/* ===========================================================================
   The nav, injected rather than copied into five files — the whole reason the
   old builder ended up with three styling systems is that its furniture was
   pasted into each page and then edited in only some of them.

   It lists what EXISTS in the new language and nothing else. The old site is
   reached through the one "v1" link, which is now there for the scans and
   tools that have not been rebuilt rather than for anything in this list.
   =========================================================================== */
(() => {
  "use strict";

  // every page is one folder deep, so "../" reaches the site root
  /* Five, not nine. Picks is gone — it is reached from Scores like any other
     match. A match page is somewhere you ARRIVE, by tapping a game, so it is
     not a place to set off from either. Today stays, and it is not a second
     Scores: Scores is the day's football, Today is what YOU did with it. */
  const LINKS = [
    ["today", "../today/", "Today"],
    ["scores", "../scores/", "Scores"],
    ["acca", "../acca/", "Acca"],
    ["board", "../board/", "Board"],
    ["vault", "../vault/", "Vault"],
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
  const myBets = (n) => `<a class="mine${n ? " on" : ""}" href="../vault/?mine=1"
      title="${n ? `${n} ticket${n === 1 ? "" : "s"} running` : "Nothing running"}">My bets${
      n ? `<i>${n}</i>` : ""}</a>`;

  const nav = document.createElement("nav");
  nav.className = "nav";
  nav.innerHTML = `<div class="in">
      <a class="mark" href="../home/">${CREST}Hawk</a>
      <div class="links">${LINKS.map(([k, href, label]) =>
        `<a href="${href}"${k === here ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</div>
      <div class="right">
        <span id="navMine">${myBets(running())}</span>
        <a class="old" href="../builder/" title="The old builder, for what has not been rebuilt">v1</a>
        <a class="btn gold btn-sm" href="../scores/">Build a bet</a>
      </div>
    </div>`;
  document.body.insertBefore(nav, document.body.firstChild);

  /* The count has to follow the Vault, not a page load: placing a bet here,
     settling one in another tab, or a sync arriving all change it. */
  const refresh = () => { const el = nav.querySelector("#navMine"); if (el) el.innerHTML = myBets(running()); };
  addEventListener("storage", (e) => { if (e.key === "hawk_bets") refresh(); });
  window.HAWKNav = { refresh };

  // The bell goes in the nav rather than on one page, because the alerts run on
  // every page: the switch has to be wherever you are when you want it off.
  if (window.HAWKAlerts) window.HAWKAlerts.mountBell(nav.querySelector(".right"));

  // transparent over the hero, lit once you have scrolled past it
  const hero = document.querySelector(".hero");
  const lit = () => nav.classList.toggle("lit", scrollY > (hero ? 60 : 10));
  lit();
  addEventListener("scroll", lit, { passive: true });
})();
