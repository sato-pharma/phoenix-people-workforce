-- Give the twelve sales-reporting RPCs a per-function statement_timeout. They are running under the
-- 8s authenticator default today, and that is what took three manager-facing modules down.
--
-- WHAT HAPPENED. 61 `canceling statement due to statement timeout` errors reached real managers on
-- 2026-09-28 and 2026-09-29, recorded in public.app_error_events and grouped by stack:
--
--   Business Review    38 events, 8 distinct people (36 of them on the 29th alone)
--   Sales vs Target    12 events, 4 distinct people
--   Make It Happen     11 events, 3 distinct people
--
-- The roles hit were District Manager, National Sales Manager, Regional Manager and Medical Rep — a
-- manager opening Business Review got an error instead of the page, 36 times in one day.
--
-- WHY IT HAPPENS, MEASURED 2026-09-30. `authenticator` and `authenticated` carry
-- `statement_timeout = 8s` in their rolconfig; `service_role` carries none, so it inherits the
-- server's 120s. But every PostgREST request logs in AS `authenticator` and then SET ROLEs, and the
-- role GUC is applied at LOGIN — so a service-role read through PostgREST still runs under 8s. That
-- is precisely why 40+ functions in this database already carry an explicit override
-- (`phx_closing_*` at 45s, `phx_closing_channel_*` at 60s, `phx_customer_directory` at 45s plus
-- `work_mem=128MB`). These twelve are the reporting family that never got one, while every sibling
-- around them has it.
--
--   phx_sales_vs_target_range          names the module that timed out
--   phx_sales_vs_target_cache_token    same read path
--   phx_sales_brick_detail             measured 2.4s min / 5.3s max against the 8s ceiling — the
--                                      profile of an intermittent failure that hits some managers
--                                      and not others, and climbs as the data grows
--   phx_monthly_achievement            wraps au.f_monthly_achievement
--   phx_monthly_attribution            wraps au.f_monthly_attribution, measured at 46s for a
--                                      three-period comparison — the heaviest of the set
--   phx_monthly_targets                the target half of every achievement figure
--   phx_monthly_store_split_net        the store split
--   phx_sales_area_trend               \
--   phx_sales_source_breakdown          |  the Source-of-Sales breakdown family, all reached from
--   phx_sales_source_breakdown_detail   |  the same three screens
--   phx_sales_source_breakdown_line     |
--   phx_sales_direct_breakdown         /
--
-- 🔴 THE EPISODE STOPPED ON ITS OWN AND NOTHING FIXED IT. Zero timeouts on 2026-09-30, and no commit
-- between the 29th and now touches the closing engine, these pages, or an index. So this was dormant,
-- not closed: the queries still sit against an 8s ceiling and the next heavy month brings it back.
--
-- 🔴 THIS CHANGES NO NUMBER AND NO LOGIC — only how long a query is allowed to run before Postgres
-- cancels it. No function body, signature, ACL, grant or row is touched, and no locked sales rule is
-- anywhere near this: the Office allocation golden rule lives in TypeScript
-- (src/lib/sales/office-allocation.ts), not in these functions. Monthly Closing remains the single
-- source of truth for every sales and target figure; nothing here alters what it computes.
--
-- Values follow the existing family: 45s as the house norm, 60s for the two that wrap the heaviest
-- au.f_* functions. Each `set` is additive — the existing `search_path=au, public` on all twelve is
-- preserved, not replaced.
--
-- 🔴 AND THE REASON THIS NEEDS A GUARD, NOT JUST A MIGRATION: `CREATE OR REPLACE FUNCTION` SILENTLY
-- DROPS any setting applied by `ALTER FUNCTION ... SET`. That is not hypothetical — it is why
-- 20260728100500_restore_report_rpc_statement_timeouts.sql exists: three functions had a 45s timeout,
-- lost it to a later recreate, and the 8s default then cancelled a 16.7s attribution query mid-flight
-- and produced the ROI report's HTTP 500s in June 2026. So all twelve are added to
-- RPCS_REQUIRING_TIMEOUT in tests/report-rpc-guardrails.test.ts in the same change, which replays
-- every migration and fails CI at the commit that drops one.
--
-- Settings only. Re-runnable.

alter function public.phx_sales_vs_target_range(p_from text, p_to text)
  set statement_timeout to '45s';

alter function public.phx_sales_vs_target_cache_token()
  set statement_timeout to '45s';

alter function public.phx_sales_brick_detail(p_period text)
  set statement_timeout to '45s';

alter function public.phx_sales_area_trend(p_line_code text, p_area_code text, p_product_code text)
  set statement_timeout to '45s';

alter function public.phx_sales_source_breakdown(p_period text, p_line_code text, p_area_code text, p_product_code text)
  set statement_timeout to '45s';

alter function public.phx_sales_source_breakdown_detail(p_period text, p_line_code text, p_area_code text, p_product_code text)
  set statement_timeout to '45s';

alter function public.phx_sales_source_breakdown_line(p_period text, p_line_code text)
  set statement_timeout to '45s';

alter function public.phx_sales_direct_breakdown(p_period text, p_line_code text)
  set statement_timeout to '45s';

alter function public.phx_monthly_targets(p_period text)
  set statement_timeout to '45s';

alter function public.phx_monthly_store_split_net(p_period text)
  set statement_timeout to '45s';

-- 60s: these two wrap au.f_monthly_achievement / au.f_monthly_attribution, the heaviest functions in
-- the set. A nested call runs under the OUTER function's timeout, so capping the wrapper is what
-- governs the whole statement.
alter function public.phx_monthly_achievement(p_period text)
  set statement_timeout to '60s';

alter function public.phx_monthly_attribution(p_period text)
  set statement_timeout to '60s';
