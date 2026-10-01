---
name: rm-dsm-portal-provisioning-gaps
description: "Regional Manager is under-provisioned vs District Manager in the employee portal — empty landing (no getRoleSpecificExtras RM branch), plans paradox, missing team/vacancy/probation tabs — and RM sales region scope is resolved 4 inconsistent ways. Analysis 2026-07-30; no edits made."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0c89c9a5-f1c8-425b-89b2-be9cac82f4a2
  modified: 2026-10-01T00:00:00.000Z
---

Deep-dive (2026-07-30, read-only, no code changed) into what RM (`Regional Manager`)
and DSM (`District Manager`) see in the employee portal and what their landing
dashboards should show.

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

**Live portal tab diffs:** RM-only = Weekly/Monthly Plan, Planning Calendar, Direct
Orders Approvals (RM is an approval rung; DSM isn't), + deeper Sales Analytics
(Executive Comparison + Reconciliation, portal-access.ts:41 `canViewPortalDetailedAnalytics`).
DSM-only = Team Performance, Team Coaching, Vacancies, Probation Tracker (all gated on
`isDistrictManager`).

**Plans paradox (confirmed current):** `WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES`
(src/lib/weekly-planning/plan-v1.ts:135) includes "District Manager", **excludes
"Regional Manager"**. But navigation.ts `showPlansTab` shows RM the builder link and
omits DSM. Net: RM sees the Plans link → submit = "Forbidden: not eligible"; DSM can
submit but has no live builder link. Backwards. See [[dsm-plan-eligibility-fix-and-rm-gap]].
Open owner decision needed: should RM SUBMIT its own weekly/monthly plan, or only APPROVE?

**RM has NO `vacancies` permission** (matrix, permissions.ts:627-650); DSM + NSM do. The
portal-min floor can't restore it (floors only protect grants a role already has). RM also
holds `probation:[read]`/`coaching:[read]`/`organogram:[read]` but gets no tab for any.

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

**Recommendation (not built):** give RM a "Region Command Center" mirroring the NSM board at
region scope — Region KPI grid + "My Districts" DSM leaderboard + attention row (districts below
target, vacant DSM seats, region-scoped DV focus + `nsm-crm-compliance.ts` first-visit compliance).
Feasible by adding an RM branch to `getRoleSpecificExtras` reusing `buildDsmPerformanceForLineScope`
bounded by `regionsWithinManagerHierarchy`, and standardizing every RM sales surface on the correct
SoS subtree-region resolution. See [[portal-overview-dashboard-build]], [[ceo-field-sales-parity]],
[[pm-gpm-vacancy-line-scope]].
