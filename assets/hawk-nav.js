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
  const LINKS = [
    ["today", "../today/", "Today"],
    ["picks", "../picks/", "Picks"],
    ["scores", "../scores/", "Scores"],
    ["acca", "../acca/", "Acca"],
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
        <a class="old" href="../builder/" title="The old builder, for what has not been rebuilt">v1</a>
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
