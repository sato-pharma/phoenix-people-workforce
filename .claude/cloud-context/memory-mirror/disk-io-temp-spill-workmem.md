---
name: disk-io-temp-spill-workmem
description: "Prod Disk-IO budget drain is temp-file spill from work_mem=2MB, not shared-block reads; two SoS analytics RPCs = 85% of it."
metadata: 
  node_type: memory
  type: project
  originSessionId: be16768f-c208-447f-be4f-1cf91b93e99a
---

Diagnosed 2026-07-04 when prod (ozucdzovmcqvepbozvqf) was running out of Supabase Disk-IO budget. Supabase's own AI Assistant blamed shared-block reads/writes on `source_of_sales_import_rows` — that was a red herring.

Real cause (pg_stat_statements, 36-day window from 2026-05-29): **~12 GB shared reads but ~161 GB temp-file I/O**. Temp spill dwarfs shared I/O ~13×. `work_mem` is only **2184 kB (~2 MB)** on this small instance (shared_buffers 224 MB, effective_cache_size 384 MB), so every analytics aggregate/sort spills to disk.

Two RPCs = ~85% of all temp I/O:
- `phx_exec_customers(p_period)` — 3771 calls, ~79.5 GB temp (48%). Called via `rpcAll` (src/lib/sales/sos-dashboard.ts:559) with `count:"exact"` + ORDER BY client_code,distributor_code → PostgREST outer sort+count of the full result set spills.
- `phx_customer_directory(...region/area/brick/dist + period range)` — 758 calls, ~59.8 GB temp (36%).

Both **already read the rollup tables** (customer_directory_rollup / fact_rollup), NOT raw import rows — so "route to rollup / trim indexes / partition" advice is moot; the rollup migration is already done. The spill is pure work_mem starvation.

Fix priority:
1. **Raise work_mem** from 2 MB to 32 MB. **Use `ALTER DATABASE postgres SET work_mem='32MB'` — NOT `ALTER ROLE`.** Verified on staging 2026-07-04: role-level GUCs load at *login*, and a plain `SET ROLE authenticated` in a console does NOT pick them up (statement_timeout showed 2min not the role's 8s; work_mem stayed 2184kB). `ALTER DATABASE postgres SET` loads at connection for the pooled authenticator and **survives SET ROLE** (verified: `work_mem`=32MB after `SET ROLE authenticated`). Per-function SET does NOT cover the PostgREST outer ORDER BY/count sort — must be DB/session level. Mechanism validated with a synthetic 300k-row sort on staging: 2184kB → `external merge Disk: 90144kB` (~180 MB temp I/O, 2.6s); 128MB → `quicksort Memory`, **0 temp**, 0.9s. NB: staging has **no SoS data** (import_rows=0), so real-query reproduction wasn't possible — synthetic + prod pg_stat_statements is the evidence. Caveat: `phx_customer_directory` spills ~79 MB/call, so global 32 MB won't fully absorb it — give that one function a higher `ALTER FUNCTION ... SET work_mem` (if its spill is internal) or accept partial. Reversible (`ALTER DATABASE postgres RESET work_mem`); watch memory on the small instance.
2. Give `phx_exec_customers`/`phx_exec_brick` the single-exec JSON treatment already used by `phx_customer_directory_json` (migration 20260614200001) — one jsonb row, no outer sort/count, aggregation runs once.
3. Drop unused/redundant small indexes on source_of_sales_import_rows (264 MB indexes on a 58 MB heap). NB: `_area_idx` is NOT redundant — the `sos_rows_region_area_brick_idx` composite leads with region_code so it can't serve area-only lookups; KEEP area_idx.
4. Compute upgrade if a global work_mem bump is unsafe under concurrency.

Do NOT run live EXPLAIN ANALYZE on these to "confirm" — it re-executes the query and burns more of the same scarce Disk-IO budget. pg_stat_statements temp_blks is conclusive.

## APPLIED TO PROD 2026-07-04 (verified)
- `ALTER DATABASE postgres SET work_mem='32MB'` — verified 32MB survives `SET ROLE authenticated` on prod. Rollback: `ALTER DATABASE postgres RESET work_mem`. (Existing `app.settings.jwt_exp` preserved — the SET appends.)
- `ALTER FUNCTION public.phx_customer_directory(text[],text[],text[],text[],text,text,text[]) SET work_mem='96MB'` — it's a SQL fn with internal GROUP BY/DISTINCT/ORDER BY (already NOT inlined due to existing proconfig), spills ~79MB/call, so the per-fn bump covers what global 32MB can't. `phx_exec_customers` left on global 32MB (only ~21MB/call, called frequently).
- Dropped 4 indexes (CONCURRENTLY): `sos_import_rows_invoice_date_idx` (0 scans), `source_of_sales_import_rows_product_idx` (6, normalized dup), `source_of_sales_import_rows_region_idx` (14, composite covers), `source_of_sales_import_rows_is_direct_idx` (63, boolean low-value). Index count 19→15, 264→253 MB. Recreate DDL captured in session if needed.
- Verified before/after mechanism on staging with synthetic sorts; staging also has DB-level + role-level work_mem=32MB applied. Follow-up: re-check prod pg_stat_statements temp growth after a day to quantify the drop.

Related: [[perf-audit-2026-07-04-root-causes]], [[sos-fact-rollup-exec-si-dashboards]].
