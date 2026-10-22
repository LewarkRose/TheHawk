// FotMob — a SECOND opinion on the per-player numbers HAWK settles player legs
// from. 365Scores remains the source of truth; nothing here changes a settlement.
//
// Why it can only live in the pipeline: FotMob serves no `Access-Control-Allow-Origin`
// header, so a browser cannot call it from a static site. 365Scores sends `*`, which
// is the whole reason HAWK is built on it. Anything added here is available to
// grade.mjs and the nightly run, never to the app.
//
// Measured over 13 matches and 391 name-matched players on 2026-10-21, against the
// numbers HAWK actually settles on:
//
//   field      compared  differ        field      compared  differ
//   shots         194     1.0%         fouls         391     0.5%
//   sot           101     1.0%         offsides       38     0.0%
//   tackles       153     3.9%         saves          25     4.0%
//   fouls won     167     1.8%
//
// So the two sources agree. The reason to carry FotMob is not disagreement, it is
// SILENCE: 365Scores names a player's tackles only once he has won one, and in that
// sample it published no tackles row for 53 player-matches where FotMob had one or
// more. hawk-settle.js already refuses to guess there (legResult returns "unknown"),
// so those legs go ungraded rather than wrongly lost — which is correct, and is the
// hole this fills.
//
// FotMob's endpoints have already moved once (/api/... -> /api/data/...), so every
// call here fails soft: a FotMob outage must never stop a match grading.

const BASE = "https://www.fotmob.com/api/data";
const HEAD = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
  "Accept": "application/json",
  "Referer": "https://www.fotmob.com/",
};

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

const strip = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Club-name noise. Deliberately short: every word removed is a word that can no
// longer tell two clubs apart.
const NOISE = new Set(["fc", "cf", "sc", "ac", "afc", "cd", "sv", "vfb", "vfl", "bk", "if", "sk",
  "us", "ss", "as", "ca", "club", "de", "the", "nk", "hnk", "fk", "kaa", "rc", "ks",
  "sport", "sports", "team", "calcio", "futbol", "football"]);
// A youth or reserve side is a DIFFERENT match with a near-identical name, and FotMob
// lists both on the same day — "Lille v Galatasaray" and "Lille U19 v Galatasaray U19"
// were both on 21 Oct. Never match across this line.
const AGE = /\b(u ?\d{2}|youth|women|reserves?|ii|b team)\b/;

// A token that does not identify a club ON ITS OWN. One shared word is not enough
// when the word is the city or the prefix half the league shares: "Manchester
// United" and "Manchester City" share `manchester`, "Real Madrid" and "Real
// Sociedad" share `real`. Both matched under the first version of this.
const COMMON = new Set(["manchester", "real", "atletico", "athletic", "inter", "sporting",
  "dynamo", "dinamo", "olympique", "olympiacos", "racing", "union", "red", "bull", "star",
  "borussia", "deportivo", "universidad", "universitatea", "nacional", "national", "america",
  "city", "united", "town", "rovers", "wanderers", "albion", "county", "north", "south",
  "east", "west", "new", "san", "santa", "santos", "river", "central", "independiente",
  "sportive", "football", "lokomotiv", "spartak", "zenit",
  // Club prefixes shared across different clubs: Viktoria Plzen / Viktoria Koln,
  // Eintracht Frankfurt / Eintracht Braunschweig, Rapid Wien / Rapid Bucuresti.
  "viktoria", "victoria", "eintracht", "fortuna", "hertha", "rapid", "austria", "royal",
  // Cities, for the same reason: Sparta Praha and Slavia Praha are two clubs that
  // share only the city. Safe to list, because the pairs that SHOULD match on a
  // city ("Real Madrid" / "Real Madrid CF", "AC Milan" / "Milan") are already
  // covered by the subset rule below.
  "praha", "prague", "madrid", "milan", "milano", "roma", "rome", "london", "paris",
  "lisboa", "lisbon", "istanbul", "moscow", "moskva", "zagreb", "beograd", "belgrade",
  "bucuresti", "bucharest", "wien", "vienna", "munchen", "munich", "berlin", "hamburg",
  "koln", "cologne", "torino", "turin", "sevilla", "seville", "athens", "athina",
  "glasgow", "bruxelles", "brussels", "warszawa", "warsaw", "budapest", "sofia", "kyiv", "kiev"]);

export const clubTokens = (name) =>
  new Set(strip(name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !NOISE.has(w)));

export function sameClub(a, b) {
  if (AGE.test(strip(a)) !== AGE.test(strip(b))) return false;
  const ta = clubTokens(a), tb = clubTokens(b);
  if (!ta.size || !tb.size) return false;
  // One name containing the whole of the other is the common shape across the two
  // feeds: "Athletic Bilbao" / "Athletic Club" (club is noise), "Inter Milan" / "Inter".
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let covered = true;
  for (const w of small) if (!big.has(w)) { covered = false; break; }
  if (covered) return true;
  // Otherwise they must share a word that identifies a club by itself — which is
  // what lets "Bayern Munich" meet "Bayern München" while the pairs above stay apart.
  for (const w of ta) if (tb.has(w) && !COMMON.has(w)) return true;
  return false;
}

// A player is matched on his last name. Accents differ between the two sources
// ("Jesús Garza" / "Jesus Garza"), and a shared last name inside one squad is a
// reason to skip the player, never to pick one.
export const lastName = (s) => {
  const w = strip(s).replace(/[^a-z ]/g, " ").split(/\s+/).filter((x) => x.length > 1);
  return w.length ? w[w.length - 1] : "";
};

const dayCache = new Map();
async function matchesOn(yyyymmdd) {
  if (!dayCache.has(yyyymmdd)) dayCache.set(yyyymmdd, await getJSON(`${BASE}/matches?date=${yyyymmdd}`));
  return dayCache.get(yyyymmdd);
}

const stamp = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

/** FotMob's match id for a 365Scores fixture, or null. Ambiguity returns null:
 *  two candidates is a reason to skip the match, never to pick one. */
export async function findMatch(kickoffISO, home, away) {
  const t = Date.parse(kickoffISO);
  if (!Number.isFinite(t)) return null;
  const hits = [];
  // A kick-off near midnight UTC can be filed under either day.
  for (const off of [0, -1, 1]) {
    const d = await matchesOn(stamp(new Date(t + off * 86400e3)));
    for (const lg of (d && d.leagues) || []) {
      for (const m of lg.matches || []) {
        if (sameClub(home, m.home && m.home.name) && sameClub(away, m.away && m.away.name)) {
          if (!hits.some((x) => x.id === m.id)) hits.push({ id: m.id, league: lg.name });
        }
      }
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

// FotMob's titles for the numbers HAWK settles on. Its `key` field is a mix of
// snake_case, PascalCase and localisation paths ("matchstats.headers.tackles"), so
// the display title is the steadier handle of the two.
const FIELD = {
  shots: "Total shots", sot: "Shots on target", tackles: "Tackles", fouled: "Was fouled",
  fouls: "Fouls committed", offsides: "Offsides", saves: "Saves", minutes: "Minutes played",
};

/** {home: [{name, stats:{shots,sot,...}}], away: [...]} — or null.
 *  A stat FotMob has no number for is ABSENT from its payload (a player who took
 *  no shots has no "Total shots" row), and it also publishes some rows with a null
 *  value. Neither is a zero, so both stay undefined here and the caller must treat
 *  a missing value as "no data" rather than nil. */
export async function playerStats(matchId) {
  const m = await getJSON(`${BASE}/matchDetails?matchId=${matchId}`);
  const ps = m && m.content && m.content.playerStats;
  if (!ps) return null;
  const homeId = m.general && m.general.homeTeam && m.general.homeTeam.id;
  const out = { home: [], away: [] };
  for (const p of Object.values(ps)) {
    const flat = {};
    for (const grp of p.stats || []) {
      for (const [title, v] of Object.entries(grp.stats || {})) {
        const val = v && v.stat ? v.stat.value : undefined;
        if (val != null) flat[title] = val;
      }
    }
    const row = { name: p.name, stats: {} };
    for (const [key, title] of Object.entries(FIELD)) {
      if (flat[title] != null) row.stats[key] = Number(flat[title]);
    }
    out[p.teamId === homeId ? "home" : "away"].push(row);
  }
  return out.home.length || out.away.length ? out : null;
}

/** Index a side's players by last name, dropping any name two players share —
 *  an ambiguous match is worse than no match. */
export function byLastName(rows) {
  const seen = new Map();
  for (const r of rows || []) {
    const k = lastName(r.name);
    if (!k) continue;
    seen.set(k, seen.has(k) ? null : r);
  }
  for (const [k, v] of seen) if (!v) seen.delete(k);
  return seen;
}
