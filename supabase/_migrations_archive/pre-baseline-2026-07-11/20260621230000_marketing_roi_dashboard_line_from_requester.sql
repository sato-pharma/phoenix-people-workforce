-- Sales & Marketing Intelligence ROI dashboard: resolve Line from the REQUESTER.
--
-- Problem: phx_marketing_roi_customer_dashboard derived each request's Line from
-- marketing_requests.line_id, which is empty for ~every request. The request CTE
-- therefore produced request_line = 'Unassigned' for all rows, so the dashboard
-- showed "Unassigned" on the request table, the Line breakdown, and the top-risk
-- card (verified prod: 109/109 paid requests = "Unassigned").
--
-- Fix: fall back to the requester's own employees.line_id when the request has no
-- line_id, exactly as every other employee-facing surface resolves Line
-- (employees.line_id -> lines). Verified read-only against prod ozucdzovmcqvepbozvqf:
-- the 109 "Unassigned" line rows resolve to Anti Inf 64 / Pedia 40 / CNS 5, zero
-- "Unassigned". This does NOT touch the Region breakdown — region remains the
-- target pharmacy's brick geography (source_of_sales_customer_map), per the locked
-- "brick is the authoritative geography" rule; it must never come from the requester.
--
-- Implemented as an in-place transform of the live function definition so it stays
-- in lock-step with whatever the most recent base migration installed, and only the
-- one request-CTE join line changes. Idempotent: once transformed, the old join
-- string is gone, so re-running re-executes the already-fixed definition (no-op).
-- SECURITY DEFINER, search_path, statement_timeout, and grants are preserved by
-- CREATE OR REPLACE.

do $$
declare
  def text;
begin
  select pg_get_functiondef(
    'public.phx_marketing_roi_customer_dashboard(text[],text[],text[],text[],text[],text[],text,text,text,integer)'::regprocedure
  ) into def;

  def := replace(
    def,
    'left join public.lines l on l.id = mr.line_id',
    'left join public.employees emp_req on upper(btrim(emp_req.hr_id)) = upper(btrim(mr.requester_hr_id))' || chr(10) ||
    '    left join public.lines l on l.id = coalesce(mr.line_id, emp_req.line_id)'
  );

  execute def;
end $$;

notify pgrst, 'reload schema';
