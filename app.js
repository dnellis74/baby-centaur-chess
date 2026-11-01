/* =====================================================================
   Baby Centaur Chess — Phase 1 application
   ---------------------------------------------------------------------
   Architecture (state is fully decoupled from rendering):
     GameStateManager  — chess rules only (wraps chess.js).
     BoardView         — tight 2D DOM board, input, highlights, arrows.
     EngineBridge      — UCI conversation with engine-worker.js.
     NetworkSyncBridge — abstract network seam. Phase 1 = local mock.
     CentaurApp        — wires the above together. Owns no chess rules
                         and no rendering; it only coordinates.

   Event contract (the hook networking will use later):
     GameStateManager emits "attemptMove" { from, to, move, fenBefore,
     fenAfter } for every legal drop. NetworkSyncBridge.sendMove(move)
     is the single place a move leaves this machine.
   ===================================================================== */

import { Chess } from 'chess.js';
import { pieceArt } from './pieces.js?v=13';
import { MODE, ASSIST, OPPONENT, AUTO_HINTS, FLIPPED } from './config.js?v=13';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const CONFIG = {
  ENGINE_DEPTH: 9,          // roadmap depth window is 8-10
  ENGINE_MULTIPV: 3,        // top lines computed simultaneously
  HIGHLIGHT_GAP_CP: 100,    // a line glows if within 1.0 pawn of best
  MAX_HIGHLIGHTS: 3,        // three-green rule: never more than 3
  BLUNDER_DROP_CP: 200,     // intercept if a move loses > 2.0 pawns
  MATE_CP: 100000,          // mate scores are mapped onto this scale
  AI_MOVE_DELAY_MS: 450,    // pause so the solo opponent feels present
  // Solo-opponent strength (hints always stay at full depth 9 / MultiPV 3).
  // Gentle searches shallower and sometimes plays its second-best move,
  // so it makes human-like mistakes and leaves real winning chances.
  OPPONENT: {
    gentle: { depth: 5, secondBest: 0.2 },
    friendly: { depth: 6, secondBest: 0.1 },
    full: { depth: 9, secondBest: 0 },
  },
};

// Squares in chess.js / UCI notation: files a-h, ranks 1-8.
const FILES = 'abcdefgh';

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

// Minimal event emitter for the state -> app hook contract.
class Emitter {
  constructor() { this.handlers = new Map(); }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
  }
  emit(event, payload) {
    (this.handlers.get(event) || []).forEach((fn) => fn(payload));
  }
}

// Stockfish "info" line -> structured line, or null if not a PV line.
// Example: "info depth 9 multipv 2 score cp 34 pv e2e4 e7e5 g1f3"
function parseInfoLine(line) {
  if (!line.startsWith('info depth')) return null;
  const multipv = (/multipv (\d+)/.exec(line) || [null, '1'])[1];
  const score = /score (cp|mate) (-?\d+)/.exec(line);
  const pv = / pv (.+)$/.exec(line);
  if (!score || !pv) return null;
  return {
    multipv: parseInt(multipv, 10),
    kind: score[1],                       // 'cp' or 'mate'
    value: parseInt(score[2], 10),
    pv: pv[1].trim().split(/\s+/),        // UCI moves, first is the move
  };
}

// A line's score on a centipawn scale, side-to-move perspective.
// Mate-in-N maps to a huge number so gap math still works.
function lineScoreCp(line) {
  if (line.kind === 'mate') {
    return Math.sign(line.value || 1) * (CONFIG.MATE_CP - Math.abs(line.value) * 100);
  }
  return line.value;
}

// Format a White-perspective centipawn score for display.
function formatScoreCp(cp) {
  if (cp === null || cp === undefined) return '';
  if (Math.abs(cp) >= CONFIG.MATE_CP - 10000) {
    const n = Math.round((CONFIG.MATE_CP - Math.abs(cp)) / 100);
    return cp > 0 ? `#${n}` : `-#${n}`;
  }
  const pawns = cp / 100;
  return (pawns >= 0 ? '+' : '') + pawns.toFixed(2);
}

const squareName = (file, rank) => FILES[file] + (rank + 1); // file 0-7, rank 0-7 (rank 1 = 0)

/* ------------------------------------------------------------------ */
/* GameStateManager — rules only, no rendering                         */
/* ------------------------------------------------------------------ */

class GameStateManager extends Emitter {
  constructor() {
    super();
    this.chess = new Chess();
  }

  reset() { this.chess = new Chess(); }

  fen() { return this.chess.fen(); }
  turn() { return this.chess.turn(); } // 'w' | 'b'
  turnName() { return this.turn() === 'w' ? 'White' : 'Black'; }

  // Verbose legal moves from a square (chess.js v1 shape).
  legalMovesFrom(square) {
    try { return this.chess.moves({ square, verbose: true }); }
    catch { return []; }
  }

  isLegal(from, to) {
    return this.legalMovesFrom(from).some((m) => m.to === to);
  }

  // Attempt a move. chess.js commits on success, so the caller is
  // responsible for undo() when the centaur decides to intercept.
  // Emits "attemptMove" for every LEGAL drop; illegal drops return null
  // and emit nothing (the view just snaps the piece back).
  tryMove(from, to, promotion = 'q') {
    const fenBefore = this.fen();
    let move = null;
    try {
      move = this.chess.move({ from, to, promotion });
    } catch { move = null; }
    if (!move) return null;
    const payload = { from, to, move, fenBefore, fenAfter: this.fen() };
    this.emit('attemptMove', payload);
    return payload;
  }

  undo() { return this.chess.undo(); }

  // Test a move without committing it: post-move facts, or null if
  // illegal. Uses the raw chess object so no "attemptMove" event fires.
  simulateMove(from, to, promotion = 'q') {
    let move = null;
    try { move = this.chess.move({ from, to, promotion }); } catch { return null; }
    if (!move) return null;
    const facts = { stalemate: this.chess.isStalemate(), checkmate: this.chess.isCheckmate() };
    this.chess.undo();
    return facts;
  }

  history() { return this.chess.history({ verbose: true }); }

  // Human-readable game status.
  statusText() {
    const turn = this.turnName();
    if (this.chess.isCheckmate()) {
      return `Checkmate! ${turn === 'White' ? 'Black' : 'White'} wins`;
    }
    if (this.chess.isStalemate()) return 'Stalemate — draw';
    if (this.chess.isThreefoldRepetition()) return 'Draw — threefold repetition';
    if (this.chess.isInsufficientMaterial()) return 'Draw — insufficient material';
    if (this.chess.isDraw()) return 'Draw';
    return `${turn} to move${this.chess.isCheck() ? ' — check!' : ''}`;
  }

  isGameOver() { return this.chess.isGameOver(); }

  // chess.board() is rank 8 -> rank 1; flatten to [{ square, type, color }].
  pieces() {
    const out = [];
    for (const row of this.chess.board()) {
      for (const cell of row) if (cell) out.push(cell);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* BoardView — tight 2D DOM board (no canvas, no WebGL)                 */
/* ------------------------------------------------------------------ */
/* Renders 64 square divs in a grid, SVG monster pieces, and an SVG
   overlay for arrows. The view owns no rules: it reports taps and drops
   through callbacks and paints what CentaurApp tells it, through the
   same seam the 3D view used:
     setPieces, setHighlights, setArrows, clearHighlights, setSelected,
     clearSelection, setFlipped, animateMove, bounceBack, snapBack.
   Square colors stay attached to squares when flipped (a1 is dark):
   color comes from file+rank parity, never from display position. */

class BoardView {
  constructor(container, callbacks) {
    this.container = container;
    this.cb = callbacks; // { onSelect(square), onDrop(from, to), onTileClick(square) }
    this.flipped = false;
    this.turn = 'w';
    this.interactive = true;

    // Zoomable board element. The toast stays a sibling in the
    // container so it never scales with the board.
    this.boardEl = document.createElement('div');
    this.boardEl.className = 'board-2d';
    container.appendChild(this.boardEl);

    this.squaresEl = document.createElement('div');
    this.squaresEl.className = 'squares';
    this.boardEl.appendChild(this.squaresEl);

    // SVG overlay for arrows (800x800 viewBox = 100 units per square).
    this.arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.arrowSvg.setAttribute('class', 'arrows');
    this.arrowSvg.setAttribute('viewBox', '0 0 800 800');
    this.arrowSvg.setAttribute('aria-hidden', 'true');
    this.boardEl.appendChild(this.arrowSvg);

    this.cells = new Map();     // square -> cell element
    this.pieceData = new Map(); // square -> { type, color }
    this.pieceEls = new Map();  // square -> piece element
    this.highlightSet = new Set();
    this.arrowPairs = [];
    this.selectedSquare = null;
    this.dragged = null; // { square, el, startX, startY }
    this.pointers = new Map(); // pointerId -> { x, y } client coords
    this.pinch = null; // { prevDist, prevMid } while two fingers are down
    this.zoom = { scale: 1, tx: 0, ty: 0 };
    this.downInfo = null; // { time, x, y, hitPiece } for tap detection
    this.lastTap = null; // { time, x, y } for double-tap-to-reset

    this.buildCells();
    this.bindInput();
  }

  /* Coordinates. Display row 0 is the top of the screen: rank 8 when
     not flipped, rank 1 when flipped. Display col 0 is the left. */
  displayPos(square) {
    const file = FILES.indexOf(square[0]);
    const rank = parseInt(square[1], 10) - 1;
    return this.flipped
      ? { col: 7 - file, row: rank }
      : { col: file, row: 7 - rank };
  }

  squareFromDisplay(col, row) {
    if (this.flipped) return FILES[7 - col] + (row + 1);
    return FILES[col] + (8 - row);
  }

  // Client coords -> square. Uses the transformed bounding rect, so
  // hit-testing stays correct under pinch zoom and pan.
  squareFromClient(x, y) {
    const rect = this.boardEl.getBoundingClientRect();
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return null;
    const col = Math.min(7, Math.floor((x - rect.left) / rect.width * 8));
    const row = Math.min(7, Math.floor((y - rect.top) / rect.height * 8));
    return this.squareFromDisplay(col, row);
  }

  buildCells() {
    this.squaresEl.innerHTML = '';
    this.cells.clear();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const square = this.squareFromDisplay(col, row);
        const file = FILES.indexOf(square[0]);
        const rank = parseInt(square[1], 10) - 1;
        const cell = document.createElement('div');
        cell.className = 'square ' + ((file + rank) % 2 === 0 ? 'dark' : 'light');
        cell.dataset.square = square;
        this.squaresEl.appendChild(cell);
        this.cells.set(square, cell);
      }
    }
    this.applyHighlights();
    this.applySelection();
  }

  placePieces() {
    this.pieceEls.forEach((el) => el.remove());
    this.pieceEls.clear();
    for (const [square, piece] of this.pieceData) {
      const cell = this.cells.get(square);
      if (!cell) continue;
      const el = document.createElement('div');
      el.className = 'piece ' + (piece.color === 'w' ? 'white' : 'black');
      el.innerHTML = pieceArt(piece.type, piece.color);
      el.dataset.square = square;
      cell.appendChild(el);
      this.pieceEls.set(square, el);
    }
  }

  applyHighlights() {
    for (const [square, cell] of this.cells) {
      cell.classList.toggle('highlight', this.highlightSet.has(square));
    }
  }

  applySelection() {
    for (const [square, cell] of this.cells) {
      cell.classList.toggle('selected', square === this.selectedSquare);
    }
  }

  setFlipped(flipped) {
    this.flipped = flipped;
    this.buildCells();
    this.placePieces();
    this.clearHighlights();
    this.clearSelection();
  }

  /* Pieces */
  setPieces(pieces) {
    this.pieceData.clear();
    for (const p of pieces) this.pieceData.set(p.square, { type: p.type, color: p.color });
    this.placePieces();
  }

  /* Highlights: at most 3 pastel-green tiles, plus a blue selection tile. */
  setHighlights(squares) {
    this.clearHighlights();
    this.highlightSet = new Set(squares.slice(0, 3));
    this.applyHighlights();
  }

  clearHighlights() {
    this.highlightSet.clear();
    this.applyHighlights();
    this.clearArrows();
  }

  // One straight arrow per (from, to) pair, from the moving piece's
  // square to its suggested destination.
  setArrows(pairs) {
    this.clearArrows();
    this.arrowPairs = pairs.filter((p) => p.from !== p.to);
    this.drawArrows();
  }

  clearArrows() {
    this.arrowPairs = [];
    this.drawArrows();
  }

  drawArrows() {
    while (this.arrowSvg.firstChild) this.arrowSvg.removeChild(this.arrowSvg.firstChild);
    const NS = 'http://www.w3.org/2000/svg';
    for (const { from, to } of this.arrowPairs) {
      const a = this.displayPos(from);
      const b = this.displayPos(to);
      const ax = a.col * 100 + 50, ay = a.row * 100 + 50;
      const bx = b.col * 100 + 50, by = b.row * 100 + 50;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const ux = dx / len, uy = dy / len;
      const px = -uy, py = ux;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', ax + ux * 12);
      line.setAttribute('y1', ay + uy * 12);
      line.setAttribute('x2', bx - ux * 40);
      line.setAttribute('y2', by - uy * 40);
      line.setAttribute('stroke', '#7ed957');
      line.setAttribute('stroke-width', '14');
      line.setAttribute('stroke-linecap', 'round');
      const head = document.createElementNS(NS, 'polygon');
      const baseX = bx - ux * 46, baseY = by - uy * 46;
      head.setAttribute('points',
        `${bx},${by} ${baseX + px * 20},${baseY + py * 20} ${baseX - px * 20},${baseY - py * 20}`);
      head.setAttribute('fill', '#7ed957');
      this.arrowSvg.appendChild(line);
      this.arrowSvg.appendChild(head);
    }
  }

  setSelected(square) {
    this.clearSelection();
    if (!square) return;
    this.selectedSquare = square;
    this.applySelection();
  }

  clearSelection() {
    this.selectedSquare = null;
    this.applySelection();
  }

  /* Animation: Web Animations API, so the page never blocks. */
  dragTransform(el) {
    const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform || '');
    return m ? { dx: parseFloat(m[1]), dy: parseFloat(m[2]) } : { dx: 0, dy: 0 };
  }

  // Playful bounce-back for intercepted blunders: hops home with a wobble.
  bounceBack(square) {
    const el = this.pieceEls.get(square);
    if (!el) return;
    const { dx, dy } = this.dragTransform(el);
    el.classList.add('dragging');
    const anim = el.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: `translate(${dx / 2}px, ${dy / 2 - 22}px) rotate(-4deg)`, offset: 0.4 },
      { transform: `translate(${dx / 2}px, ${dy / 2 - 22}px) rotate(4deg)`, offset: 0.7 },
      { transform: 'translate(0, 0)' },
    ], { duration: 700, easing: 'ease-out' });
    anim.onfinish = () => { el.style.transform = ''; el.classList.remove('dragging'); };
  }

  snapBack(square) {
    const el = this.pieceEls.get(square);
    if (!el) return;
    const { dx, dy } = this.dragTransform(el);
    const anim = el.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: 'translate(0, 0)' },
    ], { duration: 180, easing: 'ease-out' });
    anim.onfinish = () => { el.style.transform = ''; };
  }

  // Animate an applied move; captured pieces pop out of existence.
  // Returns a promise that resolves when the animation finishes, so the
  // app can resync the board from state right after (promotion art).
  animateMove(from, to, capturedSquare) {
    if (from === to) return Promise.resolve();
    const done = [];
    if (capturedSquare) {
      const victim = this.pieceEls.get(capturedSquare);
      if (victim) {
        const pop = victim.animate(
          [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0)', opacity: 0 }],
          { duration: 200, easing: 'ease-in' });
        pop.onfinish = () => victim.remove();
        done.push(pop.finished.catch(() => {}));
        this.pieceEls.delete(capturedSquare);
        this.pieceData.delete(capturedSquare);
      }
    }
    const el = this.pieceEls.get(from);
    const fromCell = this.cells.get(from);
    const toCell = this.cells.get(to);
    if (!el || !fromCell || !toCell) return Promise.all(done);
    const data = this.pieceData.get(from);
    const dx = toCell.offsetLeft - fromCell.offsetLeft;
    const dy = toCell.offsetTop - fromCell.offsetTop;
    el.style.transform = '';
    el.classList.remove('dragging');
    toCell.appendChild(el);
    el.dataset.square = to;
    const anim = el.animate([
      { transform: `translate(${-dx}px, ${-dy}px)` },
      { transform: `translate(${-dx / 2}px, ${-dy / 2 - 18}px)`, offset: 0.5 },
      { transform: 'translate(0, 0)' },
    ], { duration: 260, easing: 'ease-out' });
    anim.onfinish = () => { el.style.transform = ''; };
    done.push(anim.finished.catch(() => {}));
    this.pieceEls.delete(from);
    this.pieceEls.set(to, el);
    this.pieceData.delete(from);
    if (data) this.pieceData.set(to, data);
    return Promise.all(done);
  }

  /* View: pinch zoom + two-finger pan, anchored at the fingers' midpoint. */
  applyZoom() {
    const { scale, tx, ty } = this.zoom;
    this.boardEl.style.transform =
      (scale === 1 && tx === 0 && ty === 0) ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  resetView() {
    this.zoom = { scale: 1, tx: 0, ty: 0 };
    this.applyZoom();
  }

  /* Input: drag-and-drop primary, tap-to-select then tap-tile also works. */
  bindInput() {
    const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid2 = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    // Pinch zoom + two-finger pan: the board point under the fingers'
    // midpoint stays under it, so pinching zooms into that part of the
    // board and sliding both fingers moves the view around it.
    const pinchMove = () => {
      const pts = [...this.pointers.values()];
      if (pts.length !== 2 || !this.pinch) return;
      const d = dist2(pts[0], pts[1]);
      const mid = mid2(pts[0], pts[1]);
      if (d < 1) return;
      const rect = this.boardEl.getBoundingClientRect();
      const s = rect.width / this.boardEl.offsetWidth;
      const originX = rect.left - this.zoom.tx;
      const originY = rect.top - this.zoom.ty;
      const bx = (this.pinch.prevMid.x - rect.left) / s;
      const by = (this.pinch.prevMid.y - rect.top) / s;
      const s2 = Math.min(2.5, Math.max(1, s * (this.pinch.prevDist / d)));
      if (s2 <= 1.001) {
        this.resetView();
      } else {
        let tx = mid.x - originX - bx * s2;
        let ty = mid.y - originY - by * s2;
        // Keep at least a sliver of board inside the container frame.
        const cRect = this.container.getBoundingClientRect();
        const w = this.boardEl.offsetWidth * s2;
        const h = this.boardEl.offsetHeight * s2;
        tx = Math.max(cRect.left + 20 - w - originX, Math.min(cRect.right - 20 - originX, tx));
        ty = Math.max(cRect.top + 20 - h - originY, Math.min(cRect.bottom - 20 - originY, ty));
        this.zoom = { scale: s2, tx, ty };
        this.applyZoom();
      }
      this.pinch.prevDist = d;
      this.pinch.prevMid = mid;
    };

    // A drag interrupted by a second finger: the piece goes home.
    // Pieces never leave their home cell in the DOM (drags are pure
    // transforms), so cancelling is just clearing the transform.
    const cancelDrag = () => {
      if (!this.dragged) return;
      if (this.dragged.el) {
        this.dragged.el.style.transform = '';
        this.dragged.el.classList.remove('dragging');
      }
      this.dragged = null;
    };

    this.boardEl.addEventListener('pointerdown', (e) => {
      // Pinch bookkeeping runs even when input is locked: zooming is
      // view-only and should work while the opponent is thinking.
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        // Second finger down: stop any piece drag, keep the game state.
        cancelDrag();
        this.clearSelection(); // suggestions stay visible (kid-friendly)
        this.downInfo = null;
        this.lastTap = null;
        const pts = [...this.pointers.values()];
        this.pinch = { prevDist: dist2(pts[0], pts[1]), prevMid: mid2(pts[0], pts[1]) };
        return;
      }
      if (this.pointers.size > 2) return;
      if (!this.interactive) return;
      const square = this.squareFromClient(e.clientX, e.clientY);
      const piece = square ? this.pieceData.get(square) : undefined;
      this.downInfo = { time: performance.now(), x: e.clientX, y: e.clientY, hitPiece: !!piece };
      if (!square) return;
      if (piece) {
        if (piece.color !== this.turn) {
          // Clicking an enemy piece with a selection armed = capture attempt.
          if (this.selectedSquare) this.cb.onTileClick(square);
          return;
        }
        if (this.selectedSquare === square) {
          // Tapping the selected piece again puts it down, but the
          // partner's suggestions stay on the board: changing your mind
          // should never hide the help.
          this.clearSelection();
          return;
        }
        this.setSelected(square);
        this.cb.onSelect(square);
        const pel = this.pieceEls.get(square);
        if (pel) pel.classList.add('dragging');
        this.dragged = { square, el: pel, startX: e.clientX, startY: e.clientY };
      } else if (this.selectedSquare) {
        this.cb.onTileClick(square);
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this.pinch) { pinchMove(); return; }
      if (!this.dragged) return;
      const rect = this.boardEl.getBoundingClientRect();
      const s = rect.width / this.boardEl.offsetWidth;
      const dx = (e.clientX - this.dragged.startX) / s;
      const dy = (e.clientY - this.dragged.startY) / s;
      if (this.dragged.el) {
        this.dragged.el.style.transform = `translate(${dx}px, ${dy}px) scale(1.12)`;
      }
    });

    window.addEventListener('pointerup', (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null;
        this.downInfo = null;
        return; // pinching never drops a piece
      }
      if (!this.dragged) {
        // Tap detection for double-tap-to-reset: two quick taps on
        // empty board zoom back out to the full board.
        if (this.downInfo && !this.downInfo.hitPiece) {
          const dt = performance.now() - this.downInfo.time;
          const moved = Math.hypot(e.clientX - this.downInfo.x, e.clientY - this.downInfo.y);
          if (dt < 400 && moved < 12) {
            const now = performance.now();
            if (this.lastTap && now - this.lastTap.time < 350 &&
                Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 40) {
              this.resetView();
              this.lastTap = null;
            } else {
              this.lastTap = { time: now, x: e.clientX, y: e.clientY };
            }
          }
        }
        this.downInfo = null;
        return;
      }
      const { square, el } = this.dragged;
      this.dragged = null;
      this.downInfo = null;
      const tile = this.squareFromClient(e.clientX, e.clientY);
      if (!tile || tile === square) {
        // Dropped outside the board or on its own square: back home,
        // but stay selected (click mode armed).
        if (el) { el.style.transform = ''; el.classList.remove('dragging'); }
        return;
      }
      // The app resolves legality; the piece stays visually on the
      // drop square (transform kept) until the app animates it home
      // (bounceBack/snapBack) or to its target (animateMove).
      if (el) {
        const { dx, dy } = this.dragTransform(el);
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.classList.remove('dragging');
      }
      this.cb.onDrop(square, tile);
    });

    window.addEventListener('pointercancel', (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      cancelDrag();
      this.downInfo = null;
    });
  }
}

/* ------------------------------------------------------------------ */
/* EngineBridge — UCI conversation with engine-worker.js               */
/* ------------------------------------------------------------------ */
/* Serializes searches (one at a time; callers await). Lines are kept
   per multipv index and overwritten as depth increases, so the map
   holds the final depth's lines when "bestmove" arrives. Scores are
   side-to-move perspective, exactly as Stockfish reports them. */

class EngineBridge {
  constructor(workerPath) {
    this.worker = new Worker(workerPath);
    this.queue = Promise.resolve();
    this.failed = false;
    this.readyPromise = null;
    this.pending = null; // { resolve, lines: Map }
    this.waiters = { uciok: [], readyok: [] };

    this.worker.onmessage = (e) => this.handleLine(String(e.data));
    this.worker.onerror = () => {
      this.failed = true;
      if (this.pending) { this.pending.resolve([]); this.pending = null; }
      this.waiters.uciok.forEach((r) => r());
      this.waiters.readyok.forEach((r) => r());
    };
  }

  send(cmd) { try { this.worker.postMessage(cmd); } catch { this.failed = true; } }

  // Handshake: "uci" -> "uciok", then MultiPV option, then "isready".
  init() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve) => {
      const onUciOk = () => {
        this.send(`setoption name MultiPV value ${CONFIG.ENGINE_MULTIPV}`);
        this.send('isready');
      };
      const onReadyOk = () => resolve(!this.failed);
      this.waiters.uciok.push(onUciOk);
      this.waiters.readyok.push(onReadyOk);
      this.send('uci');
      // If the engine never answers (CDN blocked, worker failed), fail
      // open after 8s: the game stays playable, just without hints.
      setTimeout(() => {
        if (this.waiters.uciok.length || this.waiters.readyok.length) {
          this.failed = true;
          const u = this.waiters.uciok; this.waiters.uciok = [];
          const r = this.waiters.readyok; this.waiters.readyok = [];
          u.forEach((fn) => fn()); r.forEach((fn) => fn());
          if (this.pending) { this.pending.resolve([]); this.pending = null; }
        }
      }, 8000);
    });
    return this.readyPromise;
  }

  handleLine(line) {
    if (line === 'uciok') {
      const w = this.waiters.uciok; this.waiters.uciok = []; w.forEach((r) => r());
      return;
    }
    if (line === 'readyok') {
      const w = this.waiters.readyok; this.waiters.readyok = []; w.forEach((r) => r());
      return;
    }
    if (!this.pending) return;
    const parsed = parseInfoLine(line);
    if (parsed) {
      this.pending.lines.set(parsed.multipv, parsed);
      return;
    }
    if (line.startsWith('bestmove')) {
      const lines = [...this.pending.lines.values()]
        .sort((a, b) => lineScoreCp(b) - lineScoreCp(a));
      const { resolve } = this.pending;
      this.pending = null;
      resolve(lines);
    }
  }

  analyze(fen, opts = {}) {
    const depth = opts.depth || CONFIG.ENGINE_DEPTH;
    const multiPv = opts.multiPv || CONFIG.ENGINE_MULTIPV;
    const task = this.queue.then(() => new Promise((resolve) => {
      if (this.failed) return resolve([]);
      this.pending = { resolve, lines: new Map() };
      this.send(`setoption name MultiPV value ${multiPv}`);
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    }));
    this.queue = task.catch(() => {});
    return task;
  }

  // Single-PV best score for a position (side-to-move perspective).
  async evalOnce(fen) {
    const lines = await this.analyze(fen, { multiPv: 1 });
    return lines.length ? lineScoreCp(lines[0]) : null;
  }

  // Best move (UCI) for a position, for the solo opponent.
  async bestMove(fen) {
    const lines = await this.analyze(fen, { multiPv: 1 });
    return lines.length && lines[0].pv.length ? lines[0].pv[0] : null;
  }

  // Solo-opponent move: a shallower search, and sometimes (secondBest
  // chance) the second-best line instead of the best. Hints never use
  // this path, so the partner stays full strength while the opponent
  // plays like a beatable human.
  async opponentMove(fen, setting) {
    const lines = await this.analyze(fen, { multiPv: 2, depth: setting.depth });
    if (!lines.length || !lines[0].pv.length) return null;
    if (lines.length > 1 && lines[1].pv.length && Math.random() < setting.secondBest) {
      return lines[1].pv[0];
    }
    return lines[0].pv[0];
  }
}

/* ------------------------------------------------------------------ */
/* NetworkSyncBridge — abstract network seam (Phase 3 stub)            */
/* ------------------------------------------------------------------ */
/* Phase 1 is a local mock: it mirrors state machine, turn flags and
   clocks locally and never echoes your own move back. Phase 3 replaces
   ONLY this class with a WebSocket / Socket.io / Supabase Realtime
   transport implementing the same four methods. Nothing in
   GameStateManager, BoardView, or CentaurApp changes.
     connect()    -> Promise<{ mode }>
     sendMove(m)  -> deliver a local move to the peer
     onRemoteMove(cb) -> cb(move) for moves arriving from the peer
     getState()   -> mirrored { fen, turn } snapshot                */

class NetworkSyncBridge {
  constructor() {
    this.mode = 'local-mock';
    this.mirror = { fen: null, turn: 'w' };
    this.remoteHandlers = [];
  }

  async connect() { return { mode: this.mode }; }

  sendMove(move) {
    this.mirror.fen = move.afterFen || this.mirror.fen;
    this.mirror.turn = move.afterFen ? (move.afterFen.split(' ')[1]) : this.mirror.turn;
    // Mock only: no echo. A real transport delivers ONLY the
    // opponent's moves to onRemoteMove.
  }

  onRemoteMove(cb) { this.remoteHandlers.push(cb); }

  getState() { return { ...this.mirror }; }
}

/* ------------------------------------------------------------------ */
/* CentaurApp — coordination only (no rules, no rendering)             */
/* ------------------------------------------------------------------ */

class CentaurApp {
  constructor() {
    this.state = new GameStateManager();
    this.engine = new EngineBridge('engine-worker.js?v=13');
    this.network = new NetworkSyncBridge();
    this.view = new BoardView(document.getElementById('scene-container'), {
      onSelect: (sq) => this.onSelect(sq),
      onDrop: (from, to) => this.handleHumanMove(from, to),
      onTileClick: (sq) => {
        if (this.view.selectedSquare) this.handleHumanMove(this.view.selectedSquare, sq);
      },
    });

    // Options live in config.js, not in the interface (kids' build).
    this.mode = MODE; // 'solo' | 'advise'
    // Assist dial: 'full' (suggested moves only), 'hints' (no intercept),
    // 'off' (no partner output at all). This is the partner's help level,
    // not the solo opponent — Stockfish still plays Black in solo mode
    // when assist is off. Networked rule (decided 2026-10-30): centaur
    // vs centaur, and either side may start a game with assist at zero.
    this.assist = ASSIST;
    // Solo-opponent strength: only the Stockfish side in solo mode plays
    // weaker. Hints and the blunder intercept stay full strength.
    this.opponent = OPPONENT;
    this.autoHints = AUTO_HINTS;
    this.inputLocked = false;
    this.cachedAnalysis = null; // { fen, lines } — freshest engine view
    this.highlightFen = null;
    this.highlightSquares = new Set();
    this.highlightPairs = []; // (from, to) pairs behind the live suggestions
    this.toastTimer = null;

    this.el = {
      message: document.getElementById('message-text'),
      playAgain: document.getElementById('play-again'),
      evalFill: document.getElementById('eval-fill'),
      evalLabel: document.getElementById('eval-label'),
      toast: document.getElementById('toast'),
    };

    document.getElementById('play-again').addEventListener('click', () => this.newGame());
    if (FLIPPED) this.view.setFlipped(true);
    if (this.assist === 'off') this.el.evalLabel.textContent = '—';
  }

  async start() {
    await this.network.connect();
    const engineOk = await this.engine.init();
    if (!engineOk) this.toast('Partner unavailable (engine failed to load) — playing without hints');
    this.view.setPieces(this.state.pieces());
    this.refreshUI();
    // Background analysis fills eval bar, then auto hints
    // show the partner's ideas for the side to move.
    this.refreshAnalysis().then(() => this.maybeAutoHint());
  }

  /* UI ------------------------------------------------------------ */

  toast(msg, ms = 4200) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.el.toast.classList.remove('show'), ms);
  }

  refreshUI() {
    this.el.message.textContent = this.state.statusText();
    this.el.playAgain.classList.toggle('hidden', !this.state.isGameOver());
    this.view.turn = this.state.turn();
  }

  // White-perspective score -> eval bar.
  renderAnalysis(lines) {
    if (!lines.length) return;
    const turn = this.state.turn();
    const best = lines[0];
    const cpWhite = turn === 'w' ? lineScoreCp(best) : -lineScoreCp(best);
    const pct = 100 / (1 + Math.exp(-0.004 * cpWhite));
    this.el.evalFill.style.width = `${pct}%`;
    this.el.evalLabel.textContent = formatScoreCp(cpWhite);
  }

  // Background analysis of the current position: refreshes the cached
  // best score (used by blunder math) and the eval bar. Never
  // touches highlights — those belong to a selection or an Ask.
  async refreshAnalysis() {
    if (this.assist === 'off') return; // no engine calls for partner output
    const fen = this.state.fen();
    const lines = await this.engine.analyze(fen);
    if (this.state.fen() !== fen || !lines.length) return; // position moved on
    this.cachedAnalysis = { fen, lines };
    this.renderAnalysis(lines);
  }

  // Gap rule (three-green logic): best always glows; a further line
  // glows only if within HIGHLIGHT_GAP_CP of the best. Cap: 3.
  // Returns (from, to) pairs so the view can draw arrows, not just tiles.
  pickHighlightDestinations(lines, fromSquare) {
    const sorted = [...lines].sort((a, b) => lineScoreCp(b) - lineScoreCp(a));
    if (!sorted.length) return [];
    const best = lineScoreCp(sorted[0]);
    const pairs = [];
    const seenTo = new Set();
    for (const line of sorted) {
      if (pairs.length >= CONFIG.MAX_HIGHLIGHTS) break;
      if (lineScoreCp(line) < best - CONFIG.HIGHLIGHT_GAP_CP) break;
      const from = line.pv[0].slice(0, 2);
      const to = line.pv[0].slice(2, 4);
      if (fromSquare && from !== fromSquare) continue;
      if (!this.state.isLegal(from, to)) continue;
      if (seenTo.has(to)) continue;
      seenTo.add(to);
      pairs.push({ from, to });
    }
    return pairs;
  }

  // A turn belongs to a human partner when it is not the solo opponent's.
  isHumanTurn() {
    return this.mode === 'advise' || this.state.turn() === 'w';
  }

  // Auto hints: partner hints, silent and automatic. Runs at
  // game start and after every move, for human turns only. Reuses the
  // cached analysis when it matches the current position.
  async maybeAutoHint() {
    if (!this.autoHints || this.assist === 'off') return;
    if (this.inputLocked || this.state.isGameOver() || !this.isHumanTurn()) return;
    const fen = this.state.fen();
    let lines = null;
    if (this.cachedAnalysis && this.cachedAnalysis.fen === fen) {
      lines = this.cachedAnalysis.lines;
    } else {
      lines = await this.engine.analyze(fen);
      if (this.state.fen() !== fen || !lines.length) return;
      this.cachedAnalysis = { fen, lines };
      this.renderAnalysis(lines);
    }
    const pairs = this.pickHighlightDestinations(lines, null);
    this.highlightFen = fen;
    this.highlightSquares = new Set(pairs.map((p) => p.to));
    this.highlightPairs = pairs;
    this.view.setHighlights(pairs.map((p) => p.to));
    this.view.setArrows(pairs);
  }

  /* Partner interaction -------------------------------------------- */

  async onSelect(square) {
    if (this.inputLocked || this.state.isGameOver()) return;
    if (this.assist === 'off') return; // partner stays quiet at zero assist
    const fen = this.state.fen();
    const lines = await this.engine.analyze(fen);
    if (this.state.fen() !== fen) return; // user moved on meanwhile
    this.cachedAnalysis = { fen, lines };
    this.renderAnalysis(lines);
    // Suggestions are position-level and stay put while a piece is held:
    // selecting another piece must not swap them for that piece's moves,
    // or holding a piece with no suggested move would hide them all.
    // Only fill them in when nothing is live for this position yet
    // (e.g. auto hints off, first selection of the turn). `square` is
    // intentionally not used to filter here.
    if (this.highlightFen !== fen || this.highlightSquares.size === 0) {
      const pairs = this.pickHighlightDestinations(lines, null);
      this.highlightFen = fen;
      this.highlightSquares = new Set(pairs.map((p) => p.to));
      this.highlightPairs = pairs;
      this.view.setHighlights(pairs.map((p) => p.to));
      this.view.setArrows(pairs);
    }
  }

  /* Move resolution -------------------------------------------------- */

  // Every human drop lands here. Flow at default settings (assist
  // 'full'): ONLY suggested destinations are playable. A legal drop
  // anywhere else bounces home, blunder or not, and the suggestions
  // stay on the board because the turn is not complete yet.
  // At 'hints'/'off' any legal move stands (the dial's point).
  // Illegal drops snap back (no engine call, no state change).
  // Highlights/arrows are never cleared mid-turn — only a finalized
  // move clears them — so they survive selection, holding, and bounces.
  // True when this attempt moves a pawn of the side to move onto its
  // last rank, and the move is legal (any promotion piece).
  isPromotionAttempt(from, to) {
    const piece = this.state.pieces().find((p) => p.square === from);
    if (!piece || piece.type !== 'p' || piece.color !== this.state.turn()) return false;
    const lastRank = piece.color === 'w' ? '8' : '1';
    return to[1] === lastRank && this.state.isLegal(from, to);
  }

  // The partner's suggested promotion: queen, unless queening stalemates
  // the opponent and throws away the win, in which case the highest-value
  // promotion that does not stalemate. Instant and local: no engine wait.
  suggestPromotion(from, to) {
    for (const p of ['q', 'r', 'b', 'n']) {
      const sim = this.state.simulateMove(from, to, p);
      if (sim && !sim.stalemate) return p;
    }
    return 'q';
  }

  // Promotion picker: four choices in the mover's color, the suggested
  // one ringed in green (green always means the partner's suggestion).
  showPromotionPicker(from, to) {
    const color = this.state.turn();
    const suggestion = this.suggestPromotion(from, to);
    const names = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
    const row = document.getElementById('promo-row');
    row.innerHTML = '';
    for (const p of ['q', 'r', 'b', 'n']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'promo-btn' + (p === suggestion ? ' suggested' : '');
      btn.setAttribute('aria-label', names[p]);
      btn.innerHTML = pieceArt(p, color);
      if (p === suggestion) {
        const tag = document.createElement('span');
        tag.className = 'promo-tag';
        tag.textContent = "Partner's pick";
        btn.appendChild(tag);
      }
      btn.addEventListener('click', () => this.commitPromotion(from, to, p));
      row.appendChild(btn);
    }
    document.getElementById('promo-note').textContent =
      suggestion === 'q'
        ? 'Queen is the strongest choice here.'
        : 'Queen would stalemate and throw away the win, so your partner suggests this one instead.';
    document.getElementById('promo-picker').classList.remove('hidden');
  }

  closePromotionPicker() {
    document.getElementById('promo-picker').classList.add('hidden');
    document.getElementById('promo-row').innerHTML = '';
  }

  commitPromotion(from, to, piece) {
    this.closePromotionPicker();
    this.inputLocked = false;
    this.view.interactive = true;
    this.handleHumanMove(from, to, piece);
  }

  async handleHumanMove(from, to, promotion = null) {
    if (this.inputLocked || this.state.isGameOver()) { this.view.snapBack(from); return; }

    // Promotion: a pawn reaching the last rank opens the picker instead
    // of auto-queening, so the kid chooses (with the partner's pick
    // suggested). At Full assist a non-suggested destination still
    // bounces first, evaluated pre-move exactly like the gate below.
    if (!promotion && this.isPromotionAttempt(from, to)) {
      const fenNow = this.state.fen();
      const highlighted = this.highlightFen === fenNow && this.highlightSquares.has(to);
      const suggestionsLive = this.highlightFen === fenNow && this.highlightSquares.size > 0;
      if (this.assist === 'full' && !highlighted && suggestionsLive) {
        this.view.bounceBack(from);
        this.toast('Only the glowing green moves are allowed on this setting. Pick one of those to finish your turn.');
        this.refreshUI();
        return;
      }
      this.view.clearSelection();
      this.view.snapBack(from);
      this.inputLocked = true;
      this.view.interactive = false;
      this.showPromotionPicker(from, to);
      return;
    }

    const res = this.state.tryMove(from, to, promotion || 'q');
    if (!res) { this.view.snapBack(from); return; }

    // Selection clears, but suggestions stay until the turn completes.
    this.view.clearSelection();
    this.inputLocked = true;
    this.view.interactive = false;

    const highlighted = this.highlightFen === res.fenBefore && this.highlightSquares.has(to);
    const suggestionsLive = this.highlightFen === res.fenBefore && this.highlightSquares.size > 0;

    // Default setting: only suggested moves are playable.
    if (this.assist === 'full' && !highlighted && suggestionsLive) {
      this.state.undo();
      this.view.bounceBack(from);
      this.toast('Only the glowing green moves are allowed on this setting. Pick one of those to finish your turn.');
      this.inputLocked = false;
      this.view.interactive = true;
      this.refreshUI();
      return;
    }

    // Fallback at full assist when no suggestions are live (engine
    // unavailable): the old blunder intercept still guards the move.
    // At 'hints'/'off' the move stands as played, however bad.
    if (!highlighted && this.assist === 'full') {
      // Best score before the move (cached selection analysis, else fresh).
      let bestBefore = null;
      if (this.cachedAnalysis && this.cachedAnalysis.fen === res.fenBefore && this.cachedAnalysis.lines.length) {
        bestBefore = lineScoreCp(this.cachedAnalysis.lines[0]);
      } else {
        const before = await this.engine.analyze(res.fenBefore, { multiPv: 1 });
        bestBefore = before.length ? lineScoreCp(before[0]) : null;
      }
      // evalOnce returns the NEW side-to-move (opponent) perspective, so
      // the mover's score after the move is its negation.
      const after = await this.engine.evalOnce(res.fenAfter);
      const drop = bestBefore !== null && after !== null ? bestBefore + after : 0;
      if (drop > CONFIG.BLUNDER_DROP_CP) {
        this.state.undo();
        this.view.bounceBack(from);
        this.toast('Whoa, partner caught that one! That move drops the position by over 2 pawns, so it bounced home. The green tiles are safer.');
        this.inputLocked = false;
        this.view.interactive = true;
        this.refreshUI();
        return;
      }
    }

    this.finalizeMove(res);
  }

  // Commit visuals, network, UI, and the solo opponent's reply.
  async finalizeMove(res) {
    const move = res.move;
    // En passant captures a pawn that is NOT on the destination square.
    let capturedSquare = null;
    if (move.captured) {
      capturedSquare = move.flags.includes('e') ? move.to[0] + move.from[1] : move.to;
    }
    const anims = [this.view.animateMove(move.from, move.to, capturedSquare)];
    // Castling: the rook rides along.
    if (move.flags.includes('k')) {
      const rank = move.from[1];
      anims.push(this.view.animateMove('h' + rank, 'f' + rank, null));
    } else if (move.flags.includes('q')) {
      const rank = move.from[1];
      anims.push(this.view.animateMove('a' + rank, 'd' + rank, null));
    }
    await Promise.all(anims);
    // Re-render from state: the animation carries the old art, so a
    // promotion only becomes visible here. This also resyncs castling
    // and en passant, so the board can never drift from the rules.
    this.view.setPieces(this.state.pieces());

    this.network.sendMove({ from: move.from, to: move.to, san: move.san, afterFen: res.fenAfter });
    this.highlightFen = null;
    this.highlightSquares = new Set();
    this.highlightPairs = [];
    this.view.clearHighlights(); // turn complete: suggestions leave with it
    this.refreshUI();
    this.inputLocked = false;
    this.view.interactive = true;

    this.refreshAnalysis().then(() => this.maybeAutoHint());
    if (this.mode === 'solo' && this.state.turn() === 'b' && !this.state.isGameOver()) {
      this.aiReply();
    }
  }

  async aiReply() {
    if (this.state.isGameOver() || this.state.turn() !== 'b') return;
    this.inputLocked = true;
    this.view.interactive = false;
    await new Promise((r) => setTimeout(r, CONFIG.AI_MOVE_DELAY_MS));
    const setting = CONFIG.OPPONENT[this.opponent] || CONFIG.OPPONENT.full;
    const uci = await this.engine.opponentMove(this.state.fen(), setting);
    this.inputLocked = false;
    this.view.interactive = true;
    if (!uci || this.state.isGameOver() || this.state.turn() !== 'b') return;
    // Stockfish's move string carries the promotion piece (e.g. e7e8q);
    // pass it through instead of defaulting to queen.
    const promo = uci.length > 4 ? uci[4] : 'q';
    const res = this.state.tryMove(uci.slice(0, 2), uci.slice(2, 4), promo);
    if (res) this.finalizeMove(res);
  }

  newGame() {
    this.closePromotionPicker();
    this.state.reset();
    this.view.setPieces(this.state.pieces());
    this.view.clearHighlights();
    this.view.clearSelection();
    this.cachedAnalysis = null;
    this.highlightFen = null;
    this.highlightSquares = new Set();
    this.highlightPairs = [];
    this.inputLocked = false;
    this.view.interactive = true;
    this.el.evalFill.style.width = '50%';
    this.el.evalLabel.textContent = this.assist === 'off' ? '—' : '+0.0';
    this.refreshUI();
    this.refreshAnalysis().then(() => this.maybeAutoHint());
  }
}

/* Boot. Module scripts run after the DOM is parsed, so elements exist. */
const app = new CentaurApp();
app.start();
