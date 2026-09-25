---
name: a-third-of-target-carrying-territories-have-no-rep
description: "33 of 107 territories that carry a sales target have NOBODY in the rep seat — any territory picker built from carries_target shows a third empty"
metadata: 
  node_type: memory
  type: project
  originSessionId: ee8e1dd7-5943-412c-9063-b9a3827f3d74
  modified: 2026-08-21T07:53:33.197Z
---

Measured on production 2026-08-21, from `au_v_line_area_map` (live rows, `carries_target = true`)
joined to `au_v_employee_seat_drift`:

| | cells |
| --- | --- |
| Region × line × area cells carrying a sales target | **107** |
| …with a REP actually seated | **74** |
| …**with nobody in the seat** | **33 (31%)** |

**Why it matters:** "carries a target" and "has a rep" are different questions, and a third of the
map answers them differently. Anything built from `carries_target` alone — a territory picker, a
coverage board, a per-area scorecard — will show a third of its entries resolving to **zero
people**, which on screen reads as *"this territory covered nobody"*: a plausible, damning,
completely wrong reading of what is actually an empty chair. This is the trap that produced 75
dead-end filter combinations in the CRM coverage cascade before it was found. The fix pattern:
drive the picker from **filled** cells, and surface the vacant ones separately as the business fact
they are (`tree.vacancies` in `src/lib/crm/coverage-filters.ts`, rendered as its own table on the
brick board).

**The derivation was checked, not assumed** — and this is the part worth not re-deriving. Deriving
"vacant" from seat occupancy agrees **EXACTLY** with the org model's own `area_state`: all 33
seat-empty cells are precisely the `vacant_will_hire` ones, all 74 seated cells are `occupied`,
zero rows disagree either way. That agreement was NOT guaranteed in advance —
[[au-area-state-follows-seat-occupancy]] records that **hires do not flow into the au seat model
automatically** (resignations do), so some of these could have been hired-but-unrecorded. As of
2026-08-21 none are.

**How to apply:** when a territory or area list looks suspiciously empty for some entries, check
seat occupancy before assuming a data-join bug or a rep who stopped working. Re-run the
`area_state` comparison rather than re-deriving it — `carries_target` is
`generated always as (area_state in ('occupied','vacant_will_hire'))`, so the two states are a
no-op for targets and incentives and a genuine gap for anything about people.

Related: [[au-seat-drift-view-is-the-org-truth-check]],
[[crm-boards-key-the-same-rep-two-different-ways]],
[[organogram-has-two-data-paths-suppress-only-hits-vacancies]].
