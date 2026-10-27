---
name: the-ceo-is-not-a-district-and-a-picker-is-not-wider-than-its-viewer
description: "Owner rules 2026-08-28 — the CEO never holds an assigned doctor list, and a coverage filter bar must never offer more than the viewer's own scope."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9fb33483-9e95-4e1b-b031-175186fde22c
  modified: 2026-08-28T13:29:21.399Z
---

Both reported by the owner on **2026-08-28**, minutes apart, on the Doctor Coverage board.
Fixed in [PR #2584](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2584).

**1. "Anyone can filter by any line… and can choose any region and anything."**
A filter bar must never offer more than the viewer's access scope. `loadCoverageFilterTree`
(`src/lib/crm/coverage-filters-data.ts`) reads the whole org **once, cached under one key for
everybody** — correct for a cache, wrong to hand a picker. Every coverage page passed it through, so
a Medical Rep scoped to his own panel saw all ~73 rep **names** in the company, and a District
Manager could pick any region in Egypt. `restrictCoverageFilterTree` now narrows it per viewer in
memory, so the cache stays one entry.

**The data was never wide** — the scope is applied inside `getSfeDoctorCoverage` and the territory
filter is intersected after it. So a too-wide picker does not leak numbers; it produces an **empty
board**, which on a coverage board reads as *"that team covered nothing"*. That misreading is the
real damage and is exactly what the cell model in `coverage-filters.ts` exists to prevent.

**2. "I see the CEO have assigned visits appeared in the district manager page… He never assigned
to visits."**
The district walk gives a row to **every** ancestor, so it climbed to `AA` (Anwar Gaweesh, the only
active employee with a null `manager_hr_id`; all three active NSMs report to him) and showed the
board's scope as though it were his own doctor panel. Two rules now, both **structural, never a
job-title match** — job titles here are free text and misspelt enough to hide 9 of 27 DMs:

- **The root of the reporting tree gets no manager row.** It is the company; the totals already say
  that. Recognised as *nobody above AND other managers below* — production has **19** blank
  `manager_hr_id` rows but only **one** active, so the second half is what keeps a blank-managered
  real district (four departed DSMs sit in that 19) from being deleted with it.
- **The walk stops at the viewer's own seat.** Above the viewer a row can only be his own numbers
  under someone else's name.

**Why:** an owner opening this board reads a named row as a claim about that person. Naming the CEO
as holder of a doctor panel, or offering a rep the whole company roster, are both the system
asserting something untrue — and the empty-board version is *worse* than a visible error because it
looks like a real zero.

**How to apply:** any new board with an access scope must pass that scope to its **picker** as well
as its query — assume they are separate paths, because here they were. And never build a
manager/rollup row for the top of an org tree. Pinned by `tests/crm-coverage-filters.test.ts` and
`tests/doctor-coverage-districts.test.ts`, both registered in `tests/run-tests.ts`.

Related: [[crm-boards-key-the-same-rep-two-different-ways]] ·
[[au-org-tree-is-sales-only]] · [[never-change-the-organogram-skeleton]]
