-- Marketing ROI attribution RPCs were created WITHOUT the per-function statement_timeout
-- override that every sibling executive-report RPC in this codebase carries (phx_exec_*,
-- phx_si_*, phx_marketing_roi_customer_dashboard, phx_sales_marketing_dashboard — all 45s;
-- see 20260608010000_exec_report_rpc_timeout_and_perf.sql). As a result they inherit the
-- 8s authenticator/service_role limit, so the UNFILTERED ROI report (full request set,
-- measured ~16.7s) is canceled by statement_timeout -> the route returns HTTP 500
-- ("Marketing ROI tracking failed"). Restore the standard 45s override.
--
-- Function-scoped: applies ONLY while these read-only attribution functions run; it loosens
-- no other path. Idempotent; no destructive DDL. (Throughput is addressed separately by
-- indexing the attribution join.)

alter function public.phx_marketing_request_roi_actuals_v2(uuid[], text[]) set statement_timeout = '45s';
alter function public.phx_marketing_request_roi_actuals(uuid[]) set statement_timeout = '45s';
alter function public.phx_marketing_request_view_sales(uuid, text, text, text[]) set statement_timeout = '45s';

notify pgrst, 'reload schema';
