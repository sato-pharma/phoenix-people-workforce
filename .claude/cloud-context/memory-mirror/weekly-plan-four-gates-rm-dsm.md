---
name: weekly-plan-four-gates-rm-dsm
description: "Weekly/monthly plans and portal team-views each have 3-4 independent gates that must agree; RM+DSM plan submit fixed 2026-07-30 (RM added to eligibility allowlist, DSM added to showPlansTab)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0c89c9a5-f1c8-425b-89b2-be9cac82f4a2
  modified: 2026-07-30T01:36:04.240Z
---

Owner ruling 2026-07-30: **both Regional Manager (Hany Saad, PD-0001) and District Managers must be
able to submit AND respond to weekly/monthly plans.** Implemented in worktree `_wt-rm-region`,
branch `codex/rm-region-command-center`.

**The gates (all must agree, they are maintained separately):**
1. `defaultPermissionMatrix` `weekly_plans` row (`src/lib/auth/permissions.ts`) — RM + DSM already had
   `["read","create","update","approve"]`.
2. Sidebar flag `showPlansTab` (`src/lib/employee-portal/navigation.ts`) — listed RM but NOT DSM.
3. Business-rule allowlist `WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES`
   (`src/lib/weekly-planning/plan-v1.ts`) → `isWeeklyMonthlyPlanEligibleTitle` →
   `canSubmitFromEmployee` — listed DSM but NOT RM.
4. For "respond"/decide: `assertManagerReviewer` + `canViewPlan` (`weekly-planning/service.ts`) key
   ONLY off `plan.manager_hr_id` matching the viewer — no role logic at all.

Net effect before the fix (exactly inverted): RM saw the builder link and got
"Forbidden: this position is not eligible to submit"; DSM was eligible to submit but had NO builder
link. Fix = add `"Regional Manager"` to gate 3 + add `"District Manager"` to gate 2, and flip the
`isWeeklyMonthlyPlanEligibleTitle("Regional Manager") === false` assertion in
`tests/weekly-monthly-plans-v1.test.ts` to true.

**"Respond" needed no code change** — gate 4 is pure org assignment, so an RM already decides their
DSMs' plans (RM is their `manager_hr_id`) and a DSM already decides their reps'. Both roles already
had `showPlanApprovalsTab`.

**Job-title mapping matters:** Hany's real `job_title` is "Regional Sales Manager", not
"Regional Manager". `resolveJobFunctionRole` maps `"regional sales manager" → "Regional Manager"`
(`src/lib/employees/job-function.ts`), so the allowlist hit works — but always verify the title→role
mapping when gating on a title, don't assume the DB stores the PhoenixRole string.

**Same 4-gate trap hit Team Coaching:** `resolveEmployeeCoachingPortalMode`
(`src/lib/coaching/portal-access.ts`) returned the "team" view for DSM/NSM only, so enabling the RM
sidebar flag alone would have dead-ended on an empty state. RM added there too. Probation, by
contrast, was genuinely nav-flag-only (its page + `canReadProbationEmployee` already handle RM).

**How to apply:** for any "role X can't do Y though the sidebar shows it", enumerate ALL gates
(matrix row, nav flag, business allowlist, page-level mode resolver) before concluding.
See [[dsm-plan-eligibility-fix-and-rm-gap]] (superseded by this), [[rm-dsm-portal-provisioning-gaps]],
[[job-title-not-a-permission-source]].
