-- Restore the per-function statement_timeout on five heavy report RPCs that are currently
-- running under the 8s authenticator default in production.
--
-- WHY: `CREATE OR REPLACE FUNCTION` silently DROPS any setting applied earlier via
-- `ALTER FUNCTION ... SET`. Three of these had a timeout and lost it when a later migration
-- recreated the function without re-declaring it; two never had one.
--
--   phx_marketing_roi_latest_validated_period   45s granted 20260622130000, lost at
--                                               20260623170000_roi_latest_period_rewrite.sql
--   phx_monthly_closing_matrix                  45s granted 20260622130000, lost on a later recreate
--   phx_monthly_closing_direct                  45s granted 20260622130000, lost on a later recreate
--   phx_marketing_coverage_export_sales_detail  never had one — and it is the heaviest untimed
--                                               query in the module: a bulk per-sale export
--                                               joining source_of_sales_import_rows (the largest
--                                               table in the database) across an arbitrary array
--                                               of request ids, called live from the coverage
--                                               report export path
--   phx_marketing_roi_fast                      never had one; SECURITY DEFINER, fact-table reader
--                                               behind NEXT_PUBLIC_SMI_USE_FACT_TABLES
--
-- This is the exact failure mode that produced the ROI report's HTTP 500s in June 2026: the 8s
-- default cancelled a 16.7s attribution query mid-flight. Verified against production
-- 2026-07-28 — all five resolve to NO statement_timeout today.
--
-- Settings only: no function body, signature, ACL, or data is touched. Re-runnable.
--
-- tests/report-rpc-guardrails.test.ts replays every migration and models this CREATE-clears /
-- ALTER-restores behaviour, so a future recreate that drops one of these fails CI at the commit
-- that introduces it. (Its previous version read frozen archived migration files and could not
-- see any of this — it stayed green through all three regressions above.)

alter function public.phx_marketing_roi_latest_validated_period()
  set statement_timeout to '45s';

alter function public.phx_monthly_closing_matrix(p_line text, p_period text)
  set statement_timeout to '45s';

alter function public.phx_monthly_closing_direct(p_line text, p_period text)
  set statement_timeout to '45s';

alter function public.phx_marketing_coverage_export_sales_detail(
  p_request_ids uuid[], p_exclude_product_codes text[]
) set statement_timeout to '45s';

alter function public.phx_marketing_roi_fast(
  p_lines text[], p_regions text[], p_products text[], p_roi_statuses text[],
  p_from_month text, p_to_month text, p_customer_search text, p_distributors text[],
  p_attribution_qualities text[], p_limit integer, p_exclude_codes text[]
) set statement_timeout to '45s';
