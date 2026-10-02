---
name: rm-dsm-portal-provisioning-gaps
description: "2026-07-30 read-only analysis of Regional Manager vs District Manager in the employee portal; #1477 closed most of it the same day — RM Region Command Center landing, Probation/Team Coaching/Organogram tabs, and the plans paradox (owner ruling: RM AND DSM both submit and respond — RM added to WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES, DSM to showPlansTab). RM still has NO vacancies permission, and RM sales region scope was found resolved 4 inconsistent ways."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0c89c9a5-f1c8-425b-89b2-be9cac82f4a2
  modified: 2026-10-02T16:39:59.753Z
---

Deep-dive (2026-07-30, read-only, no code changed) into what RM (`Regional Manager`)
and DSM (`District Manager`) see in the employee portal and what their landing
dashboards should show. **The same day, PR #1477 (`05d5e751e`, "Regional Manager region command
center + close RM role gaps") acted on it** — the gaps it closed are marked below; the rest stands.

**Routing:** both land `/employee-portals` → `PortalCommandCenter` (portal-command-center.tsx
~1162) switches on role → `DsmCommandCenter` vs `RmCommandCenter`
(src/components/employee-portal/dashboards/). Live sidebar is driven by
`resolveEmployeePortalNavVisibility` flags (src/lib/employee-portal/navigation.ts)
via `buildEmployeePortalSections`, **NOT** `system-navigation.ts`'s
`employeePortalNavigationSections` (declared but never rendered to RM/DSM — a real
drift hazard; the two configs disagree, e.g. DSM gets Direct-Orders-Approvals in the
declared config but not the live one).

**Headline gap — RM landing is emptier than the DSMs beneath it.**
`getRoleSpecificExtras` (src/lib/employee-portal/home-snapshot.ts) has branches
for PM/GPM, Marketing Manager, District Manager, NSM — **no `Regional Manager` branch**,
so RM falls through to `emptyRoleExtras`. RM landing = personal stats (leave, payslip,
my pending requests, plans-awaiting-approval) + hardcoded "Upcoming: nothing scheduled"
+ "Insights coming soon" placeholders + the same line-scoped pacing/DV widgets a DSM
gets. DSM landing has real district analytics (KeycardGrid "District Performance" +
"My Reps" leaderboard from `getDsmTeamPerformance`). RM's `pendingApprovals` is also
computed-but-unrendered on the DSM view (dead data).
**Superseded 2026-10-02:** previously "no `Regional Manager` branch, RM falls through to `emptyRoleExtras`" —
#1477 added the `rmRegional` snapshot and a `Regional Manager` branch in `getRoleSpecificExtras`, and rebuilt
`RmCommandCenter` (Region Performance keycards, "My Districts" leaderboard, Districts Needing Attention, CRM
First Visit board), dropping the "Upcoming"/"coming soon" placeholders.

**Live portal tab diffs:** RM-only = Direct Orders Approvals (RM is an approval rung; DSM isn't)
(Weekly/Monthly Plan and Planning Calendar are now shown to DSM too — `showPlanningCalendarTab` follows
`showPlansTab`), + deeper Sales Analytics
(Executive Comparison + Reconciliation). 🔴 **That Sales Analytics half is DEAD —
the module was retired 2026-09-17 by the owner's Ruling 11** and the gate this line used to name,
`canViewPortalDetailedAnalytics` in `src/lib/analytics/portal-access.ts`, is absent from the whole
tree along with its directory. Do not look for it and do not restore it; two tests in the suite fail
the PR if it comes back. See [[analytics-open-to-all-scoped-plan]]. The rest of this tab diff stands.
DSM-only = Team Performance and Vacancies. RM now also gets Team Coaching and Probation Tracker.
**Superseded 2026-10-02:** previously "RM-only = Weekly/Monthly Plan, Planning Calendar, …" and "DSM-only = Team
Performance, Team Coaching, Vacancies, Probation Tracker" — #1477 added "District Manager" to `showPlansTab`, and
gave RM the Probation Tracker and Team Coaching tabs (and RM in `resolveEmployeeCoachingPortalMode`), and
pinned that RM does NOT gain Vacancies or Team Performance.

**Plans — RESOLVED 2026-07-30 (owner ruling: both RM and DSM must be able to submit AND respond).**
`WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES` (`src/lib/weekly-planning/plan-v1.ts`) now includes "Regional Manager"
as well as "District Manager", and navigation.ts `showPlansTab` lists "District Manager" as well as "Regional
Manager", so the two gates are in lockstep; deciding a plan needed no change (it keys off `plan.manager_hr_id`).
Shipped in #1477. See [[weekly-plan-four-gates-rm-dsm]] and [[dsm-plan-eligibility-fix-and-rm-gap]].
**Superseded 2026-10-02:** previously "plans paradox (confirmed current) — RM excluded from eligibility, DSM
missing from `showPlansTab`; open owner decision needed" — the owner ruled and the fix shipped the same day, per
[[weekly-plan-four-gates-rm-dsm]].

**RM has NO `vacancies` permission** (matrix, permissions.ts:627-650); DSM + NSM do. The
portal-min floor can't restore it (floors only protect grants a role already has). RM also
holds `probation:[read]`/`coaching:[read]`/`organogram:[read]`, and since #1477 gets a tab for each (Organogram at
line grain, like NSM).
**Superseded 2026-10-02:** previously "gets no tab for any" — #1477 added the three RM nav flags.

**RM sales region scope is resolved 4 inconsistent ways** (DSM is consistent = single own
region everywhere):
- SoS portal — correct subtree regions via `regionsWithinManagerHierarchy` (portal-sos-dashboard.ts:170-217). ✅
- Monthly-Closing (the landing "Line Sales Pacing" widget) — `applyRegionScope` fails **OPEN**
  to the whole line when the RM's coarse region label (e.g. "Alexandria + Delta") matches no
  single SoS region (monthly-closing-portal.ts). **VERIFIED** — RM pacing can show
  line-wide numbers labeled as region (bounded to line, never cross-line).
- Weekly — own region + Pedia hardcode {AB,D1,D2}, fail-closed (weekly/access.ts:163-168). agent-reported, verify.
- Analytics — own region, fail-closed to nothing (analytics/scope.ts:60-70). agent-reported, verify.
Root: sales is geography/line-centric, no rep ownership (access-scope.ts:26-30); `canAccessSales`
(permissions.ts:1243) has no HIERARCHY branch (returns false for RM at record level — but it's
effectively dead; RM sales runs through explicit subtree walks / the legacy `sales_records`
plane's `collectHierarchy`).

**Recommendation (BUILT in #1477 for the landing — `getRmRegionalPerformance`, region membership from
`regionsWithinManagerHierarchy`; whether the other RM sales surfaces above were standardised is not recorded
here — verify before relying on them):** give RM a "Region Command Center" mirroring the NSM board at
region scope — Region KPI grid + "My Districts" DSM leaderboard + attention row (districts below
target, vacant DSM seats, region-scoped DV focus + `nsm-crm-compliance.ts` first-visit compliance).
Feasible by adding an RM branch to `getRoleSpecificExtras` reusing `buildDsmPerformanceForLineScope`
bounded by `regionsWithinManagerHierarchy`, and standardizing every RM sales surface on the correct
SoS subtree-region resolution. See [[portal-overview-dashboard-build]], [[ceo-field-sales-parity]],
[[pm-gpm-vacancy-line-scope]].
