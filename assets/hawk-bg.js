/* ===========================================================================
   The hero canvas.

   TWO drawings, chosen by the canvas itself:

     <canvas>                    the drifting points — the default, everywhere
     <canvas data-bg="ground">   the Bernabéu from overhead — Home only

   Home gets the ground and no other page does, on purpose. The rule the
   rebuild keeps proving is ONE loud moment and then quiet: the same stadium
   behind the Vault, the Board, Today and Scores is not eight times as good,
   it is wallpaper, and by the third page you have stopped seeing it. Any page
   can have it by adding the attribute, and that is the only change needed.

   Both are drawn rather than faked with CSS gradients, which is the one thing
   a stylesheet genuinely cannot do and the reason three earlier attempts read
   as flat however much glow went on them.

   Strictly additive, and that is a contract, not a nicety: the hero's own
   gradients are a finished picture, so neither drawing paints a background of
   its own. If this never runs — no canvas, reduced motion, a thrown error —
   nothing is missing from the page.

   NOTHING HERE IS DATA. The lit stands are decoration on a timer. They are
   not tonight's matches and they must never be made to look like they are:
   a page that appears to show live football while showing a random number
   generator is worse than a page that shows nothing.
   =========================================================================== */
(() => {
  "use strict";

  const cv = document.querySelector(".hero canvas");
  if (!cv || !cv.getContext) return;
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let ctx;
  try { ctx = cv.getContext("2d", { alpha: true }); } catch { return; }
  if (!ctx) return;

  const MODE = cv.dataset.bg === "ground" ? "ground" : "points";
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

  /* ======================================================= the drifting points
     The original, unchanged. It is the default because it is quiet. */
  function points() {
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
  }

  /* ========================================================= THE GROUND
     Looking down into the bowl: the pitch, three tiers stepping back from
     it, the gangways that cut them into stands, and the roof ring over the
     top.

     PLAN, THEN PERSPECTIVE. Everything is built flat first — a plan, the
     drawing an architect works on — and then put into perspective by one
     function. That is the whole trick, and it is not decoration: draw the
     rings by eye and they drift out of true with each other, and the moment
     they do it stops reading as a building and starts reading as stripes.

     Plan space is x across (-1..1), y from far (-1) to near (+1), and a
     height above the pitch. The footprint is a superellipse, which is what a
     rounded rectangle actually is — the Bernabéu is not an oval and it is
     not a box, it is this.

     The projection is one over depth: the near side spreads wide and drops,
     the far side draws in and lifts, and height pushes UP more the nearer it
     is, which is what tells your eye the roof is above the seats rather than
     beside them.
     ===================================================================== */
  const AX = 1.00, AY = 0.63;        // the plan is wider than it is deep
  const SQ = 2 / 3.0;                // superellipse — how square the corners are
  // five radii and three heights. Change one and the ground changes, and
  // nothing else in the drawing does.
  const R = { pitchIn: 0.50, lowOut: 0.67, upOut: 0.86, roofIn: 0.88, roofOut: 1.07 };
  const H = { low: 0.030, up: 0.082, roof: 0.140 };
  const BLOCKS = 14;

  const stands = Array.from({ length: BLOCKS }, (_, i) => ({
    i, on: i % 4 === 1, lit: 0, phase: Math.random() * 7,
  }));
  let warm = 0;
  // the stands that are lit change slowly. On a timer, NOT on football.
  setInterval(() => {
    const b = stands[Math.floor(Math.random() * BLOCKS)];
    if (!b.on) { b.on = true; b.lit = 1; } else { warm = 1; b.lit = 1; }
  }, 4200);

  let V = null;
  function view() {
    /* The depth is sized off the WIDTH, not the height. Home's hero is a
       min-height, so on a tall screen it can run past 1000px — and a ground
       scaled to that fills the whole page and turns the headline into a
       caption on a photograph. Tying it to the width keeps the building the
       same size whatever the hero does, and the extra height becomes sky.
       It sits low, too, so the top-left corner stays clear for the words. */
    /* Off to the RIGHT on a wide screen. The hero's words are a left-hand
       column, and a centred ground puts the pitch and the roof ring directly
       behind the sentence the whole site is built to say. Moving the
       building out of the text's way is worth more than any amount of
       dimming it. On a narrow screen there is no column to clear, so it
       goes back to the middle. */
    const cx = w * (w > 860 ? 0.63 : 0.5), cy = h * 0.58;
    const RX = w * 0.370, RY = Math.min(h * 0.425, w * 0.235), HZ = RY;
    // 0.79 deep at the back, 1.37 at the front
    const P = (px, py, hg) => {
      const f = 1 / (1 - 0.27 * py);
      return [cx + px * RX * f, cy + (py * RY - hg * HZ) * f];
    };
    return { P, cx, cy };
  }
  // a point on the footprint at angle t and plan radius r
  const sp = (a, r) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [Math.sign(c) * Math.pow(Math.abs(c), SQ) * r * AX,
            Math.sign(s) * Math.pow(Math.abs(s), SQ) * r * AY];
  };
  // resolution follows width: a phone does not need a desktop's ring
  const steps = () => (w < 620 ? 64 : 120);
  function arc(r, hg, from, to, N) {
    const out = [];
    for (let i = 0; i <= N; i++) {
      const p = sp(from + (to - from) * (i / N), r);
      out.push(V.P(p[0], p[1], hg));
    }
    return out;
  }
  const ring = (r, hg, N) => arc(r, hg, 0, Math.PI * 2, N || steps());
  const trace = (p) => {
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.closePath();
  };
  const line = (p) => {
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
  };
  function annulus(outer, inner, fill) {
    ctx.beginPath(); trace(outer); trace(inner);
    ctx.fillStyle = fill; ctx.fill("evenodd");
  }

  function ground() {
    V = view();
    if (warm > 0.001) warm *= 0.962;
    /* The whole building, held back. Every alpha inside was tuned on a page
       where the ground WAS the picture; here it is behind the one sentence
       the site exists to say. One multiplier is better than re-tuning thirty
       numbers, and it keeps the standalone drawing and this one in step. */
    ctx.globalAlpha = 0.62;

    // the city it stands in. Not buildings — just the fact that there are
    // lights out there, which is what stops the ground floating in space.
    for (let i = 0; i < 80; i++) {
      const a = i * 2.399, rr = 0.48 + ((i * 37) % 100) / 100 * 0.60;
      const bright = 0.02 + ((i * 13) % 7) / 7 * 0.05;
      ctx.fillStyle = `rgba(226,232,255,${bright.toFixed(3)})`;
      ctx.fillRect(V.cx + Math.cos(a) * rr * w * 0.80, V.cy + Math.sin(a) * rr * h * 0.82, 1.7, 1.7);
    }

    const rings = {
      pitchIn: ring(R.pitchIn, H.low), lowOut: ring(R.lowOut, H.low),
      upOut: ring(R.upOut, H.up), roofIn: ring(R.roofIn, H.roof),
      roofOut: ring(R.roofOut, H.roof), foot: ring(R.roofOut, -0.02),
    };

    // the outside wall, from the roof's edge down to the street
    ctx.beginPath(); trace(rings.roofOut); trace(rings.foot);
    const wall = ctx.createLinearGradient(0, V.cy, 0, h);
    wall.addColorStop(0, "rgba(16,18,26,0.98)"); wall.addColorStop(1, "rgba(8,9,13,1)");
    ctx.fillStyle = wall; ctx.fill("evenodd");

    /* Outer ring first, inner over it. That is right for the FAR side, which
       is most of what you can see from up here. The near roof gets painted
       back on at the end, because one z-order cannot do both halves of a
       bowl: over there the tiers are in front of the roof, over here the
       roof is in front of the tiers. */
    const upper = ctx.createLinearGradient(0, V.cy - h * 0.3, 0, V.cy + h * 0.34);
    upper.addColorStop(0, "rgba(26,32,52,0.96)"); upper.addColorStop(1, "rgba(16,20,34,0.98)");
    annulus(rings.roofIn, rings.upOut, "rgba(12,14,22,0.96)");
    annulus(rings.upOut, rings.lowOut, upper);
    const lower = ctx.createLinearGradient(0, V.cy - h * 0.2, 0, V.cy + h * 0.3);
    lower.addColorStop(0, "rgba(33,41,66,0.97)"); lower.addColorStop(1, "rgba(22,27,46,0.98)");
    annulus(rings.lowOut, rings.pitchIn, lower);

    // the rows. Three faint rings per tier: your eye reads "seating" from
    // the repetition, never from the count.
    ctx.lineWidth = 1;
    for (const [a, b, n] of [[R.pitchIn, R.lowOut, 3], [R.lowOut, R.upOut, 4]]) {
      for (let i = 1; i <= n; i++) {
        const r = a + (b - a) * (i / (n + 1));
        const hg = H.low + (H.up - H.low) * ((r - R.pitchIn) / (R.upOut - R.pitchIn));
        ctx.beginPath(); trace(ring(r, hg, Math.round(steps() * 0.75)));
        ctx.strokeStyle = "rgba(226,232,255,0.045)"; ctx.stroke();
      }
    }

    // the gangways that cut the bowl into stands, and the lit ones
    for (const b of stands) {
      const t0 = (b.i / BLOCKS) * Math.PI * 2, t1 = ((b.i + 1) / BLOCKS) * Math.PI * 2;
      if (b.lit > 0.01) b.lit *= 0.972;
      const glow = b.on ? 0.075 + 0.05 * Math.sin(t * 1.7 + b.phase) + b.lit * 0.35 : 0;
      if (glow > 0.005) {
        ctx.beginPath();
        line(arc(R.upOut, H.up, t0, t1, 12));
        for (const p of arc(R.pitchIn, H.low, t1, t0, 12)) ctx.lineTo(p[0], p[1]);
        ctx.closePath();
        ctx.fillStyle = `rgba(242,219,164,${glow.toFixed(3)})`; ctx.fill();
      }
      const s0 = sp(t0, 1);
      const p0 = V.P(s0[0] * R.pitchIn, s0[1] * R.pitchIn, H.low);
      const p1 = V.P(s0[0] * R.upOut, s0[1] * R.upOut, H.up);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
      ctx.strokeStyle = "rgba(8,9,13,0.75)"; ctx.lineWidth = 2.2; ctx.stroke();
    }

    // ----------------------------------------------------------- the pitch
    const PX = 0.435, PY = 0.268;
    const pit = (x, y) => V.P(x, y, 0);
    ctx.beginPath(); trace([pit(-PX, -PY), pit(PX, -PY), pit(PX, PY), pit(-PX, PY)]);
    ctx.save(); ctx.clip();
    const grass = ctx.createLinearGradient(0, V.cy - h * 0.2, 0, V.cy + h * 0.2);
    grass.addColorStop(0, "#15351f"); grass.addColorStop(1, "#102a19");
    ctx.fillStyle = grass; ctx.fillRect(0, 0, w, h);
    // the mowing: the one thing that says football rather than concrete
    for (let i = 0; i < 10; i += 2) {
      const a = -PX + (i / 10) * PX * 2, b = -PX + ((i + 1) / 10) * PX * 2;
      ctx.beginPath(); trace([pit(a, -PY), pit(b, -PY), pit(b, PY), pit(a, PY)]);
      ctx.fillStyle = "rgba(255,255,255,0.035)"; ctx.fill();
    }
    ctx.strokeStyle = "rgba(236,244,238,0.30)"; ctx.lineWidth = 1.4;
    const box = (x0, x1, y0, y1) => {
      ctx.beginPath(); trace([pit(x0, y0), pit(x1, y0), pit(x1, y1), pit(x0, y1)]); ctx.stroke();
    };
    box(-PX * 0.97, PX * 0.97, -PY * 0.94, PY * 0.94);
    ctx.beginPath();
    ctx.moveTo(...pit(0, -PY * 0.94)); ctx.lineTo(...pit(0, PY * 0.94)); ctx.stroke();
    box(-PX * 0.97, -PX * 0.62, -PY * 0.52, PY * 0.52);
    box(PX * 0.62, PX * 0.97, -PY * 0.52, PY * 0.52);
    ctx.beginPath();
    for (let i = 0; i <= 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const p = pit(Math.cos(a) * PX * 0.165, Math.sin(a) * PY * 0.265);
      i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
    }
    ctx.stroke();
    const fl = ctx.createRadialGradient(V.cx, V.cy, 0, V.cx, V.cy, w * 0.34);
    fl.addColorStop(0, `rgba(240,248,255,${(0.10 + 0.02 * Math.sin(t * 1.4) + warm * 0.14).toFixed(3)})`);
    fl.addColorStop(1, "rgba(240,248,255,0)");
    ctx.fillStyle = fl; ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // ------------------------------------------------------------ the roof
    const roofFill = () => {
      const g = ctx.createLinearGradient(0, V.cy - h * 0.34, 0, V.cy + h * 0.42);
      /* A QUARTER of what the standalone drawing used. There it was the
         picture; here it is behind a headline, and a white ring at 0.84 does
         not sit behind anything — it reads as the subject and the words read
         as a caption. */
      g.addColorStop(0, "rgba(196,204,222,0.13)");
      g.addColorStop(0.55, "rgba(222,229,244,0.19)");
      g.addColorStop(1, "rgba(238,244,255,0.24)");
      return g;
    };
    annulus(rings.roofOut, rings.roofIn, roofFill());
    ctx.lineWidth = 1.1;
    for (let i = 0; i < 40; i++) {                        // the ribs over it
      const s = sp((i / 40) * Math.PI * 2, 1);
      const a = V.P(s[0] * R.roofIn, s[1] * R.roofIn, H.roof);
      const b = V.P(s[0] * R.roofOut, s[1] * R.roofOut, H.roof);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = "rgba(60,66,86,0.40)"; ctx.stroke();
    }
    const gold = `rgba(242,219,164,${(0.28 + warm * 0.45).toFixed(3)})`;
    ctx.beginPath(); trace(rings.roofIn);
    ctx.strokeStyle = gold; ctx.lineWidth = 2 + warm * 2.4; ctx.stroke();

    // the near half of the roof, painted back on — see the note above
    const N = Math.round(steps() * 0.55);
    const nOut = arc(R.roofOut, H.roof, 0.06, Math.PI - 0.06, N);
    const nIn = arc(R.roofIn, H.roof, Math.PI - 0.06, 0.06, N);
    ctx.beginPath(); trace(nOut.concat(nIn));
    ctx.fillStyle = roofFill(); ctx.fill();
    ctx.beginPath(); line(nIn);
    ctx.strokeStyle = gold; ctx.lineWidth = 2 + warm * 2.4; ctx.stroke();

    // the night closing back in, so it sits in the page rather than on it.
    // At full strength — the holding back above is for the building only.
    ctx.globalAlpha = 1;
    const vig = ctx.createRadialGradient(V.cx, V.cy, w * 0.22, V.cx, V.cy, w * 0.74);
    vig.addColorStop(0, "rgba(7,7,10,0)"); vig.addColorStop(1, "rgba(7,7,10,0.72)");
    ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
  }

  function frame() {
    t += MODE === "ground" ? 0.010 : 0.0022;
    /* The hero's height is a clamp(), so the box can still be settling when
       this first runs. Measuring once and trusting it drew the whole ground
       into a 40px sliver down the left-hand side. */
    if (w < 2 || h < 2) size();
    ctx.clearRect(0, 0, w, h);
    if (MODE === "ground") ground(); else points();
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
