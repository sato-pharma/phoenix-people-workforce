---
name: ungraded-sales-have-three-causes-only-one-is-big
description: "Sales with no target split into three causes and only two are defects — an Other bucket is deliberately untargeted (carries_target = false, exactly 1:1 with is_other), while 2.1M EGP carries a district but no area at all and can never be graded. Also: au.line_area_map holds no history before 2026-07-13, so any period-correct join to it silently falls through for January and February."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1e92ac6c-8bb7-4d65-855c-6c7ae9cf22de
  modified: 2026-08-23T05:13:24.154Z
---

Measured on production 2026-08-23 across 2026-01, 02, 07 and 08. Before treating "ungraded sales"
as a data gap, split it — most of it is not one.

| Cause | Ungraded EGP | Rows | Is it a defect? |
|---|---|---|---|
| **A. `area_code IS NULL`** — carries a district, sometimes only `NATIONAL`, but no area | **2,119,551** | 66 | **Yes, and it dominates** |
| B. `is_other` — the Other buckets | 818,497 | 279 | **No — by design** |
| C. Staffed area, no target row | 195,525 | 37 | Yes, but small |

**B is deliberate and provable, not a judgement call.** In `au.line_area_map`, `carries_target` is
`false` for every `other_permanent` / `other_line_specific` area and `true` for every `occupied` /
`vacant_will_hire` one — a clean 1:1 with `is_other`, 43 Other rows against 107 staffed. So ~818K of
what looks like a hole is the system working. Do not raise it as a gap, and do not ask the owner to
review 279 rows of it.

**A is the one that actually moves a number.** These sales can never match a target, because a
target is keyed per area. It is exactly why the DM outlier in
[[achievement-numerator-is-covered-actual-not-all-sales]] was so extreme: Salim Salim Abdo Ibrahim
Gomaa read **48.5% for July against a real 2.2%**, and 113,392 EGP of his July sales sit at district
level with no area. February Pedia has 746,206 EGP at `NATIONAL` with no district either.

## `au.line_area_map` has no history — do not join it period-correctly

All **150** rows have `effective_from >= 2026-07-13` (min 2026-07-13, max 2026-08-03). So a lookup
filtered on `effective_from <= period AND (effective_to IS NULL OR effective_to >= period)` returns
**nothing at all** for January or February, and a `LEFT JOIN` then silently classifies those rows
however the `COALESCE` fallback happens to land. This cost a wrong first cut here: 60-odd areas
looked like real target gaps when they were Other buckets.

**Use the engine's own flags instead.** `au.f_monthly_achievement(period)` returns `is_other` and
`area_state` resolved per period via `au.f_seat_occupant_asof`, and they genuinely vary by month —
Fayoum reads `occupied` for Anti-Infective in January and `vacant_will_hire` for Pedia in February.
That is the period-correct signal; `line_area_map` is current state only.

## The calendar holes are separate from all three

`au.monthly_targets` holds only `2026-01, 02, 07, 08, 09`. **March–June 2026 have zero target rows**
— 43,572,462.42 EGP of sales with nothing to grade them against. And **2026-08 and 2026-09 cover
only 2 of 3 lines**: Anti-Infective has no target either month, which is why its August reads 100%
ungraded. Related: [[sos-monthly-closing-is-the-only-sales-truth]],
[[never-silent-drop-count-and-flag-instead]].

Asked as an XLSX with locked dropdowns per the owner's standing rule — 63 answerable cells, not a
list in chat.
