---
name: a-leavers-earlier-months-can-never-be-recovered-by-rerunning-them
description: "A leaver's deduction candidates for months BEFORE the one they left in are unrecoverable — the month's leaver roster is scoped to last_working_date inside that month, and a reconcile that supersedes them creates no replacement"
metadata: 
  node_type: memory
  type: project
  originSessionId: de3d5355-ce2f-47ce-91e5-037397fd3f85
  modified: 2026-08-23T17:22:35.975Z
---

`loadLeaversInPeriod(month, year)` in `src/lib/deductions/connectors/crm.ts:240-250` selects
`employee_resignations` with **`last_working_date` between the 1st and the last day of THAT month**.
So an employee who left on 09 August is in **August's** leaver roster and no other. A July
collection run cannot produce her leaver candidate — the roster it builds does not contain her.

The settlement route closes the other door: it refuses any month except the one the employee
actually left in (proved live against B-52 — *"left on 2026-08-09, which is not in 07/2026"*).

**So a leaver's earlier months have NO automated route back**, and a reconcile can strip them:

Soad Atef (`AI-0003`, last day 2026-08-09, Anti Infective medical rep) had a July 2026 candidate of
**18 days / 9,580.65 EGP**, correctly computed. A July collection run at **2026-08-11 09:21 Cairo**
superseded 24 rows across 20 employees and recreated 26 across 24 — leaving **12 employees with
nothing live**, ~15,976 EGP erased in total. Soad's 9,580.65 was **60% of it**; the next largest was
1,354.84. The row's own `superseded_by_candidate_id` was **null** — the system recorded that nothing
replaced it.

**Restored by hand on 2026-08-23, on the owner's instruction** — new candidate
`d6a9697a-0339-4119-95d7-51830bdfbcc1`, `created_by = 'july-restore-superseded-11aug'`, reusing the
original `candidate_key` so it restores the row's *identity* rather than adding a look-alike (the
unique index `deductions_candidates_live_key_idx` is on `(category, candidate_key) WHERE
superseded_at IS NULL`, so the superseded original does not block it). July live rows 106 → 107.
The 18 days were re-verified first: **none of the 18 charged dates has any visit today**. The
superseded original was deliberately NOT edited — writing the new id into its
`superseded_by_candidate_id` would falsely imply the 11 Aug run created it.

**This restore is not durable.** `locked_at` is null (setting it would falsely mark the row
published, and nothing has ever been published), so another July collection run would supersede it
again by the same mechanism. If July is ever re-run, re-check her afterwards.

**Also verified in the same pass, and worth keeping separate:**

- **June 2026 has no CANONICAL candidates — but it was NOT unassessed.** Corrected 2026-08-23, same
  day the wrong version was written. `deductions_candidates` (plural, canonical) holds **only July
  and August**: April, May and June are all 0, because the module's first row ever is
  `2026-08-01 09:55 UTC`. Those months predate it. The **legacy** engine
  `deduction_candidates` (SINGULAR — see [[two-live-deduction-engines-p0]]) did run June: 66 live
  candidates / 57 employees. Always check BOTH tables before calling a month uncollected.
- **`deductions_publications` is empty** — nothing has ever been published, any month.
- **The leaver path does NOT filter by `visit_type`** (`if (dayVisits.length === 0)`, crm.ts:347,
  *"A day with ANY recorded visit is never no activity"*). So the
  [[campaign-visits-make-a-working-rep-look-like-a-zero]] trap does **not** bite here — campaign
  (-8) days are correctly credited as activity. Do not "fix" that; it only applies to plan-vs-actual.

**Why:** the leaver settlement is the last chance to charge anything — after it, the money is gone.
A month that was erased, or never collected, looks identical on the Pending screen to a month with
genuinely nothing to charge: absent. Soad's screen showed 3,991.94 EGP when the real exposure was
roughly 24,000.

**How to apply:** before settling any leaver, check every month they were employed, not just the
leaving month — `select month, count(*), sum(estimated_amount) filter (where superseded_at is null)
from deductions_candidates where upper(employee_hr_id) = '<ID>' group by month`. A month with rows
that are all superseded is a red flag, not an empty month. Recovering one needs a deliberate manual
insert; there is no button. Related: [[crm-connector-leaver-branch-attaches-no-employee-name]],
[[one-part-employees-have-no-part-2-for-deductions-to-land-in]],
[[never-auto-publish-deductions-owner-confirms-first]].
