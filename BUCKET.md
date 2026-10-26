# Bucket list

Things worth doing, not urgent. Newest at the top. Delete a line when it ships.

Model-side open questions live in Claude's memory, not here — TACKLE_SCALE, Match
SoT Over, the 3+ leg selection edge, and why the price learning stays off.

---

## Swap a leg, from the slip

v1 had 🔄 swap on each leg: tap it and HAWK puts the next best leg in its place.
The old builder's checklist still refers people to it — "If a leg isn't offered,
tap 🔄 swap on it in the slip" — but nothing in the rebuild has it. The per-leg
explanation cards on the match page are the obvious home for it: they already
say WHY a leg is on the ticket, so "and here is the next one down" belongs on
the same card.

Needs the engine's alternatives for a leg at the same target price, the swap
re-pricing the whole slip (same-match legs are priced together, so one swap
moves every other leg's contribution), and the explanation lines redrawn.

## Open question: emoji on the hero headlines?

Every static heading across the eight pages carries a mark now except the hero
headlines — "Every bet, priced honestly", "Today's card", "Where HAWK is wrong",
"One ticket, many matches". Left bare on purpose: they are the one loud moment on
each page, set at 40px+, and an emoji that size competes with the thing rather
than labelling it. Lewzu has not said either way.
