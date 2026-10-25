/* ===========================================================================
   Folding sections.

   Any <details class="fold" data-fold="key"> remembers whether you left it
   open, under "hawk.fold.<key>" — the same key the old builder uses, so a
   section you opened there is open here too.

   Default is shut, unless the section carries data-open-default. A match
   page has eight sections and most visits want two of them; opening all of
   them is how the page got long enough to need this in the first place. The
   lineups are the exception — they are the thing you check first.
   =========================================================================== */
(() => {
  "use strict";

  const KEY = (k) => `hawk.fold.${k}`;

  /* ONE-TIME: let a NEW default actually reach someone who already has a
     stored choice. The lineups were shut by default until today, so anyone
     who collapsed them — or simply visited while that was the default and
     toggled something — carries a stored false that would outlive the change
     and make "open by default" do nothing on the only machine that matters.
     Cleared once; from here their own choice is remembered again as normal. */
  try {
    if (localStorage.getItem("hawk.fold.v") !== "2") {
      localStorage.removeItem("hawk.fold.lineups");
      localStorage.removeItem("hawk.fold.ipLineups");
      localStorage.setItem("hawk.fold.v", "2");
    }
  } catch { /* private window: the defaults below apply anyway */ }
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
