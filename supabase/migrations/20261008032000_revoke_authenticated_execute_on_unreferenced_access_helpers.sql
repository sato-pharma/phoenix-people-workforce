-- Take `authenticated`'s EXECUTE away from the three `public` access helpers that nothing calls,
-- and leave the fourth alone because it IS called.
--
-- WHAT WAS ASKED, AND WHY IT IS THREE AND NOT FOUR
--
-- The Supabase linter reports 14 `public` helpers under
-- `authenticated_security_definer_function_executable`. Ten are provably load-bearing: five are
-- named by live RLS policies (`current_access_can_manage_employees` alone appears in 81 policies
-- across 23 tables) and eight are called as RPCs through a real authenticated client by
-- `scripts/phase24-real-auth-rls-api-smoke.ts` and `tests/scripts/phoenix-staging-rls-harness.ts`.
-- Four looked unreferenced. Re-checked against production's catalog on 2026-10-08, all four are
-- clean DB-side -- zero policies, zero calling function bodies, zero views, zero column defaults,
-- zero check constraints, zero non-pin `pg_depend` rows -- and none appears in any TypeScript or
-- application file: every repo hit is historical SQL or a doc.
--
-- But `current_access_can_see_employee(text,text)` is named inside POLICY DDL THIS REPO STILL
-- APPLIES. `scripts/phase25-staging-rls-mutation-smoke.ts` and
-- `scripts/phase26-staging-browser-auth-mutation-smoke.ts` each create policies `to authenticated`
-- on `public.employee_probation` and `public.v2_vacation_requests` whose `using` expression is
--     public.current_access_can_manage_employees()
--     or public.current_access_can_see_employee(employee_hr_id, manager_hr_id)
-- A policy expression is evaluated as the QUERYING role. Production carries no such policy today,
-- which is why a `pg_policy` scan calls the function unreferenced -- but the moment either smoke
-- script runs, every authenticated reader of those two tables would get
-- `permission denied for function current_access_can_see_employee`. So it keeps EXECUTE, and this
-- migration asserts at the end that it still has it.
--
-- THE HISTORY THAT MAKES THIS WORTH STATING PLAINLY
--
-- This exact revoke was already attempted and reversed inside 48 hours.
-- `supabase/20260509_live_admin_auth_security_repair.sql` revoked EXECUTE from
-- `public, anon, authenticated` on all four (and on nine siblings).
-- `supabase/20260511_phoenix_role_alignment.sql`, two days later, revoked only from `public, anon`
-- and GRANTED EXECUTE BACK to `authenticated` on every one of them -- which is the state the
-- 2026-07-11 schema baseline records and production still carries
-- (`{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}`, identical on all four).
-- The 05-11 file is a uniform alignment pass rather than a documented incident fix, so it does not
-- prove the 05-09 revoke broke anything -- but it does mean the "authenticated holds EXECUTE on
-- every access helper" shape was a deliberate decision once, and this migration narrows it on
-- evidence for three functions only.
--
-- The related precedent is why this is deliberately small: on 2026-07-30 a sweep of staging's
-- `public` grant matrix left staging unreachable by every app role for more than a day
-- (`supabase/staging_public_grants_restore_20260731.sql`).
--
-- WHAT CHANGES, ROLE BY ROLE
--
--   authenticated   loses EXECUTE on the three (it has no caller, so no behaviour changes)
--   service_role    keeps it, re-granted explicitly so the end state is stated not assumed
--   anon            unchanged -- the baseline already revoked PUBLIC, so anon never had it
--   postgres/owner  unchanged (implicit)
--
-- PUBLIC is not named: the 2026-07-11 baseline already did `REVOKE ALL ... FROM PUBLIC` on each of
-- these, so the ACL is explicit and `authenticated=X` is a real grant rather than PUBLIC inheritance.
--
-- SAFETY
--
-- No data is read or written and no function body changes. Reversal is one statement per function:
--   grant execute on function public.<fn> to authenticated;

begin;

revoke execute on function public.current_access_is_admin()        from authenticated;
grant  execute on function public.current_access_is_admin()        to service_role;

revoke execute on function public.current_access_line()            from authenticated;
grant  execute on function public.current_access_line()            to service_role;

revoke execute on function public.current_access_manager_hr_id()   from authenticated;
grant  execute on function public.current_access_manager_hr_id()   to service_role;

-- Fail loudly rather than leave a half-state. Four assertions per function, plus the exclusion.
do $guard$
declare
  v_fn   text;
  v_sig  text;
  v_pols int;
begin
  foreach v_fn in array array[
    'current_access_is_admin',
    'current_access_line',
    'current_access_manager_hr_id'
  ] loop
    v_sig := 'public.' || v_fn || '()';

    if has_function_privilege('authenticated', v_sig, 'EXECUTE') then
      raise exception '%: authenticated still holds EXECUTE, so the revoke did not take', v_sig;
    end if;

    if not has_function_privilege('service_role', v_sig, 'EXECUTE') then
      raise exception '%: service_role lost EXECUTE -- every server-side read uses that role', v_sig;
    end if;

    -- If a policy started naming it since the 2026-10-08 scan, this revoke would break that policy.
    select count(*) into v_pols
      from pg_policy pol
     where pg_get_expr(pol.polqual, pol.polrelid)      ilike '%' || v_fn || '%'
        or pg_get_expr(pol.polwithcheck, pol.polrelid) ilike '%' || v_fn || '%';
    if v_pols > 0 then
      raise exception '%: % RLS policy/policies now call this -- revoking EXECUTE would deny every authenticated reader', v_sig, v_pols;
    end if;
  end loop;

  -- The deliberate exclusion, pinned so a later edit cannot quietly widen this migration.
  if not has_function_privilege(
       'authenticated', 'public.current_access_can_see_employee(text,text)', 'EXECUTE') then
    raise exception 'current_access_can_see_employee must KEEP authenticated EXECUTE: the phase25/phase26 staging smokes create policies that call it';
  end if;
end $guard$;

commit;
