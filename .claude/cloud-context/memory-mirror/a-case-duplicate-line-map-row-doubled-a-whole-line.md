---
name: a-case-duplicate-line-map-row-doubled-a-whole-line
description: "au.sos_official_line_map held 'Anti infective' AND 'Anti Infective'; the join lowercases both sides, so every Anti Infective fact row matched TWICE and any attribution refresh doubled the line — fixed 2026-08-26 with a unique index on lower(btrim())"
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-26T16:23:31.463Z
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
---

**Found 2026-08-26 while backfilling the EZ even-split rule; unrelated to it, and it had been armed
for weeks.** `au.f_monthly_attribution(period)` joins the fact rollup to the line map with
`lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))`. The table held **two** rows that
collapse to the same key:

| official_line | line_code |
| --- | --- |
| `Anti infective` | `anti_infective` |
| `Anti Infective` | `anti_infective` |

A case-insensitive join against two colliding rows is a **fanout**, not a tie-break: every Anti
Infective fact row matched both and was emitted twice. Measured before the fix — computed was
**exactly 2×** the fact rollup in all six months and in **both** channels (Jul indirect 4,897→9,794,
direct 2,120→4,240; Feb 9,872→20,058 … Jul 7,017→14,034).

**It had not shipped, and that is the whole danger.** `au.monthly_attribution_rollup` is a stored
cache, last refreshed 2026-08-14, and it still held the correct numbers. The doubling existed only
in the *function*, so it would have landed silently on whoever next refreshed attribution for any
period — including two months whose closings were **locked**. Nothing would have errored.

**Fix:** deleted the redundant `Anti infective` row (production data uses only `Anti Infective`,
11,460 fact rows; the abbreviation `Anti Inf` is a genuinely distinct key and stays), then added
`create unique index sos_official_line_map_lower_uniq on au.sos_official_line_map
(lower(btrim(official_line)))` so the collision cannot come back. Pre-image in
`ez_split_backup_20260826.sos_official_line_map_preimage`. After the fix Mar–Jul computed matches
stored **exactly, delta 0.00 on every line**.

**This corrects [[anti-infective-canonicalization]].** That 2026-07-18 sweep inspected this very
column and deliberately left it alone, reasoning it was a "pure case-insensitive JOIN matching key
— matches regardless of casing". True for *one* row; for *two* it multiplies. Whenever a join
normalizes a key (`lower`, `btrim`, `upper`, `normalizeAliasKey`), the normalized form is the real
key and needs a unique constraint on the **normalized expression** — a plain PK on the raw text
permits exactly this.

**Why:** an alias/mapping table is a join multiplier, so a duplicate there scales a whole line's
sales rather than producing a visible error.

**How to apply:** before trusting any rebuild of a derived rollup, diff *computed vs stored* per
line first and treat a clean integer ratio (2×, 3×) as a fanout, not a data change. Then check every
`left join` in the function for a key that is normalized on both sides. Related:
[[ez-is-credited-evenly-across-cairo-giza-cns-reps]] (the task that surfaced it),
[[n-live-tup-is-stale-use-real-count]], [[how-to-attribute-a-production-write]].
