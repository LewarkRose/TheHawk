// WHICH MARKETS THE PRICE BOOK ACTUALLY PRICES, PER LEAGUE.
//
// WHY. builder/engine.js:2090 states an assumption out loud, and uses it to
// charge an unpriced non-prop leg only five percent under HAWK's own fair odds:
//
//   "A corners or cards line our feed happens not to carry is still an ordinary
//    match market to Bet365, priced at the usual few percent; HAWK just can't
//    see the number."
//
// That is true in the Premier League and false for whole leagues. Measured
// 2026-11-21 off bets/lines, counting the markets Bet365 carries:
//
//   Serie A 20   Premier League 18   La Liga 18   Championship 14
//   Scottish 13 (no shots on target)   Eredivisie 12 (no cards, no SoT)
//   Liga Portugal 11 (no corners, cards or SoT)   MALTA 7 (none of them)
//
// Malta's seven are Full Time Result, Double Chance, Draw No Bet, 1st Half
// Result, First To Score, Asian Handicap and Total Goals In Match — checked on
// three fixtures across all four ODDS_COUNTRIES, identical every time. So for a
// Maltese match HAWK invents a price for a corner leg, ranks it, and puts it on
// a slip that cannot be placed anywhere. `priceBookMissing` cannot catch it:
// Bet365 IS there, with seven markets. It only ever asked "is the book here",
// never "does it price THIS".
//
// HOW. No new requests. grade.mjs already calls HAWK.match() on every fixture
// inside PREDICT_AHEAD_H, and every leg it gets back already carries the
// bookPrice that odds365() found. This just counts them.
//
// THE TRAP THAT SHAPES THE WHOLE MODULE. Two different things look identical
// from one league's counts:
//   1. Bet365 does not offer this market here        -> do not build the leg
//   2. the feed cannot see this market anywhere      -> today's behaviour
// Player props are case 2 by definition: Bet365 prices them and they are never
// in the feed, which is why propEstimate exists. Counting them would ban every
// player leg in every league. So props are skipped outright, and for everything
// else a market is only ever called ABSENT in a league once the same market has
// been seen priced in some OTHER league — proof the feed can see it at all.
// Absent everywhere means unknown, and unknown always means "carry on as before".

export const MIN_FIXTURES = 8;          // evidence before a market is called absent
// 2: the tally asks whether the BOOK carries the market, not whether HAWK's
// own line matched. v1 answered the second question and published the first,
// which is why it called Handicap absent in the Premier League. The bump is
// load-bearing -- grade.mjs starts a fresh tally on a version it does not
// recognise, and the v1 counts are contaminated by exactly this.
export const DEPTH_VERSION = 2;

export const newDepth = () => ({ ver: DEPTH_VERSION, leagues: {} });

/** Fold one fixture's legs into the tally. `legs` is matchJSON's leg list.
 *  Counted per MARKET, not per leg: Over 11.5 Corners may be missing while the
 *  corners market is plainly there, so the question is whether ANY line in the
 *  market carried a price. */
export function fold(depth, league, legs) {
  if (!league || !Array.isArray(legs) || !legs.length) return 0;
  const byMarket = new Map();
  for (const leg of legs) {
    // Props are the feed's known blind spot, never the book's. See above.
    if (!leg || !leg.market || leg.player || String(leg.id || "").startsWith("p:")) continue;
    // bookMarketSeen, not just bookPrice. HAWK builds handicaps at 1.5 and
    // 2.5; Bet365's Asian lines are -0.25, -0.5, -0.75. The market is right
    // there and no HAWK leg can ever match a value, so counting prices alone
    // read "Bet365 does not price handicaps in the Premier League" -- which
    // it plainly does. Same for 2nd Half Result, absent in all 17 leagues
    // that had any absence at all. A market the feed quotes at any line is a
    // market the book offers.
    const had = byMarket.get(leg.market) || false;
    byMarket.set(leg.market, had || leg.bookPrice > 1 || leg.bookMarketSeen === true);
  }
  if (!byMarket.size) return 0;
  const lg = (depth.leagues[league] ||= {});
  for (const [market, priced] of byMarket) {
    const cell = (lg[market] ||= { seen: 0, priced: 0 });
    cell.seen++;
    if (priced) cell.priced++;
  }
  return byMarket.size;
}

/** Every market seen priced in at least one league — proof the feed can see it. */
export function seenSomewhere(depth) {
  const out = new Set();
  for (const markets of Object.values(depth.leagues || {}))
    for (const [market, c] of Object.entries(markets)) if (c.priced > 0) out.add(market);
  return out;
}

/** "priced" | "absent" | "unknown" for one league and market.
 *  `known` is seenSomewhere(depth), passed in so a sweep computes it once. */
export function verdict(depth, league, market, known) {
  const cell = ((depth.leagues || {})[league] || {})[market];
  if (!cell) return "unknown";
  if (cell.priced > 0) return "priced";
  if (cell.seen < MIN_FIXTURES) return "unknown";
  // Never seen here, and never seen anywhere else either: that is the feed
  // being blind, not the book being empty. Changing anything on this would
  // silently delete markets on the strength of a gap in our own plumbing.
  return (known || seenSomewhere(depth)).has(market) ? "absent" : "unknown";
}

/** What the builder reads: {league: [markets Bet365 does not price there]}.
 *  Only settled answers travel — "unknown" is simply absent from the file, so a
 *  page that cannot fetch it behaves exactly as it did before this existed. */
export function absentTable(depth) {
  const known = seenSomewhere(depth), out = {};
  for (const [league, markets] of Object.entries(depth.leagues || {})) {
    const gone = Object.keys(markets)
      .filter((m) => verdict(depth, league, m, known) === "absent").sort();
    if (gone.length) out[league] = gone;
  }
  return out;
}

/** One line for the Actions summary, and the shape graded.json publishes. */
export function report(depth) {
  const table = absentTable(depth);
  let seen = 0, cells = 0;
  for (const markets of Object.values(depth.leagues || {}))
    for (const c of Object.values(markets)) { seen = Math.max(seen, c.seen); cells++; }
  return { ver: depth.ver || DEPTH_VERSION, leagues: Object.keys(depth.leagues || {}).length,
           cells, maxSeen: seen, absent: table,
           absentCount: Object.values(table).reduce((a, v) => a + v.length, 0) };
}
