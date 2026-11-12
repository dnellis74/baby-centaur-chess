/* Baby Centaur Chess — room relay worker (Phase 3).
 *
 * Cloudflare Workers + Durable Objects. One Room object per game.
 * The server never runs an engine and never validates chess legality:
 * each device already runs Stockfish locally and only legal moves are
 * ever sent. The server only checks seat and turn (ply parity), relays
 * moves, and holds the room so a dropped player can rejoin it.
 *
 * Protocol (JSON over WebSocket, /room/<id>):
 *   Client -> server:
 *     { type: 'join', playerId }          first message on every socket
 *     { type: 'move', from, to, promotion? }
 *     { type: 'rematch' }                 reset the room for a new game
 *     { type: 'sync' }                    ask for a full welcome resync
 *   Server -> client:
 *     { type: 'welcome', seat, moves, peer }
 *     { type: 'move', from, to, promotion, by }
 *     { type: 'peer', connected }
 *     { type: 'reset' }
 *     { type: 'error', message }
 *     { type: 'full' }                    both seats taken, socket closes
 *
 * Seats are persistent per playerId: a player who drops and rejoins
 * with the same playerId gets the same seat back. Rooms expire 7 days
 * after their last activity (sliding alarm). No accounts, no chat.
 *
 * Read-only probe for the games list (v3): GET /room/<id>/state
 * returns { plies, seats: { w, b } } as JSON, so a device can show a
 * "your move" indicator without opening a socket or taking a seat.
 * The probe counts as room activity and renews the sliding expiry.
 * Dependency-free on purpose, so this file can also be pasted into
 * the Cloudflare dashboard. Plain WebSocket accept (no hibernation
 * API) for the first cut; hibernation is a later cost optimization.
 */

const ROOM_TTL_MS = 7 * 24 * 3600 * 1000;
const SQUARE = /^[a-h][1-8]$/;
const PROMOTIONS = new Set(['q', 'r', 'b', 'n']);

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sockets = new Map(); // ws -> { playerId, seat }
    this.players = null; // playerId -> seat, loaded lazily
    this.moves = null; // [{ from, to, promotion }], loaded lazily
    this.loaded = null; // promise, so concurrent fetches share one load
  }

  // Debug log (visible via `npx wrangler tail` or the dashboard's
  // worker logs). Sparse on purpose: joins, moves, probes, refusals.
  log(...args) {
    let id = '?';
    try { if (this.ctx.id) id = String(this.ctx.id).slice(0, 8); } catch { /* stub ctx in tests */ }
    console.log(`[room ${id}]`, ...args);
  }

  async ensureLoaded() {
    if (!this.loaded) {
      this.loaded = (async () => {
        const [players, moves] = await Promise.all([
          this.ctx.storage.get('players'),
          this.ctx.storage.get('moves'),
        ]);
        this.players = players || {};
        this.moves = moves || [];
      })();
    }
    return this.loaded;
  }

  async save() {
    await Promise.all([
      this.ctx.storage.put('players', this.players),
      this.ctx.storage.put('moves', this.moves),
    ]);
    // Sliding expiry: every mutation pushes the room's death out.
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  async fetch(request) {
    await this.ensureLoaded();
    // Read-only state probe (games list): no socket, no seat taken.
    // A list check counts as room activity, so it renews the expiry.
    if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/state')) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      const seats = {
        w: Object.values(this.players).includes('w'),
        b: Object.values(this.players).includes('b'),
      };
      this.log(`state probe plies=${this.moves.length} seats w=${seats.w} b=${seats.b}`);
      return new Response(JSON.stringify({ plies: this.moves.length, seats }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.set(server, { playerId: null, seat: null });
    server.addEventListener('message', (event) => {
      this.onMessage(server, event.data).catch(() => {});
    });
    server.addEventListener('close', () => {
      this.onClose(server).catch(() => {});
    });
    server.addEventListener('error', () => {
      this.onClose(server).catch(() => {});
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    } catch { /* socket went away; close handler cleans up */ }
  }

  // Every open socket holding this seat (normally one; two tabs share).
  sendToSeat(seat, obj) {
    for (const [ws, s] of this.sockets) {
      if (s.seat === seat) this.send(ws, obj);
    }
  }

  seatConnected(seat) {
    for (const [, s] of this.sockets) {
      if (s.seat === seat) return true;
    }
    return false;
  }

  otherSeat(seat) {
    return seat === 'w' ? 'b' : 'w';
  }

  async welcome(ws, session) {
    this.send(ws, {
      type: 'welcome',
      seat: session.seat,
      moves: this.moves,
      peer: this.seatConnected(this.otherSeat(session.seat)),
    });
  }

  async onMessage(ws, raw) {
    await this.ensureLoaded();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // malformed: ignore, stay connected
    }
    const session = this.sockets.get(ws);
    if (!session) return;

    if (msg.type === 'join') {
      if (typeof msg.playerId !== 'string' || !msg.playerId) {
        ws.close(1008, 'join needs a playerId');
        return;
      }
      session.playerId = msg.playerId;
      if (this.players[msg.playerId]) {
        session.seat = this.players[msg.playerId];
      } else if (!Object.values(this.players).includes('w')) {
        session.seat = 'w';
        this.players[msg.playerId] = 'w';
      } else if (!Object.values(this.players).includes('b')) {
        session.seat = 'b';
        this.players[msg.playerId] = 'b';
      } else {
        this.log(`join REFUSED (room full) player=${msg.playerId.slice(0, 8)}`);
        this.send(ws, { type: 'full' });
        ws.close(1008, 'room is full');
        return;
      }
      this.log(`join player=${msg.playerId.slice(0, 8)} seat=${session.seat} players=${Object.keys(this.players).length} plies=${this.moves.length}`);
      await this.save();
      await this.welcome(ws, session);
      // Tell the other seat a friend arrived.
      this.sendToSeat(this.otherSeat(session.seat), { type: 'peer', connected: true });
      return;
    }

    // Everything below needs an assigned seat.
    if (!session.seat) return;

    if (msg.type === 'move') {
      const turn = this.moves.length % 2 === 0 ? 'w' : 'b';
      const okSquares = typeof msg.from === 'string' && SQUARE.test(msg.from)
        && typeof msg.to === 'string' && SQUARE.test(msg.to);
      const okPromo = msg.promotion === undefined || msg.promotion === null
        || PROMOTIONS.has(msg.promotion);
      if (session.seat !== turn || !okSquares || !okPromo) {
        this.log(`move REJECTED ${msg.from}-${msg.to} by=${session.seat} (turn=${turn})`);
        this.send(ws, { type: 'error', message: 'not your turn or bad move' });
        return;
      }
      const move = { from: msg.from, to: msg.to, promotion: msg.promotion || null };
      this.moves.push(move);
      this.log(`move ${move.from}-${move.to}${move.promotion || ''} by=${session.seat} plies=${this.moves.length}`);
      await this.save();
      this.sendToSeat(this.otherSeat(session.seat), { ...move, type: 'move', by: session.seat });
      return;
    }

    if (msg.type === 'rematch') {
      this.log(`rematch by=${session.seat}`);
      this.moves = [];
      await this.save();
      this.sendToSeat(this.otherSeat(session.seat), { type: 'reset' });
      return;
    }

    if (msg.type === 'sync') {
      await this.welcome(ws, session);
      return;
    }
    // Unknown type: ignore.
  }

  async onClose(ws) {
    const session = this.sockets.get(ws);
    this.sockets.delete(ws);
    if (session && session.seat) {
      // Only report the seat empty when no other socket holds it.
      if (!this.seatConnected(session.seat)) {
        this.sendToSeat(this.otherSeat(session.seat), { type: 'peer', connected: false });
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response('ok');
    }
    const stateMatch = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,64})\/state$/);
    if (stateMatch) {
      const id = env.ROOMS.idFromName(stateMatch[1]);
      return env.ROOMS.get(id).fetch(request);
    }
    const roomMatch = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,64})$/);
    if (roomMatch) {
      const id = env.ROOMS.idFromName(roomMatch[1]);
      return env.ROOMS.get(id).fetch(request);
    }
    return new Response(
      'Baby Centaur Chess rooms. Open a WebSocket to /room/<id>.',
      { status: 404 },
    );
  },
};
