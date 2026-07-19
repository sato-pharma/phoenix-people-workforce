-- Fixes a dead RLS "self" visibility arm affecting every role except Super Admin / CEO /
-- Finance Manager / SFE Manager on the 13 tables covered by the 20260717132337 set-based
-- visibility rewrite (employees, employee_compensation, employee_locations,
-- employee_probation, outstation_expenses, outstation_expense_requests,
-- outstation_expense_reports, salary_records, salary_flags, salary_batches, geo_bricks,
-- brick_reference_rows, geo_trip_routes).
--
-- Root cause: private.phx_current_hr_id() reads ONLY the legacy per-claim PostgREST GUC
-- request.jwt.claim.hr_id. Nothing populates that GUC on current Supabase -- PostgREST >= 9
-- exposes claims solely via the single JSON GUC request.jwt.claims -- so this function has
-- always returned null for every real request, and the migration that last touched these
-- policies (20260717132337) explicitly documented the self/team/line/department arms as
-- "dead today (fail closed)" as a known, pre-existing condition it was preserving bit-for-bit,
-- not introducing.
--
-- Confirmed live impact: querying salary_records/salary_batches for the RLS-authenticated
-- session backing a real National Sales Manager account (A-12) returns zero rows for that
-- account's OWN published payslip, reproducing "No payslip records found for this batch and
-- user" from app/api/payroll/[id]/payslips/route.ts, because getSalaryBatchExport() prefers
-- the RLS-bridged client over the service-role client when the Supabase Auth bridge session
-- is present (which it is for every normal login -- see app/api/auth/login/route.ts).
--
-- Fix: resolve hr_id the same reliable way private.phx_current_role() already does --
-- via auth.uid() against user_access_profiles / app_auth_users, which correctly falls back
-- to parsing request.jwt.claims (auth.uid() already handles that fallback) instead of
-- depending on the dead per-claim GUC. The legacy claim read is kept as a last-resort
-- fallback in case it is ever wired directly, matching the original function's forward
-- compatibility intent, but is no longer the only path.
--
-- Semantics elsewhere are unchanged: phx_visible_hr_ids() and every policy's self-arm
-- (`lower(hr_id) = lower(phx_current_hr_id())`) already lower-cases and coalesces the
-- result, so returning the same value via a different lookup path changes nothing about
-- how it is compared. This can only ever WIDEN visibility back to what each RLS policy's
-- self/team/line/department arm always intended to grant -- it cannot grant anything the
-- OR'd phx_can_manage_payroll()/phx_has_company_access() arms didn't already allow, and it
-- cannot expose another employee's row (the lookup only ever returns the CURRENT session's
-- own hr_id).

create or replace function private.phx_current_hr_id()
returns text
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce(
    (
      select uap.hr_id
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    (
      select aau.hr_id
      from public.app_auth_users aau
      where aau.auth_user_id = (select auth.uid())
        and coalesce(aau.is_active, true) = true
      order by aau.updated_at desc nulls last
      limit 1
    ),
    nullif(current_setting('request.jwt.claim.hr_id', true), '')
  );
$function$;
