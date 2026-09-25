---
name: sales-intelligence-module-build
description: "Role-scoped Sales Intelligence module (Executive Dashboard + Sales Details + Data Quality Center) with hard LA003/LA004 exclusion; built on source_of_sales_*, plan we-need-to-build-starry-lighthouse.md."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1bb5dae3-68d5-4da7-8d38-01ea68bcd164
---

New **Sales Intelligence** module at `/sales-intelligence` (Executive Dashboard), `/details`
(tables), `/data-quality` (admin upload health). Built on the `source_of_sales_*` truth (NOT the
legacy `sales_records`). Plan: `~/.claude/plans/we-need-to-build-starry-lighthouse.md`.

**The confidential-product rule (the whole point):** products **LA003 + LA004 ("Lacto Basic 1 &
2", line "Head Office") = ~59% of rows but 80.5% of VALUE** (full=EGP 69.4M, excluded=EGP 13.5M).
Excluded by default for EVERYONE; only **CEO + Super Admin** can reveal via an explicit "Include
Lacto Basic 1 & 2" toggle. Enforced at the SQL layer (`phx_si_*` RPCs take `p_exclude_codes`) +
`resolveSalesAccessScope` ignores the include flag for every other role + `stripRestrictedRows`
defense-in-depth. Proven live: SFE Manager forcing `?includeRestricted=1` → still excluded, 0 leaked.

**Dashboards are geography+line centric, shown BY NAME** (brick/area/region/line/product/
distributor/customer) — NOT per-medical-rep (the files carry no rep ownership). Scope: CEO/SA/SFE =
all (COMPANY); NSM/PM/GPM = their line; Regional Manager = line+region; DSM/MR = line+region (area
unreliable → degrade). Line bridge: employee `lines.name` → SoS official_line ("Anti Inf"→"Anti
infective", "Office"→"Head Office"; Pedia/CNS verbatim) in `bridgeEmployeeLineToOfficial`.

**Key files:** `src/lib/sales/access-scope.ts` (scope engine, RESTRICTED_PRODUCT_CODES),
`src/lib/sales/intelligence/{loader,service,derive,types,request,export,data-quality}.ts`,
`supabase/migrations/20260611120000_sales_intelligence_rpcs.sql` (**APPLIED to prod**),
`src/components/sales/intelligence/*`, 7 routes under `app/api/sales/intelligence/*`. Reuses
admin-design-system, cards, charts (recharts), table-workbook export. Month-completeness = expected
distributors (seen in any ≤ period validated batch ∩ active) all uploaded. Tests:
`tests/sales-intelligence-{scope,service}.test.ts`.

**v1 SHIPPED** (commit `5802609`); user scored the dashboard **1/10** → **v2 "Phoenix Sales
Command" rebuilt 2026-06-11** (commit `0539103`, local — push pending approval). v2 adds:
- **invoice_date day grain**: column + SQL backfill from raw_row (100.00% coverage, 0 wrong-month;
  per-distributor formats incl. ambiguous EP-S/EP-R "4/9/2026" disambiguated by period-match);
  new imports persist it via `resolveInvoiceDate` (invoicePeriod untouched).
- **Fixed live Direct bug**: old phx_si_* recomputed Direct rows from factory price
  (~EGP 123k/month understated); v2 RPCs use the is_direct stored value — verified
  SI DIRECT April = 1,033,169 == exec.
- **New RPCs (migration 20260611142000, APPLIED to prod)**: phx_si_period_totals (one-scan trend/
  sparks/MoM-YoY — anti-loop test pins no per-period loop), phx_si_daily (month-bounded, NULL-date
  bucket), phx_si_customer_product (fail-closed: no filter → 0 rows; ≤500 LIMIT in SQL).
- **UI**: dark command hero + KPI band w/ real per-metric sparks + Daily Rhythm (MTD pace vs
  prior-month ghost, weekend bands, run-rate chip) + signals rail + diverging movers + Pareto
  products table (rows open URL-driven ?product= drill slide-over) + region-banded geo matrix +
  distributor dependency spine + customer pareto w/ 80% annotation + churn strip + risks band.
- **Security verified live on every new endpoint**: SFE+forced include → excluded totals, daily
  reconciles exactly, 0 leaked names, LA003 drill → 403; SA toggle 9.15M↔44.2M (April).
**v2 UI iteration (2026-06-11, local/uncommitted, gates green):** light compact hero, bigger fonts,
light executive signals. Three correctness fixes: (1) **NO CODES anywhere** — `displayName(map,code,
unmappedLabel)` in derive.ts resolves region/area/distributor/brick to NAMES and returns
"Unmapped …" for the few truly-unmastered codes (prod has area `B117` + bricks `B99-2/B19-30/B121-12`
unmapped; **Direct** leaked because master keys it `"Direct"` but rows say `"DIRECT"` → fixed with an
upper-case alias in loader). (2) **Brick column** added to Top Customers (`SiCustomerRow.brick`,
brick→area fallback). (3) **Default period = richest month** when none is "complete" (the cumulative
"expected" ratchet means no month is ever complete, so it was landing on the thin newest month and
showing "only Overseas"; `pickDefaultPeriod` now picks max-uploaded-distributors, tie→newest).

**Advanced Filters toolbar (2026-06-11, local/uncommitted, gates green):** premium light toolbar
`si-advanced-filters.tsx` on page 1 (Month + Lacto + scope badges + **Distributor/Region/Area/Line/
Product** selects, removable orange name-chips, clear-all, square corners). Filters narrow the SSR
scan via `applyDetailsFilters` (KPIs/products/line-mix/geography/distributors/movers all filter);
threaded through the lazy movers/customers/churn endpoints via `parseSiFilters` in request.ts +
`handleSiRequest` now `(scope,period,filters)=>`. **Key design choices:** customer/churn use
`applyGeoChannelFilters` (distributor/region/area ONLY — a customer spans products, so line/product
can't narrow them); **daily** filters by product+distributor only (current prod `phx_si_daily` has no
area/line/region user param — extending it needs a NEW migration, DEFERRED/approval-gated; passing the
unsupported params would break locally since local dev hits prod); **compare MoM/YoY is neutralized to
"—" under any filter** (period-totals scan is unfiltered, so a filtered headline next to a whole-book
delta would lie); **white-space stays month-level** (unfiltered, else a region filter falsely paints
other regions as zero-sales). Page-1 product filter uses URL param **`productFilter`** (NOT `product`,
which drives the drill deep-link). Tests: `tests/sales-intelligence-filters.test.ts`.

Watch: NUL-byte scan before commit is now standard. See [[source-of-sales-rebuild-rules]].
