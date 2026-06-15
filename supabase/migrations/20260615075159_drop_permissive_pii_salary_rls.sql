-- Drop permissive (USING/ WITH CHECK = true) RLS policies on PII + salary tables.
--
-- Context / why
-- -------------
-- Postgres OR-combines PERMISSIVE policies: if ANY permissive policy passes, the row
-- is allowed. These legacy "_own_hr" / "see own" policies were created in
-- 20260509030000 with predicate `true`, and the later gated policies
-- (20260531120234 / 20260531121329: phx_can_access_employee / phx_can_manage_workforce
-- / phx_can_manage_payroll / phx_current_scope) were ADDED alongside them rather than
-- replacing them. A direct read of pg_policies on production (ref ozucdzovmcqvepbozvqf)
-- confirmed both sets are live, so the gated policies are effectively nullified.
--
-- The application accesses these tables through the service-role client, which BYPASSES
-- RLS and enforces authorization in the app layer, so this is defense-in-depth — but the
-- Supabase Auth bridge issues real authenticated JWTs, making direct PostgREST access
-- reachable. A leaked/issued authenticated token could currently read salary and
-- read/insert/update/delete employee rows regardless of the intended gate.
--
-- This migration removes ONLY the unconditional permissive policies. It intentionally
-- KEEPS:
--   * the gated replacements (employees_select_access, employees_insert_hr,
--     employees_update_hr, employees_delete_hr, salary_records_*_payroll / _select_access,
--     user_access_profiles_*_super_admin / _select_self_or_super_admin), and
--   * the *_service_role_all policies the app relies on.
--
-- Blast radius: none on app paths. No app route or domain service reads these three
-- tables via the RLS-respecting client (getSupabaseRlsClient is used only for
-- salary_batches / payroll_expenses / outstation_expense_requests, and always falls back
-- to the admin client). Reversible by re-creating the dropped policies.

-- employees: remove unconditional self/own policies (gated *_hr / *_access remain).
drop policy if exists "employees_select_own_hr" on public.employees;
drop policy if exists "employees_insert_own_hr" on public.employees;
drop policy if exists "employees_update_own_hr" on public.employees;
drop policy if exists "employees_delete_own_hr" on public.employees;

-- salary_records: remove the unconditional "see own salary" SELECT (gated select_access remains).
drop policy if exists "employee can see own salary" on public.salary_records;

-- user_access_profiles: remove unconditional self read/update (gated super_admin / self_or_super_admin remain).
drop policy if exists "uap_select_own" on public.user_access_profiles;
drop policy if exists "uap_update_own" on public.user_access_profiles;
drop policy if exists "user_access_profiles_read_self_or_admin" on public.user_access_profiles;

-- Verification (run after apply): the only remaining permissive `true` policies on these
-- three tables should be the *_service_role_all entries.
--   select tablename, policyname, cmd, qual, with_check
--   from pg_policies
--   where tablename in ('employees','salary_records','user_access_profiles')
--     and (qual = 'true' or with_check = 'true')
--   order by tablename, policyname;
