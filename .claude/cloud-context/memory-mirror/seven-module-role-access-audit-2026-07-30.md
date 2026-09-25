---
name: seven-module-role-access-audit-2026-07-30
description: "Owner's 7-item role-access sweep (Direct Orders, ROI Tracker, Expenses, Plans, portal CRM, Targets, Territory Mgmt) — findings + 4 PRs #1489/#1491/#1493/#1495. The two-portal-nav-trees trap is the root cause of most gaps."
metadata:
  node_type: memory
  type: project
  originSessionId: c8b118d9-d7e7-4559-a2c4-02262f7b0709
  modified: 2026-07-30T06:47:16.125Z
---

Owner request 2026-07-30: confirm 7 features are visible to every applicable role AND actually
working; fix or mark-as-follow-up any gap; "never skip a step." Built in isolated worktree
`F:\Phoenix Workforce\_wt-seven-modules`, branch stack off origin/main.

## THE ROOT-CAUSE INSIGHT (reuse for any future "role X can't see Y" bug)
The employee portal has **TWO independent nav sources** and only one renders:
- **Rendered sidebar** = `buildEmployeePortalSections` in
  `src/components/employee-portal/employee-portal-layout.tsx`, driven by ~50 booleans from
  `resolveEmployeePortalNavVisibility` (`src/lib/employee-portal/navigation.ts`).
- **Catalog** = the `employee-portal` block of `src/config/system-navigation.ts` — feeds ONLY the
  command palette, document titles, and Modules-Control curatability. **A page catalogued but not in
  the layout renders NO sidebar link** (reachable only by URL / ⌘K). This masked items 2 and 7.
Admin shell is the opposite: `system-navigation.ts` `adminNavigationSections` IS the live sidebar.
Adding a portal route = **3 files** (flag in navigation.ts + render in layout.tsx + entry in
`employee-portal-nav-registry.ts`) + the catalog for curatability. `tests/employee-portal-nav-catalog-sync.test.ts`
and `employee-portal-bottom-nav.test.ts` enforce parity.

## VERDICTS + WHAT SHIPPED
- **Item 1 Direct Orders** 🟡→✅ module was fully live; gap was it never appeared in the combined
  "Other Approvals"/My-Requests/History inbox and had no pending badge. **PR #1491 (MERGED)** added
  `direct_order` to `HistoryApprovalModule` (NOT `ActionHubModule` — the owner-locked rule 2026-07-18
  is the dedicated `/approvals/direct-orders` page is the SOLE approve gate; deep-linking modules
  belong in the wider History union), wired My-Requests via `listMyDirectOrders`, wired the badge via
  the already-written-but-DEAD `countDirectOrderAwaiting` + new `/api/approvals/direct-orders/pending-count`
  + `BATCH_KEY_BY_SRC` + navBadge union, added the missing page guard on `/admin/direct-orders/caps`.
- **Item 2 Marketing ROI Tracker** 🔴→✅ `showMarketingRoiTrackingTab` was computed but never rendered
  (dead flag); page `/employee-portals/roi-tracker` existed. **PR #1489 (MERGED)** rendered it.
- **Item 3 Expenses** 🟢 healthy, no code. `getExpensesScope` (permissions.ts:1207) is coherent.
  Follow-up: `showExpenseDashboardTab` broader than catalog (safe, SELF scope); 3 dashboards exist.
- **Item 4 Weekly/Monthly Plans** 🟢 healthy, no code. Monthly IS real. 4 gates in lockstep + test-
  pinned. Follow-up: catalog entry omits CEO/Super Admin/Training Manager (un-curatable, cosmetic).
- **Item 5 portal CRM** 🔴→✅ did NOT exist; CRM data layer had NO viewer scope. **PR #1495 (open,
  base=targets branch)** added `src/lib/crm/viewer-scope.ts` + `portal-crm-scope.ts`, threaded a
  **REQUIRED** `CrmViewerScope` through `getCrmMasterData`/`streamCrmMasterExportPages` (company =
  explicit `CRM_SCOPE_ALL`, buildable in exactly 2 admin files), new `/employee-portals/crm` +
  scoped export. Scope reuses `resolveDoubleVisitAccessScope` (MedRep=self, DSM=district, RM=region
  subtree, NSM=line subtree — NOT company-wide). RM included per owner. See
  portal-crm-scope-security-design.
- **Item 6 Targets** 🔴→✅ every entry point gated `sales:import` (only SFE Mgr + Super Admin) — even
  the CEO was locked out, no read-only path, no portal surface. **PR #1493 (open, base=main)** split
  read from write: `breakdown` + admin page → `sales:read` + explicit `TARGETS_ADMIN_VIEW_ROLES`
  (adds CEO) + area-scope assert; writes stay `sales:import`; new `/employee-portals/targets` (DM/RM/
  NSM read-only via `resolveSalesAccessScope` by AREA code not region label — the #1479 rule);
  `canEdit` prop on the existing `TargetsWorkspace`.
- **Item 7 Territory Management** 🟡→✅ page was REAL (memory "design only/blocked" was STALE), but
  the portal page had no sidebar flag and the admin page redirected portal roles to the WRONG module
  (territory-DRILLDOWN). **PR #1489 (MERGED)** added `showTerritoryManagementTab` + fixed redirect;
  role set unified as `PORTAL_TERRITORY_MANAGEMENT_ROLES` in the service.

## OWNER DECISIONS (locked this session)
Item 5 = full scoped grid at portal URL; Item 6 = read-only DM/RM/NSM, writes stay SFE/SuperAdmin,
no Medical Rep; **keep all 3 exclusions** (MedRep∉DirectOrders, CNS∉DirectOrders, MedRep∉Plans);
RM included in portal CRM. Go-live: **owner merges all 4 in GitHub himself, verify on staging after.**

## FOLLOW-UPS (recorded, NOT fixed)
- 🔴 **CNS-line Direct Orders exclusion is NAV-ONLY** — `service.ts` has no CNS block, so a CNS DM/RM/
  NSM who POSTs `/api/direct-orders/submit` is NOT blocked. Owner wants it excluded → real enforcement
  gap. Other two exclusions ARE double-enforced (no matrix key → assertPermission throws).
- Territory Management has ZERO test coverage; its 2 pages missing from `access-registry.ts`.
- `access-registry.ts` declares `/api/marketing-requests/**` as `expenses:read` but routes assert
  nothing (scope in service) — harmless, but misdescribes the gate.

## HARD-WON GOTCHAS
- 🔴 **`pnpm run typecheck` gives FALSE GREEN in a warm worktree** — tsconfig has `incremental:true` +
  `assumeChangesOnlyAffectDirectDependencies:true`, so it missed 3 real `Record<Union>` exhaustiveness
  errors. ALWAYS verify with `pnpm exec tsc --noEmit --pretty false --incremental false`. See
  [[typecheck-incremental-false-green]].
- **Stacked PRs after the base SQUASH-merges**: rebase `--onto origin/main <old-base-tip> <branch>`
  drops the merged commits so the PR shows only its own diff; force-with-lease. GitHub auto-retargets
  a child PR to main when its parent merges.
- PowerShell here-string commits break unless `'@` is at column 0 — use `git commit -F <file>`.
- Grep tool mangles forward slashes in its OUTPUT display on this Windows box (`\employee-portals\`);
  the file is fine — confirm with Read, don't "fix" a non-bug.

Related: [[rm-dsm-portal-provisioning-gaps]] [[weekly-plan-four-gates-rm-dsm]]
[[direct-order-request-module-build]] [[crm-module-audit-and-filters-export-fix-2026-07-27]]
[[territory-management-module-plan]] [[marketing-roi-14point-verified-audit]]
