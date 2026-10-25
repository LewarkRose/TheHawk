/* ===========================================================================
   Folding sections.

   Any <details class="fold" data-fold="key"> remembers whether you left it
   open, under "hawk.fold.<key>" — the same key the old builder uses, so a
   section you opened there is open here too.

   Default is shut. A match page carries eight sections and most visits want
   two of them; opening all of them by default is how the page got long
   enough to need this in the first place.
   =========================================================================== */
(() => {
  "use strict";

  const KEY = (k) => `hawk.fold.${k}`;
  const read = (k, dflt) => {
    try {
      const v = localStorage.getItem(KEY(k));
      return v == null ? dflt : JSON.parse(v);
    } catch { return dflt; }
  };
  const write = (k, v) => { try { localStorage.setItem(KEY(k), JSON.stringify(v)); } catch { /* private window */ } };

  function restore(root = document) {
    for (const d of root.querySelectorAll("details.fold[data-fold]")) {
      if (d.dataset.foldReady) continue;
      d.dataset.foldReady = "1";
      d.open = read(d.dataset.fold, d.hasAttribute("data-open-default"));
      d.addEventListener("toggle", () => write(d.dataset.fold, d.open));
    }
  }

  restore();
  // sections are revealed as their data arrives, so pick up new ones too
  if (window.MutationObserver) {
    new MutationObserver(() => restore()).observe(document.documentElement,
      { childList: true, subtree: true });
  }

  window.HAWKFold = { restore, read, write };
})();
