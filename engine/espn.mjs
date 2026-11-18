// ESPN — a THIRD opinion on the per-player numbers HAWK settles player legs from.
// 365Scores remains the source of truth; nothing here changes a settlement.
//
// WHY THIS EXISTS, and it is not the reason FotMob exists.
//
// 365Scores publishes a player's stat row only once the number is non-zero. For
// TACKLES that silence is handled: hawk-settle.js checks the team total and returns
// "unknown" when tackles are unaccounted for, so the leg goes ungraded rather than
// wrongly lost, and [[engine/fotmob.mjs]] measures what a second source would have
// rescued. For every OTHER player stat there is no such escape — `countOf(null)` is
// 0, so a missing row settles the leg as a LOSS. HAWK is already betting that
// 365Scores' silence means zero, in the same code the Vault settles real bets with,
// and that bet has never been checked at scale.
//
// ESPN is the source that can check it, because its payload is DENSE. Measured on
// Aston Villa at Manchester United, 8 Nov 2026: totalShots, shotsOnTarget,
// totalGoals, goalAssists, foulsCommitted, foulsSuffered, yellowCards and redCards
// are present on 40 of 40 players, offsides on 36. It states a zero where
// 365Scores says nothing at all. So every "365Scores silent, ESPN non-zero" is a
// leg HAWK may have lost that should have won.
//
// Unlike FotMob this source CAN reach the app: ESPN sends
// `Access-Control-Allow-Origin: *` (verified 18 Nov 2026) and builder/engine.js
// already calls it from the browser for confirmed line-ups. That is why it is
// worth building, and it is deliberately NOT used yet — this module only measures.
//
// TWO FIELDS DELIBERATELY NOT COMPARED
//  * tackles — ESPN has no per-player tackles at all, only team totalTackles and
//    effectiveTackles. The one market FotMob uniquely covers is the one ESPN
//    cannot. Do not unwire FotMob.
//  * cards — 365Scores' stats block UNDER-COUNTS them, which is why hawk-settle
//    reads cards from `game.events` instead. Comparing the stats block would
//    manufacture a disagreement that is a known artefact of the reader, the same
//    trap as comparing the numerator of "2/3 (66.7%)" for tackles.
//
// NO MINUTES, and the guard that replaces them. ESPN publishes no minutes played.
// It publishes `appearances`: 1 for a player who was involved, 0 for an unused
// substitute. In that same match 8 of 40 players read 0 — four per side, leaving
// 16 played against 11 starters plus 5 substitutions each, which is right — and
// every one of them was `starter: false, subbedIn: false`, no exceptions. That
// cross-check is the point: two independent fields agree on who played. It is the
// guard FotMob's
// SOURCE_VERSION 4 needed and had to get from minutes: without it an unused sub
// reads as a legitimate zero, and counting those is what made the tackles rescue
// report 14% against a 57% price. `plays` carries clock stamps but is a list of
// involvements, not substitutions (a starter who was never subbed can have one),
// so minutes cannot be derived from it. Do not try.
//
// Every call fails soft: an ESPN outage must never stop a match grading.

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const HEAD = { "Accept": "application/json" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HEAD });
      if (r.ok) return await r.json();
      if (r.status < 500 && r.status !== 429) return null;
    } catch { /* retry */ }
    await sleep(700 * (i + 1));
  }
  return null;
}

const ymdUTC = (t) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};

const dayCache = new Map();
async function scoreboard(slug, day) {
  const k = `${slug}/${day}`;
  if (!dayCache.has(k)) dayCache.set(k, await getJSON(`${BASE}/${slug}/scoreboard?dates=${day}`));
  return dayCache.get(k);
}

/** ESPN's event id for a fixture, or null.
 *
 *  The test is the one builder/engine.js already uses in production for line-ups
 *  (`espnLineups`): both club names over 0.6 on HAWK's own nameSimilarity, and a
 *  kick-off within six hours. `similar` is injected rather than reimplemented so
 *  there is exactly one club-matching rule for ESPN in the codebase — a second
 *  one would be a second set of club-matching bugs.
 *
 *  Ambiguity returns null. ESPN files a match under its own date, so one event
 *  legitimately appears on two adjacent days' scoreboards; those are deduplicated
 *  by id. What survives dedup and still numbers more than one is two different
 *  matches, and picking one would mean comparing one match's players against
 *  another's and calling the difference a disagreement. */
export async function findEvent(slug, kickoffISO, home, away, similar) {
  if (!slug) return null;
  const t = Date.parse(kickoffISO);
  if (!Number.isFinite(t)) return null;
  const hits = new Map();
  for (const day of new Set([ymdUTC(t), ymdUTC(t - 86400e3), ymdUTC(t + 86400e3)])) {
    const sb = await scoreboard(slug, day);
    for (const e of (sb && sb.events) || []) {
      const cs = ((e.competitions || [])[0] || {}).competitors || [];
      const h = cs.find((c) => c.homeAway === "home"), a = cs.find((c) => c.homeAway === "away");
      if (!h || !a || !h.team || !a.team) continue;
      if (Math.abs(Date.parse(e.date) - t) >= 6 * 3600e3) continue;
      if (similar(home, h.team.displayName) < 0.6 || similar(away, a.team.displayName) < 0.6) continue;
      hits.set(String(e.id), true);
    }
  }
  return hits.size === 1 ? [...hits.keys()][0] : null;
}

// ESPN's own names for the numbers HAWK settles on. `tackles` is absent because
// ESPN has none per player, and the cards are absent on purpose — see the header.
const FIELD = {
  shots: "totalShots", sot: "shotsOnTarget", goals: "totalGoals", assists: "goalAssists",
  fouls: "foulsCommitted", fouled: "foulsSuffered", offsides: "offsides", saves: "saves",
};

/** {home: [{name, played, stats:{shots,sot,...}}], away: [...]} — or null.
 *
 *  `played` is `appearances === 1`. A row with `played: false` is an unused
 *  substitute: its zeros are not observations and the caller must drop it, because
 *  an absent player VOIDS a leg at the book rather than losing it.
 *
 *  A field ESPN does publish is a real reading INCLUDING zero — that density is the
 *  whole point of this module, so a zero here must never be collapsed into
 *  "missing". A field genuinely absent from the payload stays undefined. */
export async function playerStats(slug, eventId) {
  const s = await getJSON(`${BASE}/${slug}/summary?event=${eventId}`);
  const rosters = (s && s.rosters) || [];
  if (!rosters.length) return null;
  const out = { home: [], away: [] };
  for (const t of rosters) {
    const side = t.homeAway === "home" || t.homeAway === "away" ? t.homeAway : null;
    if (!side) continue;
    for (const p of t.roster || []) {
      const flat = {};
      for (const st of p.stats || []) {
        const v = Number(st.displayValue);
        if (st.name && Number.isFinite(v)) flat[st.name] = v;
      }
      const row = { name: (p.athlete || {}).displayName || "?", played: flat.appearances === 1, stats: {} };
      for (const [key, name] of Object.entries(FIELD)) {
        if (flat[name] != null) row.stats[key] = flat[name];
      }
      out[side].push(row);
    }
  }
  return out.home.length || out.away.length ? out : null;
}
