---
name: dsm-plan-eligibility-fix-and-rm-gap
description: "Weekly/monthly plan submission eligibility is gated by a separate business-rule allowlist in plan-v1.ts, independent of the sidebar and the coarse permission matrix — District Manager fixed 2026-07-18, Regional Manager has the identical gap left open on request"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8cda8957-643e-4932-b4e7-1c66f4a614a1
---

`src/lib/weekly-planning/plan-v1.ts`'s `WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES`
(consumed by `isWeeklyMonthlyPlanEligibleTitle` → `canSubmitFromEmployee`, enforced
in both `getEmployeePlansWorkspace` and `createEmployeePlan` in
`weekly-planning/service.ts`) is a THIRD, independent gate on top of (a) the
sidebar's `roles` array in `system-navigation.ts` and (b) the `weekly_plans`
resource row in the `defaultPermissionMatrix` (`permissions.ts`). A role can have
(a) and (b) fully correct and still be hard-rejected by (c) — this is exactly what
was wrong for District Manager (DSM) before PR #1120 (2026-07-18): sidebar showed
the "Weekly / Monthly Plans" link, permission matrix already granted
`weekly_plans: ["read","create","update","approve"]`, but plan-v1.ts's allowlist
only had Product Manager / Group Product Manager / Marketing Manager / Training
Manager / National Sales Manager — DSM hit "Forbidden: this position is not
eligible to submit weekly/monthly plans." on actual submit.

Fixed by adding `"District Manager"` to that allowlist — a one-line change, since
the workweek model (`fieldForceRoleSet`), permission matrix, sidebar, and
manager-approval routing (`assertManagerReviewer`/`canViewPlan`, keyed off
`plan.manager_hr_id` via `hrIdsMatch`, not role) all already worked correctly for
DSM once the allowlist gate was open.

**Regional Manager has the identical, still-open gap.** Sidebar (`system-navigation.ts`
roles arrays for both `/employee-portals/plans` and the plan-approvals nav entries)
and the permission matrix both already include Regional Manager, but plan-v1.ts's
allowlist still excludes it, and `tests/weekly-monthly-plans-v1.test.ts` has an
explicit `isWeeklyMonthlyPlanEligibleTitle("Regional Manager") === false` assertion
proving this is currently deliberate/tested. Left untouched in PR #1120 because
only DSM was requested — flagged to the owner as a one-line follow-up if wanted.

**How to apply:** if a future ask is "role X can't submit/see/do Y even though
the sidebar shows it," check ALL THREE gates (nav roles array, permission matrix
resource row, and any business-rule allowlist/title-classifier layered on top)
before concluding it's a sidebar bug — the sidebar is very often already correct
and the real gate is a narrower, separately-maintained allowlist like this one.
See also [[job-title-not-a-permission-source]] for the general anti-pattern this
resembles, and [[weekly-plan-approvals-in-action-center]] for the surrounding
module context.
