// THE MATCH ARCHIVE — one row per graded match, kept for ever.
//
// WHY. Every other block HAWK keeps is a running SUM: byMarket, byKey, statFit,
// clv, ev, demargin. A sum can only ever answer the question that was decided when
// it was written, and grade.mjs:388 states the cost of that out loud —
//
//   "a count distribution that is too narrow and a per-match mean that is too
//    spread out look identical from here, and statFit cannot separate them
//    because it keeps only sums"
//
// That is not a missing feature, it is a destroyed observation. The per-match pair
// (what HAWK expected, what happened) existed for a moment, was added into a
// total, and thrown away. Three open questions need those pairs and cannot be
// answered from totals at any sample size: whether the corner error is a level or
// a shape error, whether Match SoT is a rotation or a level, and whether HAWK's
// draw lean is the de-margining method or the model.
//
// It also cannot be rebuilt later. A finished fixture drops out of fixtures.json
// and 365Scores deletes its odds lines, so an expectation that was not written
// down at the time is gone permanently — the same trap as the corner scale and
// the money ledger. This accrues forward only. Every day it does not run is a day
// of evidence that cannot be recovered.
//
// WHERE. data/grading/archive/YYYY-MM.jsonl, one JSON object per line. That
// directory is BOTH kept in the Action's cache and published to Pages, so it
// inherits state.json's two independent recoveries: cache first, then the copy on
// the live site. Deliberately not in graded.json — the builder downloads that file
// on every visit.
//
// THE SILENT-TRUNCATION GUARD, which is the only hard part. data/ is rebuilt from
// scratch every run and Pages replaces the whole directory, so a month's file is
// not appended to: it is loaded, merged and written out whole. If a load quietly
// returns nothing when the file really had 3,000 rows in it, writing the merge
// would delete three thousand matches and the run would still be green. So the row
// count per month is also kept in `state` (itself cached and published), and a
// month whose load comes back SHORT of what state remembers is refused rather than
// overwritten. Losing a run's rows is a scratch; silently truncating the archive
// is the whole point of the thing gone.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

export const monthOf = (iso) => String(iso || "").slice(0, 7);   // "2026-11"

const fileFor = (dir, month) => path.join(dir, `${month}.jsonl`);

const parse = (text) => {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const s = line.trim();
    if (!s) continue;
    // One bad line must not cost the other 2,999. A truncated final line is the
    // expected shape of damage here, since the file is written whole each run.
    try { const o = JSON.parse(s); if (o && o.id) rows.push(o); } catch { /* skip */ }
  }
  return rows;
};

/** Load a month: the cache, else the published site, else empty.
 *  Returns {rows, source} — source is "cache" | "live" | "empty", and the caller
 *  needs it to tell a genuinely new month from a failed read. */
export async function loadMonth(dir, month, live) {
  try {
    const rows = parse(await readFile(fileFor(dir, month), "utf8"));
    if (rows.length) return { rows, source: "cache" };
  } catch { /* not cached */ }
  try {
    const r = await fetch(`${live}/data/grading/archive/${month}.jsonl?t=${Date.now()}`);
    if (r.ok) {
      const rows = parse(await r.text());
      if (rows.length) return { rows, source: "live" };
    }
  } catch { /* site unreachable */ }
  return { rows: [], source: "empty" };
}

/** May a month be overwritten with `found` rows when state remembers `known`?
 *
 *  Pulled out of save() as a pure function for one reason: it is the only thing
 *  standing between a failed read and months of deleted evidence, and with no Node
 *  on the machine this file is written on, a function that touches the disk cannot
 *  be tested at all. This one can.
 *
 *  Equal is allowed — a run that grades nothing re-writes the file unchanged, which
 *  is required, because data/ is rebuilt from scratch and a month not written now
 *  disappears from the next deploy. */
export const shouldWrite = (found, known) => found >= (known || 0);

/** Existing rows plus new ones, newest kept on a clash, ordered by kick-off.
 *  A match can be graded twice — a re-grade must correct its row, not add a
 *  second one, or every per-match tally drawn from this file double-counts it. */
export function merge(existing, fresh) {
  const by = new Map();
  for (const r of existing) by.set(String(r.id), r);
  for (const r of fresh) by.set(String(r.id), r);
  return [...by.values()].sort((a, b) => String(a.ko || "").localeCompare(String(b.ko || "")));
}

/** Write the months this run touched. `counts` is state's memory of how many rows
 *  each month had when it was last written successfully; it is updated in place.
 *
 *  Returns a report: what was written, and what was REFUSED because the load came
 *  back short of what state remembered. A refusal is not an error to swallow — it
 *  means this run could not see the archive, and the caller must say so loudly. */
export async function save(dir, live, rowsByMonth, counts) {
  await mkdir(dir, { recursive: true });
  const written = [], refused = [];
  for (const [month, fresh] of Object.entries(rowsByMonth)) {
    const { rows, source } = await loadMonth(dir, month, live);
    const knew = counts[month] || 0;
    // Short of what we remember = we are not looking at the real file. Writing the
    // merge here is what would destroy history, so don't.
    if (!shouldWrite(rows.length, knew)) {
      refused.push({ month, found: rows.length, expected: knew, source });
      continue;
    }
    const all = merge(rows, fresh);
    await writeFile(fileFor(dir, month), all.map((r) => JSON.stringify(r)).join("\n") + "\n");
    counts[month] = all.length;
    written.push({ month, rows: all.length, added: all.length - rows.length, source });
  }
  // Months this run had no new rows for still have to be REWRITTEN, because data/
  // is rebuilt from scratch and anything not written now vanishes from the next
  // deploy. Nothing is merged into them — they are copied forward as they are.
  for (const month of Object.keys(counts)) {
    if (rowsByMonth[month]) continue;
    const { rows, source } = await loadMonth(dir, month, live);
    if (!shouldWrite(rows.length, counts[month] || 0)) {
      refused.push({ month, found: rows.length, expected: counts[month] || 0, source });
      continue;
    }
    if (!rows.length) continue;
    await writeFile(fileFor(dir, month), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    counts[month] = rows.length;
    written.push({ month, rows: rows.length, added: 0, source });
  }
  return { written, refused };
}

/** Every month present on disk, for the summary line. */
export async function months(dir) {
  try {
    return (await readdir(dir)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 7)).sort();
  } catch { return []; }
}
