/* ===========================================================================
   THE LEAGUE TABLE

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
              groups: loadPref("hawk.tableGroups", {}) };

  /* Last five as blocks, oldest on the left. The standings list form oldest
     first; HAWK's own form() builds it newest first, so anything using that
     one has to say so rather than showing it backwards. */
  const formHTML = (s, newestFirst = false) => {
    if (!s) return "";
    const five = newestFirst ? s.split("").slice(0, 5).reverse() : s.split("").slice(-5);
    return `<span class="fmr">${five.map((c) =>
      `<i class="${c === "W" ? "fw" : c === "D" ? "fd" : "fl"}">${esc(c)}</i>`).join("")}</span>`;
  };

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
    let tabs, games = [];
    try {
      [tabs, games] = await Promise.all([
        window.HAWK.tables(league, where),
        window.HAWK.scores(localDay(new Date())).catch(() => []),
      ]);
    } catch (err) {
      box.innerHTML = `<p class="note" style="margin:0">${esc((err && err.message) || "The table wouldn't load.")}</p>`;
      return;
    }
    if (!document.getElementById("tblBody") || S.league !== league || S.where !== where) return;

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

    box.innerHTML = seg + split.map((t) => tableHTML(t, live, S.hl, split.length > 1)).join("");
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
    el.innerHTML = `<div class="in" role="dialog" aria-label="${esc(league)} table">
      <div class="hd"><h3>${esc(league)}</h3>
        <button class="x" type="button" aria-label="Close">✕</button></div>
      <div id="tblBody"><p class="note" style="margin:0">Reading the table…</p></div>
    </div>`;
    el.addEventListener("click", (e) => {
      if (e.target === el || e.target.closest(".x")) { close(); return; }
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
