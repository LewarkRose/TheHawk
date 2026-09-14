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
  ].map((g) => ({ ...g, leagues: Object.keys(g.ids) }));
  const COMPETITIONS = Object.assign({}, ...LEAGUE_GROUPS.map((g) => g.ids));
  const LEAGUES = Object.keys(COMPETITIONS);
  const S365 = "https://webws.365scores.com/web";
  const S365_PARAMS = { appTypeId: 5, langId: 1, timezoneName: "Europe/London", userCountryId: -1 };
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
  // sim.py
  const N_SIMS = 12000, PRIOR_MINUTES = 450, REST_SHARE = 0.05, XG_WEIGHT = 0.6;
  const START_PROB = { true: { Starting: 1.0, Substitute: 0.0 }, false: { Starting: 1.0, Substitute: 0.08 } };
  const SUB_APPEAR_PROB = 0.35, SUB_MINUTES = 22, DOUBTFUL_START = 0.45;
  const START_MINUTES = { F: 78, M: 82, D: 88, G: 90 }, PRIOR_STARTS = 4;
  const POSITIONS = { Goalkeeper: "G", Defender: "D", Midfielder: "M", Attacker: "F" };
  const DEFAULT_RATES = { F: [2.6, 1.0, 0.40, 0.15], M: [1.2, 0.40, 0.12, 0.20], D: [0.6, 0.18, 0.05, 0.20], G: [0, 0, 0, 0.05] };
  const STYLES = { Banker: [0.72, 0.95], Balanced: [0.55, 0.90], Punchy: [0.35, 0.78] };
  const FOCUS = { Mix: [2, 4], Players: [4, 2], Match: [0, 99] };
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
  const MATCHES_KEPT = 8; // simulated matches kept in memory (each holds ~12 MB of legs)

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
    const meta = ((await data("fixtures.json")) || { fixtures: {} }).fixtures[id] || null;
    const fd = (meta && meta.fd) || {};
    const [quotes365, detailResp, table, formH, formA, pm, profH, profA, playersH, playersA, recentH, recentA] = await Promise.all([
      odds365(id), s365("game", { gameId: id }), standings(league), form(hc.id), form(ac.id),
      meta && meta.pm_slug ? polymarket(meta.pm_slug, home, away) : null,
      fd.home ? data(`profiles/${fd.home[0]}.json`) : null, fd.away ? data(`profiles/${fd.away[0]}.json`) : null,
      meta && meta.sh ? data(`players/${meta.sh[0]}.json`) : null, meta && meta.sh ? data(`players/${meta.sh[1]}.json`) : null,
      recentForm(hc.id), recentForm(ac.id),
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

    const lineups = {};
    for (const [side, key] of [["home", "homeCompetitor"], ["away", "awayCompetitor"]]) {
      const lu = (detail[key] || {}).lineups || {};
      lineups[side] = { status: lu.status || "Not published", formation: lu.formation || null };
    }
    const confirmed = lineups.home.status === "Confirmed" && lineups.away.status === "Confirmed";
    if (!confirmed) warnings.push("Lineups not confirmed yet — HAWK rule: don't lock the ticket until they are.");

    let refName = ((detail.officials || [])[0] || {}).name || null, refAvg = null, refGames = null, refSource = null;
    if (meta && meta.ref && meta.ref.avg_cards) { refName = meta.ref.name; refAvg = meta.ref.avg_cards; refGames = meta.ref.games; refSource = "StatsHub"; }
    else if (refName) { const r = refereeFromProfile(refName, profH); if (r) { [refAvg, refGames] = r; refSource = "football-data"; } }
    const refFactor = refereeFactor(refAvg, refGames, profH && profH.avg_cards_total);

    const lamModel = profH && profA ? expectedPair(profH, fdH, profA, fdA, "goals") : null;
    for (const [team, fdName, p] of [[home, fdH, profH], [away, fdA, profA]]) {
      if (!fdName) warnings.push(`${team}: not found in football-data — model can't rate them, using market only.`);
      else if (p && ((p.teams[fdName] || {}).games_this_season || 0) < 3)
        warnings.push(`${team}: under 3 league games this season, ratings lean on last season${(p.teams[fdName] || {}).promoted ? " (promoted — starts from a below-average prior)" : ""}.`);
    }
    const c1x2 = cons["1|"];
    const p1x2 = c1x2 && ["1", "X", "2"].every((k) => k in c1x2.probs) ? [c1x2.probs["1"], c1x2.probs.X, c1x2.probs["2"]] : null;
    const totals = Object.entries(cons).filter(([k, c]) => k.startsWith("3|") && halfLine(k.slice(2)) != null && "Over" in c.probs)
      .map(([k, c]) => [parseFloat(k.slice(2)), c.probs.Over]);
    const lamMarket = p1x2 || totals.length ? fitGoalLambdas(p1x2, totals) : null;
    let lamBlend = null, ignored = false;
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
    }
    if (ignored) warnings.push("HAWK's goal model disagrees strongly with the bookmakers on this match (usually a big favourite it underrates) — trusting the market instead.");

    const statModel = {}, statMarket = {}, statBlend = {};
    for (const [t, stat] of Object.entries(STAT_TYPES)) {
      const pair = profH && profA ? expectedPair(profH, fdH, profA, fdA, stat) : null;
      let total = pair ? pair[0] + pair[1] : null;
      if (total && stat === "cards") total *= refFactor;
      statModel[stat] = total;
      const lines = Object.entries(cons).filter(([k, c]) => k.startsWith(`${t}|`) && halfLine(k.split("|")[1]) != null && "Over" in c.probs)
        .map(([k, c]) => [parseFloat(k.split("|")[1]), c.probs.Over]);
      statMarket[stat] = lines.length ? fitTotalLambda(lines) : null;
      statBlend[stat] = blend(total, statMarket[stat]);
    }
    return {
      id, league, home, away, homeComp: hc, awayComp: ac, kickoff, inPlay: !!(kickoff && kickoff < new Date()),
      quotes, cons, polymarket: pm, lineups, confirmed, detail, table, form: { home: formH, away: formA }, recentForm: { home: recentH, away: recentA },
      referee: { name: refName, avg: refAvg, games: refGames, source: refSource, factor: refFactor },
      profiles: [profH, fdH, profA, fdA], lamModel, lamMarket, lamBlend, M: lamBlend ? scoreMatrix(...lamBlend) : null,
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
    const squads = {}, missing = {};
    an.missing = missing;
    for (const [side, key] of [["home", "homeCompetitor"], ["away", "awayCompetitor"]]) {
      const lineup = (an.detail[key] || {}).lineups || {};
      const confirmed = lineup.status === "Confirmed";
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
                field, info.jerseyNumber || null, info.shortName || null];
      });
      if (!entries.some((e) => e[1] === "Starting") && sh[side].length) {
        // No lineup from 365Scores: the most-used players lately, minus the injured and suspended.
        const mins = (p) => p.matches.slice(0, 5).reduce((s, m) => s + m.minutes, 0);
        const recent = sh[side].filter((p) => !listed(p.name, "Missing")).sort((a, b) => mins(b) - mins(a));
        entries = recent.slice(0, 18).map((p, i) => [p.name, i < 11 ? "Starting" : "Substitute", p.position, null]);
      }
      squads[side] = entries.map(([name, status, pos, photo, field = null, num = null, short = null]) => {
        const match = Object.keys(byName).length ? bestMatch(name, Object.keys(byName), 0.6) : null;
        const matches = match ? byName[match].matches : [];
        pos = pos || (match && byName[match].position) || "M";
        const r = rates(matches, priors[pos] || DEFAULT_RATES.M, pos, teamHasExtras ? xpriors[pos] || EXTRA_DEFAULTS.M : null);
        // A doubtful player in a predicted lineup may well not start (and gets no legs).
        const doubt = !confirmed && listed(name, "Doubtful") ? DOUBTFUL_START : 1;
        return { ...r, name, pos, status, photo, field, num, short, start_p: START_PROB[confirmed][status] * doubt, doubtful: doubt < 1,
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
  function simulate(an, squads) {
    const rng = mulberry32(7), n = N_SIMS, exp = teamExpectations(an), M = an.M;
    const cells = [], cum = [];
    let acc = 0;
    for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) { acc += M[i][j]; cells.push([i, j]); cum.push(acc); }
    const goals = { home: new Int16Array(n), away: new Int16Array(n) };
    const half1 = { home: new Int16Array(n), away: new Int16Array(n) }; // first-half goals
    const first = new Int8Array(n); // 1 = home scored first, 2 = away, 0 = no goal
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
      first[s] = h + a ? (rng() * (h + a) < h ? 1 : 2) : 0;
    }
    const cornersTeam = { home: new Int16Array(n), away: new Int16Array(n) }, corners = new Int16Array(n);
    for (let s = 0; s < n; s++) {
      cornersTeam.home[s] = poisson(rng, exp.cornersTeam[0]); cornersTeam.away[s] = poisson(rng, exp.cornersTeam[1]);
      corners[s] = cornersTeam.home[s] + cornersTeam.away[s];
    }
    const teamSot = {}, teamShots = {}, teamCards = {};
    ["home", "away"].forEach((side, t) => {
      const g = goals[side], sot = new Int16Array(n), shots = new Int16Array(n), cards = new Int16Array(n);
      for (let s = 0; s < n; s++) {
        sot[s] = g[s] + poisson(rng, Math.max(exp.sot[t] - exp.goals[t], 0.4));
        shots[s] = sot[s] + poisson(rng, Math.max(exp.shots[t] - exp.sot[t], 0.8));
        cards[s] = poisson(rng, exp.cards[t]);
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
    return { n, exp, goals, half1, first, corners, cornersTeam, teamSot, player, teamCards, squads };
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

  function mask(n, test) { const m = new Uint8Array(n); for (let s = 0; s < n; s++) m[s] = test(s) ? 1 : 0; return m; }
  const mean = (m) => { let c = 0; for (let s = 0; s < m.length; s++) c += m[s]; return c / m.length; };

  function catalogue(an, sim) {
    const { home, away } = an, n = sim.n, hg = sim.goals.home, ag = sim.goals.away, legs = {};
    const add = (id, label, market, group, arr, extra = {}) => {
      const p = mean(arr);
      if (p >= MIN_LEG_P && p <= MAX_LEG_P) legs[id] = { id, label, market, group, arr, p, fair: 1 / p, kind: "match", ...extra };
    };
    add("res:home", `Result: ${home}`, "Full Time Result", "result", mask(n, (s) => hg[s] > ag[s]));
    add("res:draw", "Result: Draw", "Full Time Result", "result", mask(n, (s) => hg[s] === ag[s]));
    add("res:away", `Result: ${away}`, "Full Time Result", "result", mask(n, (s) => ag[s] > hg[s]));
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
      add(`corners:o${line}`, withCount(`Over ${line} Corners`, "Over", line), "Corners", "corners", mask(n, (s) => sim.corners[s] > line));
      add(`corners:u${line}`, withCount(`Under ${line} Corners`, "Under", line), "Corners", "corners", mask(n, (s) => sim.corners[s] < line));
    }
    const tc = (s) => sim.teamCards.home[s] + sim.teamCards.away[s];
    for (const line of [2.5, 3.5, 4.5, 5.5]) {
      add(`cards:o${line}`, withCount(`Over ${line} Cards`, "Over", line), "Total Cards", "cards", mask(n, (s) => tc(s) > line));
      add(`cards:u${line}`, withCount(`Under ${line} Cards`, "Under", line), "Total Cards", "cards", mask(n, (s) => tc(s) < line));
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
        add(`tcorners:${side}:o${line}`, withCount(`${name} Over ${line} Corners`, "Over", line), "Team Corners", `team_corners:${side}`, mask(n, (s) => c[s] > line));
        add(`tcorners:${side}:u${line}`, withCount(`${name} Under ${line} Corners`, "Under", line), "Team Corners", `team_corners:${side}`, mask(n, (s) => c[s] < line));
      }
      for (const line of [0.5, 1.5, 2.5, 3.5])
        add(`tcards:${side}:o${line}`, withCount(`${name} Over ${line} Cards`, "Over", line), "Team Cards", `team_cards:${side}`, mask(n, (s) => k[s] > line));
      for (const line of [1.5, 2.5])
        add(`tcards:${side}:u${line}`, withCount(`${name} Under ${line} Cards`, "Under", line), "Team Cards", `team_cards:${side}`, mask(n, (s) => k[s] < line));
    }
    add("mostcorners:home", `${home} Most Corners`, "Most Corners", "most_corners", mask(n, (s) => sim.cornersTeam.home[s] > sim.cornersTeam.away[s]));
    add("mostcorners:away", `${away} Most Corners`, "Most Corners", "most_corners", mask(n, (s) => sim.cornersTeam.away[s] > sim.cornersTeam.home[s]));
    const tsot = (s) => sim.teamSot.home[s] + sim.teamSot.away[s];
    for (const line of [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5]) {
      add(`sot:o${line}`, withCount(`Over ${line} Shots on Target`, "Over", line), "Match Shots on Target", "sot", mask(n, (s) => tsot(s) > line));
      add(`sot:u${line}`, withCount(`Under ${line} Shots on Target`, "Under", line), "Match Shots on Target", "sot", mask(n, (s) => tsot(s) < line));
    }

    for (const [key, a] of Object.entries(sim.player)) {
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

  const FIXED_BOOK_LINES = { "res:home": [1, "", "1"], "res:draw": [1, "", "X"], "res:away": [1, "", "2"], "dc:home": [14, "", "1X"],
    "dc:away": [14, "", "X2"], "btts:yes": [12, "", "Yes"], "btts:no": [12, "", "No"], "cs:home": [144, "", "Yes"], "cs:away": [145, "", "Yes"],
    "h1res:home": [5, "", "1"], "h1res:draw": [5, "", "X"], "h1res:away": [5, "", "2"],
    "h2res:home": [6, "", "1"], "h2res:draw": [6, "", "X"], "h2res:away": [6, "", "2"],
    "first:home": [7, "", "Home"], "first:away": [7, "", "Away"] };
  const LINE_TYPES = { goals: 3, corners: 137, cards: 141, h1goals: 9, sot: 139 };
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
  const valueScore = (leg) => (leg.bookPrice > 1 ? leg.bookPrice * leg.p - 1 : UNPRICED_EDGE) + (leg.agree === true ? 0.015 : leg.agree === false ? -0.015 : 0);
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
    return { p, fair: p > 0 ? 1 / p : null, legs: rows };
  }
  function pruneImplied(legs, chosen, keep, n) {
    for (const id of chosen.slice()) {
      if (keep.has(id) || chosen.length < 2) continue;
      const others = chosen.filter((x) => x !== id);
      if (mean(maskOf(legs, others, n)) - mean(maskOf(legs, chosen, n)) < 0.002) chosen.splice(chosen.indexOf(id), 1);
    }
    return chosen;
  }
  function autoBuild(legs, target, style = "Balanced", maxLegs = 10, locked = [], banned = new Set(), favourite = true, focus = "Mix", extras = false, picks = "likely") {
    const [lo, hi] = STYLES[style] || STYLES.Balanced;
    let [minPlayers, maxMatch] = FOCUS[focus] || FOCUS.Mix;
    const all = Object.values(legs);
    if (!all.length) return evaluate(legs, []);
    const n = all[0].arr.length;
    let chosen = locked.filter((i) => legs[i]);
    if (favourite && !chosen.some((i) => legs[i].group === "result")) {
      const side = ["home", "away"].sort((a, b) => ((legs[`res:${b}`] || {}).p || 0) - ((legs[`res:${a}`] || {}).p || 0))[0];
      for (const [id, floor] of [[`res:${side}`, 0.5], [`dc:${side}`, 0.6]]) if (legs[id] && !banned.has(id) && legs[id].p >= floor) { chosen.unshift(id); break; }
    }
    const keep = new Set(chosen);
    let m = maskOf(legs, chosen, n);
    while (chosen.length < maxLegs) {
      const adjNow = adjOf(legs, chosen), pNow = mean(m) * adjNow;
      if (pNow === 0 || 1 / pNow >= target) break;
      const groups = new Set(chosen.map((i) => legs[i].group)), perPlayer = {};
      for (const i of chosen) { const k = playerKey(legs[i]); if (k) perPlayer[k] = (perPlayer[k] || 0) + 1; }
      const nPlayers = Object.values(perPlayer).reduce((s, x) => s + x, 0), nMatch = chosen.length - nPlayers;
      let want = nPlayers < minPlayers || nMatch >= maxMatch ? "player" : null;
      if (focus === "Match") want = "match";
      let best = null, bestScore = null;
      for (const leg of all) {
        if (chosen.includes(leg.id) || banned.has(leg.id) || groups.has(leg.group) || leg.low_data || (leg.extra && !extras)) continue;
        if (want && leg.kind !== want) continue;
        const k = playerKey(leg);
        if (k && (perPlayer[k] || 0) >= MAX_LEGS_PER_PLAYER) continue;
        let c = 0; const a = leg.arr;
        for (let s = 0; s < n; s++) c += m[s] & a[s];
        const joint = (c / n) * adjNow * (leg.adj || 1), cond = joint / pNow;
        if (cond < lo || cond > hi) continue;
        const reaches = joint > 0 && 1 / joint >= target, t = trust[leg.market] || 1;
        const score = picks === "value" ? [reaches ? 1 : 0, valueScore(leg) - (1 - t), cond] : [reaches ? 1 : 0, (reaches ? joint : cond) * t];
        if (!bestScore || isBetter(score, bestScore)) { best = leg.id; bestScore = score; }
      }
      if (!best) {
        if (want === "player" && nMatch < maxMatch && focus !== "Match" && minPlayers > 0) { minPlayers = 0; continue; }
        break;
      }
      chosen.push(best);
      chosen = pruneImplied(legs, chosen, keep, n);
      m = maskOf(legs, chosen, n);
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
    const regularsOut = (side) => {
      const rows = playerRows(an.players[side === "home" ? 0 : 1]), names = rows.map((p) => p.name);
      return ((an.missing || {})[side] || []).filter((m) => m.status === "Missing").map((m) => {
        const hit = names.length ? bestMatch(m.name, names, 0.6) : null, p = hit && rows.find((r) => r.name === hit);
        return p && p.matches.slice(0, 5).reduce((s, x) => s + x.minutes, 0) >= 270 ? m.name : null;
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
    // 6. Rotation: how many of the favourite's regulars (270+ minutes in their
    // last 5 games) are in the lineup. Big favourites lose most often with a
    // changed team — above all in cups.
    const regulars = (p) => (p.recent || []).slice(0, 5).reduce((s, x) => s + x.minutes, 0) >= 270;
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
      kickoff: an.kickoff ? an.kickoff.toISOString() : null, started: an.inPlay, lineups: an.lineups, referee: an.referee,
      probs: { home: sumCells(M, (i, j) => i > j), draw: sumCells(M, (i, j) => i === j), away: sumCells(M, (i, j) => i < j),
               market, polymarket: an.polymarket, model },
      expected: sim.exp, grid, table: { home: tableRow(an.homeComp), away: tableRow(an.awayComp) }, form: an.form,
      legs: legJSON, priceBook: PRICE_BOOK,
      players: Object.fromEntries(Object.entries(squads).map(([side, sq]) => [side, sq.map((p) => ({
        name: p.name, pos: p.pos, status: p.status, photo: p.photo, start_p: p.start_p, doubtful: p.doubtful, sh90: p.sh90, sot90: p.sot90,
        g90: p.g90, c90: p.c90, x: p.x, sv90: p.sv90, minutes: p.minutes, has_data: p.has_data, recent: p.recent,
        recent_starts: p.recent_starts, field: p.field, num: p.num, short: p.short }))])),
      warnings: an.warnings, value: { book: PRICE_BOOK, legs: value }, sims: sim.n, missing: an.missing || { home: [], away: [] },
      movers: an.inPlay ? [] : moverRows(an, sim.exp).slice(0, 8),
      upset: upsetRadar(an, M, squads, sim.exp),
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
    return autoBuild(e.legs, +body.target || 3, body.style, +body.maxLegs || 10, body.locked || [], new Set(body.banned || []),
                     body.favourite !== false, body.focus || "Mix", !!body.extras, body.picks === "value" ? "value" : "likely");
  }
  const evaluateBody = (body) => evaluate(entryFor(body.id).legs, body.legs || []);
  // "Build again": up to `count` different tickets for the same settings. The
  // first is the normal build; the others come from building again with one
  // of its legs (or all of them) left out, and so on, keeping only tickets
  // that still reach the target. They're picked to differ from each other as
  // much as possible, best first (fewest legs = least bookmaker margin).
  function buildOptions(body, count = 5) {
    const e = entryFor(body.id), target = +body.target || 3, locked = body.locked || [];
    const run = (banned) => autoBuild(e.legs, target, body.style, +body.maxLegs || 10, locked, banned, body.favourite !== false,
                                      body.focus || "Mix", !!body.extras, body.picks === "value" ? "value" : "likely");
    const base = new Set(body.banned || []), key = (t) => t.legs.map((l) => l.id).sort().join("|");
    const first = run(base);
    if (!first.legs.length) return { options: [first] };
    const reaches = (t) => t.legs.length && t.fair >= target * 0.97;
    const free = (t) => t.legs.map((l) => l.id).filter((id) => !locked.includes(id) && e.legs[id].group !== "result");
    const found = new Map([[key(first), first]]);
    const tryBan = (ids) => { const t = run(new Set([...base, ...ids])); if (reaches(t) && !found.has(key(t))) found.set(key(t), t); return t; };
    for (const id of free(first)) tryBan([id]);
    const fresh = tryBan(free(first));                      // a ticket with none of the first one's legs
    for (const id of free(fresh)) tryBan([...free(first), id]);
    // Best first, then as different as possible from the ones already chosen.
    const quality = (t) => t.legs.length * 10 + Math.abs(Math.log(t.fair / target));
    const pool = [...found.values()].slice(1).sort((a, b) => quality(a) - quality(b));
    const chosen = [first];
    while (chosen.length < count && pool.length) {
      const overlap = (t) => Math.max(...chosen.map((c) => t.legs.filter((l) => c.legs.some((x) => x.id === l.id)).length / t.legs.length));
      let bestI = 0, bestV = Infinity;
      pool.forEach((t, i) => { const v = quality(t) + 12 * overlap(t); if (v < bestV) { bestV = v; bestI = i; } });
      chosen.push(pool.splice(bestI, 1)[0]);
    }
    return { options: chosen.sort((a, b) => quality(a) - quality(b)) };
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
               corners: pair("Corners"), cards: yellow ? [yellow[0] + red[0], yellow[1] + red[1]] : null, sot: pair("Shots On Target") };
    }));
    return { home: g.homeCompetitor.name, away: g.awayCompetitor.name, games };
  }

  async function lineups(id) {
    const d = await s365("game", { gameId: id });
    const g = (d && d.game) || {};
    const st = { home: ((g.homeCompetitor || {}).lineups || {}).status, away: ((g.awayCompetitor || {}).lineups || {}).status };
    return { ...st, confirmed: st.home === "Confirmed" && st.away === "Confirmed",
             started: !!(g.startTime && new Date(g.startTime) < new Date()) };
  }

  // Background jobs over every fixture in a time window, two matches at a
  // time: the "Best builders" scan and the Value finder.
  function newJob() { return { running: false, stop: false, total: 0, done: 0, errors: 0, results: [], params: null }; }
  const jobStatus = (job) => ({ ...job, results: job.results.slice(), movers: (job.movers || []).slice() });
  function windowParams(body) {
    return { leagues: (body.leagues || []).filter((l) => LEAGUES.includes(l)), hours: Math.min(Math.max(+body.hours || 24, 1), 168) };
  }
  async function runFixtureJob(job, perMatch) {
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
        const [league, f] = todo[next++], id = String(f.id), wasOpen = matches.has(id);
        try { const json = await match(league, id); perMatch(league, f, json, matches.get(id)); }
        catch (err) { console.warn("[hawk] skipped", f.home, "v", f.away, err.message); job.errors++; }
        // Don't keep scanned matches around (memory), only ones you opened.
        if (!wasOpen) matches.delete(id);
        job.done++;
      }
    };
    await Promise.all([worker(), worker()]);
    job.running = false;
  }
  const fixtureInfo = (league, f, json) => ({ league, id: String(f.id), home: f.home, away: f.away, homeCrest: f.homeCrest,
    awayCrest: f.awayCrest, kickoff: f.kickoff, confirmed: json.lineups.home.status === "Confirmed" && json.lineups.away.status === "Confirmed" });

  const scan = newJob();
  function startScan(body) {
    if (scan.running) return jobStatus(scan);
    const params = { ...windowParams(body), target: Math.min(Math.max(+body.target || 3, 1.2), 50),
                     style: STYLES[body.style] ? body.style : "Balanced", focus: FOCUS[body.focus] ? body.focus : "Mix",
                     maxLegs: Math.min(Math.max(+body.maxLegs || 10, 2), 12), extras: !!body.extras, picks: body.picks === "value" ? "value" : "likely" };
    Object.assign(scan, newJob(), { running: true, params });
    runFixtureJob(scan, (league, f, json, e) => {
      const t = autoBuild(e.legs, params.target, params.style, params.maxLegs, [], new Set(), true, params.focus, params.extras, params.picks);
      scan.results.push({ ...fixtureInfo(league, f, json), p: t.p, fair: t.fair, legs: t.legs.map((r) => legSummary(e, json, r.id)),
        value: json.value.legs.slice(0, 4).map((v) => ({ label: v.label, price: v.price, edge: v.edge })) });
    });
    return jobStatus(scan);
  }
  // Upset watch: the upset radar for every fixture in the window (the Radar page).
  const radarJob = newJob();
  function startRadar(body) {
    if (radarJob.running) return jobStatus(radarJob);
    Object.assign(radarJob, newJob(), { running: true, params: windowParams(body) });
    runFixtureJob(radarJob, (league, f, json) => {
      if (json.started || !json.upset) return;
      radarJob.results.push({ ...fixtureInfo(league, f, json), upset: json.upset,
                              probs: { home: json.probs.home, draw: json.probs.draw, away: json.probs.away } });
    });
    return jobStatus(radarJob);
  }
  // What an acca needs to remember about one leg once the match isn't loaded.
  function legSummary(e, json, id) {
    const l = e.legs[id], j = json.legs.find((x) => x.id === id) || {};
    return { id, label: l.label, market: l.market, kind: l.kind, p: l.p, pRaw: l.pRaw, fair: l.fair, bookPrice: j.bookPrice || null,
             player: l.player || null, side: l.side || null };
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
        let best = null;
        for (const leg of json.legs) {
          // Below 1.15 a leg adds risk but hardly any odds, so it's left out.
          if (!leg.bookPrice || leg.bookPrice < MIN_ACCA_PRICE || leg.kind !== "match" || leg.p < lo || leg.p > hi) continue;
          const ratio = leg.bookPrice * leg.p; // above 1 = Bet365 pays more than fair
          if (!best || ratio > best.ratio + 1e-9 || (Math.abs(ratio - best.ratio) <= 1e-9 && leg.p > best.leg.p)) best = { leg, ratio };
        }
        if (best) monster.results.push({ ...info, legs: [legSummary(e, json, best.leg.id)], p: best.leg.p, fair: best.leg.fair,
                                         bookPrice: best.leg.bookPrice, ratio: best.ratio, upset: json.upset });
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
      if (k >= 0) (stats[s.name] ||= [null, null])[k] = parseFloat(String(s.value).replace("%", "")) || 0;
    }
    const rem = remainingMinutes(game.gameTime, game.statusText), elapsed = Math.min(95, Math.max(0, Number(game.gameTime) || 0));
    const cons = liveConsensus(quotes), c1 = cons["1|"];
    const p1x2 = c1 && ["1", "X", "2"].every((k) => k in c1.probs) ? [c1.probs["1"], c1.probs.X, c1.probs["2"]] : null;
    const totals = Object.entries(cons).filter(([k, c]) => k.startsWith("3|") && halfLine(k.slice(2)) != null && "Over" in c.probs)
      .map(([k, c]) => [parseFloat(k.slice(2)), c.probs.Over]);
    const pre = await preMatchLambdas(file && file.fixtures && file.fixtures[id]);
    let rates, basis;
    if (p1x2 || totals.length) { rates = fitRemaining(sh, sa, p1x2, totals); basis = "live prices"; }
    else if (pre) {
      // No live prices: pre-match strength for the time left, nudged for the score and red cards.
      const diff = sh - sa;
      rates = pre.map((l, k) => {
        const mine = k === 0 ? diff : -diff, chase = mine < 0 ? Math.min(1.25, 1 + 0.1 * -mine) : mine > 0 ? 0.92 : 1;
        return (l * rem) / 95 * chase * Math.pow(0.75, reds[k]) * Math.pow(1.2, reds[1 - k]);
      });
      basis = "pre-match ratings";
    } else return { ...base, live: true, score: [sh, sa], reds, stats, noModel: true, rows: [] };
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
    return { ...base, live: true, score: [sh, sa], reds, stats, basis, remaining: rem, books: c1 ? c1.books : 0, tilt,
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
    const now = { corners: pair("Corners"), sot: pair("Shots On Target"), cards: pair("Yellow Cards").map((v, k) => v + pair("Red Cards")[k]) };
    const w = elapsed / (elapsed + 40);
    const lamStat = (stat, k) => rem * (w * (elapsed > 0 ? now[stat][k] / elapsed : 0) + (1 - w) * TYPICAL_90[stat] / 90);
    // Half-time and first goal.
    const ht = (game.stages || []).find((s) => s.id === 7 && s.isEnded);
    const inFirstHalf = !ht && /1st/i.test(st.statusText || "");
    const goals = (game.events || []).filter((e) => e.eventType && e.eventType.id === 1).sort((a, b) => (a.order || 0) - (b.order || 0));
    // Players: live numbers, who's still on, and their usual rates.
    const names = Object.fromEntries((game.members || []).map((m) => [m.id, m.name]));
    const subsIn = new Set(), subsOut = new Set(), sentOff = new Set(), booked = new Set();
    for (const e of game.events || []) {
      const n = ((e.eventType || {}).name || "").toLowerCase();
      if (n.includes("substitution")) { subsIn.add(e.playerId); (e.extraPlayers || []).forEach((p) => subsOut.add(p)); }
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
        return { name: names[m.id] || "", pos: POSITIONS[(m.position || {}).name] || "M", on, played: started || subsIn.has(m.id) || mins > 0, booked: booked.has(m.id),
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
      if ((t = goalTest(id2))) {
        goalTests.push(t);
        row.p = sumCells(M, t);
        if (row.p > 0.9999) { row.state = "won"; row.p = 1; } else if (row.p < 1e-4) { row.state = "lost"; row.p = 0; }
        row.note = `score ${sh}-${sa}`;
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
        const pl = (() => { const list = livePlayers[side] || [], hit = list.length ? bestMatch(h.player || h.label.split(/:| to /)[0], list.map((p) => p.name), 0.6) : null; return list.find((p) => p.name === hit); })();
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
          }
          row.note = `${pl.on ? "on the pitch" : "off"} · ${stat === "booked" ? (pl.booked ? "booked" : "not booked") : `${stat === "soa" ? pl.v.score + pl.v.assist : pl.v[stat] || 0} so far`}`;
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
    const res = await s365("games/allscores", { competitions: Object.values(COMPETITIONS).join(","), startDate: date, endDate: date }, 20 * 1000);
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
    const events = (game.events || []).filter((e) => e.eventType && /goal|card/i.test(e.eventType.name || "")).map((e) => ({
      side: e.competitorId === hc.id ? "home" : "away", minute: e.gameTimeDisplay || "", type: /goal/i.test(e.eventType.name) ? "goal" : /red/i.test(e.eventType.name) ? "red" : "yellow",
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

  // Market movers: Bet365 selections whose price has moved 5%+ since it opened.
  // A shortening price means money has come for it. "agree" = the move went
  // towards HAWK's fair price (it shortened from above HAWK's fair, or drifted
  // from below it); "value" = what's left of the edge at today's price.
  // Correct scores and long shots are left out: their prices jump in big steps
  // (100 → 150) that say nothing about where the money is going.
  const MOVER_SKIP_TYPES = new Set([126, 127]), MOVER_MAX_PRICE = 10;
  function moverRows(an, exp, minMove = 0.05) {
    const rows = [];
    for (const b of an.quotes) {
      if (b.book !== PRICE_BOOK || !b.opens || b.source !== "365Scores" || MOVER_SKIP_TYPES.has(b.type)) continue;
      const cons = an.cons[`${b.type}|${b.value}`];
      for (const [option, price] of Object.entries(b.prices)) {
        const open = b.opens[option];
        if (!(open > 1) || Math.max(open, price) > MOVER_MAX_PRICE) continue;
        const move = price / open - 1;
        if (Math.abs(move) < minMove) continue;
        const model = selectionModel(an, exp, b.type, b.value, option), pMarket = cons ? cons.probs[option] : null;
        const [w, ignored] = marketTrust(model && model.q, pMarket, cons ? cons.books : 0);
        const q = ignored ? pMarket : blend(model ? model.q : null, pMarket, w);
        if (!(q > 0 && q < 1)) continue;
        const fair = 1 / q;
        rows.push({ type: b.type, market: b.market, label: marketLabel(b.type, b.market, b.value, option, an.home, an.away),
                    open, price, move, p: q, fair, agree: move < 0 ? fair < open : fair > open, value: price * q - 1 });
      }
    }
    return rows.sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
  }

  const valueJob = newJob();
  function startValue(body) {
    if (valueJob.running) return jobStatus(valueJob);
    Object.assign(valueJob, newJob(), { running: true, params: windowParams(body), movers: [] });
    runFixtureJob(valueJob, (league, f, json, e) => {
      const info = fixtureInfo(league, f, json);
      for (const row of priceRows(e)) valueJob.results.push({ ...info, ...row });
      for (const row of moverRows(e.an, json.expected)) valueJob.movers.push({ ...info, ...row });
    });
    return jobStatus(valueJob);
  }

  global.HAWK = { LEAGUES, LEAGUE_GROUPS, COMPETITIONS, fixtures, match, build, buildOptions, evaluate: evaluateBody, lineups, livePrices, legPrices, setLearning, setTrust, h2h, learnKey, liveMatch,
                  scores, matchReport, ticketLive,
                  startMonster, monsterStatus: () => jobStatus(monster), stopMonster: () => { monster.stop = true; return jobStatus(monster); },
                  startScan, scanStatus: () => jobStatus(scan), stopScan: () => { scan.stop = true; return jobStatus(scan); },
                  startRadar, radarStatus: () => jobStatus(radarJob), stopRadar: () => { radarJob.stop = true; return jobStatus(radarJob); },
                  startValue, valueStatus: () => jobStatus(valueJob), stopValue: () => { valueJob.stop = true; return jobStatus(valueJob); },
                  meta: () => data("meta.json"),
                  _internals: { analyse, buildSquads, simulate, catalogue, autoBuild, evaluate, consensus, fitGoalLambdas,
                                selectionModel, priceRows, entry: (id) => matches.get(String(id)), liveState, finalMatrix,
                                fitTotalLambda, scoreMatrix, nameSimilarity, bestMatch } };
})(window);
