---
name: sos-fact-rollup-exec-si-dashboards
description: "Exec/SI dashboard RPCs now read source_of_sales_fact_rollup (pre-aggregated), NOT the 410MB raw table; keep it refreshed on import."
metadata: 
  node_type: memory
  type: project
  originSessionId: ac33499d-02ea-4d23-b372-9a86f22aa11b
---

Phase 1 of the performance program (shipped to prod 2026-06-21, PR #422, migrations
20260624090000–20260624093000). The executive / sales-intelligence RPCs
`phx_exec_distributor_product`, `phx_exec_brick`, `phx_si_period_totals` were live-scanning
the 410MB `source_of_sales_import_rows` table (4–13s each). They now read two pre-aggregated
rollups and are sub-second (67ms / 111ms / 301ms — verified byte-identical via EXCEPT):

- `source_of_sales_fact_rollup` — grain (batch, period, distributor, line, region, area, brick,
  product, is_direct). Stores `effective_units = sum(qty*(1-discount))`, `total_qty`,
  `direct_value`, NOT a priced value — functions multiply by CURRENT factory_price at query
  time so pricing stays live. ~22.6k rows.
- `source_of_sales_customer_presence_rollup` — for exact distinct `customer_count`
  (present_any vs present_nonexcluded; confidential exclusion is always {} or LA003/LA004/SS001).

**Why:** dashboards re-scanning the wide raw table was the dominant cause of "the system is very
slow" (and feeds the over-quota egress). Rollup is ~3MB, cache-resident.

**How to apply:** the rollup is refreshed per-batch by `phx_refresh_sos_fact_rollup(batch_id)`,
wired into BOTH commit paths — `persistNormalizedBatch` (normalizer/service.ts) and
`persistSourceOfSalesUpload` (monthly-distributor-import.ts). Batch deletes cascade via FK.
If you add a THIRD batch-insert path, it MUST call the refresh. Full rebuild =
`phx_backfill_sos_fact_rollup()`. Never reintroduce raw-table scans for these dashboards; extend
the rollup grain instead. Confidential exclusion (LA003/LA004/SS001) stays QUERY-TIME, never baked
into the rollup. Related: [[la003-la004-confidential-products]], [[sales-command-statement-timeout]].

Still slow (later phases): `phx_marketing_roi_customer_dashboard` (11s, scans raw twice),
`phx_marketing_roi_health` (37s audit), `phx_customer_directory*`. See the perf-program plan.
