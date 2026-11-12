/* Phase 3 worker protocol test (node, no browser).
 * Two WebSocket clients play through a room on the worker
 * (local dev or live, via WS_URL): join/seats, move relay,
 * turn validation, third-player rejection,
 * disconnect + rejoin resync, rematch. Exits non-zero on any failure.
 * Clients await the WebSocket 'open' event before sending: fixed
 * sleeps were not enough against the live worker (TLS + cold start).
 */
const WS_URL = process.env.WS_URL || 'ws://localhost:8787';
const ROOM = `test-${Math.random().toString(36).slice(2, 10)}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(`${WS_URL}/room/${ROOM}`);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    name, ws, inbox,
    open: new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`${name} failed to connect`)), { once: true });
      setTimeout(() => reject(new Error(`${name} connect timed out`)), 10000);
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    waitFor: (pred, label, ms = 5000) => new Promise((resolve, reject) => {
      const found = inbox.find(pred);
      if (found) return resolve(found);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`${name} timed out waiting for ${label}`)), ms);
    }),
    close: () => ws.close(),
  };
}

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failures++;
};

const a = client('A');
const b = client('B');
await a.open;
await b.open;

a.send({ type: 'join', playerId: 'player-a' });
const wa = await a.waitFor((m) => m.type === 'welcome', 'A welcome');
check('A is White', wa.seat === 'w');
check('A starts with no moves', wa.moves.length === 0);
check('A sees no peer yet', wa.peer === false);

b.send({ type: 'join', playerId: 'player-b' });
const wb = await b.waitFor((m) => m.type === 'welcome', 'B welcome');
check('B is Black', wb.seat === 'b');
check('B sees peer connected', wb.peer === true);
const peerA = await a.waitFor((m) => m.type === 'peer' && m.connected === true, 'A peer event');
check('A got peer connected', !!peerA);

// White moves; Black receives it, White gets no echo.
a.send({ type: 'move', from: 'e2', to: 'e4' });
const mvB = await b.waitFor((m) => m.type === 'move' && m.from === 'e2', 'B receives e4');
check('B got e2e4 from White', mvB.by === 'w' && mvB.to === 'e4');
await wait(300);
check('A got no echo of own move', !a.inbox.some((m) => m.type === 'move'));

// White tries to move again out of turn: rejected, not relayed.
a.send({ type: 'move', from: 'd2', to: 'd4' });
const err = await a.waitFor((m) => m.type === 'error', 'A error');
check('Out-of-turn move rejected', !!err);
await wait(300);
check('Rejected move not relayed to B', !b.inbox.some((m) => m.type === 'move' && m.from === 'd2'));

// Black moves; White receives it.
b.send({ type: 'move', from: 'e7', to: 'e5' });
const mvA = await a.waitFor((m) => m.type === 'move' && m.from === 'e7', 'A receives e5');
check('A got e7e5 from Black', mvA.by === 'b');

// Third player is refused.
const c = client('C');
await c.open;
c.send({ type: 'join', playerId: 'player-c' });
const full = await c.waitFor((m) => m.type === 'full', 'C full');
check('Third player refused', !!full);
c.close();

// A drops and rejoins with the same playerId: same seat, full history.
a.close();
await wait(300);
const peerOff = await b.waitFor((m) => m.type === 'peer' && m.connected === false, 'B peer left');
check('B saw A leave', !!peerOff);
const a2 = client('A2');
await a2.open;
a2.send({ type: 'join', playerId: 'player-a' });
const wa2 = await a2.waitFor((m) => m.type === 'welcome', 'A2 welcome');
check('Rejoin keeps White seat', wa2.seat === 'w');
check('Rejoin resyncs both moves', wa2.moves.length === 2
  && wa2.moves[0].from === 'e2' && wa2.moves[1].from === 'e7');
const peerBack = await b.waitFor((m) => m.type === 'peer' && m.connected === true, 'B peer back');
check('B saw A come back', !!peerBack);

// Rematch from A: B gets reset.
a2.send({ type: 'rematch' });
const reset = await b.waitFor((m) => m.type === 'reset', 'B reset');
check('B got rematch reset', !!reset);
// After reset, White can move again (ply back to 0).
a2.send({ type: 'move', from: 'd2', to: 'd4' });
const mvB2 = await b.waitFor((m) => m.type === 'move' && m.from === 'd2', 'B receives d4 after reset');
check('Post-reset White move relayed', mvB2.by === 'w');

a2.close();
b.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
