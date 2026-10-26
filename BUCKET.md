# Bucket list

Things worth doing, not urgent. Newest at the top. Delete a line when it ships.

Model-side open questions live in Claude's memory, not here — TACKLE_SCALE, Match
SoT Over, the 3+ leg selection edge, and why the price learning stays off.

---

## A bet on a match blocks its XI alert

`checkLineups()` only walks `hawk.lineupWatch`, and nothing adds a bet's match
to it. `followButton`'s click (`hawk-alerts.js:971`) routes to `toggleWatch`
only when `!followState(id).bet` — so once a bet exists, the bell goes to
`toggleFollow`, which returns early with "Already on" and arms nothing.

The result: the matches where a confirmed XI matters MOST — you have money on
them, and a player leg can die the moment the teams land — are the only ones
you cannot set a lineup alert for. It is order-dependent too: watch-then-bet
works, bet-then-watch is impossible.

Fix is probably that a pending bet should imply a lineup watch, the same way it
already implies goal-following (`pendingBetsOn`), rather than excluding one.
Check it does not double-notify a match that is already watched by hand.

## Grade HAWK's own builders under the Vault's rules

`engine/grade.mjs:588` settles the `tickets` control with
`HawkSettle.legResult(leg, f)` — no options, so no early payout and no sub-on.
`assets/hawk-alerts.js:573` settles your real bets with
`{ earlyPayout: true, subOn }`. The control is therefore graded under STRICTER
rules than the record it is the control for, and every comparison between the
two is biased in the same direction as the selection edge.

Do NOT change how `byKey` is graded — raw is deliberate there, so it measures
the model and not model-plus-payout-rule (`grade.mjs:229`). Add a second tally
to the `tickets` block settled the Vault's way, and compare like with like.

Until that exists, the +7.6 points at 3+ legs is an upper bound.

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

## Clear button in the alerts

The bell popup lists the last 20 alerts (`hawk.alertLog`, written by `notice()`
in `assets/hawk-alerts.js`) and there is no way to empty it. The row of buttons
there is Turn off / Test / Sound on — `paintPop()`, around line 940. Nothing
removes the log short of clearing site data.

Worth more than it sounds: the log is the only place an alert you missed can
still be read, so it fills with goals from three days ago and the one you
actually want is underneath them.

Needs: a **Clear** in that button row, writing `[]` to `hawk.alertLog` and
repainting. Probably only shown when the log has something in it, so the row
does not carry a dead button on a fresh install.

## Open question: emoji on the hero headlines?

Every static heading across the eight pages carries a mark now except the hero
headlines — "Every bet, priced honestly", "Today's card", "Where HAWK is wrong",
"One ticket, many matches". Left bare on purpose: they are the one loud moment on
each page, set at 40px+, and an emoji that size competes with the thing rather
than labelling it. Lewzu has not said either way.
