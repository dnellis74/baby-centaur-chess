/* Baby Centaur Chess — games library (v3).
 *
 * The landing page is a list of ongoing games. This module is the
 * on-device store behind it, plus the status logic that decides what
 * each row says. It knows nothing about chess rules: a solo game is
 * stored as its move list (replayed through the rules engine when
 * opened), and a friend game is stored as its room id plus the last
 * known room state (the server holds the real move list).
 *
 * Entry shape:
 *   {
 *     id,            // solo: 'solo-<rand>'; friend: the room id
 *     kind,          // 'solo' | 'friend'
 *     name,          // the player's own name for the game
 *     createdAt, updatedAt,
 *     moves,         // solo only: [{ from, to, promotion }]
 *     roomId, seat,  // friend only: room id, 'w' | 'b' | null
 *     plies, seats,  // friend only: last known move count, { w, b }
 *     finished,      // game over was observed on this device
 *     result,        // status text at the finish, e.g. 'Checkmate! White wins'
 *   }
 *
 * Storage is injected (localStorage in the app, a fake in tests) and
 * every operation is fail-soft: a full or blocked store never breaks
 * the game itself, the list just forgets.
 */

const STORE_KEY = 'bcc-games-v1';

export class GameLibrary {
  constructor(storage) {
    this.storage = storage || null;
  }

  all() {
    try {
      const raw = this.storage ? this.storage.getItem(STORE_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((e) => e && e.id && e.kind) : [];
    } catch {
      return [];
    }
  }

  saveAll(entries) {
    try {
      if (this.storage) this.storage.setItem(STORE_KEY, JSON.stringify(entries));
    } catch { /* storage full/blocked: the list forgets, the game plays on */ }
  }

  // Most recently played first.
  list() {
    return this.all().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(id) {
    return this.all().find((e) => e.id === id) || null;
  }

  // Insert, or merge over the entry with the same id. Callers own
  // updatedAt: a move bumps it, a background state refresh does not
  // (unless it reveals new moves, which the caller handles).
  upsert(entry) {
    const entries = this.all();
    const i = entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) entries[i] = { ...entries[i], ...entry };
    else entries.push({ createdAt: Date.now(), updatedAt: Date.now(), ...entry });
    this.saveAll(entries);
    return this.get(entry.id);
  }

  remove(id) {
    this.saveAll(this.all().filter((e) => e.id !== id));
  }
}

// What a list row says. `live` is a fresh room probe
// ({ plies, seats: { w, b } }) or null when the room could not be
// probed; last known values from the entry fill in. The server never
// learns chess results, so `finished` only reflects what this device
// has seen with the game open.
export function gameStatus(entry, live) {
  if (entry.finished) return { key: 'finished', label: entry.result || 'Finished' };
  if (live && live.resigned) return { key: 'finished', label: 'Finished' };
  if (entry.kind === 'solo') return { key: 'your', label: 'Your move' };

  const plies = live ? live.plies : (entry.plies || 0);
  const seats = live ? live.seats : entry.seats;
  // The room had moves but now probes empty: its 7 quiet days ran
  // out. (Opening it again would start a fresh room under the same
  // link, so this only shows for rooms with real history.)
  if (live && plies === 0 && seats && !seats.w && !seats.b && (entry.plies || 0) > 0) {
    return { key: 'expired', label: 'Game expired' };
  }
  if (!entry.seat) return { key: 'new', label: 'Tap to open' };
  if (entry.seat === 'w' && seats && !seats.b) {
    return { key: 'waiting', label: 'Waiting for a friend' };
  }
  const turn = plies % 2 === 0 ? 'w' : 'b';
  return turn === entry.seat
    ? { key: 'your', label: 'Your move' }
    : { key: 'their', label: 'Their move' };
}

// Prefill for the name box: the next free "Game N".
export function suggestedGameName(entries) {
  const used = new Set(entries.map((e) => e.name));
  let n = entries.length + 1;
  while (used.has(`Game ${n}`)) n += 1;
  return `Game ${n}`;
}
