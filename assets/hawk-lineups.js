/* ===========================================================================
   Lineups — the pitch, both XIs, the bench, who is out, and a tap-through to
   any player's record.

   Ported from the old builder's lineupCard() and its helpers so the two sites
   say the same thing about the same match. The logic is unchanged; what moved
   is the palette (home is gold and away is navy here, matching the chance bar
   everywhere else) and the fact that it is a module rather than six globals.

   Usage:
     HAWKLineups.render(el, m, { live, gameId })
   where `m` is a HAWK.match() object and `live`, when given, is a
   HAWK.liveMatch() object for the same fixture.
   =========================================================================== */
(() => {
  "use strict";

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const pct = (p) => (Number.isFinite(p) ? `${Math.round(100 * p)}%` : "");

  /* name matching: strip accents and punctuation, then accept a match on the
     surname plus the first initial — "M. Ødegaard" and "Martin Odegaard" */
  const pName = (s) => String(s || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const samePerson = (a, b) => {
    const x = pName(a), y = pName(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const xs = x.split(" "), ys = y.split(" ");
    return xs[xs.length - 1] === ys[ys.length - 1] && xs[0][0] === ys[0][0];
  };

  /* where each starter stands. A player with a `field` position from the feed
     keeps it; everyone else is laid out by line (keeper, defence, midfield,
     attack) and spread evenly across it. */
  function pitchSpots(list) {
    const out = [], byLine = { G: [], D: [], M: [], F: [] };
    for (const p of (list || []).filter((x) => x.status === "Starting")) {
      if (p.field) out.push({ p, depth: p.field.depth, side: p.field.side });
      else (byLine[p.pos] || byLine.M).push(p);
    }
    const depthOf = { G: 0, D: 28, M: 58, F: 88 };
    for (const [pos, ps] of Object.entries(byLine)) {
      ps.forEach((p, i) => out.push({ p, depth: depthOf[pos],
        side: ps.length === 1 ? 50 : 10 + (80 * i) / (ps.length - 1) }));
    }
    return out;
  }

  /* what happened to each player so far, from the live match's events */
  function liveEventsBy(live, m) {
    const by = { home: {}, away: {} };
    const rec = (side, name) => (by[side][pName(name)] ||=
      { goals: 0, og: 0, assists: 0, yellow: 0, red: 0 });
    const sideOf = (name, fallback) => ["home", "away"]
      .find((s) => (m.players[s] || []).some((p) => samePerson(p.name, name))) || fallback;
    for (const e of live.events || []) {
      if (!e.player) continue;
      if (e.type === "goal") {
        const own = /own/i.test(e.detail || "");
        rec(own ? sideOf(e.player, e.side === "home" ? "away" : "home") : e.side, e.player)[own ? "og" : "goals"]++;
        if (e.other && !own) rec(e.side, e.other).assists++;
      } else if (e.type === "yellow" || e.type === "red") {
        rec(e.side, e.player)[e.type]++;
      } else if (e.type === "sub") {
        Object.assign(rec(e.side, e.player), { on: e.minute, for: e.other });
        if (e.other) Object.assign(rec(e.side, e.other), { off: e.minute, by: e.player });
      }
    }
    return by;
  }
  function liveRec(by, side, name) {
    const t = by[side] || {};
    if (t[pName(name)]) return t[pName(name)];
    const k = Object.keys(t).find((n) => samePerson(n, name));
    return k ? t[k] : null;
  }
  const liveIcons = (r) => (r
    ? "⚽".repeat(Math.min(r.goals, 3)) + (r.og ? "🥅og" : "")
      + (r.assists ? "🅰️".repeat(Math.min(r.assists, 2)) : "")
      + (r.red ? "🟥" : r.yellow ? "🟨" : "")
    : "");

  /* players you already have a pending bet on, so the pitch can mark them */
  function myBetPlayers(gameId) {
    const out = new Set();
    try {
      const bets = JSON.parse(localStorage.getItem("hawk_bets") || "[]");
      for (const b of Array.isArray(bets) ? bets : []) {
        if (b.status !== "PENDING") continue;
        for (const l of b.legs || []) {
          if (!(l.hawk && String(l.hawk.game) === String(gameId))) continue;
          for (const h of l.hawk.legs || []) if (h.player) out.add(pName(h.player));
        }
      }
    } catch { /* no Vault data in this browser */ }
    return out;
  }

  /* a player's face, with his shirt number as a badge. 365Scores' photo first,
     ESPN's headshot second, the number alone if neither exists — the grey
     default silhouette is worse than a number. */
  const FALLBACK = "if(this.dataset.alt){this.src=this.dataset.alt;this.dataset.alt=''}"
    + "else{this.parentNode.classList.remove('face');this.remove()}";
  function shirtHTML(p) {
    const no = p.num || p.pos || "·";
    const src = p.photo ? String(p.photo).replace(/,d_[^,/]+/, "") : null;
    return src
      ? `<div class="shirt face"><img src="${esc(src)}" alt="" data-alt="${esc(p.photo2 || "")}"
           onerror="${FALLBACK}"><span class="no">${esc(no)}</span></div>`
      : `<div class="shirt"${p.num ? "" : ` title="No shirt number yet"`}><span class="no">${esc(no)}</span></div>`;
  }

  /* the one number worth printing under a name before kick-off */
  const legsFor = (m, side, name) => (m.legs || [])
    .filter((l) => l.kind === "player" && l.side === side && l.player === name);
  function playerTag(m, side, p) {
    const legs = legsFor(m, side, p.name), find = (re) => legs.find((l) => re.test(l.id));
    if (p.pos === "G") { const s = find(/:saves2$/); return s ? `🧤 ${pct(s.p)}` : ""; }
    const sc = find(/:score$/);
    if (sc && sc.p >= 0.15) return `⚽ ${pct(sc.p)}`;
    const sot = find(/:sot1$/);
    return sot ? `🎯 ${pct(sot.p)}` : "";
  }

  /* ---------------------------------------------------------------- view */
  const view = { rx: 46, rz: 0 };
  let flat = false;
  try { flat = JSON.parse(localStorage.getItem("hawk.p3d") || "{}").flat === true; } catch { /* default */ }

  function html(m, live, gameId) {
    if (!m.players || !(m.players.home || []).some((p) => p.status === "Starting")) return "";
    const by = live ? liveEventsBy(live, m) : null;
    const mine = live ? myBetPlayers(gameId || m.id) : null;
    const inBet = (name) => mine && [...mine].some((n) => samePerson(n, name));

    const lu = m.lineups || { home: {}, away: {} };
    const confirmed = lu.home.status === "Confirmed" && lu.away.status === "Confirmed";
    const guess = lu.home.guess || lu.away.guess;
    // two sources: 365Scores and ESPN. Both named = checked against each other.
    const srcs = [lu.home.source, lu.away.source];
    const bothChecked = srcs.every((s) => s === "365Scores + ESPN");
    const espnOnly = srcs.includes("ESPN");
    const disagree = ["home", "away"].filter((s) => lu[s].check && !lu[s].check.agree);
    const badge = !confirmed ? null
      : disagree.length ? "Confirmed · HAWK uses 365Scores' XI"
      : bothChecked ? "Confirmed · 365Scores and ESPN agree"
      : espnOnly ? "Confirmed by ESPN — 365Scores hasn't published it yet"
      : "Confirmed by 365Scores — ESPN's not out yet";
    const diffNote = disagree.map((s) => {
      const c = lu[s].check;
      return `<b>${esc(s === "home" ? m.home : m.away)}</b>: 365Scores has
        ${esc(c.only365.join(", ") || "—")} · ESPN has ${esc(c.onlyEspn.join(", ") || "—")}`;
    }).join("<br>");

    const marker = (side, { p, depth, side: s }) => {
      // Horizontal pitch: home attacks left to right. On a phone it stands up
      // (turned clockwise): home at the top, away at the bottom. Kept a little
      // inside the lines so names on the wings are not cut off.
      const hl = side === "home" ? 6 + depth * 0.4 : 94 - depth * 0.4;
      const ht = side === "home" ? 12 + s * 0.74 : 88 - s * 0.74;
      const vt = side === "home" ? 6 + depth * 0.4 : 94 - depth * 0.4;
      const vl = side === "home" ? 88 - s * 0.76 : 12 + s * 0.76;
      const at = `style="--hl:${hl.toFixed(1)}%;--ht:${ht.toFixed(1)}%;`
               + `--vl:${vl.toFixed(1)}%;--vt:${vt.toFixed(1)}%"`;

      if (live) {
        // subbed off: the player who came on takes his spot
        const r = liveRec(by, side, p.name);
        const subP = r && r.off && r.by
          ? (m.players[side] || []).find((x) => samePerson(x.name, r.by)) || { name: r.by } : null;
        const who = subP || p, rw = subP ? liveRec(by, side, subP.name) : r;
        const tag = (subP ? `↑${r.off} ` : "") + liveIcons(rw)
          + (!subP && r && r.off ? ` ↓${r.off}` : "") + (inBet(who.name) ? " 🎟" : "");
        return `<div class="pm ${side}${subP ? " subon" : ""}${!subP && r && r.off ? " gone" : ""}`
          + `${rw && (rw.goals || rw.assists) ? " star" : ""}${inBet(who.name) ? " mine" : ""}" ${at}
            data-lp="${side}" data-name="${esc(who.name)}"
            title="${esc(who.name)}${subP ? ` — on for ${esc(p.name)} (${esc(r.off)})` : ""}${inBet(who.name) ? " — in your bet" : ""}">
          ${shirtHTML(who)}<div class="nm">${esc(who.short || who.name.split(" ").slice(-1)[0])}</div>
          ${tag.trim() ? `<div class="tg">${tag.trim()}</div>` : ""}</div>`;
      }

      const tag = playerTag(m, side, p);
      const booked = legsFor(m, side, p.name).find((l) => /:booked$/.test(l.id) && l.p >= 0.3);
      // hasn't played in the team's last 5: new signing, back from injury — or
      // a lineup mistake, which is worth knowing before you build on him
      const fresh = p.teamMins === 0 && p.has_data;
      return `<div class="pm ${side}" ${at} data-lp="${side}" data-name="${esc(p.name)}"
          title="${esc(p.name)}${p.doubtful ? " — doubtful" : ""}${!p.has_data ? " — no recent data (new or young player)" : ""}${
          fresh ? ` — hasn't played in ${esc(side === "home" ? m.home : m.away)}'s last 5 games` : ""}">
        ${shirtHTML(p)}<div class="nm">${p.doubtful ? "❓" : ""}${fresh ? "🆕" : ""}${
          esc(p.short || p.name.split(" ").slice(-1)[0])}</div>
        ${tag || booked ? `<div class="tg">${tag}${booked ? " 🟨" : ""}</div>` : ""}</div>`;
    };

    const bench = (side) => (m.players[side] || []).filter((p) => p.status === "Substitute")
      .map((p) => {
        const r = live ? liveRec(by, side, p.name) : null, on = r && r.on;
        return `<span class="lu-chip${on ? " on" : ""}" data-lp="${side}" data-name="${esc(p.name)}"
          ${on ? ` title="On for ${esc(r.for || "?")} (${esc(r.on)})"` : ""}>${
          p.num ? `<b>${esc(p.num)}</b> ` : ""}${esc(p.short || p.name)}${on ? ` ↑${esc(r.on)}` : ""}</span>`;
      }).join("") || `<span class="lu-none">—</span>`;

    const out = (side) => ((m.missing || {})[side] || []).map((o) =>
      `<span class="lu-chip out" title="${esc(o.reason || o.status)}${o.back ? ` · back ${esc(o.back)}` : ""}">${
        o.status === "Doubtful" ? "❓" : "✚"} ${esc(o.name)}</span>`).join("");

    const team = (side) => `<div class="lu-team">
      <div class="lu-tname"><span class="dot ${side}"></span>${esc(side === "home" ? m.home : m.away)}
        <span class="lu-form">${esc(lu[side].formation || "")}${
          lu[side].guess && lu[side].formation ? " (guess)" : ""}</span></div>
      <div class="lu-row"><span class="lu-k">Bench</span>${bench(side)}</div>
      ${out(side) ? `<div class="lu-row"><span class="lu-k">Out</span>${out(side)}</div>` : ""}</div>`;

    const status = live ? `${esc(live.clock || "Live")} · goals, cards and subs`
      : badge ? badge
      : guess ? "HAWK's guess — no lineup out yet, taken from the team's last 5 games"
      : "Predicted — confirmed about an hour before kick-off";

    return `<div class="lu">
      <div class="lu-badge${live ? " live" : confirmed ? " ok" : ""}">${
        live ? `<span class="d"></span>` : ""}${esc(status)}</div>
      ${diffNote && !live ? `<p class="note" style="margin:14px 0 0">ESPN names someone else:
        ${diffNote} — HAWK went with 365Scores.</p>` : ""}
      <div class="stage3d${flat ? "" : " p3d"}" style="--rx:${view.rx}deg;--rz:${view.rz}deg">
        <div class="pitch">
          <svg class="pl-h" viewBox="0 0 160 100" preserveAspectRatio="none"><rect x="1" y="1" width="158" height="98"/>
            <line x1="80" y1="1" x2="80" y2="99"/><circle cx="80" cy="50" r="9"/>
            <rect x="1" y="22" width="16" height="56"/><rect x="1" y="38" width="6" height="24"/>
            <rect x="143" y="22" width="16" height="56"/><rect x="153" y="38" width="6" height="24"/></svg>
          <svg class="pl-v" viewBox="0 0 100 160" preserveAspectRatio="none"><rect x="1" y="1" width="98" height="158"/>
            <line x1="1" y1="80" x2="99" y2="80"/><circle cx="50" cy="80" r="9"/>
            <rect x="22" y="1" width="56" height="16"/><rect x="38" y="1" width="24" height="6"/>
            <rect x="22" y="143" width="56" height="16"/><rect x="38" y="153" width="24" height="6"/></svg>
          ${["home", "away"].map((side) =>
            pitchSpots(m.players[side] || []).map((spot) => marker(side, spot)).join("")).join("")}
        </div>
      </div>
      <div class="p3d-ctl"><span class="p3d-hint">${flat ? "" : "Drag the pitch to spin it"}</span>
        <button class="btn ghost sm" data-p3d="reset"${flat ? " hidden" : ""}>Reset</button>
        <button class="btn ghost sm" data-p3d="flat">${flat ? "3D" : "Flat"}</button></div>
      <p class="lu-legend">${live
        ? "⚽ goal · 🅰️ assist · 🟨 🟥 cards · ↑ came on · ↓ went off · 🎟 in your bet — updates every 15 seconds"
        : "⚽ chance to score · 🎯 1+ shot on target · 🧤 2+ saves · 🟨 30%+ to be booked · ❓ doubtful · 🆕 not in the team's last 5"}</p>
      <div class="lu-teams">${team("home")}${team("away")}</div></div>`;
  }

  /* --------------------------------------------------------- the 3D pitch
     Drag sideways to spin it; with a mouse, up and down tilts it too. A
     vertical swipe on a phone still scrolls the page, and a drag is never
     mistaken for a tap on a player. */
  let drag = null, moved = false;
  const put = (st) => {
    st.style.setProperty("--rx", view.rx + "deg");
    st.style.setProperty("--rz", view.rz + "deg");
  };
  document.addEventListener("pointerdown", (e) => {
    const st = e.target.closest && e.target.closest(".stage3d.p3d");
    if (!st || e.button > 0) return;
    drag = { st, x: e.clientX, y: e.clientY, rx: view.rx, rz: view.rz, touch: e.pointerType !== "mouse" };
    moved = false;
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    if (!moved && drag.touch && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
    moved = true;
    drag.st.classList.add("grabbing");
    view.rz = drag.rz + dx * 0.4;
    if (!drag.touch) view.rx = Math.max(0, Math.min(65, drag.rx - dy * 0.3));
    put(drag.st);
  });
  // a face photo would otherwise start the browser's own image drag
  document.addEventListener("dragstart", (e) => {
    if (e.target.closest && e.target.closest(".stage3d")) e.preventDefault();
  });
  const end = () => { if (drag) drag.st.classList.remove("grabbing"); drag = null; };
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);

  document.addEventListener("click", (e) => {
    if (moved && e.target.closest && e.target.closest(".stage3d")) {
      e.stopPropagation(); e.preventDefault(); moved = false; return;
    }
    const b = e.target.closest && e.target.closest("[data-p3d]");
    if (!b) return;
    if (b.dataset.p3d === "flat") {
      flat = !flat;
      try { localStorage.setItem("hawk.p3d", JSON.stringify({ flat })); } catch { /* private window */ }
    } else {
      view.rx = matchMedia("(max-width:560px)").matches ? 40 : 46;
      view.rz = 0;
    }
    document.querySelectorAll(".stage3d").forEach((st) => { st.classList.toggle("p3d", !flat); put(st); });
    document.querySelectorAll(".p3d-ctl").forEach((c) => {
      c.querySelector(".p3d-hint").textContent = flat ? "" : "Drag the pitch to spin it";
      c.querySelector('[data-p3d="reset"]').hidden = flat;
      c.querySelector('[data-p3d="flat"]').textContent = flat ? "3D" : "Flat";
    });
  }, true);

  window.HAWKLineups = {
    render(el, m, opts = {}) {
      if (!el) return false;
      const out = html(m, opts.live || null, opts.gameId);
      el.innerHTML = out;
      return !!out;
    },
    samePerson, pName, liveEventsBy, liveRec, myBetPlayers,
  };
})();
