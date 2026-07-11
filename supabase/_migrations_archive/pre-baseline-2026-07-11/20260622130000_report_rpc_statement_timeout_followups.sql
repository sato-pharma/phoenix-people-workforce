-- Bring the remaining LIVE report RPCs in line with the report-RPC convention: a 45s
-- per-function statement_timeout (the 8s authenticator/service_role default is what cancelled
-- the 16.7s ROI attribution -> HTTP 500). These four are read-only, code-referenced report
-- functions and were the only USED report RPCs still on the default.
--
-- Deliberately NOT touched here: the 11 phx_exec_*_snapshot functions and the phx_closing_*
-- trio are unreferenced anywhere in the app (likely dead, or inner SQL children that inherit
-- a parent's timeout) — left for a separate dead-code review rather than capped blindly.
--
-- Function-scoped, idempotent, no behavioural change for fast calls.
alter function public.phx_vacation_report_rows(text[], jsonb, integer, integer) set statement_timeout = '45s';
alter function public.phx_monthly_closing_matrix(text, text) set statement_timeout = '45s';
alter function public.phx_monthly_closing_direct(text, text) set statement_timeout = '45s';
alter function public.phx_marketing_roi_latest_validated_period() set statement_timeout = '45s';

notify pgrst, 'reload schema';
