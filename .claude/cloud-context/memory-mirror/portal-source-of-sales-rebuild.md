---
name: portal-source-of-sales-rebuild
description: "The employee-portal sales dashboards are consolidated into ONE scope-aware Source of Sales page (app/employee-portals/source-of-sales) wired to the admin SoS engine via the wrapper src/lib/sales/portal-sos-dashboard.ts. Medical Reps are EXCLUDED. The smart-filter rule hides any dimension already fixed by the viewer's scope. Head Office line is CEO/Super-Admin-only and fail-closed on every sales surface. Extend via the wrapper, never the admin engine."
metadata:
  node_type: memory
  type: project
  originSessionId: 05c6795a-b2a5-4c6a-aa1d-021d8d85f50b
  modified: 2026-09-26T01:25:41.045Z
---

The old employee-portal sales dashboards (`/employee-portals/sales`, `/weekly-sales`,
`/monthly-closing`, `/monthly-sales`) were **removed** and rebuilt as a single **Source of Sales** tab
under the "Sales Operations" sidebar section (2026-06-29).

- **Wiring:** route `app/employee-portals/source-of-sales/page.tsx`, API
  `app/api/employee-portals/source-of-sales/route.ts`, UI
  `src/components/sales/portal/portal-sos-dashboard.tsx`. It **reuses the admin `/sales` engine**
  `getSosDashboard` (distributor SoS, `phx_exec_*` RPCs) via the wrapper
  `src/lib/sales/portal-sos-dashboard.ts` (`getPortalSosDashboard`, `resolvePortalSosScope`).
  **Extend via the wrapper, not the admin engine.**
- **Roles** (`PORTAL_SOS_ROLES` / `isPortalSosRole`): DSM, RM, NSM, PM, GPM, Marketing Manager.
  **Medical Reps are intentionally EXCLUDED** — no portal sales dashboard; their personal performance
  still comes from `v_employee_portal_sales`.

## The scope rules (owner: "never show a filter for a dimension already fixed by the viewer's scope")

- **Smart-filter visibility** (`computePortalSosVisibility`): Region hidden ONLY for DSM (single fixed
  region); Line hidden for everyone except MM (3 lines); DSM drills by Area; RM's region set is his
  reporting subtree via `isWithinManagerHierarchy`; **PM/GPM strictly bounded to assigned
  `weekly_sales_product_scope` codes — no assignment ⇒ empty** (owner decision).
- **Area Coverage denominator is viewer-scoped** — region-locked callers (DSM/RM) measure
  `areasReached / totalAreas` against their OWN regions' areas (`masterAreas` filtered by
  `scopeRegionCodes`), never all company areas.
- **By-area / single-region layout:** DSM (one region) → a vertical `ColumnBars` "By area" chart, no
  Region tab, "top area" insight. Multi-region (RM/NSM/PM/GPM/MM; **RM treated like NSM**) → keep "By
  region" + a full-width horizontal `RankedBars` "By area" with drill-down. `isSingleRegion` on
  `PortalSosScopeView` (`regionCodes.size === 1`); engine `singleRegion` is null for admin/CEO ⇒ false.
  🔴 **Owner KEPT the Channel-mix donut / Direct-Share for DSM/RM (declined hiding them) and KEPT "Direct
  (National)" as a pseudo-area IN the By-area chart** — do not "fix" these away.
- The scope rule derives purely from `SalesAccessScope` (line-set size + region lock). Tests:
  `tests/portal-sos-scope.test.ts`.

## 🔴 LOCKED — Head Office line is confidential (same class as LA003/LA004/SS001, fail-closed)

The entire Head Office line + its products are **CEO / Super-Admin only** (`canViewHeadOfficeLine`,
`isHeadOfficeLine`, `stripHeadOfficeRows` in `access-scope.ts`). Enforced on **every** sales surface:
`getSosDashboard` (rows/options/trend); Weekly (`applyWeeklyAccessScope` via
`WeeklyAccessScope.canViewHeadOffice`); the analytics loaders
`loadSosByLine/Product/Customer`,`loadClosingByEmployee`,`loadCrossSource` (each analytics page passes
`canViewHeadOfficeLine(role)`); the SI dashboard (`stripHeadOfficeFromMarketingSnapshot`); and the RPCs
`analytics_sos_by_period`/`analytics_sos_by_area` via `p_exclude_head_office boolean default true`
(fail-closed; loaders pass `!filters.canViewHeadOffice`). The HO key-set baked into SQL mirrors
`isHeadOfficeLine` (trim + collapse-ws + lower → `head office`/`headoffice`/`office`/`hq`), service-role
only. Pinned by `tests/sales-head-office-lock.test.ts`, `tests/weekly-sales-access.test.ts`. **The prod
`analytics.sos_fact` has no HO line yet, so a leak here is LATENT — the guard is pre-emptive.**
See [[la003-la004-confidential-products]].

## Engine & performance facts

- `getSosDashboard` gained an optional 3rd arg `{ allowedProductCodes, allowedRegionCodes }` (additive —
  the admin call is unchanged), **skips the brick/customer RPCs for non-company callers** (perf), and
  added `filters.lines` (multi-line) alongside legacy `filters.line`.
- **Scope-pushdown:** `phx_exec_distributor_product` takes defaulted filter arrays
  (`p_lines/p_distributors/p_regions/p_areas/p_products/p_exclude_codes`) so the DB pre-aggregates only
  the caller's slice instead of returning the whole company. 🔴 **`keepExec` is kept as the authoritative
  backstop, and HO stripping was deliberately NOT pushed to SQL — it stays by `official_line` in TS.**
- **God-mode UX** (portal-only): chart drill-down (click a bar → toggles a filter), period-over-period Δ
  column + Top movers (a 2nd `getSosDashboard` on `shiftPeriod(period,1)`), URL-synced shareable filters
  (`history.replaceState`), distributor upload-status chip (`getDistributorUploadStatus`), multi-sheet
  XLSX export (`buildSosDashboardWorkbook` + `/api/employee-portals/source-of-sales/export`).

## Reusable gotchas

- 🔴 **For any RPC-signature change, apply the migration to PROD BEFORE merging the code.** The loaders
  call the RPC with the new param, so an old-signature prod RPC → PostgREST arg-mismatch → caught by
  `.catch(() => [])` → **silently empty KPIs.** (This page's own by-period/by-area KPIs briefly degraded
  when the order was reversed.)
- **A headless/in-session preview cannot render this authenticated Suspense page** — it hangs on "Loading
  Phoenix Workforce…" even though the route serves 200. Verify on a real machine
  ([[local-browser-verify-gotchas]]).
- **Filter dropdowns need `overflowVisible` on the Section** (the default `overflow-hidden` clips them) +
  dropdown `z-50`.
- **When a parallel session is live, isolate in a worktree from the start and commit early** (a swarm
  session reset the shared primary dir and wiped uncommitted edits; a follow-up fix was even built twice
  by two sessions). Remove a worktree's `node_modules` junction with
  `[System.IO.Directory]::Delete(path, $false)` — **NEVER** `rm -rf` / `Remove-Item -Recurse`, which
  follows the junction and nukes the primary's `node_modules` ([[parallel-session-swarm-hazard]]).

See [[sos-brick-authoritative-geography]], [[sales-territory-scope-build]].
