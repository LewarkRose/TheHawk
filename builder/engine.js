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
  const LEAGUES = ["Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Champions League"];
  const S365 = "https://webws.365scores.com/web";
  const S365_PARAMS = { appTypeId: 5, langId: 1, timezoneName: "Europe/London", userCountryId: -1 };
  const COMPETITIONS = { "Premier League": 7, "La Liga": 11, "Serie A": 17, "Bundesliga": 25, "Ligue 1": 35, "Champions League": 572 };
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
  const SUB_APPEAR_PROB = 0.35, SUB_MINUTES = 22;
  const START_MINUTES = { F: 78, M: 82, D: 88, G: 90 }, PRIOR_STARTS = 4;
  const POSITIONS = { Goalkeeper: "G", Defender: "D", Midfielder: "M", Attacker: "F" };
  const DEFAULT_RATES = { F: [2.6, 1.0, 0.40, 0.15], M: [1.2, 0.40, 0.12, 0.20], D: [0.6, 0.18, 0.05, 0.20], G: [0, 0, 0, 0.05] };
  const STYLES = { Banker: [0.72, 0.95], Balanced: [0.55, 0.90], Punchy: [0.35, 0.78] };
  const FOCUS = { Mix: [2, 4], Players: [4, 2], Match: [0, 99] };
  const MAX_LEGS_PER_PLAYER = 3, MIN_LEG_P = 0.04, MAX_LEG_P = 0.97, MIN_AUTO_MINUTES = 270;
  const MATCH_TTL = 10 * 60 * 1000;

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
  async function fixtures(league) {
    const d = await s365("games/fixtures", { competitions: COMPETITIONS[league] }, 5 * 60 * 1000);
    if (!d) throw new Error("365Scores didn't return fixtures — try again in a moment");
    const now = Date.now();
    return (d.games || []).filter((g) => g.statusGroup !== 4)
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
        const prices = {};
        for (const o of line.options || []) {
          const price = o.rate && o.rate.decimal;
          if (o.name && price > 1) prices[String(o.name)] = +price;
        }
        if (Object.keys(prices).length) quotes.push({
          book: names[line.bookmakerId] || `Book ${line.bookmakerId}`, type: line.lineTypeId,
          market: (line.lineType || {}).name || "", value: String(line.internalOptionValue || ""), prices, source: "365Scores" });
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
    const [quotes365, detailResp, table, formH, formA, pm, profH, profA, playersH, playersA] = await Promise.all([
      odds365(id), s365("game", { gameId: id }), standings(league), form(hc.id), form(ac.id),
      meta && meta.pm_slug ? polymarket(meta.pm_slug, home, away) : null,
      fd.home ? data(`profiles/${fd.home[0]}.json`) : null, fd.away ? data(`profiles/${fd.away[0]}.json`) : null,
      meta && meta.sh ? data(`players/${meta.sh[0]}.json`) : null, meta && meta.sh ? data(`players/${meta.sh[1]}.json`) : null,
    ]);
    const detail = (detailResp && detailResp.game) || {};
    const fdH = fd.home && fd.home[1], fdA = fd.away && fd.away[1];
    const warnings = [];
    if (!meta) warnings.push("This fixture isn't in HAWK's data files yet (they refresh every few hours) — using bookmaker prices only, no player legs.");

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
      quotes, cons, polymarket: pm, lineups, confirmed, detail, table, form: { home: formH, away: formA },
      referee: { name: refName, avg: refAvg, games: refGames, source: refSource, factor: refFactor },
      profiles: [profH, fdH, profA, fdA], lamModel, lamMarket, lamBlend, M: lamBlend ? scoreMatrix(...lamBlend) : null,
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
  function rates(matches, prior, pos) {
    const [mins, shots, sot, goals, cards] = totalsOf(matches);
    const w = (mins + PRIOR_MINUTES) / 90, v = PRIOR_MINUTES / 90;
    let [sh90, sot90, g90, c90] = [shots, sot, goals, cards].map((x, i) => (x + prior[i] * v) / w);
    sot90 = Math.max(sot90, g90 * 1.05);
    sh90 = Math.max(sh90, sot90 * 1.1);
    const starts = matches.filter((m) => !m.sub_in).map((m) => m.minutes);
    const typical = START_MINUTES[pos] || 82;
    const startMin = Math.min(90, Math.max(55, (starts.reduce((s, x) => s + x, 0) + PRIOR_STARTS * typical) / (starts.length + PRIOR_STARTS)));
    return { sh90, sot90, g90, c90, start_min: startMin, minutes: mins, apps: matches.length };
  }
  function buildSquads(an) {
    const members = Object.fromEntries((an.detail.members || []).map((m) => [m.id, m]));
    const sh = { home: playerRows(an.players[0]), away: playerRows(an.players[1]) };
    const priors = positionPriors([...sh.home, ...sh.away]);
    const squads = {};
    for (const [side, key] of [["home", "homeCompetitor"], ["away", "awayCompetitor"]]) {
      const lineup = (an.detail[key] || {}).lineups || {};
      const confirmed = lineup.status === "Confirmed";
      const byName = Object.fromEntries(sh[side].filter((p) => p.name).map((p) => [p.name, p]));
      let entries = (lineup.members || []).filter((m) => m.statusText === "Starting" || m.statusText === "Substitute").map((m) => {
        const info = members[m.id] || {};
        return [info.name || "?", m.statusText, POSITIONS[(m.position || {}).name], info.athleteId ? athletePhoto(info) : null];
      });
      if (!entries.some((e) => e[1] === "Starting") && sh[side].length) {
        const recent = sh[side].slice().sort((a, b) => b.matches.slice(0, 5).reduce((s, m) => s + m.minutes, 0) - a.matches.slice(0, 5).reduce((s, m) => s + m.minutes, 0));
        entries = recent.slice(0, 18).map((p, i) => [p.name, i < 11 ? "Starting" : "Substitute", p.position, null]);
      }
      squads[side] = entries.map(([name, status, pos, photo]) => {
        const match = Object.keys(byName).length ? bestMatch(name, Object.keys(byName), 0.6) : null;
        const matches = match ? byName[match].matches : [];
        pos = pos || (match && byName[match].position) || "M";
        const r = rates(matches, priors[pos] || DEFAULT_RATES.M, pos);
        return { ...r, name, pos, status, photo, start_p: START_PROB[confirmed][status],
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
    return { goals, sot, shots, cards, corners: an.statBlend.corners || 9.8 };
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
  function simulate(an, squads) {
    const rng = mulberry32(7), n = N_SIMS, exp = teamExpectations(an), M = an.M;
    const cells = [], cum = [];
    let acc = 0;
    for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) { acc += M[i][j]; cells.push([i, j]); cum.push(acc); }
    const goals = { home: new Int16Array(n), away: new Int16Array(n) };
    for (let s = 0; s < n; s++) {
      const u = rng() * acc;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
      goals.home[s] = cells[lo][0]; goals.away[s] = cells[lo][1];
    }
    const corners = new Int16Array(n);
    for (let s = 0; s < n; s++) corners[s] = poisson(rng, exp.corners);
    const player = {}, teamCards = {};
    ["home", "away"].forEach((side, t) => {
      const g = goals[side], sot = new Int16Array(n), shots = new Int16Array(n), cards = new Int16Array(n);
      for (let s = 0; s < n; s++) {
        sot[s] = g[s] + poisson(rng, Math.max(exp.sot[t] - exp.goals[t], 0.4));
        shots[s] = sot[s] + poisson(rng, Math.max(exp.shots[t] - exp.sot[t], 0.8));
        cards[s] = poisson(rng, exp.cards[t]);
      }
      teamCards[side] = cards;
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
      const pGoals = allocate(rng, g, weighted((p) => p.g90), k);
      const pExtraSot = allocate(rng, diff(sot, g), weighted((p) => Math.max(p.sot90 - p.g90, 0.02)), k);
      const pOff = allocate(rng, diff(shots, sot), weighted((p) => Math.max(p.sh90 - p.sot90, 0.05)), k);
      const pCards = allocate(rng, cards, weighted((p) => p.c90), k);
      for (let i = 0; i < k; i++) {
        const a = { goals: new Int16Array(n), sot: new Int16Array(n), shots: new Int16Array(n), cards: new Int16Array(n) };
        for (let s = 0; s < n; s++) {
          const x = s * k + i;
          a.goals[s] = pGoals[x]; a.sot[s] = pGoals[x] + pExtraSot[x]; a.shots[s] = a.sot[s] + pOff[x]; a.cards[s] = pCards[x];
        }
        player[`${side}:${i}`] = a;
      }
    });
    return { n, exp, goals, corners, player, teamCards, squads };
  }

  // ---------------------------------------------------------------------------
  // Legs, prices and tickets (sim.py)
  // ---------------------------------------------------------------------------
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
      add(`goals:o${line}`, `Over ${line} Goals`, "Total Goals", "goals", mask(n, (s) => hg[s] + ag[s] > line));
      add(`goals:u${line}`, `Under ${line} Goals`, "Total Goals", "goals", mask(n, (s) => hg[s] + ag[s] < line));
    }
    add("btts:yes", "Both Teams to Score", "Both Teams to Score", "btts", mask(n, (s) => hg[s] > 0 && ag[s] > 0));
    add("btts:no", "Both Teams to Score: No", "Both Teams to Score", "btts", mask(n, (s) => !(hg[s] > 0 && ag[s] > 0)));
    for (const [side, name, g] of [["home", home, hg], ["away", away, ag]]) {
      for (const line of [0.5, 1.5, 2.5])
        add(`team:${side}:o${line}`, `${name} Over ${line} Goals`, "Team Goals", `team_goals:${side}`, mask(n, (s) => g[s] > line));
      const other = side === "home" ? ag : hg;
      add(`cs:${side}`, `${name} Clean Sheet`, "Clean Sheet", `team_goals:${side === "home" ? "away" : "home"}`, mask(n, (s) => other[s] === 0));
    }
    for (const line of [7.5, 8.5, 9.5, 10.5, 11.5]) {
      add(`corners:o${line}`, `Over ${line} Corners`, "Corners", "corners", mask(n, (s) => sim.corners[s] > line));
      add(`corners:u${line}`, `Under ${line} Corners`, "Corners", "corners", mask(n, (s) => sim.corners[s] < line));
    }
    const tc = (s) => sim.teamCards.home[s] + sim.teamCards.away[s];
    for (const line of [2.5, 3.5, 4.5, 5.5]) {
      add(`cards:o${line}`, `Over ${line} Cards`, "Total Cards", "cards", mask(n, (s) => tc(s) > line));
      add(`cards:u${line}`, `Under ${line} Cards`, "Total Cards", "cards", mask(n, (s) => tc(s) < line));
    }
    for (const [key, a] of Object.entries(sim.player)) {
      const [side, i] = key.split(":"), p = sim.squads[side][+i];
      if (p.pos === "G" || p.start_p < 0.5) continue;
      const pid = `p:${side}:${i}`;
      const common = { kind: "player", player: p.name, side, pos: p.pos, photo: p.photo, low_data: p.minutes < MIN_AUTO_MINUTES };
      // Hit rates from games he started (cameos say little about a starter), unless under 3 recent starts.
      const [basisGames, basis] = p.recent_starts.length >= 3 ? [p.recent_starts, "starts"] : [p.recent, "games"];
      const hist = (stat, k) => { const vals = basisGames.map((m) => m[stat]); return { recent: vals, hits: vals.filter((v) => v >= k).length, games: vals.length, threshold: k, basis }; };
      for (const k of [1, 2, 3]) add(`${pid}:shots${k}`, `${p.name}: ${k}+ Shots`, "Player Shots", `${pid}:shots`, mask(n, (s) => a.shots[s] >= k), { ...common, ...hist("shots", k) });
      for (const k of [1, 2]) add(`${pid}:sot${k}`, `${p.name}: ${k}+ Shots on Target`, "Player Shots on Target", `${pid}:sot`, mask(n, (s) => a.sot[s] >= k), { ...common, ...hist("sot", k) });
      add(`${pid}:score`, `${p.name} to Score`, "To Score at Any Time", `${pid}:score`, mask(n, (s) => a.goals[s] >= 1), { ...common, ...hist("goals", 1) });
      add(`${pid}:booked`, `${p.name} to be Booked`, "Player to be Booked", `${pid}:booked`, mask(n, (s) => a.cards[s] >= 1), { ...common, ...hist("yellow", 1) });
    }
    return legs;
  }

  const FIXED_BOOK_LINES = { "res:home": [1, "", "1"], "res:draw": [1, "", "X"], "res:away": [1, "", "2"], "dc:home": [14, "", "1X"],
    "dc:away": [14, "", "X2"], "btts:yes": [12, "", "Yes"], "btts:no": [12, "", "No"], "cs:home": [144, "", "Yes"], "cs:away": [145, "", "Yes"] };
  const LINE_TYPES = { goals: 3, corners: 137, cards: 141 };
  function bookLine(id) {
    if (FIXED_BOOK_LINES[id]) return FIXED_BOOK_LINES[id];
    const [kind, rest] = id.split(":");
    if (LINE_TYPES[kind] && rest && (rest[0] === "o" || rest[0] === "u")) return [LINE_TYPES[kind], rest.slice(1), rest[0] === "o" ? "Over" : "Under"];
    return null;
  }
  function bookPrices(an, legs, book = PRICE_BOOK) {
    const quotes = {};
    for (const q of an.quotes) if (q.book === book) quotes[`${q.type}|${q.value}`] = q.prices;
    const out = {};
    for (const id of Object.keys(legs)) {
      const line = bookLine(id);
      const price = line && (quotes[`${line[0]}|${line[1]}`] || {})[line[2]];
      if (price) out[id] = price;
    }
    return out;
  }

  const playerKey = (leg) => (leg.kind === "player" ? `${leg.side}|${leg.player}` : null);
  function maskOf(legs, ids, n) { const m = new Uint8Array(n).fill(1); for (const id of ids) { const a = legs[id].arr; for (let s = 0; s < n; s++) m[s] &= a[s]; } return m; }
  function evaluate(legs, ids) {
    const chosen = ids.filter((i) => legs[i]);
    if (!chosen.length) return { p: null, fair: null, legs: [] };
    const n = legs[chosen[0]].arr.length, m = new Uint8Array(n).fill(1), rows = [];
    for (const id of chosen) {
      const before = mean(m), a = legs[id].arr;
      for (let s = 0; s < n; s++) m[s] &= a[s];
      rows.push({ id, p: legs[id].p, cond: before ? mean(m) / before : 0 });
    }
    const p = mean(m);
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
  function autoBuild(legs, target, style = "Balanced", maxLegs = 10, locked = [], banned = new Set(), favourite = true, focus = "Mix") {
    const [lo, hi] = STYLES[style] || STYLES.Balanced;
    let [minPlayers, maxMatch] = FOCUS[focus] || FOCUS.Mix;
    const all = Object.values(legs);
    if (!all.length) return evaluate(legs, []);
    const n = all[0].arr.length;
    let chosen = locked.filter((i) => legs[i]);
    if (favourite && !chosen.some((i) => legs[i].group === "result")) {
      const side = ["home", "away"].sort((a, b) => ((legs[`res:${b}`] || {}).p || 0) - ((legs[`res:${a}`] || {}).p || 0))[0];
      for (const [id, floor] of [[`res:${side}`, 0.5], [`dc:${side}`, 0.6]]) if (legs[id] && legs[id].p >= floor) { chosen.unshift(id); break; }
    }
    const keep = new Set(chosen);
    let m = maskOf(legs, chosen, n);
    while (chosen.length < maxLegs) {
      const pNow = mean(m);
      if (pNow === 0 || 1 / pNow >= target) break;
      const groups = new Set(chosen.map((i) => legs[i].group)), perPlayer = {};
      for (const i of chosen) { const k = playerKey(legs[i]); if (k) perPlayer[k] = (perPlayer[k] || 0) + 1; }
      const nPlayers = Object.values(perPlayer).reduce((s, x) => s + x, 0), nMatch = chosen.length - nPlayers;
      let want = nPlayers < minPlayers || nMatch >= maxMatch ? "player" : null;
      if (focus === "Match") want = "match";
      let best = null, bestScore = null;
      for (const leg of all) {
        if (chosen.includes(leg.id) || banned.has(leg.id) || groups.has(leg.group) || leg.low_data) continue;
        if (want && leg.kind !== want) continue;
        const k = playerKey(leg);
        if (k && (perPlayer[k] || 0) >= MAX_LEGS_PER_PLAYER) continue;
        let c = 0; const a = leg.arr;
        for (let s = 0; s < n; s++) c += m[s] & a[s];
        const joint = c / n, cond = joint / pNow;
        if (cond < lo || cond > hi) continue;
        const reaches = joint > 0 && 1 / joint >= target;
        const score = [reaches ? 1 : 0, reaches ? joint : cond];
        if (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) { best = leg.id; bestScore = score; }
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
  const matches = new Map(); // game id -> {t, an, legs, json}

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
    matches.set(id, { t: Date.now(), an, legs, json });
    return json;
  }
  function matchJSON(an, sim, squads, legs) {
    const M = an.M;
    const grid = [0, 1, 2, 3, 4].map((i) => [0, 1, 2, 3, 4].map((j) => sumCells(M, (a, b) => (i < 4 ? a === i : a >= 4) && (j < 4 ? b === j : b >= 4))));
    const c1x2 = an.cons["1|"];
    const market = c1x2 && ["1", "X", "2"].every((k) => k in c1x2.probs)
      ? { home: c1x2.probs["1"], draw: c1x2.probs.X, away: c1x2.probs["2"], sources: c1x2.books } : null;
    const prices = bookPrices(an, legs);
    const legJSON = Object.values(legs).map(({ arr, ...rest }) => ({ ...rest, bookPrice: prices[rest.id] || null }));
    const value = legJSON.filter((l) => l.bookPrice && l.bookPrice > l.fair * 1.02)
      .map((l) => ({ label: l.label, price: l.bookPrice, p: l.p, edge: l.bookPrice / l.fair - 1 })).sort((a, b) => b.edge - a.edge).slice(0, 5);
    const tableRow = (c) => { const r = an.table[c.id]; return r ? { position: r.position, points: r.points } : null; };
    return {
      id: an.id, league: an.league, home: an.home, away: an.away, homeCrest: crest(an.homeComp), awayCrest: crest(an.awayComp),
      kickoff: an.kickoff ? an.kickoff.toISOString() : null, started: an.inPlay, lineups: an.lineups, referee: an.referee,
      probs: { home: sumCells(M, (i, j) => i > j), draw: sumCells(M, (i, j) => i === j), away: sumCells(M, (i, j) => i < j),
               market, polymarket: an.polymarket },
      expected: sim.exp, grid, table: { home: tableRow(an.homeComp), away: tableRow(an.awayComp) }, form: an.form,
      legs: legJSON, priceBook: PRICE_BOOK,
      players: Object.fromEntries(Object.entries(squads).map(([side, sq]) => [side, sq.map((p) => ({
        name: p.name, pos: p.pos, status: p.status, photo: p.photo, start_p: p.start_p, sh90: p.sh90, sot90: p.sot90,
        g90: p.g90, c90: p.c90, minutes: p.minutes, has_data: p.has_data, recent: p.recent }))])),
      warnings: an.warnings, value: { book: PRICE_BOOK, legs: value }, sims: sim.n,
    };
  }
  function entryFor(id) {
    const e = matches.get(String(id));
    if (!e) throw new Error("match not loaded — open it again");
    return e;
  }
  function build(body) {
    const e = entryFor(body.id);
    return autoBuild(e.legs, +body.target || 3, body.style, +body.maxLegs || 10, body.locked || [], new Set(body.banned || []),
                     body.favourite !== false, body.focus || "Mix");
  }
  const evaluateBody = (body) => evaluate(entryFor(body.id).legs, body.legs || []);

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
  const jobStatus = (job) => ({ ...job, results: job.results.slice() });
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
        const [league, f] = todo[next++];
        try { const json = await match(league, f.id); perMatch(league, f, json, entryFor(f.id)); }
        catch (err) { console.warn("[hawk] skipped", f.home, "v", f.away, err.message); job.errors++; }
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
                     maxLegs: Math.min(Math.max(+body.maxLegs || 10, 2), 12) };
    Object.assign(scan, newJob(), { running: true, params });
    runFixtureJob(scan, (league, f, json, e) => {
      const t = autoBuild(e.legs, params.target, params.style, params.maxLegs, [], new Set(), true, params.focus);
      scan.results.push({ ...fixtureInfo(league, f, json), p: t.p, fair: t.fair,
        legs: t.legs.map((r) => ({ id: r.id, label: e.legs[r.id].label, kind: e.legs[r.id].kind })),
        value: json.value.legs.slice(0, 4).map((v) => ({ label: v.label, price: v.price, edge: v.edge })) });
    });
    return jobStatus(scan);
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
      case 3: return `${option} ${value} Goals`;
      case 11: return `Asian Handicap: ${option === "Home" ? `${home} ${fmt(v)}` : `${away} ${fmt(-v)}`}`;
      case 12: return `Both Teams to Score: ${option}`;
      case 144: return `${home} Clean Sheet: ${option}`;
      case 145: return `${away} Clean Sheet: ${option}`;
      case 7: return option === "No Goal" ? "No Goalscorer" : `${team(option)} to Score First`;
      case 126: return `Correct Score ${value}`;
      case 5: return `1st Half Result: ${team(option)}`;
      case 6: return `2nd Half Result: ${team(option)}`;
      case 9: return `1st Half ${option} ${value} Goals`;
      case 13: return `BTTS 2nd Half: ${option}`;
      case 127: return `Half-Time Score ${value}`;
      case 137: return `${option} ${value} Corners`;
      case 141: return `${option} ${value} Cards`;
      case 139: return `${option} ${value} Shots on Target`;
    }
    return `${market}: ${option}${value ? " " + value : ""}`;
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

  global.HAWK = { LEAGUES, fixtures, match, build, evaluate: evaluateBody, lineups,
                  startScan, scanStatus: () => jobStatus(scan), stopScan: () => { scan.stop = true; return jobStatus(scan); },
                  startValue, valueStatus: () => jobStatus(valueJob), stopValue: () => { valueJob.stop = true; return jobStatus(valueJob); },
                  meta: () => data("meta.json"),
                  _internals: { analyse, buildSquads, simulate, catalogue, autoBuild, evaluate, consensus, fitGoalLambdas,
                                selectionModel, priceRows, entry: (id) => matches.get(String(id)),
                                fitTotalLambda, scoreMatrix, nameSimilarity, bestMatch } };
})(window);
