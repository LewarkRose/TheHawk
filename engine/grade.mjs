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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = process.env.HAWK_LOCAL || "http://127.0.0.1:8000";
const LIVE = process.env.HAWK_LIVE || "https://lewarkrose.github.io/TheHawk";
const PREDICT_AHEAD_H = 6, GRADE_AFTER_H = 2.5, GIVE_UP_AFTER_D = 4, KEEP_RECENT = 40;
const BANDS = [[0, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 0.8], [0.8, 0.9], [0.9, 1.01]];
const STATE_FILE = path.join(ROOT, "data", "grading", "state.json");

// The browser engine and the settle module, run as they are.
globalThis.window = globalThis;
globalThis.document = { baseURI: `${LOCAL}/builder/` };
for (const f of ["builder/engine.js", "builder/hawk-settle.js"])
  vm.runInThisContext(await readFile(path.join(ROOT, f), "utf8"), { filename: f });
const { HAWK, HawkSettle } = globalThis;
HAWK.setLearning({});   // grade HAWK's own chances, not adjusted ones

const newBands = () => BANDS.map(([lo, hi]) => ({ lo, hi, n: 0, p: 0, won: 0 }));
const newTotals = () => ({ matches: 0, legs: 0, byMarket: {}, byKey: {}, byLeague: {}, keyBands: {},
                           recent: [], bands: newBands() });
// Upset radar record, per level (Low … Very high): how often the favourite
// really failed to win / the underdog won, against what the radar said.
const newUpsets = () => ["Low", "Medium", "High", "Very high"].map((label, level) =>
  ({ level, label, n: 0, saidFail: 0, failed: 0, saidDog: 0, dogWon: 0 }));
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
const now = Date.now();
let graded = 0, predicted = 0;

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
  }
  let n = 0, won = 0, said = 0;
  for (const leg of pr.legs) {
    const r = HawkSettle.legResult(leg, f);
    if (r !== "won" && r !== "lost") continue;   // didn't play, or no data
    const w = r === "won";
    n++; said += leg.p; if (w) won++;
    tally(T.byMarket[leg.market] ||= { n: 0, p: 0, won: 0 }, leg.p, w);
    const key = HAWK.learnKey(leg.id, leg.market);
    if (key) {
      tally(T.byKey[key] ||= { n: 0, p: 0, won: 0 }, leg.p, w);
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
    // Per league, so "is HAWK better in Serie A than in La Liga" can be answered
    // from every match rather than from the handful you happened to bet on.
    if (pr.league) tally((T.byLeague ||= {})[pr.league] ||= { n: 0, p: 0, won: 0, matches: 0 }, leg.p, w);
  }
  if (!n) continue;
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
      state.pending[String(f.id)] = {
        league, home: f.home, away: f.away, kickoff: f.kickoff, at: new Date().toISOString(),
        legs: m.legs.filter((l) => !l.low_data).map((l) => ({ id: l.id, market: l.market, p: +(l.pRaw ?? l.p).toFixed(4),
                                                             ...(l.player ? { player: l.player } : {}) })),
        upset: m.upset ? { level: m.upset.level, fav: m.upset.fav, favFail: +m.upset.favFail.toFixed(3), dogWin: +m.upset.dogWin.toFixed(3) } : null,
        probs: { home: +m.probs.home.toFixed(3), draw: +m.probs.draw.toFixed(3), away: +m.probs.away.toFixed(3) },
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
await mkdir(path.dirname(STATE_FILE), { recursive: true });
await writeFile(STATE_FILE, JSON.stringify(state));
await writeFile(path.join(ROOT, "data", "graded.json"), JSON.stringify({
  updated: new Date().toISOString(), matches: T.matches, legs: T.legs, waiting: Object.keys(state.pending).length,
  byMarket: T.byMarket, byKey: T.byKey, byLeague: T.byLeague || {}, bands: T.bands,
  keyBands: T.keyBands || {},
  recent: T.recent.slice(0, KEEP_RECENT), upsets: T.upsets, weeks: T.weeks || {},
}));
console.log(`graded ${graded} matches, saved predictions for ${predicted}; totals: ${T.matches} matches, ${T.legs} legs, ${Object.keys(state.pending).length} waiting`);
process.exit(0);   // the engine's timers shouldn't keep the job alive
