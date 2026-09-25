---
name: closing-matrix-fold-live-on-prod-2026-08-15
description: "Monthly Closing derives the headline matrix in-process from phx_closing_distributor_product; the phx_monthly_closing_matrix app call is dropped — LIVE prod, do not restore the second scan"
metadata:
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-14T23:56:08.627Z
---

`loadMonthlyClosingParts()` in `src/lib/sales/monthly-distributor-import.ts` used to fire **two**
near-identical scans of `source_of_sales_fact_rollup` (228 MB, 222k rows) per (line, period):
`phx_monthly_closing_matrix` grouped by (area, product) → the headline grid, and
`phx_closing_distributor_product` grouped by (distributor, region, area, product) → already fetched
for the "of which Office" slice. The two RPCs select **identical rows under identical filters**
(same period, same line, same `not is_direct`, same `LA003/LA004/SS001` exclusion; value =
`sum(effective_units * coalesce(factory_price,0))`, units = `sum(total_qty)`) and differ **only in
GROUP BY grain** — confirmed via `pg_get_functiondef` (bodies identical bar the GROUP BY). So the
matrix is the **Σ of the distributor read over (distributor, region)** — a sum-over-partition
identity, not an approximation.

`phx_monthly_closing_matrix` was **47.2 s / 7.3 %** of prod DB time in the post-brick-fix window
(82 calls, ~576 ms cold-scan mean — sparse ~18/h calls re-read a wide covering index per period).

**Fix (LIVE prod 2026-08-15 01:55 Cairo, PR #2151, squash `73620f79`, healthz-confirmed serving):**
new exported fold `matrixCellsFromDistributorRows(rows)` collapses the ONE distributor read up to
(area, product); the `phx_monthly_closing_matrix` **app call is removed**. One fact-table scan per
closing build instead of two. **Pure TypeScript — no migration, no index, no schema.**

**Invariants that must not be "cleaned up":**
- **`phx_monthly_closing_matrix` stays DEFINED in the DB** — only the app-side call is gone. Its
  `statement_timeout` guard pinned by `tests/report-rpc-guardrails.test.ts` is unaffected; do not
  drop the function.
- **The `phx_closing_distributor_product` read is now LOAD-BEARING** — a failure fails the whole
  closing (exactly as the matrix RPC's failure used to), which is correct: these are the sheet's
  headline numbers. The old fail-soft `loadOfficeClosingCells` → `null` path is **gone on purpose**;
  `officeData` is now always an array (Office is a subset of the already-required rows), so a
  genuinely Office-free month is a true zero grid, never `null`. Do not reintroduce the null branch.
- The fold groups by the **raw** `area_code`/`product_code` strings (space-joined key, mirroring the
  sibling `officeCellsFromDistributorRows`) — codes are short and space-free (GZ6, LA003) so no
  tuple can alias. Do not "normalize" the key.

**Proven piastre-identical on production:** 28/28 validated (line, period) slices, `EXCEPT`-diff
**0 rows** different in either direction (2026-08-15); earlier to 0 units / 0 EGP on CNS July
(2026-08-11). Regression guard `tests/closing-matrix-fold.test.ts` (registered in `run-tests.ts`)
pins the fold; break-the-fix confirmed (an Office filter drops the headline cell 1,000 → 400 and the
headline assertion fires).

**Do NOT undo:** do not re-add the `phx_monthly_closing_matrix` call to the closing `Promise.all`, do
not restore `loadOfficeClosingCells`, do not restore the `officeData ? … : null` conditionals.

Same performance campaign as [[brick-centroids-cache-live-on-prod-2026-08-15]],
[[search-direct-order-customer-code-trgm-live-on-prod-2026-08-14]] and
[[vacation-report-cross-request-cache-live-on-prod-2026-08-14]]. The next profiling pass should read
prod pg_stat_statements again; the follow-up target is `phx_closing_distributor_product`'s own
cold-cache tax (~48 s remaining), for which the options are an expression index (~40 %) or a
product-grain rollup (~90 %), to be proposed separately.
