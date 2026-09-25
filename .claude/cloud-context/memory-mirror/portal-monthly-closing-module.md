---
name: portal-monthly-closing-module
description: "New employee-portal Monthly Closing page mirrors admin /sales/monthly-closing, published-gated + scoped per role"
metadata: 
  node_type: memory
  type: project
  originSessionId: ff84be1b-c3f9-40fd-b34e-12e57fe41aa6
  modified: 2026-08-04T15:39:29.889Z
---

Built `/employee-portals/monthly-closing` — the portal render of the admin `/sales/monthly-closing` **Closing Matrix + Details** view, scoped per viewer. Branch `codex/portal-monthly-closing` in worktree `_wt-portal-monthly-closing` (off origin/main ed8a18da). Requested 2026-07-30: "add the same as /sales/monthly-closing in the employee portal NSM DM RM and everyone based on his scope."

**Owner decision: PUBLISHED-ONLY** (not live). Uses `loadPortalMonthlyClosing` (publish-gated via `monthly_closing_publications`), NOT `loadPortalLiveMonthly`. Honors the admin Publish button + hero promise. If nothing published → honest "Awaiting publish" empty state.

**Backend already existed** — `src/lib/sales/monthly-closing-portal.ts` (`loadPortalMonthlyClosing`, `canAccessPortalClosing`, `PORTAL_CLOSING_ROLES`) did all scoping (line/region/seat-area/product + confidential strip). Only the PAGE was missing; the portal previously had just the *analytics* dashboards (by-employee/by-line), a different presentation. I added `canAccessPortalClosing` was defined-but-unused → now the page's gate.

**New files:** `app/employee-portals/monthly-closing/page.tsx` (server), `src/components/sales/portal-monthly-closing-view.tsx` (client). Reuses production-proven `ClosingMatrixTable` + `ClosingDetailsPanel` + `MonthlyClosingFilters`.

**No new API** — month switch = `?period=` server nav; Details reuses `/api/sales/monthly-closing/details`, Export reuses `/api/sales/monthly-closing/export` (both already scoped). Avoided access-registry churn.

**Roles:** DM/RM/NSM/PM/GPM. Added legacy **"Manager"** alias to `PORTAL_CLOSING_ROLES` (mirrors PORTAL_CORE_ANALYTICS_ROLES). Excludes Marketing Manager (Head-Office line) + Medical Rep (no line).

**Nav has FOUR sync points** (see [[portal-nav-registry-one-way-sync-test]]) — all wired for `showMonthlyClosingTab`:
1. `src/lib/employee-portal/navigation.ts` (flag type + resolver)
2. `src/components/employee-portal/employee-portal-layout.tsx` (sidebar `buildEmployeePortalSections`)
3. `src/config/system-navigation.ts` employee-portal `sales-operations` catalog — REQUIRED by `employee-portal-nav-catalog-sync.test.ts` (layout href must be in catalog or KNOWN_UNCURATABLE)
4. `src/components/employee-portal/employee-portal-nav-registry.ts` (mobile bottom-nav) — guarded by `employee-portal-bottom-nav.test.ts`

**Test trap:** `employee-portal-navigation.test.ts` has a `deepEqual` asserting Marketing Manager visibility == GPM except an override list. New flag differs (MM false/GPM true) → had to add `showMonthlyClosingTab` to that override or it fails.

Validated: typecheck ✓, lint ✓, 479→480 test files ✓, build ✓ (route compiled into .next). **Committed + pushed + PR #1497** opened against main (owner approved delivery).

**PR conflicted on open** — origin/main had advanced 4 commits (#1489 portal nav ROI/Territory, #1491, #1493 Targets, #1492) that touched the SAME nav files. Merged origin/main into the branch (NOT rebase — avoids force-push): auto-merged layout/navigation.ts/system-navigation.ts/tests, ONE hand-resolved conflict in `employee-portal-nav-registry.ts` (both sides inserted sales entries after SoS). Kept ALL of main's new registry entries + placed Monthly Closing between Weekly and Sales Analytics. Re-validated: 480 tests ✓, typecheck ✓. Merge commit 45e30c66. Lesson: a same-day feature touching portal nav files WILL conflict with the parallel nav churn — expect a merge before the PR goes green.

**Browser-verified against PROD data** (dev server from worktree on :3001, dev-auth with real hrId): only ONE published closing exists in prod — **CNS line, 2026-05** (`monthly_closing_publications`). Impersonated CNS NSM **B-122** (line_id=3) → full matrix (896KB, 48 area rows, Closing Matrix+Details+Export, locked line CNS / month 2026-05). CNS DM **B-116** → narrower scope (266KB, 5 area rows) = "everyone based on his scope" proven. dev-auth by ROLE alone gives synthetic identity with no line → "No line on file" empty state (pass hrId= to impersonate a real employee). Employees resolve line via line_id→lines.name (employees.line_name col is blank for CNS).
