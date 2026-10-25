/* ===========================================================================
   The nav, injected rather than copied into five files — the whole reason the
   old builder ended up with three styling systems is that its furniture was
   pasted into each page and then edited in only some of them.

   It lists what EXISTS in the new language and nothing else. The "v1" link
   that used to sit beside My bets has gone with the page it pointed at —
   builder/index.html is deleted. The engine it shared a folder with is not
   deleted and never could be: every page here loads builder/engine.js.
   =========================================================================== */
(() => {
  "use strict";

  // every page is one folder deep, so "../" reaches the site root
  /* Five, not nine. Picks is gone — it is reached from Scores like any other
     match. A match page is somewhere you ARRIVE, by tapping a game, so it is
     not a place to set off from either. Today stays, and it is not a second
     Scores: Scores is the day's football, Today is what YOU did with it. */
  const LINKS = [
    ["today", "../today/", "Today", "📅"],
    ["scores", "../scores/", "Scores", "⚽"],
    ["acca", "../acca/", "Acca", "📶"],
    ["board", "../board/", "Board", "📊"],
    ["vault", "../vault/", "Vault", "🏦"],
  ];

  // which page we are on, from the folder name
  const here = (location.pathname.replace(/\/+$/, "").split("/").pop() || "home").toLowerCase();

  /* The crest, inline rather than an <img>, so it takes the page's own colour
     variables and can lift on hover. Same two paths as assets/hawk-mark.svg
     and favicon.svg — one shape, three places, no second drawing of it. The
     gold diamond that used to sit here was a placeholder that outstayed its
     welcome: HAWK has a mark and the site was not using it. */
  const CREST = `<svg class="crest" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path class="sh" d="M32 1 L62 10 V36 C62 50 48 60 32 63 C16 60 2 50 2 36 V10 Z"/>
      <path class="bd" d="M32 15 L36 21 L32 25 L28 21 Z M30 27 L6 17 L13 26 L6 28 L16 34 L30 39 Z
        M34 27 L58 17 L51 26 L58 28 L48 34 L34 39 Z M28 42 L32 54 L36 42 L32 45 Z"/>
    </svg>`;

  /* MY BETS — what you have running, with the count, on every page.
     v1 carried this and the rebuild dropped it: running tickets were on
     Today and behind a filter in the Vault, so nothing anywhere told you
     two were on. It is the one number you want visible without looking
     for it, so it lives in the bar. */
  const running = () => {
    try {
      const b = JSON.parse(localStorage.getItem("hawk_bets") || "[]");
      return Array.isArray(b) ? b.filter((x) => x && x.status === "PENDING").length : 0;
    } catch { return 0; }
  };
  const myBets = (n) => `<button type="button" class="mine${n ? " on" : ""}" id="mineBtn"
      title="${n ? `${n} ticket${n === 1 ? "" : "s"} running` : "Nothing running"}"><i
      class="ic">🎟️</i><b class="tx">My bets</b>${n ? `<i class="ct">${n}</i>` : ""}</button>`;

  /* ------------------------------------------------------- the bets drawer
     v1 opened My bets beside the page rather than navigating to it, and it
     was right to: you check what is running WHILE reading a match, and a
     page jump loses the slip you were building. Swings in from the right on
     a wide screen, covers the page on a phone. */
  const money = (n) => `${n < 0 ? "−" : ""}€${Math.abs(+n || 0).toFixed(2)}`;
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const bets = () => {
    try { const b = JSON.parse(localStorage.getItem("hawk_bets") || "[]"); return Array.isArray(b) ? b : []; }
    catch { return []; }
  };
  const bank = () => { const n = parseFloat(localStorage.getItem("hawk_bankroll")); return Number.isFinite(n) ? n : null; };

  let drawer = null;
  function drawerHTML() {
    const open = bets().filter((b) => b && b.status === "PENDING");
    const atRisk = open.reduce((a, b) => a + (+b.stake || 0), 0);
    const couldWin = open.reduce((a, b) => a + (+b.potentialReturn || 0), 0);
    const bk = bank();
    const MARK = { won: ["w", "✓"], lost: ["l", "✗"], void: ["v", "∅"] };
    return `<div class="dhd"><h4>🎟 My bets</h4>
        <button type="button" class="x" data-dclose title="Close">✕</button></div>
      ${open.length ? `<div class="dsum">
          <div><span class="k">On</span><span class="v">${money(atRisk)}</span></div>
          <div><span class="k">Could return</span><span class="v g">${money(couldWin)}</span></div>
          <div><span class="k">Bankroll</span><span class="v">${bk == null ? "—" : money(bk)}</span></div>
        </div>` : ""}
      <div class="dlist">${open.length ? open.map((b) => {
        const where = [...new Set((b.legs || []).map((l) => l.fixture).filter(Boolean))].join(" · ");
        const hawk = (b.legs || []).flatMap((l) => (l.hawk && l.hawk.legs) || []);
        const done = hawk.filter((h) => h.result === "won").length;
        return `<a class="dbet" href="../vault/?mine=1">
          <div class="t"><span class="nm">${esc(where || "Ticket")}</span>
            <span class="od">${(+b.odds || 0).toFixed(2)}</span></div>
          ${hawk.length ? `<ul class="dl">${hawk.slice(0, 8).map((h) => {
            const [c, mk] = MARK[h.result] || ["o", "·"];
            return `<li><i class="${c}">${mk}</i>${esc(h.label || "")}</li>`;
          }).join("")}</ul>` : ""}
          <div class="f"><span>${money(b.stake)} on${
            hawk.length ? ` · ${done} of ${hawk.length} legs home` : ""}</span>
            <b>${money(b.potentialReturn)}</b></div></a>`;
      }).join("") : `<p class="dnone">Nothing running. Build one from a match and it shows up here
        wherever you are.</p>`}</div>
      <div class="dft"><a class="btn ghost btn-sm" href="../vault/?mine=1">Open the Vault</a></div>`;
  }
  function toggleDrawer(on) {
    if (!drawer) {
      drawer = document.createElement("aside");
      drawer.className = "bdrawer";
      document.body.appendChild(drawer);
      drawer.addEventListener("click", (e) => { if (e.target.closest("[data-dclose]")) toggleDrawer(false); });
      addEventListener("keydown", (e) => { if (e.key === "Escape") toggleDrawer(false); });
    }
    const want = on == null ? !drawer.classList.contains("on") : on;
    if (want) drawer.innerHTML = drawerHTML();
    drawer.classList.toggle("on", want);
    document.body.classList.toggle("drawn", want);
  }

  const nav = document.createElement("nav");
  nav.className = "nav";
  nav.innerHTML = `<div class="in">
      <a class="mark" href="../home/">${CREST}Hawk</a>
      <div class="links">${LINKS.map(([k, href, label, icon]) =>
        `<a href="${href}"${k === here ? ' aria-current="page"' : ""}><i>${icon}</i>${label}</a>`).join("")}</div>
      <div class="right">
        <span id="navMine">${myBets(running())}</span>
        <a class="btn gold btn-sm" href="../scores/">Build a bet</a>
      </div>
    </div>`;
  document.body.insertBefore(nav, document.body.firstChild);

  /* The count has to follow the Vault, not a page load: placing a bet here,
     settling one in another tab, or a sync arriving all change it. */
  const refresh = () => {
    const el = nav.querySelector("#navMine");
    if (el) el.innerHTML = myBets(running());
    if (drawer && drawer.classList.contains("on")) drawer.innerHTML = drawerHTML();
  };
  addEventListener("storage", (e) => { if (e.key === "hawk_bets") refresh(); });
  nav.addEventListener("click", (e) => { if (e.target.closest("#mineBtn")) toggleDrawer(); });
  window.HAWKNav = { refresh, openBets: () => toggleDrawer(true) };

  // The bell goes in the nav rather than on one page, because the alerts run on
  // every page: the switch has to be wherever you are when you want it off.
  if (window.HAWKAlerts) window.HAWKAlerts.mountBell(nav.querySelector(".right"));

  // transparent over the hero, lit once you have scrolled past it
  const hero = document.querySelector(".hero");
  const lit = () => nav.classList.toggle("lit", scrollY > (hero ? 60 : 10));
  lit();
  addEventListener("scroll", lit, { passive: true });
})();
