// Can a GitHub runner read SofaScore, and does SofaScore have what Malta needs?
//
// Two separate questions, and this answers both in one run. It writes nothing,
// changes nothing and is wired to no schedule — run it by hand from the Actions
// tab, read the log, decide, delete it.
//
// WHY IT EXISTS
// 365Scores publishes a lineup for about one Maltese Premier League game in five
// and per-player stats for none of them, so Malta is team markets only. ESPN
// stopped covering Malta after 2024/25 and FotMob does not carry it at all.
// SofaScore does: it had a CONFIRMED XI for Floriana v Valletta on 1 Nov 2026
// when 365Scores had nothing, and it puts a rating on players in finished
// Maltese matches — and SofaScore only rates players in matches where it has
// collected per-player numbers. So the data exists. The question is whether
// HAWK can reach it.
//
// THE LINE THIS CODE DOES NOT CROSS
// Every request below is plain: no User-Agent, no Referer, no cookie, no key,
// nothing that disguises what is calling. SofaScore refuses this developer's
// machine on every host tried — api.sofascore.com answers 403 and
// api.sofascore.app answers 200 with an empty body from a Varnish edge. A
// GitHub runner is a different network and may be treated differently; that is
// the whole experiment. If it is refused too, THAT IS THE ANSWER. Do not come
// back and add headers to make this pass. A site that declines an honest
// request has declined.
//
// WHAT A PASS WOULD UNLOCK
//   - the lineup gap: a confirmed XI for Maltese games 365Scores leaves blank
//   - the real prize: per-player match stats, which is the ONLY thing that
//     could ever give Malta player props. HAWK needs roughly six matches per
//     player to build per-90 rates, so it needs a feed, not a lineup.
//   - the id mapping, for free: events carry team names and a kick-off
//     timestamp, which is exactly what engine/fotmob.mjs already matches on.
//
// WHAT A PASS WOULD NOT UNLOCK
// Nothing here can reach the app. SofaScore sends no Access-Control-Allow-Origin,
// so the browser blocks it the same way it blocks FotMob — see the top of
// engine/fotmob.mjs. Anything built on this lives in the pipeline and arrives
// in the app as a built data file, hours old. A confirmed XI that is six hours
// stale is worth less than it sounds, so read the stats result first.

const MALTA = 629;            // SofaScore's unique-tournament id for Malta's Premier League
const HOSTS = ["https://api.sofascore.com", "https://api.sofascore.app"];

// The stat keys HAWK actually prices on. Anything else SofaScore returns is a
// bonus; these are the ones whose absence makes the whole exercise pointless.
const WANTED = ["totalShots", "shotsOnTarget", "onTargetScoringAttempt", "totalTackle",
                "fouls", "wasFouled", "minutesPlayed", "rating"];

async function get(host, path) {
  // No headers. See the note above.
  try {
    const r = await fetch(`${host}${path}`);
    const body = await r.text();
    if (!r.ok) return { ok: false, why: `HTTP ${r.status}`, status: r.status };
    if (!body) return { ok: false, why: "200 with an empty body (soft block)", status: 200 };
    try { return { ok: true, json: JSON.parse(body) }; }
    catch { return { ok: false, why: `200 but not JSON (${body.length} bytes)`, status: 200 }; }
  } catch (e) {
    return { ok: false, why: `network: ${e.message}` };
  }
}

// Which host, if either, will talk to us.
async function pickHost() {
  for (const host of HOSTS) {
    const r = await get(host, `/api/v1/unique-tournament/${MALTA}/seasons`);
    console.log(`[probe] ${host} -> ${r.ok ? "OK" : r.why}`);
    if (r.ok) return { host, seasons: r.json };
  }
  return null;
}

const main = async () => {
  const hit = await pickHost();
  if (!hit) {
    console.log("[probe] VERDICT: SofaScore refuses the runner too. Malta stays team markets only.");
    console.log("[probe] Do not retry with headers. Delete this file.");
    return;
  }
  const { host } = hit;

  const seasons = hit.seasons.seasons || [];
  console.log(`[probe] seasons listed: ${seasons.length}` +
              (seasons.length ? ` — newest ${seasons[0].year} (id ${seasons[0].id})` : ""));
  if (!seasons.length) return console.log("[probe] no seasons, nothing to look at");
  const season = seasons[0].id;

  // Finished matches, newest first. This is also the id-mapping test: whatever
  // comes back has to carry enough to tie a row to a 365Scores fixture.
  const ev = await get(host, `/api/v1/unique-tournament/${MALTA}/season/${season}/events/last/0`);
  if (!ev.ok) return console.log(`[probe] events: ${ev.why}`);
  const events = (ev.json.events || []).slice(-5).reverse();
  console.log(`[probe] finished matches available: ${(ev.json.events || []).length}`);
  for (const e of events) {
    console.log(`[probe]   ${e.id}  ${new Date(e.startTimestamp * 1000).toISOString().slice(0, 10)}  ` +
                `${e.homeTeam?.name} v ${e.awayTeam?.name}`);
  }
  if (!events.length) return console.log("[probe] no finished matches to inspect");

  // The question that decides everything: does a Maltese match carry per-player
  // numbers, or only a name and a shirt?
  const game = events[0];
  const lu = await get(host, `/api/v1/event/${game.id}/lineups`);
  if (!lu.ok) return console.log(`[probe] lineups for ${game.id}: ${lu.why}`);
  console.log(`[probe] lineups confirmed flag: ${lu.json.confirmed}`);

  for (const side of ["home", "away"]) {
    const players = lu.json[side]?.players || [];
    const withStats = players.filter((p) => p.statistics && Object.keys(p.statistics).length);
    console.log(`[probe] ${side}: ${players.length} players, ${withStats.length} with a statistics object`);
    if (!withStats.length) continue;
    const keys = new Set();
    for (const p of withStats) for (const k of Object.keys(p.statistics)) keys.add(k);
    console.log(`[probe]   ${keys.size} distinct stat keys`);
    console.log(`[probe]   HAWK needs: ` + WANTED.map((w) => `${w}=${keys.has(w) ? "YES" : "no"}`).join("  "));
    const sample = withStats[0];
    console.log(`[probe]   e.g. ${sample.player?.name}: ` +
                Object.entries(sample.statistics).slice(0, 14).map(([k, v]) => `${k}=${v}`).join(" "));
  }

  // History depth: per-90 rates need roughly six matches per player, so one
  // match carrying stats is necessary and nowhere near sufficient.
  console.log("[probe] NOTE: one match with stats is not enough. HAWK needs ~6 per player.");
  console.log("[probe] If the keys above are YES, the next question is how far back events/last goes.");
};

main().catch((e) => console.log(`[probe] died: ${e.message}`));
