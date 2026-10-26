/* ===========================================================================
   ALERTS — the only part of HAWK that is allowed to interrupt you.

   It watches the matches you follow and says, on your screen and on your
   phone: a goal went in (or came back off), someone was sent off, a leg of
   your bet landed or died, you are down to one leg, half-time, full time.

   A match you have a pending bet on is ALWAYS followed. You never have to
   remember to turn anything on for the matches that cost you money.

   -------------------------------------------------------------------------
   WHAT THIS IS NOT

   Everything the old builder alerts on is here: goals through both feeds,
   goals taken off, red cards, lineups confirmed, your bet leg by leg,
   half-time, full time — and a bet that can no longer land is settled as
   LOST in the Vault the moment that is certain, not at full time.

   Two things in the old builder are NOT alerts and are not here: the
   background value scan (half-time tips), and striking the dead legs on
   the slip in front of you when the XIs land. Both belong to the builder.
   =========================================================================== */
/* ---------------------------------------------------------------------------
   THE ONE THING THIS FILE WRITES

   settleLost(). A leg that is gone is gone, and a bet carrying it cannot
   come back — so it is marked LOST in the Vault there and then, which is
   what stops it haunting your running bets, the 🎟 on Scores, and these
   alerts for the next two hours. It is the old builder's rule exactly: the
   same leg has to read "lost" on two consecutive checks, ten seconds or
   more apart, so one bad frame of data cannot do it.

   No money moves. The stake came off your bankroll when the bet was
   logged, and a losing bet returns nothing — the Vault's own settle does
   the same. Nothing else in this file writes to hawk_bets.
   --------------------------------------------------------------------------- */
(() => {
  "use strict";
  if (window.HAWKAlerts) return;

  /* ------------------------------------------------------------- plumbing */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const pct = (p, dp = 0) => (Number.isFinite(p) ? `${(100 * p).toFixed(dp)}%` : "—");
  const odds = (x) => (x > 0 && Number.isFinite(x) ? (+x).toFixed(2) : "—");
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : /(ch|sh|s|x|z)$/.test(w) ? "es" : "s"}`;
  const loadPref = (k, f) => { try { const v = localStorage.getItem(k); return v === null ? f : JSON.parse(v); } catch { return f; } };
  const savePref = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private */ } };
  const vaultBets = () => { try { const b = JSON.parse(localStorage.getItem("hawk_bets") || "[]"); return Array.isArray(b) ? b : []; } catch { return []; } };
  const pad = (n) => String(n).padStart(2, "0");
  const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const phone = () => matchMedia("(max-width:560px)").matches;
  const E = () => window.HAWK;

  // The page's own title, so flashing one and putting it back is possible. Read
  // again each time a flash starts, because the in-play page rewrites its own
  // title with the score — putting back the one from page load would freeze it
  // at kick-off.
  let TITLE = document.title;

  // The heartbeat is the fast lane's: Unibet every 5 s, 365Scores every
  // other beat, lineups once a minute.
  const FAST_MS = 5 * 1000;
  // A phone shows one card at a time over what you are reading, so it gets out
  // of the way sooner; on a PC they sit in the corner and can linger.
  const SHOW_MS = phone() ? 8000 : 15000;
  const FOLLOW_MS = 3 * 3600e3;
  const LOG_KEEP = 20;

  /* =================================================== the two-feed rules
     Kept from the old builder verbatim in behaviour, because they were
     earned the hard way: two feeds reporting the same match never agree by
     the second, and comparing one against the other made the pair flip-flop
     and alert on every poll.

       · each feed is compared only against its OWN last reading
       · a goal coming off has to be seen twice by the same feed
       · the same change is never announced twice within ten minutes

     One correction. The old rule "another feed already announced this score
     move, so this is lag catching up" did not record WHICH feed announced
     it — and with a single feed, as here, that turned a real VAR disallow
     inside three minutes into silence: 1–0 then 0–0 looks exactly like the
     lag it was written to ignore. The feed is recorded now and the guard
     only fires across feeds, which is the only case it was ever for. */
  const GOAL_OFF_CONFIRM_MS = 3 * 60e3, GOAL_SAID_MS = 10 * 60e3;
  const scoreKey = (s) => `${s[0]}-${s[1]}`;

  const G = {
    on: loadPref("hawk.goalAlerts", true),
    last: {}, src: {}, said: {}, pending: {}, games: [], busy: false,
    // the fast lane's last reading per match, and whether Unibet's score for
    // it has ever agreed with 365Scores (see fastGoals)
    fast: {}, ok: {},
    // what has been announced, and when — persisted, so two HAWK tabs open at
    // once do not both beep at you for the same goal
    told: loadPref("hawk.goalTold", {}),
  };
  function tellTold(move, at) {
    G.told[move] = at;
    const cut = at - GOAL_SAID_MS;
    for (const k of Object.keys(G.told)) if (G.told[k] < cut) delete G.told[k];
    savePref("hawk.goalTold", G.told);
  }

  function goalMove(src, id, now, clock) {
    const key = `${src}|${id}`, was = G.src[key], at = Date.now();
    const take = () => { G.src[key] = now; delete G.pending[key]; };
    if (!was) { take(); return null; }                              // first look: just remember it
    if (was[0] === now[0] && was[1] === now[1]) { delete G.pending[key]; return null; }
    const side = now[0] > was[0] ? "home" : now[1] > was[1] ? "away"
               : now[0] < was[0] ? "home-off" : now[1] < was[1] ? "away-off" : null;
    if (!side) { take(); return null; }
    const move = `${id}|${scoreKey(was)}>${scoreKey(now)}`;
    // Another feed has already announced this move and this one is reporting
    // the score it has moved on from: lag, not a goal being taken off.
    const said = G.said[id];
    if (said && said.src !== src && at - said.at < GOAL_OFF_CONFIRM_MS && said.from === scoreKey(now)) { take(); return null; }
    // Believe a goal off only when the same feed still says so on its next
    // look — so the reading is not committed until then. That is "seen twice".
    if (side.endsWith("-off")) {
      const p = G.pending[key];
      if (!p || p.move !== move) { G.pending[key] = { move, at }; return null; }
    }
    take();
    const told = G.told[move];
    if (told && at - told < GOAL_SAID_MS) return null;              // said that already
    tellTold(move, at);
    G.said[id] = { from: scoreKey(was), to: scoreKey(now), at, src };
    return { side, clock };
  }

  /* ============================================= which matches are followed
     A bet on it beats everything: you cannot turn those alerts off, and you
     do not have to turn them on. A match you followed by hand lasts three
     hours, and a lineup alert set in the old builder counts too. */
  function pendingBetsOn(gameId) {
    return vaultBets().filter((b) => b.status === "PENDING"
      && (b.legs || []).some((l) => l && l.hawk && String(l.hawk.game) === String(gameId)));
  }
  // A match on the in-play page in front of you is followed while you are
  // there, without being asked — but that is not the same as having turned its
  // alerts on, and the button has to say which of the two it is.
  const lookingAt = (id) => /\/live\/?$/.test(location.pathname)
    && new URLSearchParams(location.search).get("id") === String(id);
  function followState(id) {
    const f = loadPref("hawk.goalFollow", {})[String(id)];
    const mine = pendingBetsOn(id).length > 0;
    return { on: mine || (!!f && Date.now() - Date.parse(f) < FOLLOW_MS), bet: mine, here: lookingAt(id) };
  }
  async function toggleFollow(id) {
    const st = followState(id);
    if (st.bet) { notice({ icon: "🔔", word: "Already on", text: "You have a bet on this match — its alerts stay on.", tone: "info" }); return st; }
    const follow = loadPref("hawk.goalFollow", {});
    if (st.on) {
      delete follow[String(id)];
      savePref("hawk.goalFollow", follow);
      notice({ icon: "🔕", word: "Alerts off", tone: "info",
        text: lookingAt(id) ? "Goals still show while this page is open, and stop when you leave it."
                            : "Nothing more from this match." });
    } else {
      follow[String(id)] = new Date().toISOString();
      savePref("hawk.goalFollow", follow);
      if (!G.on) { G.on = true; savePref("hawk.goalAlerts", true); }
      await askPermission();
      notice({ icon: "🔔", word: "Alerts on", text: "Goals, red cards and your bet on this match"
        + (canNotify() ? ", on your screen even when HAWK is in the background." : "."), tone: "good" });
      check();
    }
    paintBell();
    document.dispatchEvent(new CustomEvent("hawk:follow", { detail: { id: String(id) } }));
    return followState(id);
  }
  function followedGames() {
    const ids = new Set();
    for (const b of vaultBets())
      if (b.status === "PENDING")
        for (const l of b.legs || []) if (l && l.hawk && l.hawk.game) ids.add(String(l.hawk.game));
    // a lineup alert follows the match for goals too — set here or in v1
    for (const w of watchList()) if (w && w.id != null) ids.add(String(w.id));
    const follow = loadPref("hawk.goalFollow", {}), now = Date.now();
    let changed = false;
    for (const [id, ko] of Object.entries(follow)) {
      if (now - Date.parse(ko) < FOLLOW_MS) ids.add(id);
      else { delete follow[id]; changed = true; }
    }
    if (changed) savePref("hawk.goalFollow", follow);
    // the match you are looking at right now, on the in-play page
    if (/\/live\/?$/.test(location.pathname)) {
      const here = new URLSearchParams(location.search).get("id");
      if (here) ids.add(String(here));
    }
    return ids;
  }

  /* ===================================================== lineup alerts
     "Both XIs are confirmed" — the one alert that happens BEFORE a match,
     and the only one worth being woken by, because it is the last moment a
     build is still worth making.

     The difficult half is already done elsewhere: engine.js's lineups()
     asks ESPN as well, because 365Scores marks a predicted XI "Confirmed"
     a day out and quietly downgrades it later. All this does is ask, and
     say so once.

     The list is v1's own key and v1's own entry shape, so an alert set in
     the old builder fires here and one set here fires there. */
  const WATCH_KEY = "hawk.lineupWatch";
  function watchList() { const v = loadPref(WATCH_KEY, []); return Array.isArray(v) ? v : []; }
  const isWatched = (id) => watchList().some((w) => String(w.id) === String(id));
  async function toggleWatch(g) {
    const list = watchList(), on = isWatched(g.id);
    if (on) {
      savePref(WATCH_KEY, list.filter((w) => String(w.id) !== String(g.id)));
      notice({ icon: "🔕", word: "Alert off", tone: "info",
               text: `${g.home} v ${g.away} — nothing when the lineups land.` });
    } else {
      savePref(WATCH_KEY, [...list, { id: String(g.id), league: g.league, home: g.home, away: g.away }]);
      if (!G.on) { G.on = true; savePref("hawk.goalAlerts", true); }
      await askPermission();
      notice({ icon: "🔔", word: "Alert on", tone: "good",
               text: `${g.home} v ${g.away} — the moment both XIs are confirmed, then its goals.`
                   + (canNotify() ? "" : " Keep a HAWK tab open; this browser is not allowing notifications.") });
      checkLineups();
    }
    paintBell();
    document.dispatchEvent(new CustomEvent("hawk:follow", { detail: { id: String(g.id) } }));
  }
  /* A PENDING BET IS A LINEUP WATCH, without being asked.
     It already means the goals are followed (followedGames above). It did NOT
     mean the XIs were, and the bell refused to add one — toggleFollow returns
     early on a bet — so the matches where a confirmed XI matters MOST were the
     only ones you could not be told about. A player leg dies the moment the
     teams land, and that is the last point you can do anything about it.

     Derived, not stored: a bet placed on any page counts the moment it exists,
     and nothing has to be cleaned up when it settles. Only before kick-off —
     after that there is no lineup left to wait for. */
  function betWatches() {
    const out = new Map();
    for (const b of vaultBets()) {
      if (b.status !== "PENDING") continue;
      for (const l of b.legs || []) {
        const h = l && l.hawk;
        if (!h || !h.game) continue;
        const ko = Date.parse(h.kickoff || "");
        if (Number.isFinite(ko) && ko < Date.now()) continue;        // already under way
        out.set(String(h.game), { id: String(h.game), league: h.league, home: h.home, away: h.away });
      }
    }
    return [...out.values()];
  }

  let lineupBusy = false;
  async function checkLineups() {
    const list = watchList();
    // the hand-set watches, plus every match you have money on
    const seen = new Set(list.map((w) => String(w.id)));
    const all = [...list, ...betWatches().filter((w) => !seen.has(w.id))];
    if (!G.on || lineupBusy || !all.length || !E() || !E().lineups) return;
    lineupBusy = true;
    try {
      let keep = list, changed = false;
      for (const w of all) {
        let st = null;
        try { st = await E().lineups(w.id); } catch { continue; }   // ask again next time
        if (!st || !(st.confirmed || st.started)) continue;
        // Once the XIs are in — or the match has started without them — the
        // lineup alert is done. Goals keep coming for the next three hours.
        // Only a HAND-SET watch has anything to remove; a bet-derived one is
        // computed fresh each pass, and firstTime() below stops it repeating.
        if (seen.has(String(w.id))) {
          keep = keep.filter((x) => String(x.id) !== String(w.id));
          changed = true;
        }
        const follow = loadPref("hawk.goalFollow", {});
        follow[String(w.id)] = new Date().toISOString();
        savePref("hawk.goalFollow", follow);
        if (st.confirmed && firstTime(`xi|${w.id}`))
          card({ tone: "warn", icon: "🔔", word: "LINEUPS IN", clock: "XI",
                 href: `../match/?league=${encodeURIComponent(w.league || "")}&id=${encodeURIComponent(w.id)}`,
                 g: { id: w.id, league: w.league, home: w.home, away: w.away, score: [null, null], status: 1 },
                 body: `Both XIs are confirmed${st.source === "ESPN" ? " <span>· ESPN had them first</span>" : ""}
                        <br><span>Tap to build it on the real teams</span>` });
      }
      if (changed) { savePref(WATCH_KEY, keep); paintBell(); }
    } finally { lineupBusy = false; }
  }

  /* ================================================= once and only once
     What has been shown is remembered, so a reload does not repeat it — and
     a leg that landed while HAWK was closed still gets its alert when you
     are back. Read back from storage each time, so a second tab (or the old
     builder) does not beep at you for the same thing. */
  const SEEN_KEY = "hawk.alertSeen";
  function seen() { const v = loadPref(SEEN_KEY, []); return Array.isArray(v) ? v : []; }
  function firstTime(key) {
    const list = seen();
    if (list.includes(key)) return false;
    list.push(key);
    savePref(SEEN_KEY, list.slice(-500));
    return true;
  }
  const alreadySeen = (key) => seen().includes(key);

  /* ======================================================== the alert cards */
  let box = null;
  function host() {
    if (box && box.isConnected) return box;
    box = document.createElement("div");
    box.className = "alerts";
    box.setAttribute("aria-live", "polite");
    document.body.appendChild(box);
    return box;
  }
  // A phone shows one card at a time (the rest are hidden in CSS), so a card
  // must not start its countdown until it is the one on screen — otherwise an
  // alert times out behind another and you get the beep with nothing to look
  // at. On a PC they stack and each runs its own clock.
  function start(card) {
    if (card.dataset.timing) return;
    card.dataset.timing = "1";
    const go = () => {
      setTimeout(() => card.classList.add("bye"), SHOW_MS);
      setTimeout(() => { card.remove(); tick(); }, SHOW_MS + 500);
    };
    // away from HAWK when it fired? the card waits for you to come back
    if (document.hidden) document.addEventListener("visibilitychange", function once() {
      if (!document.hidden) { document.removeEventListener("visibilitychange", once); go(); }
    });
    else go();
  }
  function tick() {
    if (!box) return;
    if (phone()) { if (box.firstElementChild) start(box.firstElementChild); }
    else [...box.children].forEach(start);
  }
  function add(card) {
    const b = host();
    // phone: queued behind whatever is showing, so they arrive in order.
    // PC: newest on top of the stack.
    if (phone()) b.appendChild(card); else b.prepend(card);
    const cap = phone() ? 6 : 3;
    // never yank the card being read: on a phone the oldest one still waiting goes
    while (b.children.length > cap) (phone() ? b.children[1] : b.lastElementChild).remove();
    tick();
  }

  // Everything HAWK has beeped about, kept so a card you miss is still
  // readable afterwards under the bell. Last 20, oldest dropped.
  function logAlert(icon, word, text) {
    const list = loadPref("hawk.alertLog", []);
    list.unshift({ icon, word, text: String(text || "").replace(/\s+/g, " ").trim().slice(0, 160), at: Date.now() });
    savePref("hawk.alertLog", list.slice(0, LOG_KEEP));
    paintBell();
  }
  const ago = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`; };

  const liveHref = (g) => `../live/?league=${encodeURIComponent(g.league || "")}&id=${encodeURIComponent(g.id)}`;
  const matchHref = (g) => `../match/?league=${encodeURIComponent(g.league || "")}&id=${encodeURIComponent(g.id)}`;

  function card({ tone = "good", icon, word, g, clock, body, bet, href, hit, voice }) {
    const el = document.createElement("div");
    el.className = `ac t-${tone}`;
    el.style.setProperty("--acms", `${SHOW_MS}ms`);
    const crest = (k) => (g && g[k + "Crest"]
      ? `<img src="${esc(g[k + "Crest"])}" alt="" onerror="this.style.visibility='hidden'">` : "");
    const score = g && g.score && g.score[0] != null ? `${g.score[0]}<i>–</i>${g.score[1]}` : "<i>·</i>";
    el.innerHTML = `<button class="x" aria-label="Close">✕</button>
      <div class="t"><span class="i">${icon}</span><span class="w">${esc(word)}</span>
        <span class="m">${esc(clock || (g && g.clock) || "")}</span></div>
      ${g ? `<div class="s">
        <span class="tm${hit === "home" ? " hit" : ""}">${crest("home")}<span>${esc(g.home)}</span></span>
        <b>${score}</b>
        <span class="tm a${hit === "away" ? " hit" : ""}"><span>${esc(g.away)}</span>${crest("away")}</span></div>` : ""}
      <div class="b">${body}</div>
      ${bet && bet.p != null ? `<div class="mine">🎟 Your bet: <b>${pct(bet.p, bet.p < 0.1 ? 1 : 0)}</b> to land now${
        bet.ret ? ` · worth ≈ €${(bet.p * bet.ret).toFixed(2)}` : ""}</div>` : ""}
      <div class="bar"><i></i></div>`;
    const go = href || (g ? (g.status === 4 ? matchHref(g) : liveHref(g)) : null);
    el.onclick = (e) => {
      el.remove(); tick();
      if (!e.target.closest(".x") && go) location.href = go;
    };

    const flat = document.createElement("div"); flat.innerHTML = body;
    logAlert(icon, word, g
      ? `${g.home} ${g.score && g.score[0] != null ? `${g.score[0]}-${g.score[1]}` : "v"} ${g.away} · ${flat.textContent}`
      : flat.textContent);
    add(el);
    // `voice` wins when the caller knows something the word does not — a goal
    // is a goal, but only the caller knows whose goal it was good for.
    if (tone !== "info") beep(voice || VOICE_OF[word] || TONE_VOICE[tone] || "won");
    flashTitle(`${icon} ${word}`);
    if (document.hidden || !document.hasFocus())
      systemNotify(`${icon} ${word}${g ? ` · ${g.home} ${g.score && g.score[0] != null ? `${g.score[0]}–${g.score[1]}` : "v"} ${g.away}` : ""}`,
        [flat.textContent, bet && bet.p != null ? `🎟 Your bet: ${pct(bet.p)} to land now` : ""].filter(Boolean).join("\n"),
        { tag: `${word}-${g ? g.id : "hawk"}`, url: go || location.href });
    return el;
  }

  // A notice with no match behind it (alerts turned on, a test).
  function notice({ icon = "🔔", word, text, tone = "good", href }) {
    return card({ tone, icon, word, body: esc(text), href });
  }

  /* ============================================================ the noises
     Every alert used to play the same rising arpeggio, so a goal against you
     and a goal for you sounded identical — and the one you most want to tell
     apart without looking is exactly that pair. Each alert now has its own
     voice. Synthesised rather than shipped as files: six tones that cost
     nothing to download and nothing for the service worker to carry.

     A note is [frequency, startSeconds, lengthSeconds, waveform, loudness,
     bendTo]. Falling means bad, rising means good. */
  const VOICES = {
    /* A GOAL IS A BELL, and a goal taken off is the same bell two octaves
       down, sagging as it rings. They are a PAIR on purpose: one instrument
       saying two things, so the second reads as the first being taken back
       rather than as some unrelated noise arriving.

       The multipliers are 1, 2.76, 5.4, 8.9 — not 1, 2, 3, 4. A struck bell
       is inharmonic, and those ratios are the whole difference between a bell
       and an organ chord. Keep them if either is ever retuned.

       Four partials struck together SUM, so the obvious amplitudes rendered at
       0.58 against every other alert's 0.195 — a goal would have been three
       times louder than a bet winning. Measured offline and scaled to match;
       the RATIOS between the partials are the timbre, so they are preserved
       exactly and only the overall level moved. */
    goal:    [[784, 0, 1.5, "sine", 0.101], [2164, 0, 1.1, "sine", 0.061],
              [4234, 0, 0.7, "sine", 0.034], [6978, 0, 0.45, "sine", 0.017],
              [5000, 0, 0.02, "noise", 0.084]],                   // the hammer

    /* THE SAME BELL, STRUCK TWICE — and which way the second strike goes is
       the whole message. A goal on its own is one strike; a goal that helped
       your bet adds one ABOVE it, one that hurt adds one BELOW.

       This is the pair you could not tell apart before, and it is the pair
       that costs you money: both played the identical sound, so the phone in
       your pocket could tell you a goal had happened and not whose side it
       was on. One strike still means "a goal, and you have nothing on it". */
    goalFor: [[784, 0, 1.2, "sine", 0.080], [2164, 0, 0.9, "sine", 0.048],
              [4234, 0, 0.6, "sine", 0.027], [5000, 0, 0.02, "noise", 0.066],
              [1175, 0.17, 1.3, "sine", 0.080], [3243, 0.17, 0.95, "sine", 0.048],
              [6345, 0.17, 0.6, "sine", 0.027], [5000, 0.17, 0.02, "noise", 0.066]],
    goalAgainst: [[784, 0, 1.2, "sine", 0.080], [2164, 0, 0.9, "sine", 0.048],
              [4234, 0, 0.6, "sine", 0.027], [5000, 0, 0.02, "noise", 0.066],
              [523, 0.17, 1.4, "sine", 0.086], [1443, 0.17, 1.0, "sine", 0.052],
              [2824, 0.17, 0.65, "sine", 0.029], [4000, 0.17, 0.02, "noise", 0.060]],
    // …and the low one bends DOWN as it decays, which is the sag
    goalOff: [[196, 0, 1.88, "sine", 0.109, 0.84], [541, 0, 1.38, "sine", 0.066, 0.84],
              [1058, 0, 0.88, "sine", 0.036, 0.84], [1744, 0, 0.56, "sine", 0.018, 0.84],
              [2500, 0, 0.02, "noise", 0.051]],
    won:     [[523, 0, 0.4, "triangle", 0.2], [659, 0.1, 0.45, "triangle", 0.2],
              [784, 0.2, 0.5, "triangle", 0.2], [1047, 0.3, 0.9, "triangle", 0.18]],
    landed:  [[784, 0, 0.4, "triangle", 0.2], [1047, 0.09, 0.55, "triangle", 0.16]],
    lost:    [[392, 0, 0.5, "triangle", 0.2], [294, 0.18, 0.8, "triangle", 0.18]],
    /* Three voices need more than a list of notes can say, so they are
       FUNCTIONS instead: a whistle needs vibrato on its frequency, a fanfare
       needs a filter sweep per note, and neither fits in a tuple. `len` is
       how long the voice runs, so beep() knows when to let the context go,
       and `gain` is its measured level — see the note on the bell. */
    red: Object.assign((c, t0, out) => {
      // a pea whistle: the rattle IS the vibrato, and without it this is a kettle
      for (const at of [0, 0.28]) {
        const o = c.createOscillator(), g = c.createGain();
        const v = c.createOscillator(), vg = c.createGain();
        o.type = "sine"; o.frequency.value = 2350;
        v.frequency.value = 38; vg.gain.value = 120;
        v.connect(vg); vg.connect(o.frequency);
        o.connect(g); g.connect(out);
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.2, t0 + at + 0.02);
        g.gain.setValueAtTime(0.2, t0 + at + 0.16);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.21);
        o.start(t0 + at); o.stop(t0 + at + 0.22);
        v.start(t0 + at); v.stop(t0 + at + 0.22);
      }
    }, { len: 0.6, gain: 0.98 }),

    won: Object.assign((c, t0, out) => {
      // brass: a sawtooth under a lowpass that opens on the attack and shuts
      [262, 330, 392, 523].forEach((f, i) => {
        const at = i * 0.085, len = i === 3 ? 0.6 : 0.24;
        const o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter();
        o.type = "sawtooth"; o.frequency.value = f;
        lp.type = "lowpass"; lp.Q.value = 0.8;
        lp.frequency.setValueAtTime(f * 2, t0 + at);
        lp.frequency.exponentialRampToValueAtTime(f * 6, t0 + at + 0.06);
        lp.frequency.exponentialRampToValueAtTime(f * 2.5, t0 + at + len);
        o.connect(lp); lp.connect(g); g.connect(out);
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
        o.start(t0 + at); o.stop(t0 + at + len + 0.02);
      });
    }, { len: 1.0, gain: 0.90 }),

    urgent: Object.assign((c, t0, out) => {
      // two notes, three times: an alarm, not a chime. It is meant to nag.
      for (let i = 0; i < 3; i++) {
        for (const [f, off] of [[740, 0], [988, 0.085]]) {
          const o = c.createOscillator(), g = c.createGain();
          o.type = "square"; o.frequency.value = f;
          o.connect(g); g.connect(out);
          const at = i * 0.2 + off;
          g.gain.setValueAtTime(0.0001, t0 + at);
          g.gain.exponentialRampToValueAtTime(0.14, t0 + at + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.085);
          o.start(t0 + at); o.stop(t0 + at + 0.1);
        }
      }
    }, { len: 0.6, gain: 1.42 }),
    warn:    [[587, 0, 0.4, "triangle", 0.2], [494, 0.22, 0.7, "triangle", 0.18]],
    /* The lineups one is the odd job: the only alert that is not news, so it
       is the one sound here that is neither a bell (the pitch) nor a tone
       (your ticket). Three struck wooden bars climbing — the XI going up.

       A struck bar is three things at once: the knock of the mallet, the
       bar's own note, and a partial at 4.1x that dies almost immediately.
       That 4.1 is not a typo and not a harmonic; it is what stops this
       sounding like a flute. */
    tick: Object.assign((c, t0, out) => {
      for (const [f, at] of [[523, 0], [659, 0.1], [784, 0.2]]) {
        for (const [freq, len, peak] of [[f, 0.14, 0.26], [f * 4.1, 0.042, 0.078]]) {
          const o = c.createOscillator(), g = c.createGain();
          o.type = "sine"; o.frequency.value = freq;
          o.connect(g); g.connect(out);
          g.gain.setValueAtTime(0.0001, t0 + at);
          g.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.008);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
          o.start(t0 + at); o.stop(t0 + at + len + 0.02);
        }
        const n = Math.max(1, Math.floor(c.sampleRate * 0.01));
        const b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
        const s = c.createBufferSource(); s.buffer = b;
        const bp = c.createBiquadFilter();
        bp.type = "bandpass"; bp.frequency.value = 2200; bp.Q.value = 1;
        const g = c.createGain(); g.gain.value = 0.14;
        s.connect(bp); bp.connect(g); g.connect(out);
        s.start(t0 + at); s.stop(t0 + at + 0.01);
      }
    }, { len: 0.4, gain: 0.59 }),
  };
  /* Which voice an alert gets, by the word on its card — the cards already
     name themselves and the names are stable, so nothing else has to change
     when a new alert is added: it simply falls back to its tone. */
  const VOICE_OF = {
    "GOAL": "goal", "GOAL OFF": "goalOff", "RED CARD": "red",
    "BET WON": "won", "BET LOST": "lost", "LEG LOST": "lost",
    "LEG LANDED": "landed", "ONE LEG TO GO": "urgent",
    "LINEUPS IN": "tick", "CHECK YOUR BET": "warn",
  };
  const TONE_VOICE = { goal: "goal", good: "won", bad: "lost", warn: "warn" };

  function beep(voice = "won") {
    if (!loadPref("hawk.alertSound", true)) return;
    const notes = VOICES[voice] || VOICES.won;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // A voice that builds itself. Everything goes through one gain so a
      // whole sound can be levelled against the others by a single number.
      if (typeof notes === "function") {
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const out = ctx.createGain();
        out.gain.value = notes.gain || 1;
        out.connect(ctx.destination);
        notes(ctx, ctx.currentTime, out);
        setTimeout(() => { try { ctx.close(); } catch { /* already gone */ } },
                   ((notes.len || 1.5) + 0.3) * 1000);
        return;
      }
      // A tab the user has never clicked cannot play anything; the card and
      // the system notification still do their job, so this stays quiet
      // rather than throwing.
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      /* A note is [frequency, start, length, waveform, loudness, bendTo].
         Two additions for the bell: "noise" is a short filtered burst rather
         than a tone — a hammer striking has no pitch — and `bendTo` slides the
         frequency to a multiple of itself across the note, which is how the
         low bell sags. Everything that does not use them is unaffected. */
      for (const [freq, at, len, type = "sine", peak = 0.3, bend = 0] of notes) {
        const t0 = ctx.currentTime + at;
        if (type === "noise") {
          const n = Math.max(1, Math.floor(ctx.sampleRate * len));
          const b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
          for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
          const s = ctx.createBufferSource(); s.buffer = b;
          const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = freq;
          const gn = ctx.createGain(); gn.gain.value = peak;
          s.connect(hp); hp.connect(gn); gn.connect(ctx.destination);
          s.start(t0); s.stop(t0 + len);
          continue;
        }
        const o = ctx.createOscillator(), gn = ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t0);
        if (bend) o.frequency.exponentialRampToValueAtTime(freq * bend, t0 + len);
        o.connect(gn); gn.connect(ctx.destination);
        gn.gain.setValueAtTime(0.0001, t0);
        gn.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
        o.start(t0); o.stop(t0 + len + 0.02);
      }
      // let the context go once the longest note has finished
      const end = Math.max(...notes.map(([, at, len]) => at + len)) + 0.1;
      setTimeout(() => { try { ctx.close(); } catch { /* already gone */ } }, end * 1000 + 200);
    } catch { /* no audio: the card is still there */ }
  }
  let flashing = null;
  function flashTitle(text) {
    let n = 0;
    // Two alerts at once used to leave two timers fighting over the tab's
    // name. The newest one wins.
    if (flashing) clearInterval(flashing); else TITLE = document.title;
    const t = flashing = setInterval(() => {
      document.title = n % 2 ? TITLE : text;
      if (++n > 20 || (document.hasFocus() && n > 4)) {
        clearInterval(t); if (flashing === t) flashing = null; document.title = TITLE;
      }
    }, 1000);
  }

  const canNotify = () => "Notification" in window && Notification.permission === "granted";
  async function askPermission() {
    if (!("Notification" in window) || Notification.permission !== "default") return canNotify();
    try { await Notification.requestPermission(); } catch { /* refused */ }
    return canNotify();
  }
  async function systemNotify(title, body, { tag, url } = {}) {
    if (!canNotify()) return false;
    const icon = new URL("../icon-192.png", location.href).href;
    const opts = { body, icon, badge: icon, tag, renotify: !!tag,
                   data: { url: url ? new URL(url, location.href).href : location.href } };
    // Phones (Android Chrome, Brave, Samsung Internet) only show notifications
    // through the service worker — "new Notification()" is refused there.
    try {
      const reg = "serviceWorker" in navigator
        ? (await navigator.serviceWorker.getRegistration("../"))
          || await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 3000))])
        : null;
      if (reg && reg.showNotification) { await reg.showNotification(title, opts); return true; }
    } catch { /* fall through */ }
    try {
      const n = new Notification(title, opts);
      n.onclick = () => { window.focus(); if (url) location.href = url; n.close(); };
      return true;
    } catch { return false; }
  }
  // An Android phone will only show a notification through the service worker,
  // so the new pages have to register it as well — otherwise alerts worked on
  // a PC and silently did nothing on the phone until you had opened the Vault
  // or the old builder at least once in that browser.
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register(new URL("../sw.js", location.href))
      .catch(() => { /* not over https, or blocked */ });
  // Tapping a notification: the service worker asks whichever HAWK window is
  // open to go to the match, rather than opening a second one.
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.addEventListener("message", (e) => {
      const url = e.data && e.data.open;
      if (url && typeof url === "string" && new URL(url, location.href).origin === location.origin)
        location.href = url;
    });

  /* ===================================================== your bet, live
     The same shape the in-play page's tickets use: every leg on THIS match
     priced live, legs on other matches counted at the chance stored with
     the bet, and the ticket says so. */
  async function myLiveTickets(gameId) {
    const sub = loadPref("hawk.subOn", true);
    const out = [];
    for (const b of vaultBets()) {
      if (b.status !== "PENDING"
        || !(b.legs || []).some((l) => l && l.hawk && String(l.hawk.game) === String(gameId))) continue;
      let p = 1, approx = false, unknown = 0;
      const parts = [];
      for (const l of b.legs || []) {
        if (!l || !l.hawk) { unknown++; continue; }
        if (String(l.hawk.game) === String(gameId)) {
          let live = null;
          try {
            live = await E().ticketLive(String(gameId),
              (l.hawk.legs || []).map((h) => ({ ...h, subOn: sub && b.subOn !== false })));
          } catch { /* skipped */ }
          if (!live) { unknown++; continue; }
          parts.push({ fixture: l.fixture, live });
          p *= live.p; unknown += live.unknown || 0;
        } else {
          const rs = (l.hawk.legs || []).map((h) => h.result);
          if (rs.includes("lost")) p = 0;
          else if (rs.length && rs.every((r) => r === "won")) { /* already landed */ }
          else { p *= l.hawk.p || 1; approx = true; }
          parts.push({ fixture: l.fixture, p: l.hawk.p,
            other: rs.includes("lost") ? "lost" : rs.length && rs.every((r) => r === "won") ? "won" : "pending" });
        }
      }
      out.push({ id: b.id, stake: b.stake, odds: b.odds, ret: b.potentialReturn, p, approx, unknown, parts });
    }
    return out;
  }

  /* What each ticket's chance was at the LAST look.
     A goal alert can only say whether it helped you by comparing the chance
     now against the chance a moment ago — nothing in a single reading tells
     you which way a goal went for a ticket, because a goal can help one leg
     and kill another on the same slip. The regular ten-second check keeps
     this up to date; the goal handler reads it before refreshing it. */
  const betWas = new Map();
  const rememberP = (tickets) => {
    for (const t of tickets) if (t && t.id != null && typeof t.p === "number") betWas.set(t.id, t.p);
  };
  async function betNow(gameId) {
    let mine = [];
    try { mine = await myLiveTickets(gameId); } catch { return null; }
    const t = mine[0];
    if (!t) return null;
    const rows = t.parts.filter((pt) => pt.live).flatMap((pt) => pt.live.legs);
    return { ...t, done: rows.filter((r) => r.state === "won").length,
             lost: rows.filter((r) => r.state === "lost").length, total: rows.length };
  }

  // hawk-settle.js settles a finished bet the way the Vault will. It is the
  // old builder's file and it is only needed at full time, so it is fetched
  // then rather than on every page load.
  let settlePromise = null;
  function settler() {
    if (window.HawkSettle) return Promise.resolve(window.HawkSettle);
    if (!settlePromise) settlePromise = new Promise((res) => {
      const s = document.createElement("script");
      s.src = "../builder/hawk-settle.js";
      s.onload = () => res(window.HawkSettle || null);
      s.onerror = () => res(null);
      document.head.appendChild(s);
    });
    return settlePromise;
  }
  // {won} / {lost: leg} / {check: why}, or null while other matches are still to play.
  async function betOutcome(b) {
    const S = await settler();
    if (!S) return null;
    let check = null;
    for (const l of b.legs || []) {
      if (!l || !l.hawk) { check = "a leg HAWK can't follow"; continue; }
      let f = null;
      try { f = await S.fetchMatchFacts(l.hawk.game); } catch { return null; }
      if (!f || !f.finished) return null;
      if (f.off) { check = `${l.fixture}: ${f.off}`; continue; }
      /* Sub On Play On, the same way v1's Vault settles: a player leg follows
         his replacement unless you switched the rule off, globally or on this
         bet. Without it a leg Bet365 pays WON reads lost here, and this is
         the function that can mark the whole bet LOST. */
      const subOn = loadPref("hawk.subOn", true) && b.subOn !== false;
      for (const h of l.hawk.legs || []) {
        const r = h.userDone ? "won" : S.legResult(h, f, { earlyPayout: true, subOn });
        if (r === "lost") return { lost: h.label };
        if (r !== "won") check = `${h.label} — ${r === "void" ? "didn't play" : "no result data"}`;
      }
    }
    return check ? { check } : { won: true };
  }

  /* ====================================== a bet that cannot land any more
     Marked LOST in the Vault now rather than at full time, with each leg's
     result as it stands, so it drops out of your running bets, the 🎟 on
     Scores, and these alerts. No money moves: the stake came off when the
     bet was logged and a lost bet returns nothing, which is exactly what
     the Vault's own settle does.

     Called only when the SAME leg has read "lost" on two consecutive
     checks, so one bad frame of data cannot settle a live bet. */
  function settleLost(betId, label, gameId, rows) {
    const bets = vaultBets();
    const b = bets.find((x) => x.id === betId);
    if (!b || b.status !== "PENDING") return false;
    const st = Object.fromEntries(rows.map((r) => [r.id, r.state]));
    for (const l of b.legs || [])
      if (l && l.hawk && String(l.hawk.game) === String(gameId))
        for (const h of l.hawk.legs || [])
          if (st[h.id] === "won" || st[h.id] === "lost") h.result = st[h.id];
    b.status = "LOST";
    b.settledAt = new Date().toISOString();
    b.settledBy = "HAWK";
    b.lostEarly = label;
    delete b.needsCheck;
    try { localStorage.setItem("hawk_bets", JSON.stringify(bets)); } catch { return false; }
    // Clear this match's notifications already sitting on your PC or phone.
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.getRegistration("../")
        .then((reg) => (reg ? reg.getNotifications() : []))
        .then((ns) => ns.filter((n) => String(n.tag || "").includes(String(gameId))).forEach((n) => n.close()))
        .catch(() => { /* none to clear */ });
    return true;
  }

  /* ============================================================ the goal card */
  const scorerLine = (s) => `<b>${esc(s.player)}</b> ${esc(s.minute)}${
    s.detail ? ` <span>· ${esc(s.detail)}</span>` : ""}${s.assist ? ` <span>· assist ${esc(s.assist)}</span>` : ""}`;
  async function goalAlert(g, side, score, fast = false) {
    const off = side.endsWith("-off"), who = side.startsWith("home") ? "home" : "away";
    const team = g[who];
    // Who scored (the latest goal for that side) and what it did to your bet.
    let scorer = null, bet = null;
    try {
      const goals = (await E().matchReport(g.id)).events.filter((e) => e.type === "goal" && e.side === who);
      // only once 365Scores lists this goal too — otherwise its latest goal
      // would be the previous one
      scorer = goals.length >= score[who === "home" ? 0 : 1] ? goals[goals.length - 1] : null;
    } catch { /* just the score then */ }
    /* …and which way it went for you. `swing` is the ticket's chance now
       against what it was at the last check, so the sound can say whose goal
       this was. No stored reading — a goal in the first ten seconds, or no
       bet at all — means no claim is made and it plays the plain bell. */
    let swing = null;
    try {
      const mine = await myLiveTickets(g.id);
      if (mine.length) {
        bet = mine[0];
        const prev = betWas.get(bet.id);
        if (typeof prev === "number" && typeof bet.p === "number") swing = bet.p - prev;
        rememberP(mine);
      }
    } catch { /* no bet */ }

    const body = off ? `${esc(team)}'s goal was taken off`
      : scorer && scorer.player ? scorerLine(scorer)
      : `${esc(team)} score`;
    // a point either way is noise; two is a goal doing something
    const voice = off ? null
      : swing == null ? null
      : swing > 0.02 ? "goalFor"
      : swing < -0.02 ? "goalAgainst"
      : null;
    const el = card({ tone: off ? "bad" : "goal", icon: off ? "❌⚽" : "⚽", word: off ? "GOAL OFF" : "GOAL",
                      g: { ...g, score }, body, bet, hit: off ? null : who, voice });

    // From Unibet, before 365Scores had the goal: the card goes up with the
    // score alone and the scorer's name arrives into it (every 10 s, for two
    // minutes). Waiting for the name would throw away the whole point of the
    // fast lane, which is the ten to sixty seconds it buys.
    if (fast && !off && !(scorer && scorer.player)) {
      const n0 = score[who === "home" ? 0 : 1];
      (async () => {
        for (let i = 0; i < 12 && el.isConnected; i++) {
          await new Promise((r) => setTimeout(r, 10000));
          try {
            const goals = (await E().matchReport(g.id)).events.filter((e) => e.type === "goal" && e.side === who);
            const sc = goals.length >= n0 ? goals[goals.length - 1] : null;
            if (sc && sc.player) { el.querySelector(".b").innerHTML = scorerLine(sc); return; }
          } catch { /* try again */ }
        }
      })();
    }
  }

  /* ========================================= red cards, your bet, half-time */
  async function matchAlerts(games) {
    const states = loadPref("hawk.betStates", {});
    for (const g of games) {
      /* 🟥 red cards */
      if (g.status === 3) {
        let ev = null;
        try { ev = await E().gameEvents(g.id); } catch { /* next time */ }
        for (const e of (ev && ev.events || []).filter((x) => x.type === "red"))
          if (firstTime(`red|${g.id}|${e.player}|${e.minute}`))
            card({ tone: "bad", icon: "🟥", word: "RED CARD", g, clock: e.minute,
                   body: `${esc(e.player || "A player")} <span>· ${esc(g[e.side])}${
                     /second|2nd/i.test(e.detail) ? " · second yellow" : ""}</span>`,
                   bet: pendingBetsOn(g.id).length ? await betNow(g.id) : null });
      }

      const bets = pendingBetsOn(g.id);
      if (!bets.length) continue;

      /* ⏸ half-time check on your bet */
      if (g.status === 3 && /half.?time|^ht$/i.test(g.statusText || "") && firstTime(`ht|${g.id}`)) {
        const t = await betNow(g.id);
        if (t) card({ tone: "info", icon: "⏸", word: "HALF-TIME", g, clock: "HT",
                      body: `${t.done} of ${t.total} legs done${t.lost ? ` · ${t.lost} lost` : ""}
                             <br><span>Tap to check a cash-out offer</span>`, bet: t });
      }

      /* ✅ / ❌ / 🔥 your bet, leg by leg */
      if (g.status === 3) {
        let mine = [];
        try { mine = await myLiveTickets(g.id); } catch { continue; }
        // the reading a goal alert will compare itself against
        rememberP(mine);
        for (const t of mine) {
          const rows = t.parts.filter((pt) => pt.live).flatMap((pt) => pt.live.legs);
          const was = states[t.id];
          states[t.id] = Object.fromEntries(rows.map((r) => [r.id, r.state]));
          if (!was) continue;                     // first look at this bet: just remember it
          // A leg lost on two checks in a row (10 s or more apart, so a data
          // blip cannot do it): the bet is settled as lost in the Vault now,
          // and its alerts stop.
          const gone = rows.find((r) => r.state === "lost" && was[r.id] === "lost");
          if (gone && settleLost(t.id, gone.label, g.id, rows)) {
            delete states[t.id];
            card({ tone: "bad", icon: "❌", word: "BET LOST", g, href: "../vault/",
                   body: `${esc(gone.label)} <span>· €${(+t.stake).toFixed(2)} stake · settled as lost
                          in your Vault, so its alerts stop</span>` });
            continue;
          }
          for (const r of rows) {
            if (was[r.id] === r.state) continue;
            if (r.state === "won" && firstTime(`leg|${t.id}|${r.id}|won`))
              card({ tone: "good", icon: "✅", word: "LEG LANDED", g, body: esc(r.label), bet: t });
            if (r.state === "lost" && firstTime(`leg|${t.id}|${r.id}|lost`))
              card({ tone: "bad", icon: "❌", word: "LEG LOST", g,
                     body: `${esc(r.label)} <span>· the bet can't land now. HAWK settles it as lost
                            once the next check says the same.</span>` });
          }
          const open = rows.filter((r) => r.state !== "won");
          const others = t.parts.filter((pt) => !pt.live && pt.other !== "won");
          if (open.length === 1 && open[0].state !== "lost" && !others.length && t.p > 0
            && firstTime(`last|${t.id}`))
            card({ tone: "warn", icon: "🔥", word: "ONE LEG TO GO", g,
                   body: `${esc(open[0].label)} <span>· ${open[0].p != null ? pct(open[0].p) : "—"}</span>`, bet: t });
        }
      }

      /* 🎉 / ❌ settled — as soon as the match ends (the Vault books it when you open it) */
      if (g.status === 4) for (const b of bets) {
        if (alreadySeen(`settled|${b.id}`)) continue;
        const out = await betOutcome(b);
        if (!out) continue;
        firstTime(`settled|${b.id}`);
        card(out.won
          ? { tone: "good", icon: "🎉", word: "BET WON", g,
              body: `€${(+b.stake).toFixed(2)} @ ${odds(b.odds)} returns <b>€${(+b.potentialReturn).toFixed(2)}</b>
                     <span>· the Vault books it when you open it</span>`, href: "../vault/" }
          : out.lost
            ? { tone: "bad", icon: "❌", word: "BET LOST", g,
                body: `${esc(out.lost)} didn't land <span>· €${(+b.stake).toFixed(2)} stake</span>`, href: "../vault/" }
            : { tone: "warn", icon: "⚠️", word: "CHECK YOUR BET", g,
                body: `${esc(out.check)} <span>· settle it in the Vault</span>`, href: "../vault/" });
      }
    }
    savePref("hawk.betStates", states);
  }

  /* ================================================== ⚡ the fast lane
     Unibet's live score for the matches you follow, every 5 s. A goal shows
     the moment Unibet has it, which is usually well before 365Scores; the
     scorer's name fills itself in afterwards.

     A match is only trusted once Unibet's score has matched 365Scores' at
     least once (G.ok). Unibet is found by name and kick-off time, so the
     wrong event can be matched to a fixture — and a mix-up that is never
     checked against the other feed would alert you about somebody else's
     game. One agreement is cheap and rules that out. */
  let fastBusy = false;
  async function fastGoals() {
    if (!G.on || fastBusy || !G.games.length || !E() || !E().kambiLive) return;
    const follow = followedGames();
    const games = G.games.filter((g) => g.status === 3 && follow.has(String(g.id)));
    if (!games.length) return;
    fastBusy = true;
    try {
      const live = await E().kambiLive(games);
      for (const g of games) {
        const k = live[g.id], was = G.last[String(g.id)];
        if (!k || !was) continue;
        const now = k.score;
        if (now[0] === was[0] && now[1] === was[1]) {       // the two feeds agree
          G.ok[g.id] = true; G.src[`fast|${g.id}`] = now; continue;
        }
        if (!G.ok[g.id]) continue;                          // never agreed: not trusted
        const move = goalMove("fast", g.id, now, k.minute);
        if (!move) continue;
        G.last[String(g.id)] = now;
        G.fast[g.id] = { score: now, at: Date.now() };
        goalAlert({ ...g, score: now, clock: k.minute != null ? `${k.minute}'` : g.clock },
                  move.side, now, true).catch((e) => console.warn("[hawk] goal alert:", e.message));
      }
    } catch (e) { console.warn("[hawk] fast lane:", e.message); }
    finally { fastBusy = false; }
  }

  /* ================================================================= the poll */
  async function check() {
    if (!G.on || G.busy || !E() || !E().scores) return;
    const follow = followedGames();
    if (!follow.size) { G.games = []; return; }
    G.busy = true;
    try {
      // Today's games — and, in the small hours, yesterday's too (a match that
      // kicked off before midnight).
      let list = await E().scores(localDay(new Date()));
      if (new Date().getHours() < 5) {
        const y = new Date(); y.setDate(y.getDate() - 1);
        list = list.concat(await E().scores(localDay(y)));
      }
      const seenId = new Set();
      const games = (list || []).filter((g) => g && follow.has(String(g.id))
        && (g.status === 3 || g.status === 4) && !seenId.has(g.id) && seenId.add(g.id));
      G.games = games;
      for (const g of games) {
        const now = [g.score[0] || 0, g.score[1] || 0], was = G.last[String(g.id)];
        // Unibet already had this goal: 365Scores is catching up, not a goal
        // being taken off.
        const fast = G.fast[g.id];
        if (fast && Date.now() - fast.at < 5 * 60e3 && now[0] <= fast.score[0] && now[1] <= fast.score[1]) {
          if (now[0] === fast.score[0] && now[1] === fast.score[1]) delete G.fast[g.id];
          continue;
        }
        G.last[String(g.id)] = now;
        // first look, or a finished match that has not moved: just remember it
        if (!was || (g.status === 4 && was[0] === now[0] && was[1] === now[1])) {
          G.src[`s365|${g.id}`] = now;
          continue;
        }
        const move = goalMove("s365", g.id, now, null);
        if (move) goalAlert(g, move.side, now).catch((e) => console.warn("[hawk] goal alert:", e.message));
      }
      await matchAlerts(games);
    } catch (e) { console.warn("[hawk] alert check:", e.message); }
    finally { G.busy = false; paintBell(); }
  }

  /* ============== the Vault settled one of your bets in another tab (or v1) */
  addEventListener("storage", (e) => {
    if (e.key !== "hawk_bets" || !e.newValue) return;
    let before = [], after = [];
    try { before = JSON.parse(e.oldValue || "[]"); after = JSON.parse(e.newValue); } catch { return; }
    for (const b of after) {
      const old = before.find((x) => x.id === b.id);
      if (!old || old.status !== "PENDING" || (b.status !== "WON" && b.status !== "LOST")) continue;
      if (!firstTime(`settled|${b.id}`)) continue;
      const l = (b.legs || []).find((x) => x && x.hawk) || {}, h = l.hawk || {};
      const sg = (G.games || []).find((x) => String(x.id) === String(h.game));
      const score = /^\d+-\d+$/.test(h.score || "") ? h.score.split("-").map(Number)
        : sg && sg.status === 4 && sg.score[0] != null ? sg.score : [null, null];
      const g = { id: h.game, league: h.league, home: h.home || l.fixture || "", away: h.away || "",
                  homeCrest: (sg && sg.homeCrest) || "", awayCrest: (sg && sg.awayCrest) || "",
                  status: 4, score, clock: "FT" };
      card(b.status === "WON"
        ? { tone: "good", icon: "🎉", word: "BET WON", g, href: "../vault/",
            body: `Returns <b>€${(+b.potentialReturn).toFixed(2)}</b> <span>· booked in your Vault</span>` }
        : { tone: "bad", icon: "❌", word: "BET LOST", g, href: "../vault/",
            body: `€${(+b.stake).toFixed(2)} stake <span>· booked in your Vault</span>` });
    }
  });

  /* ================================================================ the bell
     Mounted by hawk-nav.js. It is the master switch, the notification test,
     and the place a card you missed can still be read. */
  let bell = null, pop = null;
  function paintBell() {
    if (!bell) return;
    // Always shown, because it is the master switch as well as the count —
    // a hidden bell is how you end up not knowing alerts are off.
    const n = followedGames().size;
    bell.classList.toggle("off", !G.on);
    bell.innerHTML = `🔔<em>${G.on && n ? n : ""}</em>`;
    bell.title = !G.on ? "Alerts are off" : n
      ? `${plural(n, "match")} followed — goals, red cards and your bet`
      : "Alerts are on. A match you have a bet on is followed automatically.";
    if (pop) paintPop();
  }
  function paintPop() {
    const log = loadPref("hawk.alertLog", []);
    const n = followedGames().size;
    const perm = "Notification" in window ? Notification.permission : "none";
    const xi = watchList().length;
    const snd = loadPref("hawk.alertSound", true);
    pop.innerHTML = `<h5>Alerts</h5>
      <p>${G.on
        ? `Lineups confirmed, goals, red cards, and every leg of your bet — for
           ${n ? plural(n, "match") : "any match you follow"}${xi ? `, ${xi} waiting on the XIs` : ""}.
           A match you have a bet on is followed automatically, and a bet that can no longer
           land is settled as lost in your Vault.`
        : `Off. Nothing will interrupt you, including a leg of your bet going down.`}</p>
      <div class="row">
        <button data-al="toggle">${G.on ? "Turn off" : "Turn on"}</button>
        ${G.on ? `<button data-al="test">${perm === "granted" ? "Test" : perm === "denied" ? "Blocked" : "On my phone too"}</button>` : ""}
        <button data-al="sound" aria-pressed="${String(snd)}">${snd ? "Sound on" : "Sound off"}</button>
      </div>
      ${G.on && snd ? `<div class="hear">
        <span class="k">Hear them</span>
        ${[["goal", "⚽ Goal"], ["goalOff", "❌ Goal off"], ["red", "🟥 Red"],
           ["landed", "✅ Leg landed"], ["lost", "❌ Lost"], ["urgent", "🔥 One to go"],
           ["tick", "🔔 Lineups"]].map(([v, t]) =>
          `<button data-hear="${v}">${t}</button>`).join("")}
        <p>A goal for you rises, a goal against falls, and the VAR take-back is the goal
          played backwards. Your browser will not play any of them until you have clicked
          the page once — the card and the phone notification do not need that.</p>
      </div>` : ""}
      ${perm === "denied" && G.on ? `<p>This browser is blocking HAWK's notifications, so alerts only show
        while a HAWK tab is open. Allow them in the padlock menu beside the address bar.</p>` : ""}
      ${log.length ? `<div class="lghd"><span class="k">${plural(log.length, "alert")}</span>
          <button data-al="clear">Clear</button></div>` : ""}
      ${log.length ? log.map((a) => `<div class="lg"><span class="i">${a.icon || "🔔"}</span>
        <span class="tx"><b>${esc(a.word || "")}</b>${esc(a.text || "")}</span>
        <time>${ago(a.at)}</time></div>`).join("")
        : `<div class="lg"><span class="tx">Nothing yet.</span></div>`}`;
  }
  function mountBell(into) {
    if (bell) return bell;
    bell = document.createElement("button");
    bell.className = "bell";
    bell.type = "button";
    into.appendChild(bell);
    paintBell();
    bell.onclick = (e) => {
      e.stopPropagation();
      if (pop) { pop.remove(); pop = null; return; }
      pop = document.createElement("div");
      pop.className = "bellpop";
      paintPop();
      into.appendChild(pop);
      pop.onclick = async (ev) => {
        ev.stopPropagation();
        // the test buttons: a click is also the gesture that lets a browser
        // play anything at all, so pressing one always makes a noise
        const h = ev.target.closest("[data-hear]");
        if (h) { beep(h.dataset.hear); return; }
        const b = ev.target.closest("[data-al]");
        if (!b) return;
        if (b.dataset.al === "sound") {
          const now = !loadPref("hawk.alertSound", true);
          savePref("hawk.alertSound", now);
          paintPop();
          if (now) beep("landed");
          return;
        }
        /* Empty the history. It is the only place an alert you missed can
           still be read, so it fills with Tuesday's goals and the one you
           actually want is underneath them. The log only — the alerts
           themselves, and which matches you follow, are untouched. */
        if (b.dataset.al === "clear") {
          savePref("hawk.alertLog", []);
          paintPop();
          return;
        }
        if (b.dataset.al === "toggle") {
          G.on = !G.on; savePref("hawk.goalAlerts", G.on);
          if (G.on) { await askPermission(); check(); }
          paintBell();
        } else if (b.dataset.al === "test") {
          const ok = await askPermission();
          paintPop();
          notice({ icon: "🔔", word: "Test", tone: "info",
            text: ok ? "That is what a HAWK alert looks like. One like it will reach your phone with HAWK in the background."
                     : "That is what a HAWK alert looks like. It will only show while a HAWK tab is open — notifications are not allowed." });
        }
      };
    };
    addEventListener("click", () => { if (pop) { pop.remove(); pop = null; } });
    return bell;
  }

  /* ========================================= a 🔔 button for one match
     One button, two meanings, decided by whether the match has started.
     Before kick-off the thing worth being told is that the XIs are in —
     it is the last moment a build is still worth making — and a lineup
     alert follows the match for goals afterwards anyway. Once it is under
     way there are no lineups left to wait for, so it is goals only.

     `info` is {league, home, away, started}; a lineup watch needs the names
     to be able to say what it is about hours later. */
  function followButton(el, id, info = {}) {
    if (!el) return;
    const pre = !info.started;
    const paint = () => {
      const st = followState(id), watched = pre && isWatched(id);
      const lit = st.bet || st.on || watched;
      el.className = `fol${st.bet ? " bet" : lit ? " on" : ""}`;
      el.textContent = st.bet ? (pre ? "🔔 Alerts on — lineups, then goals (you have a bet)"
                                     : "🔔 Alerts on — you have a bet")
        : watched ? "🔔 Alerts on — lineups, then goals"
        : st.on ? "🔔 Alerts on"
        : st.here ? "🔕 Keep alerts after I leave"
        : pre ? "🔕 Alert me when the lineups land"
        : "🔕 Alert me";
      el.title = st.bet ? (pre ? "You have a bet on this match: you'll be told the moment both XIs are confirmed, then goals and red cards. It cannot be turned off."
                               : "You have a bet on this match, so its alerts cannot be turned off.")
        : watched ? "You'll be told the moment both XIs are confirmed, then goals and red cards. Click to turn off."
        : st.on ? "Goals, red cards and your bet. Click to turn off."
        : st.here ? "You get this match's goals while this page is open. Click to keep them for three hours after you leave."
        : pre ? "Both XIs confirmed — ESPN is asked too, because 365Scores calls a predicted XI confirmed a day out. Goals follow."
        : "Goals and red cards on this match, for the next three hours.";
    };
    paint();
    el.onclick = async () => {
      if (pre && !followState(id).bet) await toggleWatch({ id, ...info });
      else await toggleFollow(id);
      paint();
    };
    document.addEventListener("hawk:follow", paint);
    return el;
  }

  /* ================================================================== boot
     A background tab's own timers are slowed to once a minute by the browser,
     but a worker's are not — so alerts stay quick while HAWK sits behind
     something else. That is the whole reason for the worker. */
  function run() {
    // Unibet every beat (5 s), 365Scores every other one (10 s), lineups
    // once a minute — they land an hour before kick-off, not every five
    // seconds.
    let n = 0;
    const beat = () => {
      fastGoals();
      if (++n % 2 === 0) check();
      if (n % 12 === 0) checkLineups();
    };
    try {
      const url = URL.createObjectURL(new Blob(
        [`setInterval(() => postMessage(0), ${FAST_MS})`], { type: "text/javascript" }));
      new Worker(url).onmessage = beat;
    } catch { setInterval(beat, FAST_MS); }
    setTimeout(() => { check(); checkLineups(); }, 3500);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { check(); checkLineups(); }
    });
  }

  window.HAWKAlerts = {
    mountBell, followButton, followState, toggleFollow, followedGames,
    // show() is the full card (a match, a score, your bet on it); notice() is
    // the plain one. Pages raise their own through these rather than inventing
    // a second kind of popup.
    show: card, notice, check, checkLineups, paintBell,
    toggleWatch, isWatched, watchList,
    get on() { return G.on; },
    log: () => loadPref("hawk.alertLog", []),
  };
  run();
})();
