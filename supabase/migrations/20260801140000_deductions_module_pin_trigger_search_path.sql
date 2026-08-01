-- Pin search_path on the Deductions module's three trigger functions.
--
-- 20260725115137_deductions_module.sql and
-- 20260725161204_deductions_module_safety_constraints.sql created these without
-- a search_path setting, which raises Supabase's function_search_path_mutable
-- advisor (confirmed live on production 2026-08-01: applying the module's four
-- migrations took the security advisor from 15 WARN to 18). phx_publish_deductions
-- already pins its own; these three were missed. Matches the sweep in
-- 20260615093000_pin_function_search_path.sql.
--
-- None of the three is SECURITY DEFINER, so they execute as the invoker and the
-- exposure is limited — but an unqualified name inside a function body resolves
-- through the caller's search_path, so pinning removes the ambiguity outright.
--
-- Depends on the module's own migrations having run first (these functions do
-- not exist otherwise). That ordering holds by timestamp: 20260725* < 20260801*.

alter function public.deductions_candidates_guard_locked()
  set search_path = public, pg_temp;

alter function public.deductions_decisions_touch_updated_at()
  set search_path = public, pg_temp;

alter function public.deductions_publication_lines_guard_day_overlap()
  set search_path = public, pg_temp;
