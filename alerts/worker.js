// HAWK screen-off alerts — a Cloudflare Worker (free plan).
//
// Every minute it checks the matches HAWK told it about (your pending HAWK
// bets, 🔔 matches and lineup alerts) on 365Scores and sends what's new to your
// phone through the ntfy app, so they arrive with the screen off:
//   ⚽ goals (and ❌⚽ ones VAR takes off) · 🟥 red cards · ⏸ half time · 🏁 full time
//   📋 lineups confirmed · ✅ a leg landing · 🔥 one leg to go · 🎉/❌ the bet's result
//
// Set up once — HAWK → Scores → 📲 Screen-off alerts walks you through it:
//   • a D1 database bound as DB (it keeps what's already been sent)
//   • a variable TOPIC = your ntfy topic (HAWK makes one for you)
//   • a Cron Trigger: * * * * *   (every minute)
//   • if ntfy turns the Worker away (too many requests from Cloudflare's shared
//     addresses): a secret NTFY_TOKEN = an access token from a free ntfy.sh account
// HAWK sends the list of matches to follow to this Worker's /follow address;
// only requests carrying your topic are accepted.

// Can't find "Variables and Secrets" in Cloudflare? Put your ntfy topic between
// the quotes instead (like "hawk-abc123") and press Deploy.
const MY_TOPIC = "";
const topicOf = (env) => env.TOPIC || MY_TOPIC;

const S365 = "https://webws.365scores.com/web";
const S365_PARAMS = { appTypeId: 5, langId: 1, timezoneName: "Europe/London", userCountryId: -1 };
const SITE = "https://lewarkrose.github.io", HAWK = `${SITE}/TheHawk/builder/`;
const NTFY = "https://ntfy.sh";
const BEFORE_MS = 75 * 60e3;       // start checking a match 75 minutes before kick-off (lineups)
const GIVE_UP_MS = 6 * 3600e3;     // …and stop 6 hours after it
const MAX_GAMES = 20, MAX_SENDS = 12;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": origin === SITE || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ? origin : SITE,
                   "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method === "GET") return reply({ hawk: "alerts", topic: !!topicOf(env), db: !!env.DB });
    if (!topicOf(env) || !env.DB) return reply({ error: "Not set up yet: add the TOPIC variable and the DB (D1) binding." }, 500);
    let body;
    try { body = await req.json(); } catch { return reply({ error: "bad request" }, 400); }
    if (!body || body.topic !== topicOf(env)) return reply({ error: "That topic doesn't match this Worker's TOPIC." }, 403);
    await initDb(env);
    const path = new URL(req.url).pathname;
    if (path === "/test") {
      const ok = await notify(env, { title: "🦅 HAWK alerts connected", message: "Goals, red cards and your bets will come here — even with the screen off.", tags: ["white_check_mark"] });
      return reply({ ok, ntfy: notify.last || null, token: !!env.NTFY_TOKEN });
    }
    if (path === "/follow") {
      const data = JSON.stringify({ games: (body.games || []).slice(0, 40), bets: (body.bets || []).slice(0, 40) });
      if (data.length > 80000) return reply({ error: "too much to follow" }, 413);
      await env.DB.prepare("INSERT INTO follows (device, data, at) VALUES (?1, ?2, ?3) ON CONFLICT(device) DO UPDATE SET data = ?2, at = ?3")
        .bind(String(body.device || "one").slice(0, 40), data, Date.now()).run();
      return reply({ ok: true });
    }
    return reply({ error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); },
};

async function initDb(env) {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS follows (device TEXT PRIMARY KEY, data TEXT, at INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sent (key TEXT PRIMARY KEY, at INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, kickoff INTEGER, checked INTEGER, done INTEGER)"),
  ]);
}

async function s365(path, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${S365}/${path}/?${new URLSearchParams({ ...S365_PARAMS, ...params })}`);
      if (r.ok) return await r.json();
      if (r.status < 500 && r.status !== 429) return null;
    } catch { /* try once more */ }
  }
  return null;
}

// ntfy.sh limits how much each internet address can send, and Cloudflare Workers
// share addresses — with a free ntfy.sh account, its access token (a secret
// NTFY_TOKEN on this Worker) makes the limit yours alone.
async function notify(env, a) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
    const r = await fetch(NTFY, { method: "POST", headers,
      body: JSON.stringify({ topic: topicOf(env), title: a.title, message: a.message || " ", priority: a.priority || 3, click: a.click || HAWK }) });
    notify.last = r.ok ? null : `ntfy answered ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`;
    return r.ok;
  } catch (e) { notify.last = `couldn't reach ntfy: ${e && e.message}`; return false; }
}

// ---------------------------------------------------------------------------
// Every minute
// ---------------------------------------------------------------------------
async function run(env) {
  if (!topicOf(env) || !env.DB) return;
  await initDb(env);
  const now = Date.now();
  // What to follow: every device's latest list (a device that hasn't sent one in 5 days is dropped).
  await env.DB.prepare("DELETE FROM follows WHERE at < ?1").bind(now - 5 * 86400e3).run();
  const games = new Map(), bets = new Map();
  for (const row of (await env.DB.prepare("SELECT data FROM follows").all()).results || []) {
    let d; try { d = JSON.parse(row.data); } catch { continue; }
    for (const b of d.bets || []) if (b && b.id) bets.set(String(b.id), b);
    for (const g of d.games || []) addGame(games, g);
  }
  for (const b of bets.values()) for (const p of b.parts || []) addGame(games, { id: p.game, league: p.league, bet: true });
  if (!games.size) return;

  const meta = new Map(((await env.DB.prepare("SELECT * FROM games").all()).results || []).map((g) => [g.id, g]));
  const sent = new Set(((await env.DB.prepare("SELECT key FROM sent WHERE at > ?1").bind(now - 4 * 86400e3).all()).results || []).map((r) => r.key));
  const alerts = [], silent = [], metaRows = [], seen = {};
  let fetched = 0;
  for (const g of games.values()) {
    const m = meta.get(g.id);
    if (m && m.done) continue;
    // Not close to kick-off yet: look again every 30 minutes (in case it moves).
    if (m && m.kickoff && now < m.kickoff - BEFORE_MS && now - (m.checked || 0) < 30 * 60e3) continue;
    if (m && m.kickoff && now > m.kickoff + GIVE_UP_MS) { metaRows.push([g.id, m.kickoff, now, 1]); continue; }
    if (++fetched > MAX_GAMES) break;
    const d = await s365("game", { gameId: g.id }), game = d && d.game;
    if (!game || !game.homeCompetitor) continue;
    const ko = Date.parse(game.startTime) || 0, off = /postpon|cancel|abandon|suspend/i.test(game.statusText || "");
    const info = gameInfo(g, game);
    seen[g.id] = info;
    // First time this match is checked: what already happened isn't news.
    const first = !sent.has(`s:${g.id}`);
    const list = off ? [{ key: `p:${g.id}`, title: `⚠️ ${game.statusText} — ${info.name}`, message: "HAWK stops following it." }] : matchAlerts(g, game, info);
    if (first) {
      silent.push(`s:${g.id}`, ...list.map((a) => a.key));
      if (game.statusGroup === 3) alerts.push({ key: `c:${g.id}`, title: `📡 HAWK is following ${info.name}`, message: `${info.score} (${game.gameTimeDisplay || "live"})`, click: info.live });
    } else for (const a of list) if (!sent.has(a.key)) alerts.push(a);
    // At full time: what happened to every leg (players' stats, corners, cards…).
    if (game.statusGroup === 4 && !off) info.facts = await matchFacts(game);
    // Finished: checked once more the minute after its full-time alert went, so nothing about your bet is missed.
    metaRows.push([g.id, ko, now, off || (game.statusGroup === 4 && info.facts && sent.has(`f:${g.id}`)) ? 1 : 0]);
  }

  // Your bets: legs landing, one leg to go, the result.
  for (const b of bets.values()) betAlerts(b, seen, sent, alerts, silent);

  // Send (a few a minute at most; the rest go next minute), then remember them.
  const done = [];
  for (const a of alerts.slice(0, MAX_SENDS)) if (await notify(env, a)) done.push(a.key, ...(a.also || []));
  const keys = [...new Set([...done, ...silent])];
  const stmts = keys.map((k) => env.DB.prepare("INSERT OR IGNORE INTO sent (key, at) VALUES (?1, ?2)").bind(k, now));
  for (const [id, ko, checked, isDone] of metaRows)
    stmts.push(env.DB.prepare("INSERT INTO games (id, kickoff, checked, done) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET kickoff = ?2, checked = ?3, done = ?4").bind(id, ko, checked, isDone));
  stmts.push(env.DB.prepare("DELETE FROM sent WHERE at < ?1").bind(now - 4 * 86400e3));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}
function addGame(map, g) {
  if (!g || !g.id) return;
  const id = String(g.id), cur = map.get(id) || { id, league: "", lineup: false, bet: false };
  cur.league ||= g.league || "";
  cur.lineup ||= !!g.lineup;
  cur.bet ||= !!g.bet;
  map.set(id, cur);
}

function evType(e) {
  const t = e && e.eventType, nm = ((t && t.name) || "").toLowerCase();
  if (!t) return null;
  if (t.id === 1) return "goal";
  if (t.id === 11 || /disallow|cancel/.test(nm)) return "disallowed";
  if (nm.includes("red")) return "red";
  return null;
}

function gameInfo(g, game) {
  const hc = game.homeCompetitor, ac = game.awayCompetitor;
  const H = Math.max(0, Math.trunc(hc.score) || 0), A = Math.max(0, Math.trunc(ac.score) || 0);
  const names = Object.fromEntries((game.members || []).map((m) => [m.id, m.name]));
  const evs = (game.events || []).filter((e) => e.eventType).sort((a, b) => (a.order || 0) - (b.order || 0));
  // Goals per player (own goals don't count as his) and assists, for the player legs.
  const goals = {}, assists = {};
  let h = 0, a = 0, lead = { home: false, away: false };
  for (const e of evs) {
    if (evType(e) !== "goal") continue;
    const own = /own/i.test((e.eventType && e.eventType.subTypeName) || "");
    e.competitorId === hc.id ? h++ : a++;
    if (h - a >= 2) lead.home = true;
    if (a - h >= 2) lead.away = true;
    if (!own && names[e.playerId]) goals[names[e.playerId]] = (goals[names[e.playerId]] || 0) + 1;
    const as = (e.extraPlayers || []).map((p) => names[p]).filter(Boolean)[0];
    if (!own && as) assists[as] = (assists[as] || 0) + 1;
  }
  return { hc, ac, H, A, names, evs, goals, assists, lead, status: game.statusGroup, clock: game.gameTimeDisplay || "",
           firstHalf: game.statusGroup === 3 && !((game.stages || []).find((s) => s.id === 7 && s.isEnded)),
           name: `${hc.name} v ${ac.name}`, score: `${hc.name} ${H}–${A} ${ac.name}`,
           live: `${HAWK}?view=live&id=${g.id}&league=${encodeURIComponent(g.league || "")}` };
}

function matchAlerts(g, game, info) {
  const { hc, ac, names, evs } = info, out = [];
  const team = (side) => (side === "home" ? hc.name : ac.name);
  let h = 0, a = 0;
  for (const e of evs) {
    const t = evType(e);
    if (!t) continue;
    const side = e.competitorId === hc.id ? "home" : "away", who = names[e.playerId] || "", min = e.gameTimeDisplay || "";
    const key = `${g.id}:${e.order != null ? e.order : `${e.eventType.id}-${e.playerId}-${min}`}`;
    if (t === "goal") {
      side === "home" ? h++ : a++;
      const sub = (e.eventType && e.eventType.subTypeName) || "", how = /pen/i.test(sub) ? " (pen)" : /own/i.test(sub) ? " (own goal)" : "";
      out.push({ key: `g:${key}`, title: `⚽ GOAL — ${hc.name} ${h}–${a} ${ac.name}`, message: `${who || team(side)} ${min}${how}`,
                 tags: ["soccer"], priority: g.bet ? 5 : 4, click: info.live });
    } else if (t === "disallowed") {
      out.push({ key: `x:${key}`, title: `❌⚽ Goal disallowed — ${info.name}`, message: `${who ? who + " " : ""}${min} · still ${info.H}–${info.A}`, priority: 4, click: info.live });
    } else if (t === "red") {
      out.push({ key: `r:${key}`, title: `🟥 Red card — ${who || team(side)}`, message: `${team(side)} · ${min} · ${info.score}`, priority: 4, click: info.live });
    }
  }
  const lu = (c) => ((c.lineups || {}).status || "") === "Confirmed";
  if ((g.lineup || g.bet) && game.statusGroup === 2 && lu(hc) && lu(ac))
    out.push({ key: `l:${g.id}`, title: `📋 Lineups are in — ${info.name}`, message: g.bet ? "Check your players are starting." : "Tap to rebuild your builder with them.",
               click: `${HAWK}?view=build&id=${g.id}&league=${encodeURIComponent(g.league || "")}` });
  if (g.bet && game.statusGroup === 3) out.push({ key: `k:${g.id}`, title: `🟢 Kick-off — ${info.name}`, message: "Your bet is live.", click: info.live });
  if (game.statusGroup === 3 && /half.?time|^ht$/i.test(game.shortStatusText || game.statusText || ""))
    out.push({ key: `h:${g.id}`, title: `⏸ Half time — ${info.score}`, click: info.live });
  if (game.statusGroup === 4) out.push({ key: `f:${g.id}`, title: `🏁 Full time — ${info.score}`, click: info.live });
  return out;
}

// ---------------------------------------------------------------------------
// Your bets
// ---------------------------------------------------------------------------
const normName = (s) => String(s || "").replace(/[øØ]/g, "o").replace(/ß/g, "ss").normalize("NFKD").replace(/\p{M}/gu, "")
  .toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
function samePerson(a, b) {
  const x = normName(a).split(" "), y = normName(b).split(" ");
  if (!x[0] || !y[0]) return false;
  if (x.join(" ") === y.join(" ")) return true;
  return x[x.length - 1] === y[y.length - 1] && (x.length === 1 || y.length === 1 || x[0][0] === y[0][0]);
}
const countFor = (tally, name) => Object.entries(tally).reduce((n, [who, c]) => n + (samePerson(who, name) ? c : 0), 0);

// A leg's state while the match is on: "won" / "lost" once it's certain, else null.
function liveLeg(h, info) {
  const id = h.id || "", { H, A } = info, sideGoals = (s) => (s === "home" ? [H, A] : [A, H]);
  let m;
  if ((m = /^p:(home|away):\d+:(score|assist|soa)(\d*)$/.exec(id))) {
    const who = h.player || String(h.label || "").split(/:| to /)[0], need = +m[3] || 1;
    const n = m[2] === "score" ? countFor(info.goals, who) : m[2] === "assist" ? countFor(info.assists, who) : countFor(info.goals, who) + countFor(info.assists, who);
    return n >= need ? "won" : null;
  }
  if ((m = /^res:(home|away)$/.exec(id)) && info.lead[m[1]]) return "won";   // Bet365 Early Payout: 2 goals up
  if ((m = /^goals:([ou])([\d.]+)$/.exec(id))) return H + A > +m[2] ? (m[1] === "o" ? "won" : "lost") : null;
  if ((m = /^btts:(yes|no)$/.exec(id))) return H > 0 && A > 0 ? (m[1] === "yes" ? "won" : "lost") : null;
  if ((m = /^team:(home|away):o([\d.]+)$/.exec(id))) return sideGoals(m[1])[0] > +m[2] ? "won" : null;
  if ((m = /^(cs|wtn):(home|away)$/.exec(id))) return sideGoals(m[2])[1] > 0 ? "lost" : null;
  if ((m = /^h1goals:o([\d.]+)$/.exec(id)) && info.firstHalf) return H + A > +m[1] ? "won" : null;
  return null;
}

function betAlerts(b, seen, sent, alerts, silent) {
  const parts = (b.parts || []).filter((p) => p && p.game && Array.isArray(p.legs));
  if (!parts.length) return;
  const legKey = (p, h) => `${b.id}|${p.game}|${h.id}`;
  const state = {}, fresh = [];
  for (const p of parts) {
    const info = seen[String(p.game)];
    for (const h of p.legs) {
      const k = legKey(p, h);
      let st = sent.has(`w:${k}`) ? "won" : sent.has(`L:${k}`) ? "lost" : sent.has(`v:${k}`) ? "void" : null;
      if (!st && h.userDone) st = "won";
      if (!st && info && info.facts) st = legResult(h, info.facts);
      else if (!st && info && info.status === 3) st = liveLeg(h, info);
      if (st === "unknown") st = null;
      if (st && !sent.has(`${st === "won" ? "w" : st === "lost" ? "L" : "v"}:${k}`)) fresh.push({ p, h, st, info, k });
      state[k] = st;
    }
  }
  const total = Object.keys(state).length + (b.other || 0);
  const won = Object.values(state).filter((s) => s === "won" || s === "void").length, lost = fresh.concat().filter((x) => x.st === "lost");
  const lostBefore = Object.entries(state).some(([k, s]) => s === "lost" && sent.has(`L:${k}`));
  const click = (x) => (x && x.info ? x.info.live : HAWK);
  const mark = (x) => `${x.st === "won" ? "w" : x.st === "lost" ? "L" : "v"}:${x.k}`;
  const betName = parts.length > 1 ? `your ${total}-leg acca` : "your bet";
  // A leg lost: one alert — the bet is gone.
  if (lost.length && !lostBefore && !sent.has(`B:${b.id}`)) {
    const x = lost[0];
    alerts.push({ key: `B:${b.id}`, title: `❌ Bet lost — ${x.h.label}`, message: `${x.info ? x.info.score : ""}${b.stake ? ` · €${Number(b.stake).toFixed(2)} stake` : ""}`,
                  click: click(x), also: fresh.map(mark) });
    return;
  }
  if (lostBefore || sent.has(`B:${b.id}`)) { silent.push(...fresh.map(mark)); return; }
  // Legs that just landed (while playing: one alert each; at full time: one summary per match).
  const liveWins = fresh.filter((x) => x.st === "won" && !(x.info && x.info.facts));
  const ftWins = fresh.filter((x) => x.st !== "lost" && x.info && x.info.facts);
  const allIn = won === total && !(b.other > 0);
  if (allIn) {
    alerts.push({ key: `B:${b.id}`, title: `🎉 BET WON — €${Number(b.ret || 0).toFixed(2)}`, message: `${betName} @ ${Number(b.odds || 0).toFixed(2)} — every leg landed.`,
                  tags: ["tada"], priority: 5, click: `${SITE}/TheHawk/`, also: fresh.map(mark) });
    return;
  }
  for (const x of liveWins)
    alerts.push({ key: mark(x), title: `✅ Leg landed — ${x.h.label}`, message: `${x.info.score} (${x.info.clock}) · ${won} of ${total} legs done`, click: click(x) });
  const byMatch = {};
  for (const x of ftWins) (byMatch[x.p.game] ||= []).push(x);
  for (const [gm, xs] of Object.entries(byMatch)) {
    const w = xs.filter((x) => x.st === "won").length, v = xs.length - w;
    alerts.push({ key: `M:${b.id}|${gm}`, title: `✅ ${xs[0].info.name}: your legs landed`, message: `${w} won${v ? `, ${v} void` : ""} · ${won} of ${total} legs done — the rest are still to play`,
                  click: click(xs[0]), also: xs.map(mark) });
  }
  // One leg to go.
  const open = Object.entries(state).filter(([, s]) => !s);
  if (open.length === 1 && !(b.other > 0) && !sent.has(`o:${b.id}`)) {
    const [k] = open[0], [, gm, legId] = k.split("|"), p = parts.find((q) => String(q.game) === gm), h = p && p.legs.find((l) => l.id === legId);
    alerts.push({ key: `o:${b.id}`, title: `🔥 One leg to go — ${h ? h.label : "last leg"}`, message: `${betName} returns €${Number(b.ret || 0).toFixed(2)} if it lands.`,
                  priority: 4, click: seen[gm] ? seen[gm].live : HAWK });
  }
}

// ---------------------------------------------------------------------------
// Full time: every leg won or lost (the same rules as the Vault — hawk-settle.js)
// ---------------------------------------------------------------------------
const countOf = (v, total = false) => {
  if (v == null || v === "") return 0;
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(String(v));
  if (m) return +(total ? m[2] : m[1]);
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};
async function matchFacts(game) {
  const st = await s365("game/stats", { games: game.id });
  if (!st) return null;
  const homeId = game.homeCompetitor.id, awayId = game.awayCompetitor.id;
  const stage = (id) => (game.stages || []).find((s) => s.id === id);
  const s90 = stage(9) || stage(1), ht = stage(7);
  const regular = (e) => e.stageId == null || e.stageId === 7 || e.stageId === 9;
  const events = (game.events || []).filter((e) => e.eventType && regular(e));
  const goals = events.filter((e) => e.eventType.id === 1).sort((a, b) => (a.order || 0) - (b.order || 0));
  const cardEvents = events.filter((e) => /card/i.test(e.eventType.name || ""));
  const team = {}, tackles = [0, 0];
  for (const s of st.statistics || []) {
    const side = s.competitorId === homeId ? 0 : s.competitorId === awayId ? 1 : -1;
    if (side >= 0) (team[s.name] ||= [null, null])[side] = countOf(s.value);
    if (side >= 0 && s.name === "Tackles Won") tackles[side] = countOf(s.value, true);
  }
  const ft90 = s90 ? [s90.homeCompetitorScore, s90.awayCompetitorScore] : [game.homeCompetitor.score, game.awayCompetitor.score];
  let twoUp = null;
  if (goals.filter((e) => e.competitorId === homeId).length === ft90[0] && goals.filter((e) => e.competitorId === awayId).length === ft90[1]) {
    twoUp = { home: false, away: false };
    let d = 0;
    for (const e of goals) { d += e.competitorId === homeId ? 1 : -1; if (d >= 2) twoUp.home = true; if (d <= -2) twoUp.away = true; }
  }
  const pair = (name) => (team[name] && team[name][0] != null && team[name][1] != null ? team[name] : null);
  const yellow = pair("Yellow Cards"), red = pair("Red Cards") || [0, 0];
  const cards = yellow ? [yellow[0] + red[0], yellow[1] + red[1]] : [homeId, awayId].map((id) => cardEvents.filter((e) => e.competitorId === id).length);
  const names = Object.fromEntries((game.members || []).map((m) => [m.id, m.name]));
  const bookedIds = new Set(cardEvents.map((e) => e.playerId));
  const players = {};
  for (const [side, key] of [["home", "homeCompetitor"], ["away", "awayCompetitor"]]) {
    players[side] = (((game[key] || {}).lineups || {}).members || []).map((m) => {
      const stats = Object.fromEntries((m.stats || []).map((s) => [s.name, s.value]));
      return { name: names[m.id] || "", minutes: countOf(stats["Minutes"]), stats, booked: bookedIds.has(m.id) };
    });
  }
  return { ft: ft90, twoUp, tackles, ht: ht ? [ht.homeCompetitorScore, ht.awayCompetitorScore] : null,
           first: goals.length ? (goals[0].competitorId === homeId ? "home" : "away") : null,
           corners: pair("Corners"), sot: pair("Shots On Target"), cards, players };
}
function findPlayer(list, name) {
  const n = normName(name);
  if (!n) return null;
  const exact = list.filter((p) => normName(p.name) === n);
  if (exact.length === 1) return exact[0];
  const parts = n.split(" "), last = parts[parts.length - 1];
  const byLast = list.filter((p) => { const q = normName(p.name).split(" "); return q[q.length - 1] === last && (parts.length === 1 || q[0][0] === parts[0][0]); });
  if (byLast.length === 1) return byLast[0];
  const within = list.filter((p) => { const q = normName(p.name); return q && (q.includes(n) || n.includes(q)); });
  return within.length === 1 ? within[0] : null;
}
function legResult(h, f) {
  const id = h.id || "", W = (c) => (c ? "won" : "lost");
  const [H, A] = f.ft, side = (s) => (s === "home" ? [H, A] : [A, H]);
  const line = (ou, value, x) => (ou === "o" ? x > value : x < value);
  let m;
  if ((m = /^p:(home|away):\d+:([a-z]+?)(\d*)$/.exec(id))) {
    const [, sd, stat, k] = m, need = +k || 1;
    const who = h.player || String(h.label || "").split(/:| to /)[0];
    const pl = findPlayer(f.players[sd] || [], who);
    if (!pl) return (f.players[sd] || []).length ? "void" : "unknown";
    if (!(pl.minutes > 0)) return "void";
    const s = pl.stats;
    const v = { shots: countOf(s["Total Shots"]), sot: countOf(s["Shots On Target"]), score: countOf(s["Goals"]),
                assist: countOf(s["Assists"]), soa: countOf(s["Goals"]) + countOf(s["Assists"]), booked: pl.booked ? 1 : 0,
                fouls: countOf(s["Fouls Made"]), fouled: countOf(s["Was Fouled"]), tackles: countOf(s["Tackles Won"], true),
                offsides: countOf(s["Offsides"]), saves: countOf(s["Goalkeeper Saves"]) }[stat];
    if (v === undefined) return "unknown";
    if (stat === "tackles" && v < need && s["Tackles Won"] == null && f.tackles) {
      const i = sd === "home" ? 0 : 1, named = (f.players[sd] || []).reduce((a, p) => a + countOf(p.stats["Tackles Won"], true), 0);
      if (f.tackles[i] > named) return "unknown";
    }
    return W(v >= need);
  }
  if ((m = /^res:(home|away)$/.exec(id)) && f.twoUp && f.twoUp[m[1]]) return "won";   // Early Payout, as the Vault settles your bets
  if ((m = /^res:(home|draw|away)$/.exec(id))) return W(m[1] === "home" ? H > A : m[1] === "away" ? A > H : H === A);
  if ((m = /^dc:(home|away)$/.exec(id))) return W(m[1] === "home" ? H >= A : A >= H);
  if ((m = /^goals:([ou])([\d.]+)$/.exec(id))) return W(line(m[1], +m[2], H + A));
  if ((m = /^btts:(yes|no)$/.exec(id))) return W((H > 0 && A > 0) === (m[1] === "yes"));
  if ((m = /^team:(home|away):o([\d.]+)$/.exec(id))) return W(side(m[1])[0] > +m[2]);
  if ((m = /^cs:(home|away)$/.exec(id))) return W(side(m[1])[1] === 0);
  if ((m = /^cs:(\d+)-(\d+)$/.exec(id))) return W(H === +m[1] && A === +m[2]);
  if ((m = /^wtn:(home|away)$/.exec(id))) { const [gf, ga] = side(m[1]); return W(gf > 0 && ga === 0); }
  if ((m = /^margin:(home|away):(\d)$/.exec(id))) { const [gf, ga] = side(m[1]); return W(+m[2] === 3 ? gf - ga >= 3 : gf - ga === +m[2]); }
  if ((m = /^ah:(home|away):([+-][\d.]+)$/.exec(id))) { const [gf, ga] = side(m[1]); return W(gf - ga + parseFloat(m[2]) > 0); }
  if ((m = /^first:(home|away)$/.exec(id))) return W(f.first === m[1]);
  if ((m = /^h([12])(res|goals):(.+)$/.exec(id))) {
    if (!f.ht) return "unknown";
    const [hh, ha] = m[1] === "1" ? f.ht : [H - f.ht[0], A - f.ht[1]];
    if (m[2] === "res") return W(m[3] === "home" ? hh > ha : m[3] === "away" ? ha > hh : hh === ha);
    const gl = /^([ou])([\d.]+)$/.exec(m[3]);
    return gl ? W(line(gl[1], +gl[2], hh + ha)) : "unknown";
  }
  const totals = { corners: f.corners, cards: f.cards, sot: f.sot };
  if ((m = /^(corners|cards|sot):([ou])([\d.]+)$/.exec(id))) { const t = totals[m[1]]; return t ? W(line(m[2], +m[3], t[0] + t[1])) : "unknown"; }
  if ((m = /^t(corners|cards):(home|away):([ou])([\d.]+)$/.exec(id))) { const t = totals[m[1]]; return t ? W(line(m[3], +m[4], t[m[2] === "home" ? 0 : 1])) : "unknown"; }
  if ((m = /^mostcorners:(home|away)$/.exec(id))) { const t = f.corners; return t ? W(m[1] === "home" ? t[0] > t[1] : t[1] > t[0]) : "unknown"; }
  return "unknown";
}
