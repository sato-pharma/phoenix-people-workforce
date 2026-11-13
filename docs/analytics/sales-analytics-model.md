# Sales Analytics Data Model

> **The app's Sales Analytics pages were retired on 2026-09-17; this `analytics` schema was not.**
> The views stay in the database, and the SFE Manager's IMS contribution
> (`src/lib/sales/sfe-performance.ts`) still reads `analytics.dim_periods` and `analytics.sos_fact_all`.

## Schema verification checklist (read this before editing analytics SQL)

Before assuming a table's schema from `supabase/migrations/`, also check the loose root scripts
in `supabase/*.sql` (e.g. `supabase/scripts/phoenix-sales-manager-hr-id.sql` holds the REAL, currently-applied
`sales_records` / `sales_import_batches` / `sales_targets` / `sales_target_batches` schema — the
migrations-folder version (`20260502000001_legacy_sales_payroll_branch_baseline.sql`) is a
`create table if not exists` no-op against an already-existing table with a thinner legacy column
set). A prior audit got this wrong by only grepping `supabase/migrations/` and flagged the
`analytics.closing_fact` view's `territory`/`family`/`sales_type`/`sales_units`/`target_units`/
`validation_state` column references as a "critical schema mismatch" — they are correct. Always
grep BOTH locations for `create table.*<table_name>` before concluding a column doesn't exist.

> **`sales_targets` and `sales_target_batches` are EMPTY LEGACY — never read them.** The note
> above is about column *shape*, not about where the data is. Both tables hold zero rows on
> production and always have. The live sales targets are **`au.monthly_targets`**, reached
> through the service-role RPCs `phx_monthly_targets` / `phx_upsert_monthly_targets`. Both
> tables now carry a Postgres `COMMENT` saying so. Because they are empty rather than absent,
> a query against them returns a confident, wrong zero instead of an error — that has already
> misled one session. See `src/lib/sales/monthly-targets.ts`.

## Three pipelines — three source families

### 1. Source of Sales (SoS)
- **Source tables:** `source_of_sales_import_batches`, `source_of_sales_fact_rollup`
- **Reference tables:** `source_of_sales_products`, `source_of_sales_distributors`, `source_of_sales_area_regions`
- **Grain:** batch × distributor × line × region × area × brick × product × is_direct
- **Value semantics:** distributor rows = `effective_units × factory_price`; direct rows = stored `direct_value`
- **No employee attribution** — geography and product centric
- **Analytics views:** `analytics.sos_*`

### 2. Monthly Closing
- **Source tables:** `sales_import_batches`, `sales_records`
- **Grain:** batch × employee × line × territory × product × month
- **Value semantics:** `sales_value` vs `target_value` (uploaded with closing sheet)
- **Employee attributed** — HR_ID, manager_hr_id, territory
- **Analytics views:** `analytics.closing_*`

### 3. Weekly Sales
- **Source tables:** `weekly_sales_batches`, `weekly_sales_rows`
- **Grain:** batch × week × distributor × region × branch × product
- **Value semantics:** `qty × factory_price × (1 - discount)` — sheet value is ignored
- **Stock:** units only — no stock value column by design
- **Analytics views:** `analytics.weekly_*`

## View layer

```
Source tables
    ↓
analytics schema (regular views)
    ↓
Metabase dashboards / Phoenix pages
```

Views are **non-materialized** (regular `CREATE OR REPLACE VIEW`).
Performance is covered by `source_of_sales_fact_rollup` for SoS (pre-aggregated),
and existing indexes for closing/weekly.

## Confidential product handling

Products LA003, LA004, SS001 are excluded from all standard views:
- `analytics.sos_fact` — filters `product_code NOT IN ('LA003', 'LA004', 'SS001')`
- `analytics.closing_fact` — filters `lower(product) NOT IN ('lacto basic 1', 'lacto basic 2', 'satoslim')`
- `analytics.weekly_fact` — filters `product_code NOT IN ('LA003', 'LA004', 'SS001')`

CEO/admin access uses `analytics.sos_fact_all` and `analytics.dim_products_all`.

## Cross-source reconciliation

`analytics.cross_source_period_line` joins all three pipelines on `(period, line)`.
- SoS has no employee data — it is geography-first
- Closing has no geography — it is employee-first
- Weekly has branch-level geography but no employee data
- Gaps between pipelines are **expected and normal** — they represent different measurement methods

## Adding new analytics views

1. Add a `CREATE OR REPLACE VIEW analytics.your_view AS ...` to a new migration
2. Grant `SELECT ON analytics.your_view TO analytics_readonly`
3. Add a corresponding RPC helper in `analytics_rpc_helpers` migration if Phoenix pages need it
4. Never expose raw `source_of_sales_import_rows` directly — always aggregate via `source_of_sales_fact_rollup`
