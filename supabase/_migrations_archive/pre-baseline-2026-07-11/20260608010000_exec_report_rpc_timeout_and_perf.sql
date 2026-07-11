-- Sales Command / Source-of-Sales executive RPC reliability + performance.
--
-- Symptom: the CEO's /admin/sales-command dashboard showed "Failed to load Source of Sales
-- data." The real cause (captured server-side) was Postgres SQLSTATE 57014
-- "canceling statement due to statement timeout".
--
-- Why: the executive aggregates (phx_exec_distributor_product / phx_exec_brick /
-- phx_exec_customers) scan the whole month of fact rows and run for ~4-8s each. Every
-- PostgREST/Supabase request runs under the `authenticator` role, which carries
-- statement_timeout = 8s. So these read-only aggregates were being cancelled mid-flight.
--
-- This migration is ADDITIVE, REVERSIBLE, and does NOT change any function body or query
-- logic — results are byte-for-byte identical. It only:
--   1) raises the per-function statement timeout for the three read-only aggregates,
--   2) adds expression indexes that support the product-code value join, and
--   3) refreshes planner statistics so the cheaper single-scan plan is chosen.
--
-- Rollback:
--   alter function public.phx_exec_distributor_product(text) reset statement_timeout;
--   alter function public.phx_exec_brick(text)               reset statement_timeout;
--   alter function public.phx_exec_customers(text)           reset statement_timeout;
--   drop index if exists public.sos_rows_norm_product_code_idx;
--   drop index if exists public.sos_products_norm_product_code_idx;

-- 1) Per-function statement-timeout override.
--    Function-scoped: it applies ONLY while these specific read-only aggregates execute and
--    overrides the inherited 8s authenticator limit. It does not loosen any timeout for the
--    rest of the application. 45s sits comfortably above realistic compute (~4-8s) while
--    still capping any runaway, and below the app's own request/abort budget.
alter function public.phx_exec_distributor_product(text) set statement_timeout = '45s';
alter function public.phx_exec_brick(text)               set statement_timeout = '45s';
alter function public.phx_exec_customers(text)           set statement_timeout = '45s';

-- 2) Expression indexes for the value join `upper(btrim(product_code))` on both sides.
--    Without these the join must externally sort the full month of fact rows. Built
--    non-concurrently inside the migration transaction (brief lock; the table is ~40k rows).
create index if not exists sos_rows_norm_product_code_idx
  on public.source_of_sales_import_rows (upper(btrim(product_code)));
create index if not exists sos_products_norm_product_code_idx
  on public.source_of_sales_products (upper(btrim(product_code)));

-- 3) Refresh statistics so the planner estimates the per-period / per-batch row counts
--    correctly and prefers a single index scan + hash join over a per-batch nested loop.
analyze public.source_of_sales_import_rows;
analyze public.source_of_sales_import_batches;
analyze public.source_of_sales_products;
