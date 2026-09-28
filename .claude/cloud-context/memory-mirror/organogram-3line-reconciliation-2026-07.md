---
name: organogram-3line-reconciliation-2026-07
description: "How the sales organogram is actually built, learned reconciling all 3 lines to the owner's fixed structure. CRITICAL: the areas table is NOT partitioned per line — one physical area row is staffed by one rep from EACH of Anti Infective, Pedia and CNS at once, and areas.line_id marks only which line's naming owns the row, so NEVER 'fix' a shared area by changing its line_id. And the org chart has FOUR layers that must ALL reconcile — filled seats, vacant seats, manager parenting, and ghost (stale non-open) vacancy cards — so a fix that touches only employees.area_id leaves the chart still looking wrong."
metadata:
  node_type: memory
  type: project
  originSessionId: 0ac40777-29b1-46d4-9f33-552b74b6673b
  modified: 2026-09-26T00:32:44.559Z
---

The owner (CEO side) gives an authoritative "fixed structure" (job_title × area, per line) the live
organogram must match exactly and permanently: **areas/seats are constant, only people are variable** —
a resignation or vacancy never removes a seat ([[organogram-vacancy-occupancy-truth]],
[[never-change-the-organogram-skeleton]]). (The 2026-07-06 reconciliation of all three lines shipped and
was verified live; its specific seat counts are long superseded by later org moves — do not quote them.)

## 🔴 Shared geography — the load-bearing design fact

The `areas` table is **NOT partitioned per line** for scope. The **same physical territory (one
`area_id`) is routinely staffed by one rep from Anti Infective, Pedia AND CNS simultaneously** (Cairo East
2, the Dakahlia areas, Alex East, the Gharbia areas, Kafr El-Sheikh… each carried three reps, one per
line, on the identical `area_id`). **`areas.line_id` marks only which line's naming convention "owns" that
row — not who may staff it.** **Never "fix" a shared area by changing its `line_id`** — that breaks the
other two lines' org charts.

Only two things are ever real defects (the third looks like one and is not):
1. **Double-booking** — two people from the *same* line on one generic row when the structure wants a
   split. `team_id` already encodes which is which (team-code suffix, e.g. `qena_1_…`/`qena_2_…`); use it
   to disambiguate and split.
2. **Name mismatch** — a rep's displayed area name isn't what THAT line calls it (a Pedia rep showing
   "Gharbia (1)" when Pedia's structure calls it "Mahalla").

**The fix pattern: repoint the rep to that same line's OWN already-seeded row of the correct name; create
a new row only when it is genuinely missing; and never touch a shared row's `line_id`.** An org migration
should be idempotent, keyed by `areas.code` (globally unique) with FROM-join guards so `area_id` is never
nulled when a target row is absent (re-applies as a true no-op).

## 🔴 The org chart has FOUR layers — reconcile ALL of them

Fixing one layer and declaring victory is why "nothing changed in the organogram" survived migration after
migration. `getVacancyReport` / `org-chart.tsx` render all of these together:

1. **Filled seats** (`employees.area_id`). Fixing only this makes filled cards right and leaves vacant
   cards stale.
2. **Vacant seats** (`position_vacancies`; status ∈ {open, filled, cancelled}, `vacancy_code` UNIQUE,
   `manager_hr_id` FK→employees). The chart draws filled seats PLUS open vacancies. Reconcile both:
   `filled_count + open_vacancy_count == structure_seat_count`, AND no area is both filled and open in the
   same line. Manually-seeded structural vacancies (`VAC-…`, null manager while that DSM is vacant) are an
   established, safe pattern.
3. **Manager parenting (tree grouping).** The chart nests each seat under its `manager_hr_id`; a seat
   pointed at the NSM or null floats loose instead of grouping under its district DSM. Audit: list every
   MR seat (filled + vacant) whose parent's job_title is NOT 'District Sales Manager'. Legitimate
   exceptions are **acting-DMs** (an MR whose `manager_hr_id` bypasses the DSM straight to the NSM and who
   has her own direct reports — owner-confirmed as the intended permanent arrangement, NOT a pending
   promotion; [[acting-dm-authority-is-app-role-not-job-title]]) and a genuinely vacant-DSM district.
4. 🔴 **GHOST vacancy cards.** The organogram filter passes ANY vacancy row that classifies as a
   sales-structure role (including `medicalRep`) to the chart **even when `status = 'filled'` or
   `'cancelled'`**. A stale `filled` MR-vacancy with no matching live employee in its slot survives as a
   phantom VACANT card and inflates the line's MR count. **A `status='open'`-only SQL query MISSES these
   (they are `filled`) — audit ghosts against the actual `/api/reports/organogram` payload (a worktree
   dev-server + dev-auth), not against SQL counts.** The durable code fix is `&& level !== "medicalRep"` in
   the filter, excluding non-open MR vacancies entirely.

## Verification note

`pg_class.relkind` is the authoritative catalog — trust it over `pg_matviews` if they disagree
(`v_active_organogram` read as a matview in `pg_matviews` but `relkind` said plain view `'v'`). Browser
verification uses local dev-auth (`GET /api/dev-auth?role=Super Admin`) against the prod DB — the live
authenticated page can't be driven (no password entry).
