/* ===========================================================================
   THE ACCA STORE

   One acca, shared by the match page, Picks and the Acca page — and by the
   old builder, because this reads and writes v1's own key (hawk.acca) in
   v1's own shapes. A ticket started in one is finished in the other.

   A part is one MATCH, not one leg: a same-match builder of three legs is
   still one part, because Bet365 prices a builder as a unit and dividing a
   builder's price back into legs is arithmetic nobody can do honestly.
   Adding a match you already have replaces it rather than doubling it.

   Parts are kept in kick-off order. That is not cosmetic: the acca's chance
   compounds down the board in the order the matches actually play, which is
   the only arrangement in which watching 16% become 3.2% become 0.64% tells
   you which leg is costing you.
   =========================================================================== */
(() => {
  "use strict";
  if (window.HAWKAcca) return;

  const KEY = "hawk.acca";
  const load = (k, f) => { try { const v = localStorage.getItem(k); return v === null ? f : JSON.parse(v); } catch { return f; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

  const list = () => { const v = load(KEY, []); return Array.isArray(v) ? v : []; };
  const put = (parts) => {
    parts.sort((a, b) => String(a.kickoff || "").localeCompare(String(b.kickoff || "")));
    save(KEY, parts);
    document.dispatchEvent(new CustomEvent("hawk:acca", { detail: { n: parts.length } }));
    return parts;
  };

  /* A leg as it lives on the acca: enough to draw its card and price it with
     the match it came from long closed. */
  const legShape = (l) => ({
    id: l.id, label: l.label, market: l.market, kind: l.kind, p: l.p, pRaw: l.pRaw, fair: l.fair,
    bookPrice: l.bookPrice || null, player: l.player || null, side: l.side || null,
    photo: l.photo || null, refPrice: l.refPrice || null, b365: l.b365 || null,
    ep: !!l.ep, pNoEp: l.pNoEp ?? null, hits: l.hits ?? null, games: l.games ?? null, basis: l.basis || null,
  });

  const makePart = (info, legs, p) => ({
    id: String(info.id), league: info.league, home: info.home, away: info.away,
    homeCrest: info.homeCrest || null, awayCrest: info.awayCrest || null, upset: info.upset,
    kickoff: info.kickoff, legs: legs.map(legShape), p, fair: p > 0 ? 1 / p : null,
  });

  /* Only a single leg has a price of its own. A builder's price is Bet365's
     to set and HAWK does not get to invent one, which is why the acca's
     "Bet365" column goes blank the moment one part is a builder. */
  const partPrice = (pt) => (pt.legs.length === 1 ? pt.legs[0].bookPrice || null : null);

  function totals(parts = list()) {
    if (!parts.length) return { p: null, fair: null, known: null, legs: 0, parts: 0 };
    const p = parts.reduce((s, pt) => s * pt.p, 1);
    const prices = parts.map(partPrice);
    return {
      p, fair: p > 0 ? 1 / p : null,
      known: prices.every(Boolean) ? prices.reduce((s, x) => s * x, 1) : null,
      legs: parts.reduce((s, pt) => s + pt.legs.length, 0), parts: parts.length,
    };
  }

  function add(info, legs, p) {
    const parts = list(), part = makePart(info, legs, p);
    const i = parts.findIndex((x) => String(x.id) === part.id);
    const replaced = i >= 0;
    if (replaced) parts[i] = part; else parts.push(part);
    put(parts);
    return { replaced, totals: totals() };
  }
  const remove = (id) => put(list().filter((x) => String(x.id) !== String(id)));
  const clear = () => put([]);
  const has = (id) => list().some((x) => String(x.id) === String(id));
  const get = (id) => list().find((x) => String(x.id) === String(id)) || null;

  /* What goes into the Vault with the bet, so it can settle itself later. The
     crests are STORED rather than looked up: once a match leaves the feed
     there is nothing left to look it up by, and a ticket logged today would
     otherwise be blank by the time you read it back. */
  const hawkPart = (pt) => ({
    game: String(pt.id), league: pt.league, home: pt.home, away: pt.away, kickoff: pt.kickoff, p: pt.p,
    homeCrest: pt.homeCrest || null, awayCrest: pt.awayCrest || null,
    legs: pt.legs.map((l) => ({
      id: l.id, label: l.label, market: l.market, p: l.p, pRaw: l.pRaw != null ? l.pRaw : l.p,
      player: l.player || null, side: l.side || null, bookPrice: l.bookPrice || null,
      refPrice: l.refPrice || null, refBooks: l.refBooks || null,
    })),
  });

  // Bet365 runs acca boosts on 3+ legs: a boost lifts the WINNINGS, not the
  // stake, so 10.00 boosted 20% pays like 1 + 9 × 1.2 = 10.80, not 12.00.
  const effective = (price, boostPct) =>
    (price > 1 ? 1 + (price - 1) * (1 + (Math.max(0, boostPct) || 0) / 100) : NaN);

  window.HAWKAcca = { KEY, list, get, has, add, remove, clear, totals, partPrice, legShape, makePart, hawkPart, effective };
})();
