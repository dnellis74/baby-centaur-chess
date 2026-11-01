/* Baby Centaur Chess — piece art (Phase 2).
 *
 * Black-and-white chubby monsters. Each piece keeps its classic outline
 * (made chubby) so it stays identifiable at a glance, and carries its own
 * face: the pawn's approved cozy face, and a different lovable face per
 * piece for the rest. Faces sit on the body (on the head for the knight,
 * whose outline is a horse head in profile).
 *
 * Two colors only, and the whole drawing inverts per team:
 *   F = piece fill, L = line and face color.
 *   White team: F white, L black. Black team: F black, L white.
 * So eyes, mouths, teeth, blush, and outlines all flip together, and one
 * definition serves both teams. viewBox is 0 0 100 100 for every piece;
 * pieceArt normalizes each drawing to 90% of the square height (a scale
 * plus translate wrap), so faces are as large as possible on a phone.
 * That means every piece stands the same height: the classic height
 * order is intentionally not kept. */

const ART = {
  // King: three-point crown with a cross finial, sleepy content eyes.
  k: (F, L) => `<svg viewBox="0 0 100 100" aria-hidden="true">`
    + `<ellipse cx="50" cy="89" rx="24" ry="2.5" fill="${F}" stroke="${L}" stroke-width="2.5"/>`
    + `<path d="M36 26 L42 32 L50 22 L58 32 L64 26 L64 38 C66 50 69 65 70 81 L74 89 L26 89 L30 81 C31 65 34 50 36 38 Z" fill="${F}" stroke="${L}" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<rect x="48.75" y="12" width="2.5" height="11" fill="${F}" stroke="${L}" stroke-width="1.5"/>`
    + `<rect x="45" y="15.5" width="10" height="3" fill="${F}" stroke="${L}" stroke-width="1.5"/>`
    + `<path d="M41 58 Q45 53 49 58" stroke="${L}" stroke-width="2" fill="none" stroke-linecap="round"/>`
    + `<path d="M51 58 Q55 53 59 58" stroke="${L}" stroke-width="2" fill="none" stroke-linecap="round"/>`
    + `<path d="M42 68 Q50 73 58 68" stroke="${L}" stroke-width="2" fill="none" stroke-linecap="round"/>`
    + `<circle cx="36" cy="64" r="2" fill="none" stroke="${L}" stroke-width="1.5"/>`
    + `<circle cx="64" cy="64" r="2" fill="none" stroke="${L}" stroke-width="1.5"/>`
    + `</svg>`,

  // Queen: ball-tipped coronet, sparkling eyes with lashes.
  q: (F, L) => `<svg viewBox="0 0 100 100" aria-hidden="true">`
    + `<ellipse cx="50" cy="89" rx="24" ry="2.5" fill="${F}" stroke="${L}" stroke-width="2.5"/>`
    + `<path d="M36 38 L38 24 L42 29 L45 22 L48 28 L50 20 L52 28 L55 22 L58 29 L62 24 L64 38 C66 50 69 65 70 81 L74 89 L26 89 L30 81 C31 65 34 50 36 38 Z" fill="${F}" stroke="${L}" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<circle cx="38" cy="23" r="2.5" fill="${F}" stroke="${L}" stroke-width="1.5"/>`
    + `<circle cx="45" cy="21" r="2.5" fill="${F}" stroke="${L}" stroke-width="1.5"/>`
    + `<circle cx="50" cy="19" r="2.5" fill="${F}" stroke="${L}" stroke-width="1.5"/>`
    + `<circle cx="55" cy="21" r="2.5" fill="${F}" stroke="${L}" stroke-width="1.5"/>`
    + `<circle cx="62" cy="23" r="2.5" fill="${F}" stroke="${L}" stroke-width="1.5"/>`
    + `<circle cx="44" cy="57" r="4" fill="${L}"/><circle cx="56" cy="57" r="4" fill="${L}"/>`
    + `<circle cx="42.5" cy="55.5" r="1.5" fill="${F}"/><circle cx="54.5" cy="55.5" r="1.5" fill="${F}"/>`
    + `<path d="M41 54 L39 51 M44 53 L44 49 M47 54 L49 51" stroke="${L}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
    + `<path d="M53 54 L51 51 M56 53 L56 49 M59 54 L61 51" stroke="${L}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
    + `<path d="M45 68 Q50 71 55 68" stroke="${L}" stroke-width="2" fill="none" stroke-linecap="round"/>`
    + `<circle cx="37" cy="64" r="2" fill="none" stroke="${L}" stroke-width="1.5"/>`
    + `<circle cx="63" cy="64" r="2" fill="none" stroke="${L}" stroke-width="1.5"/>`
    + `</svg>`,

  // Rook: crenellated top, big laugh with two teeth, happy brows.
  r: (F, L) => `<svg viewBox="0 0 100 100" aria-hidden="true">`
    + `<ellipse cx="50" cy="89" rx="24" ry="2.5" fill="${F}" stroke="${L}" stroke-width="2.5"/>`
    + `<path d="M34 42 L34 30 L41 30 L41 37 L46 37 L46 30 L54 30 L54 37 L59 37 L59 30 L66 30 L66 42 C67 55 69 68 70 81 L74 89 L26 89 L30 81 C31 68 33 55 34 42 Z" fill="${F}" stroke="${L}" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<path d="M39 51 Q43 48 47 51" stroke="${L}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
    + `<path d="M53 51 Q57 48 61 51" stroke="${L}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
    + `<circle cx="43" cy="58" r="4.5" fill="${L}"/><circle cx="57" cy="58" r="4.5" fill="${L}"/>`
    + `<circle cx="41.5" cy="56.5" r="1.5" fill="${F}"/><circle cx="55.5" cy="56.5" r="1.5" fill="${F}"/>`
    + `<path d="M40 66 Q50 70 60 66 Q60 78 50 79 Q40 78 40 66 Z" fill="${L}"/>`
    + `<rect x="44" y="67" width="4" height="3.5" rx="0.5" fill="${F}"/>`
    + `<rect x="52" y="67" width="4" height="3.5" rx="0.5" fill="${F}"/>`
    + `</svg>`,

  // Bishop: pointed mitre with slit and collar, one wink and a smirk.
  b: (F, L) => `<svg viewBox="0 0 100 100" aria-hidden="true">`
    + `<ellipse cx="50" cy="89" rx="24" ry="2.5" fill="${F}" stroke="${L}" stroke-width="2.5"/>`
    + `<path d="M38 40 C38 30 43 24 50 22 C57 24 62 30 62 40 C64 52 68 66 70 81 L74 89 L26 89 L30 81 C32 66 36 52 38 40 Z" fill="${F}" stroke="${L}" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<path d="M47 33 L53 27" stroke="${L}" stroke-width="2" stroke-linecap="round"/>`
    + `<path d="M37 41 L63 41" stroke="${L}" stroke-width="1.5" stroke-linecap="round"/>`
    + `<circle cx="44" cy="58" r="4" fill="${L}"/><circle cx="42.5" cy="56.5" r="1.5" fill="${F}"/>`
    + `<path d="M52 58 Q56 54 60 58" stroke="${L}" stroke-width="2" fill="none" stroke-linecap="round"/>`
    + `<path d="M43 67 Q51 72 58 66" stroke="${L}" stroke-width="2" fill="none" stroke-linecap="round"/>`
    + `<circle cx="37" cy="64" r="2" fill="none" stroke="${L}" stroke-width="1.5"/>`
    + `<circle cx="63" cy="64" r="2" fill="none" stroke="${L}" stroke-width="1.5"/>`
    + `</svg>`,

  // Knight: horse head in profile, facing left. One big eye, muzzle grin.
  n: (F, L) => `<svg viewBox="0 0 100 100" aria-hidden="true">`
    + `<ellipse cx="50" cy="89" rx="24" ry="2.5" fill="${F}" stroke="${L}" stroke-width="2.5"/>`
    + `<path d="M40 32 L44 40 L50 28 L55 38 C62 40 68 46 68 54 C68 64 69 72 70 81 L74 89 L26 89 L30 81 C31 74 32 68 34 62 C30 58 27 55 27 51 C27 47 31 45 35 45 C37 41 38 36 40 32 Z" fill="${F}" stroke="${L}" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<path d="M42 38 Q46 35 50 38" stroke="${L}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
    + `<circle cx="46" cy="44" r="4" fill="${L}"/><circle cx="44.5" cy="42.5" r="1.5" fill="${F}"/>`
    + `<circle cx="30" cy="49" r="1.2" fill="${L}"/>`
    + `<path d="M28 52 Q32 56 36 52" stroke="${L}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
    + `</svg>`,

  // Pawn: the approved cozy face (big soft eyes, open grin, one tooth,
  // blush), on the approved chubby pawn outline, scaled to sit shortest
  // in the set. Face on the body, ball left blank.
  p: (F, L) => `<svg viewBox="0 0 100 100" aria-hidden="true">`
    + `<ellipse cx="50" cy="90" rx="16.5" ry="2" fill="${F}" stroke="${L}" stroke-width="2.5"/>`
    + `<path d="M36.5 84 L63.5 84 L66.5 90 L33.5 90 Z" fill="${F}" stroke="${L}" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<path d="M41.5 61.5 C37 66 36.5 75.5 36.5 84 L63.5 84 C63.5 75.5 63 66 58.5 61.5 Z" fill="${F}" stroke="${L}" stroke-width="2.5" stroke-linejoin="round"/>`
    + `<rect x="40" y="57" width="20" height="4.5" rx="2" fill="${F}" stroke="${L}" stroke-width="2.5"/>`
    + `<circle cx="50" cy="48" r="10" fill="${F}" stroke="${L}" stroke-width="2.5"/>`
    + `<circle cx="45.5" cy="69" r="2.8" fill="${L}"/><circle cx="54.5" cy="69" r="2.8" fill="${L}"/>`
    + `<circle cx="44.5" cy="68" r="1" fill="${F}"/><circle cx="55.5" cy="68" r="1" fill="${F}"/>`
    + `<circle cx="40" cy="74" r="1.5" fill="none" stroke="${L}" stroke-width="1.5"/>`
    + `<circle cx="60" cy="74" r="1.5" fill="none" stroke="${L}" stroke-width="1.5"/>`
    + `<path d="M43 75 Q50 77.5 57 75 Q56.5 81.5 50 82 Q43.5 81.5 43 75 Z" fill="${L}"/>`
    + `<rect x="48.5" y="76" width="3" height="2.5" rx="0.5" fill="${F}"/>`
    + `</svg>`,
};

// Scale + translate that maps each piece's own vertical span onto
// y 5..95 (90% of the square height), centered horizontally. Derived
// from each outline's top and bottom: king 12..91.5, queen 16.5..91.5,
// bishop 22..91.5, knight 28..91.5, rook 30..91.5, pawn 38..92.
const NORM = {
  k: 'translate(-6.6 -8.58) scale(1.132)',
  q: 'translate(-10 -14.8) scale(1.2)',
  b: 'translate(-14.75 -23.49) scale(1.295)',
  n: 'translate(-20.85 -34.68) scale(1.417)',
  r: 'translate(-23.15 -38.89) scale(1.463)',
  p: 'translate(-33.35 -58.35) scale(1.667)',
};

// type: 'k' | 'q' | 'r' | 'b' | 'n' | 'p'; color: 'w' | 'b'.
export function pieceArt(type, color) {
  const F = color === 'w' ? '#ffffff' : '#000000';
  const L = color === 'w' ? '#000000' : '#ffffff';
  const svg = ART[type](F, L);
  return svg
    .replace('<svg viewBox="0 0 100 100" aria-hidden="true">',
      `<svg viewBox="0 0 100 100" aria-hidden="true"><g transform="${NORM[type]}">`)
    .replace('</svg>', '</g></svg>');
}
