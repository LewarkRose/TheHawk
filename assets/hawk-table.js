/* ===========================================================================
   THE LEAGUE TABLE — AND, IN A CUP, THE DRAW

   A panel, opened from a league header on Scores or from the match page's
   own header. v1 settled the shape years of use ago and it is the right one,
   so this is that shape in the new language rather than a new idea:

     · the summary row is only what you scan for — position, badge, name,
       form, points. Everything else is one tap down. A nine-column grid is
       a spreadsheet; this is a list you read.
     · All / Home / Away, because "who is best at home" is a different
       question and the feed answers it (standings type 1, 2, 3).
     · a game being played right now is folded in as it stands, with ▲▼ for
       the places it moves — but ONLY on All. A match that has not finished
       is not yet a home result or an away one to anybody.
     · opened from a match, the two teams are gold and already expanded.

   And a cup has no table, so the same panel draws the bracket instead. That
   is not a second panel: one thing opens, and it shows whichever of the two
   the competition actually has. A few have both — the Champions League once
   the knockout starts, Libertadores, qualifying play-offs — and those get a
   Table / Rounds switch in the same language as All / Home / Away.
   =========================================================================== */
(() => {
  "use strict";
  if (window.HAWKTable) return;

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const loadPref = (k, f) => { try { const v = localStorage.getItem(k); return v === null ? f : JSON.parse(v); } catch { return f; } };
  const savePref = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private */ } };
  const pad = (n) => String(n).padStart(2, "0");
  const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const S = { where: "all", league: null, hl: [], timer: 0, el: null,
              groups: loadPref("hawk.tableGroups", {}),
              views: loadPref("hawk.tableView", {}) };

  /* Last five as blocks, oldest on the left. The standings list form oldest
     first; HAWK's own form() builds it newest first, so anything using that
     one has to say so rather than showing it backwards. */
  const formHTML = (s, newestFirst = false) => {
    if (!s) return "";
    const five = newestFirst ? s.split("").slice(0, 5).reverse() : s.split("").slice(-5);
    return `<span class="fmr">${five.map((c) =>
      `<i class="${c === "W" ? "fw" : c === "D" ? "fd" : "fl"}">${esc(c)}</i>`).join("")}</span>`;
  };

  /* ======================================================= the cup bracket
     cupRounds() has been in the engine since the rebuild with nothing
     calling it, so pressing Table on a cup opened a panel with a heading,
     an All / Home / Away switch and nothing underneath — every domestic
     cup, every time. This is what fills it.

     What it draws is the DRAW: rounds as columns, left to right. Three
     things decide the shape, and the feed hands over none of them whole:

       · A TIE IS NOT A GAME. A two-legged round comes back as two games of
         the same pairing, so they are merged here on the unordered pair of
         names. Without that a Round of 16 draws sixteen boxes and the tree
         is twice as tall as the competition.
       · A ROUND THE FEED HAS MAY BE SHORT. The EFL Cup's quarter-finals
         came back as three ties, not four, so a column is padded out to the
         slots the round should hold rather than to what arrived.
       · A ROUND THE FEED HAS NOT GOT IS NOT DRAWN YET. The draw is made
         round by round, so those columns are slots with nothing in them.
         A tree drawn in advance would be invented. */
  const nameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const dayShort = (iso) => {
    const d = new Date(iso || "");
    return Number.isFinite(d.getTime()) ? `${d.getDate()} ${MON[d.getMonth()]}` : "";
  };
  // 365Scores writes a two-legged aggregate as "Aggregate 1 - 1", and the
  // label in front of it already says agg, so the word is not said twice.
  const aggText = (s) => String(s).replace(/^\s*agg(regate)?\s*:?\s*/i, "")
    .replace(/\s*-\s*/g, "–").trim();

  function tiesOf(round) {
    const by = new Map();
    for (const g of round.games || []) {
      const k = [nameKey(g.home), nameKey(g.away)].sort().join("|");
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(g);
    }
    return [...by.values()].map((legs) => {
      const a = { name: legs[0].home, key: nameKey(legs[0].home) };
      const b = { name: legs[0].away, key: nameKey(legs[0].away) };
      // Who went through, mapped back BY NAME: the sides swap between legs,
      // so "home" on the second leg is the other team.
      let won = null;
      for (const g of legs) {
        if (!g.won) continue;
        const k = nameKey(g.won === "home" ? g.home : g.away);
        won = k === a.key ? "a" : k === b.key ? "b" : won;
      }
      const live = legs.find((g) => g.live) || null;
      const next = legs.find((g) => !g.score && !g.live) || null;
      const shown = live || [...legs].reverse().find((g) => g.score) || null;
      let score = null;
      if (shown && shown.score)
        score = nameKey(shown.home) === a.key ? shown.score.slice() : [shown.score[1], shown.score[0]];
      const at = live || next || legs[legs.length - 1];
      return { a, b, won, score, legs: legs.length,
               agg: legs.map((g) => g.agg).filter(Boolean).pop() || null,
               live: !!live, clock: live ? live.clock || "live" : null,
               when: next ? next.kickoff : shown ? shown.kickoff : null,
               id: at ? at.id : null };
    });
  }

  /* The standard knockout ladder, by how many ties a round holds — but a
     round only counts as a rung when its NAME says so too. World Cup
     qualifying's "Playoffs - Final" also holds four ties, and reading that
     as a quarter-final would invent a semi-final and a final the
     competition does not have. */
  const LADDER = [[8, "Round of 16", /round ?of ?16|last ?16|1\s*\/\s*8/i],
                  [4, "Quarter Finals", /quarter|1\s*\/\s*4/i],
                  [2, "Semi Finals", /semi|1\s*\/\s*2/i],
                  [1, "Final", /final/i]];
  const pow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };

  function bracketCols(rounds) {
    const rs = (rounds || []).map((r) => {
      const ties = tiesOf(r);
      return { name: r.name, ties, slots: pow2(ties.length) };
    });
    /* The tree is the knockout TAIL, read BACKWARDS from the last round the
       feed has. Reading it forwards was wrong twice over, and both ways show
       up in the first cup tried: the Coppa Italia's preliminary round holds
       four ties, so "the first round small enough to draw" started the tree
       in August among Vicenza and Ravenna; and its Round of 32 holds eight
       ties while its Round of 16 holds eight more, because the eight seeds
       enter there — so rounds do not reliably halve either.
       A round therefore joins the tree only when the one before it is exactly
       twice its size, and the tree stops at eight ties because sixteen is
       eleven hundred pixels tall. Everything earlier is listed underneath. */
    let from = rs.length - 1;
    if (from < 0 || !rs[from].ties.length || rs[from].slots > 8) return { cols: [], rest: rs };
    while (from > 0 && rs[from - 1].slots === rs[from].slots * 2 && rs[from - 1].slots <= 8) from--;
    const cols = rs.slice(from).map((r) => ({ name: r.name, ties: r.ties, slots: r.slots }));
    /* 365Scores calls the Copa Libertadores final "Round 8" — its own stage
       numbering leaking through. A column headed Round 8 in a bracket reads
       as a bug, so a BARE number is replaced by what a round of that size is
       called. Only a bare one: "Playoffs - Final" is a name and is left
       alone, which is also what stops the rung test below firing on it. */
    const BARE = /^(round|stage|week)\s*\d+$/i;
    for (const c of cols) {
      const r = LADDER.find(([n]) => n === c.slots);
      if (r && BARE.test(c.name)) c.name = r[1];
    }
    linkPairs(cols);
    const tail = cols[cols.length - 1], rung = LADDER.find(([n]) => n === tail.slots);
    if (rung && rung[2].test(tail.name))
      for (let n = Math.floor(tail.slots / 2); n >= 1; n = Math.floor(n / 2)) {
        const next = LADDER.find(([k]) => k === n);
        cols.push({ name: next ? next[1] : `Last ${n * 2}`, ties: [], slots: n });
      }
    return { cols, rest: rs.slice(0, from) };
  }

  /* A JOINING BRACKET IS A CLAIM, AND IN MOST CUPS IT IS FALSE.
     Drawing one says "the winners of these two ties meet in that one". The
     League Cup and the FA Cup draw every round fresh, so they do no such
     thing — the first run of this joined Bradford's tie to Arsenal's and
     labelled the result Liverpool v Bournemouth, which is the same sin as
     a tree drawn in advance, only harder to spot.

     So a connector is drawn only where the pairing can be PROVED: the next
     round's two teams are traced back to the ties they came out of, and
     those two ties are moved to sit together. Where the next round is drawn
     this makes the tree true — the League Cup's three quarter-finals line
     up with the eight fourth-round ties that fed them. Where it is not
     drawn, the pairs simply face the empty slots with nothing joining them,
     which is exactly what is known. */
  function linkPairs(cols) {
    for (let k = cols.length - 2; k >= 0; k--) {
      const here = cols[k], next = cols[k + 1];
      const pool = here.ties.slice(), pairs = [], joins = [];
      const take = (key) => {
        const i = pool.findIndex((t) => t.a.key === key || t.b.key === key);
        return i < 0 ? null : pool.splice(i, 1)[0];
      };
      for (let j = 0; j < Math.max(1, here.slots / 2); j++) {
        const t = next.ties[j];
        const x = t ? take(t.a.key) : null, y = t ? take(t.b.key) : null;
        pairs.push([x, y]);
        joins.push(!!(x && y));
      }
      // a side that could not be traced (a seed entering here, a round the
      // feed is missing) falls back to whatever is left, in the order it came
      for (const p of pairs) for (let i = 0; i < 2; i++) if (!p[i]) p[i] = pool.shift() || null;
      here.pairs = pairs;
      here.joins = joins;
      here.ties = pairs.flat().filter(Boolean);
    }
    return cols;
  }

  const pairUp = (c) => {
    const out = [];
    for (let n = 0; n < c.slots; n += 2)
      out.push(c.slots - n === 1 ? [c.ties[n] || null] : [c.ties[n] || null, c.ties[n + 1] || null]);
    return out;
  };

  const tieHref = (t) => (t && t.id
    ? `../${t.live ? "live" : "match"}/?league=${encodeURIComponent(S.league || "")}&id=${encodeURIComponent(t.id)}`
    : null);

  /* Every box the same height, because the joining brackets are drawn from
     it: a column's gap and top offset are worked out from the one before, so
     each slot sits exactly level with the middle of the pair that feeds it.
     Guess the geometry and the tree bends. */
  const BOX_H = 56, BOX_GAP = 14;

  function tieBox(t, hlKeys) {
    // bkt, not bt: .bt is already the Vault's bet row, and its 16px padding
    // silently made every team line three times its height in here.
    if (!t) return `<span class="btie tbd"><span class="bkt"><b>—</b></span>
      <span class="bkt"><b>—</b></span><span class="bw">Not drawn</span></span>`;
    const sc = t.legs > 1 && t.agg ? null : t.score;
    const side = (p) => {
      const team = p === "a" ? t.a : t.b, n = sc ? sc[p === "a" ? 0 : 1] : null;
      return `<span class="bkt${t.won ? (t.won === p ? " go" : " out") : ""}"><b>${esc(team.name)}</b>${
        n == null ? "" : `<em>${n}</em>`}</span>`;
    };
    const foot = t.live ? `<span class="bw lv">● ${esc(t.clock)}</span>`
      : t.legs > 1 && t.agg ? `<span class="bw">agg ${esc(aggText(t.agg))}</span>`
      : `<span class="bw">${esc(dayShort(t.when))}</span>`;
    const cls = `btie${hlKeys.includes(t.a.key) || hlKeys.includes(t.b.key) ? " hl" : ""}`;
    const body = `${side("a")}${side("b")}${foot}`;
    const href = tieHref(t);
    return href ? `<a class="${cls}" href="${href}">${body}</a>` : `<span class="${cls}">${body}</span>`;
  }

  function bracketHTML(cols, hl) {
    const hlKeys = hl.map(nameKey);
    // the round being played now: the first that is not decided
    const i = cols.findIndex((c) => !c.ties.length || c.ties.some((t) => !t.won));
    const now = i < 0 ? cols.length - 1 : i;
    let gap = BOX_GAP, pad = 0;
    const body = cols.map((c, k) => {
      const last = k === cols.length - 1;
      /* The gutter is kept even where nothing is drawn in it, so every box in
         a column is the same width whether its pairing is known or not. */
      const join = (ok) => (last ? "" : `<i class="bjoin${ok ? "" : " off"}" style="margin:${BOX_H / 2}px 0"></i>`);
      const html = `<div class="bcol" style="gap:${gap}px;padding-top:${pad}px">${
        (c.pairs || pairUp(c)).map((p, j) => p.length < 2
          ? tieBox(p[0], hlKeys)
          : `<div class="bpair"><div class="bin" style="gap:${gap}px">${
              tieBox(p[0], hlKeys)}${tieBox(p[1], hlKeys)}</div>${
              join(!!(c.joins && c.joins[j]))}</div>`).join("")}</div>`;
      pad += (BOX_H + gap) / 2;
      gap = BOX_H + 2 * gap;
      return html;
    }).join("");
    const head = cols.map((c, k) =>
      `<span${k === now ? ' class="now"' : ""}>${esc(c.name)}</span>`).join("");
    return `<div class="brack"><div class="bhd">${head}</div><div class="brow">${body}</div></div>`;
  }

  // The rounds a tree cannot hold: the early ones under a bracket, or every
  // round when there is no bracket yet (the FA Cup in October is 52 ties).
  function roundsHTML(rs, hl, heading) {
    const hlKeys = hl.map(nameKey);
    const row = (t) => {
      const sc = t.legs > 1 && t.agg ? esc(aggText(t.agg))
        : t.score ? `${t.score[0]}–${t.score[1]}` : "v";
      const cls = (p) => (t.won ? (t.won === p ? " go" : " out") : "");
      const body = `<span class="hm${cls("a")}">${esc(t.a.name)}</span><span class="sc">${sc}</span>
        <span class="aw${cls("b")}">${esc(t.b.name)}</span>
        <span class="wh">${t.live ? `● ${esc(t.clock)}` : esc(dayShort(t.when))}</span>`;
      const hi = hlKeys.includes(t.a.key) || hlKeys.includes(t.b.key) ? " hl" : "";
      const href = tieHref(t);
      return href ? `<a class="btr${hi}" href="${href}">${body}</a>` : `<span class="btr${hi}">${body}</span>`;
    };
    return `<div class="brds">${heading ? `<p class="bhdr">${esc(heading)}</p>` : ""}${
      rs.slice().reverse().map((r, i) => `<details class="brd"${i === 0 ? " open" : ""}>
        <summary><span class="rn">${esc(r.name)}</span><span class="rc">${r.ties.length} tie${
          r.ties.length === 1 ? "" : "s"}</span></summary>
        <div class="rl">${r.ties.map(row).join("")}</div></details>`).join("")}</div>`;
  }

  function tableHTML(t, games, hl, showName) {
    const rows = t.rows.map((r) => ({ ...r }));
    let moving = false;

    /* A game on right now that the table has not counted yet: add it as it
       stands. Matching on the standings' own "next match" alone never fires —
       365Scores moves nextMatch on to the FOLLOWING fixture the moment a game
       kicks off, so by the time there is a score to fold in, no row points at
       it any more. A live game is by definition not in the table yet, which is
       the safe test; a finished one is only added while the standings still
       call it next, which is the window before they catch up. */
    for (const g of games) {
      for (const side of ["home", "away"]) {
        const r = rows.find((x) => x.name === g[side]);
        if (!r || g.score[0] == null) continue;
        if (!(g.status === 3 || r.next === String(g.id))) continue;
        const f = g.score[side === "home" ? 0 : 1] || 0;
        const a = g.score[side === "home" ? 1 : 0] || 0;
        r.p++; r.gf += f; r.ga += a; r.pts += f > a ? 3 : f === a ? 1 : 0;
        if (f > a) r.w++; else if (f === a) r.d++; else r.l++;
        r.live = { text: `${f}–${a}`, clock: g.status === 3 ? (g.clock || "live") : "FT",
                   res: f > a ? "w" : f === a ? "d" : "l" };
        moving = true;
      }
    }
    if (moving) rows.sort((a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf);

    /* The match feed and the standings feed are both 365Scores and today they
       agree on all twenty names, but the feed has drifted before, so compare
       loosely rather than lose the highlight the one time it does. */
    const key = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const hlKeys = hl.map(key);
    const isHl = (name) => hlKeys.includes(key(name));
    const body = rows.map((r, i) => {
      const pos = i + 1, move = moving ? r.pos - pos : 0;
      const dest = r.dest && t.dest[r.dest];
      const gd = r.gf - r.ga, gpg = r.p ? (r.gf + r.ga) / r.p : 0;
      const hot = gpg >= 3.5;
      return `<details class="lteam${isHl(r.name) ? " hl" : ""}"${isHl(r.name) ? " open" : ""}>
        <summary class="trow">
          <span class="lp">${dest ? `<i class="tdst" style="background:${esc(dest.color)}" title="${esc(dest.name)}"></i>` : ""}${pos}${
            move > 0 ? '<b class="up">▲</b>' : move < 0 ? '<b class="dn">▼</b>' : ""}</span>
          <img class="lc" src="${esc(r.crest)}" alt="" onerror="this.style.visibility='hidden'">
          <span class="ln">${esc(r.name)}</span>
          ${r.live ? `<em class="tl ${r.live.res}">${r.live.clock === "FT" ? "" : "● "}${
            esc(r.live.text)}<small>${esc(r.live.clock)}</small></em>` : ""}
          <span class="lform">${formHTML(r.form)}</span>
          <span class="lpts">${r.pts}</span>
        </summary>
        <div class="lopen">
          Played <b>${r.p}</b> · won <b>${r.w}</b>, drew <b>${r.d}</b>, lost <b>${r.l}</b><br>
          Scored <b>${r.gf}</b>, conceded <b>${r.ga}</b> — goal difference <b>${gd > 0 ? "+" : ""}${gd}</b><br>
          <span class="${hot ? "hot" : ""}">Their games average <b class="${hot ? "hot" : ""}">${gpg.toFixed(1)} goals</b></span>${
            hot ? " — one to look at for an over" : gpg && gpg <= 2.2 ? " — tight games" : ""}
        </div></details>`;
    }).join("");

    const legend = Object.values(t.dest || {}).map((d) =>
      `<span><i class="tdst" style="background:${esc(d.color)}"></i>${esc(d.name)}</span>`).join("");

    return `<div class="ltable">${showName && t.name ? `<h4 class="tname">${esc(t.name)}</h4>` : ""}
      ${moving ? `<p class="note" style="margin:0 0 10px">● Live — today's games are in the table as
        they stand, and it updates while this is open.</p>` : ""}
      <p class="note" style="margin:0 0 6px">Tap a team for its goals and how its games have gone.</p>
      ${body}
      ${legend ? `<div class="tleg">${legend}</div>` : ""}</div>`;
  }

  async function paint() {
    const box = document.getElementById("tblBody");
    if (!box) return;
    const where = S.where, league = S.league;
    /* All three settle rather than race: a cup has no table and a league has
       no bracket, so one of them coming back empty-handed is the normal case
       here, not a failure to report. */
    const [tRes, gRes, rRes] = await Promise.all([
      window.HAWK.tables(league, where).then((v) => ({ v }), (e) => ({ e })),
      window.HAWK.scores(localDay(new Date())).then((v) => ({ v }), () => ({ v: [] })),
      (window.HAWK.cupRounds ? window.HAWK.cupRounds(league) : Promise.resolve([]))
        .then((v) => ({ v }), () => ({ v: [] })),
    ]);
    if (!document.getElementById("tblBody") || S.league !== league || S.where !== where) return;
    const tabs = tRes.v || [], games = gRes.v || [];
    const { cols, rest } = bracketCols(rRes.v || []);
    const hasTable = tabs.length > 0, hasBracket = cols.length >= 2;
    if (!hasTable && !hasBracket && !rest.length) {
      box.innerHTML = `<p class="note" style="margin:0">${
        esc((tRes.e && tRes.e.message) || "There is nothing to show for this competition.")}</p>`;
      return;
    }

    /* Nothing to switch between is no switch. A plain league never offers
       one: its "rounds" are a single stage of 380 games, which is not a
       bracket and not worth a button. The choice is remembered per
       competition, the way By group is. */
    const view = !hasTable ? "rounds"
      : hasBracket && S.views[league] === "rounds" ? "rounds" : "table";
    const vseg = hasTable && hasBracket ? `<div class="tseg" id="tblView">${
      [["table", "Table"], ["rounds", "Rounds"]].map(([k, t]) =>
        `<button type="button" data-view="${k}" aria-pressed="${String(view === k)}">${t}</button>`).join("")}</div>` : "";

    if (view === "rounds") {
      // The last round that has pairings in it, named, so the line underneath
      // says where the known part of the tree stops instead of hand-waving.
      const drawn = cols.filter((c) => c.ties.length);
      const note = hasBracket && drawn.length < cols.length
        ? `<p class="note" style="margin:14px 0 0">Scroll sideways for the later rounds. The draw
             is made round by round, so nothing after the ${esc(drawn[drawn.length - 1].name)}
             exists yet — HAWK draws the slot, never a pairing.</p>`
        : "";
      box.innerHTML = vseg
        + (hasBracket ? bracketHTML(cols, S.hl) : "")
        + note
        + (rest.length ? roundsHTML(rest, S.hl, hasBracket ? "Earlier rounds" : "") : "");
      return;
    }

    // only on All, for the reason given above
    const live = where === "all"
      ? games.filter((g) => g.league === league && (g.status === 3 || g.status === 4)) : [];

    /* A competition with groups — the Nations League, World Cup qualifying —
       came back as one list of fifty-four nations ranked 1 to 54, every league
       and group flattened. The feed does say which group each row is in. But
       showing ONLY the groups takes away the whole table, which is the one you
       want for MLS or Argentina, so both exist and the choice is remembered
       per competition rather than globally. */
    const grouped = tabs.flatMap((t) => {
      const nums = [...new Set(t.rows.map((r) => r.group).filter((g) => g != null))];
      if (nums.length < 2) return [t];
      return nums.map((g) => ({ ...t, name: t.groups[g] || `Group ${g}`,
                                rows: t.rows.filter((r) => r.group === g) }));
    });
    const hasGroups = grouped.length > tabs.length;
    const asGroups = hasGroups && S.groups[league] !== false;
    const whole = tabs.map((t) => ({ ...t, rows: t.rows.map((r, i) => ({ ...r, pos: i + 1 })) }));
    const split = asGroups ? grouped : whole;

    const seg = `<div class="tseg" id="tblWhere">${
      [["all", "All"], ["home", "Home"], ["away", "Away"]].map(([k, t]) =>
        `<button type="button" data-where="${k}" aria-pressed="${String(where === k)}">${t}</button>`).join("")}</div>`
      + (hasGroups ? `<div class="tseg" id="tblGroups">${
        [[true, "By group"], [false, "One table"]].map(([k, t]) =>
          `<button type="button" data-groups="${k}" aria-pressed="${String(asGroups === k)}">${t}</button>`).join("")}</div>` : "");

    box.innerHTML = vseg + seg + split.map((t) => tableHTML(t, live, S.hl, split.length > 1)).join("");
  }

  function close() {
    clearTimeout(S.timer);
    if (S.el) { S.el.remove(); S.el = null; }
    document.removeEventListener("keydown", onKey);
    S.league = null;
  }
  const onKey = (e) => { if (e.key === "Escape") close(); };

  async function open(league, highlight = []) {
    if (!window.HAWK || !window.HAWK.tables) return;
    close();
    S.where = "all";                 // always opens on the full table
    S.league = league;
    S.hl = Array.isArray(highlight) ? highlight.filter(Boolean) : [];

    const el = document.createElement("div");
    el.className = "tpanel";
    el.innerHTML = `<div class="in" role="dialog" aria-label="${esc(league)}">
      <div class="hd"><h3>${esc(league)}</h3>
        <button class="x" type="button" aria-label="Close">✕</button></div>
      <div id="tblBody"><p class="note" style="margin:0">Reading the table…</p></div>
    </div>`;
    el.addEventListener("click", (e) => {
      if (e.target === el || e.target.closest(".x")) { close(); return; }
      const v = e.target.closest("[data-view]");
      if (v) {
        S.views[S.league] = v.dataset.view;
        savePref("hawk.tableView", S.views);
        paint();
        return;
      }
      const w = e.target.closest("[data-where]");
      if (w && w.dataset.where !== S.where) { S.where = w.dataset.where; paint(); return; }
      const g = e.target.closest("[data-groups]");
      if (g) {
        S.groups[S.league] = g.dataset.groups === "true";
        savePref("hawk.tableGroups", S.groups);
        paint();
      }
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(el);
    S.el = el;

    await paint();
    // a live game moves the table under you; keep it honest while it is open
    const tick = () => { S.timer = setTimeout(async () => { if (S.el) { await paint(); tick(); } }, 30000); };
    tick();
  }

  // any [data-table] opens it; data-hl is a JSON array of the names to light up
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-table]");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    let hl = [];
    try { hl = JSON.parse(b.dataset.hl || "[]"); } catch { /* none */ }
    open(b.dataset.table, hl);
  }, true);

  window.HAWKTable = { open, close };
})();
