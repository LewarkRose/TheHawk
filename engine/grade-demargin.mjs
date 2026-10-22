// De-margining a closing price, in one place so the safety test exercises the same
// code grade.mjs runs. A copy in the test would prove only that the copy works.
//
// A raw 1/price is inflated by the bookmaker's cut, so every option at the line is
// read, the implied chances are summed, and each is divided by the total. That is
// only correct when the options are mutually exclusive AND between them cover every
// outcome.
//
// DOUBLE CHANCE is neither. Its options are 1X, 12 and X2, and every result appears
// in two of them, so the true chances sum to 2 rather than 1. Normalising to 1
// halved every one: the closing-line block read Bet365 at 30.9% on double chances
// HAWK had at 62.0% and that landed 58.3%, which made HAWK look 903 per 10,000
// better than the market on the leg that opens nearly every ticket. Without it,
// HAWK's margin over the close is 10.5 per 10,000 across 2,519 legs — nothing.
// Found 2026-10-22, because a double chance at 30.9% would be odds of 3.24.
//
// If another overlapping market is ever priced here, add its line type below and a
// case to the safety test. Everything else normalises to 1.
export const OVERLAP = { 14: 2 };   // 365Scores line type -> how many options each result appears in

/** De-margined chance for one option at a line, or null if it can't be done safely.
 *  `opts` is {option name: decimal price} for every option the book closed. */
export function closingChanceFor(lineType, opts, want) {
  const mine = opts && opts[want];
  if (!(mine > 1)) return null;
  const all = Object.values(opts).filter((v) => v > 1);
  if (all.length < 2) return { q: 1 / mine, demargined: false }.q;
  const cover = OVERLAP[lineType] || 1;
  // With an option missing, the ones that remain sum to about 1 and dividing by 2
  // would halve them for real. Better to score nothing than to score it wrong.
  if (cover > 1 && all.length < 3) return null;
  const book = all.reduce((a, v) => a + 1 / v, 0) / cover;
  return book > 0 ? (1 / mine) / book : null;
}
