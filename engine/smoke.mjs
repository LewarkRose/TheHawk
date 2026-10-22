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

// ---------- HAWK MUST NOT CONTRADICT ITSELF ----------
// Every block above asks whether HAWK is RIGHT. These ask whether it is COHERENT,
// which is a different property and the one a person actually experiences. On
// 2026-10-22 a session's worth of bugs turned out to be nine contradictions and
// zero wrong models: two offered tickets taking opposite sides of the same goals
// line, a badge disagreeing with the board it reads from, two totals for the same
// day, a double chance priced at half its real chance. Lewzu found two thirds of
// them. These checks exist so the deploy finds them first.
//
// Each one is here because something really went wrong in the way it describes.
const OU_ID = /^((?:t?goals|t?corners|t?cards|sot|offs|h[12]goals)(?::(?:home|away))?):([ou])([\d.]+)$/;
const ouOf = (t) => (t.legs || []).map((l) => OU_ID.exec((l && l.id) || "")).filter(Boolean);
// Two tickets argue when one needs a total above a line and the other needs it
// below one no higher — leaving a single scoreline where both land, or none.
function arguingPair(options) {
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      for (const a of ouOf(options[i])) {
        for (const b of ouOf(options[j])) {
          if (a[1] !== b[1] || a[2] === b[2]) continue;
          const over = a[2] === "o" ? +a[3] : +b[3], under = a[2] === "o" ? +b[3] : +a[3];
          if (under - over <= 1) return `option ${i + 1} "${a[0]}" vs option ${j + 1} "${b[0]}"`;
        }
      }
    }
  }
  return null;
}
// A market HAWK prices on both sides must have the two sides add to one. This is
// the invariant behind the de-margining bug and behind "HAWK rates it lower" having
// once appeared on the Over AND the Under of the same line.
function brokenPairs(legs) {
  const by = new Map();
  for (const l of legs) {
    const m = OU_ID.exec(l.id || "");
    if (m) by.set(`${m[1]}|${m[3]}|${m[2]}`, l.p);
  }
  const bad = [];
  for (const [k, p] of by) {
    const [q, line, side] = k.split("|");
    if (side !== "o") continue;
    const u = by.get(`${q}|${line}|u`);
    // A line can legitimately be offered on one side only (the other fell outside
    // MIN_LEG_P / MAX_LEG_P), which is not a contradiction.
    if (u == null) continue;
    if (Math.abs(p + u - 1) > 0.02) bad.push(`${q} ${line}: over ${(100 * p).toFixed(1)}% + under ${(100 * u).toFixed(1)}% = ${(100 * (p + u)).toFixed(1)}%`);
  }
  return bad;
}

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); return ok; };

// 0. De-margining, on markets with a known answer. grade.mjs divides a leg's
// implied chance by the sum of every option's — which is only right when the
// options are mutually exclusive AND cover everything. Double Chance is neither
// (1X, 12 and X2 each contain two results, so they sum to 2), and for weeks the
// closing-line block read Bet365 at 30.9% on double chances that landed 58.3%.
// That one error was the whole of HAWK's apparent edge over the market.
// Priced here with a deliberate margin so a check that ignored it would fail.
{
  const mod = await import(new URL("./grade-demargin.mjs", import.meta.url)).catch(() => null);
  const demargin = mod && mod.closingChanceFor;
  if (!demargin) {
    failures.push("engine/grade-demargin.mjs is missing — the de-margin check cannot run");
  } else {
    const cases = [
      // [line type, options, the one we want, roughly what it should be]
      [1, { "1": 1.70, X: 3.80, "2": 5.00 }, "1", 0.56, "1X2 home"],
      [14, { "1X": 1.30, "12": 1.25, X2: 2.30 }, "1X", 0.77, "double chance 1X"],
      [14, { "1X": 1.30, "12": 1.25, X2: 2.30 }, "X2", 0.43, "double chance X2"],
      [3, { Over: 1.90, Under: 1.90 }, "Over", 0.50, "a two-way total"],
    ];
    for (const [type, opts, want, expect, label] of cases) {
      const q = demargin(type, opts, want);
      check(q != null && Math.abs(q - expect) < 0.04,
        `de-margining is wrong for ${label}: got ${q == null ? "null" : (100 * q).toFixed(1) + "%"}, expected about ${(100 * expect).toFixed(0)}%`);
    }
    // Every option present is what makes the overlap correction safe.
    check(demargin(14, { "1X": 1.30, X2: 2.30 }, "1X") == null,
      "de-margining a double chance with an option missing must return null, not a halved number");
  }
}

// 0b. ONE RULE FOR WHICH DAY OR WEEK A TICKET BELONGS TO.
// The Vault had two: the history rows bucketed by the night a ticket was played,
// the Weekly Report by the day it settled. One ticket in the log differs — settled
// a week after the match — and €6 was enough to flip a week from −€2.14 to +€3.86
// between two blocks on the same page. Settled on match day, 2026-10-22.
//
// This is a source check rather than a behaviour one, because the Vault's page
// script is not loaded here. Crude, and it still catches the regression: the day
// someone reaches for settleTime inside renderWeekly again, the deploy stops.
{
  const src = await readFile(path.join(ROOT, "index.html"), "utf8");
  const start = src.indexOf("function renderWeekly");
  const body = start < 0 ? "" : src.slice(start, start + 4000);
  check(start >= 0, "index.html: renderWeekly has gone — the week-attribution check cannot run");
  if (start >= 0) {
    check(!/inWeek\(\s*settleTime/.test(body),
      "index.html: the Weekly Report is bucketing by settleTime again. The history rows and the "
      + "week strip use betTime (the night it was played), and two rules for the same week put two "
      + "different totals on one page.");
    check(/inWeek\(\s*betTime/.test(body),
      "index.html: the Weekly Report no longer buckets by betTime — it must share the rule the "
      + "history rows and the week strip use.");
  }
}

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
  // The two sides of a line HAWK prices itself must add to one.
  for (const bad of brokenPairs(m.legs))
    check(false, `${name}: the two sides of a line don't add up — ${bad}`);
  // Neither route to a list of options may offer two that argue. Both are tested
  // because the first fix went into one of them and the other kept contradicting.
  for (const [label, body] of [["Build", { id: f.id, target: 3, style: "Balanced", focus: "Mix", maxLegs: 10, favourite: true, options: 6 }],
                               ["Auto", { id: f.id, auto: true, style: "Balanced", focus: "Mix", maxLegs: 10, favourite: true, options: 6 }]]) {
    let opts = null;
    try { opts = (HAWK.buildOptions(body, 6) || {}).options || []; }
    catch (e) { failures.push(`${name}: ${label} options crashed — ${e.message}`); continue; }
    const clash = arguingPair(opts);
    check(!clash, `${name}: ${label} offered two options that contradict each other — ${clash}. `
      + `See argues() in engine.js: opposite sides of the same total with no room between the lines.`);
  }
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
