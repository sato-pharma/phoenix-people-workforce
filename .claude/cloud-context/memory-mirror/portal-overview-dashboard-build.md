---
name: portal-overview-dashboard-build
description: "Employee-portal Overview redesign (attention inbox, my-requests, pacing, weekly+monthly trend, double-visit, expense, alerts); shipped as PR #444, CLOSED 2026-06-26 as obsolete — see update note."
metadata: 
  node_type: memory
  type: project
  originSessionId: 7d626d56-5dbd-4496-bddc-4125e3e0da4e
---

Redesigned the employee-portal home (`MedicalRepOverviewPage` in src/components/employee-portal/employee-portal-dashboard.tsx) into a glanceable Overview. Kept IdentityCard unchanged. Upgraded `MyActionsPanel` → "Needs Your Attention" (reads `overview.attentionInbox`). Added `MyRequestsStrip`, `TargetPacingChip`, `AlertsFeedPanel`, `ExpenseOverviewPanel`, `SalesPerformanceOverviewSection` (weekly lazy + monthly from payload), `DoubleVisitInsightsSection` (lazy, managers). Deep analytics (territory/line/product/family/top-products/org) RELOCATED to the full Sales page (`MedicalRepSalesPage`) — kept used + decluttered home.

Server: `getPortalAttentionInbox(access,{myRequests,expenses})` + marketing added to `getMyRequestItems` in src/lib/action-center/service.ts (composes scoped vacation/excuse via getAwaitingMyActionItems "portal" + marketing approver inbox + plan approvals by managerHrId + team expenses !hrApproved + returned-to-me; never widens the locked Actions-Center audience). `computeSalesPacing` + optional `overview.{attentionInbox,myRequests,pacing,alerts}` in src/lib/employee-portal/service.ts. New lazy API routes app/api/portal-overview/{weekly-trend,double-visit} (reuse `resolveWeeklyAccessScope` + `getDoubleVisitDashboardData`; registered in src/lib/security/access-registry.ts as employee_profile:read). GOTCHA: a dedicated weekly scope mapper was NOT needed — `resolveWeeklyAccessScope(ctx)` already exists. GOTCHA: `PayrollExpenseApproval` lives in @/lib/payroll/types (not /expenses); never name a var `module` (Next lint).

State (2026-06-21): ALL gates green — typecheck/lint/230 unit tests (incl new tests/portal-overview-pacing.test.ts)/production build; dev liveness OK. NOT committed/pushed (needs approval). Branch `codex/portal-overview-dashboard` off origin/main @2b2eb52f, in worktree F:\Phoenix Workforce\_wt-portal-overview (has node_modules + .env.local → PRODUCTION ref ozucdzovmcqvepbozvqf). Visual role-by-role smoke deferred to a Vercel preview because local env = prod. CRITICAL: the primary tree F:\Phoenix Workforce\phoenix-workforce is actively churned by parallel sessions — it was branch-switched under me mid-edit and wiped my first attempt; do all work for this feature in the worktree, never the primary. See [[parallel-session-swarm-hazard]].

**UPDATE 2026-06-26 — closed as obsolete.** PR #444 closed; `PortalCommandCenter` was missing all three widgets.

**UPDATE 2026-06-27 — FULLY SHIPPED via PR #552.** The three missing widgets (Month Pace / pacing projection, Trend 4 Mo. mini bar chart, Double Visits pulse) were rebuilt fresh against `PortalCommandCenter` + `home-snapshot.ts`. Squash-merged to main. `PortalHomeSnapshot` now carries `monthlySalesTrend` and `doubleVisitPulse`; all three queries fire in parallel at function start.
