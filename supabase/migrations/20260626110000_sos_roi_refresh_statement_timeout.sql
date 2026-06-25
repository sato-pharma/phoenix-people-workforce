-- phx_refresh_sos_fact_rollup and phx_refresh_marketing_roi_facts were defined
-- without an explicit statement_timeout, unlike every sibling batch-scoped refresh
-- function in this codebase (phx_refresh_sos_customer_directory_rollup: 60s,
-- phx_finalize_sos_batch: 120s). Both are single-batch delete-then-insert refreshes
-- of similarly-sized rollup tables -- 60s matches the closest analog
-- (phx_refresh_sos_customer_directory_rollup). No logic change: ALTER FUNCTION only
-- sets the per-function statement_timeout override.

alter function public.phx_refresh_sos_fact_rollup(uuid) set statement_timeout = '60s';
alter function public.phx_refresh_marketing_roi_facts(uuid) set statement_timeout = '60s';

notify pgrst, 'reload schema';
