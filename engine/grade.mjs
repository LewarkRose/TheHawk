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

const newTotals = () => ({ matches: 0, legs: 0, byMarket: {}, byKey: {}, recent: [],
                           bands: BANDS.map(([lo, hi]) => ({ lo, hi, n: 0, p: 0, won: 0 })) });
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

const state = await loadState();
const T = state.totals;
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
  let n = 0, won = 0, said = 0;
  for (const leg of pr.legs) {
    const r = HawkSettle.legResult(leg, f);
    if (r !== "won" && r !== "lost") continue;   // didn't play, or no data
    const w = r === "won";
    n++; said += leg.p; if (w) won++;
    tally(T.byMarket[leg.market] ||= { n: 0, p: 0, won: 0 }, leg.p, w);
    const key = HAWK.learnKey(leg.id, leg.market);
    if (key) tally(T.byKey[key] ||= { n: 0, p: 0, won: 0 }, leg.p, w);
    const band = T.bands.find((b) => leg.p >= b.lo && leg.p < b.hi);
    if (band) tally(band, leg.p, w);
  }
  if (!n) continue;
  T.matches++; T.legs += n; graded++;
  T.recent.unshift({ id, league: pr.league, home: pr.home, away: pr.away, kickoff: pr.kickoff, score: f.ft.join("-"),
                     n, said: +(said / n).toFixed(3), got: +(won / n).toFixed(3) });
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
      };
      predicted++;
    } catch (e) { console.warn(`skipped ${f.home} v ${f.away}: ${e.message}`); }
  }
}

// 3. Write.
await mkdir(path.dirname(STATE_FILE), { recursive: true });
await writeFile(STATE_FILE, JSON.stringify(state));
await writeFile(path.join(ROOT, "data", "graded.json"), JSON.stringify({
  updated: new Date().toISOString(), matches: T.matches, legs: T.legs, waiting: Object.keys(state.pending).length,
  byMarket: T.byMarket, byKey: T.byKey, bands: T.bands, recent: T.recent.slice(0, 20),
}));
console.log(`graded ${graded} matches, saved predictions for ${predicted}; totals: ${T.matches} matches, ${T.legs} legs, ${Object.keys(state.pending).length} waiting`);
process.exit(0);   // the engine's timers shouldn't keep the job alive
