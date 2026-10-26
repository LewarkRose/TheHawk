// HAWK grades itself on every match. Runs in the GitHub Action after
// build_data.py, with this run's site served on 127.0.0.1:8000:
//
//   1. Grades the predictions it saved for matches that have finished: each
//      leg won or lost, using the same code as the Vault (builder/hawk-settle.js).
//   2. Saves HAWK's pre-match chances for every match kicking off in the next
//      6 hours — the same legs the builder offers, from the same engine
//      (builder/engine.js), before any learning adjustment.
//   3. Writes data/graded.json (totals: how often HAWK's chances came true, by
//      market and by chance band) for the builder's learning and the Vault's
//      Track Record, and data/grading/state.json (the predictions still to
//      grade + the totals), which the Action keeps between runs.
//
// Run locally: python -m http.server 8000 --bind 127.0.0.1 (repo root), then
// node engine/grade.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as FotMob from "./fotmob.mjs";
import { closingChanceFor } from "./grade-demargin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = process.env.HAWK_LOCAL || "http://127.0.0.1:8000";
const LIVE = process.env.HAWK_LIVE || "https://lewarkrose.github.io/TheHawk";
// How far ahead a prediction is saved. This has to be longer than the longest gap
// between runs, because a match that kicks off inside a gap is never predicted at
// all: no HAWK probability on the Scores page, and nothing to grade afterwards —
// the record simply skips it, which is worse, because it is invisible.
// 6 hours assumed the 3-hourly cron actually ran 3-hourly. It did for two days and
// then GitHub started dropping scheduled runs: measured gaps of 5.6, 4.4, 7.3 and
// 7.1 hours on 3-4 Oct 2026. 14 covers those with room, and costs nothing in
// accuracy — every run overwrites the pending prediction, so the numbers that get
// graded are still the ones from the last run before kick-off. It only means more
// matches analysed per run.
const PREDICT_AHEAD_H = 14, GRADE_AFTER_H = 2.5, GIVE_UP_AFTER_D = 4, KEEP_RECENT = 40;
const BANDS = [[0, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 0.8], [0.8, 0.9], [0.9, 1.01]];
const STATE_FILE = path.join(ROOT, "data", "grading", "state.json");

// The browser engine and the settle module, run as they are.
globalThis.window = globalThis;
globalThis.document = { baseURI: `${LOCAL}/builder/` };
for (const f of ["builder/engine.js", "builder/hawk-settle.js"])
  vm.runInThisContext(await readFile(path.join(ROOT, f), "utf8"), { filename: f });
const { HAWK, HawkSettle } = globalThis;
HAWK.setLearning({});   // grade HAWK's own chances, not adjusted ones

// ---------- 🎟 THE TICKETS HAWK OFFERS, RECORDED FOR GRADING LATER ----------
// Every block on this board grades LEGS. Nothing grades a TICKET — which is the
// only number anyone actually bets. A builder's chance is the JOINT chance of its
// legs, which the engine reaches through the simulation rather than by multiplying
// them; `evaluate` reports the difference as `agree`, the joint chance over the
// legs multiplied as if independent. Whether that factor is right has never been
// measured, and the leg blocks cannot measure it: HAWK can be perfect on every
// single leg and still be wrong about how often they land together.
//
// The tickets are captured here because this is the one place the simulation is
// still in memory. A build costs 3-11ms against the 1,319ms the match itself cost,
// so eight of them are free. Grading needs nothing new either: part 1 already
// settles every leg, and a ticket is won when all of its legs are.
//
// RECORDING ONLY. Nothing reads these yet — that is deliberate, so a run can be
// watched before anything depends on it.
// Both focuses, deliberately. Measured on one match: every "Mix" ticket contains a
// player leg, so every one of them carries an ESTIMATED Bet365 price (guessed: 1)
// and dies ungradeable if that player doesn't start. "Match" tickets have no player
// legs at all, a real price on every leg, and still span the same `agree` range
// (0.973-1.272 against Mix's 0.973-1.529). Recording only Mix would have built a
// record that silently skipped thin-lineup matches and could never separate a
// correlation error from a prop-price estimate.
const BUILDER_TARGETS = [2.0, 3.0, 4.5, 7.0], BUILDER_LEGS = [3, 5];
const BUILDER_FOCUS = ["Mix", "Match"], BUILDER_MAX = 12;
function sampleBuilders(id) {
  const out = [], seen = new Set();
  for (const focus of BUILDER_FOCUS) {
    for (const maxLegs of BUILDER_LEGS) {
      for (const target of BUILDER_TARGETS) {
        let t = null;
        // One bad build must not cost the others, nor the prediction itself.
        try { t = HAWK.build({ id: String(id), target, style: "Balanced", maxLegs, focus, picks: "likely" }); }
        catch { continue; }
        if (!t || !(t.p > 0) || !Array.isArray(t.legs) || t.legs.length < 2) continue;
        const ids = t.legs.map((l) => l.id).sort();
        const key = ids.join("|");
        if (seen.has(key)) continue;   // different targets often land on the same ticket
        seen.add(key);
        out.push({ ids, n: ids.length, target, focus, p: +t.p.toFixed(4),
                   agree: t.agree != null ? +t.agree.toFixed(3) : null,
                   b365: t.b365 > 1 ? +t.b365.toFixed(2) : null,
                   check: t.check != null ? +t.check.toFixed(3) : null,
                   guessed: t.guessed || 0 });
        if (out.length >= BUILDER_MAX) return out;
      }
    }
  }
  return out;
}
const newBands = () => BANDS.map(([lo, hi]) => ({ lo, hi, n: 0, p: 0, won: 0 }));
const newTotals = () => ({ matches: 0, legs: 0, byMarket: {}, byKey: {}, byLeague: {}, keyBands: {},
                           recent: [], bands: newBands(), clv: {}, builders: newBuilders() });

// ---------- PHASE 1b: GRADING THE TICKET, NOT THE LEG ----------
// Every other block here grades LEGS. Nothing grades a TICKET, which is the only
// thing anyone actually bets. HAWK can be perfect on every leg and still wrong
// about how often they land together — and `agree`, the factor that turns several
// leg chances into one ticket chance, has never been measured at all.
//
// It matters right now: over 229 of the user's own tickets, 76 won against 59.8
// expected (z +2.5), which is what a too-harsh `agree` would look like. But those
// tickets cluster by match and cannot settle it. This does, from every match HAWK
// rates, bet or not.
//
// MUST be graded in the same pass that settles the legs: grade.mjs deletes
// state.pending[id] the moment a match is graded, and the recorded tickets go with
// it. There is no history to come back for.
//
// `byAgree` is the block that settles the question. `byWorth` answers a different
// one — whether the builder's "worth it" check is too harsh — by putting p x b365
// against what the ticket really returned.
// Bump when the tickets HAWK OFFERS change; resets this block alone.
//   2 — 2026-10-23. autoBuild's leg score now carries a form penalty: a player leg
//       HAWK rates well above the man's own last 6+ games is demoted (×0.85, or
//       ×0.7 past 35 points). The 894 tickets recorded under v1 were chosen by a
//       scorer that could not see form at all, so they describe a builder that no
//       longer exists — and byAgree/byLegs read off them would be measuring it.
const BUILDER_VERSION = 2;
const TICKET_BANDS = [[0, .1], [.1, .2], [.2, .3], [.3, .4], [.4, 1.01]];
const AGREE_BANDS = [[0, 1.05], [1.05, 1.15], [1.15, 1.35], [1.35, 99]];
const newCell = () => ({ n: 0, p: 0, won: 0, stake: 0, back: 0 });
/* `vault` is the SAME tickets settled the way the Vault settles: Early Payout
   and Sub On Play On both on. Without it this record was graded under stricter
   rules than the bets it is the control for — the Vault settles with
   {earlyPayout, subOn} (assets/hawk-alerts.js) — so every comparison between
   HAWK's own builders and Lewzu's was biased in the same direction as the
   selection edge it is supposed to test. Measured 2026-10-26: his tickets came
   in +7.6 points over HAWK's chance at 3+ legs while HAWK's own came in at
   −0.2, and the rules asymmetry was the last thing that could explain it.

   Kept BESIDE the raw figures, not instead of them. Raw is what the model
   said; this is what Bet365 would have paid out on. byKey is untouched and
   stays raw on purpose — see the note at DOES THE LEARNING HELP.

   BUILDER_VERSION is deliberately NOT bumped: the 1,878 tickets already in the
   record are the control, and throwing them away to add a column would cost
   more than the column is worth. So `vault` starts counting later than `n`,
   and it carries its OWN `p` for exactly that reason — compare vault.won
   against vault.p, never against the record's `p`, or you are reading a win
   count from one window against a chance total from a longer one. That is the
   mistake byLeague already made once. */
const newBuilders = () => ({
  ver: BUILDER_VERSION, n: 0, won: 0, p: 0, matches: 0, skipped: 0, clamped: 0,
  vault: { n: 0, won: 0, p: 0, byLegs: {} },
  byLegs: {}, byOpen: {}, byFocus: {},
  byChance: TICKET_BANDS.map(([lo, hi]) => ({ lo, hi, ...newCell() })),
  byAgree: AGREE_BANDS.map(([lo, hi]) => ({ lo, hi, ...newCell() })),
  byWorth: {},
});
// Staked flat at 1 unit so `back` is directly comparable across bands: a band's
// return per unit is back/stake, and 1.00 means it broke even at Bet365's price.
const tickTally = (c, p, won, b365) => {
  if (!c) return;
  c.n++; c.p = +(c.p + p).toFixed(4); if (won) c.won++;
  if (b365 > 1) { c.stake++; if (won) c.back = +(c.back + b365).toFixed(3); }
};

// ---------- HAWK AGAINST THE CLOSING LINE ----------
// Every other block here asks whether HAWK's chances are honest. This one asks the
// only question that decides whether they are worth money: on the same leg, is HAWK
// a better forecaster than Bet365's own closing price?
//
// Being well calibrated does not pay. HAWK is already within a point almost
// everywhere and the bets still run at about -12% expected, because the price moves
// with the model. Beating the CLOSE is the thing that doesn't — the closing line is
// the best forecast anyone has of a match, so beating it consistently is an edge,
// and it shows up in a few hundred legs instead of the thousands of BETS an ROI
// needs. See Match Shots on Target: +2 points over 7,000 legs and holding, which is
// either a real edge or a market that already knows. This is what tells them apart.
//
// Brier score, lower is better: mean (chance - outcome)^2. Scored for HAWK and for
// the market on exactly the same legs, so the pair is comparable even though the
// mix of legs changes over time.
//
// The closing price is DE-MARGINED first. A raw 1/price is inflated by the
// bookmaker's cut, which would hand HAWK a win it hasn't earned — so every option
// at that line is read, the implied chances are summed, and each is divided by the
// total. Legs where only one side closed are counted separately and left out of the
// comparison rather than scored with the margin still in.
// The de-margining itself lives in grade-demargin.mjs, so engine/smoke.mjs can test
// the very code this runs rather than a copy of it. See that file for why Double
// Chance needed its own treatment and what it cost while it didn't have one.
function closingChance(leg, f) {
  const b = HawkSettle.bookLine(leg.id);
  if (!b || !f.closing) return null;
  const opts = f.closing[`${b[0]}|${b[1]}`];
  if (!opts) return null;
  const q = closingChanceFor(b[0], opts, b[2]);
  if (q == null) return null;
  return { q, demargined: Object.values(opts).filter((v) => v > 1).length >= 2 };
}
// Upset radar record, per level (Low … Very high): how often the favourite
// really failed to win / the underdog won, against what the radar said.
const newUpsets = () => ["Low", "Medium", "High", "Very high"].map((label, level) =>
  ({ level, label, n: 0, saidFail: 0, failed: 0, saidDog: 0, dogWon: 0 }));
// The same record, but split by the WEIGHT OF THE SIGNALS rather than the level.
// The level can't answer the question that matters, because it's built partly out
// of HAWK's own probability — `score = net + (probs[dog] - 0.2) * 5` — so a level
// bucket agreeing with the result mostly says the probabilities are calibrated,
// which we already know. The open question is whether the signals the model never
// sees (rotation, missing regulars, money moving, Polymarket, rest) carry anything
// BEYOND the probability. That shows up as a residual: inside a band, compare what
// HAWK said to what happened. If strong upset signals mean the favourite fails more
// often than HAWK's own number said, the signals are worth feeding into the model.
// If every band sits on zero, the radar really is only a display and this can rest.
const NET_BANDS = [[-99, -0.5, "Points to the favourite"], [-0.5, 0.5, "Nothing either way"],
                   [0.5, 1.5, "Some upset signals"], [1.5, 99, "Strong upset signals"]];
const newUpsetNet = () => NET_BANDS.map(([lo, hi, label]) => ({ lo, hi, label, n: 0, saidFail: 0, failed: 0 }));
// How many corners / cards / shots on target / tackles HAWK EXPECTED against how many
// there were. The leg board can only ever say a market is off by so many points of
// probability, which is a symptom: it cannot tell a wrong average from a wrong spread,
// and it cannot be turned back into "expect 4% fewer corners". Worse, the inputs behind
// an expectation do not survive the match — the bookmakers' corner lines, which the
// total is 70% built from, are deleted at full time, and a finished fixture drops out
// of fixtures.json, so no amount of digging afterwards can reconstruct what HAWK said.
// Recording the expectation up front is the only way these become measurable, and it
// is kept per league because a constant tuned on one competition has twice now failed
// to hold in another.
// Tackles are the reason this exists. StatsHub's `totalTackle` is challenges MADE —
// the same thing the lines settle on, confirmed against 365Scores over 405
// player-matches — yet TACKLE_SCALE multiplies it by 1.4 on the stated grounds that it
// counts tackles won. Three attempts to measure the right figure gave 1.0, 1.22 and
// 1.56 depending on the sample, so the constant stays where it is until the record
// here says what it should be, measured on the legs actually being graded. Rates are
// applied to the minutes each player REALLY played, so this tests the rate alone and
// never HAWK's guess at who would start.
const newStat = () => ({ n: 0, exp: 0, act: 0 });
const fitStat = (league, stat, exp, act) => {
  if (!(exp > 0) || !(act >= 0)) return;
  for (const key of [league, "ALL"]) {
    const b = ((T.statFit ||= {})[key] ||= {});
    const s = (b[stat] ||= newStat());
    s.n++; s.exp = +(s.exp + exp).toFixed(3); s.act = +(s.act + act).toFixed(3);
  }
};
// 365Scores writes a tackle count as "2/3 (66.7%)": won out of made. The lines settle
// on made, so that is the denominator — the same reading hawk-settle.js uses.
const tacklesMade = (v) => { const m = /^(\d+)\s*\/\s*(\d+)/.exec(String(v ?? "")); return m ? +m[2] : null; };
// ---------- DOES THE LEARNING HELP? ----------
// The app corrects a market's chances by what the graded record says (see
// computeLearning in builder/index.html, which merges graded.json's byKey into a
// log-odds shift). The record itself is graded RAW, deliberately, so byKey measures
// the model and not model-plus-correction. The consequence nobody had noticed: the
// corrections have been applied live for weeks and NOTHING has ever measured whether
// they help. A market reading +2.4 on the board may be perfectly corrected in the
// app, or over-corrected, and the board cannot tell you which.
//
// So grade every leg twice. Once at its raw chance, once at the chance the live app
// would have shown — using the shift computed from the record AS IT STOOD BEFORE
// this match, which is what was live at the time. Brier score decides: lower is
// better, and the difference between the two is the value of the learning.
//
// Not identical to the app: computeLearning also folds in Lewzu's own settled bets,
// which this cannot see. So this measures the graded half of the correction, which
// is the overwhelming majority of it (314,131 legs of 314,131 on 2026-10-22).
const AB_VERSION = 1;
const LEARN_MIN = 30, LEARN_SHRINK = 60, LEARN_CAP = 0.6;
const lgit = (p) => Math.log(p / (1 - p));
const ilgit = (x) => 1 / (1 + Math.exp(-x));
const newAB = () => ({ ver: AB_VERSION, n: 0, shifted: 0, rawBrier: 0, adjBrier: 0, byKey: {} });
// The same formula computeLearning uses, read off the record in hand.
function learnShifts() {
  const out = {};
  for (const [key, g] of Object.entries(T.byKey || {})) {
    if (!g.n || g.n < LEARN_MIN) continue;
    const said = g.p / g.n;
    if (!(said > 0 && said < 1)) continue;
    const got = Math.min(Math.max(g.won / g.n, 0.02), 0.98);
    const s = Math.max(-LEARN_CAP, Math.min(LEARN_CAP, (g.n / (g.n + LEARN_SHRINK)) * (lgit(got) - lgit(said))));
    if (Math.abs(s) >= 0.02) out[key] = s;
  }
  return out;
}
function abTally(shifts, leg, w) {
  const p = leg.p;
  if (!(p > 0 && p < 1)) return;
  const A = (T.ab ||= newAB());
  if ((A.ver || 1) !== AB_VERSION) Object.assign(A, newAB());
  const key = (HAWK.learnKey && HAWK.learnKey(leg.id, leg.market)) || leg.market;
  const sh = shifts[(HAWK.learnKey && HAWK.learnKey(leg.id, leg.market)) || ""];
  const q = sh ? ilgit(lgit(p) + sh) : p;
  const o = w ? 1 : 0;
  A.n++; if (sh) A.shifted++;
  A.rawBrier = +(A.rawBrier + (p - o) ** 2).toFixed(4);
  A.adjBrier = +(A.adjBrier + (q - o) ** 2).toFixed(4);
  const c = (A.byKey[key] ||= { n: 0, raw: 0, adj: 0, said: 0, adjSaid: 0, won: 0 });
  c.n++; if (w) c.won++;
  c.raw = +(c.raw + (p - o) ** 2).toFixed(4);
  c.adj = +(c.adj + (q - o) ** 2).toFixed(4);
  c.said = +(c.said + p).toFixed(4);
  c.adjSaid = +(c.adjSaid + q).toFixed(4);
}

// ---------- THE SECOND SOURCE ----------
// Every player leg HAWK settles rests on one feed. FotMob is read alongside it and
// RECORDED — never applied. See engine/fotmob.mjs for why it cannot reach the app,
// and for the day's measurement that says the two agree.
//
// Recorded rather than used on purpose. Folding FotMob into settlement would start
// grading the tackles legs 365Scores is silent on, and those are not a random
// sample — they are the players who made a tackle without winning one, so the
// low-count end. Adding them shifts Player Tackles' byKey record, which the builder
// applies as a correction. Measure what it would do first, then decide.
// 2 — 2026-10-23. `said` was added a run after the counters it had to be divided
// BY, so it accumulated over a handful of legs while `settleable` carried every leg
// since the block began. The ratio read 0.7% per leg, which is impossible —
// MIN_LEG_P is 0.04, so nothing HAWK prices can sit under 4% — and `saidWon` came
// out null, which is NaN from `undefined + number`. Both are the same mistake: a
// numerator and a denominator that do not count the same thing. The block restarts
// so every field begins together, and each sum now carries its own count.
//   3 — 2026-10-24. Added `graded`: the tackles legs that DID settle, over the same
//       matches as the discarded ones. v2 could only set 616 discarded legs against
//       Player Tackles' all-time byKey, which spans every match ever graded — the
//       same mismatched-denominator trap, a third time. Reset so both halves start
//       together and the pair is finally comparable.
//   4 — 2026-10-24, same day, because v3 answered the question and the answer was
//       not believable. Over 54 matches it read: discarded legs said 56.7% and
//       landed 14.3%, against graded legs saying 62.2% and landing 54.6%. A
//       42-point miss on one half and 8 on the other cannot both describe the same
//       market. It was not a units mismatch — where both feeds name a player's
//       tackles they agree on 570 of 579 — it was WHO was being counted. A leg
//       became `settleable` the moment the second source had any tackles number,
//       zero included, and zero was then scored as a LOSS. But 678 of 860
//       second-source-only readings were zero, and the two feeds disagreed about
//       minutes for 733 of 1,439 players, so most of those zeros are players who
//       never came on. At Bet365 an absent player VOIDS the leg; it does not lose
//       it. So v3 was measuring absences and calling them bad prices. v4 requires
//       real minutes from the second source before a leg counts, and records the
//       exclusions in `noMinutes` so the explanation can be checked rather than
//       assumed: if that counter lands near the settleable one, this was the cause.
const SOURCE_VERSION = 4;
const SRC_FIELDS = ["shots", "sot", "tackles", "fouled", "fouls", "offsides", "saves", "minutes"];
const newSources = () => ({
  ver: SOURCE_VERSION, matches: 0, resolved: 0, ambiguous: 0, players: 0, unmatched: 0,
  // per field: compared both ways, how often they differ, total absolute gap, and
  // how often one side has a number the other simply does not publish.
  fields: Object.fromEntries(SRC_FIELDS.map((k) => [k, { n: 0, differ: 0, gap: 0, only365: 0, onlyFM: 0, silentNonZero: 0 }])),
  // Tackles legs HAWK could not grade, and what FotMob would have done with them.
  //
  // `said` is the number that decides whether this matters. The first live run found
  // 228 settleable legs of which only 30 would have won — a 13% strike against the
  // 57.7% Player Tackles shows on the board. If HAWK's chance on those legs was also
  // low, they are cheap legs it priced correctly and nothing is wrong. If it was
  // high, then the biggest market on the board is being flattered by quietly
  // dropping its losers, and that is a calibration problem hiding inside a coverage
  // one. Counting them without their chances could not tell the two apart.
  // saidN is the count `said` is averaged over, and it is NOT settleable: a leg
  // only joins `said` if it carried a usable chance. Divide by the wrong one and
  // the answer is off by whatever fraction of legs that is.
  // `graded` is the missing half. Without it the discarded legs can only be set
  // against Player Tackles' all-time byKey, which spans every match ever graded
  // while these come from the handful since the block reset — mismatched
  // denominators for the third time in two days. Counted over the SAME matches,
  // the two are finally comparable and the board's real gap can be stated.
  // `noMinutes` is the v4 addition and the one to read first: legs the second
  // source could put a number against but whose player it shows no minutes for.
  // Those are voids at the book, not losses, and counting them as losses is what
  // made v3 read 14% against a 57% price.
  rescue: { ungraded: 0, settleable: 0, noMinutes: 0, wouldWin: 0, said: 0, saidN: 0, wonOfSaidN: 0,
            graded: 0, gradedWon: 0, gradedSaid: 0 },
});
// 365Scores' own names for the same numbers, and how to read each one. A tackle is
// written "2/3 (66.7%)" — won out of MADE — and the lines settle on made, so the
// denominator is the only number worth comparing. Reading the numerator makes FotMob
// look uniformly higher; that is a bug in the reader, not a disagreement.
const S365_FIELD = {
  shots: "Total Shots", sot: "Shots On Target", tackles: "Tackles Won", fouled: "Was Fouled",
  fouls: "Fouls Made", offsides: "Offsides", saves: "Goalkeeper Saves", minutes: "Minutes",
};
const readS365 = (key, raw) => {
  if (raw == null || raw === "") return null;
  if (key === "tackles") return tacklesMade(raw);
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(String(raw));
  return m ? +m[1] : null;
};
async function crossCheck(pr, f, unknownTackles) {
  const S = (T.sources ||= newSources());
  if ((S.ver || 1) !== SOURCE_VERSION) Object.assign(S, newSources());
  S.matches++;
  let hit = null, fm = null;
  try {
    hit = await FotMob.findMatch(pr.kickoff, pr.home, pr.away);
    if (hit) fm = await FotMob.playerStats(hit.id);
  } catch { /* a FotMob outage must never stop a match grading */ }
  if (!fm) { if (!hit) S.ambiguous++; return; }
  S.resolved++;
  for (const side of ["home", "away"]) {
    const index = FotMob.byLastName(fm[side]);
    for (const p of (f.players || {})[side] || []) {
      if (!(p.minutes > 0)) continue;
      const q = index.get(FotMob.lastName(p.name));
      if (!q) { S.unmatched++; continue; }
      S.players++;
      for (const key of SRC_FIELDS) {
        const a = readS365(key, (p.stats || {})[S365_FIELD[key]]);
        const b = q.stats[key];
        const c = S.fields[key];
        if (a == null && b == null) continue;
        if (a == null) { c.onlyFM++; if (b > 0) c.silentNonZero++; continue; }
        if (b == null) { c.only365++; continue; }
        c.n++;
        if (Math.abs(a - b) > 1e-9) { c.differ++; c.gap = +(c.gap + Math.abs(a - b)).toFixed(3); }
      }
    }
    // What the second source would have rescued. A leg HAWK left ungraded because
    // 365Scores never named the player's tackles is one FotMob usually can settle.
    for (const leg of unknownTackles) {
      if (leg.side !== side) continue;
      S.rescue.ungraded++;
      const q = index.get(FotMob.lastName(leg.player));
      if (!q || q.stats.tackles == null) continue;
      // Minutes first, and counted separately. A player who never came on reads as
      // zero tackles here, and "0 >= need" is false, so without this the leg scored
      // as a loss when the book would have voided it. See SOURCE_VERSION 4 above.
      if (!(q.stats.minutes > 0)) { S.rescue.noMinutes++; continue; }
      S.rescue.settleable++;
      const won = q.stats.tackles >= leg.need;
      if (won) S.rescue.wouldWin++;
      // `|| 0` on every read so a field added later can never turn the running
      // total into NaN, which is how saidWon came out null the first time.
      if (leg.p > 0 && leg.p < 1) {
        S.rescue.said = +((S.rescue.said || 0) + leg.p).toFixed(3);
        S.rescue.saidN = (S.rescue.saidN || 0) + 1;
        if (won) S.rescue.wonOfSaidN = (S.rescue.wonOfSaidN || 0) + 1;
      }
    }
  }
}
const pairSum = (p) => (Array.isArray(p) && p[0] != null && p[1] != null ? p[0] + p[1] : null);
const r3 = (v) => (typeof v === "number" && Number.isFinite(v) ? +v.toFixed(3) : null);
// Every league-and-market cell is kept in state.json so it keeps accumulating, but a
// cell with four legs in it is noise that would treble the size of the file the
// builder downloads on every visit. Only cells with enough legs to be worth reading
// are published; the rest carry on filling up out of sight.
// HAWK's own headline call — home, draw or away — graded as three separate things.
//
// It looks like this is already covered, because byMarket has a "Full Time Result"
// line reading 33.6% said against 33.6% landed over 1,707 legs. That number is
// arithmetic, not calibration: every match contributes three legs that sum to 100%
// and exactly one of them wins, so "landed" is pinned at a third no matter what the
// model does. A draw bias of any size is invisible there, cancelled exactly by the
// opposite error on home and away. byKey has no result entry at all. So HAWK grades
// 183,000 legs and has never once checked the prediction on the front of the page.
//
// Worth checking because there is a hint of something. Over a rolling window of 101
// finished matches, draws landed 32.7% against 24.4% claimed, and split by how high
// HAWK rated the draw the gap only appears at the top:
//   under 25% rated — calibrated.  25-28% — +14.0.  28-32% — +13.2.  32%+ — +16.8.
// Three bands in a row, same direction, growing. But the 40-match slice of that
// window on its own says +3.2 at z=+0.47, so one sample is doing all the work.
// Hence: record it, per outcome and banded, and decide when there is enough.
const newResult = () => ({ home: { n: 0, p: 0, hit: 0 }, draw: { n: 0, p: 0, hit: 0 }, away: { n: 0, p: 0, hit: 0 } });
const DRAW_BANDS = [[0, 0.20], [0.20, 0.25], [0.25, 0.28], [0.28, 0.32], [0.32, 1.01]];
const newDrawBands = () => DRAW_BANDS.map(([lo, hi]) => ({ lo, hi, n: 0, p: 0, drew: 0 }));
const tallyResult = (probs, ft) => {
  if (!probs || !Array.isArray(ft) || ft[0] == null || ft[1] == null) return;
  const actual = ft[0] > ft[1] ? "home" : ft[0] === ft[1] ? "draw" : "away";
  // All three checked before any of them is counted. Validating inside the loop
  // banked home and draw and then bailed on a missing away, leaving the three
  // totals on different denominators — which is exactly the kind of quiet skew
  // this tally exists to detect.
  const sides = ["home", "draw", "away"];
  if (!sides.every((k) => probs[k] >= 0 && probs[k] <= 1)) return;
  const R = (T.result ||= newResult());
  for (const k of sides) {
    R[k].n++; R[k].p = +(R[k].p + probs[k]).toFixed(4); if (actual === k) R[k].hit++;
  }
  // Banded on the draw's own chance: the pattern above is a slope, not a shift, so
  // one overall figure would average it away.
  const b = (T.drawBands ||= newDrawBands()).find((x) => probs.draw >= x.lo && probs.draw < x.hi);
  if (b) { b.n++; b.p = +(b.p + probs.draw).toFixed(4); if (actual === "draw") b.drew++; }
};
// A line needs enough legs to be read against its neighbours — the whole point is the
// shape across six of them, and one noisy rung makes a flat curve look alternating.
const PUBLISH_LINE_MIN = 40;
const publishedLines = () =>
  Object.fromEntries(Object.entries(T.byLine || {}).filter(([, v]) => v.n >= PUBLISH_LINE_MIN));
const PUBLISH_LEAGUE_KEY_MIN = 10;
const publishedLeagueKeys = () => {
  const out = {};
  for (const [league, keys] of Object.entries(T.byLeagueKey || {})) {
    const kept = Object.fromEntries(Object.entries(keys).filter(([, v]) => v.n >= PUBLISH_LEAGUE_KEY_MIN));
    if (Object.keys(kept).length) out[league] = kept;
  }
  return out;
};
const tally = (b, p, won) => { b.n++; b.p = +(b.p + p).toFixed(4); if (won) b.won++; };

// Last run's state: kept by the Action's cache; if that's missing, the copy on
// the published site; if neither exists, this is the first run.
async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { /* not cached */ }
  try {
    const r = await fetch(`${LIVE}/data/grading/state.json?t=${Date.now()}`);
    if (r.ok) return await r.json();
  } catch { /* site unreachable */ }
  return { pending: {}, totals: newTotals() };
}

// The Monday (UTC date) of the week a kick-off falls in: "2026-09-14".
const mondayKey = (iso) => {
  const d = new Date(iso), back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
};

const state = await loadState();
const T = state.totals;
T.upsets ||= newUpsets();
T.upsetNet ||= newUpsetNet();
// A one-off head start. state.done keeps the last four days of {probs, ft} for the
// Scores page, which is the same pairing this tally wants, so the first run seeds
// itself from matches already graded instead of starting empty. Guarded by a flag
// because running it twice would count them twice, and the whole point of the
// exercise is a number that can be trusted.
// The closing-line record is only true of the way the close was READ. Double Chance
// was de-margined against a sum of 2 as if it were a sum of 1 (see OVERLAP), so every
// DC leg already in the record is wrong and would sit under the corrected ones for as
// long again. Bump this whenever closingChance changes and the block starts over.
const CLV_VERSION = 2;
if ((state.clvVer || 1) !== CLV_VERSION) {
  const had = Object.values(T.clv || {}).reduce((a, c) => a + (c.n || 0), 0);
  T.clv = {};
  state.clvVer = CLV_VERSION;
  console.log(`[grade] clv: v${CLV_VERSION} — closing-line record starting over (discarded ${had} leg(s) read the old way)`);
}
if (!state.resultSeeded) {
  let seeded = 0;
  for (const d of Object.values(state.done || {})) { tallyResult(d.probs, d.ft); seeded++; }
  state.resultSeeded = true;
  console.log(`[grade] result tally seeded from ${seeded} already-graded match(es)`);
}
const now = Date.now();
let graded = 0, predicted = 0, builtTickets = 0;

// 1. Grade finished matches.
for (const [id, pr] of Object.entries(state.pending)) {
  const ko = Date.parse(pr.kickoff);
  if (now < ko + GRADE_AFTER_H * 3600e3) continue;
  let f = null;
  try { f = await HawkSettle.fetchMatchFacts(id); } catch { /* try again next run */ }
  if (!f || !f.finished) { if (now > ko + GIVE_UP_AFTER_D * 86400e3) delete state.pending[id]; continue; }
  delete state.pending[id];
  if (f.off) continue;   // postponed / abandoned
  // Kept a few days for the Scores page: HAWK's prediction next to the result.
  if (pr.probs && f.ft) (state.done ||= {})[id] = { probs: pr.probs, level: pr.upset ? pr.upset.level : null, kickoff: pr.kickoff, ft: f.ft };
  tallyResult(pr.probs, f.ft);
  // The upset radar's call against the result.
  let upset = null;
  if (pr.upset && f.ft) {
    const [H, A] = f.ft, fg = pr.upset.fav === "home" ? H : A, dg = pr.upset.fav === "home" ? A : H;
    upset = { level: pr.upset.level, fav: pr.upset.fav, favFail: pr.upset.favFail, dogWin: pr.upset.dogWin, failed: fg <= dg, dogWon: dg > fg };
    const b = T.upsets[upset.level];
    if (b) {
      b.n++; b.saidFail = +(b.saidFail + upset.favFail).toFixed(4); b.saidDog = +(b.saidDog + upset.dogWin).toFixed(4);
      if (upset.failed) b.failed++;
      if (upset.dogWon) b.dogWon++;
    }
    // Predictions saved before the signal weight was recorded have no `net`. They
    // are left out rather than counted as "nothing either way", which would put
    // matches that had loud signals into the quiet band and flatten the very
    // residual this is here to measure.
    if (typeof pr.upset.net === "number") {
      const nb = T.upsetNet.find((x) => pr.upset.net >= x.lo && pr.upset.net < x.hi);
      if (nb) { nb.n++; nb.saidFail = +(nb.saidFail + upset.favFail).toFixed(4); if (upset.failed) nb.failed++; }
    }
  }
  // Expectation against outcome, for the match totals and for tackles.
  if (pr.expected) {
    fitStat(pr.league, "corners", pr.expected.corners, pairSum(f.corners));
    fitStat(pr.league, "cards", pr.expected.cards, pairSum(f.cards));
    fitStat(pr.league, "sot", pr.expected.sot, pairSum(f.sot));
  }
  for (const side of ["home", "away"]) {
    const rates = (pr.tackleRates || {})[side] || [];
    if (!rates.length) continue;
    const byName = new Map(rates.map((r) => [r.name, r.rate]));
    let exp = 0, act = 0;
    for (const p of (f.players || {})[side] || []) {
      const made = tacklesMade(p.stats && p.stats["Tackles Won"]);
      const rate = byName.get(p.name);
      // A player with no minutes tells us nothing, and a missing stat is not a zero.
      if (made == null || rate == null || !(p.minutes > 0)) continue;
      exp += rate * (p.minutes / 90); act += made;
    }
    if (exp > 0) fitStat(pr.league, "tackles", exp, act);
  }
  let n = 0, won = 0, said = 0;
  // id -> outcome, so a builder ticket can be resolved from the same settlements
  // rather than re-settling its legs. A leg that returned "unknown" is simply
  // absent, which is what makes a ticket containing it countable as skipped.
  // legOut is RAW — the model's own call. legOutEP is the same legs settled the
  // way the Vault settles them, so the builder record can be compared with real
  // bets on equal terms. See newBuilders().
  const legOut = new Map(), legP = new Map(), legOutEP = new Map();
  // Tackles legs that could not be graded because 365Scores never named the
  // player's tackles. Collected here so the second source can be asked what it
  // would have done with them — see crossCheck.
  const unknownTackles = [];
  // Taken BEFORE this match's legs are added to byKey, so the shift is the one the
  // app would have been using when these legs were offered, not one that has already
  // seen their outcome.
  const shiftsNow = learnShifts();
  for (const leg of pr.legs) {
    const r = HawkSettle.legResult(leg, f);
    if (r !== "won" && r !== "lost") {
      const t = /^p:(home|away):\d+:tackles(\d*)$/.exec(leg.id || "");
      if (t && r === "unknown") {
        unknownTackles.push({ side: t[1], need: +t[2] || 1, p: leg.p,
          player: leg.player || String(leg.label || "").split(/:| to /)[0] });
      }
    }
    if (r !== "won" && r !== "lost") continue;   // didn't play, or no data
    const w = r === "won";
    legOut.set(leg.id, w); legP.set(leg.id, leg.p);
    // the same leg under Bet365's two settling rules
    const rv = HawkSettle.legResult(leg, f, { earlyPayout: true, subOn: true });
    legOutEP.set(leg.id, rv === "won" ? true : rv === "lost" ? false : w);
    abTally(shiftsNow, leg, w);
    // Tackles legs that DID grade, over the same matches as the discarded ones.
    if (/^p:(home|away):\d+:tackles\d*$/.test(leg.id || "") && leg.p > 0 && leg.p < 1) {
      const R = ((T.sources ||= newSources()).rescue);
      R.graded = (R.graded || 0) + 1;
      if (w) R.gradedWon = (R.gradedWon || 0) + 1;
      R.gradedSaid = +((R.gradedSaid || 0) + leg.p).toFixed(3);
    }
    n++; said += leg.p; if (w) won++;
    tally(T.byMarket[leg.market] ||= { n: 0, p: 0, won: 0 }, leg.p, w);
    // HAWK vs the closing line on this exact leg (see closingChance above).
    const cc = closingChance(leg, f);
    if (cc) {
      const c = (T.clv ||= {})[leg.market] ||= { n: 0, hawk: 0, market: 0, p: 0, q: 0, won: 0, oneSided: 0 };
      if (!cc.demargined) c.oneSided++;
      else {
        const o = w ? 1 : 0;
        c.n++; c.won += o; c.p += leg.p; c.q += cc.q;
        c.hawk += (leg.p - o) ** 2;
        c.market += (cc.q - o) ** 2;
      }
    }
    const key = HAWK.learnKey(leg.id, leg.market);
    if (key) {
      // A market whose model has been changed starts again: what was measured
      // was measured about a different model, and the board never forgets on its
      // own — it only adds, so a stale correction would outlive the bug it was
      // covering for by as many legs again.
      const ver = (HAWK.MODEL_VERSION || {})[key] || 1;
      const had = T.byKey[key];
      // Everything already on the board predates this and carries no version:
      // that IS version 1, not a mismatch, or the first run after this shipped
      // would throw away every market's record.
      if (!had) T.byKey[key] = { n: 0, p: 0, won: 0, ver };
      else if ((had.ver || 1) !== ver) {
        console.log(`[grade] ${key}: model v${ver} — starting its record over (was ${had.n} legs)`);
        T.byKey[key] = { n: 0, p: 0, won: 0, ver };
        if (T.keyBands) delete T.keyBands[key];
      }
      tally(T.byKey[key], leg.p, w);
      // The same split again, but per market: one figure per market says
      // whether HAWK is out, not how. A mean that is too high misses at every
      // line in one direction; tails that are too thin (OVERDISP) miss at both
      // ends and the other way in the middle. Only the curve tells them apart.
      const kb = (T.keyBands ||= {})[key] ||= newBands();
      const b = kb.find((x) => leg.p >= x.lo && leg.p < x.hi);
      if (b) tally(b, leg.p, w);
    }
    const band = T.bands.find((b) => leg.p >= b.lo && leg.p < b.hi);
    if (band) tally(band, leg.p, w);
    // By the LINE itself, which is the one cut that can say WHY a totals market is
    // off. The chance-band ladder cannot: a leg at 45% might be Over 2.5 for a weak
    // side or Over 6.5 for a strong one, and those two fail in opposite directions
    // when the variance is wrong. Against the line they separate cleanly.
    //
    //   mean too high      — every line misses the same way, a flat -2 or -3 across
    //                        2.5, 3.5, 4.5, 5.5, 6.5, 7.5
    //   variance too wide  — the miss ALTERNATES: low lines land more than said,
    //                        high lines fewer, crossing over around the middle
    //
    // Team Corners is -2.5 points over 6,452 legs with the match total calibrated at
    // 0.983, which says the split between the two sides is at fault, but not which
    // way. A 2,000,000-draw simulation of the engine's own corner path put the two
    // signatures at flat -2.1/-3.0 against an alternating +5.9/+3.2/0/-2.9/-4.0/-3.9
    // — nothing alike, and the aggregate throws away exactly the difference.
    // Match totals only. No player prop ends `:o<n>` or `:u<n>` today — they end in
    // the stat and its count, `:tackles1`, `:offsides2` — but one named `:u21` would
    // slip straight into a corner line's bucket, and a prop always carries `player`.
    const lineAt = leg.player ? null : /:([ou])(\d+(?:\.\d+)?)$/.exec(leg.id || "");
    if (lineAt) {
      const lk = `${leg.market} · ${lineAt[1] === "o" ? "Over" : "Under"} ${lineAt[2]}`;
      tally((T.byLine ||= {})[lk] ||= { n: 0, p: 0, won: 0 }, leg.p, w);
    }
    // Per league, so "is HAWK better in Serie A than in La Liga" can be answered
    // from every match rather than from the handful you happened to bet on.
    if (pr.league) tally((T.byLeague ||= {})[pr.league] ||= { n: 0, p: 0, won: 0, matches: 0 }, leg.p, w);
    // Per league AND market. The corrections the builder applies are keyed on the
    // market alone, which assumes a market behaves the same everywhere — and it
    // demonstrably doesn't: the tackle rate that fits Brazil is 1.22 and the one
    // that fits Spain is 1.56, so a single number fitted across both is wrong in
    // both. Friendlies have been over-confident for weeks (39.6% said, 37.4%
    // landed) and cannot correct themselves for exactly this reason.
    // Recording it is cheap. APPLYING it is not yet possible and must not be
    // switched on because this exists: a league-and-market cell needs its own
    // LEARN_MIN before it means anything, and most cells will sit near zero for
    // months (Serie A has one graded match today). This is here to accumulate so
    // the question can be settled later with numbers instead of a third guess.
    if (pr.league && key) {
      const lk = ((T.byLeagueKey ||= {})[pr.league] ||= {});
      tally(lk[key] ||= { n: 0, p: 0, won: 0 }, leg.p, w);
    }
  }
  if (!n) continue;

  // ---- 1b: grade the tickets HAWK would have offered for this match ----
  // A ticket wins when every leg wins. One ungradeable leg makes the whole ticket
  // ungradeable — counted as `skipped`, never silently dropped, or the record
  // quietly excludes exactly the thin-lineup matches where props fail to settle.
  if ((pr.builders || []).length) {
    const B = (T.builders ||= newBuilders());
    if ((B.ver || 1) !== BUILDER_VERSION) {
      console.log(`[grade] builders: v${BUILDER_VERSION} — starting the ticket record over (was ${B.n})`);
      Object.assign(B, newBuilders());
    }
    // What the ticket OPENED with. The builder seeds from the favourite's result
    // leg, else its double chance, else the underdog's double chance — and that
    // last rule is the one nobody can check without this split.
    const fav = (pr.probs && (pr.probs.home || 0) >= (pr.probs.away || 0)) ? "home" : "away";
    const dog = fav === "home" ? "away" : "home";
    const openOf = (ids) =>
      ids.includes(`res:${fav}`) ? "favourite to win"
      : ids.includes(`dc:${fav}`) ? "favourite double chance"
      : ids.includes(`dc:${dog}`) ? "underdog double chance"
      : ids.includes(`res:${dog}`) ? "underdog to win"
      : ids.includes("res:draw") ? "the draw"
      : "no result leg";
    let graded = 0;
    for (const t of pr.builders) {
      const ids = t.ids || [];
      if (!ids.length || !ids.every((i) => legOut.has(i))) { B.skipped++; continue; }
      const w = ids.every((i) => legOut.get(i));
      const p = +t.p || 0, b365 = +t.b365 || 0;
      graded++;
      B.n++; B.p = +(B.p + p).toFixed(4); if (w) B.won++;
      /* …and again under the Vault's rules, on the SAME tickets and the same
         skip rule, so the two tallies differ only in how a leg settles. */
      {
        const V = (B.vault ||= { n: 0, won: 0, p: 0, byLegs: {} });
        const wv = ids.every((i) => legOutEP.get(i));
        V.n++; V.p = +(V.p + p).toFixed(4); if (wv) V.won++;
        const cell = (V.byLegs[t.n || ids.length] ||= { n: 0, p: 0, won: 0 });
        cell.n++; cell.p = +(cell.p + p).toFixed(4); if (wv) cell.won++;
      }
      if (b365 > 1) { B.stake = (B.stake || 0) + 1; if (w) B.back = +((B.back || 0) + b365).toFixed(3); }
      // The clamp in evaluate() caps a ticket at its smallest leg's chance. Watching
      // how often it binds keeps it monitored rather than spot-checked.
      const smallest = Math.min(...ids.map((i) => legP.get(i)));
      if (p >= smallest - 1e-6) B.clamped++;
      tickTally(B.byLegs[t.n || ids.length] ||= newCell(), p, w, b365);
      tickTally(B.byOpen[openOf(ids)] ||= newCell(), p, w, b365);
      if (t.focus) tickTally(B.byFocus[t.focus] ||= newCell(), p, w, b365);
      tickTally(B.byChance.find((x) => p >= x.lo && p < x.hi), p, w, b365);
      if (t.agree != null) tickTally(B.byAgree.find((x) => t.agree >= x.lo && t.agree < x.hi), p, w, b365);
      // Was the "worth it" check right? p x b365 is what HAWK thought the ticket
      // was worth at the offered price; `back` is what it really returned.
      if (b365 > 1) {
        const edge = p * b365 - 1;
        const band = edge < -0.05 ? "HAWK said: poor value" : edge < 0.02 ? "HAWK said: about fair" : "HAWK said: worth it";
        tickTally(B.byWorth[band] ||= newCell(), p, w, b365);
      }
    }
    // Matches, not tickets. The ~10 tickets from one match open from the same result
    // leg and rise and fall together, so the honest sample size is this one.
    if (graded) B.matches++;
  }

  // Matches as well as legs: one match brings hundreds of legs and they share a
  // referee, two teams and one afternoon, so they are nowhere near independent.
  // A league needs MATCHES behind it before its number is worth reading.
  if (pr.league && T.byLeague && T.byLeague[pr.league]) T.byLeague[pr.league].matches++;
  T.matches++; T.legs += n; graded++;
  // Week by week (Monday to Sunday, by kick-off) for the Vault's weekly report.
  const W = ((T.weeks ||= {})[mondayKey(pr.kickoff)] ||= { matches: 0, legs: 0, said: 0, won: 0, bigCalls: 0, bigRight: 0 });
  W.matches++; W.legs += n; W.said = +(W.said + said).toFixed(3); W.won += won;
  if (upset && upset.level >= 2) { W.bigCalls++; if (upset.failed) W.bigRight++; }
  T.recent.unshift({ id, league: pr.league, home: pr.home, away: pr.away, kickoff: pr.kickoff, score: f.ft.join("-"),
                     n, said: +(said / n).toFixed(3), got: +(won / n).toFixed(3), upset });
  T.recent = T.recent.slice(0, KEEP_RECENT);
  // Last, and in its own try/catch: the second source is a reader, and nothing it
  // does may cost a match its grade. Only for matches with player legs — a match
  // with none has nothing to cross-check and the fetch would be wasted.
  if ((f.players || {}).home) {
    try { await crossCheck(pr, f, unknownTackles); }
    catch (e) { console.log(`[grade] cross-check skipped for ${id}: ${e.message}`); }
  }
}

// 2. Save HAWK's chances for matches kicking off soon (the latest run before
// kick-off wins, so lineups and prices are as fresh as possible).
for (const league of HAWK.LEAGUES) {
  let list = [];
  try { list = await HAWK.fixtures(league); } catch { continue; }
  for (const f of list) {
    const ko = Date.parse(f.kickoff);
    if (!(ko > now && ko - now <= PREDICT_AHEAD_H * 3600e3)) continue;
    try {
      const m = await HAWK.match(league, f.id, true);
      // Belt and braces: the leg record has worked for 909 matches and a bug in
      // something recording-only must not be able to touch it.
      let builders = [];
      try { builders = sampleBuilders(f.id); }
      catch (e) { console.warn(`[grade] builders skipped for ${f.home} v ${f.away}: ${e.message}`); }
      builtTickets += builders.length;
      state.pending[String(f.id)] = {
        league, home: f.home, away: f.away, kickoff: f.kickoff, at: new Date().toISOString(),
        // The derby flag HAWK priced this match with. Recorded so the card total
        // it lifted can be graded on derby matches alone: 59 derbies in 3,106
        // matches means the all-match card record would hide a 1.18x factor
        // whether it is right or wrong.
        ...(m.derby ? { derby: m.derby } : {}),
        legs: m.legs.filter((l) => !l.low_data).map((l) => ({ id: l.id, market: l.market, p: +(l.pRaw ?? l.p).toFixed(4),
                                                             ...(l.player ? { player: l.player } : {}) })),
        upset: m.upset ? { level: m.upset.level, fav: m.upset.fav, favFail: +m.upset.favFail.toFixed(3),
                           dogWin: +m.upset.dogWin.toFixed(3), net: +(m.upset.net || 0).toFixed(2) } : null,
        // What HAWK expected, for the expectation-against-outcome record. The totals
        // are one number each; tackles are per player, as an unscaled per-90 rate
        // (TACKLE_SCALE is deliberately left off so the record measures the rate
        // itself and the scale can be read straight off the result).
        expected: m.expected ? { corners: r3(m.expected.corners), cards: r3(pairSum(m.expected.cards)),
                                 sot: r3(pairSum(m.expected.sot)) } : null,
        tackleRates: Object.fromEntries(["home", "away"].map((side) => [side,
          ((m.players || {})[side] || []).filter((p) => p.name && p.has_data && p.x && p.x.tackles > 0)
            .map((p) => ({ name: p.name, rate: +p.x.tackles.toFixed(3) }))])),
        probs: { home: +m.probs.home.toFixed(3), draw: +m.probs.draw.toFixed(3), away: +m.probs.away.toFixed(3) },
        ...(builders.length ? { builders } : {}),
      };
      predicted++;
    } catch (e) { console.warn(`skipped ${f.home} v ${f.away}: ${e.message}`); }
  }
}

// 3. Write.
// HAWK's 1X2 prediction for every match it saved (upcoming, and finished in
// the last 4 days with the score) — the Scores page shows them in its list.
for (const [id, d] of Object.entries(state.done || {})) if (now - Date.parse(d.kickoff) > 4 * 86400e3) delete state.done[id];
const predictions = {};
for (const [id, pr] of Object.entries(state.pending)) if (pr.probs) predictions[id] = { probs: pr.probs, level: pr.upset ? pr.upset.level : null, kickoff: pr.kickoff };
for (const [id, d] of Object.entries(state.done || {})) predictions[id] = d;
await writeFile(path.join(ROOT, "data", "predictions.json"), JSON.stringify({ updated: new Date().toISOString(), matches: predictions }));
// Keep the last 12 weeks.
if (T.weeks) for (const k of Object.keys(T.weeks).sort().slice(0, -12)) delete T.weeks[k];
// Phase 1a records builder tickets but nothing reads them yet, so until 1b grades
// them the only evidence it is working at all is a console line in a run log — and
// the grading step is continue-on-error, so a sampleBuilders() that quietly returned
// nothing would leave every run green and the week of data this needs simply absent.
// The inventory goes into graded.json instead, where one fetch answers it.
const pendingBuilders = Object.values(state.pending || {}).filter((p) => (p.builders || []).length);
const storedTickets = pendingBuilders.reduce((a, p) => a + p.builders.length, 0);
state.builderSeen = (state.builderSeen || 0) + builtTickets;
if (!state.builderSince && builtTickets) state.builderSince = new Date().toISOString();
await mkdir(path.dirname(STATE_FILE), { recursive: true });
await writeFile(STATE_FILE, JSON.stringify(state));
await writeFile(path.join(ROOT, "data", "graded.json"), JSON.stringify({
  updated: new Date().toISOString(), matches: T.matches, legs: T.legs, waiting: Object.keys(state.pending).length,
  byMarket: T.byMarket, byKey: T.byKey, byLeague: T.byLeague || {}, bands: T.bands,
  keyBands: T.keyBands || {},
  recent: T.recent.slice(0, KEEP_RECENT), upsets: T.upsets, upsetNet: T.upsetNet || [],
  statFit: T.statFit || {}, byLeagueKey: publishedLeagueKeys(),
  result: T.result || newResult(), drawBands: T.drawBands || newDrawBands(),
  byLine: publishedLines(), weeks: T.weeks || {},
  // HAWK's Brier against the closing line's, on the same legs. `hawk` lower than
  // `market` means HAWK forecast that market better than the price did.
  clv: T.clv || {},
  // 1a's counters: what the sampler is recording right now. `stored` is a QUEUE,
  // not a stockpile — a match's tickets are deleted with its pending entry the
  // moment it grades, which is why 1b has to grade them in the same pass.
  builders: { recorded: builtTickets, stored: storedTickets, matches: pendingBuilders.length,
    seen: state.builderSeen || 0, since: state.builderSince || null },
  // 1b: the tickets themselves, graded. `byAgree` is the block that says whether
  // the correlation factor is right; `matches` is the honest sample size.
  tickets: T.builders || null,
  // The second source's running report. Recorded, never applied — see crossCheck.
  sources: T.sources || null,
  // Raw chances against corrected ones, by Brier score: does the learning help?
  ab: T.ab || null,
}));
console.log(`graded ${graded} matches, saved predictions for ${predicted}; totals: ${T.matches} matches, ${T.legs} legs, ${Object.keys(state.pending).length} waiting`);
console.log(`[grade] recorded ${builtTickets} builder ticket(s) across ${predicted} prediction(s)`);
{
  const B = T.builders || {};
  if (B.n) {
    const pct = (c) => c.n ? `${(100 * c.won / c.n).toFixed(1)}% vs ${(100 * c.p / c.n).toFixed(1)}% said` : "—";
    const ret = (c) => c.stake ? ` · ${(c.back / c.stake).toFixed(2)} back per 1` : "";
    console.log(`[grade] TICKETS (1b): ${B.n} graded over ${B.matches} match(es), ${B.skipped} skipped — `
      + `${(100 * B.won / B.n).toFixed(1)}% landed vs ${(100 * B.p / B.n).toFixed(1)}% said`
      + (B.stake ? ` · ${((B.back || 0) / B.stake).toFixed(2)} back per 1 staked` : ""));
    // The one that settles whether `agree` is right: if HAWK's ticket chances are
    // too harsh, the gap widens as `agree` climbs.
    for (const b of B.byAgree) if (b.n) console.log(`[grade]   agree ${b.lo}-${b.hi}: ${b.n} tickets  ${pct(b)}${ret(b)}`);
  }
}
{
  const A = T.ab;
  if (A && A.n) {
    const raw = A.rawBrier / A.n, adj = A.adjBrier / A.n;
    const better = raw - adj;
    console.log(`[grade] LEARNING A/B: ${A.n} legs (${A.shifted} carried a correction) — `
      + `Brier raw ${raw.toFixed(5)} vs corrected ${adj.toFixed(5)}  `
      + `${better > 0 ? `the correction HELPS by ${(better * 1e4).toFixed(1)} per 10k`
                      : `the correction HURTS by ${(-better * 1e4).toFixed(1)} per 10k`}`);
    // Only the markets a correction actually touched, worst first: a market where
    // the shift makes things worse is one that is being over-corrected live.
    const rows = Object.entries(A.byKey)
      .filter(([, c]) => c.n >= 200 && Math.abs(c.said - c.adjSaid) > 0.5)
      .map(([k, c]) => [k, c, (c.raw - c.adj) / c.n])
      .sort((a, b) => a[2] - b[2]);
    for (const [k, c, d] of rows.slice(0, 6)) {
      console.log(`[grade]   ${k.padEnd(32)} n=${String(c.n).padStart(6)}  `
        + `said ${(100 * c.said / c.n).toFixed(1)}% -> ${(100 * c.adjSaid / c.n).toFixed(1)}%  `
        + `landed ${(100 * c.won / c.n).toFixed(1)}%  Brier ${d > 0 ? "better" : "WORSE"} by ${(Math.abs(d) * 1e4).toFixed(1)} per 10k`);
    }
  }
}
{
  const S = T.sources;
  if (S && S.matches) {
    console.log(`[grade] SECOND SOURCE (FotMob): ${S.resolved}/${S.matches} matches resolved, `
      + `${S.players} players compared, ${S.unmatched} unmatched`);
    for (const k of SRC_FIELDS) {
      const c = S.fields[k];
      if (!c || (!c.n && !c.onlyFM && !c.only365)) continue;
      console.log(`[grade]   ${k.padEnd(9)} ${String(c.n).padStart(6)} compared`
        + (c.n ? `, ${(100 * c.differ / c.n).toFixed(1)}% differ` : "")
        + `, 365-only ${c.only365}, fotmob-only ${c.onlyFM}`
        + (c.silentNonZero ? ` (${c.silentNonZero} where 365Scores is silent and FotMob is NOT zero)` : ""));
    }
    const r = S.rescue;
    if (r.ungraded) {
      console.log(`[grade]   tackles legs HAWK left ungraded: ${r.ungraded}; FotMob could settle ${r.settleable}.`);
      // Both figures over the SAME legs — the ones that had a chance to compare.
      if (r.saidN) {
        const said = 100 * r.said / r.saidN, got = 100 * r.wonOfSaidN / r.saidN;
        console.log(`[grade]   of ${r.saidN} with a chance attached: HAWK said ${said.toFixed(1)}%, `
          + `${got.toFixed(1)}% would have won (gap ${got - said >= 0 ? "+" : ""}${(got - said).toFixed(1)}). `
          + `Recorded only — settlement unchanged.`);
        if (r.saidN >= 200 && said - got > 10) {
          console.log(`[grade]   ^ the board never sees these, and they lose far more often than HAWK said. `
            + `Player Tackles' record is measured without its losers.`);
        }
        // The comparison that means something: both halves, same matches.
        if (r.graded) {
          const gs = 100 * r.gradedSaid / r.graded, gw = 100 * r.gradedWon / r.graded;
          const allN = r.graded + r.saidN, allW = r.gradedWon + r.wonOfSaidN, allS = r.gradedSaid + r.said;
          console.log(`[grade]   over the same matches: ${r.graded} tackles legs GRADED `
            + `(said ${gs.toFixed(1)}%, landed ${gw.toFixed(1)}%) and ${r.saidN} DISCARDED `
            + `(said ${said.toFixed(1)}%, landed ${got.toFixed(1)}%).`);
          console.log(`[grade]   both together: ${allN} legs, said ${(100 * allS / allN).toFixed(1)}%, `
            + `landed ${(100 * allW / allN).toFixed(1)}% — gap ${(100 * (allW - allS) / allN).toFixed(1)} `
            + `against the board's ${(gw - gs).toFixed(1)}. THAT difference is what dropping them hides.`);
        }
      } else {
        console.log(`[grade]   none of them carried a chance yet — no verdict.`);
      }
    }
    for (const [k, c] of Object.entries(B.byOpen)) if (c.n) console.log(`[grade]   opened ${k}: ${c.n} tickets  ${pct(c)}${ret(c)}`);
    console.log(`[grade]   the smallest-leg clamp bound on ${B.clamped} of ${B.n}`);
  } else {
    console.log(`[grade] TICKETS (1b): nothing graded yet (${(T.builders || {}).skipped || 0} skipped)`);
  }
}
// Closing line: the markets where HAWK forecast better than the price, worst gap
// first. A negative `edge` means the closing line beat HAWK on those legs.
{
  const rows = Object.entries(T.clv || {}).filter(([, c]) => c.n >= 200)
    .map(([m, c]) => [m, c.n, (c.market - c.hawk) / c.n]);
  if (rows.length) {
    console.log(`[grade] HAWK vs the closing line (Brier, 200+ legs; + means HAWK forecast it better):`);
    for (const [m, n, edge] of rows.sort((a, b) => b[2] - a[2]))
      console.log(`[grade]   ${m.padEnd(30)} ${String(n).padStart(6)} legs   ${edge >= 0 ? "+" : ""}${(1000 * edge).toFixed(2)} per 1000`);
  } else {
    console.log(`[grade] closing line: no market has 200 two-sided legs yet (${Object.keys(T.clv || {}).length} started)`);
  }
}
process.exit(0);   // the engine's timers shouldn't keep the job alive
