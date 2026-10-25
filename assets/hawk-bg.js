/* ===========================================================================
   The hero canvas: a field of points at different depths drifting past one
   soft light that moves on a slow cycle.

   It is drawn rather than faked with CSS gradients, which is the one thing a
   stylesheet genuinely cannot do and the reason three earlier attempts read
   as flat however much glow went on them.

   Strictly additive. The hero's own gradients are a finished picture, so if
   this never runs — no canvas, reduced motion, a thrown error — nothing is
   missing from the page.

   Usage: put <canvas> inside an element with class "hero". Nothing else.
   =========================================================================== */
(() => {
  "use strict";

  const cv = document.querySelector(".hero canvas");
  if (!cv || !cv.getContext) return;
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let ctx;
  try { ctx = cv.getContext("2d", { alpha: true }); } catch { return; }
  if (!ctx) return;

  let w = 0, h = 0, pts = [], raf = 0, t = 0;

  function size() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect();
    w = Math.max(1, r.width); h = Math.max(1, r.height);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // density follows area, so a phone never draws a desktop's worth of points
    const n = Math.round(Math.min(150, Math.max(40, (w * h) / 11000)));
    pts = Array.from({ length: n }, () => {
      const z = Math.random();                 // 0 far, 1 near
      return { x: Math.random() * w, y: Math.random() * h, z,
               r: 0.5 + z * 1.6, s: 0.05 + z * 0.22,
               g: Math.random() < 0.28 };      // roughly a quarter carry the gold
    });
  }

  function frame() {
    t += 0.0022;
    ctx.clearRect(0, 0, w, h);

    // the key light, well behind the points
    const lx = w * (0.5 + 0.26 * Math.cos(t)), ly = h * (0.32 + 0.14 * Math.sin(t * 0.8));
    const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, Math.max(w, h) * 0.5);
    g.addColorStop(0, "rgba(107,143,224,.16)");
    g.addColorStop(0.55, "rgba(107,143,224,.05)");
    g.addColorStop(1, "rgba(107,143,224,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    for (const p of pts) {
      // nearer points drift faster. That difference IS the depth; one speed
      // for all of them reads as dust on the lens.
      p.x -= p.s; p.y -= p.s * 0.45;
      if (p.x < -4) { p.x = w + 4; p.y = Math.random() * h; }
      if (p.y < -4) { p.y = h + 4; p.x = Math.random() * w; }
      const a = 0.12 + p.z * 0.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.g ? `rgba(242,219,164,${a})` : `rgba(230,236,250,${a * 0.8})`;
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }

  function stop() { cancelAnimationFrame(raf); raf = 0; }
  function go() { if (!raf) frame(); }

  let rt = 0;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(size, 180); });
  // nothing is worth drawing while the tab is hidden
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : go()));

  size();
  cv.classList.add("on");
  go();
})();
