/* HAWK engine — the browser version of the Python engine (sources.py,
 * model.py, builder.py, sim.py), so the site runs on GitHub Pages with no
 * server.
 *
 * Live, straight from the browser (these sources allow it):
 *   365Scores — fixtures, odds from 6 bookmakers, lineups, referee, table, form
 *   Polymarket — crowd prices for the match result
 * Pre-built every few hours by the GitHub Action (engine/build_data.py),
 * because StatsHub and football-data block cross-site requests:
 *   data/fixtures.json, data/profiles/<code>.json, data/players/<id>.json
 *
 * The maths mirrors the Python version; see those files for the reasoning
 * behind each constant.
 */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  // Every competition, grouped the way the site shows them, with its 365Scores
  // id. Keep in step with COMPETITIONS in engine/sources.py (which builds the
  // data files for the same list).
  const LEAGUE_GROUPS = [
    { key: "top5", name: "Top 5", icon: "👑", ids: { "Premier League": 7, "La Liga": 11, "Serie A": 17, "Bundesliga": 25, "Ligue 1": 35 } },
    { key: "europe", name: "Europe", icon: "🏆", ids: { "Champions League": 572, "Europa League": 573, "Conference League": 7685 } },
    { key: "more", name: "More Europe", icon: "🌍", ids: { "Eredivisie": 57, "Liga Portugal": 73, "Scottish Premiership": 61, "Belgian Pro League": 98,
        "Süper Lig": 78, "Greek Super League": 84, "Austrian Bundesliga": 111, "Swiss Super League": 95, "Danish Superliga": 119, "Allsvenskan": 122 } },
    { key: "second", name: "Second tier", icon: "🥈", ids: { "Championship": 1, "League One": 2, "2. Bundesliga": 26, "Serie B": 18, "LaLiga 2": 12, "Ligue 2": 36 } },
    { key: "cups", name: "Cups", icon: "🏅", ids: { "FA Cup": 8, "EFL Cup": 9, "Copa del Rey": 13, "Coppa Italia": 20, "DFB-Pokal": 28, "Coupe de France": 37 } },
    { key: "world", name: "World", icon: "🌎", ids: { "MLS": 104, "Brasileirão": 113, "Argentina Primera": 72, "Liga MX": 141, "Saudi Pro League": 649,
        "Copa Libertadores": 102 } },
    // National teams. HAWK has no ratings or player files for them — those are
    // built per club league — so an international runs on the bookmakers' prices
    // alone: result and goals markets are sound, but there are no player props
    // and the corner/card lines fall back to league-average rates. See INTL.
    { key: "intl", name: "International", icon: "🌐", ids: { "World Cup": 5930, "Euro": 6316, "Nations League": 7016,
        "World Cup Qualifiers": 5421, "Copa America": 595, "Internationals": 570 } },
  ].map((g) => ({ ...g, leagues: Object.keys(g.ids) }));
  // Competitions between national teams: no club data file will ever match them.
  const INTL = new Set(["World Cup", "Euro", "Nations League", "World Cup Qualifiers", "Copa America", "Internationals"]);
  // 365Scores writes -1 for a shirt number it doesn't know, and -1 shown on a
  // player's badge looks like a rating rather than a missing number.
  const shirt = (n) => (+n > 0 ? +n : null);
  const COMPETITIONS = Object.assign({}, ...LEAGUE_GROUPS.map((g) => g.ids));
  const LEAGUES = Object.keys(COMPETITIONS);
  const S365 = "https://webws.365scores.com/web";
  // Your device's time zone (e.g. Europe/Malta), so a "day" of scores runs midnight to midnight for you.
  const LOCAL_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London"; } catch { return "Europe/London"; } })();
  const S365_PARAMS = { appTypeId: 5, langId: 1, timezoneName: LOCAL_TZ, userCountryId: -1 };
  const ODDS_COUNTRIES = [21, 31, 37]; // each exposes a different bookmaker set
  const PM_BASE = "https://gamma-api.polymarket.com";
  const DATA_URL = new URL("../data/", document.baseURI).href;
  const PRICE_BOOK = "Bet365";

  // model.py
  const MARKET_WEIGHT = 0.7, DC_RHO = -0.10, MAX_GOALS = 10, REF_SHRINK_GAMES = 10;
  // builder.py
  const CONSENSUS_ONLY = new Set(["Betfair Exchange", "Polymarket"]);
  const CONSENSUS_WEIGHT = { "Betfair Exchange": 2.0 };
  const SNAPSHOT_WEIGHT = 0.5;
  const OPTION_TOTAL = { 14: 2.0 };
  const DEEP_MARKET_SOURCES = 5, DEEP_MARKET_WEIGHT = 0.85, MAX_LOGIT_GAP = 0.5;
  const STAT_TYPES = { 137: "corners", 141: "cards", 139: "sot" };
  // A card market settles in booking points — a yellow is 1, a red is 2 — but the
  // team data counts cards, so a red is one there. The bookmakers' own card lines
  // are already in points, so only HAWK's side of the blend needs the difference
  // added: the extra point a sending-off brings, times how often one happens
  // (about a quarter of matches across the big leagues). Without it the model
  // aims at a smaller number than the one the bet is settled on, and for matches
  // where no card line is published it is the ONLY number, so nothing corrects it.
  const RED_POINTS = 0.25;
  // sim.py
  const N_SIMS = 12000, SCAN_SIMS = 4000, PRIOR_MINUTES = 450, REST_SHARE = 0.05, XG_WEIGHT = 0.6;
  const START_PROB = { true: { Starting: 1.0, Substitute: 0.0 }, false: { Starting: 1.0, Substitute: 0.08 } };
  const SUB_APPEAR_PROB = 0.35, SUB_MINUTES = 22, DOUBTFUL_START = 0.45;
  const START_MINUTES = { F: 78, M: 82, D: 88, G: 90 }, PRIOR_STARTS = 4;
  const POSITIONS = { Goalkeeper: "G", Defender: "D", Midfielder: "M", Attacker: "F" };
  const DEFAULT_RATES = { F: [2.6, 1.0, 0.40, 0.15], M: [1.2, 0.40, 0.12, 0.20], D: [0.6, 0.18, 0.05, 0.20], G: [0, 0, 0, 0.05] };
  const STYLES = { Banker: [0.72, 0.95], Balanced: [0.55, 0.90], Punchy: [0.35, 0.78] };
  // "Stats" is Match without the result market. Result and double chance are
  // short and likely, so they win the leg scoring every time — 49 builds out of
  // 49 had one, even with "start with the favourite" turned off. That makes
  // every ticket the same shape: a favourite, then an under. Stats bans the
  // group outright so goals, cards, corners and shots have to carry the ticket.
  const FOCUS = { Mix: [2, 4], Players: [4, 2], Match: [0, 99], Stats: [0, 99] };
  const NO_RESULT = new Set(["Stats"]);
  const MAX_LEGS_PER_PLAYER = 3, MIN_LEG_P = 0.04, MAX_LEG_P = 0.97, MIN_AUTO_MINUTES = 270;
  const MATCH_TTL = 10 * 60 * 1000;
  // Extra player stats, per 90 (position averages until the data says
  // otherwise). Assists are shared out from the simulated goals; the others
  // are counted per player. Saves come from the opponent's shots on target.
  const ASSIST_SHARE = 0.72; // share of goals with an assist (top leagues ~70–75%)
  const EXTRA_STATS = ["assists", "fouls", "fouled", "tackles", "offsides"];
  const EXTRA_DEFAULTS = {
    F: { assists: 0.14, fouls: 1.2, fouled: 1.3, tackles: 0.6, offsides: 0.55 },
    M: { assists: 0.14, fouls: 1.1, fouled: 1.2, tackles: 1.6, offsides: 0.15 },
    D: { assists: 0.07, fouls: 1.0, fouled: 0.7, tackles: 1.8, offsides: 0.05 },
    G: { assists: 0.005, fouls: 0.05, fouled: 0.3, tackles: 0.02, offsides: 0 },
  };
  // Legs the auto-builder leaves out unless asked: counted per player with no
  // link to the opponent or the referee, so they're the least certain.
  const EXTRA_MARKETS = new Set(["Player Fouls Committed", "Player Fouls Won", "Player Tackles", "Player Offsides"]);
  // Simulated matches kept in memory: each holds ~12 MB of legs, so a phone keeps
  // fewer — eight of them was enough to crash the tab on a phone browser.
  const MATCHES_KEPT = typeof matchMedia === "function" && matchMedia("(max-width:820px)").matches ? 3 : 6;

  // ---------------------------------------------------------------------------
  // HTTP with retries and a small cache
  // ---------------------------------------------------------------------------
  const cache = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getJSON(url, ttlMs = 0) {
    const hit = ttlMs && cache.get(url);
    if (hit && Date.now() - hit.t < ttlMs) return hit.v;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000 * (attempt + 1));
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (r.status === 429 || r.status >= 500) { await sleep(800 * (attempt + 1)); continue; }
        if (!r.ok) return null;
        const v = await r.json();
        if (ttlMs) cache.set(url, { t: Date.now(), v });
        return v;
      } catch (e) {
        // Network errors include throttled replies that arrive without CORS
        // headers (seen from 365Scores during fast scans): back off, then retry.
        if (attempt === 2) { console.warn("[hawk] request failed:", url, e.message); return null; }
        await sleep(700 * (attempt + 1));
      } finally { clearTimeout(timer); }
    }
    return null;
  }
  const s365 = (path, params, ttlMs = 0) =>
    getJSON(`${S365}/${path}/?${new URLSearchParams({ ...S365_PARAMS, ...params })}`, ttlMs);
  const data = (path) => getJSON(DATA_URL + path, 30 * 60 * 1000);

  // ---------------------------------------------------------------------------
  // Name matching (sources.py)
  // ---------------------------------------------------------------------------
  const STOPWORDS = new Set(["fc", "afc", "cf", "sc", "ac", "as", "ss", "ssc", "club", "cd", "ud", "rc", "sd", "sv", "vfb",
    "vfl", "tsg", "the", "de", "calcio", "and", "hove", "albion", "1"]);
  const ALIASES = {  // same list as sources.py
    "man united": "manchester united", "man utd": "manchester united", "man city": "manchester city",
    "nottm forest": "nottingham forest", "spurs": "tottenham", "tottenham hotspur": "tottenham",
    "wolves": "wolverhampton", "wolverhampton wanderers": "wolverhampton",
    "sheffield weds": "sheffield wednesday", "qpr": "queens park rangers",
    "ath madrid": "atletico madrid", "atletico de madrid": "atletico madrid",
    "ath bilbao": "athletic bilbao", "athletic": "athletic bilbao",
    "espanol": "espanyol", "la coruna": "deportivo la coruna", "deportivo": "deportivo la coruna",
    "mgladbach": "monchengladbach", "borussia monchengladbach": "monchengladbach", "gladbach": "monchengladbach",
    "borussia mgladbach": "monchengladbach", "stade rennais": "rennes",
    "ein frankfurt": "eintracht frankfurt", "koln": "koln", "cologne": "koln",
    "bayern munchen": "bayern munich", "bayern": "bayern munich",
    "paris sg": "paris saint germain", "psg": "paris saint germain",
    "inter milan": "inter", "internazionale": "inter",
  };
  const SPECIAL_LETTERS = { "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss", "đ": "d", "Đ": "D", "ł": "l", "Ł": "L",
                            "ı": "i", "œ": "oe", "Œ": "OE", "þ": "th" };
  function norm(name) {
    // ø, æ, ß... don't break down into base letter + accent, so map them first ("Højlund" -> "hojlund").
    let s = String(name || "").replace(/[øØæÆßđĐłŁıœŒþ]/g, (c) => SPECIAL_LETTERS[c])
      .normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    s = s.replace(/&/g, " and ").replace(/['.]/g, "").replace(/[^a-z0-9 ]+/g, " ");
    s = s.split(/\s+/).filter((t) => t && !STOPWORDS.has(t)).join(" ");
    return ALIASES[s] || s;
  }
  function bigramRatio(a, b) {  // stand-in for difflib's ratio
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const ga = grams(a), gb = grams(b);
    let shared = 0;
    for (const [g, n] of ga) shared += Math.min(n, gb.get(g) || 0);
    return (2 * shared) / (a.length + b.length - 2);
  }
  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function nameSimilarity(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (new RegExp(`\\b${reEscape(na)}\\b`).test(nb) || new RegExp(`\\b${reEscape(nb)}\\b`).test(na)) return 0.9;
    const ta = na.split(" ").filter((t) => t.length >= 3), tb = nb.split(" ").filter((t) => t.length >= 3);
    let token = 0;
    if (ta.length && tb.length) {
      const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
      const hits = short.filter((s) => long.some((l) => s.startsWith(l) || l.startsWith(s))).length;
      token = hits === short.length ? 0.85 : (0.5 * hits) / short.length;
    }
    return Math.max(token, 0.8 * bigramRatio(na, nb));
  }
  function bestMatch(name, candidates, threshold = 0.7) {
    const scored = candidates.map((c) => [nameSimilarity(name, c), c]).sort((x, y) => y[0] - x[0]);
    if (!scored.length || scored[0][0] < threshold) return null;
    if (scored.length > 1 && scored[1][0] === scored[0][0] && scored[1][1] !== scored[0][1]) return null;
    return scored[0][1];
  }

  // ---------------------------------------------------------------------------
  // Live sources: 365Scores and Polymarket
  // ---------------------------------------------------------------------------
  const crest = (c) => `https://imagecache.365scores.com/image/upload/f_png,w_64,h_64,c_limit,q_auto:eco,dpr_2,d_Competitors:default1.png/v${c.imageVersion || 1}/Competitors/${c.id}`;
  const athletePhoto = (m) => `https://imagecache.365scores.com/image/upload/f_png,w_64,h_64,c_limit,q_auto:eco,dpr_2,d_Athletes:default.png/v${m.imageVersion || 1}/Athletes/${m.athleteId}`;

  const rawFixtures = new Map(); // game id -> {league, game}
  const CUPS = new Set(LEAGUE_GROUPS.find((g) => g.key === "cups").leagues);
  const DATA_DAYS = 8;   // build_data.py's DAYS_AHEAD
  async function fixtures(league) {
    const d = await s365("games/fixtures", { competitions: COMPETITIONS[league] }, 5 * 60 * 1000);
    if (!d) throw new Error("365Scores didn't return fixtures — try again in a moment");
    const now = Date.now();
    // Domestic cups: only ties HAWK's data files kept (at least one league
    // club — early qualifying rounds between amateur clubs have no data or
    // bet builders), plus ties too far ahead to be in the files yet.
    const kept = CUPS.has(league) ? ((await data("fixtures.json")) || {}).fixtures : null;
    const keep = (g) => !kept || kept[String(g.id)] || !g.startTime || Date.parse(g.startTime) - now > DATA_DAYS * 86400e3;
    return (d.games || []).filter((g) => g.statusGroup !== 4 && keep(g))
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""))
      .map((g) => {
        rawFixtures.set(String(g.id), { league, game: g });
        const ko = g.startTime ? new Date(g.startTime) : null;
        return { id: g.id, home: g.homeCompetitor.name, away: g.awayCompetitor.name, homeCrest: crest(g.homeCompetitor),
                 awayCrest: crest(g.awayCompetitor), kickoff: g.startTime, started: !!(ko && ko.getTime() < now) };
      });
  }

  async function odds365(gameId) {
    const batches = await Promise.all(ODDS_COUNTRIES.map((c) => s365("bets/lines", { userCountryId: c, games: gameId })));
    const quotes = [];
    for (const d of batches) {
      if (!d) continue;
      const names = Object.fromEntries((d.bookmakers || []).map((b) => [b.id, b.name]));
      for (const line of d.lines || []) {
        const prices = {}, opens = {};   // opens = the bookmaker's opening price for each option
        for (const o of line.options || []) {
          const price = o.rate && o.rate.decimal, open = o.originalRate && o.originalRate.decimal;
          if (o.name && price > 1) prices[String(o.name)] = +price;
          if (o.name && open > 1) opens[String(o.name)] = +open;
        }
        if (Object.keys(prices).length) quotes.push({
          book: names[line.bookmakerId] || `Book ${line.bookmakerId}`, type: line.lineTypeId,
          market: (line.lineType || {}).name || "", value: String(line.internalOptionValue || ""), prices, opens, source: "365Scores" });
      }
    }
    return dedupeQuotes(quotes);
  }
  function dedupeQuotes(quotes) {
    const seen = new Set();
    return quotes.filter((q) => { const k = `${q.book}|${q.type}|${q.value}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  async function standings(league) {
    const d = await s365("standings", { competitions: COMPETITIONS[league] }, 10 * 60 * 1000);
    const rows = {};
    for (const t of (d && d.standings) || []) for (const r of t.rows || []) if (r.competitor) rows[r.competitor.id] = r;
    return rows;
  }
  // Full league tables (365Scores), for the live table view: every table of the
  // competition (groups too), where each place leads (Champions League,
  // relegation…), and each club's next match — so a game being played right now
  // can be added to the table as it stands.
  async function tables(league) {
    const d = await s365("standings", { competitions: COMPETITIONS[league] }, 60 * 1000);
    if (!d) throw new Error("365Scores didn't return the table — try again in a moment");
    return (d.standings || []).filter((t) => (t.rows || []).length).map((t) => ({
      name: t.displayName || null,
      dest: Object.fromEntries((t.destinations || []).map((x) => [x.num, { name: x.name, color: x.color }])),
      rows: t.rows.filter((r) => r.competitor).map((r) => ({
        id: String(r.competitor.id), name: r.competitor.name, crest: crest(r.competitor), pos: r.position,
        p: r.gamePlayed || 0, w: r.gamesWon || 0, d: r.gamesEven || 0, l: r.gamesLost || 0, gf: r.for || 0, ga: r.against || 0,
        pts: Math.round(r.points || 0), dest: r.destinationNum || null, next: r.nextMatch ? String(r.nextMatch.id) : null })) }));
  }
  async function form(competitorId, games = 6) {
    const d = await s365("games/results", { competitors: competitorId }, 30 * 60 * 1000);
    if (!d) return null;
    const out = [];
    for (const g of (d.games || []).slice().sort((a, b) => (b.startTime || "").localeCompare(a.startTime || ""))) {
      const status = (g.statusText || "").toLowerCase();
      if (g.statusGroup !== 4 || /cancel|postpon|abandon/.test(status)) continue;
      if ((g.competitionDisplayName || "").toLowerCase().includes("friendl")) continue;
      const hs = Math.trunc(g.homeCompetitor.score), as = Math.trunc(g.awayCompetitor.score);
      if (!(hs >= 0 && as >= 0)) continue;
      const [mine, theirs] = g.homeCompetitor.id === competitorId ? [hs, as] : [as, hs];
      out.push(mine > theirs ? "W" : mine < theirs ? "L" : "D");
      if (out.length === games) break;
    }
    return out.join("") || null;
  }
  // Form for the upset radar: competitive games in the last 60 days only (in
  // August, last season's results aren't form). Same cached request as form().
  async function recentForm(competitorId, days = 60) {
    const d = await s365("games/results", { competitors: competitorId }, 30 * 60 * 1000);
    if (!d) return null;
    const since = Date.now() - days * 86400e3, out = [];
    for (const g of (d.games || []).slice().sort((a, b) => (b.startTime || "").localeCompare(a.startTime || ""))) {
      if (g.statusGroup !== 4 || /cancel|postpon|abandon/i.test(g.statusText || "") || /friendl/i.test(g.competitionDisplayName || "")) continue;
      if (Date.parse(g.startTime) < since) break;
      const hs = Math.trunc(g.homeCompetitor.score), as = Math.trunc(g.awayCompetitor.score);
      if (!(hs >= 0 && as >= 0)) continue;
      const [mine, theirs] = g.homeCompetitor.id === competitorId ? [hs, as] : [as, hs];
      out.push(mine > theirs ? "W" : mine < theirs ? "L" : "D");
      if (out.length === 6) break;
    }
    return out.join("");
  }
  // ---------------------------------------------------------------------------
  // Second lineup source: ESPN's public API, readable from the page like
  // 365Scores. It publishes the official XIs (about an hour before kick-off)
  // for every competition HAWK covers. Used when 365Scores hasn't confirmed a
  // lineup yet, and to double-check it when both have.
  // ---------------------------------------------------------------------------
  const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer";
  const ESPN_SLUGS = { "Premier League": "eng.1", "La Liga": "esp.1", "Serie A": "ita.1", "Bundesliga": "ger.1", "Ligue 1": "fra.1",
    "Champions League": "uefa.champions", "Europa League": "uefa.europa", "Conference League": "uefa.europa.conf",
    "Eredivisie": "ned.1", "Liga Portugal": "por.1", "Scottish Premiership": "sco.1", "Belgian Pro League": "bel.1", "Süper Lig": "tur.1",
    "Greek Super League": "gre.1", "Austrian Bundesliga": "aut.1", "Swiss Super League": "sui.1", "Danish Superliga": "den.1", "Allsvenskan": "swe.1",
    "Championship": "eng.2", "League One": "eng.3", "2. Bundesliga": "ger.2", "Serie B": "ita.2", "LaLiga 2": "esp.2", "Ligue 2": "fra.2",
    "FA Cup": "eng.fa", "EFL Cup": "eng.league_cup", "Copa del Rey": "esp.copa_del_rey", "Coppa Italia": "ita.coppa_italia",
    "DFB-Pokal": "ger.dfb_pokal", "Coupe de France": "fra.coupe_de_france",
    "MLS": "usa.1", "Brasileirão": "bra.1", "Argentina Primera": "arg.1", "Liga MX": "mex.1", "Saudi Pro League": "ksa.1",
    "Copa Libertadores": "conmebol.libertadores" };
  const espnCache = new Map();
  async function espnJSON(url, ttl) {
    const hit = espnCache.get(url);
    if (hit && Date.now() - hit.t < ttl) return hit.v;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url);
        if (r.ok) { const v = await r.json(); espnCache.set(url, { t: Date.now(), v }); return v; }
        if (r.status < 500) return null;
      } catch { /* network hiccup: try once more */ }
      await sleep(600);
    }
    return null;
  }
  const ymdUTC = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
  const espnPos = (abbr) => {
    const a = String(abbr || "").toUpperCase();
    if (a === "G" || a === "GK") return "G";
    if (/^(CD|CB|LB|RB|D|LWB|RWB|SW)/.test(a)) return "D";
    if (/^(CM|LM|RM|DM|AM|M|CDM|CAM)/.test(a)) return "M";
    return "F";
  };
  // {confirmed, home: {formation, starters, subs}, away: …} or null (not on ESPN).
  async function espnLineups(league, home, away, kickoff) {
    const slug = ESPN_SLUGS[league];
    if (!slug || !kickoff) return null;
    const t = kickoff.getTime();
    for (const day of new Set([ymdUTC(t), ymdUTC(t - 86400e3), ymdUTC(t + 86400e3)])) {
      const sb = await espnJSON(`${ESPN}/${slug}/scoreboard?dates=${day}`, 10 * 60e3);
      const ev = ((sb && sb.events) || []).find((e) => {
        const cs = ((e.competitions || [])[0] || {}).competitors || [];
        const h = cs.find((c) => c.homeAway === "home"), a = cs.find((c) => c.homeAway === "away");
        return h && a && Math.abs(Date.parse(e.date) - t) < 6 * 3600e3
          && nameSimilarity(home, h.team.displayName) >= 0.6 && nameSimilarity(away, a.team.displayName) >= 0.6;
      });
      if (!ev) continue;
      const s = await espnJSON(`${ESPN}/${slug}/summary?event=${ev.id}`, 90e3);
      const out = { id: ev.id };
      for (const r of (s && s.rosters) || []) {
        const nm = (r.team || {}).displayName || "";
        const side = r.homeAway === "home" || r.homeAway === "away" ? r.homeAway : nameSimilarity(home, nm) >= nameSimilarity(away, nm) ? "home" : "away";
        const players = (r.roster || []).map((p) => { const a = p.athlete || {};
          return { name: a.displayName || "?", num: shirt(p.jersey), pos: espnPos((p.position || {}).abbreviation), starter: !!p.starter,
                   photo: (a.headshot && a.headshot.href) || (a.id ? `https://a.espncdn.com/i/headshots/soccer/players/full/${a.id}.png` : null) }; });
        out[side] = { formation: r.formation || null, starters: players.filter((p) => p.starter), subs: players.filter((p) => !p.starter) };
      }
      out.confirmed = ["home", "away"].every((sd) => out[sd] && out[sd].starters.length >= 11);
      return out;
    }
    return null;
  }
  // Same player in both sources? ("Carl Rushworth" / "C. Rushworth" / accents.)
  const lastName = (n) => norm(n).split(" ").filter(Boolean).pop() || "";
  const samePlayer = (a, b) => nameSimilarity(a, b) >= 0.75 || (lastName(a).length > 2 && lastName(a) === lastName(b));

  // Unibet's player-prop prices (Kambi's public odds feed, the one Unibet's
  // own site reads): to score, assist, score or assist, and shots on target —
  // the big leagues mostly; smaller ones often only have scorers. A real
  // bookmaker's price for the leg, used where Bet365's isn't available.
  const KAMBI = "https://eu-offering-api.kambicdn.com/offering/v2018/ub", KAMBI_Q = "lang=en_GB&market=GB", REF_BOOK = "Unibet";
  const KAMBI_PATH = {
    "Premier League": "england", "Championship": "england", "League One": "england", "FA Cup": "england", "EFL Cup": "england",
    "La Liga": "spain", "LaLiga 2": "spain", "Copa del Rey": "spain", "Serie A": "italy", "Serie B": "italy", "Coppa Italia": "italy",
    "Bundesliga": "germany", "2. Bundesliga": "germany", "DFB-Pokal": "germany", "Ligue 1": "france", "Ligue 2": "france", "Coupe de France": "france",
    "Champions League": "champions_league", "Europa League": "europa_league", "Conference League": "conference_league",
    "Eredivisie": "netherlands", "Liga Portugal": "portugal", "Scottish Premiership": "scotland", "Belgian Pro League": "belgium",
    "Süper Lig": "turkey", "Greek Super League": "greece", "Austrian Bundesliga": "austria", "Swiss Super League": "switzerland",
    "Danish Superliga": "denmark", "Allsvenskan": "sweden", "MLS": "usa", "Brasileirão": "brazil", "Argentina Primera": "argentina",
    "Liga MX": "mexico", "Saudi Pro League": "saudi_arabia", "Copa Libertadores": "copa_libertadores",
  };
  const KAMBI_STAT = [[/^To Score$/i, "score"], [/^To give an assist/i, "assist"], [/^To score or give an assist/i, "soa"], [/^Player's shots on target/i, "sot"]];
  // {event, rows: [{player, key ("score", "sot1", …), price}]} or null.
  async function kambiEvent(league, home, away, kickoff) {
    const path = KAMBI_PATH[league];
    if (!path || !kickoff) return null;
    const list = await getJSON(`${KAMBI}/listView/football/${path}.json?${KAMBI_Q}`, 10 * 60e3);
    let ev = null, best = 0;
    // Not the club's U21 / reserves / women's side playing the same evening.
    const youth = /\b(u\d{2}|reserves|women|ladies)\b|\(w\)/i, grown = !youth.test(`${home} ${away}`);
    for (const e of (list && list.events) || []) {
      const x = e.event || {};
      if (Math.abs(Date.parse(x.start) - kickoff.getTime()) > 3 * 3600e3) continue;
      if (grown && youth.test(`${x.homeName || ""} ${x.awayName || ""} ${x.group || ""}`)) continue;
      const s = nameSimilarity(home, x.homeName || "") + nameSimilarity(away, x.awayName || "");
      if (s > best) { best = s; ev = x; }
    }
    return ev && best >= 1.2 ? ev : null;
  }
  // In play: Unibet's "Next Goal" (home / no more goals / away) and "Next Goal
  // Scorer" prices, with the bookmaker's margin taken out so they read as chances.
  async function kambiNextGoal(league, home, away, kickoff) {
    const ev = await kambiEvent(league, home, away, kickoff);
    if (!ev) return null;
    const j = await getJSON(`${KAMBI}/betoffer/event/${ev.id}.json?${KAMBI_Q}`, 20 * 1000);
    const offers = (j && j.betOffers) || [], open = (o) => (o.outcomes || []).filter((x) => x.status === "OPEN" && x.odds > 1000);
    const fair = (outs) => { const inv = outs.map((x) => 1000 / x.odds), s = inv.reduce((a, b) => a + b, 0); return inv.map((v) => v / s); };
    const ng = offers.find((o) => /^Next Goal \(\d+\)/i.test((o.criterion || {}).englishLabel || (o.criterion || {}).label || ""));
    const sc = offers.find((o) => /^Next Goal Scorer/i.test((o.criterion || {}).englishLabel || (o.criterion || {}).label || ""));
    let team = null, scorers = [];
    if (ng && open(ng).length === 3) {
      const outs = open(ng), p = fair(outs), by = Object.fromEntries(outs.map((x, i) => [x.label, p[i]]));
      if (by["1"] != null && by.X != null && by["2"] != null) team = { home: by["1"], none: by.X, away: by["2"] };
    }
    if (sc && open(sc).length > 2) {
      const outs = open(sc), p = fair(outs);
      scorers = outs.map((x, i) => ({ player: x.participant || x.label, p: p[i], none: /no goal/i.test(x.label) }))
        .filter((x) => !x.none).sort((a, b) => b.p - a.p).slice(0, 5);
    }
    return team || scorers.length ? { book: REF_BOOK, team, scorers } : null;
  }
  // Live scores straight from Unibet's feed for the matches you follow: a 1 KB
  // file per match that changes within seconds of a goal (a bookmaker has to
  // stop betting at once) — usually well before the score apps.
  const kambiIds = new Map();   // 365Scores game id -> Unibet event id (or null)
  async function kambiEventId(game) {
    const k = String(game.id);
    if (!kambiIds.has(k)) {
      const ev = await kambiEvent(game.league, game.home, game.away, game.kickoff ? new Date(game.kickoff) : null).catch(() => null);
      kambiIds.set(k, ev ? ev.id : null);
    }
    return kambiIds.get(k);
  }
  async function kambiLive(games) {
    const pairs = [];
    for (const g of games) { const id = await kambiEventId(g); if (id) pairs.push([String(g.id), id]); }
    if (!pairs.length) return {};
    const j = await getJSON(`${KAMBI}/event/livedata/${pairs.map(([, id]) => id).join(",")}.json?${KAMBI_Q}`);
    const by = Object.fromEntries(((j && j.liveData) || []).map((x) => [x.eventId, x]));
    const out = {};
    for (const [gid, id] of pairs) {
      const x = by[id], st = x && x.statistics && x.statistics.football;
      if (x && x.score) out[gid] = { score: [+x.score.home || 0, +x.score.away || 0], minute: x.matchClock ? x.matchClock.minute : null,
                                      reds: st ? [(st.home || {}).redCards || 0, (st.away || {}).redCards || 0] : null };
    }
    return out;
  }
  async function kambiProps(league, home, away, kickoff) {
    const ev = await kambiEvent(league, home, away, kickoff);
    if (!ev) return null;
    const j = await getJSON(`${KAMBI}/betoffer/event/${ev.id}.json?${KAMBI_Q}`, 5 * 60e3);
    const rows = [];
    for (const o of (j && j.betOffers) || []) {
      const label = (o.criterion || {}).englishLabel || (o.criterion || {}).label || "";
      const stat = (KAMBI_STAT.find(([re]) => re.test(label)) || [])[1];
      if (!stat) continue;
      for (const x of o.outcomes || []) {
        if (x.status !== "OPEN" || !x.participant || !(x.odds > 1000)) continue;
        if (stat === "sot") { if (x.type === "OT_OVER") rows.push({ player: x.participant, key: `sot${Math.floor(x.line / 1000) + 1}`, price: x.odds / 1000 }); }
        else if (x.type === "OT_YES") rows.push({ player: x.participant, key: stat, price: x.odds / 1000 });
      }
    }
    return { event: ev.name, rows };
  }

  async function polymarket(slug, home, away) {
    const events = await getJSON(`${PM_BASE}/events?slug=${encodeURIComponent(slug)}`, 2 * 60 * 1000);
    const ev = events && events[0];
    if (!ev) return null;
    const probs = {};
    let liquidity = 0;
    for (const mk of ev.markets || []) {
      let price = null;
      const bid = parseFloat(mk.bestBid), ask = parseFloat(mk.bestAsk);
      if (bid > 0 && ask >= bid && ask < 1) price = (bid + ask) / 2;
      else { try { price = parseFloat(JSON.parse(mk.outcomePrices || "[]")[0]); } catch { price = null; } }
      if (!(price > 0)) continue;
      liquidity += parseFloat(mk.liquidity) || 0;
      const title = mk.groupItemTitle || "";
      if ((mk.question || "").toLowerCase().includes("draw")) probs.draw = price;
      else if (nameSimilarity(home, title) >= nameSimilarity(away, title)) probs.home = price;
      else probs.away = price;
    }
    if (!("home" in probs && "draw" in probs && "away" in probs)) return null;
    const total = probs.home + probs.draw + probs.away;
    return { home: probs.home / total, draw: probs.draw / total, away: probs.away / total, liquidity, title: ev.title };
  }

  // ---------------------------------------------------------------------------
  // Model (model.py)
  // ---------------------------------------------------------------------------
  const LOGFACT = [0];
  for (let k = 1; k < 200; k++) LOGFACT[k] = LOGFACT[k - 1] + Math.log(k);
  const pmf = (lam, k) => Math.exp(-lam + k * Math.log(lam) - LOGFACT[k]);
  const pmfRow = (lam) => Array.from({ length: MAX_GOALS + 1 }, (_, k) => pmf(lam, k));

  function scoreMatrix(lh, la) {
    const ph = pmfRow(lh), pa = pmfRow(la);
    const M = ph.map((x) => pa.map((y) => x * y));
    M[0][0] *= 1 - lh * la * DC_RHO; M[0][1] *= 1 + lh * DC_RHO; M[1][0] *= 1 + la * DC_RHO; M[1][1] *= 1 - DC_RHO;
    let s = 0; for (const row of M) for (const v of row) s += v;
    return M.map((row) => row.map((v) => v / s));
  }
  const sumCells = (M, test) => { let s = 0; for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) if (test(i, j)) s += M[i][j]; return s; };

  // P(home win, draw, away win, over each line) for one (lh, la), Dixon-Coles adjusted.
  function outcomeProbs(ph, pa, lh, la, lines) {
    let home = 0, draw = 0, away = 0;
    const over = lines.map(() => 0);
    for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) {
      const p = ph[i] * pa[j];
      if (i > j) home += p; else if (i === j) draw += p; else away += p;
      for (let k = 0; k < lines.length; k++) if (i + j > lines[k]) over[k] += p;
    }
    const d00 = ph[0] * pa[0] * (-lh * la * DC_RHO), d01 = ph[0] * pa[1] * (lh * DC_RHO);
    const d10 = ph[1] * pa[0] * (la * DC_RHO), d11 = ph[1] * pa[1] * (-DC_RHO);
    draw += d00 + d11; away += d01; home += d10;
    for (let k = 0; k < lines.length; k++) {
      if (0 > lines[k]) over[k] += d00;
      if (1 > lines[k]) over[k] += d01 + d10;
      if (2 > lines[k]) over[k] += d11;
    }
    return { home, draw, away, over };
  }
  function fitGoalLambdas(p1x2, totals) {
    if (!p1x2 && !totals.length) return null;
    const lines = totals.map((t) => t[0]);
    const rows = new Map();
    const row = (lam) => { const k = lam.toFixed(4); if (!rows.has(k)) rows.set(k, pmfRow(lam)); return rows.get(k); };
    const solve = (gh, ga) => {
      let best = null, bestLoss = Infinity;
      for (const lh of gh) for (const la of ga) {
        const o = outcomeProbs(row(lh), row(la), lh, la, lines);
        let loss = 0;
        if (p1x2) loss += (o.home - p1x2[0]) ** 2 + (o.draw - p1x2[1]) ** 2 + (o.away - p1x2[2]) ** 2;
        totals.forEach(([, pOver], k) => { loss += (o.over[k] - pOver) ** 2; });
        if (loss < bestLoss) { bestLoss = loss; best = [lh, la]; }
      }
      return best;
    };
    const range = (a, b, step) => { const out = []; for (let x = a; x <= b + 1e-9; x += step) out.push(+x.toFixed(4)); return out; };
    const [lh, la] = solve(range(0.1, 4.0, 0.05), range(0.1, 4.0, 0.05));
    return solve(range(Math.max(0.02, lh - 0.06), lh + 0.06, 0.005), range(Math.max(0.02, la - 0.06), la + 0.06, 0.005));
  }
  const poissonOver = (lam, line) => { let c = 0; for (let k = 0; k <= Math.floor(line); k++) c += pmf(lam, k); return 1 - c; };
  function fitTotalLambda(lines) {
    if (!lines.length) return null;
    const solve = (a, b, step) => {
      let best = null, bestLoss = Infinity;
      for (let lam = a; lam <= b + 1e-9; lam += step) {
        let loss = 0;
        for (const [line, pOver] of lines) loss += (poissonOver(lam, line) - pOver) ** 2;
        if (loss < bestLoss) { bestLoss = loss; best = lam; }
      }
      return best;
    };
    const lam = solve(0.2, 40, 0.05);
    return solve(Math.max(0.05, lam - 0.06), lam + 0.06, 0.005);
  }
  const blend = (model, market, w = MARKET_WEIGHT) => (model == null ? market : market == null ? model : w * market + (1 - w) * model);

  function expectedPair(profH, h, profA, a, stat) {
    try {
      const th = profH.teams[h][stat], ta = profA.teams[a][stat];
      const avgH = (profH.avg[stat][0] + profA.avg[stat][0]) / 2, avgA = (profH.avg[stat][1] + profA.avg[stat][1]) / 2;
      if (!th || !ta) return null;
      return [avgH * th.att * ta.def, avgA * ta.att * th.def];
    } catch { return null; }
  }
  function refereeFactor(avg, games, leagueAvg) {
    if (!avg || !games || !leagueAvg) return 1;
    return ((games * avg + REF_SHRINK_GAMES * leagueAvg) / (games + REF_SHRINK_GAMES)) / leagueAvg;
  }
  function refereeFromProfile(name, profile) {
    if (!name || !profile) return null;
    const parts = name.split(/\s+/);
    for (const [ref, [cards, games]] of Object.entries(profile.referees || {})) {
      const rp = ref.split(/\s+/);
      if (rp.length && rp[rp.length - 1].toLowerCase() === parts[parts.length - 1].toLowerCase() && rp[0][0].toLowerCase() === parts[0][0].toLowerCase())
        return [cards / games, games];
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Market consensus and trust (builder.py)
  // ---------------------------------------------------------------------------
  function consensus(quotes) {
    const groups = {};
    for (const q of quotes) {
      const opts = Object.entries(q.prices);
      if (opts.length < 2) continue;
      const inv = opts.map(([o, p]) => [o, 1 / p]);
      const overround = inv.reduce((s, [, x]) => s + x, 0) / (OPTION_TOTAL[q.type] || 1);
      if (overround < 0.98) continue;
      const w = (CONSENSUS_WEIGHT[q.book] || 1) * (q.source === "football-data" ? SNAPSHOT_WEIGHT : 1);
      const g = (groups[`${q.type}|${q.value}`] ||= { w: 0, probs: {}, books: new Set() });
      g.w += w; g.books.add(q.book);
      for (const [o, x] of inv) g.probs[o] = (g.probs[o] || 0) + (w * x) / overround;
    }
    const out = {};
    for (const [k, g] of Object.entries(groups))
      out[k] = { probs: Object.fromEntries(Object.entries(g.probs).map(([o, v]) => [o, v / g.w])), books: g.books.size };
    return out;
  }
  const logit = (p) => { p = Math.min(Math.max(p, 1e-4), 1 - 1e-4); return Math.log(p / (1 - p)); };
  function marketTrust(pModel, pMarket, sources) {
    if (sources < DEEP_MARKET_SOURCES) return [MARKET_WEIGHT, false];
    if (pModel != null && pMarket != null && Math.abs(logit(pModel) - logit(pMarket)) > MAX_LOGIT_GAP) return [1, true];
    return [DEEP_MARKET_WEIGHT, false];
  }
  const halfLine = (v) => { const x = parseFloat(v); return Number.isFinite(x) && x !== Math.trunc(x) ? x : null; };

  // ---------------------------------------------------------------------------
  // Analysis of one fixture (builder.analyse)
  // ---------------------------------------------------------------------------
  async function analyse(league, game) {
    const id = String(game.id), hc = game.homeCompetitor, ac = game.awayCompetitor;
    const home = hc.name, away = ac.name, kickoff = game.startTime ? new Date(game.startTime) : null;
    let meta = ((await data("fixtures.json")) || { fixtures: {} }).fixtures[id] || null;
    // Not in the copy this page has? A match in the next week should be in the files, so that
    // copy is old or didn't load properly (a phone that was offline, a slow connection): fetch them fresh.
    if (!meta && kickoff && kickoff.getTime() - Date.now() < 7 * 86400e3) {
      const fresh = await getJSON(`${DATA_URL}fixtures.json?t=${Date.now()}`);
      if (fresh && fresh.fixtures) { cache.set(DATA_URL + "fixtures.json", { t: Date.now(), v: fresh }); meta = fresh.fixtures[id] || null; }
    }
    const fd = (meta && meta.fd) || {};
    const [quotes365, detailResp, table, formH, formA, pm, profH, profA, playersH, playersA, recentH, recentA, espn] = await Promise.all([
      odds365(id), s365("game", { gameId: id }), standings(league), form(hc.id), form(ac.id),
      meta && meta.pm_slug ? polymarket(meta.pm_slug, home, away) : null,
      fd.home ? data(`profiles/${fd.home[0]}.json`) : null, fd.away ? data(`profiles/${fd.away[0]}.json`) : null,
      meta && meta.sh ? data(`players/${meta.sh[0]}.json`) : null, meta && meta.sh ? data(`players/${meta.sh[1]}.json`) : null,
      recentForm(hc.id), recentForm(ac.id),
      // ESPN's lineups only matter close to kick-off (they're published about an hour before).
      kickoff && kickoff.getTime() - Date.now() < 4 * 3600e3 ? espnLineups(league, home, away, kickoff).catch(() => null) : null,
    ]);
    const detail = (detailResp && detailResp.game) || {};
    const fdH = fd.home && fd.home[1], fdA = fd.away && fd.away[1];
    const warnings = [];
    if (!meta) warnings.push("This fixture isn't in HAWK's data files yet (they refresh every few hours) — using bookmaker prices only, no player legs.");
    // A source that was down leaves last-good files behind: say how old they are.
    const builtAt = (files, hours) => files.map((f) => f && f.built && Date.parse(f.built)).filter((t) => t && Date.now() - t > hours * 3600e3);
    const when = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const oldPlayers = builtAt([playersH, playersA], 12), oldRatings = builtAt([profH, profA], 48);
    if (oldPlayers.length) warnings.push(`Player stats are from ${when(Math.min(...oldPlayers))} — StatsHub hasn't answered since, so any newer games aren't in them.`);
    if (oldRatings.length) warnings.push(`Team ratings are from ${when(Math.min(...oldRatings))} — football-data hasn't answered since.`);

    let quotes = dedupeQuotes([...quotes365, ...((meta && meta.uk) || [])]);
    if (pm) quotes.push({ book: "Polymarket", type: 1, market: "Full Time Result", value: "", source: "Polymarket",
                          prices: { 1: 1 / pm.home, X: 1 / pm.draw, 2: 1 / pm.away } });
    const cons = consensus(quotes);
    if (!quotes.length) warnings.push("No odds found for this game on any source yet.");

    const lineups = {}, lineupCheck = {};
    const memberName = Object.fromEntries((detail.members || []).map((m) => [m.id, m.name]));
    const memberNum = Object.fromEntries((detail.members || []).map((m) => [m.id, m.jerseyNumber]));
    for (const [side, key] of [["home", "homeCompetitor"], ["away", "awayCompetitor"]]) {
      const lu = (detail[key] || {}).lineups || {};
      lineups[side] = { status: lu.status || "Not published", formation: lu.formation || null, source: lu.status === "Confirmed" ? "365Scores" : null };
      const e = espn && espn[side];
      if (!e || e.starters.length < 11) continue;
      if (lineups[side].status !== "Confirmed") {
        // 365Scores hasn't confirmed it yet — ESPN has: use ESPN's XI.
        lineups[side] = { status: "Confirmed", formation: e.formation || lineups[side].formation, source: "ESPN" };
      } else {
        // Both have it: do they name the same XI? The same player can be spelt
        // two ways ("Fabrício Garcia" / "Fabrício Andrade" — one man, two
        // surnames), so the shirt number settles it, and a single leftover name
        // on each side with the same first name is the same player too.
        const xi365 = (lu.members || []).filter((m) => m.statusText === "Starting").map((m) => ({ name: memberName[m.id], num: shirt(memberNum[m.id]) })).filter((x) => x.name);
        const same = (a, b) => samePlayer(a.name, b.name) || (a.num && b.num && a.num === b.num);
        let only365 = xi365.filter((a) => !e.starters.some((b) => same(a, b)));
        let onlyEspn = e.starters.filter((b) => !xi365.some((a) => same(a, b)));
        const first = (n) => norm(n).split(" ")[0] || "";
        const firsts = (list) => list.map((x) => first(x.name)).sort().join("|");
        if (only365.length && only365.length === onlyEspn.length && firsts(only365) === firsts(onlyEspn)) { only365 = []; onlyEspn = []; }
        lineupCheck[side] = { agree: !only365.length && !onlyEspn.length, only365: only365.map((a) => a.name), onlyEspn: onlyEspn.map((b) => b.name) };
        lineups[side].source = "365Scores + ESPN";
      }
    }
    const confirmed = lineups.home.status === "Confirmed" && lineups.away.status === "Confirmed";
    // (If they still name someone different, HAWK goes with 365Scores' XI — the lineup card says so quietly.)
    if (!confirmed) warnings.push("Lineups not confirmed yet — HAWK rule: don't lock the ticket until they are.");

    let refName = ((detail.officials || [])[0] || {}).name || null, refAvg = null, refGames = null, refSource = null;
    if (meta && meta.ref && meta.ref.avg_cards) { refName = meta.ref.name; refAvg = meta.ref.avg_cards; refGames = meta.ref.games; refSource = "StatsHub"; }
    else if (refName) { const r = refereeFromProfile(refName, profH); if (r) { [refAvg, refGames] = r; refSource = "football-data"; } }
    const refFactor = refereeFactor(refAvg, refGames, profH && profH.avg_cards_total);

    const lamModel = profH && profA ? expectedPair(profH, fdH, profA, fdA, "goals") : null;
    // A national side has no league to be rated in, so saying "their league isn't
    // in HAWK's ratings" reads as a fault when it is simply how internationals
    // work — and saying it once per team said it twice for the same reason.
    if (INTL.has(league) && !fdH && !fdA && meta)
      warnings.push("National teams have no season ratings in HAWK — the result, goals, corner and card chances come from the bookmakers' prices.");
    else for (const [team, fdName, p] of [[home, fdH, profH], [away, fdA, profA]]) {
      if (!fdName && meta) warnings.push(`${team}: their league isn't in HAWK's team ratings (football-data covers the main European leagues) — their chances come from the bookmakers' prices.`);
      else if (p && ((p.teams[fdName] || {}).games_this_season || 0) < 3)
        warnings.push(`${team}: under 3 league games this season, ratings lean on last season${(p.teams[fdName] || {}).promoted ? " (promoted — starts from a below-average prior)" : ""}.`);
    }
    const c1x2 = cons["1|"];
    const p1x2 = c1x2 && ["1", "X", "2"].every((k) => k in c1x2.probs) ? [c1x2.probs["1"], c1x2.probs.X, c1x2.probs["2"]] : null;
    const totals = Object.entries(cons).filter(([k, c]) => k.startsWith("3|") && halfLine(k.slice(2)) != null && "Over" in c.probs)
      .map(([k, c]) => [parseFloat(k.slice(2)), c.probs.Over]);
    const lamMarket = p1x2 || totals.length ? fitGoalLambdas(p1x2, totals) : null;
    let lamBlend = null, ignored = false, marketW = null;
    if (lamModel || lamMarket) {
      let weight = MARKET_WEIGHT;
      if (lamModel && p1x2) {
        const Mm = scoreMatrix(...lamModel);
        const pm1x2 = [sumCells(Mm, (i, j) => i > j), sumCells(Mm, (i, j) => i === j), sumCells(Mm, (i, j) => i < j)];
        const trust = pm1x2.map((p, k) => marketTrust(p, p1x2[k], c1x2.books));
        weight = Math.max(...trust.map((t) => t[0]));
        ignored = trust.some((t) => t[1]);
      }
      lamBlend = [0, 1].map((k) => blend(lamModel ? lamModel[k] : null, lamMarket ? lamMarket[k] : null, weight));
      marketW = !lamMarket ? 0 : !lamModel ? 1 : weight;   // how much of HAWK's number is the bookmakers'
    }
    if (ignored) warnings.push("HAWK's goal model disagrees strongly with the bookmakers on this match (usually a big favourite it underrates) — trusting the market instead.");

    const statModel = {}, statMarket = {}, statBlend = {};
    for (const [t, stat] of Object.entries(STAT_TYPES)) {
      const pair = profH && profA ? expectedPair(profH, fdH, profA, fdA, stat) : null;
      let total = pair ? pair[0] + pair[1] : null;
      if (total && stat === "cards") total = total * refFactor + RED_POINTS;
      statModel[stat] = total;
      const lines = Object.entries(cons).filter(([k, c]) => k.startsWith(`${t}|`) && halfLine(k.split("|")[1]) != null && "Over" in c.probs)
        .map(([k, c]) => [parseFloat(k.split("|")[1]), c.probs.Over]);
      statMarket[stat] = lines.length ? fitTotalLambda(lines) : null;
      statBlend[stat] = blend(total, statMarket[stat]);
    }
    return {
      id, league, home, away, homeComp: hc, awayComp: ac, kickoff, inPlay: !!(kickoff && kickoff < new Date()),
      quotes, cons, polymarket: pm, lineups, confirmed, espn, lineupCheck, detail, table, form: { home: formH, away: formA }, recentForm: { home: recentH, away: recentA },
      referee: { name: refName, avg: refAvg, games: refGames, source: refSource, factor: refFactor },
      profiles: [profH, fdH, profA, fdA], lamModel, lamMarket, lamBlend, M: lamBlend ? scoreMatrix(...lamBlend) : null, marketW, ignored,
      // Both teams rated within the same league: only then can HAWK's own
      // ratings be compared head to head (a League One side isn't "45%" v Brentford).
      sameLeague: !!(fd.home && fd.away && fd.home[0] === fd.away[0]),
      statModel, statMarket, statBlend, players: [playersH, playersA], warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Squads (sim.py)
  // ---------------------------------------------------------------------------
  function playerRows(file) {
    if (!file) return [];
    const f = file.fields;
    return file.players.map((p) => ({ name: p.name, position: p.position,
      matches: p.m.map((row) => Object.fromEntries(f.map((k, i) => [k, k === "home" || k === "sub_in" ? !!row[i] : row[i]]))) }));
  }
  // Which of the team's StatsHub players is this lineup name? The usual name
  // match, plus two careful extras for names the sources write differently:
  //  - transliterations: nearly the same surname ("Yarmolyuk" / "Yarmoliuk")
  //  - keepers: same first name and both goalkeepers ("Daniel Heuer" /
  //    "Daniel Fernandes") — only for keepers, where it can't pick the wrong man.
  // A new signing with no StatsHub record stays unmatched (no borrowed stats).
  function matchPlayer(name, pos, rows) {
    const names = rows.map((r) => r.name);
    if (!names.length) return null;
    const hit = bestMatch(name, names, 0.6);
    if (hit) return hit;
    const tok = (s) => norm(s).split(" ").filter((t) => t.length >= 3);
    const mine = tok(name), last = mine[mine.length - 1] || "";
    const scored = rows.map((r) => {
      const t = tok(r.name), l = t[t.length - 1] || "";
      let s = 0;
      if (last && l && last[0] === l[0] && bigramRatio(last, l) >= 0.7) s = 0.7;
      if (pos === "G" && r.position === "G" && mine[0] && t[0] === mine[0]) s = Math.max(s, 0.65);
      if (pos && r.position && pos !== r.position) s -= 0.3;
      return [s, r.name];
    }).sort((a, b) => b[0] - a[0]);
    return scored[0][0] >= 0.6 && (!scored[1] || scored[0][0] - scored[1][0] >= 0.1) ? scored[0][1] : null;
  }
  // The team's last n games (their kick-off times) from all its players' logs,
  // and a player's minutes in them. "Who plays lately" must be measured in the
  // team's recent games: a player's own last 5 can be from last season (he's
  // since left, or has been injured for months).
  function teamGames(rows, n = 5) {
    const ts = [...new Set(rows.flatMap((p) => p.matches.map((m) => m.ts)).filter(Boolean))].sort((a, b) => b - a);
    return new Set(ts.slice(0, n));
  }
  const minutesIn = (matches, games) => (matches || []).reduce((s, m) => s + (games.has(m.ts) ? m.minutes : 0), 0);
  const totalsOf = (ms) => [
    ms.reduce((s, m) => s + m.minutes, 0), ms.reduce((s, m) => s + m.shots, 0), ms.reduce((s, m) => s + m.sot, 0),
    ms.reduce((s, m) => s + XG_WEIGHT * m.xg + (1 - XG_WEIGHT) * m.goals, 0), ms.reduce((s, m) => s + m.yellow + m.red, 0)];
  function positionPriors(players) {
    const pooled = {};
    for (const p of players) {
      const t = totalsOf(p.matches);
      if (t[0] >= 300 && DEFAULT_RATES[p.position]) { const acc = (pooled[p.position] ||= [0, 0, 0, 0, 0]); t.forEach((v, i) => { acc[i] += v; }); }
    }
    const priors = { ...DEFAULT_RATES };
    for (const [pos, [mins, ...rest]] of Object.entries(pooled)) priors[pos] = rest.map((v) => (90 * v) / mins);
    return priors;
  }
  // Data files built before the extra stats were added don't have them.
  const hasExtras = (matches) => matches.length > 0 && matches[0].fouls !== undefined;
  const extraValue = (m, k) => (k === "assists" ? XG_WEIGHT * (m.xa || 0) + (1 - XG_WEIGHT) * (m.assists || 0) : m[k] || 0);
  function extraPriors(players) {
    const pooled = {};
    for (const p of players) {
      if (!hasExtras(p.matches) || !EXTRA_DEFAULTS[p.position]) continue;
      const mins = p.matches.reduce((s, m) => s + m.minutes, 0);
      if (mins < 300) continue;
      const acc = (pooled[p.position] ||= { mins: 0 });
      acc.mins += mins;
      for (const k of EXTRA_STATS) acc[k] = (acc[k] || 0) + p.matches.reduce((s, m) => s + extraValue(m, k), 0);
    }
    const priors = { ...EXTRA_DEFAULTS };
    for (const [pos, acc] of Object.entries(pooled)) priors[pos] = Object.fromEntries(EXTRA_STATS.map((k) => [k, (90 * acc[k]) / acc.mins]));
    return priors;
  }
  function rates(matches, prior, pos, xprior) {
    const [mins, shots, sot, goals, cards] = totalsOf(matches);
    const w = (mins + PRIOR_MINUTES) / 90, v = PRIOR_MINUTES / 90;
    let [sh90, sot90, g90, c90] = [shots, sot, goals, cards].map((x, i) => (x + prior[i] * v) / w);
    sot90 = Math.max(sot90, g90 * 1.05);
    sh90 = Math.max(sh90, sot90 * 1.1);
    const starts = matches.filter((m) => !m.sub_in).map((m) => m.minutes);
    const typical = START_MINUTES[pos] || 82;
    const startMin = Math.min(90, Math.max(55, (starts.reduce((s, x) => s + x, 0) + PRIOR_STARTS * typical) / (starts.length + PRIOR_STARTS)));
    // Per-90 extras, shrunk to the position average the same way; null when
    // the team's data file predates them (legs shouldn't rest on averages alone).
    const x = xprior && (!matches.length || hasExtras(matches))
      ? Object.fromEntries(EXTRA_STATS.map((k) => [k, (matches.reduce((s, m) => s + extraValue(m, k), 0) + xprior[k] * v) / w])) : null;
    const sv90 = x && mins > 0 ? (90 * matches.reduce((s, m) => s + (m.saves || 0), 0)) / mins : null;
    return { sh90, sot90, g90, c90, x, sv90, start_min: startMin, minutes: mins, apps: matches.length };
  }
  function buildSquads(an) {
    const members = Object.fromEntries((an.detail.members || []).map((m) => [m.id, m]));
    const sh = { home: playerRows(an.players[0]), away: playerRows(an.players[1]) };
    const priors = positionPriors([...sh.home, ...sh.away]), xpriors = extraPriors([...sh.home, ...sh.away]);
    const squads = {}, missing = {}, lineupGuess = {};
    an.missing = missing;
    an.lineupGuess = lineupGuess;   // side -> true when HAWK guessed the XI (365Scores had none)
    for (const [side, key] of [["home", "homeCompetitor"], ["away", "awayCompetitor"]]) {
      const lineup = (an.detail[key] || {}).lineups || {};
      const fromEspn = an.lineups[side].source === "ESPN", confirmed = an.lineups[side].status === "Confirmed";
      const byName = Object.fromEntries(sh[side].filter((p) => p.name).map((p) => [p.name, p]));
      const teamHasExtras = sh[side].some((p) => hasExtras(p.matches));
      // Team news: 365Scores lists injured/suspended ("Missing") and doubtful players.
      const news = (lineup.members || []).filter((m) => m.statusText === "Missing" || m.statusText === "Doubtful").map((m) => {
        const info = members[m.id] || {}, inj = m.injury || {};
        return { name: info.name || "?", status: m.statusText, reason: inj.reason && inj.reason !== "-" ? inj.reason : null,
                 back: inj.expectedReturn && inj.expectedReturn !== "Unknown" ? inj.expectedReturn : null, pos: POSITIONS[(m.position || {}).name] || null };
      });
      missing[side] = news;
      const listed = (name, status) => news.some((o) => o.status === status && nameSimilarity(o.name, name) >= 0.85);
      let entries = (lineup.members || []).filter((m) => m.statusText === "Starting" || m.statusText === "Substitute").map((m) => {
        const info = members[m.id] || {}, y = m.yardFormation;
        // Where he plays on the pitch (for the lineup view): depth 0 = own goal … 100 = attack, side 0 … 100.
        const field = y && y.fieldLine != null ? { depth: y.fieldLine, side: y.fieldSide } : null;
        return [info.name || "?", m.statusText, POSITIONS[(m.position || {}).name], info.athleteId ? athletePhoto(info) : null,
                field, shirt(info.jerseyNumber), info.shortName || null];
      });
      // Faces: 365Scores' photo, else ESPN's headshot (a second source for the players 365Scores has none for).
      const espnSide = (an.espn && an.espn[side]) || null, espnAll = espnSide ? [...espnSide.starters, ...espnSide.subs] : [];
      const espnPhoto = (name) => { const p = espnAll.find((x) => x.photo && samePlayer(x.name, name)); return p ? p.photo : null; };
      const photo365 = (name) => { const m = Object.values(members).find((x) => x.athleteId && x.name && samePlayer(x.name, name)); return m ? athletePhoto(m) : null; };
      if (fromEspn) {
        // The confirmed XI from ESPN (365Scores didn't have it yet). No pitch
        // positions: the lineup view lays these out by position.
        const e = an.espn[side];
        entries = [...e.starters.map((p) => [p.name, "Starting", p.pos, photo365(p.name) || p.photo, null, p.num, null]),
                   ...e.subs.map((p) => [p.name, "Substitute", p.pos, photo365(p.name) || p.photo, null, p.num, null])];
      } else if (!entries.some((e) => e[1] === "Starting") && sh[side].length) {
        // No lineup from 365Scores: the most-used players in the team's last 5
        // games (minus the injured and suspended) in a real shape — a keeper,
        // 4 at the back, and 3-3 or 4-2 up front depending on whether a third
        // forward has been playing. Short lines are filled with the next most-used.
        const games = teamGames(sh[side]), mins = (p) => minutesIn(p.matches, games);
        const recent = sh[side].filter((p) => !listed(p.name, "Missing") && mins(p) > 0).sort((a, b) => mins(b) - mins(a));
        const of = (pos) => recent.filter((p) => (p.position || "M") === pos);
        const fwd = of("F"), threeUp = fwd.length >= 3 && mins(fwd[2]) >= 200;
        const xi = [of("G")[0], ...of("D").slice(0, 4), ...of("M").slice(0, threeUp ? 3 : 4), ...fwd.slice(0, threeUp ? 3 : 2)].filter(Boolean);
        for (const p of recent) { if (xi.length >= 11) break; if (!xi.includes(p) && p.position !== "G") xi.push(p); }
        const bench = recent.filter((p) => !xi.includes(p)).slice(0, 7);
        entries = [...xi.map((p) => [p.name, "Starting", p.position, photo365(p.name)]), ...bench.map((p) => [p.name, "Substitute", p.position, photo365(p.name)])];
        lineupGuess[side] = true;
        const count = (pos) => xi.filter((p) => (p.position || "M") === pos).length;
        if (!an.lineups[side].formation) an.lineups[side].formation = `${count("D")}-${count("M")}-${count("F")}`;
      }
      const lastGames = teamGames(sh[side]);
      squads[side] = entries.map(([name, status, pos, photo, field = null, num = null, short = null]) => {
        const match = matchPlayer(name, pos, sh[side]);
        const matches = match ? byName[match].matches : [];
        // Minutes in the team's last 5 games: 0 for a starter = new signing, back
        // from a long injury — or a lineup mistake (the lineup view flags it).
        const teamMins = lastGames.size ? minutesIn(matches, lastGames) : null;
        pos = pos || (match && byName[match].position) || "M";
        const r = rates(matches, priors[pos] || DEFAULT_RATES.M, pos, teamHasExtras ? xpriors[pos] || EXTRA_DEFAULTS.M : null);
        // A doubtful player in a predicted lineup may well not start (and gets no legs).
        const doubt = !confirmed && listed(name, "Doubtful") ? DOUBTFUL_START : 1;
        const alt = espnPhoto(name), photo2 = alt && alt !== photo ? alt : null;
        return { ...r, name, pos, status, photo: photo || photo2, photo2: photo ? photo2 : null, field, num, short, teamMins, start_p: START_PROB[confirmed][status] * doubt, doubtful: doubt < 1,
                 sub_p: status === "Substitute" ? SUB_APPEAR_PROB : 0, has_data: !!match, recent: matches.slice(0, 10),
                 recent_starts: matches.filter((m) => !m.sub_in).slice(0, 10) };
      });
    }
    return squads;
  }

  // ---------------------------------------------------------------------------
  // Simulation (sim.py)
  // ---------------------------------------------------------------------------
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function poisson(rng, lam) {
    if (lam <= 0) return 0;
    const L = Math.exp(-lam);
    let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }
  // Corners and cards are overdispersed: their variance runs above their mean,
  // which a plain Poisson cannot represent (Poisson forces variance = mean).
  // The literature fits them with negative binomial / compound Poisson instead.
  // A negative binomial is a Poisson whose RATE varies, which is also the honest
  // description of the thing — some matches are scrappy and some are not, and
  // that is largely settled before a card is shown.
  // The fitted mean is untouched, so everything calibrated to the bookmakers'
  // lines stays put; only the tails widen. Understating the tails makes the far
  // lines look rarer than they are and the middle lines commoner, which is
  // exactly the shape of leg the "no result leg" builds are made of.
  const OVERDISP = { corners: 1.30, cards: 1.25 };   // variance ÷ mean
  // Marsaglia-Tsang gamma, shape >= 1, using the same seeded rng.
  function gamma(rng, shape) {
    if (shape < 1) return gamma(rng, shape + 1) * Math.pow(rng() || 1e-12, 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (let i = 0; i < 64; i++) {
      let x, w;
      do { const u1 = rng() || 1e-12, u2 = rng() || 1e-12;
           x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
           w = 1 + c * x; } while (w <= 0);
      const v = w * w * w, u = rng() || 1e-12;
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
    return shape;   // gave up: fall back to the mean
  }
  // One multiplier per MATCH, not per team: a scrappy game produces cards at
  // both ends and a stretched one produces corners at both ends. Drawing them
  // independently would lose that, and it's the home/away association the card
  // papers reach for a copula to describe. Mean 1, variance (v-1)/lam.
  const dispMult = (rng, lam, v) => {
    if (!(v > 1) || !(lam > 0)) return 1;
    const k = lam / (v - 1);
    return gamma(rng, k) / k;
  };
  function teamExpectations(an) {
    const M = an.M;
    let gh = 0, ga = 0;
    for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) { gh += i * M[i][j]; ga += j * M[i][j]; }
    const goals = [gh, ga];
    const [profH, fdH, profA, fdA] = an.profiles;
    const pair = (stat) => (profH && profA ? expectedPair(profH, fdH, profA, fdA, stat) : null);
    const scaled = (p, total) => (p && total && p[0] + p[1] > 0 ? p.map((v) => (v * total) / (p[0] + p[1])) : p);
    let sot = pair("sot") || [goals[0] * 3.2, goals[1] * 3.2];
    if (an.lamModel) sot = sot.map((s, k) => s * Math.pow(goals[k] / Math.max(an.lamModel[k], 0.1), 0.6));
    sot = scaled(sot, an.statBlend.sot).map((s, k) => Math.max(s, goals[k] + 0.6));
    let shots = pair("shots");
    shots = shots ? shots.map((x, k) => Math.max(x, sot[k] * 1.6)) : [sot[0] * 2.8, sot[1] * 2.8];
    let cards = pair("cards");
    cards = cards ? cards.map((c) => c * an.referee.factor) : [2.1, 2.1];
    cards = scaled(cards, an.statBlend.cards);
    // Each team's share of the (market-calibrated) corner total, from the ratings.
    const corners = an.statBlend.corners || 9.8;
    const cornersTeam = scaled(pair("corners"), corners) || [corners * 0.55, corners * 0.45];
    return { goals, sot, shots, cards, corners, cornersTeam };
  }
  // Share each simulation's `counts` events among players (weights per sim
  // and player, row-major) plus a small "rest of team" bucket.
  function allocate(rng, counts, weights, k) {
    const n = counts.length, out = new Int16Array(n * k);
    let mean = 0;
    for (let s = 0; s < n; s++) for (let i = 0; i < k; i++) mean += weights[s * k + i];
    const rest = REST_SHARE * Math.max(mean / n, 1e-6);
    for (let s = 0; s < n; s++) {
      const c = counts[s];
      if (!c) continue;
      let total = rest;
      for (let i = 0; i < k; i++) total += weights[s * k + i];
      for (let e = 0; e < c; e++) {
        let u = rng() * total, i = 0;
        for (; i < k; i++) { u -= weights[s * k + i]; if (u < 0) break; }
        if (i < k) out[s * k + i]++;
      }
    }
    return out;
  }
  // Goals and their assists, event by event, so nobody assists his own goal.
  // Each goal gets an assist with probability ASSIST_SHARE.
  function allocateGoals(rng, counts, wGoal, wAssist, k) {
    const n = counts.length, goals = new Int16Array(n * k), assists = new Int16Array(n * k);
    const meanOf = (w) => { let m = 0; for (let x = 0; x < w.length; x++) m += w[x]; return m / n; };
    const restG = REST_SHARE * Math.max(meanOf(wGoal), 1e-6), restA = REST_SHARE * Math.max(meanOf(wAssist), 1e-6);
    const pick = (w, s, total, skip) => {
      let u = rng() * total;
      for (let i = 0; i < k; i++) { if (i === skip) continue; u -= w[s * k + i]; if (u < 0) return i; }
      return -1; // rest of the team
    };
    for (let s = 0; s < n; s++) {
      const c = counts[s];
      if (!c) continue;
      let totG = restG, totA = restA;
      for (let i = 0; i < k; i++) { totG += wGoal[s * k + i]; totA += wAssist[s * k + i]; }
      for (let e = 0; e < c; e++) {
        const scorer = pick(wGoal, s, totG, -1);
        if (scorer >= 0) goals[s * k + scorer]++;
        if (rng() >= ASSIST_SHARE) continue;
        const helper = pick(wAssist, s, totA - (scorer >= 0 ? wAssist[s * k + scorer] : 0), scorer);
        if (helper >= 0) assists[s * k + helper]++;
      }
    }
    return { goals, assists };
  }
  // Scanning dozens of matches runs the same simulation for each one, and each
  // run blocks the screen. A scan uses a third of the simulations: plenty to rank
  // matches, a third of the work and a third of the memory. Opening a match
  // re-simulates it in full.
  let scanSims = false;
  function simulate(an, squads) {
    const rng = mulberry32(7), n = scanSims ? SCAN_SIMS : N_SIMS, exp = teamExpectations(an), M = an.M;
    const cells = [], cum = [];
    let acc = 0;
    for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) { acc += M[i][j]; cells.push([i, j]); cum.push(acc); }
    const goals = { home: new Int16Array(n), away: new Int16Array(n) };
    const half1 = { home: new Int16Array(n), away: new Int16Array(n) }; // first-half goals
    const first = new Int8Array(n); // 1 = home scored first, 2 = away, 0 = no goal
    // Bet365's Early Payout: was the team ever 2 goals ahead?
    const twoUp = { home: new Uint8Array(n), away: new Uint8Array(n) };
    const order = mulberry32(11);   // its own stream, so the rest of the simulation is unchanged
    for (let s = 0; s < n; s++) {
      const u = rng() * acc;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
      const h = cells[lo][0], a = cells[lo][1];
      goals.home[s] = h; goals.away[s] = a;
      // Each goal falls in the first half with probability HALF_SHARE, and
      // given the score every order of the goals is equally likely.
      for (let e = 0; e < h; e++) if (rng() < HALF_SHARE) half1.home[s]++;
      for (let e = 0; e < a; e++) if (rng() < HALF_SHARE) half1.away[s]++;
      rng();   // (kept so the random stream — and every other number — stays the same)
      // The goals in order: the first half's, then the second half's, each
      // half in a random order. Gives the first scorer and the biggest leads.
      let d = 0, fs = 0;
      for (const [rh0, ra0] of [[half1.home[s], half1.away[s]], [h - half1.home[s], a - half1.away[s]]]) {
        let rh = rh0, ra = ra0;
        while (rh + ra > 0) {
          const home = order() * (rh + ra) < rh;
          if (home) { rh--; d++; } else { ra--; d--; }
          if (!fs) fs = home ? 1 : 2;
          if (d >= 2) twoUp.home[s] = 1;
          if (d <= -2) twoUp.away[s] = 1;
        }
      }
      first[s] = fs;
    }
    const cornersTeam = { home: new Int16Array(n), away: new Int16Array(n) }, corners = new Int16Array(n);
    // How stretched this particular match is, drawn once and applied to both
    // teams — see dispMult. Poisson alone can't produce the fat tails corners
    // and cards really have, so the far lines came out rarer than they are.
    const cornerLam = exp.cornersTeam[0] + exp.cornersTeam[1];
    const cardLam = exp.cards[0] + exp.cards[1];
    const cornerMult = new Float64Array(n), cardMult = new Float64Array(n);
    for (let s = 0; s < n; s++) {
      cornerMult[s] = dispMult(rng, cornerLam, OVERDISP.corners);
      cardMult[s] = dispMult(rng, cardLam, OVERDISP.cards);
    }
    for (let s = 0; s < n; s++) {
      cornersTeam.home[s] = poisson(rng, exp.cornersTeam[0] * cornerMult[s]);
      cornersTeam.away[s] = poisson(rng, exp.cornersTeam[1] * cornerMult[s]);
      corners[s] = cornersTeam.home[s] + cornersTeam.away[s];
    }
    const teamSot = {}, teamShots = {}, teamCards = {};
    ["home", "away"].forEach((side, t) => {
      const g = goals[side], sot = new Int16Array(n), shots = new Int16Array(n), cards = new Int16Array(n);
      for (let s = 0; s < n; s++) {
        sot[s] = g[s] + poisson(rng, Math.max(exp.sot[t] - exp.goals[t], 0.4));
        shots[s] = sot[s] + poisson(rng, Math.max(exp.shots[t] - exp.sot[t], 0.8));
        cards[s] = poisson(rng, exp.cards[t] * cardMult[s]);
      }
      teamSot[side] = sot; teamShots[side] = shots; teamCards[side] = cards;
    });
    const player = {};
    ["home", "away"].forEach((side) => {
      const other = side === "home" ? "away" : "home";
      const g = goals[side], sot = teamSot[side], shots = teamShots[side], cards = teamCards[side];
      const squad = squads[side] || [], k = squad.length;
      if (!k) return;
      const frac = new Float64Array(n * k);
      for (let s = 0; s < n; s++) for (let i = 0; i < k; i++) {
        const p = squad[i];
        const starts = rng() < p.start_p, subs = !starts && rng() < p.sub_p;
        frac[s * k + i] = (starts ? p.start_min : subs ? SUB_MINUTES : 0) / 90;
      }
      const weighted = (fn) => { const w = new Float64Array(n * k); for (let s = 0; s < n; s++) for (let i = 0; i < k; i++) w[s * k + i] = frac[s * k + i] * fn(squad[i]); return w; };
      const diff = (a, b) => { const d = new Int16Array(n); for (let s = 0; s < n; s++) d[s] = a[s] - b[s]; return d; };
      const xr = (p, key) => (p.x ? p.x[key] : EXTRA_DEFAULTS[p.pos] ? EXTRA_DEFAULTS[p.pos][key] : EXTRA_DEFAULTS.M[key]);
      const pg = allocateGoals(rng, g, weighted((p) => p.g90), weighted((p) => Math.max(xr(p, "assists"), 0.005)), k);
      const pExtraSot = allocate(rng, diff(sot, g), weighted((p) => Math.max(p.sot90 - p.g90, 0.02)), k);
      const pOff = allocate(rng, diff(shots, sot), weighted((p) => Math.max(p.sh90 - p.sot90, 0.05)), k);
      // Fouls, fouls won, tackles and offsides are counted per player. A player
      // who fouls more than usual in a simulation is likelier to be the one booked.
      const counted = {};
      for (const key of ["fouls", "fouled", "tackles", "offsides"]) {
        const arr = new Int16Array(n * k);
        for (let s = 0; s < n; s++) for (let i = 0; i < k; i++) { const f = frac[s * k + i]; if (f) arr[s * k + i] = poisson(rng, f * xr(squad[i], key)); }
        counted[key] = arr;
      }
      const wCards = weighted((p) => p.c90);
      for (let s = 0; s < n; s++) for (let i = 0; i < k; i++) {
        const x = s * k + i, lam = frac[x] * xr(squad[i], "fouls");
        wCards[x] *= (0.5 + counted.fouls[x]) / (0.5 + lam); // averages to 1 for a Poisson count
      }
      const pCards = allocate(rng, cards, wCards, k);
      // Saves: the opponent's shots on target that weren't goals, for whoever is in goal.
      const oppSot = teamSot[other], oppGoals = goals[other];
      for (let i = 0; i < k; i++) {
        const p = squad[i], keeper = p.pos === "G";
        const a = { goals: new Int16Array(n), sot: new Int16Array(n), shots: new Int16Array(n), cards: new Int16Array(n),
                    assists: new Int16Array(n), fouls: new Int16Array(n), fouled: new Int16Array(n), tackles: new Int16Array(n),
                    offsides: new Int16Array(n), saves: keeper ? new Int16Array(n) : null };
        for (let s = 0; s < n; s++) {
          const x = s * k + i;
          a.goals[s] = pg.goals[x]; a.sot[s] = pg.goals[x] + pExtraSot[x]; a.shots[s] = a.sot[s] + pOff[x]; a.cards[s] = pCards[x];
          a.assists[s] = pg.assists[x]; a.fouls[s] = counted.fouls[x]; a.fouled[s] = counted.fouled[x];
          a.tackles[s] = counted.tackles[x]; a.offsides[s] = counted.offsides[x];
          if (keeper && frac[x] >= 0.5) a.saves[s] = Math.max(0, oppSot[s] - oppGoals[s]);
        }
        player[`${side}:${i}`] = a;
      }
    });
    return { n, exp, goals, half1, first, twoUp, corners, cornersTeam, teamSot, player, teamCards, squads };
  }

  // ---------------------------------------------------------------------------
  // Legs, prices and tickets (sim.py)
  // ---------------------------------------------------------------------------
  // "(3+)" / "(2 or fewer)" after a line, in plain numbers — bookmaker bet
  // builders word lines differently ("Over 3 Cards" in a 3-way market means
  // 4+), so this makes copying a leg across unambiguous. Whole and quarter
  // lines also say what happens on the boundary number.
  function plainCount(option, line) {
    const x = Number(line);
    if (!Number.isFinite(x) || (option !== "Over" && option !== "Under")) return "";
    const n = Math.floor(x), frac = Math.round((x - n) * 100) / 100, over = option === "Over";
    const fewer = (k) => (k <= 0 ? "0" : `${k} or fewer`);
    if (frac === 0.5) return over ? `(${n + 1}+)` : `(${fewer(n)})`;
    if (frac === 0) return over ? `(${n + 1}+, ${n} = stake back)` : `(${fewer(n - 1)}, ${n} = stake back)`;
    if (frac === 0.25) return over ? `(${n + 1}+; ${n} = half stake back)` : `(${fewer(n - 1)}; ${n} = half win)`;
    return over ? `(${n + 2}+; ${n + 1} = half win)` : `(${fewer(n)}; ${n + 1} = half stake back)`;
  }
  const withCount = (text, option, line) => `${text} ${plainCount(option, line)}`.trim();
  // Bet365's bet builder prices corners and cards 3-way on whole numbers
  // (Over / Exactly / Under): its "Over 3" is 4+ and its "Under 12" is 11 or
  // fewer. So HAWK's Over 3.5 is Bet365's "Over 3", HAWK's Under 11.5 its "Under 12".
  const b365Whole = (option, line, what, team = "") => ({ b365: `${team ? team + ": " : ""}${option} ${option === "Over" ? Math.floor(line) : Math.ceil(line)} ${what}` });

  function mask(n, test) { const m = new Uint8Array(n); for (let s = 0; s < n; s++) m[s] = test(s) ? 1 : 0; return m; }
  const mean = (m) => { let c = 0; for (let s = 0; s < m.length; s++) c += m[s]; return c / m.length; };

  function catalogue(an, sim) {
    const { home, away } = an, n = sim.n, hg = sim.goals.home, ag = sim.goals.away, legs = {};
    const add = (id, label, market, group, arr, extra = {}) => {
      const p = mean(arr);
      if (p >= MIN_LEG_P && p <= MAX_LEG_P) legs[id] = { id, label, market, group, arr, p, fair: 1 / p, kind: "match", ...extra };
    };
    // With Early Payout, a Result leg also wins when that team goes 2 goals up
    // and doesn't hold on — Bet365 has already paid it.
    const resLeg = (side, name, g, o) => {
      const win = mask(n, (s) => g[s] > o[s]);
      if (!earlyPayout) return add(`res:${side}`, `Result: ${name}`, "Full Time Result", "result", win);
      const up = sim.twoUp[side];
      add(`res:${side}`, `Result: ${name}`, "Full Time Result", "result", mask(n, (s) => win[s] || up[s]), { ep: true, pNoEp: mean(win) });
    };
    resLeg("home", home, hg, ag);
    add("res:draw", "Result: Draw", "Full Time Result", "result", mask(n, (s) => hg[s] === ag[s]));
    resLeg("away", away, ag, hg);
    // To Qualify (knockout ties, one-off or second leg): who goes through, extra time
    // and penalties included — Bet365's cup market. After 90 minutes level on
    // aggregate, extra time/penalties are split by etShare.
    // (not in a first leg: the tie isn't decided in that game)
    const legNum = an.detail && an.detail.legNum;
    if (legNum >= 2 || (an.cons["39|"] && legNum !== 1)) {
      const [ah, aa] = preAgg(an.detail, home), pH = mean(mask(n, (s) => hg[s] > ag[s])), pA = mean(mask(n, (s) => ag[s] > hg[s]));
      const share = etShare(pH, pA), coin = (s) => ((s * 2654435761) % 1000) / 1000 < share;
      const homeThrough = mask(n, (s) => ah + hg[s] > aa + ag[s] || (ah + hg[s] === aa + ag[s] && coin(s)));
      add("qual:home", `${home} to Qualify`, "To Qualify", "qualify", homeThrough, { note: "extra time and penalties count" });
      add("qual:away", `${away} to Qualify`, "To Qualify", "qualify", mask(n, (s) => !homeThrough[s]), { note: "extra time and penalties count" });
    }
    add("dc:home", `${home} or Draw`, "Double Chance", "result", mask(n, (s) => hg[s] >= ag[s]));
    add("dc:away", `${away} or Draw`, "Double Chance", "result", mask(n, (s) => ag[s] >= hg[s]));
    for (const line of [1.5, 2.5, 3.5, 4.5]) {
      add(`goals:o${line}`, withCount(`Over ${line} Goals`, "Over", line), "Total Goals", "goals", mask(n, (s) => hg[s] + ag[s] > line));
      add(`goals:u${line}`, withCount(`Under ${line} Goals`, "Under", line), "Total Goals", "goals", mask(n, (s) => hg[s] + ag[s] < line));
    }
    add("btts:yes", "Both Teams to Score", "Both Teams to Score", "btts", mask(n, (s) => hg[s] > 0 && ag[s] > 0));
    add("btts:no", "Both Teams to Score: No", "Both Teams to Score", "btts", mask(n, (s) => !(hg[s] > 0 && ag[s] > 0)));
    for (const [side, name, g] of [["home", home, hg], ["away", away, ag]]) {
      for (const line of [0.5, 1.5, 2.5])
        add(`team:${side}:o${line}`, withCount(`${name} Over ${line} Goals`, "Over", line), "Team Goals", `team_goals:${side}`, mask(n, (s) => g[s] > line));
      const other = side === "home" ? ag : hg;
      add(`cs:${side}`, `${name} Clean Sheet`, "Clean Sheet", `team_goals:${side === "home" ? "away" : "home"}`, mask(n, (s) => other[s] === 0));
    }
    for (const line of [7.5, 8.5, 9.5, 10.5, 11.5]) {
      add(`corners:o${line}`, withCount(`Over ${line} Corners`, "Over", line), "Corners", "corners", mask(n, (s) => sim.corners[s] > line), b365Whole("Over", line, "Corners"));
      add(`corners:u${line}`, withCount(`Under ${line} Corners`, "Under", line), "Corners", "corners", mask(n, (s) => sim.corners[s] < line), b365Whole("Under", line, "Corners"));
    }
    const tc = (s) => sim.teamCards.home[s] + sim.teamCards.away[s];
    for (const line of [2.5, 3.5, 4.5, 5.5]) {
      add(`cards:o${line}`, withCount(`Over ${line} Cards`, "Over", line), "Total Cards", "cards", mask(n, (s) => tc(s) > line), b365Whole("Over", line, "Cards"));
      add(`cards:u${line}`, withCount(`Under ${line} Cards`, "Under", line), "Total Cards", "cards", mask(n, (s) => tc(s) < line), b365Whole("Under", line, "Cards"));
    }

    // Result extras
    for (const [side, name, g, o] of [["home", home, hg, ag], ["away", away, ag, hg]]) {
      add(`wtn:${side}`, `${name} to Win to Nil`, "Win to Nil", "result", mask(n, (s) => g[s] > 0 && o[s] === 0));
      add(`margin:${side}:1`, `${name} to Win by 1`, "Winning Margin", "result", mask(n, (s) => g[s] - o[s] === 1));
      add(`margin:${side}:2`, `${name} to Win by 2`, "Winning Margin", "result", mask(n, (s) => g[s] - o[s] === 2));
      add(`margin:${side}:3`, `${name} to Win by 3+`, "Winning Margin", "result", mask(n, (s) => g[s] - o[s] >= 3));
    }
    for (const line of [1.5, 2.5]) {  // Asian handicap on half lines: no stake back, so it fits a builder
      const by = line + 0.5;
      add(`ah:home:-${line}`, `${home} -${line} Handicap (win by ${by}+)`, "Handicap", "handicap", mask(n, (s) => hg[s] - ag[s] > line));
      add(`ah:away:+${line}`, `${away} +${line} Handicap (not beaten by ${by}+)`, "Handicap", "handicap", mask(n, (s) => hg[s] - ag[s] < line));
      add(`ah:away:-${line}`, `${away} -${line} Handicap (win by ${by}+)`, "Handicap", "handicap", mask(n, (s) => ag[s] - hg[s] > line));
      add(`ah:home:+${line}`, `${home} +${line} Handicap (not beaten by ${by}+)`, "Handicap", "handicap", mask(n, (s) => ag[s] - hg[s] < line));
    }
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++)
      add(`cs:${i}-${j}`, `Correct Score ${i}-${j}`, "Correct Score", "result", mask(n, (s) => hg[s] === i && ag[s] === j));
    add("first:home", `${home} to Score First`, "First Team to Score", "first", mask(n, (s) => sim.first[s] === 1));
    add("first:away", `${away} to Score First`, "First Team to Score", "first", mask(n, (s) => sim.first[s] === 2));

    // Halves
    const h1 = sim.half1, h2 = (side, s) => sim.goals[side][s] - h1[side][s];
    for (const [half, fh, fa] of [[1, (s) => h1.home[s], (s) => h1.away[s]], [2, (s) => h2("home", s), (s) => h2("away", s)]]) {
      const tag = half === 1 ? "1st" : "2nd";
      add(`h${half}res:home`, `${tag} Half Result: ${home}`, `${tag} Half Result`, `h${half}result`, mask(n, (s) => fh(s) > fa(s)));
      add(`h${half}res:draw`, `${tag} Half Result: Draw`, `${tag} Half Result`, `h${half}result`, mask(n, (s) => fh(s) === fa(s)));
      add(`h${half}res:away`, `${tag} Half Result: ${away}`, `${tag} Half Result`, `h${half}result`, mask(n, (s) => fh(s) < fa(s)));
      for (const line of [0.5, 1.5, 2.5]) {
        add(`h${half}goals:o${line}`, withCount(`${tag} Half Over ${line} Goals`, "Over", line), `${tag} Half Goals`, `h${half}goals`, mask(n, (s) => fh(s) + fa(s) > line));
        add(`h${half}goals:u${line}`, withCount(`${tag} Half Under ${line} Goals`, "Under", line), `${tag} Half Goals`, `h${half}goals`, mask(n, (s) => fh(s) + fa(s) < line));
      }
    }

    // Team corners and cards, shots on target
    for (const [side, name] of [["home", home], ["away", away]]) {
      const c = sim.cornersTeam[side], k = sim.teamCards[side];
      for (const line of [2.5, 3.5, 4.5, 5.5, 6.5, 7.5]) {
        add(`tcorners:${side}:o${line}`, withCount(`${name} Over ${line} Corners`, "Over", line), "Team Corners", `team_corners:${side}`, mask(n, (s) => c[s] > line), b365Whole("Over", line, "Corners", name));
        add(`tcorners:${side}:u${line}`, withCount(`${name} Under ${line} Corners`, "Under", line), "Team Corners", `team_corners:${side}`, mask(n, (s) => c[s] < line), b365Whole("Under", line, "Corners", name));
      }
      for (const line of [0.5, 1.5, 2.5, 3.5])
        add(`tcards:${side}:o${line}`, withCount(`${name} Over ${line} Cards`, "Over", line), "Team Cards", `team_cards:${side}`, mask(n, (s) => k[s] > line), b365Whole("Over", line, "Cards", name));
      for (const line of [1.5, 2.5])
        add(`tcards:${side}:u${line}`, withCount(`${name} Under ${line} Cards`, "Under", line), "Team Cards", `team_cards:${side}`, mask(n, (s) => k[s] < line), b365Whole("Under", line, "Cards", name));
    }
    add("mostcorners:home", `${home} Most Corners`, "Most Corners", "most_corners", mask(n, (s) => sim.cornersTeam.home[s] > sim.cornersTeam.away[s]));
    add("mostcorners:away", `${away} Most Corners`, "Most Corners", "most_corners", mask(n, (s) => sim.cornersTeam.away[s] > sim.cornersTeam.home[s]));
    // Offsides in the match: every player's own offsides added up, simulation by simulation.
    const offs = new Int16Array(n);
    for (const a of Object.values(sim.player)) if (a.offsides) for (let s = 0; s < n; s++) offs[s] += a.offsides[s];
    if (mean(mask(n, (s) => offs[s] > 0)) > 0.2) for (const line of [1.5, 2.5, 3.5, 4.5]) {
      add(`offs:o${line}`, withCount(`Over ${line} Offsides`, "Over", line), "Match Offsides", "offsides", mask(n, (s) => offs[s] > line), b365Whole("Over", line, "Offsides"));
      add(`offs:u${line}`, withCount(`Under ${line} Offsides`, "Under", line), "Match Offsides", "offsides", mask(n, (s) => offs[s] < line), b365Whole("Under", line, "Offsides"));
    }
    // Offsides come from adding up each player's own record, which no one calibrates
    // — so where the bookmakers price a line, HAWK's chance is blended with theirs
    // (as the goals, corners and cards totals already are).
    for (const id of Object.keys(legs).filter((k) => k.startsWith("offs:"))) {
      const leg = legs[id], m2 = /^offs:([ou])([\d.]+)$/.exec(id), c = m2 && (an.cons || {})[`140|${m2[2]}`];
      const pm = c && c.probs[m2[1] === "o" ? "Over" : "Under"];
      if (!(pm > 0.01 && pm < 0.99) || !(leg.p > 0)) continue;
      const p2 = blend(leg.p, pm);
      leg.adj = p2 / leg.p; leg.p = p2; leg.fair = 1 / p2;
    }
    // A red card / a penalty in the match: HAWK doesn't simulate either, so the
    // chance is the bookmakers' own (margin removed) and the leg is treated as
    // independent of the rest. Without prices there's no leg at all.
    const cons = consensus(an.quotes || []);
    for (const [kind, type, market, label] of [["redcard", 142, "Red Card", "A Red Card in the Match"], ["pen", 143, "Penalty", "A Penalty in the Match"]]) {
      const c = cons[`${type}|`];
      if (!c || !(c.probs.Yes > 0.01) || c.books < 2) continue;
      for (const [opt, id, text] of [["Yes", `${kind}:yes`, label], ["No", `${kind}:no`, `No ${label.replace(/^A /, "")}`]]) {
        const q = c.probs[opt];
        if (!(q > 0.01 && q < 0.99)) continue;
        // an independent draw per simulation, so it mixes with the other legs sensibly
        add(id, text, market, kind, mask(n, (s) => ((Math.sin((s + 1) * (kind === "pen" ? 12.9898 : 78.233)) * 43758.5453) % 1 + 1) % 1 < q), { marketOnly: true });
      }
    }
    const tsot = (s) => sim.teamSot.home[s] + sim.teamSot.away[s];
    for (const line of [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5]) {
      add(`sot:o${line}`, withCount(`Over ${line} Shots on Target`, "Over", line), "Match Shots on Target", "sot", mask(n, (s) => tsot(s) > line));
      add(`sot:u${line}`, withCount(`Under ${line} Shots on Target`, "Under", line), "Match Shots on Target", "sot", mask(n, (s) => tsot(s) < line));
    }

    // Player props need the player's own record, and that comes from his LEAGUE's
    // data file. National teams have no league file, so in an international not one
    // player is found — Virgil van Dijk included — and every prop would be built
    // from a position average dressed up as a number about him. Nothing is offered
    // rather than something that looks precise and is a guess. The result, goals,
    // corner and card markets are unaffected: those come from the bookmakers.
    const intlNoPlayers = INTL.has(an.league) && !sim.squads.home.some((p) => p.has_data);
    for (const [key, a] of Object.entries(sim.player)) {
      if (intlNoPlayers) break;
      const [side, i] = key.split(":"), p = sim.squads[side][+i];
      if (p.start_p < 0.5) continue;
      const pid = `p:${side}:${i}`;
      const common = { kind: "player", player: p.name, side, pos: p.pos, photo: p.photo, low_data: p.minutes < MIN_AUTO_MINUTES };
      // Hit rates from games he started (cameos say little about a starter), unless under 3 recent starts.
      const [basisGames, basis] = p.recent_starts.length >= 3 ? [p.recent_starts, "starts"] : [p.recent, "games"];
      const hist = (stat, k) => {
        const vals = basisGames.map((m) => (typeof stat === "function" ? stat(m) : m[stat]));
        if (vals.some((v) => v === undefined)) return {}; // not in this data file yet
        return { recent: vals, hits: vals.filter((v) => v >= k).length, games: vals.length, threshold: k, basis };
      };
      if (p.pos === "G") {
        // Saves follow from the simulated shots against, so they don't need his own record.
        for (const k of [1, 2, 3, 4, 5, 6])
          add(`${pid}:saves${k}`, `${p.name}: ${k}+ Saves`, "Goalkeeper Saves", `${pid}:saves`, mask(n, (s) => a.saves[s] >= k),
              { ...common, low_data: false, ...hist("saves", k) });
        continue;
      }
      for (const k of [1, 2, 3]) add(`${pid}:shots${k}`, `${p.name}: ${k}+ Shots`, "Player Shots", `${pid}:shots`, mask(n, (s) => a.shots[s] >= k), { ...common, ...hist("shots", k) });
      for (const k of [1, 2]) add(`${pid}:sot${k}`, `${p.name}: ${k}+ Shots on Target`, "Player Shots on Target", `${pid}:sot`, mask(n, (s) => a.sot[s] >= k), { ...common, ...hist("sot", k) });
      add(`${pid}:score`, `${p.name} to Score`, "To Score at Any Time", `${pid}:score`, mask(n, (s) => a.goals[s] >= 1), { ...common, ...hist("goals", 1) });
      add(`${pid}:booked`, `${p.name} to be Booked`, "Player to be Booked", `${pid}:booked`, mask(n, (s) => a.cards[s] >= 1), { ...common, ...hist("yellow", 1) });
      if (!p.x) continue; // this team's data file doesn't have the extra stats yet
      add(`${pid}:assist`, `${p.name} to Assist`, "Player to Assist", `${pid}:assist`, mask(n, (s) => a.assists[s] >= 1), { ...common, ...hist("assists", 1) });
      add(`${pid}:soa`, `${p.name} to Score or Assist`, "Score or Assist", `${pid}:soa`, mask(n, (s) => a.goals[s] + a.assists[s] >= 1),
          { ...common, ...hist((m) => (m.assists === undefined ? undefined : m.goals + m.assists), 1) });
      for (const k of [1, 2, 3]) {
        add(`${pid}:fouls${k}`, `${p.name}: ${k}+ Fouls Committed`, "Player Fouls Committed", `${pid}:fouls`, mask(n, (s) => a.fouls[s] >= k), { ...common, ...hist("fouls", k) });
        add(`${pid}:fouled${k}`, `${p.name}: ${k}+ Fouls Won`, "Player Fouls Won", `${pid}:fouled`, mask(n, (s) => a.fouled[s] >= k), { ...common, ...hist("fouled", k) });
        add(`${pid}:tackles${k}`, `${p.name}: ${k}+ Tackles`, "Player Tackles", `${pid}:tackles`, mask(n, (s) => a.tackles[s] >= k), { ...common, ...hist("tackles", k) });
      }
      for (const k of [1, 2]) add(`${pid}:offsides${k}`, `${p.name}: ${k}+ Offsides`, "Player Offsides", `${pid}:offsides`, mask(n, (s) => a.offsides[s] >= k), { ...common, ...hist("offsides", k) });
    }
    for (const leg of Object.values(legs)) {
      if (EXTRA_MARKETS.has(leg.market)) leg.extra = true;
      // Learning: shift a market's chances by what your settled bets showed.
      // The simulation is untouched; `adj` rescales this leg in ticket maths.
      leg.pRaw = leg.p;
      const key = learnKey(leg.id, leg.market), shift = key && learning[key];
      if (shift) {
        const p = 1 / (1 + Math.exp(-(logit(leg.p) + shift)));
        leg.adj = p / leg.p; leg.p = p; leg.fair = 1 / p;
      }
    }
    return legs;
  }

  // Per-market shifts in log-odds, worked out by the page from your settled
  // HAWK bets (see "learning" in index.html). Empty = no adjustment.
  let learning = {};
  function setLearning(shifts) { learning = shifts && typeof shifts === "object" ? shifts : {}; }
  // Trusted markets: {market: factor} from HAWK's graded predictions (worked
  // out by the page). A factor under 1 marks a market where HAWK's chances
  // have landed less often than it said; auto-builds then prefer a similar
  // leg from a market it has proven accurate on. It never changes a chance.
  let trust = {};
  function setTrust(factors) { trust = factors && typeof factors === "object" ? factors : {}; }
  // Bet365's Early Payout on Result legs (paid once the team is 2 goals up).
  // Off by default (GitHub grades HAWK's plain chances); the builder turns it on.
  let earlyPayout = false;
  function setEarlyPayout(on) { if (!!on !== earlyPayout) { earlyPayout = !!on; matches.clear(); } }
  // Which group a leg learns with, or null. Only HAWK's own estimates learn:
  // player props, and corners/cards/shots-on-target lines split by Over and
  // Under (shifting both the same way would be contradictory). Results and
  // goals come from the bookmakers' prices, so they're left alone.
  function learnKey(id, market) {
    if (String(id).startsWith("p:")) return market;
    const m = /^(?:corners|cards|sot|tcorners:\w+|tcards:\w+):([ou])/.exec(id || "");
    return m ? `${market} · ${m[1] === "o" ? "Over" : "Under"}` : null;
  }
  const adjOf = (legs, ids) => ids.reduce((s, id) => s * ((legs[id] && legs[id].adj) || 1), 1);

  // A selection typed as text (a bet you entered in the Vault yourself, e.g.
  // "Gyokeres Over 1.5 Shots on Target") → a HAWK leg the Vault can settle, or
  // null when HAWK can't read it. ctx = {home, away, players: {home: [{name}], away}}.
  const TEXT_PLAYER = [[/ to score or (?:give an )?assist$/i, "soa", "Score or Assist"], [/ to score(?: anytime| at any time)?$/i, "score", "To Score at Any Time"],
    [/ to (?:give an )?assist$/i, "assist", "Player to Assist"], [/ to be (?:booked|carded|shown a card)$/i, "booked", "Player to be Booked"]];
  const TEXT_COUNT = { "shots on target": ["sot", "Player Shots on Target"], shots: ["shots", "Player Shots"], tackles: ["tackles", "Player Tackles"],
    fouls: ["fouls", "Player Fouls Committed"], "fouls committed": ["fouls", "Player Fouls Committed"], "fouls won": ["fouled", "Player Fouls Won"],
    saves: ["saves", "Goalkeeper Saves"], offsides: ["offsides", "Player Offsides"] };
  function readLeg(text, ctx) {
    const t = String(text || "").replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();   // "Over 3.5 Goals (4+)" → "Over 3.5 Goals"
    const side = (name) => {
      const n = String(name || "").trim();
      if (/^home(?: team)?$/i.test(n)) return "home";
      if (/^away(?: team)?$/i.test(n)) return "away";
      const h = nameSimilarity(n, ctx.home), a = nameSimilarity(n, ctx.away);
      return Math.max(h, a) >= 0.6 ? (h >= a ? "home" : "away") : null;
    };
    const ou = (s) => (/^o/i.test(s) ? "o" : "u");
    // Bet365's whole-number lines ("Over 4 corners" = 5+, "Under 6 cards" = 5 or fewer) as HAWK's .5 lines.
    const val = (o, v) => { const x = parseFloat(v); return Number.isInteger(x) ? (o === "o" ? x + 0.5 : x - 0.5) : x; };
    const leg = (id, market, extra = {}) => ({ id, label: String(text).trim(), market, player: null, side: null, ...extra });
    const findP = (who) => { for (const s of ["home", "away"]) { const p = ((ctx.players || {})[s] || []).find((x) => samePlayer(who, x.name)); if (p) return { side: s, name: p.name }; } return null; };
    let m;
    if (/^(?:result:\s*)?draw$/i.test(t)) return leg("res:draw", "Full Time Result");
    if ((m = /^(.+?) to qualify$/i.exec(t)) && side(m[1])) return leg(`qual:${side(m[1])}`, "To Qualify");
    if ((m = /^(?:result:\s*)?(.+?) to win by (\d)\+(?: goals?)?$/i.exec(t)) && side(m[1])) return leg(`ah:${side(m[1])}:-${+m[2] - 0.5}`, "Handicap");
    if ((m = /^(home|away) win$/i.exec(t) || /^result:\s*(.+)$/i.exec(t) || /^(.+?) to win$/i.exec(t)) && side(m[1])) return leg(`res:${side(m[1])}`, "Full Time Result");
    if ((m = /^double chance:?\s*(.+?)\s*\/\s*draw$/i.exec(t) || /^double chance:?\s*draw\s*\/\s*(.+)$/i.exec(t) || /^(.+?) or draw$/i.exec(t)) && side(m[1])) return leg(`dc:${side(m[1])}`, "Double Chance");
    if ((m = /^both teams to score\s*[-:]?\s*(yes|no)?$/i.exec(t))) return leg(`btts:${(m[1] || "yes").toLowerCase()}`, "Both Teams to Score");
    if ((m = /^(over|under) ([\d.]+) (?:match |total )?(goals|shots on target|corners|cards)$/i.exec(t))) {
      const o = ou(m[1]), k = { goals: ["goals", "Total Goals"], "shots on target": ["sot", "Match Shots on Target"], corners: ["corners", "Corners"], cards: ["cards", "Total Cards"] }[m[3].toLowerCase()];
      return leg(`${k[0]}:${o}${val(o, m[2])}`, k[1]);
    }
    if ((m = /^(.+?) (over|under) ([\d.]+) (goals|corners|cards)$/i.exec(t)) && side(m[1]) && !findP(m[1])) {
      const s = side(m[1]), o = ou(m[2]), v = val(o, m[3]), kind = m[4].toLowerCase();
      if (kind === "goals") return o === "o" ? leg(`team:${s}:o${v}`, "Team Goals") : null;
      return leg(`t${kind}:${s}:${o}${v}`, kind === "corners" ? "Team Corners" : "Team Cards");
    }
    for (const [re, stat, market] of TEXT_PLAYER) {
      const i = t.search(re);
      if (i > 0) { const p = findP(t.slice(0, i).trim()); return p ? leg(`p:${p.side}:0:${stat}`, market, { player: p.name, side: p.side }) : null; }
    }
    if ((m = /^(.+?):? (?:over ([\d.]+)|(\d+)\+) (shots on target|shots|tackles|fouls committed|fouls won|fouls|saves|offsides)$/i.exec(t))) {
      const p = findP(m[1]), k = m[2] != null ? Math.floor(parseFloat(m[2])) + 1 : +m[3], st = TEXT_COUNT[m[4].toLowerCase()];
      return p && k >= 1 ? leg(`p:${p.side}:0:${st[0]}${k}`, st[1], { player: p.name, side: p.side }) : null;
    }
    return null;
  }
  // Does this text look like a player leg (so HAWK should wait for the lineups before reading it)?
  const isPlayerText = (text) => TEXT_PLAYER.some(([re]) => re.test(String(text).trim())) || / (?:over [\d.]+|\d+\+) (?:shots|tackles|fouls|saves|offsides)/i.test(String(text));

  // Bet365's likely price for a builder: each leg at Bet365's own price (match
  // legs), Unibet's turned into Bet365's (scorer, assist, shots on target) or
  // HAWK's estimate, multiplied together and corrected for legs that go
  // together (HAWK's joint chance against the chances multiplied) — then by
  // how far off that has been on the builder prices you've typed (aim.c).
  // With aim on, auto-build builds to this price instead of HAWK's fair odds,
  // so a 3.25 target shows about 3.25 on Bet365.
  // aim.cl: Bet365's extra builder cut per leg (it grows with every leg you add),
  // in logs; aim.c: any cut on top of that for the whole builder.
  let aim = null;
  function setAim(a) { aim = a && typeof a === "object"
    ? { c: Number.isFinite(+a.c) ? +a.c : 0, cl: Number.isFinite(+a.cl) ? +a.cl : 0, gl: Number.isFinite(+a.gl) ? +a.gl : 0 } : null; }
  // n legs, of which `guessed` are ones HAWK had to price itself: Bet365 cuts
  // those harder, so they get their own term.
  const aimOf = (n, guessed = 0) => (aim ? Math.exp(aim.c + aim.cl * n + (aim.gl || 0) * guessed) : 1);
  // The 27% is what Bet365 charges for a PLAYER PROP — that is what it was
  // measured on. A corners or cards line our feed happens not to carry is still
  // an ordinary match market to Bet365, priced at the usual few percent; HAWK
  // just can't see the number. Charging those the prop rate priced them out of
  // existence, and one of them (Under 9.5 Corners at 1.49) was the first
  // genuinely green bet in the record.
  const isProp = (leg) => !!(leg && (leg.player || String(leg.id || "").startsWith("p:")));
  const guessedCount = (legs, ids) => ids.reduce((k, id) => k + (isProp(legs[id]) && !(legs[id].bookPrice > 1) ? 1 : 0), 0);
  const UNPRICED_CUT = 0.05;   // a leg nobody prices: about 5% under HAWK's fair odds
  const hasPrice = (leg) => leg.bookPrice > 1 || (leg.refPrice > 1 && !refOff(leg));
  const legB365 = (leg) => (leg.bookPrice > 1 ? leg.bookPrice : propEstimate(leg) || Math.max(1.01, Math.exp(-UNPRICED_CUT) / leg.p));
  // Two squeezes Bet365 applies that the maths above doesn't catch, measured on
  // the builders you've priced: a second (or third) leg on the SAME player pays
  // far less than its own price suggests, and a leg on a short favourite is cut
  // harder still. Without these HAWK expected 4.10 where Bet365 showed 2.87.
  const SAME_PLAYER_CUT = 0.85, SHORT_FAVE = 1.25, SHORT_FAVE_CUT = 0.92;
  function squeeze(legs, ids) {
    const seen = new Set();
    let f = 1;
    for (const id of ids) {
      const l = legs[id];
      if (l.player) { if (seen.has(l.player)) f *= SAME_PLAYER_CUT; else seen.add(l.player); }
      if (l.bookPrice > 1 && l.bookPrice <= SHORT_FAVE) f *= SHORT_FAVE_CUT;
    }
    return f;
  }
  function b365Raw(legs, ids, joint) {
    if (!ids.length || !(joint > 0)) return null;
    let prod = 1, pp = 1;
    for (const id of ids) { const l = legs[id]; prod *= legB365(l); pp *= l.p * (l.adj || 1); }
    return prod * Math.min(1.5, Math.max(0.3, pp / joint)) * squeeze(legs, ids);
  }
  const b365Of = (legs, ids, joint) => { const r = b365Raw(legs, ids, joint); return r && r * aimOf(ids.length, guessedCount(legs, ids)); };
  // What auto-build compares with your target.
  const priceOf = (legs, ids, joint) => (aim ? b365Of(legs, ids, joint) || 0 : joint > 0 ? 1 / joint : 0);

  const FIXED_BOOK_LINES = { "qual:home": [39, "", "1"], "qual:away": [39, "", "2"], "res:home": [1, "", "1"], "res:draw": [1, "", "X"], "res:away": [1, "", "2"], "dc:home": [14, "", "1X"],
    "dc:away": [14, "", "X2"], "btts:yes": [12, "", "Yes"], "btts:no": [12, "", "No"], "cs:home": [144, "", "Yes"], "cs:away": [145, "", "Yes"],
    "h1res:home": [5, "", "1"], "h1res:draw": [5, "", "X"], "h1res:away": [5, "", "2"],
    "h2res:home": [6, "", "1"], "h2res:draw": [6, "", "X"], "h2res:away": [6, "", "2"],
    "first:home": [7, "", "Home"], "first:away": [7, "", "Away"],
    "redcard:yes": [142, "", "Yes"], "redcard:no": [142, "", "No"], "pen:yes": [143, "", "Yes"], "pen:no": [143, "", "No"] };
  const LINE_TYPES = { goals: 3, corners: 137, cards: 141, h1goals: 9, sot: 139, offs: 140 };
  // 365Scores line for a leg: [line type, value, option]. Asian handicap
  // values are the home team's handicap.
  function bookLine(id) {
    if (FIXED_BOOK_LINES[id]) return FIXED_BOOK_LINES[id];
    const [kind, rest, extra] = id.split(":");
    if (LINE_TYPES[kind] && rest && (rest[0] === "o" || rest[0] === "u")) return [LINE_TYPES[kind], rest.slice(1), rest[0] === "o" ? "Over" : "Under"];
    if (kind === "ah" && extra) {
      const h = parseFloat(extra), homeValue = rest === "home" ? h : -h;
      return [11, String(homeValue), rest === "home" ? "Home" : "Away"];
    }
    if (kind === "cs" && /^\d-\d$/.test(rest || "")) return [126, rest, "Yes"];
    return null;
  }
  function bookPrices(an, legs, book = PRICE_BOOK, which = "prices") {
    const quotes = {};
    for (const q of an.quotes) if (q.book === book) quotes[`${q.type}|${q.value}`] = q[which] || {};
    const out = {};
    for (const id of Object.keys(legs)) {
      const line = bookLine(id);
      const price = line && (quotes[`${line[0]}|${line[1]}`] || {})[line[2]];
      if (price) out[id] = price;
    }
    return out;
  }

  // Has Bet365's price moved 3%+ since it opened, and did it move towards HAWK's
  // fair price? true = HAWK agrees with the move, false = disagrees, null = no real move.
  function marketAgrees(leg) {
    if (!(leg.bookOpen > 1 && leg.bookPrice > 1 && leg.fair > 1)) return null;
    const move = leg.bookPrice / leg.bookOpen - 1;
    if (Math.abs(move) < 0.03) return null;
    return move < 0 ? leg.fair < leg.bookOpen : leg.fair > leg.bookOpen;
  }
  // "Value first" builds rank legs by how much Bet365 over-pays on them (plus a
  // little for a market move HAWK agrees with). Legs Bet365 doesn't price on
  // their own (player props) are assumed to carry its usual builder margin on
  // props (~7%), so they're used when the priced legs are worse than that.
  const UNPRICED_EDGE = -0.07;
  // Bet365's prices for player props, learnt from the ones you type in (no
  // free feed has them): per kind of leg ("tackles1" = 1+ tackles), how much
  // more (or less) sure Bet365 is than HAWK, in log-odds. The builder works
  // it out from your prices and hands it over with setPropBook().
  let propBook = {}, refRatio = {};
  // refRatio[kind]: Bet365's price ÷ Unibet's, in logs, learnt from your builder prices.
  function setPropBook(book, ratios) { propBook = book && typeof book === "object" ? book : {}; refRatio = ratios && typeof ratios === "object" ? ratios : {}; }
  // Bet365 against Unibet on the markets both price (1X2, goals, BTTS, corners): measured on 307 prices
  // across 25 top-5-league games (Sept 2026), Bet365 paid 1.2% more on average (typically within ±4%).
  const REF_TO_B365 = Math.log(1.012);
  // Player-prop prices carry roughly 7% margin, and HAWK leans 60% on them where
  // two or more of the close-to-Bet365 books price the same leg.
  const PROP_MARGIN = 0.93, PROP_MARKET_WEIGHT = 0.6;
  const b365FromRef = (leg) => { const k = propKey(leg), r = k && refRatio[k] != null ? refRatio[k] : REF_TO_B365;
                                  return Math.max(1.01, Math.round(100 * leg.refPrice * Math.exp(r)) / 100); };
  const propKey = (leg) => { const m = /^p:(?:home|away):\d+:([a-z]+?)(\d*)$/.exec(leg.id || ""); return m ? m[1] + m[2] : null; };
  // A Unibet-based price that pays nearly double what HAWK's chance is worth is a
  // mix-up (wrong player or market, or a bad learnt ratio), not a bargain: it's
  // ignored and the leg counts as guessed. Real prop edges are nowhere near +80%.
  const REF_MAX_VALUE = 1.8;
  const refOff = (leg) => leg.refPrice > 1 && leg.p > 0 && b365FromRef(leg) * leg.p > REF_MAX_VALUE;
  const logitP = (p) => { p = Math.min(Math.max(p, 1e-4), 1 - 1e-4); return Math.log(p / (1 - p)); };
  // Bet365's likely price for a prop leg (it never goes below 1.01), or null if HAWK hasn't learnt that kind yet.
  // propBook[kind] = [{x: HAWK's log-odds, d: Bet365's minus HAWK's}] from your prices. A price counts
  // most for legs HAWK rates about the same (a defender's 89% tackle says little about a forward's 50%),
  // and with no close price it falls back towards Bet365's usual prop margin (PROP_PRIOR_D).
  const PROP_PRIOR_D = 0.3, PROP_PRIOR_W = 0.15, PROP_WIDTH = 1;
  function propEstimate(leg) {
    if (leg && leg.refPrice > 1 && !refOff(leg)) return b365FromRef(leg);   // Unibet's real price for it (Kambi), turned into Bet365's, beats a guess
    const k = leg && leg.kind === "player" ? propKey(leg) : null, pts = k ? propBook[k] : null;
    if (!pts || !pts.length || !(leg.p > 0)) return null;
    const x = logitP(leg.p);
    let w = PROP_PRIOR_W, s = PROP_PRIOR_D * PROP_PRIOR_W;
    for (const pt of pts) { const wi = (pt.w ?? 1) * Math.exp(-((x - pt.x) ** 2) / (2 * PROP_WIDTH ** 2)); w += wi; s += wi * pt.d; }
    const q = 1 / (1 + Math.exp(-(x + s / w)));
    return Math.max(1.01, Math.round(100 / q) / 100);
  }
  // A leg Bet365 pays this little for adds nothing to the builder's price but can still lose it.
  const DEAD_PRICE = 1.03, FILLER_PRICE = 1.10;
  const valueScore = (leg) => {
    const est = leg.bookPrice > 1 ? null : propEstimate(leg);
    return (leg.bookPrice > 1 ? leg.bookPrice * leg.p - 1 : est ? est * leg.p - 1 : UNPRICED_EDGE) + (leg.agree === true ? 0.015 : leg.agree === false ? -0.015 : 0);
  };
  const playerKey = (leg) => (leg.kind === "player" ? `${leg.side}|${leg.player}` : null);
  // Compare two scores item by item: the first difference decides.
  const isBetter = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
  function maskOf(legs, ids, n) { const m = new Uint8Array(n).fill(1); for (const id of ids) { const a = legs[id].arr; for (let s = 0; s < n; s++) m[s] &= a[s]; } return m; }
  function evaluate(legs, ids) {
    const chosen = ids.filter((i) => legs[i]);
    if (!chosen.length) return { p: null, fair: null, legs: [] };
    const n = legs[chosen[0]].arr.length, m = new Uint8Array(n).fill(1), rows = [];
    let adj = 1;   // learning adjustments of the legs so far
    for (const id of chosen) {
      const before = mean(m) * adj, a = legs[id].arr;
      for (let s = 0; s < n; s++) m[s] &= a[s];
      adj *= legs[id].adj || 1;
      rows.push({ id, p: legs[id].p, cond: before ? Math.min(1, (mean(m) * adj) / before) : 0 });
    }
    const p = Math.min(1, mean(m) * adj, ...chosen.map((id) => legs[id].p));
    const raw = b365Raw(legs, chosen, p);
    // Market check: how much of p stays if each leg counts as at most 12% likelier than its bookie price says.
    const check = chosen.reduce((k, id) => { const l = legs[id], ref = l.refPrice || l.bookPrice;
      return ref > 1 && l.p ? k * Math.min(1, 1.12 / ref / l.p) : k; }, 1);
    // How much the legs move together: the joint chance against the chances
    // multiplied as if they were independent. Above 1 the legs agree, so the
    // ticket is worth LESS than its singles multiplied and the bookmaker
    // discounts it. Below 1 they pull apart and it is worth more.
    const pp = chosen.reduce((a, id) => a * legs[id].p, 1);
    const agree = pp > 0 ? p / pp : null;
    // aimOf needs the guessed-leg count, same as b365Of: without it the slip
    // left out the 27% a leg Bet365 doesn't publish costs, so the same ticket
    // priced one way on the slip and another on the scan.
    const guessedHere = guessedCount(legs, chosen);
    return { p, fair: p > 0 ? 1 / p : null, legs: rows, b365: raw && raw * aimOf(chosen.length, guessedHere), b365raw: raw,
             price: priceOf(legs, chosen, p) || null, agree,
             guessed: chosen.filter((id) => !hasPrice(legs[id])).length, check };
  }
  function pruneImplied(legs, chosen, keep, n) {
    for (const id of chosen.slice()) {
      if (keep.has(id) || chosen.length < 2) continue;
      const others = chosen.filter((x) => x !== id);
      if (mean(maskOf(legs, others, n)) - mean(maskOf(legs, chosen, n)) < 0.002) chosen.splice(chosen.indexOf(id), 1);
    }
    return chosen;
  }
  // known: legs in markets you've already found on Bet365 in this league (from builders you checked or logged).
  const SAFE_STEP = Math.log(1.35), SAFE_P = 0.72;
  function autoBuild(legs, target, style = "Balanced", maxLegs = 10, locked = [], banned = new Set(), favourite = true, focus = "Mix", extras = false, picks = "likely", known = new Set()) {
    const [lo, hi] = STYLES[style] || STYLES.Balanced;
    let [minPlayers, maxMatch] = FOCUS[focus] || FOCUS.Mix;
    const all = Object.values(legs);
    if (!all.length) return evaluate(legs, []);
    const n = all[0].arr.length;
    const noResult = NO_RESULT.has(focus);
    let chosen = locked.filter((i) => legs[i]);
    if (favourite && !noResult && !chosen.some((i) => legs[i].group === "result")) {
      const side = ["home", "away"].sort((a, b) => ((legs[`res:${b}`] || {}).p || 0) - ((legs[`res:${a}`] || {}).p || 0))[0];
      for (const [id, floor] of [[`res:${side}`, 0.5], [`dc:${side}`, 0.6]]) if (legs[id] && !banned.has(id) && legs[id].p >= floor) { chosen.unshift(id); break; }
    }
    const keep = new Set(chosen);
    let m = maskOf(legs, chosen, n);
    while (chosen.length < maxLegs) {
      const adjNow = adjOf(legs, chosen), pNow = mean(m) * adjNow;
      if (pNow === 0 || priceOf(legs, chosen, pNow) >= target) break;
      const groups = new Set(chosen.map((i) => legs[i].group)), perPlayer = {};
      for (const i of chosen) { const k = playerKey(legs[i]); if (k) perPlayer[k] = (perPlayer[k] || 0) + 1; }
      const nPlayers = Object.values(perPlayer).reduce((s, x) => s + x, 0), nMatch = chosen.length - nPlayers;
      let want = nPlayers < minPlayers || nMatch >= maxMatch ? "player" : null;
      if (focus === "Match") want = "match";
      let best = null, bestScore = null;
      // Each candidate is judged by the chance the WHOLE ticket lands at your price:
      // a leg that reaches the target now counts at its own chance; one that doesn't
      // counts as if the rest were made of typical safe legs (about 1.35 at Bet365,
      // landing about 72% alongside the others) — so one long-shot scorer that hits
      // 3.25 straight away loses to two likelier legs that get there together.
      // A leg that leaves the target out of reach with the legs left comes last.
      const priceNow = chosen.length ? priceOf(legs, chosen, pNow) || 1 : 1;
      // Legs with a known price first (Bet365's own, or Unibet's): they're the
      // ones you'll find on Bet365 at about the price HAWK expects. Then at most
      // ONE guessed leg (tackles, fouls, saves…) — one you've found on Bet365
      // before if possible. With a single guessed leg, the Bet365 price you type
      // tells HAWK exactly what Bet365 pays for it. A second only if nothing else fits.
      const guessedNow = chosen.filter((id) => !hasPrice(legs[id])).length;
      const passes = [(l) => hasPrice(l), (l) => guessedNow < 1 && known.has(l.id), (l) => guessedNow < 1, () => true];
      let bestPass = -1;
      for (const allowed of passes) {
        bestPass++;
        for (const leg of all) {
          if (chosen.includes(leg.id) || banned.has(leg.id) || groups.has(leg.group) || leg.low_data || (leg.extra && !extras)) continue;
          if (noResult && leg.group === "result") continue;   // Stats: the match has to carry it
          if (!hasPrice(leg) && !allowed(leg)) continue;
          if (want && leg.kind !== want) continue;
          // Filler: a leg Bet365 pays 1.10 or less for (1+ tackles, 1+ shots, 2+ saves…) barely moves the
          // price but can still lose the bet — auto-build leaves it out (you can still add it yourself).
          if (legB365(leg) <= FILLER_PRICE) continue;
          // Team Over 0.5 / 1.5 cards: land far less often than they look (graded: HAWK said 54%, 42% landed).
          if (/^tcards:(home|away):o/.test(leg.id)) continue;
          const k = playerKey(leg);
          if (k && (perPlayer[k] || 0) >= MAX_LEGS_PER_PLAYER) continue;
          let c = 0; const a = leg.arr;
          for (let s = 0; s < n; s++) c += m[s] & a[s];
          const joint = (c / n) * adjNow * (leg.adj || 1), cond = joint / pNow;
          if (cond < lo || cond > hi) continue;
          const pr = joint > 0 ? priceOf(legs, [...chosen, leg.id], joint) : 0, reaches = pr >= target, t = trust[leg.market] || 1;
          const step = pr > 0 ? Math.log(pr / priceNow) : 0;
          const need = reaches ? 0 : Math.max(1, Math.ceil(Math.log(target / Math.max(pr, 1.0001)) / SAFE_STEP));
          const feasible = reaches || chosen.length + 1 + need <= maxLegs;
          const score = picks === "value" ? [reaches ? 1 : 0, valueScore(leg) - (1 - t), cond]
            : feasible ? [1, joint * t * SAFE_P ** need] : [0, step];
          if (!bestScore || isBetter(score, bestScore)) { best = leg.id; bestScore = score; }
        }
        if (best) break;
      }
      // A Mix build that could only get its next player leg as a 2nd guessed
      // price: fewer player legs instead (a priced match leg next).
      if (best && bestPass === passes.length - 1 && want === "player" && focus === "Mix" && minPlayers > nPlayers) { minPlayers = nPlayers; continue; }
      if (!best) {
        if (want === "player" && nMatch < maxMatch && focus !== "Match" && minPlayers > 0) { minPlayers = 0; continue; }
        break;
      }
      chosen.push(best);
      chosen = pruneImplied(legs, chosen, keep, n);
      m = maskOf(legs, chosen, n);
      // A leg the prune throws straight back out — one the ticket already implies,
      // so it changes nothing — would otherwise be picked again, pruned again,
      // for ever (the page would hang). Leave it out of this build for good.
      if (!chosen.includes(best)) banned = new Set([...banned, best]);
    }
    return evaluate(legs, chosen);
  }

  // ---------------------------------------------------------------------------
  // Public API — same shapes as the local server's /api endpoints
  // ---------------------------------------------------------------------------
  const matches = new Map(); // game id -> {t, an, legs, json}, oldest first
  function keep(id, entry) {
    matches.delete(id); matches.set(id, entry);
    while (matches.size > MATCHES_KEPT) matches.delete(matches.keys().next().value);
  }

  async function gameFor(league, id) {
    if (!rawFixtures.has(String(id))) await fixtures(league);
    const hit = rawFixtures.get(String(id));
    if (!hit) throw new Error("fixture not found — reload the fixture list");
    return hit.game;
  }
  async function match(league, id, refresh = false) {
    id = String(id);
    const cached = matches.get(id);
    if (cached && !refresh && Date.now() - cached.t < MATCH_TTL) return cached.json;
    const an = await analyse(league, await gameFor(league, id));
    if (!an.M) throw new Error("no odds or ratings for this match yet");
    const squads = buildSquads(an), sim = simulate(an, squads), legs = catalogue(an, sim);
    // Player-leg prices: first the ones the data build publishes (the median of
    // DraftKings, FanDuel, Unibet and BetRivers — the books that sit within ~2-3%
    // of Bet365 on the markets both price), then Unibet live for anything left.
    try {
      const file = await data(`props/${id}.json`);
      const rows = (file && file.rows) || [];
      if (rows.length) {
        let used = 0;
        for (const leg of Object.values(legs)) {
          const k = leg.kind === "player" ? propKey(leg) : null;
          const hit = k && rows.find((r) => r.key === k && samePlayer(r.player, leg.player));
          if (hit && hit.price > 1.01) { leg.refPrice = hit.price; leg.refBook = hit.books > 1 ? `${hit.books} bookmakers` : "a bookmaker"; leg.refBooks = hit.books; used++; }
        }
        // Calibrate the player legs to those prices, as the goals, corners, cards and
        // offsides totals already are: a prop price carries about 7% margin, so the
        // chance it implies is ~0.93 / price. Two books or more, 60% weight to them.
        let tuned = 0;
        for (const leg of Object.values(legs)) {
          if (!(leg.refPrice > 1.01) || !(leg.refBooks >= 2) || !(leg.p > 0)) continue;
          const pm = Math.min(0.97, PROP_MARGIN / leg.refPrice), p2 = blend(leg.p, pm, PROP_MARKET_WEIGHT);
          if (!(p2 > 0.001 && p2 < 0.999)) continue;
          leg.pModel = leg.p; leg.adj = (leg.adj || 1) * (p2 / leg.p); leg.p = p2; leg.fair = 1 / p2;
          tuned++;
        }
        if (used) an.refFile = { built: file.built, legs: used, tuned };
      }
    } catch (e) { console.warn("[hawk] player prices:", e.message); }
    // Unibet is only asked when the published prices didn't cover enough player
    // legs — its feed takes seconds, and waiting on it is most of a match's load.
    try {
      const covered = Object.values(legs).filter((l) => l.refPrice > 1).length;
      const ref = covered >= 20 ? null : await Promise.race([kambiProps(league, an.home, an.away, an.kickoff), sleep(4000).then(() => null)]);
      if (ref && ref.rows.length) {
        for (const leg of Object.values(legs)) {
          const k = leg.kind === "player" ? propKey(leg) : null;
          const hit = k && !(leg.refPrice > 1) && ref.rows.find((r) => r.key === k && samePlayer(r.player, leg.player));
          if (hit) { leg.refPrice = hit.price; leg.refBook = REF_BOOK; }
        }
        an.refEvent = ref.event;
      }
    } catch (e) { console.warn("[hawk] Unibet prices:", e.message); }
    const json = matchJSON(an, sim, squads, legs);
    keep(id, { t: Date.now(), an, legs, json });
    return json;
  }
  // Bet365's current price for every leg of an open match: just the odds,
  // re-fetched (3 small requests), without re-running the simulation.
  async function livePrices(id) {
    const e = matches.get(String(id));
    if (!e) return null;
    const quotes = await odds365(String(id));
    if (!quotes.some((q) => q.book === PRICE_BOOK)) return null;
    return { prices: bookPrices({ quotes }, e.legs), book: PRICE_BOOK, checked: new Date().toISOString() };
  }
  // Upset radar: how likely the underdog is to win (HAWK's chance, blended
  // with the market), and the evidence for and against an upset that the
  // price alone doesn't show. It predicts, it doesn't bet: every signal is a
  // reason the favourite could be weaker (or stronger) than its odds.
  const UPSET_LEVELS = ["Low", "Medium", "High", "Very high"];
  function upsetRadar(an, M, squads, exp) {
    const probs = { home: sumCells(M, (i, j) => i > j), draw: sumCells(M, (i, j) => i === j), away: sumCells(M, (i, j) => i < j) };
    const c = an.cons["1|"], mk = c && ["1", "X", "2"].every((k) => k in c.probs) ? { home: c.probs["1"], draw: c.probs.X, away: c.probs["2"] } : null;
    const ref = mk || probs, fav = ref.home >= ref.away ? "home" : "away", dog = fav === "home" ? "away" : "home";
    const name = { home: an.home, away: an.away }, P = (p) => `${Math.round(100 * p)}%`, signals = [];
    const add = (dir, weight, text) => signals.push({ dir, weight, text });
    // 1. HAWK's own team ratings (goals and xG), before the market blend —
    // only when both teams are rated within the same league.
    if (an.lamModel && an.sameLeague && mk) {
      const Mm = scoreMatrix(...an.lamModel), model = { home: sumCells(Mm, (i, j) => i > j), away: sumCells(Mm, (i, j) => i < j) };
      const gap = model[dog] - mk[dog];
      if (gap >= 0.05) add("up", 1, `HAWK's team ratings (goals & xG) give ${name[dog]} ${P(model[dog])} to win — the bookmakers ${P(mk[dog])}.`);
      else if (gap <= -0.05) add("down", 1, `HAWK's team ratings rate ${name[dog]} lower than the bookmakers (${P(model[dog])} vs ${P(mk[dog])}).`);
    }
    // 2. Money: Bet365's price for the underdog since it opened.
    const q = an.quotes.find((x) => x.book === PRICE_BOOK && x.type === 1), opt = dog === "home" ? "1" : "2";
    if (q && q.opens && q.opens[opt] > 1 && q.prices[opt] > 1) {
      const move = q.prices[opt] / q.opens[opt] - 1, w = Math.abs(move) >= 0.08 ? 1 : 0.5;   // small moves are often noise
      if (move <= -0.05) add("up", w, `Money is coming for ${name[dog]}: Bet365 ${q.opens[opt].toFixed(2)} → ${q.prices[opt].toFixed(2)}.`);
      else if (move >= 0.05) add("down", w, `Money is going against ${name[dog]}: Bet365 ${q.opens[opt].toFixed(2)} → ${q.prices[opt].toFixed(2)}.`);
    }
    // 3. Polymarket's real-money crowd vs the bookmakers.
    if (an.polymarket && mk) {
      const gap = an.polymarket[dog] - mk[dog];
      if (gap >= 0.03) add("up", 0.5, `Polymarket's crowd gives ${name[dog]} ${P(an.polymarket[dog])} — more than the bookmakers' ${P(mk[dog])}.`);
      else if (gap <= -0.03) add("down", 0.5, `Polymarket gives ${name[dog]} only ${P(an.polymarket[dog])}.`);
    }
    // 4. Team news: absent players who've been regulars (270+ minutes in the last 5 games).
    // (Regular = 270+ minutes in the TEAM's last 5 games: someone out since May is already in the odds.)
    const rowsOf = (side) => playerRows(an.players[side === "home" ? 0 : 1]);
    const regularsOut = (side) => {
      const rows = rowsOf(side), names = rows.map((p) => p.name), games = teamGames(rows);
      return ((an.missing || {})[side] || []).filter((m) => m.status === "Missing").map((m) => {
        const hit = names.length ? bestMatch(m.name, names, 0.6) : null, p = hit && rows.find((r) => r.name === hit);
        return p && minutesIn(p.matches, games) >= 270 ? m.name : null;
      }).filter(Boolean);
    };
    const favOut = regularsOut(fav), dogOut = regularsOut(dog);
    if (favOut.length) add("up", favOut.length >= 2 ? 1 : 0.5, `${name[fav]} are missing ${favOut.length} regular${favOut.length === 1 ? "" : "s"}: ${favOut.slice(0, 4).join(", ")}.`);
    if (dogOut.length >= 2) add("down", 0.5, `${name[dog]} are missing ${dogOut.length} regulars: ${dogOut.slice(0, 4).join(", ")}.`);
    // 5. Form: points per game from competitive games in the last 60 days
    // (at least 3 each — in August last season's results aren't form).
    const rf = an.recentForm || {}, ppg = (f) => (f && f.length >= 3 ? [...f].reduce((s, r) => s + (r === "W" ? 3 : r === "D" ? 1 : 0), 0) / f.length : null);
    const fp = ppg(rf[fav]), dp = ppg(rf[dog]);
    if (fp != null && dp != null) {
      if (dp >= fp + 0.5) add("up", 0.5, `${name[dog]} are in better form: ${rf[dog]} (${dp.toFixed(1)} pts a game) vs ${rf[fav]} (${fp.toFixed(1)}).`);
      else if (fp >= dp + 0.8) add("down", 0.5, `${name[fav]} are in much better form: ${rf[fav]} (${fp.toFixed(1)} pts a game) vs ${rf[dog]} (${dp.toFixed(1)}).`);
    }
    // 5b. Chances: does HAWK expect the underdog to create about as many shots
    // on target? Results follow chances — a "weaker" side that matches the
    // favourite for chances is a live upset.
    if (exp && exp.sot && exp.sot[fav === "home" ? 0 : 1] > 0) {
      const sf = exp.sot[fav === "home" ? 0 : 1], sd = exp.sot[dog === "home" ? 0 : 1], r = sd / sf;
      if (r >= 0.85) add("up", 0.5, `HAWK expects ${name[dog]} to create about as many shots on target as ${name[fav]} (${sd.toFixed(1)} v ${sf.toFixed(1)}).`);
      else if (r <= 0.5) add("down", 0.5, `HAWK expects ${name[fav]} to dominate the chances (${sf.toFixed(1)} v ${sd.toFixed(1)} shots on target).`);
    }
    // 5c. Early season: the prices and HAWK's ratings still lean on last
    // season, so a favourite's price is less sure. A caution, not a weight.
    const round = +((an.detail || {}).roundNum) || 0, played = (f) => (f ? f.length : 0);
    if (!CUPS.has(an.league) && ((round && round <= 3) || (played(rf.home) + played(rf.away) <= 2 && !round)))
      add("info", 0, `Early in the season${round ? ` (round ${round})` : ""}: the odds and HAWK's ratings still lean on last season — new signings and managers make any favourite's price less sure.`);
    // 6. Rotation: how many of the favourite's regulars (270+ minutes in the
    // team's last 5 games) are in the lineup. Big favourites lose most often with a
    // changed team — above all in cups.
    const favGames = teamGames(rowsOf(fav)), regulars = (p) => minutesIn(p.recent, favGames) >= 270;
    const favXI = ((squads || {})[fav] || []).filter((p) => p.status === "Starting");
    const known = an.lineups[fav] && an.lineups[fav].status === "Confirmed";
    if (known && favXI.length >= 11 && favXI.some((p) => p.has_data)) {
      const kept = favXI.filter(regulars).length;
      if (kept <= 5) add("up", 1.5, `${name[fav]} have rotated heavily: only ${kept} of their regular starters are in the XI.`);
      else if (kept <= 7) add("up", 1, `${name[fav]} have rotated: ${kept} of their regular starters are in the XI.`);
      else add("down", 0.5, `${name[fav]} are close to full strength (${kept} regulars in the XI).`);
    } else if (CUPS.has(an.league) || /cup|pokal|coppa|copa|coupe/i.test(an.league)) {
      add("up", 0.5, `It's a cup tie — favourites often rotate. Check ${name[fav]}'s lineup when it's out.`);
    }
    // 6b. The second leg of a two-legged tie: who needs what changes how both sides play.
    const tie = tieInfo(an);
    if (tie && tie.leg === 2 && tie.agg) {
      const [ah, aa] = tie.agg, lead = ah > aa ? "home" : aa > ah ? "away" : null, by = Math.abs(ah - aa);
      if (lead) add("info", 0, `2nd leg: ${name[lead]} lead ${Math.max(ah, aa)}–${Math.min(ah, aa)} on aggregate, so ${by >= 2 ? `they go through even losing by ${by - 1}` : "a draw is enough for them"} and ${name[lead === "home" ? "away" : "home"]} must attack${by >= 2 ? ` — they need to win by ${by + 1} to go through in 90 minutes` : ""}. Expect ${name[lead]} to sit deeper; the bookmakers' prices already allow for it.`);
      else add("info", 0, `2nd leg: level on aggregate (${ah}–${aa}) — whoever wins goes through; a draw means extra time.`);
    }
    // 7. Tiredness: days since each side's last game (from their players' match logs).
    const lastGame = (side) => Math.max(0, ...playerRows(an.players[side === "home" ? 0 : 1]).flatMap((p) => p.matches.slice(0, 1).map((x) => x.ts || 0)));
    const kick = an.kickoff ? an.kickoff.getTime() / 1000 : Date.now() / 1000;
    const rest = (side) => { const t = lastGame(side); return t ? (kick - t) / 86400 : null; };
    const favRest = rest(fav), dogRest = rest(dog);
    if (favRest != null && favRest <= 3.5 && (dogRest == null || dogRest >= favRest + 2))
      add("up", 0.5, `${name[fav]} played ${Math.max(1, Math.round(favRest))} day${Math.round(favRest) === 1 ? "" : "s"} ago${dogRest != null ? `; ${name[dog]} have had ${Math.round(dogRest)} days' rest` : ""}.`);
    // (Home advantage isn't a signal: it's already in the odds.)
    // The level: mostly the evidence, plus a little for how live the underdog
    // already is (a 30% underdog adds half a point, a 10% one takes half off).
    const net = signals.reduce((s, x) => s + (x.dir === "up" ? x.weight : x.dir === "down" ? -x.weight : 0), 0);
    const score = net + (probs[dog] - 0.2) * 5;
    const level = score < 0.5 ? 0 : score < 1.5 ? 1 : score < 2.5 ? 2 : 3;
    return { fav, dog, favName: name[fav], dogName: name[dog], dogWin: probs[dog], favFail: 1 - probs[fav], draw: probs.draw,
             marketDog: mk ? mk[dog] : null, open: ref[fav] < 0.42, level, label: UPSET_LEVELS[level], net, signals };
  }

  // Two-legged ties in any competition (European cups, Libertadores, domestic
  // cups, qualifiers): which leg, the aggregate before this game, the first leg's
  // score — and the bookmakers' "To Qualify" (365Scores line type 39, which
  // counts extra time and penalties).
  // Goals each side takes into this game: the first leg's score (0-0 for a one-off tie).
  function preAgg(g, home) {
    if (!(g && g.legNum >= 2)) return [0, 0];
    const r = (g.relatedGames || []).find((x) => x.legNum === 1 && x.statusGroup === 4);
    if (!r) return [0, 0];
    const sc = [Math.trunc(r.homeCompetitor.score) || 0, Math.trunc(r.awayCompetitor.score) || 0];
    return nameSimilarity(r.homeCompetitor.name, home) >= nameSimilarity(r.awayCompetitor.name, home) ? sc : [sc[1], sc[0]];
  }
  // A level tie after 90 minutes goes to extra time and penalties: the better
  // side wins it a bit more often than not (a coin flip pulled towards their 90-minute edge).
  const etShare = (pH, pA) => 0.5 + ((pH / Math.max(pH + pA, 1e-9)) - 0.5) * 0.6;
  function tieInfo(an) {
    const g = an.detail || {}, hc = g.homeCompetitor || {}, ac = g.awayCompetitor || {};
    if (g.legNum === 1) return { leg: 1, stage: g.stageName || null };
    if (!(g.legNum >= 2)) return null;
    const r = (g.relatedGames || []).find((x) => x.legNum === 1 && x.statusGroup === 4);
    const first = r ? { home: r.homeCompetitor.name, away: r.awayCompetitor.name, score: [Math.trunc(r.homeCompetitor.score) || 0, Math.trunc(r.awayCompetitor.score) || 0] } : null;
    // The aggregate before kick-off (365Scores' own, or the first leg's score for each club).
    let agg = hc.aggregatedScore != null && ac.aggregatedScore != null ? [Math.trunc(hc.aggregatedScore), Math.trunc(ac.aggregatedScore)] : null;
    if (first && (!agg || an.inPlay)) agg = nameSimilarity(first.home, an.home) >= nameSimilarity(first.home, an.away) ? first.score : [first.score[1], first.score[0]];
    const q = an.cons["39|"], b = an.quotes.find((x) => x.type === 39 && x.book === PRICE_BOOK);
    return { leg: 2, stage: g.stageName || null, agg, first,
             qualify: q && q.probs["1"] != null && q.probs["2"] != null ? { home: q.probs["1"], away: q.probs["2"] } : null,
             qualifyPrice: b ? { home: b.prices["1"] || null, away: b.prices["2"] || null } : null };
  }
  function matchJSON(an, sim, squads, legs) {
    const M = an.M;
    const grid = [0, 1, 2, 3, 4].map((i) => [0, 1, 2, 3, 4].map((j) => sumCells(M, (a, b) => (i < 4 ? a === i : a >= 4) && (j < 4 ? b === j : b >= 4))));
    const c1x2 = an.cons["1|"];
    const market = c1x2 && ["1", "X", "2"].every((k) => k in c1x2.probs)
      ? { home: c1x2.probs["1"], draw: c1x2.probs.X, away: c1x2.probs["2"], sources: c1x2.books } : null;
    // HAWK's own ratings (goals & xG), before blending with the market.
    const Mm = an.lamModel && an.sameLeague ? scoreMatrix(...an.lamModel) : null;
    const model = Mm ? { home: sumCells(Mm, (i, j) => i > j), draw: sumCells(Mm, (i, j) => i === j), away: sumCells(Mm, (i, j) => i < j) } : null;
    const prices = bookPrices(an, legs), opens = bookPrices(an, legs, PRICE_BOOK, "opens");
    // Keep Bet365's prices on the legs themselves too: "Value first" builds use them.
    for (const [id, leg] of Object.entries(legs)) {
      leg.bookPrice = prices[id] || null; leg.bookOpen = opens[id] || null;
      leg.agree = marketAgrees(leg);
    }
    const legJSON = Object.values(legs).map(({ arr, ...rest }) => rest);
    const value = legJSON.filter((l) => l.bookPrice && l.bookPrice > l.fair * 1.02)
      .map((l) => ({ label: l.label, price: l.bookPrice, p: l.p, edge: l.bookPrice / l.fair - 1 })).sort((a, b) => b.edge - a.edge).slice(0, 5);
    const tableRow = (c) => { const r = an.table[c.id]; return r ? { position: r.position, points: r.points } : null; };
    return {
      id: an.id, league: an.league, home: an.home, away: an.away, homeCrest: crest(an.homeComp), awayCrest: crest(an.awayComp),
      kickoff: an.kickoff ? an.kickoff.toISOString() : null, started: an.inPlay, referee: an.referee,
      // guess: 365Scores had no lineup yet, so HAWK picked the XI from the team's last 5 games
      lineups: Object.fromEntries(Object.entries(an.lineups).map(([s, v]) => [s, { ...v, guess: !!(an.lineupGuess || {})[s],
                                                                                   check: (an.lineupCheck || {})[s] || null }])),
      probs: { home: sumCells(M, (i, j) => i > j), draw: sumCells(M, (i, j) => i === j), away: sumCells(M, (i, j) => i < j),
               market, polymarket: an.polymarket, model, mix: { market: an.marketW, ignored: !!an.ignored } },
      expected: sim.exp, grid, table: { home: tableRow(an.homeComp), away: tableRow(an.awayComp) }, form: an.form,
      legs: legJSON, priceBook: PRICE_BOOK,
      players: Object.fromEntries(Object.entries(squads).map(([side, sq]) => [side, sq.map((p) => ({
        name: p.name, pos: p.pos, status: p.status, photo: p.photo, photo2: p.photo2 || null, start_p: p.start_p, doubtful: p.doubtful, sh90: p.sh90, sot90: p.sot90,
        g90: p.g90, c90: p.c90, x: p.x, sv90: p.sv90, minutes: p.minutes, has_data: p.has_data, recent: p.recent,
        recent_starts: p.recent_starts, field: p.field, num: p.num, short: p.short, teamMins: p.teamMins }))])),
      warnings: an.warnings, value: { book: PRICE_BOOK, legs: value }, sims: sim.n, missing: an.missing || { home: [], away: [] },
      upset: upsetRadar(an, M, squads, sim.exp), tie: tieInfo(an),
    };
  }
  function entryFor(id) {
    const e = matches.get(String(id));
    if (!e) throw new Error("match not loaded — open it again");
    keep(String(id), e);
    return e;
  }
  function build(body) {
    const e = entryFor(body.id);
    body = withPriced(e, body);
    return autoBuild(e.legs, +body.target || 3, body.style, +body.maxLegs || 10, body.locked || [], new Set(body.banned || []),
                     body.favourite !== false, body.focus || "Mix", !!body.extras, body.picks === "value" ? "value" : "likely", new Set(body.known || []));
  }
  const evaluateBody = (body) => evaluate(entryFor(body.id).legs, body.legs || []);
  const buildBodyPriced = (body) => { const e = entryFor(body.id); return withPriced(e, body); };
  // "Build again": up to `count` different tickets for the same settings. The
  // first is the normal build; the others come from building again with one
  // of its legs (or all of them) left out, and so on, keeping only tickets
  // that still reach the target. They're picked to differ from each other as
  // much as possible, best first (fewest legs = least bookmaker margin).
  // What a ticket is worth at Bet365: its chance × the price HAWK expects Bet365
  // to show. 1.02+ is "✅ worth it", 0.95+ a "🤏 fair price" (small cut), lower is underpaid.
  // A leg HAWK rates far likelier than the bookies' price says only counts as up to
  // 12% over the price's chance, so "worth it" never rests on HAWK out-guessing the market alone.
  // (evaluate() stores it as `check`.)
  const worthOf = (t) => { const x = t.b365 || t.price || null; return x && t.p ? t.p * x * (t.check || 1) : 0; };
  // Tickets for one match, the ones worth betting at Bet365 first. HAWK tries the
  // likeliest legs AND the best-value legs, in your style and the two next to it,
  // then swaps out each leg in turn — many different tickets — and ranks them:
  // worth it at Bet365 first (most value, then likeliest), then the nearest misses.
  // Tickets far from your target price are left out.
  function searchOptions(e, params, count = 5, depth = 2) {
    const target = +params.target || 3, locked = params.locked || [], known = new Set(params.known || []);
    const base = new Set(params.banned || []), key = (t) => t.legs.map((l) => l.id).sort().join("|");
    const styles = [...new Set([STYLES[params.style] ? params.style : "Balanced", "Balanced", params.style === "Punchy" ? "Balanced" : "Banker"])];
    const at = (t) => t.b365 || t.price || t.fair;
    const near = (t) => t.legs.length && at(t) >= target * 0.9 && at(t) <= target * 1.6;
    const free = (t) => t.legs.map((l) => l.id).filter((id) => !locked.includes(id) && e.legs[id].group !== "result");
    const found = new Map();
    const run = (style, picks, banned) => {
      const t = autoBuild(e.legs, target, style, +params.maxLegs || 10, locked, banned, params.favourite !== false, params.focus || "Mix", !!params.extras, picks, known);
      if (t.legs.length && !found.has(key(t))) found.set(key(t), t);
      return t;
    };
    for (const style of styles) for (const picks of ["value", "likely"]) {
      const first = run(style, picks, base);
      if (depth < 1 || !first.legs.length) continue;
      for (const id of free(first)) {
        const t = run(style, picks, new Set([...base, id]));
        if (depth >= 2) for (const id2 of free(t).filter((x) => x !== id).slice(0, 2)) run(style, picks, new Set([...base, id, id2]));
      }
    }
    let pool = [...found.values()];
    if (!pool.length) return [run(styles[0], params.picks === "value" ? "value" : "likely", base)];
    const close = pool.filter(near);
    if (close.length) pool = close;
    // Score: value at Bet365 counts most, then the chance to land, then few guessed prices and a price close to the target.
    const score = (t) => { const w = worthOf(t);
      return (w >= 1.02 ? 10 : 0) + w * 3 + (t.p || 0) - 0.08 * (t.guessed || 0) - 0.15 * Math.abs(Math.log(at(t) / target)); };
    pool.sort((x, y) => score(y) - score(x));
    const chosen = [];
    for (const t of pool) {
      if (chosen.length >= count) break;
      // as different as possible from the ones already chosen
      if (chosen.some((c) => t.legs.filter((l) => c.legs.some((x) => x.id === l.id)).length >= Math.max(2, t.legs.length - 1))) continue;
      chosen.push(t);
    }
    for (const t of pool) { if (chosen.length >= count) break; if (!chosen.includes(t)) chosen.push(t); }
    return chosen.map((t) => ({ ...t, worth: +worthOf(t).toFixed(3) }));
  }
  // 🎯 Auto: no target odds to pick. HAWK tries a few targets (about 2, 2.75 and
  // 3.75) with up to your max legs, keeps only builders that land at least 1 time in 4,
  // and puts the ones worth it at Bet365 first (then fair price, then the rest),
  // best value and likeliest first within each.
  const AUTO_TARGETS = [2, 2.75, 3.75], AUTO_MIN_P = 0.25;
  // "At least 2.00": Bet365 pays about a tenth less per leg than the fair price,
  // so HAWK aims a bit above what you asked for and keeps only the builds whose
  // expected Bet365 price really clears it — likeliest first.
  // Aiming well above your "at least" costs chance for payout you didn't ask
  // for: at 2.00+ it was only ever trying 2.30, 2.90 and 3.80, so the likeliest
  // ticket that just clears 2.00 was never built. It aims just over the line
  // first now, and keeps the higher aims for the other options.
  const minTargets = (min) => [min * 1.04, min * 1.15, min * 1.45, min * 1.9];
  // How far below your "at least" a build may look on HAWK's guess and still be
  // shown: measured on 44 checked builds, Bet365 came in above HAWK's estimate
  // on 13 of them, by as much as a third. A likelier ticket that clears 2.00
  // only once the real price is seen is worth more than one that never clears.
  // 0.88, not 0.72: a build HAWK guesses at 1.76 can still pay 2.00 at Bet365,
  // and a third of them beat the guess by about that much. Any looser and
  // "at least 2.00" starts handing back tickets guessing 1.45, which is the
  // filter lying in the other direction.
  const B365_GUESS_LOW = 0.88;
  // The "lands 1 in 4" floor is for when HAWK picks the odds itself. Once you
  // ask for a price, it would just rule everything out (nothing paying 8.00
  // lands 1 in 4), so it's dropped — HAWK shows the likeliest build that pays
  // what you asked for, with its real chance, and the verdict says the rest.
  const minChance = (min) => (min ? 0 : AUTO_MIN_P);
  function autoOptions(e, params, count = 5, depth = 0) {
    const found = new Map(), maxLegs = +params.maxLegs || 6;
    const min = +params.minOdds || 0;   // "at least these odds"
    const onlyWorth = !!params.onlyWorth;   // and only ones HAWK would back
    const exact = Math.min(12, Math.max(0, +params.exactLegs || 0));
    for (const target of (exact ? [999] : min ? minTargets(min) : AUTO_TARGETS))
      for (const t of searchOptions(e, { ...params, target, maxLegs: exact || maxLegs }, count, depth)) {
        const k = t.legs.map((l) => l.id).sort().join("|");
        if (!t.legs.length || !(t.p >= (exact ? 0 : minChance(min))) || found.has(k)) continue;
        if (exact && t.legs.length !== exact) continue;      // not the number of legs you asked for
        if (!exact && t.legs.length < 2) continue;           // it's a builder: a single isn't one
        if (min && !((t.b365 || t.fair) >= min * B365_GUESS_LOW)) continue;   // below the odds you asked for, allowing for the guess being out
        if (onlyWorth && worthOf(t) < 1.02) continue;          // not one HAWK would back
        found.set(k, { ...t, autoTarget: target });
      }
    const tier = (t) => { const w = worthOf(t); return w >= 1.02 ? 2 : w >= 0.95 ? 1 : 0; };
    // Option 1 is the one you'd actually want: of the builders that Bet365 pays
    // for, the likeliest. Ranking on chance alone used to hand you a ticket that
    // underpaid just because it landed one point more often.
    return [...found.values()].sort((a, b) => tier(b) - tier(a) || (min ? b.p - a.p
      : (worthOf(b) + 0.5 * b.p) - (worthOf(a) + 0.5 * a.p))).slice(0, count);
  }
  // "Only legs Bet365 prices": leave out every leg whose price HAWK has to guess
  // (player props — no free feed has Bet365's). What's left are legs 365Scores
  // carries Bet365's own price for, so HAWK's expected builder price is built
  // from real numbers and lands far closer to what you'll see on Bet365.
  // What this option is really for is keeping PLAYER PROPS out, because Bet365
  // marks those up about 27% a leg (measured blind, 20 Sep). It is not for
  // keeping out every leg our feed lacks a price for: 365Scores doesn't carry
  // some corners and cards lines that Bet365 prices perfectly normally, and
  // excluding those threw away good match markets — including the Under 9.5
  // Corners leg at 1.49 that made the first green bet in the record.
  // So: props go, match markets stay even when HAWK has to estimate the leg.
  const unpricedIds = (e, typed) => Object.values(e.legs)
    .filter((l) => isProp(l) && !(l.bookPrice > 1) && !typed.has(l.id)).map((l) => l.id);
  const withPriced = (e, body) => (body.priced
    ? { ...body, banned: [...(body.banned || []), ...unpricedIds(e, new Set(body.typed || []))] } : body);
  // The scan's cheap version of 🎯 Auto: one build per target in your own style,
  // best of the three (worth it at Bet365 first, then the likeliest). Scanning
  // dozens of matches can't afford the builder's full search.
  // It builds one per target anyway and used to throw all but the best away.
  // Those are the other options for the match — a different price, a different
  // shape — so they're kept and ranked instead.
  function autoTop(e, params, count = 1) {
    const maxLegs = +params.maxLegs || 6, banned = new Set(params.banned || []), known = new Set(params.known || []);
    const min = +params.minOdds || 0;   // "at least these odds": a bigger payout, still the likeliest that pays it
    const onlyWorth = !!params.onlyWorth;
    const exact = Math.min(12, Math.max(0, +params.exactLegs || 0));
    const found = new Map();
    // Worth-it hunting needs more than three tries: the ticket that clears the
    // cut is usually two legs, not the one that happens to hit a round target.
    let targets = exact ? [999]   // no price to aim at: stack until there are `exact` legs
                : onlyWorth ? [1.6, 2, 2.5, 3, 3.75, 5].filter((t) => !min || t >= min).concat(min ? minTargets(min) : [])
                : (min ? minTargets(min) : AUTO_TARGETS);
    // Asked for more than one? Look at more prices and build the other way round
    // as well (likeliest legs / legs with value) — otherwise every try comes
    // back with the same ticket and there's nothing to choose between.
    const base = params.picks === "value" ? "value" : "likely";
    const modes = count > 1 ? [base, base === "value" ? "likely" : "value"] : [base];
    if (count > 1 && !exact) targets = [...new Set([...targets, ...targets.map((t) => +(t * 1.7).toFixed(2))])];
    for (const target of targets) for (const picks of modes) {
      const t = autoBuild(e.legs, target, params.style, exact || maxLegs, params.locked || [], banned,
                          params.favourite !== false, params.focus || "Mix", !!params.extras, picks, known);
      if (!t.legs.length || !(t.p >= (exact ? 0 : minChance(min)))) continue;
      if (exact && t.legs.length !== exact) continue;      // not the number of legs you asked for
      if (!exact && t.legs.length < 2) continue;           // it's a builder: a single isn't one
      // "At least 2.00" is about the price Bet365 ends up showing, and HAWK's
      // guess at that is its weakest number — out by up to a third either way.
      // Throwing a build out on the guess hides the likeliest tickets that do
      // clear once checked, so the gate is widened by the size of the error and
      // the card asks you to check the real price.
      // Asking for a number of legs used to throw your odds floor away, so
      // "exactly 2 legs, at least 2.00" handed back 2-leg tickets paying 1.16.
      // Both are your terms: they both apply.
      if (min && !((t.b365 || t.fair) >= min * B365_GUESS_LOW)) continue;
      const w = worthOf(t);
      if (onlyWorth && w < 1.02) continue;   // not one HAWK would back: don't offer it
      const k = t.legs.map((l) => l.id).sort().join("|");
      if (found.has(k)) continue;            // the same ticket from another target
      found.set(k, { ...t, worth: +w.toFixed(3), autoTarget: target,
                     rank: min && !onlyWorth ? [0, t.p] : [w >= 1.02 ? 2 : w >= 0.95 ? 1 : 0, w + 0.5 * t.p] });
    }
    const pool = [...found.values()].sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1]);
    const chosen = [];
    for (const t of pool) {
      if (chosen.length >= count) break;
      // One ticket sitting inside another isn't a second option — but sharing
      // the result leg and going a different way after it is.
      if (chosen.some((c) => t.legs.filter((l) => c.legs.some((x) => x.id === l.id)).length
                             >= Math.max(2, Math.min(t.legs.length, c.legs.length)))) continue;
      chosen.push(t);
    }
    return chosen.map(({ rank, ...t }) => t);
  }
  const autoBest = (e, params) => autoTop(e, params, 1)[0] || null;
  function buildOptions(body, count = 5) {
    if (body.auto) { const e0 = entryFor(body.id); return { options: autoOptions(e0, withPriced(e0, body), count, 0) }; }
    const e = entryFor(body.id);
    return { options: searchOptions(e, withPriced(e, body), count, 2) };
  }

  // Head to head: the last 5 finished meetings of the two clubs (any
  // competition), each with its corners, cards and shots on target. Past
  // games don't change, so their stats are cached for a day.
  async function h2h(id) {
    const d = await s365("games/h2h", { gameId: id }, 30 * 60 * 1000);
    const g = d && d.game;
    if (!g || !g.homeCompetitor) throw new Error("365Scores didn't return the head to head");
    const past = (g.h2hGames || []).filter((x) => x.statusGroup === 4 && String(x.id) !== String(id)
      && x.homeCompetitor.score >= 0 && x.awayCompetitor.score >= 0 && !/postpon|cancel|abandon/i.test(x.statusText || "")).slice(0, 5);
    const games = await Promise.all(past.map(async (x) => {
      const st = await s365("game/stats", { games: x.id }, 24 * 3600 * 1000);
      const one = (name, cid) => { const s = ((st && st.statistics) || []).find((v) => v.name === name && v.competitorId === cid); return s ? parseFloat(s.value) || 0 : null; };
      const pair = (name) => { const a = one(name, x.homeCompetitor.id), b = one(name, x.awayCompetitor.id); return a == null && b == null ? null : [a || 0, b || 0]; };
      const yellow = pair("Yellow Cards"), red = pair("Red Cards") || [0, 0];
      return { id: String(x.id), date: x.startTime, comp: x.competitionDisplayName || "", home: x.homeCompetitor.name, away: x.awayCompetitor.name,
               // true when today's home side was at home in that meeting
               sameVenue: x.homeCompetitor.id === g.homeCompetitor.id,
               score: [Math.trunc(x.homeCompetitor.score), Math.trunc(x.awayCompetitor.score)],
               // Booking points, the way a card market settles: yellow 1, red 2.
               corners: pair("Corners"), cards: yellow ? [yellow[0] + 2 * red[0], yellow[1] + 2 * red[1]] : null, sot: pair("Shots On Target") };
    }));
    return { home: g.homeCompetitor.name, away: g.awayCompetitor.name, games };
  }

  async function lineups(id) {
    const d = await s365("game", { gameId: id });
    const g = (d && d.game) || {};
    const st = { home: ((g.homeCompetitor || {}).lineups || {}).status, away: ((g.awayCompetitor || {}).lineups || {}).status };
    let confirmed = st.home === "Confirmed" && st.away === "Confirmed", source = confirmed ? "365Scores" : null;
    // Not confirmed on 365Scores yet? ESPN may already have the official XIs.
    if (!confirmed && g.startTime && Date.parse(g.startTime) - Date.now() < 3 * 3600e3 && g.homeCompetitor && LEAGUE_OF[g.competitionId]) {
      const e = await espnLineups(LEAGUE_OF[g.competitionId], g.homeCompetitor.name, g.awayCompetitor.name, new Date(g.startTime)).catch(() => null);
      if (e && e.confirmed) { confirmed = true; source = "ESPN"; }
    }
    return { ...st, confirmed, source, started: !!(g.startTime && new Date(g.startTime) < new Date()) };
  }

  // Background jobs over every fixture in a time window, two matches at a
  // time: the "Best builders" scan and the Value finder.
  function newJob() { return { running: false, stop: false, total: 0, done: 0, errors: 0, results: [], params: null }; }
  const jobStatus = (job) => ({ ...job, results: job.results.slice() });
  function windowParams(body) {
    return { leagues: (body.leagues || []).filter((l) => LEAGUES.includes(l)), hours: Math.min(Math.max(+body.hours || 24, 1), 168) };
  }
  async function runFixtureJob(job, perMatch) {
    scanSims = true;   // lighter simulations while a scan is running
    const now = Date.now(), horizon = now + job.params.hours * 3600 * 1000, todo = [];
    for (const league of job.params.leagues) {
      let list = [];
      try { list = await fixtures(league); } catch { job.errors++; }
      for (const f of list) { const ko = f.kickoff ? new Date(f.kickoff).getTime() : 0; if (ko > now && ko <= horizon) todo.push([league, f]); }
    }
    todo.sort((a, b) => (a[1].kickoff || "").localeCompare(b[1].kickoff || ""));
    job.total = todo.length;
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !job.stop) {
        const [league, f] = todo[next++], id = String(f.id);
        try { const json = await match(league, id); perMatch(league, f, json, matches.get(id)); }
        catch (err) { console.warn("[hawk] skipped", f.home, "v", f.away, err.message); job.errors++; }
        // Don't keep scanned matches around (memory), only ones you opened.
        matches.delete(id);   // scan-quality simulations are never kept
        job.done++;
        await sleep(0);   // hand the screen back between matches
      }
    };
    await Promise.all([worker(), worker()]);
    scanSims = false;
    job.running = false;
  }
  const fixtureInfo = (league, f, json) => ({ league, id: String(f.id), home: f.home, away: f.away, homeCrest: f.homeCrest,
    awayCrest: f.awayCrest, kickoff: f.kickoff, confirmed: json.lineups.home.status === "Confirmed" && json.lineups.away.status === "Confirmed" });

  const scan = newJob();
  function startScan(body) {
    if (scan.running) return jobStatus(scan);
    const params = { ...windowParams(body), target: Math.min(Math.max(+body.target || 3, 1.2), 50),
                     style: STYLES[body.style] ? body.style : "Balanced", focus: FOCUS[body.focus] ? body.focus : "Mix",
                     maxLegs: Math.min(Math.max(+body.maxLegs || 10, 2), 12), extras: !!body.extras, picks: body.picks === "value" ? "value" : "likely", auto: !!body.auto, priced: !!body.priced,
                     minOdds: Math.min(Math.max(+body.minOdds || 0, 0), 20), onlyWorth: !!body.onlyWorth, exactLegs: +body.exactLegs || 0, typed: body.typed || [],
                     options: Math.min(4, Math.max(1, +body.options || 1)) };
    Object.assign(scan, newJob(), { running: true, params });
    runFixtureJob(scan, (league, f, json, e) => {
      // The best ticket for this match (worth betting at Bet365 first), from a quicker search than the builder's.
      const p2 = withPriced(e, { ...params, favourite: true, known: params.known || [] });
      // More than one when you've asked for options: the same match, built a
      // different way, so there's something to choose between.
      const list = params.auto ? autoTop(e, p2, params.options) : searchOptions(e, p2, params.options, 1);
      const t = list[0];
      if (!t) return;   // 🎯 Auto: nothing here lands 1 in 4 or better
      // How much the legs move together — the one quantity a 12,000-match
      // simulation can read better than a bookmaker's parametric rule, and so
      // the only place a builder could be mispriced in your favour.
      const agreeOf = (x) => { const pp = x.legs.reduce((a, r) => a * (e.legs[r.id] || { p: 1 }).p, 1);
                               return pp > 0 ? +(x.p / pp).toFixed(3) : null; };
      scan.results.push({ ...fixtureInfo(league, f, json), p: t.p, fair: t.fair, b365: t.b365 || null, b365raw: t.b365raw || null, check: t.check || 1, worth: +worthOf(t).toFixed(3), guessed: t.guessed || 0,
        agree: agreeOf(t),
        legs: t.legs.map((r) => legSummary(e, json, r.id)),
        alts: list.slice(1).map((x) => ({ p: x.p, fair: x.fair, b365: x.b365 || null, b365raw: x.b365raw || null, check: x.check || 1,
                                          worth: +worthOf(x).toFixed(3), guessed: x.guessed || 0, agree: agreeOf(x),
                                          legs: x.legs.map((r) => legSummary(e, json, r.id)) })),
        value: json.value.legs.slice(0, 4).map((v) => ({ label: v.label, price: v.price, edge: v.edge })),
        // Single bets at Bet365's own price that beat HAWK's chance — no builder
        // cut, nothing to guess. Only ones that land often enough to be real.
        // One pick per match, whatever the match: the result / double chance /
        // handicap leg at Bet365's own price that's worth the most (even when
        // that's still under fair — the card says so).
        pick: (() => {
          const rows = json.legs.filter((l) => l.bookPrice > 1.01 && l.p >= 0.3 && /Full Time Result|Double Chance|Handicap|Draw No Bet/.test(l.market))
            .map((l) => ({ id: l.id, label: l.label, market: l.market, price: l.bookPrice, p: l.p, edge: l.bookPrice * l.p - 1 }))
            .sort((a, b) => b.edge - a.edge);
          return rows[0] || null;
        })(),
        singles: json.legs.filter((l) => l.bookPrice > 1.01 && l.p >= 0.25 && l.bookPrice * l.p >= 1.02)
          .map((l) => ({ id: l.id, label: l.label, market: l.market, price: l.bookPrice, p: l.p, edge: l.bookPrice * l.p - 1 }))
          .sort((a, b) => b.edge - a.edge).slice(0, 6) });
    });
    return jobStatus(scan);
  }
  // What an acca needs to remember about one leg once the match isn't loaded.
  function legSummary(e, json, id) {
    const l = e.legs[id], j = json.legs.find((x) => x.id === id) || {};
    return { id, label: l.label, market: l.market, kind: l.kind, p: l.p, pRaw: l.pRaw, fair: l.fair, bookPrice: j.bookPrice || null,
             player: l.player || null, side: l.side || null,
             // for the acca cards: face, form, Unibet's price, Bet365's wording, Early Payout
             photo: l.photo || null, refPrice: l.refPrice || null, b365: l.b365 || null, ep: !!l.ep, pNoEp: l.pNoEp ?? null,
             hits: l.hits ?? null, games: l.games ?? null, basis: l.basis || null };
  }

  // Monster Acca: one part per fixture, then the page picks the best ones.
  //  1 leg per match: the single Bet365-priced match leg whose price is
  //    closest to (or above) fair, so the acca's price is known exactly
  //    (Bet365 multiplies the singles' prices).
  //  2–4 legs per match: a small bet builder per match (priced by the bookmaker).
  const monster = newJob(), MIN_ACCA_PRICE = 1.15;
  function startMonster(body) {
    if (monster.running) return jobStatus(monster);
    const params = { ...windowParams(body), style: STYLES[body.style] ? body.style : "Banker", focus: FOCUS[body.focus] ? body.focus : "Mix",
                     perMatch: Math.min(Math.max(+body.perMatch || 1, 1), 4), extras: !!body.extras };
    Object.assign(monster, newJob(), { running: true, params });
    const [lo, hi] = STYLES[params.style];
    runFixtureJob(monster, (league, f, json, e) => {
      if (json.started) return;
      const info = fixtureInfo(league, f, json);
      if (params.perMatch === 1) {
        // Every Bet365-priced match leg in the style's range, best first (Bet365
        // paying closest to — or above — fair). The first is used; the rest are
        // this match's "other leg" options. Below 1.15 a leg adds risk but
        // hardly any odds, so it's left out.
        // Ranked on HAWK's chance, but counted as at most 3% over the chance Bet365's own price
        // implies (its ~5% margin taken off): otherwise the legs HAWK disagrees with the bookies
        // on most (cards, mostly) always look best — and those are where HAWK is least sure.
        // Near-ties (within 1%) go to the likelier leg.
        const ranked = json.legs.filter((leg) => leg.bookPrice && leg.bookPrice >= MIN_ACCA_PRICE && leg.kind === "match" && leg.p >= lo && leg.p <= hi)
          .map((leg) => ({ leg, ratio: leg.bookPrice * Math.min(leg.p, (1.03 / leg.bookPrice) / 1.05) }))   // above 1 = Bet365 pays more than fair
          .sort((a, b) => Math.round(100 * b.ratio) - Math.round(100 * a.ratio) || b.leg.p - a.leg.p);
        // One per group: "Over 2.5" and "Over 1.5 goals" aren't two different options.
        const seen = new Set(), alts = [];
        for (const { leg, ratio } of ranked) {
          if (seen.has(leg.group) || alts.length >= 6) continue;
          seen.add(leg.group);
          alts.push({ legs: [legSummary(e, json, leg.id)], p: leg.p, fair: leg.fair, bookPrice: leg.bookPrice, ratio });
        }
        if (alts.length) monster.results.push({ ...info, ...alts[0], alts, upset: json.upset });
      } else {
        const t = autoBuild(e.legs, 1e6, params.style, params.perMatch, [], new Set(), true, params.focus, params.extras);
        if (t.legs.length) monster.results.push({ ...info, legs: t.legs.map((r) => legSummary(e, json, r.id)), p: t.p, fair: t.fair,
                                                  bookPrice: null, ratio: null, upset: json.upset });
      }
    });
    return jobStatus(monster);
  }

  // Current Bet365 prices for legs in any matches (price alerts, acca legs):
  // items [{match, leg}] -> {"match|leg": price}. One odds request per match.
  async function legPrices(items) {
    const byMatch = {};
    for (const it of items || []) (byMatch[String(it.match)] ||= new Set()).add(it.leg);
    const out = {};
    for (const [id, legIds] of Object.entries(byMatch)) {
      const quotes = await odds365(id);
      const prices = bookPrices({ quotes }, Object.fromEntries([...legIds].map((l) => [l, true])));
      for (const [leg, price] of Object.entries(prices)) out[`${id}|${leg}`] = price;
      await sleep(250); // go easy on 365Scores
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Every-market fair odds (Value finder)
  //
  // Each selection is priced exactly from the model rather than from the
  // simulation (whose ~±0.5% noise matters when hunting 2–5% edges), then
  // blended with the de-margined consensus of all bookmakers for that same
  // line, like the builder does. Markets HAWK doesn't model (offsides,
  // penalties, red cards) use the consensus alone, so a price there is
  // "value" when one bookmaker is out of line with the others.
  //
  // Bets that can push (whole lines, Asian handicaps, draw no bet) are
  // handled by q = the win share of the money that isn't refunded, so the
  // fair price is 1 / q and the edge is price × q − 1.
  // ---------------------------------------------------------------------------
  const HALF_SHARE = 0.45; // share of goals in the first half (top-league average is ~44–46%)

  function distFromMatrix(M, fn) {  // distribution of fn(i, j) over the score matrix
    const d = new Map();
    for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) { const x = fn(i, j); d.set(x, (d.get(x) || 0) + M[i][j]); }
    return d;
  }
  function poissonDist(lam) { const d = new Map(); for (let k = 0; k < 60; k++) d.set(k, pmf(lam, k)); return d; }
  // {q, d} for "X over line" (or under) on a discrete distribution, with
  // pushes on whole lines and quarter lines split into two half-stakes.
  function lineBet(dist, line, over) {
    const parts = Math.abs(line * 4 % 2) === 1 ? [line - 0.25, line + 0.25] : [line];
    let win = 0, lose = 0;
    for (const L of parts) for (const [x, p] of dist) {
      if (x === L) continue;
      if ((x > L) === over) win += p; else lose += p;
    }
    return win + lose > 0 ? { q: win / (win + lose), d: (win + lose) / parts.length } : null;
  }
  function halfMatrix(an, share) {
    const ph = pmfRow(an.lamBlend[0] * share), pa = pmfRow(an.lamBlend[1] * share);
    return ph.map((x) => pa.map((y) => x * y));
  }
  const score = (v) => { const m = /^(\d+)\s*-\s*(\d+)$/.exec(v || ""); return m ? [+m[1], +m[2]] : null; };
  const result3 = (M, opt) => { const t = { 1: (i, j) => i > j, X: (i, j) => i === j, 2: (i, j) => i < j }[opt]; return t ? { q: sumCells(M, t), d: 1 } : null; };

  // HAWK's model price for one selection, or null if it doesn't model it.
  function selectionModel(an, exp, type, value, option) {
    const M = an.M, v = parseFloat(value), yes = option === "Yes";
    const simple = (q) => (q > 0 && q < 1 ? { q, d: 1 } : null);
    switch (type) {
      case 1: return result3(M, option);
      case 14: { const t = { "1X": (i, j) => i >= j, "12": (i, j) => i !== j, X2: (i, j) => i <= j }[option]; return t ? simple(sumCells(M, t)) : null; }
      case 15: { const w = sumCells(M, (i, j) => i > j), l = sumCells(M, (i, j) => i < j); return option === "Home" ? { q: w / (w + l), d: w + l } : option === "Away" ? { q: l / (w + l), d: w + l } : null; }
      case 3: return Number.isFinite(v) && (option === "Over" || option === "Under") ? lineBet(distFromMatrix(M, (i, j) => i + j), v, option === "Over") : null;
      case 11: // value = the home team's handicap
        return Number.isFinite(v) && (option === "Home" || option === "Away") ? lineBet(distFromMatrix(M, (i, j) => i - j), -v, option === "Home") : null;
      case 12: return simple(sumCells(M, (i, j) => (i > 0 && j > 0) === yes));
      case 144: return simple(sumCells(M, (i, j) => (j === 0) === yes));
      case 145: return simple(sumCells(M, (i, j) => (i === 0) === yes));
      case 7: { // given the final score, every order of the goals is equally likely
        if (option === "No Goal") return simple(M[0][0]);
        if (option !== "Home" && option !== "Away") return null;
        let s = 0;
        for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++)
          if (i + j) s += (M[i][j] * (option === "Home" ? i : j)) / (i + j);
        return simple(s);
      }
      case 126: { const s = score(value); return s && yes && s[0] <= MAX_GOALS && s[1] <= MAX_GOALS ? simple(M[s[0]][s[1]]) : null; }
      case 5: return result3(halfMatrix(an, HALF_SHARE), option);
      case 6: return result3(halfMatrix(an, 1 - HALF_SHARE), option);
      case 9: return Number.isFinite(v) && (option === "Over" || option === "Under") ? lineBet(distFromMatrix(halfMatrix(an, HALF_SHARE), (i, j) => i + j), v, option === "Over") : null;
      case 13: return simple(sumCells(halfMatrix(an, 1 - HALF_SHARE), (i, j) => (i > 0 && j > 0) === yes));
      case 127: { const s = score(value); return s && yes ? simple(halfMatrix(an, HALF_SHARE)[s[0]][s[1]]) : null; }
      case 137: case 141: case 139: {
        const lam = type === 137 ? exp.corners : type === 141 ? exp.cards[0] + exp.cards[1] : exp.sot[0] + exp.sot[1];
        return Number.isFinite(v) && (option === "Over" || option === "Under") ? lineBet(poissonDist(lam), v, option === "Over") : null;
      }
    }
    return null;
  }

  function marketLabel(type, market, value, option, home, away) {
    const team = (o) => ({ 1: home, Home: home, 2: away, Away: away, X: "Draw" }[o] || o);
    const fmt = (x) => (x > 0 ? `+${x}` : `${x}`);
    const v = parseFloat(value);
    switch (type) {
      case 1: return `Result: ${team(option)}`;
      case 14: return { "1X": `${home} or Draw`, X2: `${away} or Draw`, "12": `${home} or ${away}` }[option] || option;
      case 15: return `Draw No Bet: ${team(option)}`;
      case 3: return withCount(`${option} ${value} Goals`, option, value);
      case 11: return `Asian Handicap: ${option === "Home" ? `${home} ${fmt(v)}` : `${away} ${fmt(-v)}`}`;
      case 12: return `Both Teams to Score: ${option}`;
      case 144: return `${home} Clean Sheet: ${option}`;
      case 145: return `${away} Clean Sheet: ${option}`;
      case 7: return option === "No Goal" ? "No Goalscorer" : `${team(option)} to Score First`;
      case 126: return `Correct Score ${value}`;
      case 5: return `1st Half Result: ${team(option)}`;
      case 6: return `2nd Half Result: ${team(option)}`;
      case 9: return withCount(`1st Half ${option} ${value} Goals`, option, value);
      case 13: return `BTTS 2nd Half: ${option}`;
      case 127: return `Half-Time Score ${value}`;
      case 137: return withCount(`${option} ${value} Corners`, option, value);
      case 141: return withCount(`${option} ${value} Cards`, option, value);
      case 139: return withCount(`${option} ${value} Shots on Target`, option, value);
    }
    return withCount(`${market}: ${option}${value ? " " + value : ""}`, option, value);
  }

  // Value finder rows for one match: every live bookmaker price on every
  // market, against HAWK's fair odds. Keeps prices at or above fair.
  function priceRows(entry) {
    const an = entry.an, exp = entry.json.expected, rows = [];
    const byLine = {};
    for (const q of an.quotes) {
      // Live 365Scores books only: Polymarket and Betfair Exchange feed the
      // consensus, and football-data's odds are a days-old snapshot.
      if (q.source !== "365Scores" || CONSENSUS_ONLY.has(q.book)) continue;
      (byLine[`${q.type}|${q.value}`] ||= []).push(q);
    }
    const legByLine = {};
    for (const id of Object.keys(entry.legs)) { const l = bookLine(id); if (l) legByLine[l.join("|")] = id; }
    for (const [key, quotes] of Object.entries(byLine)) {
      const { type, market, value } = quotes[0];
      const cons = an.cons[key];
      for (const option of new Set(quotes.flatMap((q) => Object.keys(q.prices)))) {
        const model = selectionModel(an, exp, type, value, option);
        const pMarket = cons ? cons.probs[option] : null;
        const [w, ignored] = marketTrust(model && model.q, pMarket, cons ? cons.books : 0);
        const q = ignored ? pMarket : blend(model ? model.q : null, pMarket, w);
        if (!(q > 0 && q < 1)) continue;
        const basis = model && pMarket != null && !ignored ? "model + market" : model && !ignored ? "model" : "market";
        for (const b of quotes) {
          const price = b.prices[option];
          if (!price || price * q < 1) continue;
          rows.push({ label: marketLabel(type, market, value, option, an.home, an.away), market, book: b.book, price,
                      p: q, fair: 1 / q, edge: price * q - 1, basis, push: !!model && model.d < 0.999,
                      legId: legByLine[`${type}|${value}|${option}`] || null });
        }
      }
    }
    return rows;
  }
  // ---------------------------------------------------------------------------
  // Live (in-play)
  //
  // The match's remaining goals are two Poisson counts added to the current
  // score. Their rates are fitted to the live prices of all bookmakers
  // (result + goal lines), so they already know the score, red cards and
  // momentum; HAWK then tilts them by the live xG against what the teams
  // were expected to create so far. The blend with the bookmakers'
  // consensus gives the chance for each live selection, compared with
  // Bet365's in-play price. Before any live price exists, the rates come
  // from HAWK's pre-match ratings, scaled to the time left.
  // ---------------------------------------------------------------------------
  // Corners and cards are left out: bookmakers update those live lines at very
  // different speeds (some still offer lines already decided), so there's no
  // trustworthy live consensus to compare against.
  const LIVE_MARKET_WEIGHT = 0.7, LIVE_TYPES = new Set([1, 14, 15, 3, 12, 144, 145, 126]);
  // Live consensus = the MEDIAN of the bookmakers' margin-free chances, so one
  // book that hasn't updated yet can't drag it off.
  function liveConsensus(quotes) {
    const groups = {};
    for (const q of quotes) {
      const opts = Object.entries(q.prices);
      if (opts.length < 2) continue;
      const inv = opts.map(([o, p]) => [o, 1 / p]), over = inv.reduce((s, [, x]) => s + x, 0) / (OPTION_TOTAL[q.type] || 1);
      if (over < 0.98) continue;
      const g = (groups[`${q.type}|${q.value}`] ||= { books: new Set(), probs: {} });
      g.books.add(q.book);
      for (const [o, x] of inv) (g.probs[o] ||= []).push(x / over);
    }
    const median = (xs) => { const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const out = {};
    for (const [k, g] of Object.entries(groups)) out[k] = { probs: Object.fromEntries(Object.entries(g.probs).map(([o, xs]) => [o, median(xs)])), books: g.books.size };
    return out;
  }
  function remainingMinutes(minute, statusText) {
    const m = Number(minute) || 0, s = String(statusText || "");
    if (/half.?time|break/i.test(s)) return 50;
    if (/1st/i.test(s) || m < 45) return Math.max(2, 47 - m) + 50;
    return Math.max(1, 96 - m);
  }
  // Final-score matrix from the current score plus remaining-goal rates.
  function finalMatrix(sh, sa, rh, ra) {
    const ph = pmfRow(rh), pa = pmfRow(ra);
    const M = Array.from({ length: MAX_GOALS + 1 }, () => new Array(MAX_GOALS + 1).fill(0));
    for (let i = 0; i + sh <= MAX_GOALS; i++) for (let j = 0; j + sa <= MAX_GOALS; j++) M[i + sh][j + sa] += ph[i] * pa[j];
    let s = 0; for (const row of M) for (const v of row) s += v;
    return M.map((row) => row.map((v) => v / s));
  }
  function fitRemaining(sh, sa, p1x2, totals) {
    const loss = (rh, ra) => {
      const M = finalMatrix(sh, sa, rh, ra);
      let l = 0;
      if (p1x2) l += (sumCells(M, (i, j) => i > j) - p1x2[0]) ** 2 + (sumCells(M, (i, j) => i === j) - p1x2[1]) ** 2 + (sumCells(M, (i, j) => i < j) - p1x2[2]) ** 2;
      for (const [line, pOver] of totals) l += (sumCells(M, (i, j) => i + j > line) - pOver) ** 2;
      return l;
    };
    const solve = (hs, as) => { let best = null, bl = Infinity; for (const a of hs) for (const b of as) { const l = loss(a, b); if (l < bl) { bl = l; best = [a, b]; } } return best; };
    const range = (a, b, st) => { const o = []; for (let x = a; x <= b + 1e-9; x += st) o.push(+x.toFixed(4)); return o; };
    const [h, a] = solve(range(0.01, 3.2, 0.05), range(0.01, 3.2, 0.05));
    return solve(range(Math.max(0.005, h - 0.05), h + 0.05, 0.005), range(Math.max(0.005, a - 0.05), a + 0.05, 0.005));
  }
  async function preMatchLambdas(meta) {
    if (!meta) return null;
    const fd = meta.fd || {};
    const [profH, profA] = await Promise.all([fd.home ? data(`profiles/${fd.home[0]}.json`) : null, fd.away ? data(`profiles/${fd.away[0]}.json`) : null]);
    const model = profH && profA ? expectedPair(profH, fd.home[1], profA, fd.away[1], "goals") : null;
    const c = consensus(meta.uk || [])["1|"];   // football-data's pre-match odds snapshot
    const p1x2 = c && ["1", "X", "2"].every((k) => k in c.probs) ? [c.probs["1"], c.probs.X, c.probs["2"]] : null;
    const market = p1x2 ? fitGoalLambdas(p1x2, []) : null;
    if (!model && !market) return null;
    return [0, 1].map((k) => blend(model ? model[k] : null, market ? market[k] : null));
  }
  async function liveMatch(id) {
    id = String(id);
    const [d, st, quotes, file] = await Promise.all([s365("game", { gameId: id }), s365("game/stats", { games: id }), odds365(id), data("fixtures.json")]);
    const game = d && d.game;
    if (!game) throw new Error("365Scores didn't return this match");
    const hc = game.homeCompetitor, ac = game.awayCompetitor;
    const base = { id, home: hc.name, away: ac.name, homeCrest: crest(hc), awayCrest: crest(ac), status: game.statusGroup,
                   statusText: game.statusText, minute: game.gameTime, clock: game.gameTimeDisplay };
    if (game.statusGroup !== 3) return { ...base, live: false };
    const sh = Math.max(0, Math.trunc(hc.score) || 0), sa = Math.max(0, Math.trunc(ac.score) || 0);
    const reds = [hc.id, ac.id].map((cid) => (game.events || []).filter((e) => e.competitorId === cid && /red/i.test((e.eventType || {}).name || "")).length);
    const stats = {};
    for (const s of (st && st.statistics) || []) {
      const k = s.competitorId === hc.id ? 0 : s.competitorId === ac.id ? 1 : -1;
      if (k < 0) continue;
      (stats[s.name] ||= [null, null])[k] = parseFloat(String(s.value).replace("%", "")) || 0;
      // "6/7 (86%)": also keep the 7 (e.g. tackles made, won or not)
      const of = /^\s*\d+\s*\/\s*(\d+)/.exec(String(s.value));
      if (of) (stats[`${s.name}|of`] ||= [null, null])[k] = +of[1];
    }
    const rem = remainingMinutes(game.gameTime, game.statusText), elapsed = Math.min(95, Math.max(0, Number(game.gameTime) || 0));
    const cons = liveConsensus(quotes), c1 = cons["1|"];
    const p1x2 = c1 && ["1", "X", "2"].every((k) => k in c1.probs) ? [c1.probs["1"], c1.probs.X, c1.probs["2"]] : null;
    const totals = Object.entries(cons).filter(([k, c]) => k.startsWith("3|") && halfLine(k.slice(2)) != null && "Over" in c.probs)
      .map(([k, c]) => [parseFloat(k.slice(2)), c.probs.Over]);
    const pre = await preMatchLambdas(file && file.fixtures && file.fixtures[id]);
    // HAWK's own read: pre-match strength for the time left, nudged for the score and red cards.
    const diff = sh - sa;
    const ownRates = pre ? pre.map((l, k) => {
      const mine = k === 0 ? diff : -diff, chase = mine < 0 ? Math.min(1.25, 1 + 0.1 * -mine) : mine > 0 ? 0.92 : 1;
      return (l * rem) / 95 * chase * Math.pow(0.75, reds[k]) * Math.pow(1.2, reds[1 - k]);
    }) : null;
    let rates, basis;
    if (p1x2 || totals.length) { rates = fitRemaining(sh, sa, p1x2, totals); basis = "live prices"; }
    else if (ownRates) { rates = ownRates; basis = "pre-match ratings"; }
    else return { ...base, live: true, score: [sh, sa], reds, stats, noModel: true, rows: [] };
    // HAWK's tilt: teams creating more (or less) than expected so far keep doing so, a bit.
    const xg = stats["Expected Goals"];
    const tilt = [0, 1].map((k) => {
      if (!pre || !xg || elapsed < 15) return 1;
      const expected = (pre[k] * elapsed) / 95;
      return Math.min(1.2, Math.max(0.85, Math.sqrt((xg[k] + expected) / (2 * expected))));
    });
    const M = finalMatrix(sh, sa, rates[0] * tilt[0], rates[1] * tilt[1]);
    const anLive = { M, lamBlend: rates };
    liveState[id] = { M, sh, sa, rem, elapsed, statusText: game.statusText, rates: [rates[0] * tilt[0], rates[1] * tilt[1]], stats, game,
                      league: (file && file.fixtures && file.fixtures[id] && file.fixtures[id].league) || null, t: Date.now() };
    const liveModel = (type, value, option) => selectionModel(anLive, {}, type, value, option);
    const rows = [];
    const byLine = {};
    for (const q of quotes) if (LIVE_TYPES.has(q.type) && !CONSENSUS_ONLY.has(q.book)) (byLine[`${q.type}|${q.value}`] ||= []).push(q);
    for (const [key, qs] of Object.entries(byLine)) {
      const b365 = qs.find((q) => q.book === PRICE_BOOK);
      if (!b365) continue;
      const { type, market, value } = b365, c = cons[key];
      for (const [option, price] of Object.entries(b365.prices)) {
        const model = liveModel(type, value, option), pMarket = c ? c.probs[option] : null;
        const w = c && c.books >= 3 ? LIVE_MARKET_WEIGHT : 0.5;
        const q = blend(model ? model.q : null, pMarket, w);
        if (!(q > 0 && q < 1)) continue;
        rows.push({ type, market, label: marketLabel(type, market, value, option, hc.name, ac.name), price, p: q, fair: 1 / q,
                    edge: price * q - 1, push: !!model && model.d < 0.999,
                    basis: model && pMarket != null ? "HAWK + bookmakers" : model ? "HAWK" : "bookmakers" });
      }
    }
    const res = (o) => (rows.find((r) => r.type === 1 && r.label === marketLabel(1, "", "", o, hc.name, ac.name)) || {}).p;
    const three = (Mx) => ({ home: sumCells(Mx, (i, j) => i > j), draw: sumCells(Mx, (i, j) => i === j), away: sumCells(Mx, (i, j) => i < j) });
    // Goals, cards and subs by player, for the live lineup pitch. A sub's
    // player is the one coming on; the one going off is in extraPlayers.
    const names = Object.fromEntries((game.members || []).map((m) => [m.id, m.name]));
    const events = (game.events || []).map((e) => {
      const nm = ((e.eventType || {}).name || "").toLowerCase();
      // (365Scores event type 1 = goal; "Goal Disallowed" (VAR) is type 11 — not a goal)
      const type = evType(e);
      return type && { type, side: e.competitorId === hc.id ? "home" : "away", minute: e.gameTimeDisplay || "", player: names[e.playerId] || "",
                       other: (e.extraPlayers || []).map((p) => names[p]).filter(Boolean)[0] || "", detail: (e.eventType || {}).subTypeName || "" };
    }).filter(Boolean);
    // The next goal, from the goals still expected (live prices + xG tilt): the
    // chance of another goal, whose it is, 2+ more, and when it's due (the
    // minute by which it's more likely than not to have come).
    const [lh, la] = [rates[0] * tilt[0], rates[1] * tilt[1]], lt = lh + la;
    const any = 1 - Math.exp(-lt), elapsedNow = Math.max(0, Number(game.gameTime) || 0);
    const next = lt > 0 ? { any, home: (lh / lt) * any, away: (la / lt) * any, twoPlus: 1 - Math.exp(-lt) * (1 + lt),
                            by: any > 0.5 ? Math.round(elapsedNow + (rem * Math.LN2) / lt) : null, xg: [lh, la] } : null;
    // Unibet's live next-goal prices, to set beside HAWK's (a few seconds at most).
    const lg = LEAGUE_OF[game.competitionId] || (file && file.fixtures && file.fixtures[id] && file.fixtures[id].league);
    const nextBook = next && lg ? await Promise.race([kambiNextGoal(lg, hc.name, ac.name, new Date(game.startTime)).catch(() => null), sleep(4000).then(() => null)]) : null;
    return { ...base, live: true, score: [sh, sa], reds, stats, basis, remaining: rem, books: c1 ? c1.books : 0, tilt, events, next, nextBook,
             market: p1x2 ? { home: p1x2[0], draw: p1x2[1], away: p1x2[2], books: c1.books } : null,
             own: ownRates ? three(finalMatrix(sh, sa, Math.max(ownRates[0] * tilt[0], 1e-9), Math.max(ownRates[1] * tilt[1], 1e-9))) : null,
             probs: { home: res("1") ?? sumCells(M, (i, j) => i > j), draw: res("X") ?? sumCells(M, (i, j) => i === j), away: res("2") ?? sumCells(M, (i, j) => i < j) },
             rows, checked: new Date().toISOString() };
  }

  // ---------------------------------------------------------------------------
  // Live chance of your HAWK legs (the cash-out helper). For a match in play:
  //  - goal-based legs (result, goals, BTTS, clean sheet, handicap, margin,
  //    correct score) are checked together on the live final-score matrix,
  //    so they're correlated properly;
  //  - corners/cards/shots-on-target: what's happened + a Poisson count for
  //    the time left (live pace blended with a normal match's pace);
  //  - player legs: his numbers so far + his usual per-90 rate for the
  //    minutes he has left (none if he's been subbed off or sent off).
  // Those groups are combined as if independent — a fair approximation.
  // ---------------------------------------------------------------------------
  const liveState = {};   // game id -> internals of the last liveMatch() for it
  const poisAtLeast = (lam, k) => { if (k <= 0) return 1; if (!(lam > 1e-9)) return 0; let c = 0; for (let i = 0; i < k; i++) c += pmf(lam, i); return Math.max(0, 1 - c); };
  const poisAtMost = (lam, k) => { if (k < 0) return 0; if (!(lam > 1e-9)) return 1; let c = 0; for (let i = 0; i <= k; i++) c += pmf(lam, i); return Math.min(1, c); };
  // A line on a count: x so far, lam still to come.
  function lineChance(x, lam, ou, line) {
    if (ou === "o") { const need = Math.floor(line) + 1 - x; return need <= 0 ? { state: "won", p: 1 } : { state: "live", p: poisAtLeast(lam, need) }; }
    const room = Math.ceil(line) - 1 - x;
    return room < 0 ? { state: "lost", p: 0 } : { state: "live", p: poisAtMost(lam, room) };
  }
  const TYPICAL_90 = { corners: 5, cards: 2.1, sot: 4.2 };   // per team, a normal match
  async function ticketLive(id, legs) {
    id = String(id);
    if (!liveState[id] || Date.now() - liveState[id].t > 25000) await liveMatch(id);
    const st = liveState[id];
    if (!st) return null;
    const { M, sh, sa, rem, elapsed, stats, game } = st, [rh, ra] = st.rates;
    const hc = game.homeCompetitor, ac = game.awayCompetitor;
    const pair = (name) => (stats[name] || [0, 0]).map((v) => v || 0);
    // Cards in booking points (yellow 1, red 2) so the live count matches what a
    // card market actually settles on — see the same rule in hawk-settle.js.
    const now = { corners: pair("Corners"), sot: pair("Shots On Target"), cards: pair("Yellow Cards").map((v, k) => v + 2 * pair("Red Cards")[k]) };
    const w = elapsed / (elapsed + 40);
    const lamStat = (stat, k) => rem * (w * (elapsed > 0 ? now[stat][k] / elapsed : 0) + (1 - w) * TYPICAL_90[stat] / 90);
    // Half-time and first goal.
    const ht = (game.stages || []).find((s) => s.id === 7 && s.isEnded);
    const inFirstHalf = !ht && /1st/i.test(st.statusText || "");
    const goals = (game.events || []).filter((e) => e.eventType && e.eventType.id === 1).sort((a, b) => (a.order || 0) - (b.order || 0));
    // Bet365's Early Payout: a Full Time Result leg is paid as won once that
    // team has been 2 goals ahead at any point. Followed through the goals in
    // order (only when they add up to the score; otherwise the score now).
    const twoUp = { home: sh - sa >= 2, away: sa - sh >= 2 };
    if (goals.filter((e) => e.competitorId === hc.id).length === sh && goals.filter((e) => e.competitorId === ac.id).length === sa) {
      let d = 0;
      for (const e of goals) { d += e.competitorId === hc.id ? 1 : -1; if (d >= 2) twoUp.home = true; if (d <= -2) twoUp.away = true; }
    }
    // Players: live numbers, who's still on, and their usual rates.
    const names = Object.fromEntries((game.members || []).map((m) => [m.id, m.name]));
    const subsIn = new Set(), subsOut = new Set(), sentOff = new Set(), booked = new Set(), replacedBy = {};
    for (const e of game.events || []) {
      const n = ((e.eventType || {}).name || "").toLowerCase();
      if (n.includes("substitution")) { subsIn.add(e.playerId); (e.extraPlayers || []).forEach((p) => { subsOut.add(p); replacedBy[p] = e.playerId; }); }
      if (n.includes("card")) booked.add(e.playerId);
      if (n.includes("red")) sentOff.add(e.playerId);
    }
    const livePlayers = {};
    for (const [side, key] of [["home", "homeCompetitor"], ["away", "awayCompetitor"]]) {
      livePlayers[side] = (((game[key] || {}).lineups || {}).members || []).map((m) => {
        const s = Object.fromEntries((m.stats || []).map((x) => [x.name, x.value]));
        const count = (k, total) => { const v = s[k]; if (v == null) return 0; const mm = /^(\d+)\s*\/\s*(\d+)/.exec(String(v)); return mm ? +(total ? mm[2] : mm[1]) : parseFloat(v) || 0; };
        const started = m.statusText === "Starting", mins = count("Minutes");
        const on = !sentOff.has(m.id) && !subsOut.has(m.id) && (started ? !(mins > 0 && mins < elapsed - 5 && !subsIn.has(m.id)) : subsIn.has(m.id));
        return { id: m.id, name: names[m.id] || "", pos: POSITIONS[(m.position || {}).name] || "M", on, played: started || subsIn.has(m.id) || mins > 0, booked: booked.has(m.id),
                 mins, tkShown: s["Tackles Won"] != null,
                 v: { shots: count("Total Shots"), sot: count("Shots On Target"), score: count("Goals"), assist: count("Assists"), fouls: count("Fouls Made"),
                      fouled: count("Was Fouled"), tackles: count("Tackles Won", true), offsides: count("Offsides"), saves: count("Goalkeeper Saves") } };
      });
    }
    const meta = ((await data("fixtures.json")) || { fixtures: {} }).fixtures[id];
    const files = meta && meta.sh ? await Promise.all(meta.sh.map((t) => data(`players/${t}.json`))) : [null, null];
    const history = { home: playerRows(files[0]), away: playerRows(files[1]) };
    const usual = (side, name, pos) => {
      const rows = history[side] || [], hit = rows.length ? bestMatch(name, rows.map((p) => p.name), 0.6) : null;
      const mt = hit ? rows.find((p) => p.name === hit).matches : [];
      const r = rates(mt, DEFAULT_RATES[pos] || DEFAULT_RATES.M, pos, EXTRA_DEFAULTS[pos] || EXTRA_DEFAULTS.M);
      const x = r.x || EXTRA_DEFAULTS[pos] || EXTRA_DEFAULTS.M;
      return { shots: r.sh90, sot: r.sot90, score: r.g90, cards: r.c90, assist: x.assists, fouls: x.fouls, fouled: x.fouled, tackles: x.tackles, offsides: x.offsides };
    };
    // Team tackles (won or not) that no player is named for.
    const unnamedTackles = (side) => {
      const team = (stats["Tackles Won|of"] || [])[side === "home" ? 0 : 1];
      if (!(team > 0)) return 0;
      return Math.max(0, team - (livePlayers[side] || []).reduce((a, p) => a + (p.v.tackles || 0), 0));
    };
    // Goal legs as conditions on the final score (i = home, j = away).
    const goalTest = (legId) => {
      let m;
      if ((m = /^res:(home|draw|away)$/.exec(legId))) return (i, j) => (m[1] === "home" ? i > j : m[1] === "away" ? j > i : i === j);
      if ((m = /^dc:(home|away)$/.exec(legId))) return (i, j) => (m[1] === "home" ? i >= j : j >= i);
      if ((m = /^goals:([ou])([\d.]+)$/.exec(legId))) return (i, j) => (m[1] === "o" ? i + j > +m[2] : i + j < +m[2]);
      if ((m = /^btts:(yes|no)$/.exec(legId))) return (i, j) => (i > 0 && j > 0) === (m[1] === "yes");
      if ((m = /^team:(home|away):o([\d.]+)$/.exec(legId))) return (i, j) => (m[1] === "home" ? i : j) > +m[2];
      if ((m = /^cs:(home|away)$/.exec(legId))) return (i, j) => (m[1] === "home" ? j : i) === 0;
      if ((m = /^cs:(\d+)-(\d+)$/.exec(legId))) return (i, j) => i === +m[1] && j === +m[2];
      if ((m = /^wtn:(home|away)$/.exec(legId))) return (i, j) => (m[1] === "home" ? i > 0 && j === 0 : j > 0 && i === 0);
      if ((m = /^margin:(home|away):(\d)$/.exec(legId))) return (i, j) => { const d = m[1] === "home" ? i - j : j - i; return +m[2] === 3 ? d >= 3 : d === +m[2]; };
      if ((m = /^ah:(home|away):([+-][\d.]+)$/.exec(legId))) return (i, j) => (m[1] === "home" ? i - j : j - i) + parseFloat(m[2]) > 0;
      return null;
    };
    const out = [], goalTests = [];
    for (const h of legs) {
      const id2 = h.id || "", row = { id: id2, label: h.label, state: "live", p: null, note: "" };
      let m, t;
      if (h.userDone) {
        // You ticked it: Bet365 shows it done (e.g. a tackle 365Scores doesn't name).
        row.state = "won"; row.p = 1; row.userDone = true; row.note = "you marked it done — Bet365 shows it";
      } else if ((m = /^res:(home|away)$/.exec(id2)) && twoUp[m[1]]) {
        row.state = "won"; row.p = 1; row.ep = true;
        row.note = `score ${sh}-${sa} · Early Payout: ${m[1] === "home" ? hc.name : ac.name} went 2 goals ahead, so Bet365 pays this leg as won (if your slip shows EP)`;
      } else if ((t = goalTest(id2))) {
        goalTests.push(t);
        row.p = sumCells(M, t);
        if (row.p > 0.9999) { row.state = "won"; row.p = 1; } else if (row.p < 1e-4) { row.state = "lost"; row.p = 0; }
        row.note = `score ${sh}-${sa}`;
      } else if ((m = /^qual:(home|away)$/.exec(id2))) {
        const [ah, aa] = preAgg(game, hc.name), pH = sumCells(M, (i, j) => i > j), pA = sumCells(M, (i, j) => j > i), share = etShare(pH, pA);
        const pHome = sumCells(M, (i, j) => ah + i > aa + j) + share * sumCells(M, (i, j) => ah + i === aa + j);
        row.p = m[1] === "home" ? pHome : 1 - pHome;
        row.note = `score ${sh}-${sa}${ah || aa ? ` · aggregate ${ah + sh}-${aa + sa}` : ""} · extra time and penalties count`;
      } else if ((m = /^first:(home|away)$/.exec(id2))) {
        if (goals.length) { const won = (goals[0].competitorId === hc.id) === (m[1] === "home"); row.state = won ? "won" : "lost"; row.p = won ? 1 : 0; }
        else row.p = ((m[1] === "home" ? rh : ra) / Math.max(rh + ra, 1e-9)) * (1 - Math.exp(-(rh + ra)));
      } else if ((m = /^h([12])(res|goals):(.+)$/.exec(id2))) {
        const rem1 = inFirstHalf ? Math.max(0, 47 - elapsed) : 0, remAll = Math.max(rem, 1);
        let base, lam;
        if (m[1] === "1") {
          if (!inFirstHalf) { base = ht ? [ht.homeCompetitorScore, ht.awayCompetitorScore] : [sh, sa]; lam = [0, 0]; }
          else { base = [sh, sa]; lam = [rh * rem1 / remAll, ra * rem1 / remAll]; }
        } else if (inFirstHalf) { base = [0, 0]; lam = [rh * (remAll - rem1) / remAll, ra * (remAll - rem1) / remAll]; }
        else { base = ht ? [sh - ht.homeCompetitorScore, sa - ht.awayCompetitorScore] : [0, 0]; lam = [rh, ra]; }
        const HM = finalMatrix(base[0], base[1], Math.max(lam[0], 1e-9), Math.max(lam[1], 1e-9)), g = /^([ou])([\d.]+)$/.exec(m[3]);
        const test = m[2] === "res" ? (i, j) => (m[3] === "home" ? i > j : m[3] === "away" ? j > i : i === j) : g ? (i, j) => (g[1] === "o" ? i + j > +g[2] : i + j < +g[2]) : null;
        row.p = test ? sumCells(HM, test) : null;
        if (row.p != null && (lam[0] + lam[1] === 0)) row.state = row.p > 0.5 ? "won" : "lost";
      } else if ((m = /^(corners|cards|sot):([ou])([\d.]+)$/.exec(id2))) {
        const x = now[m[1]][0] + now[m[1]][1], r = lineChance(x, lamStat(m[1], 0) + lamStat(m[1], 1), m[2], +m[3]);
        Object.assign(row, r, { note: `${x} so far` });
      } else if ((m = /^t(corners|cards):(home|away):([ou])([\d.]+)$/.exec(id2))) {
        const k = m[2] === "home" ? 0 : 1, x = now[m[1]][k], r = lineChance(x, lamStat(m[1], k), m[3], +m[4]);
        Object.assign(row, r, { note: `${x} so far` });
      } else if ((m = /^mostcorners:(home|away)$/.exec(id2))) {
        const [ch, ca] = now.corners, lh = lamStat("corners", 0), la = lamStat("corners", 1);
        let p = 0; for (let a = 0; a < 25; a++) for (let b = 0; b < 25; b++) { const fh = ch + a, fa = ca + b; if (m[1] === "home" ? fh > fa : fa > fh) p += pmf(Math.max(lh, 1e-9), a) * pmf(Math.max(la, 1e-9), b); }
        row.p = Math.min(1, p); row.note = `corners ${ch}-${ca}`;
      } else if ((m = /^p:(home|away):\d+:([a-z]+?)(\d*)$/.exec(id2))) {
        const side = m[1], stat = m[2], need = +m[3] || 1;
        let pl = (() => { const list = livePlayers[side] || [], hit = list.length ? bestMatch(h.player || h.label.split(/:| to /)[0], list.map((p) => p.name), 0.6) : null; return list.find((p) => p.name === hit); })();
        // Bet365's Sub On Play On: your player subbed off before the leg landed → the
        // bet moves to the player who came on for him (only the sub's own numbers
        // count; a sub of the sub carries it on). Not for a red card.
        const done = (p) => (stat === "booked" ? p.booked : (stat === "soa" ? p.v.score + p.v.assist : p.v[stat] || 0) >= need);
        let subFrom = null;
        if (pl && pl.played && h.subOn && !done(pl) && subsOut.has(pl.id)) {
          let cur = pl;
          for (let hop = 0; hop < 5 && replacedBy[cur.id]; hop++) {
            const nx = (livePlayers[side] || []).find((p) => p.id === replacedBy[cur.id]);
            if (!nx) break;
            cur = nx;
            if (done(cur) || !subsOut.has(cur.id)) break;
          }
          if (cur !== pl) { subFrom = pl; pl = cur; }
        }
        if (!pl) { row.state = "void"; row.note = "not in the squad list"; }
        else if (!pl.played) { row.state = "wait"; row.p = null; row.note = "hasn't come on (Bet365 voids the leg if he doesn't play)"; }
        else {
          const left = pl.on ? rem : 0;
          if (stat === "booked") {
            if (pl.booked) { row.state = "won"; row.p = 1; }
            else if (!left) { row.state = "lost"; row.p = 0; }
            else { const r = usual(side, pl.name, pl.pos); row.p = 1 - Math.exp(-(r.cards * left) / 90); }
          } else if (stat === "saves") {
            const opp = side === "home" ? 1 : 0;
            Object.assign(row, lineChance(pl.v.saves, left ? lamStat("sot", opp) * 0.7 : 0, "o", need - 0.5));
          } else {
            const key = stat === "soa" ? null : stat, r = usual(side, pl.name, pl.pos);
            const x = stat === "soa" ? pl.v.score + pl.v.assist : pl.v[key] || 0;
            const per90 = stat === "soa" ? r.score + r.assist : r[key] || 0;
            Object.assign(row, lineChance(x, (per90 * left) / 90, "o", need - 0.5));
            const u = stat === "tackles" && !pl.tkShown ? unnamedTackles(side) : 0;
            if (u > 0 && row.state === "live") {
              // 365Scores only names a player's tackles once he's won one; the
              // team total also has the ones that lost the ball, and Bet365
              // counts those. Some of them may be his: share them out by how
              // often each unnamed player usually tackles and how long he's played.
              const pool = (livePlayers[side] || []).filter((p) => p.played && !p.tkShown);
              const wt = (p) => usual(side, p.name, p.pos).tackles * Math.max(p.mins, 1);
              const share = Math.min(1, wt(pl) / Math.max(pool.reduce((a, p) => a + wt(p), 0), 1e-9));
              const lam = (per90 * left) / 90;
              let p = 0, c = 1;
              for (let k = 0; k <= u; k++) {
                if (k) c = (c * (u - k + 1)) / k;
                p += c * share ** k * (1 - share) ** (u - k) * poisAtLeast(lam, need - k);
              }
              row.p = Math.min(1, p);
              row.unnamed = u;
            }
          }
          row.note = `${subFrom ? `🔄 ${pl.name} on for ${subFrom.name} (Sub On Play) · ` : ""}${pl.on ? "on the pitch" : "off"} · ${stat === "booked" ? (pl.booked ? "booked" : "not booked") : `${stat === "soa" ? pl.v.score + pl.v.assist : pl.v[stat] || 0} so far`}`;
          if (subFrom) row.sub = { from: subFrom.name, to: pl.name };
          if (row.unnamed) row.note += ` · ${side === "home" ? hc.name : ac.name} have ${row.unnamed} more tackle${row.unnamed > 1 ? "s" : ""} 365Scores doesn't name (lost the ball) — Bet365 counts those, so he may already have one`;
        }
      } else row.note = "HAWK can't follow this one live";
      out.push(row);
    }
    // Goal legs together (correlated), everything else multiplied in.
    const goalJoint = goalTests.length ? sumCells(M, (i, j) => goalTests.every((t) => t(i, j))) : 1;
    let p = goalJoint, unknown = 0;
    out.forEach((r) => {
      if (goalTest(r.id)) return;
      if (r.state === "lost") p = 0;
      else if (r.p == null) unknown++;
      else p *= r.p;
    });
    return { legs: out, p: out.some((r) => r.state === "lost") ? 0 : p, unknown, minute: game.gameTimeDisplay, score: [sh, sa] };
  }

  // ---------------------------------------------------------------------------
  // Scores: every game in HAWK's competitions on one day, and a match report
  // (goals, cards, key stats) for a game that has started.
  // ---------------------------------------------------------------------------
  const LEAGUE_OF = Object.fromEntries(Object.entries(COMPETITIONS).map(([name, cid]) => [cid, name]));
  async function scores(day) {   // day = "YYYY-MM-DD" (your local date)
    const [y, m, d] = String(day).split("-"), date = `${d}/${m}/${y}`;
    // Now and then 365Scores answers with an empty list (a hiccup, not a day without
    // games): that reply isn't kept, and it's asked again twice before being believed.
    const params = { competitions: Object.values(COMPETITIONS).join(","), startDate: date, endDate: date };
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) { cache.delete(`${S365}/games/allscores/?${new URLSearchParams({ ...S365_PARAMS, ...params })}`); await sleep(700 * attempt); }
      res = await s365("games/allscores", params, 10 * 1000);
      if (res && (res.games || []).length) break;
    }
    if (!res) throw new Error("365Scores didn't return scores — try again in a moment");
    const score = (c, g) => (g.statusGroup === 2 || !(c.score >= 0) ? null : Math.trunc(c.score));
    const qualifier = (g) => CUPS.has(LEAGUE_OF[g.competitionId]) && /qualif|prelim/i.test(g.stageName || "");
    return (res.games || []).filter((g) => !qualifier(g)).map((g) => ({
      id: String(g.id), league: LEAGUE_OF[g.competitionId] || g.competitionDisplayName || "", home: g.homeCompetitor.name, away: g.awayCompetitor.name,
      homeCrest: crest(g.homeCompetitor), awayCrest: crest(g.awayCompetitor), kickoff: g.startTime, status: g.statusGroup,
      statusText: g.shortStatusText || g.statusText || "", clock: g.gameTimeDisplay || "", score: [score(g.homeCompetitor, g), score(g.awayCompetitor, g)],
      winner: g.winner || 0,
      // 365Scores' lineupsStatus: 1 = only absences known, 2 = probable XI, 3 = confirmed XI
      lineupsConfirmed: g.lineupsStatus === 3,
    })).sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));
  }
  const REPORT_STATS = [["Expected Goals", "Expected goals (xG)"], ["Total Shots", "Shots"], ["Shots On Target", "Shots on target"],
                        ["Big Chances Created", "Big chances"], ["Possession", "Possession"], ["Corners", "Corners"], ["Fouls", "Fouls"],
                        ["Yellow Cards", "Yellow cards"], ["Red Cards", "Red cards"], ["Offsides", "Offsides"], ["Goalkeeper Saves", "Saves"]];
  async function matchReport(id) {
    const [d, st] = await Promise.all([s365("game", { gameId: id }), s365("game/stats", { games: id })]);
    const game = d && d.game;
    if (!game) throw new Error("365Scores didn't return this match");
    const hc = game.homeCompetitor, ac = game.awayCompetitor, names = Object.fromEntries((game.members || []).map((m) => [m.id, m.name]));
    const ht = (game.stages || []).find((s) => s.id === 7);
    const events = (game.events || []).filter((e) => ["goal", "disallowed", "red", "yellow"].includes(evType(e))).map((e) => ({
      side: e.competitorId === hc.id ? "home" : "away", minute: e.gameTimeDisplay || "", type: evType(e),
      detail: e.eventType.subTypeName && !/field goal/i.test(e.eventType.subTypeName) ? e.eventType.subTypeName : "",
      player: names[e.playerId] || "", assist: (e.extraPlayers || []).map((p) => names[p]).filter(Boolean)[0] || "",
    }));
    const stats = [];
    for (const [key, label] of REPORT_STATS) {
      const pair = [null, null];
      for (const s of (st && st.statistics) || []) if (s.name === key) pair[s.competitorId === hc.id ? 0 : 1] = s.value;
      if (pair[0] != null || pair[1] != null) stats.push({ label, home: pair[0] ?? "0", away: pair[1] ?? "0" });
    }
    return { id: String(id), home: hc.name, away: ac.name, homeCrest: crest(hc), awayCrest: crest(ac), status: game.statusGroup,
             statusText: game.statusText, clock: game.gameTimeDisplay, score: [Math.max(0, Math.trunc(hc.score) || 0), Math.max(0, Math.trunc(ac.score) || 0)],
             ht: ht && ht.isEnded ? [ht.homeCompetitorScore, ht.awayCompetitorScore] : null, venue: (game.venue || {}).name || "",
             competition: game.competitionDisplayName || "", events, stats };
  }

  // What a 365Scores match event is. Goals are event type 1 only: a goal ruled
  // out by VAR comes as "Goal Disallowed" (type 11) and must not count.
  function evType(e) {
    const t = e && e.eventType, nm = ((t && t.name) || "").toLowerCase();
    if (!t) return null;
    if (t.id === 1) return "goal";
    if (t.id === 11 || /disallow|cancel/.test(nm)) return "disallowed";
    if (nm.includes("red")) return "red";
    if (nm.includes("yellow")) return "yellow";
    if (nm.includes("substitution")) return "sub";
    return null;
  }
  // Team stats for one half: 365Scores' stats filter 6 = 1st half, 8 = 2nd half.
  // {name: [home, away]} as numbers, like the match stats in liveMatch.
  const HALF_FILTER = { 1: 6, 2: 8 };
  async function halfStats(id, half) {
    const st = await s365("game/stats", { games: id, filterId: HALF_FILTER[half] }, 20 * 1000);
    const g = st && (st.games || [])[0], hcId = g && g.homeCompetitor && g.homeCompetitor.id;
    if (!hcId) return null;
    const out = {};
    for (const s of st.statistics || []) {
      const k = s.competitorId === hcId ? 0 : 1;
      (out[s.name] ||= [null, null])[k] = parseFloat(String(s.value).replace("%", "")) || 0;
    }
    return out;
  }
  // A match's goals and cards so far (for the alerts), cached 20 seconds.
  async function gameEvents(id) {
    const d = await s365("game", { gameId: id }, 20 * 1000), game = d && d.game;
    if (!game) return null;
    const hc = game.homeCompetitor, names = Object.fromEntries((game.members || []).map((m) => [m.id, m.name]));
    const nums = Object.fromEntries((game.members || []).map((m) => [m.id, m.jerseyNumber]));
    const photos = Object.fromEntries((game.members || []).filter((m) => m.athleteId).map((m) => [m.id, athletePhoto(m)]));
    // Every player's live numbers, as 365Scores lists them (Minutes, Goals, Total Shots, Tackles Won "1/2 (50%)", …).
    const players = {};
    for (const [side, key] of [["home", "homeCompetitor"], ["away", "awayCompetitor"]])
      players[side] = (((game[key] || {}).lineups || {}).members || []).filter((m) => m.statusText === "Starting" || m.statusText === "Substitute")
        .map((m) => ({ name: names[m.id] || "", num: shirt(nums[m.id]), photo: photos[m.id] || null, starter: m.statusText === "Starting", pos: ((m.position || {}).name) || "",
                       stats: (m.stats || []).map((s) => [s.name, String(s.value)]) }));
    return { status: game.statusGroup, statusText: game.statusText, clock: game.gameTimeDisplay, players,
             events: (game.events || []).map((e) => {
               const type = evType(e);
               return type && { type, side: e.competitorId === hc.id ? "home" : "away", player: names[e.playerId] || "", minute: e.gameTimeDisplay || "",
                                detail: (e.eventType || {}).subTypeName || "" };
             }).filter(Boolean) };
  }


  const valueJob = newJob();
  function startValue(body) {
    if (valueJob.running) return jobStatus(valueJob);
    Object.assign(valueJob, newJob(), { running: true, params: windowParams(body) });
    runFixtureJob(valueJob, (league, f, json, e) => {
      const info = fixtureInfo(league, f, json);
      for (const row of priceRows(e)) valueJob.results.push({ ...info, ...row });
    });
    return jobStatus(valueJob);
  }

  global.HAWK = { LEAGUES, LEAGUE_GROUPS, COMPETITIONS, INTL: [...INTL], fixtures, match, build, buildOptions, evaluate: evaluateBody, lineups, livePrices, legPrices, setLearning, setTrust, setEarlyPayout, setPropBook, setAim, propEstimate, propKey, refOff, DEAD_PRICE, REF_TO_B365, h2h, learnKey, liveMatch,
                  scores, matchReport, ticketLive, gameEvents, halfStats, readLeg, isPlayerText, nameSimilarity, kambiLive, tables,
                  startMonster, monsterStatus: () => jobStatus(monster), stopMonster: () => { monster.stop = true; return jobStatus(monster); },
                  startScan, scanStatus: () => jobStatus(scan), stopScan: () => { scan.stop = true; return jobStatus(scan); },
                  startValue, valueStatus: () => jobStatus(valueJob), stopValue: () => { valueJob.stop = true; return jobStatus(valueJob); },
                  meta: () => data("meta.json"),
                  _internals: { analyse, buildSquads, simulate, catalogue, autoBuild, evaluate, consensus, fitGoalLambdas, espnLineups, matchPlayer, playerRows,
                                selectionModel, priceRows, entry: (id) => matches.get(String(id)), liveState, finalMatrix,
                                fitTotalLambda, scoreMatrix, nameSimilarity, bestMatch } };
})(window);
