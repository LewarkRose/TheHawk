/* HAWK settle — reads a finished match from 365Scores and marks each HAWK leg
 * won or lost. Shared by the Vault (auto-settle, closing prices) and by
 * engine/grade.mjs, which grades HAWK's predictions for every match on
 * GitHub. Works in a browser and in Node 18+ (it only needs fetch).
 *
 *   HawkSettle.fetchMatchFacts(gameId) -> what happened (cached once finished)
 *   HawkSettle.legResult(leg, facts)   -> 'won' | 'lost' | 'void' | 'unknown'
 *   HawkSettle.closingPrice(leg, facts) -> Bet365's last price before kick-off
 */
(function (g) {
  "use strict";
  const S365 = "https://webws.365scores.com/web";
  const S365_PARAMS = { appTypeId: 5, langId: 1, timezoneName: "Europe/London", userCountryId: -1 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function s365(path, params) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${S365}/${path}/?${new URLSearchParams({ ...S365_PARAMS, ...params })}`);
        if (r.ok) return await r.json();
        if (r.status < 500 && r.status !== 429) return null;
      } catch (e) { /* throttled replies can arrive without CORS headers — wait and retry */ }
      await sleep(800 * (attempt + 1));
    }
    return null;
  }

  const facts = {};   // 365Scores game id -> what happened (finished games only)
  const countOf = (v, total = false) => {
    if (v == null || v === "") return 0;
    const m = /^(\d+)\s*\/\s*(\d+)/.exec(String(v));
    if (m) return +(total ? m[2] : m[1]);   // "2/3 (67%)": won / attempted
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  };

  async function fetchMatchFacts(gameId) {
    if (facts[gameId]) return facts[gameId];
    const d = await s365("game", { gameId });
    const game = d && d.game;
    if (!game) return null;
    if (/postpon|cancel|abandon|suspend/i.test(game.statusText || "")) return (facts[gameId] = { finished: true, off: game.statusText });
    if (game.statusGroup !== 4) return { finished: false };
    const st = await s365("game/stats", { games: gameId });
    const homeId = game.homeCompetitor.id, awayId = game.awayCompetitor.id;
    const stage = (id) => (game.stages || []).find((s) => s.id === id);
    const s90 = stage(9) || stage(1), ht = stage(7);
    const regular = (e) => e.stageId == null || e.stageId === 7 || e.stageId === 9;   // 1st and 2nd half, not extra time
    const events = (game.events || []).filter((e) => e.eventType && regular(e));
    const goals = events.filter((e) => e.eventType.id === 1).sort((a, b) => (a.order || 0) - (b.order || 0));
    const cardEvents = events.filter((e) => /card/i.test(e.eventType.name || ""));
    const team = {}, tackles = [0, 0];
    for (const s of (st && st.statistics) || []) {
      const side = s.competitorId === homeId ? 0 : s.competitorId === awayId ? 1 : -1;
      if (side >= 0) (team[s.name] ||= [null, null])[side] = countOf(s.value);
      if (side >= 0 && s.name === "Tackles Won") tackles[side] = countOf(s.value, true);   // won or not
    }
    // Bet365's Early Payout: a Full Time Result leg is paid once that team has
    // been 2 goals ahead in normal time (only trusted when the goals add up).
    const ft90 = s90 ? [s90.homeCompetitorScore, s90.awayCompetitorScore] : [game.homeCompetitor.score, game.awayCompetitor.score];
    let twoUp = null;
    if (goals.filter((e) => e.competitorId === homeId).length === ft90[0] && goals.filter((e) => e.competitorId === awayId).length === ft90[1]) {
      twoUp = { home: false, away: false };
      let d = 0;
      for (const e of goals) { d += e.competitorId === homeId ? 1 : -1; if (d >= 2) twoUp.home = true; if (d <= -2) twoUp.away = true; }
    }
    const pair = (name) => (team[name] && team[name][0] != null && team[name][1] != null ? team[name] : null);
    const yellow = pair("Yellow Cards"), red = pair("Red Cards") || [0, 0];
    // Card markets settle in BOOKING POINTS, not card events: a yellow is 1 and a
    // red is 2, and no player can be charged more than 3 (his first yellow, then
    // 2 for the red — the second yellow itself adds nothing). The feed hands back
    // a plain count, so a red used to score 1 here and every match with a sending
    // off was graded a card short; "Over" legs that won were settled as losers.
    // Second yellows are found from the events: a player with two yellows AND a
    // red is one of them, so a point comes back off that side's total.
    const secondYellow = [homeId, awayId].map((id) => {
      const per = new Map();
      for (const e of cardEvents) {
        if (e.competitorId !== id || e.playerId == null) continue;
        const v = per.get(e.playerId) || { y: 0, r: 0 };
        /red/i.test(e.eventType.name || "") ? v.r++ : v.y++;
        per.set(e.playerId, v);
      }
      return [...per.values()].filter((v) => v.r > 0 && v.y >= 2).length;
    });
    const cards = yellow
      ? [0, 1].map((k) => yellow[k] + 2 * red[k] - secondYellow[k])
      : [homeId, awayId].map((id, k) => {
          const per = new Map();
          for (const e of cardEvents) {
            if (e.competitorId !== id) continue;
            const key = e.playerId == null ? `x${per.size}` : e.playerId;
            const v = per.get(key) || { y: 0, r: 0 };
            /red/i.test(e.eventType.name || "") ? v.r++ : v.y++;
            per.set(key, v);
          }
          return [...per.values()].reduce((a, v) => a + Math.min(3, v.y + 2 * v.r), 0);
        });
    const names = Object.fromEntries((game.members || []).map((m) => [m.id, m.name]));
    const bookedIds = new Set(cardEvents.map((e) => e.playerId));
    const players = {};
    for (const [side, key] of [["home", "homeCompetitor"], ["away", "awayCompetitor"]]) {
      players[side] = (((game[key] || {}).lineups || {}).members || []).map((m) => {
        const stats = Object.fromEntries((m.stats || []).map((s) => [s.name, s.value]));
        return { id: m.id, name: names[m.id] || "", minutes: countOf(stats["Minutes"]), stats, booked: bookedIds.has(m.id) };
      });
    }
    // Substitutions in normal time: who came on for whom (Bet365's Sub On Play On).
    const replacedBy = {};
    for (const e of events) if (/substitution/i.test(e.eventType.name || "")) for (const off of e.extraPlayers || []) replacedBy[off] = e.playerId;
    // Closing prices: once a match is over, 365Scores shows each Bet365 line at
    // its last price before kick-off (the opening price is kept separately).
    const closing = {};
    try {
      const lines = await s365("bets/lines", { games: gameId, userCountryId: 21 });
      const b365 = new Set(((lines && lines.bookmakers) || []).filter((b) => /bet365/i.test(b.name || "")).map((b) => b.id));
      for (const l of (lines && lines.lines) || []) {
        if (!b365.has(l.bookmakerId)) continue;
        closing[`${l.lineTypeId}|${l.internalOptionValue ?? ""}`] = Object.fromEntries((l.options || [])
          .map((o) => [String(o.name), o.rate && o.rate.decimal]).filter(([, v]) => v > 1));
      }
    } catch (e) { /* no closing prices — the result still settles */ }
    return (facts[gameId] = {
      finished: true, homeId,
      ft: ft90, twoUp, tackles,
      ht: ht ? [ht.homeCompetitorScore, ht.awayCompetitorScore] : null,
      first: goals.length ? (goals[0].competitorId === homeId ? "home" : "away") : null,
      corners: pair("Corners"), sot: pair("Shots On Target"), cards, players, closing, replacedBy,
      // who went through (To Qualify legs: extra time and penalties included)
      qualified: game.homeCompetitor.isQualified ? "home" : game.awayCompetitor.isQualified ? "away" : null,
    });
  }

  // The Bet365 line a HAWK leg is on: [365Scores line type, value, option]
  // (same mapping as engine.js; handicap values are the home side's).
  const FIXED_BOOK_LINES = { "qual:home": [39, "", "1"], "qual:away": [39, "", "2"], "res:home": [1, "", "1"], "res:draw": [1, "", "X"], "res:away": [1, "", "2"], "dc:home": [14, "", "1X"],
    "dc:away": [14, "", "X2"], "btts:yes": [12, "", "Yes"], "btts:no": [12, "", "No"], "cs:home": [144, "", "Yes"], "cs:away": [145, "", "Yes"],
    "h1res:home": [5, "", "1"], "h1res:draw": [5, "", "X"], "h1res:away": [5, "", "2"], "first:home": [7, "", "Home"], "first:away": [7, "", "Away"] };
  const LINE_TYPES = { goals: 3, corners: 137, cards: 141, h1goals: 9, sot: 139 };
  function bookLine(id) {
    if (FIXED_BOOK_LINES[id]) return FIXED_BOOK_LINES[id];
    const [kind, rest, extra] = String(id).split(":");
    if (LINE_TYPES[kind] && rest && (rest[0] === "o" || rest[0] === "u")) return [LINE_TYPES[kind], rest.slice(1), rest[0] === "o" ? "Over" : "Under"];
    if (kind === "ah" && extra) { const h = parseFloat(extra); return [11, String(rest === "home" ? h : -h), rest === "home" ? "Home" : "Away"]; }
    if (kind === "cs" && /^\d-\d$/.test(rest || "")) return [126, rest, "Yes"];
    return null;
  }
  const closingPrice = (h, f) => { const b = bookLine(h.id); return b && f.closing ? (f.closing[`${b[0]}|${b[1]}`] || {})[b[2]] || null : null; };

  const normName = (s) => String(s || "").replace(/[øØ]/g, "o").replace(/ß/g, "ss").normalize("NFKD").replace(/\p{M}/gu, "")
    .toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
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

  // 'won' | 'lost' | 'void' (player didn't play) | 'unknown' (no data)
  // opts.earlyPayout: settle Full Time Result legs the way Bet365's Early
  // Payout does (the Vault, for your bets) — not for grading HAWK's chances.
  // opts.subOn: Bet365's Sub On Play On — a player subbed off before his leg
  // landed passes it to the player who came on for him (only the sub's own
  // numbers count; a sub of the sub carries it on).
  function legResult(h, f, opts = {}) {
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
      const val = (p) => { const s = p.stats;
        return { shots: countOf(s["Total Shots"]), sot: countOf(s["Shots On Target"]), score: countOf(s["Goals"]),
                  assist: countOf(s["Assists"]), soa: countOf(s["Goals"]) + countOf(s["Assists"]), booked: p.booked ? 1 : 0,
                  fouls: countOf(s["Fouls Made"]), fouled: countOf(s["Was Fouled"]), tackles: countOf(s["Tackles Won"], true),
                  offsides: countOf(s["Offsides"]), saves: countOf(s["Goalkeeper Saves"]) }[stat]; };
      let v = val(pl);
      if (v === undefined) return "unknown";
      if (opts.subOn && v < need && f.replacedBy) {
        const list = f.players[sd] || [];
        let cur = pl;
        for (let hop = 0; hop < 5 && f.replacedBy[cur.id]; hop++) {
          const nx = list.find((p) => p.id === f.replacedBy[cur.id]);
          if (!nx) break;
          cur = nx;
          if (val(cur) >= need || f.replacedBy[cur.id] == null) break;
        }
        if (cur !== pl) return W(val(cur) >= need);
      }
      const s = pl.stats;
      // 365Scores names a player's tackles only once he's won one; Bet365 also
      // counts the ones that lost the ball. If his team has tackles nobody is
      // named for, some may be his — HAWK can't tell, so it doesn't guess.
      if (stat === "tackles" && v < need && s["Tackles Won"] == null && f.tackles) {
        const sideIdx = sd === "home" ? 0 : 1;
        const named = (f.players[sd] || []).reduce((a, p) => a + countOf(p.stats["Tackles Won"], true), 0);
        if (f.tackles[sideIdx] > named) return "unknown";
      }
      return W(v >= need);
    }
    if ((m = /^qual:(home|away)$/.exec(id))) return f.qualified ? W(f.qualified === m[1]) : "unknown";
    if ((m = /^res:(home|away)$/.exec(id)) && opts.earlyPayout && f.twoUp && f.twoUp[m[1]]) return "won";
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
    if ((m = /^(corners|cards|sot):([ou])([\d.]+)$/.exec(id))) {
      const t = totals[m[1]];
      return t ? W(line(m[2], +m[3], t[0] + t[1])) : "unknown";
    }
    if ((m = /^t(corners|cards):(home|away):([ou])([\d.]+)$/.exec(id))) {
      const t = totals[m[1]];
      return t ? W(line(m[3], +m[4], t[m[2] === "home" ? 0 : 1])) : "unknown";
    }
    if ((m = /^mostcorners:(home|away)$/.exec(id))) {
      const t = f.corners;
      return t ? W(m[1] === "home" ? t[0] > t[1] : t[1] > t[0]) : "unknown";
    }
    return "unknown";
  }

  g.HawkSettle = { facts, fetchMatchFacts, legResult, closingPrice, bookLine };
})(typeof window !== "undefined" ? window : globalThis);
