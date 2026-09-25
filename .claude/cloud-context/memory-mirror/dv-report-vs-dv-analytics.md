---
name: dv-report-vs-dv-analytics
description: "Two DIFFERENT double-visit portal modules; don't confuse them. Plus the portal sidebar's real source."
metadata: 
  node_type: memory
  type: project
  originSessionId: 59caaa59-c943-4f4b-8072-d31b50d3ef10
---

`/employee-portals/double-visit-report` and `/employee-portals/double-visit-analytics` are **two separate modules** — easy to confuse.

- **Double Visit Report** (`double-visit-report/`, page + `double-visit-report-workspace.tsx`): portal report reading LIVE data via `getDoubleVisitReportData`. Access gate = `DV_FOCUS_ROLES` (DSM/RM/NSM/PM/GPM/TM, defined in `src/lib/employee-portal/home-snapshot.ts`) + `canAccess(double_visit_analytics,read)`. Tabs: Visit Log / Never Visited / Probation.
- **Double-Visit Analytics** (`double-visit-analytics/`): Sales Intelligence dashboard reading a PUBLISHED snapshot via `getDoubleVisitDashboardData`. Roles: PM/GPM/MM (+TM). Has admin import/publish.

Both share `resolveDoubleVisitAccessScope` in `src/lib/double-visit-analytics/service.ts` — editing it affects BOTH. NSM was `all:true` (company-wide); changed to fall into the descendant-chain path (his scope) on 2026-07-05.

The **employee-portal sidebar is built in `employee-portal-layout.tsx` `buildEmployeePortalSections`**, NOT `system-navigation.ts` (that drives the admin shell). A route being in `system-navigation.ts` + `DV_FOCUS_ROLES` does NOT put it in the portal sidebar — you must add it to `buildEmployeePortalSections` + a `show*Tab` flag in `navigation.ts` + `PORTAL_NAV_REGISTRY` (bottom nav). See [[portal-sidebar-real-source]].

Work delivered on branch `codex/dv-report-nsm` (worktree `_wt-dv-report`) off origin/main: NSM sidebar link + his-scope + pagination(20)/no-export/frozen-headers/advanced-filters. Note: primary checkout branch `codex/agents-policy-v2` is ~136 commits behind main and lacks this module — never build DV work there.
