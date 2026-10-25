/* ===========================================================================
   SYNC — getting the Vault from one device to another.

   Ported from v1, which is where all of this was learned. It reads and writes
   v1's own keys, so a device running either version can sync with a device
   running the other.

   The hard part is not moving the data, it is the BANKROLL. Two devices that
   have both been used do not have one true balance to pick between: picking a
   side throws away the other one's stakes and returns. So the balance follows
   the TICKETS — each one that arrives moves it by its own stake and payout —
   and money moved by hand comes across from the edit log instead. v1's note
   on that line reads "that is how €9.25 went missing".

   Four ways across, because each one fails differently:
     · a link        — fine until a messaging app truncates it
     · a QR code     — nothing leaves the room, but a Vault needs many frames
     · a file        — the only one that cannot be cut short
     · paste a link  — when the link opened in the wrong browser

   The host page hands in the few things only it can do (read its bets, save
   them, redraw) and this file does the rest.
   =========================================================================== */
(() => {
  "use strict";
  if (window.HAWKSync) return;

  /* What HAWK has LEARNED about prices, as opposed to what you bet. It only
     ever grows, so a diff never carries it — the whole point of a diff is
     that it stays small enough for a messaging app. */
  const SYNC_LEARN = ["hawk.b365prices", "hawk.propPrices", "hawk.notOn365", "hawk.onBet365"];
  const MARK_KEY = "hawk.syncMark";
  const LOG_KEY = "hawk_bankroll_log";
  const REMOVED_KEY = "hawk_removed";

  const load = (k, f) => { try { const v = localStorage.getItem(k); return v === null ? f : JSON.parse(v); } catch { return f; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const round2 = (v) => Math.round((+v || 0) * 100) / 100;
  const money = (n) => `€${(+n || 0).toFixed(2)}`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  const bankrollLog = () => { const v = load(LOG_KEY, []); return Array.isArray(v) ? v : []; };
  const removedBets = () => new Set(load(REMOVED_KEY, []) || []);

  /* ------------------------------------------------------------- packing */
  const b64url = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const pipe = async (bytes, stream) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  // What went out last time, so the next sync can be only what changed since.
  // A full Vault is ~28,000 characters — more than any messaging app carries
  // intact and ten times what a QR code holds. Three new tickets is ~900.
  const syncMark = () => { const v = load(MARK_KEY, { ids: [], at: null }); return v && Array.isArray(v.ids) ? v : { ids: [], at: null }; };
  const setSyncMark = (ids) => save(MARK_KEY, { ids, at: new Date().toISOString() });

  function syncData(bets, bank, mode = "full") {
    const seen = new Set(syncMark().ids);
    const out = mode === "diff" ? bets.filter((b) => b && b.id && !seen.has(b.id)) : bets;
    const data = { v: 1, mode, at: new Date().toISOString(), bankroll: bank,
                   bets: out, bankrollLog: bankrollLog(), learn: {} };
    if (mode === "full") for (const k of SYNC_LEARN) {
      const v = load(k, null); if (v != null) data.learn[k] = v;
    }
    return data;
  }
  // The link says how long it should be ("y" + length + "."), so a link an app
  // cut short is told apart from one that was changed on the way.
  async function packSync(bets, bank, mode = "full") {
    const raw = new TextEncoder().encode(JSON.stringify(syncData(bets, bank, mode)));
    if (!("CompressionStream" in window)) return "n." + b64url(raw);
    const body = b64url(await pipe(raw, new CompressionStream("deflate-raw")));
    return "y" + body.length.toString(36) + "." + body;
  }
  async function unpackSync(s) {
    let kind = s.slice(0, 2), body = s.slice(2);
    if (s[0] === "y") {
      const dot = s.indexOf("."), want = parseInt(s.slice(1, dot), 36);
      body = s.slice(dot + 1);
      if (!(want > 0) || body.length < want) { const e = new Error("cut short"); e.cut = [body.length, want]; throw e; }
      body = body.slice(0, want); kind = "z.";
    }
    let bytes = Uint8Array.from(atob(body.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    if (kind === "z.") bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  /* ------------------------------------------------------------------ QR
     A Vault does not fit in one QR code (2,953 bytes at best), so it is cut
     into frames and cycled. The phone collects them in any order, over as
     many passes as it needs. Nothing leaves the room and no app is involved. */
  const QR_CHUNK = 900;
  const qrFrames = (code) => {
    const n = Math.ceil(code.length / QR_CHUNK);
    return Array.from({ length: n }, (_, i) => `HWK1|${i + 1}|${n}|${code.slice(i * QR_CHUNK, (i + 1) * QR_CHUNK)}`);
  };
  function qrSvg(text, px = 260) {
    if (typeof window.qrcode !== "function") return `<p class="note" style="margin:0">qr.js didn't load, so the code can't be drawn. Use a file or the link.</p>`;
    const q = window.qrcode(0, "L"); q.addData(text); q.make();
    const c = q.getModuleCount(), cell = Math.max(1, Math.floor(px / (c + 8)));
    return q.createImgTag(cell, cell * 4);
  }
  // Frames may arrive in any order and repeat freely; the code comes back
  // only once every index is present.
  function qrCollector() {
    const parts = new Map(); let total = 0;
    return {
      take(text) {
        const m = /^HWK1\|(\d+)\|(\d+)\|([\s\S]*)$/.exec(text || "");
        if (!m) return false;
        const i = +m[1], n = +m[2];
        if (total && n !== total) return false;    // a frame from a different Vault
        total = n; parts.set(i, m[3]);
        return true;
      },
      have: () => parts.size,
      need: () => total,
      missing: () => { const out = []; for (let i = 1; i <= total; i++) if (!parts.has(i)) out.push(i); return out; },
      done: () => total > 0 && parts.size === total,
      code: () => Array.from({ length: total }, (_, i) => parts.get(i + 1)).join(""),
    };
  }

  /* ---------------------------------------------------------- the merge */
  // A newer copy of the same ticket wins: settled beats pending, a later
  // settle beats an earlier one, more marked legs beats fewer.
  function syncRank(b) {
    const known = (b.legs || []).reduce((n, l) =>
      n + ((l.hawk && l.hawk.legs) || []).filter((h) => h.result || h.userDone).length, 0);
    return [b.status !== "PENDING" ? 1 : 0, Date.parse(b.settledAt || "") || 0, known];
  }
  const newer = (a, b) => {
    const x = syncRank(a), y = syncRank(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  // What a ticket contributes to the balance beyond its stake. Same rules as
  // the Vault's own settle(), or the two pages would value a ticket
  // differently and the sync would move money that was never won.
  const payout = (status, ret, cash) =>
    (status === "WON" ? (+ret || 0) : status === "CASHED_OUT" ? (+cash || 0) : status === "VOID" ? 0 : 0);

  async function applySyncData(ctx, data) {
    if (!data || !Array.isArray(data.bets)) return false;
    const bets = ctx.bets();
    const here = new Map(bets.map((b) => [b.id, b]));
    const gone = removedBets();

    /* A ticket you deleted here is not one this device is "missing", and
       re-adding it would apply its stake and payout to the balance again.
       Counted so the summary can say so rather than skip in silence, which
       looks like the sync simply failed to arrive. */
    const incoming = data.bets.filter((b) => b && b.id && !here.has(b.id));
    const add = incoming.filter((b) => !gone.has(b.id));
    const blocked = incoming.length - add.length;
    const upd = data.bets.filter((b) => b && here.has(b.id) && newer(b, here.get(b.id)));

    const made = data.at
      ? new Date(data.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : "a backup file";
    const blockedNote = blocked ? `\n• ${plural(blocked, "ticket")} you removed here — left out` : "";
    const bank = ctx.bank();
    if (!add.length && !upd.length && Math.abs((data.bankroll || 0) - bank) < 0.005) {
      alert(`Sync from ${made}: this device already has everything in it.${blockedNote}`);
      return false;
    }
    if (!confirm(`Sync from your other device (made ${made}):\n\n`
      + `• ${plural(add.length, "new ticket")} to add\n`
      + `• ${plural(upd.length, "ticket")} settled or updated there${blockedNote}\n\n`
      + `Tickets already here are kept. Add them?`)) return false;

    const wasBefore = new Map(upd.map((b) => [b.id, { ...here.get(b.id) }]));
    /* A Vault nobody has used yet — a reinstalled phone, a new browser — is
       sitting on a default, which is not a baseline to add deltas to. */
    const fresh = !bets.length && !bankrollLog().length;

    for (const b of add) bets.push(b);
    for (const b of upd) { const i = bets.findIndex((x) => x.id === b.id); if (i >= 0) bets[i] = b; }
    const ms = (b) => { const t = /^bet_(\d{12,})/.exec(b.id || ""); return t ? +t[1] : 0; };
    bets.sort((a, b) => ms(b) - ms(a));

    // HAWK's price learning: add what the other device learned, never replace.
    for (const [k, v] of Object.entries(data.learn || {})) {
      if (!Array.isArray(v)) continue;
      const mine = load(k, []) || [];
      const have = new Set(mine.map((x) => JSON.stringify(x)));
      save(k, [...mine, ...v.filter((x) => !have.has(JSON.stringify(x)))]);
    }

    /* The balance follows the tickets that just arrived, rather than being a
       choice between two whole numbers. */
    const was = bank;
    let now = bank;
    if (fresh && typeof data.bankroll === "number") {
      now = data.bankroll;                        // nothing here to reconcile against
    } else {
      for (const b of add) now += -(+b.stake || 0) + payout(b.status, b.potentialReturn, b.cashOutAmount);
      for (const b of upd) {
        const old = wasBefore.get(b.id) || {};
        now += -((+b.stake || 0) - (+old.stake || 0))
             + payout(b.status, b.potentialReturn, b.cashOutAmount)
             - payout(old.status, old.potentialReturn, old.cashOutAmount);
      }
    }
    /* Money you moved by hand over there (a top-up, a correction) is in no
       ticket, so carry across only the log entries this device hasn't seen.
       A `derived` entry is the other device's own record of a sync and the
       tickets behind it have just been replayed above — adding its delta too
       charges for the same tickets twice. */
    const seenEdits = new Set(bankrollLog().map((e) => e.timestamp));
    const newEdits = (Array.isArray(data.bankrollLog) ? data.bankrollLog : []).filter((e) => e && !seenEdits.has(e.timestamp));
    if (!fresh) for (const e of newEdits) if (!e.derived) now += (+e.delta || 0);
    if (newEdits.length) {
      save(LOG_KEY, [...newEdits, ...bankrollLog()]
        .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0)));
    }
    now = round2(now);
    ctx.setBank(now);
    if (Math.abs(now - was) >= 0.005)
      logEdit(was, now, `Synced from your other device (${add.length} added, ${upd.length} updated)`, true);
    ctx.save();
    ctx.draw();

    const theirs = typeof data.bankroll === "number" ? data.bankroll : null;
    alert(`Synced: ${add.length} added, ${upd.length} updated. `
      + `You now have ${plural(bets.length, "ticket")} and ${money(now)}.`
      + (theirs !== null && Math.abs(theirs - now) >= 0.01
        ? `\n\nThe other device's own total was ${money(theirs)}, ${money(Math.abs(theirs - now))} apart from this.`
          + `\nThis number is worked out from the tickets, so it is usually the right one.`
        : ""));
    return true;
  }

  /* An entry in the bankroll's own history. `derived` marks money that moved
     because of tickets rather than by hand, so a later sync knows not to
     charge for it twice. */
  function logEdit(from, to, why, derived = false) {
    const list = bankrollLog();
    list.unshift({ timestamp: new Date().toISOString(), from: round2(from), to: round2(to),
                   delta: round2(to - from), reason: String(why || "").slice(0, 160), derived: !!derived });
    save(LOG_KEY, list.slice(0, 400));
  }

  /* ----------------------------------------------------------- reading in */
  async function applyCode(ctx, code) {
    let data;
    try { data = await unpackSync(code); }
    catch (e) {
      alert(e && e.cut
        ? `Only part of the link arrived (${e.cut[0].toLocaleString()} of ${e.cut[1].toLocaleString()} characters) — `
          + `the app you sent it with cut it short.\n\nOn the other device use "Send as a file", then here "Add from a file".`
        : `This sync link was changed on the way, so it can't be read.\n\n`
          + `On the other device use "Send as a file", then here "Add from a file".`);
      return false;
    }
    return applySyncData(ctx, data);
  }
  // A link pasted into the box, for when it opened in a browser that is not
  // the one HAWK's data lives in.
  async function applyText(ctx, text) {
    const t = String(text || "").replace(/\s+/g, "");
    const code = /(?:[zn]\.|y[0-9a-z]+\.)[A-Za-z0-9_-]+/;
    const m = new RegExp("#sync=(" + code.source + ")").exec(t) || new RegExp("^(" + code.source + ")$").exec(t);
    if (!m) { alert(`That isn't a HAWK sync link. On the other device: Sync → Copy link, then paste it here.`); return false; }
    return applyCode(ctx, m[1]);
  }
  // A link opened on this device: #sync=… in the address.
  async function fromHash(ctx) {
    const m = /^#sync=(.+)$/.exec(location.hash);
    if (!m) return false;
    history.replaceState(null, "", location.pathname + location.search);
    return applyCode(ctx, m[1]);
  }

  const newCount = (bets) => { const seen = new Set(syncMark().ids); return bets.filter((b) => b && b.id && !seen.has(b.id)).length; };

  window.HAWKSync = {
    SYNC_LEARN, syncData, packSync, unpackSync,
    qrFrames, qrSvg, qrCollector, QR_CHUNK,
    syncRank, newer, applySyncData, applyCode, applyText, fromHash,
    syncMark, setSyncMark, newCount, logEdit, bankrollLog, removedBets,
  };
})();
