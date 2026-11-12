# Baby Centaur Chess — room worker

Cloudflare Worker + Durable Object that relays moves between two players
in a room. No engine runs on the server: each device runs Stockfish
locally and only legal moves are ever sent. The server checks seat and
turn (ply parity), relays moves, and holds the room so a dropped player
can rejoin it.

## Live deployment

- URL: https://baby-centaur-chess-rooms.dnellis74.workers.dev
- Deployed: 2026-11-11 by Dave, `npx wrangler deploy` (wrangler 4.86.0)
  from his MacBook Pro.
- Version ID: 650f6e03-3d55-432e-8c19-10ab2f1057ad
- Binding: env.ROOMS (Room) Durable Object, live. Migration in
  wrangler.toml: tag v1, new_sqlite_classes ["Room"].
- /health returns "ok" (verified 2026-11-11). Root returns the usage
  line with HTTP 404, as designed.
- Deploy warns that preview URLs are enabled by default (preview_urls
  is not set in wrangler.toml). Harmless; leave it unless previews
  become a problem.

## Files

- src/index.js — the worker plus the Room class. Dependency-free on
  purpose, so it can also be pasted into the dashboard editor.
- wrangler.toml — name, main, compatibility date, DO binding, migration.
- test-protocol.mjs — node protocol test (see below).
- .wrangler/ — local wrangler state (logs, config). Not part of deploys.

## Redeploy

From this folder (Node 20+): `npx wrangler login` once per machine,
then `npx wrangler deploy`. It updates the worker in place under the
same name. `npx wrangler dev --port 8787` runs it locally for testing.

## Flushing all rooms

`node flush-rooms.mjs` deletes EVERY stored game. There is no API
to empty a Durable Object namespace, so the script renames the DO
class (Room -> Room2 -> ...), appends migrations that delete the
old class (and all its objects) and create the new one empty, then
runs `npx wrangler deploy`. It asks for confirmation unless --yes
is passed, supports --dry-run and --no-deploy, and rolls the file
edits back if the deploy fails. After a flush, tell Muse the new
class name so the repo copy of src/index.js and wrangler.toml
stays in sync with what is live.

## Protocol test

`WS_URL=wss://baby-centaur-chess-rooms.dnellis74.workers.dev node test-protocol.mjs`
(default WS_URL is ws://localhost:8787 for local dev). 18 checks: seats,
move relay, no echo of your own move, out-of-turn rejection, third-player
refusal, disconnect/rejoin resync, rematch. Result 2026-11-11 against
the live worker: ALL PASS.

Test fix 2026-11-11: clients now await the WebSocket `open` event
before sending. Fixed sleeps were not enough against the live worker
(TLS + cold start); the first live run failed with "Sent before
connected", a test bug, not a worker bug.

## Protocol (summary)

JSON over WebSocket at /room/<id>. Client sends: join {playerId}
(first message on every socket), move {from, to, promotion?}, rematch,
sync. Server sends: welcome {seat, moves, peer}, move
{from, to, promotion, by}, peer {connected}, reset, error {message},
full (both seats taken). Seats persist per playerId, so rejoining with
the same playerId restores the seat and the full move list. Rooms
expire 7 days after their last activity (sliding alarm).

Read-only probe (added for the v3 games list): GET /room/<id>/state
returns { plies, seats: { w, b } } as JSON with CORS open. It opens no
socket and takes no seat; the games list uses it for the your-move
indicators. A probe counts as room activity and renews the expiry.

## History (why deploy is wrangler-only)

- 2026-11-01: worker created and code pasted via the Cloudflare
  dashboard; /health ok. But the dashboard has no way to register a
  Durable Object class: a class that appears only in code is ignored
  until it is declared in config (migrations or the newer exports
  field) and applied by a wrangler deploy (Cloudflare docs). The
  Bindings dropdown only lists already-provisioned namespaces, so the
  ROOMS binding could not be added from the dashboard.
- wrangler login from this VM failed 3 times (2026-11-01): Cloudflare
  Turnstile blocked the agent sign-in, a browser-environment
  replacement lost the OAuth CSRF session, and the ~2-minute login
  window expired each time. Manual takeover also failed: the
  remote-session keyboard would not stay open for typing, and the
  email field ended up holding the game URL instead of the address.
  Dave self-ran `npx wrangler deploy` on his own machine on
  2026-11-11 and it worked first try (his browser + localhost
  callback, no remote session involved).
- wrangler.toml was updated 2026-11-01 from legacy new_classes to
  new_sqlite_classes (the current form for new classes). The Room code
  uses only storage APIs supported on SQLite-backed objects
  (get/put/setAlarm/deleteAll).

## Game wiring

The game (../config.js) connects wss to <WORKER_URL>/room/<id> when
WORKER_URL is set; empty means network play is off. Since v3, friend
games are created from the games list (the landing page), the list
probes <WORKER_URL>/room/<id>/state for live your-move indicators,
and room links carry the game name (?name=) so both players' lists
show the same name.
