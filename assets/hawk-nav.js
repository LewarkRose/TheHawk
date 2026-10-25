/* ===========================================================================
   The nav, injected rather than copied into five files — the whole reason the
   old builder ended up with three styling systems is that its furniture was
   pasted into each page and then edited in only some of them.

   It lists what EXISTS in the new language and nothing else. Acca and Scan are
   still only on the old site, so they are reached through the one "v1" link
   rather than being listed as if they were here.
   =========================================================================== */
(() => {
  "use strict";

  // every page is one folder deep, so "../" reaches the site root
  const LINKS = [
    ["today", "../today/", "Today"],
    ["scores", "../scores/", "Scores"],
    ["board", "../board/", "Board"],
    ["vault", "../vault/", "Vault"],
  ];

  // which page we are on, from the folder name
  const here = (location.pathname.replace(/\/+$/, "").split("/").pop() || "home").toLowerCase();

  const nav = document.createElement("nav");
  nav.className = "nav";
  nav.innerHTML = `<div class="in">
      <a class="mark" href="../home/"><i></i>Hawk</a>
      <div class="links">${LINKS.map(([k, href, label]) =>
        `<a href="${href}"${k === here ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</div>
      <div class="right">
        <a class="old" href="../builder/" title="Acca and Scan are still on the old site">v1 ·
          acca, scan</a>
        <a class="btn gold btn-sm" href="../scores/">Build a bet</a>
      </div>
    </div>`;
  document.body.insertBefore(nav, document.body.firstChild);

  // The bell goes in the nav rather than on one page, because the alerts run on
  // every page: the switch has to be wherever you are when you want it off.
  if (window.HAWKAlerts) window.HAWKAlerts.mountBell(nav.querySelector(".right"));

  // transparent over the hero, lit once you have scrolled past it
  const hero = document.querySelector(".hero");
  const lit = () => nav.classList.toggle("lit", scrollY > (hero ? 60 : 10));
  lit();
  addEventListener("scroll", lit, { passive: true });
})();
