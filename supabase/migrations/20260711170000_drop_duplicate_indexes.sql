-- Advisor follow-up: "Duplicate Index" (0009) — 10 WARN findings on production.
--
-- Each pair below has THREE btree indexes on the exact same table/column, created
-- across the baseline dump (idx_fk_*_<hash> and *_fkey_idx conventions) plus an
-- earlier hand-named FK-covering-index migration (idx_mroi_*_fk / idx_*_fk). None
-- of these are unique or back a constraint — plain CREATE INDEX only — so dropping
-- the redundant two per group is safe and reversible (any of the three can be
-- recreated identically if ever needed). Keeps the hand-named index in each group.
--
-- IF EXISTS makes this idempotent/safe to re-run.

drop index if exists public.idx_fk_marketing_roi_customer_facts_refresh_run_id_0622bc;
drop index if exists public.marketing_roi_customer_facts_refresh_run_id_fkey_idx;

drop index if exists public.idx_fk_marketing_roi_distributor_facts_refresh_run_id_dbd584;
drop index if exists public.marketing_roi_distributor_facts_refresh_run_id_fkey_idx;

drop index if exists public.idx_fk_marketing_roi_line_facts_refresh_run_id_6e09f4;
drop index if exists public.marketing_roi_line_facts_refresh_run_id_fkey_idx;

drop index if exists public.idx_fk_marketing_roi_product_facts_refresh_run_id_943bed;
drop index if exists public.marketing_roi_product_facts_refresh_run_id_fkey_idx;

drop index if exists public.idx_fk_marketing_roi_region_facts_refresh_run_id_39f17f;
drop index if exists public.marketing_roi_region_facts_refresh_run_id_fkey_idx;

drop index if exists public.idx_fk_marketing_roi_request_facts_refresh_run_id_04ebf6;
drop index if exists public.marketing_roi_request_facts_refresh_run_id_fkey_idx;

drop index if exists public.idx_fk_marketing_roi_request_geo_facts_refresh_run_id_6e60d0;
drop index if exists public.marketing_roi_request_geo_facts_refresh_run_id_fkey_idx;

drop index if exists public.idx_fk_probation_feedback_comments_commenter_hr_id_7c917a;
drop index if exists public.probation_feedback_comments_commenter_hr_id_fkey_idx;

drop index if exists public.idx_fk_sales_ops_import_batches_superseded_by_batch_id_7bf65e;
drop index if exists public.sales_ops_import_batches_superseded_by_batch_id_fkey_idx;

drop index if exists public.idx_fk_sales_ops_import_batches_supersedes_batch_id_2314b6;
drop index if exists public.sales_ops_import_batches_supersedes_batch_id_fkey_idx;
