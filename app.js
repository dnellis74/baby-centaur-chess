/* =====================================================================
   Baby Centaur Chess — Phase 1 application
   ---------------------------------------------------------------------
   Architecture (state is fully decoupled from rendering):
     GameStateManager  — chess rules only (wraps chess.js). No Three.js.
     PieceModelFactory — builds 3D piece meshes. Swappable for glTF later.
     BoardView         — Three.js scene, input, highlights, animation.
     EngineBridge      — UCI conversation with engine-worker.js.
     NetworkSyncBridge — abstract network seam. Phase 1 = local mock.
     CentaurApp        — wires the above together. Owns no chess rules
                         and no rendering; it only coordinates.

   Event contract (the hook networking will use later):
     GameStateManager emits "attemptMove" { from, to, move, fenBefore,
     fenAfter } for every legal drop. NetworkSyncBridge.sendMove(move)
     is the single place a move leaves this machine.
   ===================================================================== */

import * as THREE from 'three';
import { Chess } from 'chess.js';

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
  tryMove(from, to) {
    const fenBefore = this.fen();
    let move = null;
    try {
      move = this.chess.move({ from, to, promotion: 'q' }); // auto-queen: stress-free
    } catch { move = null; }
    if (!move) return null;
    const payload = { from, to, move, fenBefore, fenAfter: this.fen() };
    this.emit('attemptMove', payload);
    return payload;
  }

  undo() { return this.chess.undo(); }

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
/* PieceModelFactory — Phase 2 seam                                    */
/* ------------------------------------------------------------------ */
/* Phase 1 returns rounded cartoon placeholders: capsule body, sphere
   head, painted eyes and rosy cheeks. Phase 2 keeps this exact API and
   swaps the body for loaded glTF/OBJ models (chibi animals/monsters):
     const group = await PieceModelFactory.createPiece(type, color)
   Every mesh gets castShadow; the group carries userData { type, color,
   square } so BoardView raycasting can resolve a hit to a piece. */

class PieceModelFactory {
  // Per-type proportions + head topper, so placeholders stay readable.
  static SPECS = {
    p: { bodyR: 0.24, bodyLen: 0.22, headR: 0.26, topper: null },
    r: { bodyR: 0.28, bodyLen: 0.32, headR: 0.30, topper: 'rook' },
    n: { bodyR: 0.28, bodyLen: 0.36, headR: 0.30, topper: 'knight' },
    b: { bodyR: 0.28, bodyLen: 0.44, headR: 0.30, topper: 'bishop' },
    q: { bodyR: 0.30, bodyLen: 0.52, headR: 0.32, topper: 'queen' },
    k: { bodyR: 0.30, bodyLen: 0.56, headR: 0.32, topper: 'king' },
  };

  static createPiece(type, color) {
    const spec = this.SPECS[type];
    const isWhite = color === 'w';
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({
      color: isWhite ? 0xfdf3e3 : 0x3a4756, roughness: 0.55,
    });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c2530, roughness: 0.4 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const cheekMat = new THREE.MeshStandardMaterial({ color: 0xffb3c1, roughness: 0.7 });
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.35, metalness: 0.4 });

    const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); mesh.castShadow = true; group.add(mesh); return mesh; };

    // Base disc so the piece reads as a game piece, not a blob.
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.08, 24), bodyMat), 0, 0.04, 0);
    // Rounded capsule body.
    add(new THREE.Mesh(new THREE.CapsuleGeometry(spec.bodyR, spec.bodyLen, 6, 16), bodyMat),
      0, 0.08 + spec.bodyR + spec.bodyLen / 2, 0);
    // Sphere head.
    const headY = 0.08 + spec.bodyR * 2 + spec.bodyLen + spec.headR * 0.55;
    add(new THREE.Mesh(new THREE.SphereGeometry(spec.headR, 24, 18), bodyMat), 0, headY, 0);
    // Cartoon eyes (white + pupil) and rosy cheeks, facing +z.
    for (const side of [-1, 1]) {
      add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), whiteMat),
        side * 0.11, headY + 0.06, spec.headR * 0.86);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), darkMat),
        side * 0.11, headY + 0.06, spec.headR * 0.86 + 0.05);
      const cheek = add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), cheekMat),
        side * 0.20, headY - 0.06, spec.headR * 0.78);
      cheek.scale.set(1, 0.6, 0.5);
    }
    // Type toppers: silhouettes stay distinguishable at a glance.
    const topY = headY + spec.headR * 0.9;
    if (spec.topper === 'king' || spec.topper === 'queen') {
      add(new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.22, 16), goldMat), 0, topY + 0.08, 0);
      if (spec.topper === 'queen') add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), goldMat), 0, topY + 0.22, 0);
    } else if (spec.topper === 'rook') {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.12, 16), bodyMat), 0, topY + 0.03, 0);
      for (const [dx, dz] of [[-0.13, 0], [0.13, 0], [0, -0.13], [0, 0.13]]) {
        add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), bodyMat), dx, topY + 0.12, dz);
      }
    } else if (spec.topper === 'bishop') {
      const mitre = add(new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.26, 16), bodyMat), 0, topY + 0.10, 0);
      mitre.rotation.z = 0.25;
    } else if (spec.topper === 'knight') {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.22), bodyMat), 0, headY - 0.02, spec.headR * 0.85);
      for (const side of [-1, 1]) {
        add(new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 8), bodyMat), side * 0.12, topY + 0.02, 0);
      }
    }

    group.userData = { type, color, square: null };
    return group;
  }
}

/* ------------------------------------------------------------------ */
/* BoardView — Three.js scene, input, highlights, animation            */
/* ------------------------------------------------------------------ */

class BoardView {
  constructor(container, callbacks) {
    this.container = container;
    this.cb = callbacks; // { onSelect(square), onDrop(from, to), onTileClick(square) }
    this.flipped = false;
    this.turn = 'w';
    this.interactive = true;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x171d27);

    // Slightly top-down perspective: board reads as 3D, pieces stay clear.
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    // View state for pinch zoom: a fixed viewing direction, a look-at
    // target that pans with two fingers, and a distance that pinches in
    // and out. The default distance shows the whole board.
    this.viewDir = new THREE.Vector3(0, 11.5, 8.5).normalize();
    this.viewTarget = new THREE.Vector3(0, 0, 0);
    this.viewDistDefault = new THREE.Vector3(0, 11.5, 8.5).length();
    this.viewDist = this.viewDistDefault;
    this.viewDistMin = 6.5;
    this.updateCamera();

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(5, 12, 6);
    sun.castShadow = true;
    sun.shadow.camera.left = -7; sun.shadow.camera.right = 7;
    sun.shadow.camera.top = 7; sun.shadow.camera.bottom = -7;
    this.scene.add(sun);

    this.buildBoard();
    this.pieceGroups = new Map(); // square -> Group

    // Highlight overlays (shared pastel-green material, pulsed in animate).
    this.highlightMat = new THREE.MeshStandardMaterial({
      color: 0xb7e4a8, emissive: 0x86c06c, emissiveIntensity: 0.8,
      transparent: true, opacity: 0.85,
    });
    // Glowing green arrows: one per highlighted destination, arcing from
    // the moving piece to its suggested destination tile.
    this.arrowMat = new THREE.MeshBasicMaterial({ color: 0x7ed957, transparent: true, opacity: 0.9 });
    this.arrows = [];
    this.highlights = new Map(); // square -> Mesh
    this.selectMat = new THREE.MeshStandardMaterial({
      color: 0xa8c8e8, emissive: 0x5a8ac0, emissiveIntensity: 0.7,
      transparent: true, opacity: 0.7,
    });
    this.selectMesh = null;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.selectedSquare = null;
    this.dragged = null; // { square, group }
    this.pointers = new Map(); // pointerId -> { x, y } client coords
    this.pinch = null; // { prevDist, prevMid } while two fingers are down
    this.downInfo = null; // { time, x, y, hitPiece } for tap detection
    this.lastTap = null; // { time, x, y } for double-tap-to-reset
    this.tweens = [];
    this.scalers = [];
    this.clock = new THREE.Clock();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // The board's size follows its container, which changes on rotation,
    // browser resize, and layout shifts — watch the container directly
    // so the canvas never lags behind the responsive layout.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.bindInput();
    this.animate();
  }

  /* Coordinates. Board spans x,z in [-4, 4]; rank 1 is near the camera
     (z = +3.5) when not flipped. Flipping negates both axes. */
  squareToPos(file, rank) {
    let x = file - 3.5;
    let z = 3.5 - rank;
    if (this.flipped) { x = -x; z = -z; }
    return { x, z };
  }

  posToSquare(x, z) {
    if (this.flipped) { x = -x; z = -z; }
    const file = Math.round(x + 3.5);
    const rank = Math.round(3.5 - z);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return squareName(file, rank);
  }

  buildBoard() {
    this.tileGroup = new THREE.Group();
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xf0d9b5, roughness: 0.8 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0xb58863, roughness: 0.8 });
    const geo = new THREE.BoxGeometry(0.96, 0.2, 0.96);
    for (let file = 0; file < 8; file++) {
      for (let rank = 0; rank < 8; rank++) {
        const tile = new THREE.Mesh(geo, (file + rank) % 2 === 0 ? darkMat : lightMat);
        const { x, z } = this.squareToPos(file, rank);
        tile.position.set(x, 0, z);
        tile.receiveShadow = true;
        tile.userData.square = squareName(file, rank);
        this.tileGroup.add(tile);
      }
    }
    this.scene.add(this.tileGroup);
  }

  repositionAll() {
    // Tiles keep their colors on flip: (file+rank) parity is preserved
    // because flipping maps (f, r) -> (7-f, 7-r), a sum shift of 14.
    for (const tile of this.tileGroup.children) {
      const sq = tile.userData.square;
      const file = FILES.indexOf(sq[0]);
      const rank = parseInt(sq[1], 10) - 1;
      const { x, z } = this.squareToPos(file, rank);
      tile.position.set(x, 0, z);
    }
    for (const [sq, group] of this.pieceGroups) {
      const { x, z } = this.squareToPos(FILES.indexOf(sq[0]), parseInt(sq[1], 10) - 1);
      group.position.set(x, 0.1, z);
    }
    this.clearHighlights();
    this.clearSelection();
  }

  setFlipped(flipped) { this.flipped = flipped; this.repositionAll(); }

  /* Pieces */
  setPieces(pieces) {
    for (const g of this.pieceGroups.values()) this.scene.remove(g);
    this.pieceGroups.clear();
    for (const p of pieces) {
      const group = PieceModelFactory.createPiece(p.type, p.color);
      const { x, z } = this.squareToPos(FILES.indexOf(p.square[0]), parseInt(p.square[1], 10) - 1);
      group.position.set(x, 0.1, z);
      group.userData.square = p.square;
      this.scene.add(group);
      this.pieceGroups.set(p.square, group);
    }
  }

  pieceAt(square) { return this.pieceGroups.get(square) || null; }

  /* Highlights: at most 3 pastel-green tiles, plus a blue selection tile. */
  setHighlights(squares) {
    this.clearHighlights();
    for (const sq of squares.slice(0, 3)) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.94), this.highlightMat);
      mesh.rotation.x = -Math.PI / 2;
      const { x, z } = this.squareToPos(FILES.indexOf(sq[0]), parseInt(sq[1], 10) - 1);
      mesh.position.set(x, 0.115, z);
      this.scene.add(mesh);
      this.highlights.set(sq, mesh);
    }
  }

  clearHighlights() {
    for (const m of this.highlights.values()) this.scene.remove(m);
    this.highlights.clear();
    this.clearArrows();
  }

  // One arcing arrow per (from, to) pair. The arc peaks above the pieces
  // so the arrow reads clearly instead of clipping through them.
  setArrows(pairs) {
    this.clearArrows();
    const up = new THREE.Vector3(0, 1, 0);
    for (const { from, to } of pairs) {
      if (from === to) continue;
      const a = this.squareToPos(FILES.indexOf(from[0]), parseInt(from[1], 10) - 1);
      const b = this.squareToPos(FILES.indexOf(to[0]), parseInt(to[1], 10) - 1);
      const start = new THREE.Vector3(a.x, 0.25, a.z);
      const end = new THREE.Vector3(b.x, 0.25, b.z);
      const dist = start.distanceTo(end);
      if (dist < 0.5) continue;
      const mid = start.clone().lerp(end, 0.5);
      mid.y = 0.25 + Math.min(1.6, 0.6 + dist * 0.35);
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.045, 8, false), this.arrowMat);
      const tangent = curve.getTangent(1).normalize();
      const coneH = 0.42;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.17, coneH, 14), this.arrowMat);
      cone.quaternion.setFromUnitVectors(up, tangent);
      cone.position.copy(end).addScaledVector(tangent, -coneH / 2 + 0.05);
      const group = new THREE.Group();
      group.add(tube, cone);
      this.scene.add(group);
      this.arrows.push(group);
    }
  }

  clearArrows() {
    for (const g of this.arrows) this.scene.remove(g);
    this.arrows = [];
  }

  setSelected(square) {
    this.clearSelection();
    if (!square) return;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.94), this.selectMat);
    mesh.rotation.x = -Math.PI / 2;
    const { x, z } = this.squareToPos(FILES.indexOf(square[0]), parseInt(square[1], 10) - 1);
    mesh.position.set(x, 0.11, z);
    this.scene.add(mesh);
    this.selectMesh = mesh;
    this.selectedSquare = square;
  }

  clearSelection() {
    if (this.selectMesh) this.scene.remove(this.selectMesh);
    this.selectMesh = null;
    this.selectedSquare = null;
  }

  /* Animation: tweens run in the render loop so the page never blocks. */
  tween(group, to, durMs, opts = {}) {
    this.tweens.push({
      group, from: group.position.clone(), to, start: performance.now(), durMs,
      arc: opts.arc || 0, bounces: opts.bounces || 0, wobble: opts.wobble || 0,
      onDone: opts.onDone || null,
    });
  }

  // Playful bounce-back for intercepted blunders: hops home with a wobble.
  bounceBack(square) {
    const group = this.pieceGroups.get(square);
    if (!group) return;
    const { x, z } = this.squareToPos(FILES.indexOf(square[0]), parseInt(square[1], 10) - 1);
    this.tween(group, new THREE.Vector3(x, 0.1, z), 700,
      { bounces: 3, arc: 0.55, wobble: 0.35 });
  }

  snapBack(square) {
    const group = this.pieceGroups.get(square);
    if (!group) return;
    const { x, z } = this.squareToPos(FILES.indexOf(square[0]), parseInt(square[1], 10) - 1);
    this.tween(group, new THREE.Vector3(x, 0.1, z), 180);
  }

  // Animate an applied move; captured pieces pop out of existence.
  animateMove(from, to, capturedSquare) {
    const group = this.pieceGroups.get(from);
    if (!group) return;
    if (capturedSquare) {
      const victim = this.pieceGroups.get(capturedSquare);
      if (victim) {
        this.scalers.push({ group: victim, start: performance.now(), durMs: 200 });
        this.pieceGroups.delete(capturedSquare);
      }
    }
    const { x, z } = this.squareToPos(FILES.indexOf(to[0]), parseInt(to[1], 10) - 1);
    this.tween(group, new THREE.Vector3(x, 0.1, z), 260, { arc: 0.4 });
    this.pieceGroups.delete(from);
    group.userData.square = to;
    this.pieceGroups.set(to, group);
  }

  /* Input: drag-and-drop primary, click-to-select then click-tile also works. */
  bindInput() {
    const el = this.renderer.domElement;

    const setPointer = (x, y) => {
      const rect = el.getBoundingClientRect();
      this.pointer.x = ((x - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((y - rect.top) / rect.height) * 2 + 1;
    };

    const pickPiece = () => {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hits = this.raycaster.intersectObjects([...this.pieceGroups.values()], true);
      if (!hits.length) return null;
      let obj = hits[0].object;
      while (obj && !obj.userData.square) obj = obj.parent;
      return obj ? obj.userData.square : null;
    };

    const planePoint = () => {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const point = new THREE.Vector3();
      return this.raycaster.ray.intersectPlane(this.dragPlane, point) ? point : null;
    };

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
      setPointer(this.pinch.prevMid.x, this.pinch.prevMid.y);
      const wOld = planePoint();
      this.viewDist = Math.min(this.viewDistDefault,
        Math.max(this.viewDistMin, this.viewDist * (this.pinch.prevDist / d)));
      this.updateCamera();
      setPointer(mid.x, mid.y);
      const wNew = planePoint();
      if (wOld && wNew) {
        this.viewTarget.x = Math.max(-3.5, Math.min(3.5, this.viewTarget.x + wOld.x - wNew.x));
        this.viewTarget.z = Math.max(-3.5, Math.min(3.5, this.viewTarget.z + wOld.z - wNew.z));
        this.updateCamera();
      }
      this.pinch.prevDist = d;
      this.pinch.prevMid = mid;
    };

    // A drag interrupted by a second finger: the piece goes home.
    const cancelDrag = () => {
      if (!this.dragged) return;
      const { square, group } = this.dragged;
      const { x, z } = this.squareToPos(FILES.indexOf(square[0]), parseInt(square[1], 10) - 1);
      group.position.set(x, 0.1, z);
      this.dragged = null;
    };

    el.addEventListener('pointerdown', (e) => {
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
      setPointer(e.clientX, e.clientY);
      const square = pickPiece();
      this.downInfo = { time: performance.now(), x: e.clientX, y: e.clientY, hitPiece: !!square };
      if (square) {
        const group = this.pieceGroups.get(square);
        if (group.userData.color !== this.turn) {
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
        group.position.y = 0.55; // lift while dragging
        this.dragged = { square, group };
      } else if (this.selectedSquare) {
        const point = planePoint();
        const tile = point ? this.posToSquare(point.x, point.z) : null;
        if (tile) this.cb.onTileClick(tile);
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this.pinch) { pinchMove(); return; }
      if (!this.dragged) return;
      setPointer(e.clientX, e.clientY);
      const point = planePoint();
      if (!point) return;
      this.dragged.group.position.x = Math.max(-4, Math.min(4, point.x));
      this.dragged.group.position.z = Math.max(-4, Math.min(4, point.z));
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
      const { square, group } = this.dragged;
      this.dragged = null;
      this.downInfo = null;
      setPointer(e.clientX, e.clientY);
      const point = planePoint();
      const tile = point ? this.posToSquare(point.x, point.z) : null;
      if (!tile || tile === square) {
        // Dropped on its own square: stay selected (click mode armed).
        group.position.y = 0.1;
        return;
      }
      // The app resolves legality; the view leaves the piece on the
      // drop square until the app animates it home or to its target.
      group.position.y = 0.1;
      this.cb.onDrop(square, tile);
    });

    window.addEventListener('pointercancel', (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      cancelDrag();
      this.downInfo = null;
    });
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Apply the pinch-zoom view state to the camera.
  updateCamera() {
    this.camera.position.copy(this.viewTarget).addScaledVector(this.viewDir, this.viewDist);
    this.camera.lookAt(this.viewTarget);
  }

  // Back to the full board (double-tap the board).
  resetView() {
    this.viewTarget.set(0, 0, 0);
    this.viewDist = this.viewDistDefault;
    this.updateCamera();
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const now = performance.now();
    const t = this.clock.getElapsedTime();

    // Soft pulse on the green highlights and arrows.
    this.highlightMat.emissiveIntensity = 0.65 + 0.35 * Math.sin(t * 3);
    this.arrowMat.opacity = 0.7 + 0.3 * Math.sin(t * 3);

    this.tweens = this.tweens.filter((tw) => {
      const p = Math.min(1, (now - tw.start) / tw.durMs);
      const pos = tw.from.clone().lerp(tw.to, p);
      if (tw.bounces > 0) pos.y += Math.abs(Math.sin(p * Math.PI * tw.bounces)) * tw.arc;
      else if (tw.arc > 0) pos.y += Math.sin(p * Math.PI) * tw.arc;
      if (tw.wobble > 0) tw.group.rotation.z = Math.sin(p * Math.PI * 6) * tw.wobble * (1 - p);
      tw.group.position.copy(pos);
      if (p >= 1) {
        tw.group.position.copy(tw.to);
        tw.group.rotation.z = 0;
        if (tw.onDone) tw.onDone();
        return false;
      }
      return true;
    });

    this.scalers = this.scalers.filter((s) => {
      const p = Math.min(1, (now - s.start) / s.durMs);
      s.group.scale.setScalar(Math.max(0.01, 1 - p));
      if (p >= 1) { this.scene.remove(s.group); return false; }
      return true;
    });

    this.renderer.render(this.scene, this.camera);
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
    this.engine = new EngineBridge('engine-worker.js');
    this.network = new NetworkSyncBridge();
    this.view = new BoardView(document.getElementById('scene-container'), {
      onSelect: (sq) => this.onSelect(sq),
      onDrop: (from, to) => this.handleHumanMove(from, to),
      onTileClick: (sq) => {
        if (this.view.selectedSquare) this.handleHumanMove(this.view.selectedSquare, sq);
      },
    });

    this.mode = document.getElementById('mode').value; // 'solo' | 'advise'
    // Assist dial: 'full' (suggested moves only), 'hints' (no intercept),
    // 'off' (no partner output at all). This is the partner's help level,
    // not the solo opponent — Stockfish still plays Black in solo mode
    // when assist is off. Networked rule (decided 2026-10-30): centaur
    // vs centaur, and either side may start a game with assist at zero.
    this.assist = document.getElementById('assist').value;
    this.inputLocked = false;
    this.cachedAnalysis = null; // { fen, lines } — freshest engine view
    this.highlightFen = null;
    this.highlightSquares = new Set();
    this.highlightPairs = []; // (from, to) pairs behind the live suggestions
    this.toastTimer = null;

    this.el = {
      status: document.getElementById('status'),
      lines: document.getElementById('lines'),
      moves: document.getElementById('moves'),
      evalFill: document.getElementById('eval-fill'),
      evalLabel: document.getElementById('eval-label'),
      toast: document.getElementById('toast'),
      engineStatus: document.getElementById('engine-status'),
      engineText: document.getElementById('engine-text'),
    };

    document.getElementById('btn-new').addEventListener('click', () => this.newGame());
    document.getElementById('btn-flip').addEventListener('click', () => {
      this.view.setFlipped(!this.view.flipped);
      // Flipping wipes overlays; re-show this turn's suggestions.
      if (this.highlightPairs.length > 0) {
        this.view.setHighlights(this.highlightPairs.map((p) => p.to));
        this.view.setArrows(this.highlightPairs);
      }
    });
    document.getElementById('btn-hint').addEventListener('click', () => this.showHint());
    document.getElementById('mode').addEventListener('change', (e) => {
      this.mode = e.target.value;
      // Switching to solo with Black to move hands the turn to Stockfish.
      if (this.mode === 'solo' && this.state.turn() === 'b' && !this.state.isGameOver()) this.aiReply();
    });
    document.getElementById('assist').addEventListener('change', (e) => {
      this.assist = e.target.value;
      if (this.assist === 'off') {
        // Partner goes quiet immediately: no glows, no lines, neutral bar.
        this.view.clearHighlights();
        this.highlightFen = null;
        this.highlightSquares = new Set();
        this.highlightPairs = [];
        this.el.lines.innerHTML = '<li class="lines-empty">AI assist is off.</li>';
        this.el.evalFill.style.height = '50%';
        this.el.evalLabel.textContent = '—';
      } else {
        this.refreshAnalysis().then(() => this.maybeAutoHint());
      }
    });
    // Solo-opponent strength: only the Stockfish side in solo mode plays
    // weaker. Hints, lines, and the blunder intercept stay full strength.
    this.opponent = document.getElementById('opponent').value;
    document.getElementById('opponent').addEventListener('change', (e) => {
      this.opponent = e.target.value;
    });
    // Auto hints are ON by default: the partner asks for hints every turn
    // without waiting for a selection or the Ask button.
    this.autoHints = document.getElementById('auto-hints').checked;
    document.getElementById('auto-hints').addEventListener('change', (e) => {
      this.autoHints = e.target.checked;
      if (this.autoHints) this.maybeAutoHint();
      else {
        this.view.clearHighlights();
        this.highlightFen = null;
        this.highlightSquares = new Set();
        this.highlightPairs = [];
      }
    });
  }

  async start() {
    await this.network.connect();
    const engineOk = await this.engine.init();
    this.el.engineStatus.classList.toggle('ready', engineOk);
    this.el.engineStatus.classList.toggle('failed', !engineOk);
    this.el.engineText.textContent = engineOk
      ? `Partner ready — Stockfish, depth ${CONFIG.ENGINE_DEPTH}, MultiPV ${CONFIG.ENGINE_MULTIPV}`
      : 'Partner unavailable (engine failed to load) — playing without hints';
    this.view.setPieces(this.state.pieces());
    this.refreshUI();
    // Background analysis fills eval bar + lines panel, then auto hints
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
    this.el.status.textContent = this.state.statusText();
    this.view.turn = this.state.turn();
    const history = this.state.history();
    this.el.moves.innerHTML = '';
    for (let i = 0; i < history.length; i += 2) {
      const li = document.createElement('li');
      li.textContent = `${i / 2 + 1}. ${history[i].san}${history[i + 1] ? ' ' + history[i + 1].san : ''}`;
      this.el.moves.appendChild(li);
    }
    this.el.moves.scrollTop = this.el.moves.scrollHeight;
  }

  // White-perspective score -> eval bar + lines panel.
  renderAnalysis(lines) {
    if (!lines.length) return;
    const turn = this.state.turn();
    const best = lines[0];
    const cpWhite = turn === 'w' ? lineScoreCp(best) : -lineScoreCp(best);
    const pct = 100 / (1 + Math.exp(-0.004 * cpWhite));
    this.el.evalFill.style.height = `${pct}%`;
    this.el.evalLabel.textContent = formatScoreCp(cpWhite);

    this.el.lines.innerHTML = '';
    for (const line of lines) {
      const from = line.pv[0].slice(0, 2);
      const to = line.pv[0].slice(2, 4);
      const san = (this.state.legalMovesFrom(from).find((m) => m.to === to) || {}).san || line.pv[0];
      const cpLineWhite = turn === 'w' ? lineScoreCp(line) : -lineScoreCp(line);
      const li = document.createElement('li');
      li.innerHTML = `<b>${san}</b> (${formatScoreCp(cpLineWhite)}) <span style="color:#9aa7b5">${line.pv.join(' ')}</span>`;
      this.el.lines.appendChild(li);
    }
  }

  // Background analysis of the current position: refreshes the cached
  // best score (used by blunder math) and the eval/lines panels. Never
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

  // Auto hints: same as Ask partner, but silent and automatic. Runs at
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

  async showHint() {
    if (this.inputLocked || this.state.isGameOver()) return;
    if (this.assist === 'off') {
      this.toast('AI assist is off. Turn it up to get partner hints.');
      return;
    }
    const fen = this.state.fen();
    const lines = await this.engine.analyze(fen);
    if (this.state.fen() !== fen || !lines.length) return;
    this.cachedAnalysis = { fen, lines };
    this.renderAnalysis(lines);
    const pairs = this.pickHighlightDestinations(lines, null);
    this.highlightFen = fen;
    this.highlightSquares = new Set(pairs.map((p) => p.to));
    this.highlightPairs = pairs;
    this.view.setHighlights(pairs.map((p) => p.to));
    this.view.setArrows(pairs);
    this.toast("Your partner's top ideas are glowing green.");
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
  async handleHumanMove(from, to) {
    if (this.inputLocked || this.state.isGameOver()) { this.view.snapBack(from); return; }
    const res = this.state.tryMove(from, to);
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
  finalizeMove(res) {
    const move = res.move;
    // En passant captures a pawn that is NOT on the destination square.
    let capturedSquare = null;
    if (move.captured) {
      capturedSquare = move.flags.includes('e') ? move.to[0] + move.from[1] : move.to;
    }
    this.view.animateMove(move.from, move.to, capturedSquare);
    // Castling: the rook rides along.
    if (move.flags.includes('k')) {
      const rank = move.from[1];
      this.view.animateMove('h' + rank, 'f' + rank, null);
    } else if (move.flags.includes('q')) {
      const rank = move.from[1];
      this.view.animateMove('a' + rank, 'd' + rank, null);
    }

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
    const res = this.state.tryMove(uci.slice(0, 2), uci.slice(2, 4));
    if (res) this.finalizeMove(res);
  }

  newGame() {
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
    this.el.lines.innerHTML = '<li class="lines-empty">Select a piece or press “Ask partner”.</li>';
    this.el.evalFill.style.height = '50%';
    this.el.evalLabel.textContent = '+0.0';
    this.refreshUI();
    this.refreshAnalysis().then(() => this.maybeAutoHint());
  }
}

/* Boot. Module scripts run after the DOM is parsed, so elements exist. */
const app = new CentaurApp();
app.start();
