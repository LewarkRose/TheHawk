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

// ---------- THE SAME PRICES, READ THREE WAYS ----------
// closingChanceFor above divides each 1/price by their sum. That is the simple
// read, and it has a known lean: it leaves too much probability on the longest
// price and too little on the shortest. HAWK's own result record carries exactly
// that signature over 1,605 matches — the draw said 389.0 and happened 353 (-2.24
// points), the home win said 692.4 and happened 726 (+2.10) — which is what the
// proportional read predicts, because the draw is the long price in most matches.
//
// Suggestive, not settled: z is about -2.1 on one season. So nothing switches
// here. These two alternatives are scored against the SAME legs in grade.mjs and
// the record decides, the way a market earns its learning correction.
//
// Both assume the options partition the result — exactly one happens — so they
// are refused where OVERLAP says otherwise (double chance). There the simple
// read stays, and the leg is skipped rather than scored wrong.

// Σ f(k) is strictly decreasing in k here (every 1/price < 1), so plain bisection
// finds the single root. 60 halvings of [0,1] or [1,64] is far past float precision.
function solve(f, lo, hi, target) {
  let flo = f(lo);
  if (!isFinite(flo)) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2, v = f(mid);
    if (!isFinite(v)) return null;
    if ((v > target) === (flo > target)) { lo = mid; flo = v; } else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Power: find k with Σ (1/price)^k = 1, then read the option off at that k.
 *  Shrinks long prices harder than short ones, which is the correction. */
export function powerChance(opts, want) {
  const xs = Object.values(opts).filter((v) => v > 1).map((v) => 1 / v);
  const mine = opts[want];
  if (xs.length < 2 || !(mine > 1)) return null;
  if (xs.reduce((a, x) => a + x, 0) <= 1) return null;   // no margin to remove
  const k = solve((e) => xs.reduce((a, x) => a + x ** e, 0), 1, 64, 1);
  if (k == null || !(k > 0)) return null;
  const q = (1 / mine) ** k;
  return q > 0 && q < 1 ? q : null;
}

/** Shin: the margin is modelled as the book defending itself against insiders,
 *  which falls hardest on the long prices. z is that insider share. */
export function shinChance(opts, want) {
  const xs = Object.values(opts).filter((v) => v > 1).map((v) => 1 / v);
  const mine = opts[want];
  if (xs.length < 2 || !(mine > 1)) return null;
  const S = xs.reduce((a, x) => a + x, 0);
  if (S <= 1) return null;
  const pi = (x, z) => (Math.sqrt(z * z + 4 * (1 - z) * ((x * x) / S)) - z) / (2 * (1 - z));
  const z = solve((t) => xs.reduce((a, x) => a + pi(x, t), 0), 0, 0.999, 1);
  if (z == null) return null;
  const q = pi(1 / mine, z);
  return isFinite(q) && q > 0 && q < 1 ? q : null;
}

/** All three reads of the same line, or null where they cannot be compared
 *  on equal terms. Only legs where every method answered are ever scored. */
export function closingChancesAll(lineType, opts, want) {
  if ((OVERLAP[lineType] || 1) !== 1) return null;
  if (!opts || Object.values(opts).filter((v) => v > 1).length < 2) return null;
  const prop = closingChanceFor(lineType, opts, want);
  const power = powerChance(opts, want), shin = shinChance(opts, want);
  if (prop == null || power == null || shin == null) return null;
  return { prop, power, shin };
}
