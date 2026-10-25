/* ===========================================================================
   THE WAY BACK, ON THE OLD PAGES.

   The rebuilt site is the front door now, but v1 still holds things that were
   never rebuilt, so it stays reachable — and from inside it there was no way
   out except the browser's back button.

   This is a script rather than markup on purpose. v1's two pages are 4,500
   and 10,000 lines of HTML with three styling systems between them, and the
   smallest honest change to them is one <script> tag each. Everything the
   link is lives here, in the new language, with its own styles scoped to
   itself so it cannot disturb whatever it is sitting on top of.
   =========================================================================== */
(() => {
  "use strict";
  if (document.getElementById("hawkV1Back")) return;

  /* Where "home" is, worked out from THIS script's own URL rather than the
     page's. The two old pages sit at different depths — vault-v1.html is at
     the site root and the builder is a folder below it — so a hardcoded
     "../home/" is right on one and points outside the site on the other. */
  const src = (document.currentScript && document.currentScript.src)
    || [...document.scripts].map((s) => s.src).find((s) => /hawk-v1-link\.js/.test(s)) || "";
  const HOME = src ? new URL("../home/", src).href : "./home/";

  const css = `
  #hawkV1Back{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;
    display:flex;align-items:center;gap:12px;padding:9px 10px 9px 16px;
    background:#0e0f13;box-shadow:inset 0 0 0 1px rgba(242,242,242,.16),0 22px 50px -22px #000;
    font:400 12px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#8b8b95;
    animation:hawkV1In .7s cubic-bezier(.16,1,.3,1) both}
  @keyframes hawkV1In{from{opacity:0;transform:translate(-50%,14px)}}
  #hawkV1Back b{color:#55555f;font:700 9px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    letter-spacing:.18em;text-transform:uppercase}
  #hawkV1Back a{display:inline-block;padding:8px 14px;text-decoration:none;color:#f2dba4;
    font:700 9.5px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.16em;
    text-transform:uppercase;box-shadow:inset 0 0 0 1px #d4a94e;
    transition:background .35s cubic-bezier(.16,1,.3,1),color .35s cubic-bezier(.16,1,.3,1)}
  #hawkV1Back a:hover{background:#d4a94e;color:#231a06}
  #hawkV1Back button{border:0;background:none;cursor:pointer;color:#55555f;padding:6px 4px;
    font:400 13px/1 system-ui,sans-serif;transition:color .3s}
  #hawkV1Back button:hover{color:#f2f2f2}
  @media (max-width:560px){
    #hawkV1Back{left:10px;right:10px;transform:none;bottom:10px;justify-content:space-between;
      animation-name:hawkV1InPhone}
    @keyframes hawkV1InPhone{from{opacity:0;transform:translateY(14px)}}
    #hawkV1Back b{display:none}
  }`;

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "hawkV1Back";
  bar.innerHTML = `<b>You are on the old HAWK</b>
    <a href="${HOME}">Back to HAWK</a>
    <button type="button" aria-label="Hide for this session">✕</button>`;
  // Dismissed per session, not for ever: hiding it on a page you came to on
  // purpose should not hide it tomorrow when you have forgotten the way out.
  try { if (sessionStorage.getItem("hawk.v1back") === "off") return; } catch { /* private window */ }
  bar.querySelector("button").onclick = () => {
    bar.remove();
    try { sessionStorage.setItem("hawk.v1back", "off"); } catch { /* ignored */ }
  };
  (document.body || document.documentElement).appendChild(bar);
})();
