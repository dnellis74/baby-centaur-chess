/* Baby Centaur Chess — configuration.
 *
 * For kids, the interface shows only a small title, the board, the
 * score slider, and a message box. Everything tunable lives here, not
 * in the interface. Edit these values to change behavior; the values
 * below are the ones the interface used to offer as options.
 *
 * On every publish, bump the ?v= number on every asset reference
 * (index.html, and the imports in app.js) so a new release can never
 * mix with cached old files. */

// 'solo': you play White against Stockfish.
// 'advise': the partner advises both sides.
export const MODE = 'solo';

// Partner help level. 'full': only suggested moves are playable.
// 'hints': hints glow but any legal move is allowed. 'off': no
// partner output at all (Stockfish still plays Black in solo mode).
export const ASSIST = 'full';

// Solo-opponent strength: 'gentle' | 'friendly' | 'full'.
// Hints, lines, and the blunder intercept always stay full strength.
export const OPPONENT = 'gentle';

// Show partner hints automatically each turn, without being asked.
export const AUTO_HINTS = true;

// Start with the board flipped (Black at the bottom).
export const FLIPPED = false;

// Game server for network play (Phase 3). The live worker URL; the game
// connects over wss to <WORKER_URL>/room/<id>. The "Play with a friend"
// button always shows when this is set; the game stays solo vs
// Stockfish until it is tapped. For local testing,
// ?worker=ws://localhost:8787 overrides this without editing the file.
export const WORKER_URL = 'https://baby-centaur-chess-rooms.dnellis74.workers.dev';
