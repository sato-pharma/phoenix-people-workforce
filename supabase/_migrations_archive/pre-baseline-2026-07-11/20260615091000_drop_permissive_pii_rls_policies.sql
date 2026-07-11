-- ============================================================================
-- Drop permissive USING(true) RLS policies on PII / salary / access tables
-- ----------------------------------------------------------------------------
-- Finding (High — "Blocker #5"): broad GRANTs to `authenticated` on the
-- salary/comp/PII tables are only safe while each table's RLS is genuinely
-- gating. Several legacy policies are `TO public USING (true)` (and/or
-- WITH CHECK (true)). Because PostgreSQL OR-combines permissive policies, these
-- "always true" policies nullify the properly-gated companions on the same
-- table, effectively bypassing row-level security.
--
-- Verified live on production (ref ozucdzovmcqvepbozvqf) via pg_policies:
--   employees:             employees_select_own_hr (SELECT true),
--                          employees_insert_own_hr (INSERT check true),
--                          employees_update_own_hr (UPDATE true / check true),
--                          employees_delete_own_hr (DELETE true)   -- role public
--   salary_records:        "employee can see own salary" (SELECT true) -- public
--   user_access_profiles:  uap_select_own (SELECT true),
--                          user_access_profiles_read_self_or_admin (SELECT true),
--                          uap_update_own (UPDATE true / check true) -- role public
--
-- These DROPs leave each table with its full gated CRUD set + an explicit
-- service-role policy:
--   employees:            employees_select_access, employees_insert_hr,
--                         employees_update_hr, employees_delete_hr,
--                         employees_service_role_all
--   salary_records:       salary_records_select_access, *_insert/update/delete_payroll,
--                         salary_records_service_role_all
--   user_access_profiles: user_access_profiles_select_self_or_super_admin,
--                         *_insert/update/delete_super_admin,
--                         user_access_profiles_service_role_all
--
-- Blast radius: NONE on application paths. The app reads/writes these three
-- tables exclusively via the service-role client, and `service_role` has
-- rolbypassrls = true (verified) so it is unaffected by any policy change.
-- `authenticated` does NOT bypass RLS, so this genuinely tightens direct
-- PostgREST access by a leaked authenticated JWT. Reversible (recreate below).
-- ============================================================================

-- employees ------------------------------------------------------------------
drop policy if exists employees_select_own_hr on public.employees;
drop policy if exists employees_insert_own_hr on public.employees;
drop policy if exists employees_update_own_hr on public.employees;
drop policy if exists employees_delete_own_hr on public.employees;

-- salary_records -------------------------------------------------------------
drop policy if exists "employee can see own salary" on public.salary_records;

-- user_access_profiles -------------------------------------------------------
drop policy if exists uap_select_own on public.user_access_profiles;
drop policy if exists user_access_profiles_read_self_or_admin on public.user_access_profiles;
drop policy if exists uap_update_own on public.user_access_profiles;

-- ----------------------------------------------------------------------------
-- Rollback (DO NOT APPLY automatically — execute manually only if required):
-- ----------------------------------------------------------------------------
/*
create policy employees_select_own_hr on public.employees for select to public using (true);
create policy employees_insert_own_hr on public.employees for insert to public with check (true);
create policy employees_update_own_hr on public.employees for update to public using (true) with check (true);
create policy employees_delete_own_hr on public.employees for delete to public using (true);
create policy "employee can see own salary" on public.salary_records for select to public using (true);
create policy uap_select_own on public.user_access_profiles for select to public using (true);
create policy user_access_profiles_read_self_or_admin on public.user_access_profiles for select to public using (true);
create policy uap_update_own on public.user_access_profiles for update to public using (true) with check (true);
*/
