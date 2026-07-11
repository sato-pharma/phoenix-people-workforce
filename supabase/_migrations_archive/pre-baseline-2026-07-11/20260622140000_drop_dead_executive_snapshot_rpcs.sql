-- Remove confirmed-DEAD report functions. Verified read-only on prod ozucdzovmcqvepbozvqf:
-- each of the 14 has 0 callers in other functions, 0 view references, 0 anon/authenticated
-- grants, and is unreferenced anywhere in src/app. The CEO executive dashboard was
-- reimplemented around the newer phx_exec_brick/customers/distributor_product (which ARE
-- referenced + already carry statement_timeout); these *_snapshot generators and the
-- phx_closing_* trio (superseded by phx_monthly_closing_*) are orphaned.
--
-- DESTRUCTIVE (DROP FUNCTION). Reversible — the definitions remain in their original
-- migrations (20260602082351 executive_dashboard_snapshot; the closing-trio base migration).
-- Before applying to prod: sanity-check the CEO Command Center / executive dashboard still
-- renders (it should — it doesn't reference these).
drop function if exists public.phx_exec_attendance_snapshot(text, text, text, text, text);
drop function if exists public.phx_exec_contracts_snapshot(text, text, text, text, text);
drop function if exists public.phx_exec_expenses_snapshot(text, text, text, text, text);
drop function if exists public.phx_exec_leave_snapshot(text, text, text, text, text);
drop function if exists public.phx_exec_operations_snapshot(text, text, text, text, text);
drop function if exists public.phx_exec_payroll_snapshot(text, text, text, text, text);
drop function if exists public.phx_exec_probation_snapshot(text, text, text, text, text);
drop function if exists public.phx_exec_recruitment_snapshot(text, text, text, text, text);
drop function if exists public.phx_exec_sales_snapshot(text, text, text, text, text);
drop function if exists public.phx_exec_vacancies_snapshot(text, text, text, text, text);
drop function if exists public.phx_exec_workforce_snapshot(text, text, text, text, text);
drop function if exists public.phx_closing_brick(text, text);
drop function if exists public.phx_closing_customers(text, text);
drop function if exists public.phx_closing_distributor_product(text, text);

notify pgrst, 'reload schema';
