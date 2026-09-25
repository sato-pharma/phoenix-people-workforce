---
name: portal-weekly-sales-dashboard
description: "Employee portal Weekly Sales dashboard under Sales Operations sidebar — wired to weekly service layer. Architecture mirrors portal SoS (PR #653)"
metadata: 
  node_type: memory
  type: project
  originSessionId: a8352f7a-f0c5-48b4-8abb-40127166541a
---

Portal Weekly Sales dashboard shipped in **PR #653** (squash merged to main 2026-06-30).

**Route:** `/employee-portals/weekly-sales`  
**API:** `GET /api/employee-portals/weekly-sales` (data) + `GET /api/employee-portals/weekly-sales/export` (3-tab XLSX)  
**UI:** `src/components/sales/weekly/portal-weekly-dashboard.tsx`  
**Wrapper lib:** `src/lib/sales/weekly/portal-weekly-dashboard.ts` (`getPortalWeeklyDashboard`, `resolvePortalWeeklyScope`, `computeWeeklyComparison`)  
**Export:** `src/lib/sales/weekly/portal-weekly-export.ts` (`buildPortalWeeklyWorkbook` — 3 tabs: Summary, Week Comparison, Sources)

**Roles:** DSM, RM, NSM, PM, GPM, Marketing Manager. Medical Reps excluded (`isPortalWeeklyRole`).

**Smart-filter rules** (`computePortalWeeklyVisibility`):
- `region` hidden when `allowedRegionCodes.size === 1` (DSM territory tier)
- `line` shown only for Marketing Manager
- `month` + `weekNumber` + `product` + `distributor` always visible

**DSM layout** (`isSingleRegion = true`): region filter hidden, "By Region" chart slot replaced by wider "By Distributor" chart, breakdown defaults to "product" (no Region tab).

**Period-over-period comparison:** `shiftCycleMonthBack("2026-06-01") → "2026-05-01"` — second `loadWeeklyDashboard` call with prevMonth; returns null if prev month has no data. Gainers/decliners from products where `prevValue > 0`.

**Upload-status chip:** derived from `data.sources` (distinct `distributorCode` set) vs `data.distributors.length` — no separate DB call.

**Completeness tracker:** `data.distributors × [W1,W2,W3,W4] × last 3 months` grid keyed on `data.sources` distributorCode+cycleMonth+weekNumber.

**Scope enforcement:** scope ALWAYS resolved server-side from session (`resolveWeeklyAccessScope(ctx)` → `WeeklyAccessScope`). Client params carry only filter selections (months, weeks, regions, products, distributors, lines). Territory tier `allowedRegionCodes` drives `isSingleRegion`; product tier `productCodes` drives PM/GPM trimming.

**Access registry:** both routes registered in `src/lib/security/access-registry.ts` (`sales.read` permission, export audit-classified).

**Navigation wired in:**
- `src/config/system-navigation.ts` — `CalendarRange` icon, same roles list as SoS
- `src/lib/employee-portal/navigation.ts` — `showWeeklyTab` added to `EmployeePortalNavVisibility` type and `resolveEmployeePortalNavVisibility()`
- `src/components/employee-portal/employee-portal-layout.tsx` — `showWeeklyTab` destructured + entry added to "Sales Operations" section

**DO NOT TOUCH** (unchanged from plan): `src/lib/sales/weekly/service.ts`, `access.ts`, `types.ts`, parser, any admin weekly page/component.

**Why:** Owner wanted weekly sales in employee portal same as portal SoS — scoped, de-cumulated real-week numbers, performance-first (pulls from `loadWeeklyDashboard` directly).
**How to apply:** Extend via wrapper lib (`portal-weekly-dashboard.ts`) not the admin engine. See [[portal-source-of-sales-rebuild]], [[weekly-sales-module-map]].
