// Safety test, run by the GitHub Action before every deploy: loads this run's
// engine and data exactly as the website does (served on 127.0.0.1:8000),
// analyses a few upcoming matches and checks the answers make sense. If it
// fails, the Action stops before publishing, so the live site keeps the last
// version that worked.
//
// Run locally: python -m http.server 8000 --bind 127.0.0.1 (repo root), then
// node engine/smoke.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = process.env.HAWK_LOCAL || "http://127.0.0.1:8000";
const WANT = 3;   // matches to check

globalThis.window = globalThis;
globalThis.document = { baseURI: `${LOCAL}/builder/` };
vm.runInThisContext(await readFile(path.join(ROOT, "builder/engine.js"), "utf8"), { filename: "builder/engine.js" });
vm.runInThisContext(await readFile(path.join(ROOT, "builder/hawk-settle.js"), "utf8"), { filename: "builder/hawk-settle.js" });
const { HAWK, HawkSettle } = globalThis;

// ---------- every market HAWK offers must be one it can grade ----------
// The builder and the settler are separate files that never checked each other,
// and three markets sat in that gap: Match Offsides could never be settled, a
// Penalty has no data source at all, and A Red Card in the Match was offered for
// months and graded exactly never. Each one looked fine from either side alone.
//
// A finished match with EVERY fact filled in. The point of filling it completely
// is that "unknown" can then only mean "no branch in legResult for this id" —
// never "the data was missing" — which is what makes a failure here real.
const GRADED_FACTS = {
  finished: true, homeId: 1,
  ft: [2, 1], ht: [1, 0], twoUp: { home: false, away: false },
  first: "home", qualified: "home",
  corners: [6, 5], cards: [3, 2], sot: [5, 4], offsides: [2, 1], reds: [0, 1],
  tackles: [10, 9], players: { home: [], away: [] }, closing: {}, replacedBy: null,
};
// Player props are left out on purpose: their branch needs the real player inside
// facts.players, so a synthetic one would report "void" and drown this in noise.
// All three markets that went missing were match-level, and player props are the
// best-covered on the board anyway.
const matchLevel = (id) => !String(id).startsWith("p:");
function ungradeableMarkets(legs) {
  const bad = new Map();
  for (const l of legs) {
    if (!matchLevel(l.id) || bad.has(l.market)) continue;
    let r;
    try { r = HawkSettle.legResult(l, GRADED_FACTS, {}); }
    catch (e) { bad.set(l.market, `${l.id} threw ${e.name}: ${e.message}`); continue; }
    if (r !== "won" && r !== "lost") bad.set(l.market, `${l.id} settles "${r}"`);
  }
  return bad;
}

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); return ok; };

// 1. The data files the site needs are there and readable.
for (const f of ["data/meta.json", "data/fixtures.json"]) {
  try { JSON.parse(await readFile(path.join(ROOT, f), "utf8")); } catch (e) { failures.push(`${f} missing or broken (${e.message})`); }
}

// 2. A few real upcoming matches, start to finish.
let tested = 0, tried = 0;
const leagues = ["Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", ...HAWK.LEAGUES];
for (const league of [...new Set(leagues)]) {
  if (tested >= WANT || tried >= 12) break;
  let list = [];
  try { list = await HAWK.fixtures(league); } catch { continue; }   // 365Scores hiccup: try the next league
  const f = list.find((x) => !x.started);
  if (!f) continue;
  tried++;
  let m;
  try { m = await HAWK.match(league, f.id); } catch (e) {
    // A code error is a failure; a source not answering (or a match without
    // prices yet) isn't the engine's fault — try another match.
    if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError)
      failures.push(`${league} ${f.home} v ${f.away}: analysis crashed — ${e.name}: ${e.message}`);
    else console.log(`skip ${f.home} v ${f.away}: ${e.message}`);
    continue;
  }
  const name = `${f.home} v ${f.away}`, p = m.probs;
  check(Math.abs(p.home + p.draw + p.away - 1) < 0.01, `${name}: win chances add up to ${(100 * (p.home + p.draw + p.away)).toFixed(1)}%`);
  check(m.legs.length >= 50, `${name}: only ${m.legs.length} legs`);
  const bad = m.legs.filter((l) => !(l.p > 0 && l.p < 1) || !(l.fair > 1));
  check(!bad.length, `${name}: ${bad.length} legs with an impossible chance (e.g. ${bad[0] && bad[0].id})`);
  check(m.upset && m.upset.label && Number.isFinite(m.upset.dogWin), `${name}: upset radar missing`);
  check(m.players && m.players.home && m.players.away, `${name}: no lineups/players`);
  try {
    const t = HAWK.build({ id: f.id, target: 3, style: "Balanced", focus: "Mix", maxLegs: 10, favourite: true });
    check(t.legs.length > 0 && t.p > 0 && t.p < 1, `${name}: the builder returned no ticket`);
  } catch (e) { failures.push(`${name}: build crashed — ${e.message}`); }
  for (const [market, why] of ungradeableMarkets(m.legs))
    check(false, `${name}: "${market}" is offered but cannot be graded — ${why}. `
      + `Give it a branch in hawk-settle.js legResult, or stop offering it in engine.js.`);
  tested++;
  console.log(`ok  ${league}: ${name} — ${m.legs.length} legs, ${Math.round(100 * p.home)}/${Math.round(100 * p.draw)}/${Math.round(100 * p.away)}, radar ${m.upset.label}`);
}
// No matches to test (a quiet week, or 365Scores down) isn't the engine's fault.
if (!tested) console.log("no upcoming match could be tested — skipping the match checks");

if (failures.length) {
  console.error(`SAFETY TEST FAILED — not deploying:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`safety test passed (${tested} match${tested === 1 ? "" : "es"})`);
process.exit(0);
