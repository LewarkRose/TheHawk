# Bucket list

Things worth doing, not urgent. Newest at the top. Delete a line when it ships.

Model-side open questions live in Claude's memory, not here — TACKLE_SCALE, Match
SoT Over, the 3+ leg selection edge, and why the price learning stays off.

---

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
