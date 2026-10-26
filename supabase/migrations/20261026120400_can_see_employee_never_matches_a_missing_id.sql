-- public.current_access_can_see_employee(): a caller with no HR id never matches a row with no HR id.
--
-- WHAT WAS WRONG (audit 2026-10-26, point 11 — measured live on production and staging)
--   The body compared `lower(coalesce(employee_hr_id, ''))` with `lower(coalesce(current_access_hr_id(), ''))`
--   (and the same for the manager column under TEAM/HIERARCHY scope). For a caller whose HR id
--   resolves to nothing — no session, or a signed-in account with no linked employee — both sides
--   collapse to '' and the comparison is TRUE. Called as `authenticated` with no session:
--     ('B-10', null) -> false, ('B-10', 'B-10') -> false, but (null, null) -> TRUE and ('', '') -> TRUE.
--   So any row with a blank or missing HR id was visible to every caller that has no HR id. No live
--   production policy calls this helper today (the phase 25/26 staging smokes create policies on it
--   at smoke time), but it is granted to `authenticated` and reads as the employee-visibility check,
--   so the next policy that used it would have inherited the hole.
--
-- WHAT THIS CHANGES
--   Same signature, SECURITY DEFINER, STABLE, `search_path = public`, same grants. The caller's HR id
--   is read once; if it is blank or missing, the id and manager branches are false. The result is
--   wrapped in coalesce(..., false) so it can never answer NULL. Every match the old body made for a
--   caller WITH an HR id is kept exactly (same lower() comparison, no trimming of either side), so
--   this only removes matches — the blank-to-blank ones. The Super Admin branch is untouched.
--
-- WHY THE GRANT STAYS
--   tests/access-helper-execute-grant-lock.test.ts and docs/security/supabase-advisor-baseline.md
--   ("11 IS THE FLOOR"): this is one of the eleven helpers the phase 24-26 real-auth smokes and live
--   policies depend on, and revoking `authenticated` breaks them. The revoke below is FROM PUBLIC
--   only, which is what scripts/check-migrations.mjs rule 4 requires of any SECURITY DEFINER function,
--   followed by the explicit re-grant to authenticated and service_role it already holds.
--
-- RE-APPLY
--   create or replace keeps the owner and the ACL; the revoke and grant are idempotent. The block at
--   the end RAISES if the blank-to-blank case still answers true, if anon can execute it, or if
--   authenticated or service_role lost EXECUTE.
--
-- ROLLBACK
--   Re-create it with the body from 20260711135352_phoenix_production_schema_baseline.sql (line 1744).

create or replace function public.current_access_can_see_employee(employee_hr_id text, employee_manager_hr_id text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    public.current_access_can_manage_employees()
    or (
      me.hr_id is not null
      and (
        lower(employee_hr_id) = me.hr_id
        or (
          public.current_access_scope() in ('TEAM', 'HIERARCHY')
          and lower(employee_manager_hr_id) = me.hr_id
        )
      )
    ),
    false
  )
  from (
    select case when btrim(coalesce(raw.hr_id, '')) = '' then null else lower(raw.hr_id) end as hr_id
    from (select public.current_access_hr_id() as hr_id) as raw
  ) as me;
$$;

revoke execute on function public.current_access_can_see_employee(text, text) from public;
grant execute on function public.current_access_can_see_employee(text, text) to authenticated, service_role;

do $$
begin
  if public.current_access_hr_id() is null and not coalesce(public.current_access_can_manage_employees(), false) then
    if public.current_access_can_see_employee(null, null)
       or public.current_access_can_see_employee('', '')
       or public.current_access_can_see_employee('  ', '  ')
       or public.current_access_can_see_employee(null, '') then
      raise exception 'refusing: a caller with no HR id still matches a row with no HR id';
    end if;
    if public.current_access_can_see_employee(null, null) is null then
      raise exception 'refusing: current_access_can_see_employee can still answer NULL';
    end if;
  end if;

  if has_function_privilege('anon', 'public.current_access_can_see_employee(text, text)', 'EXECUTE') then
    raise exception 'refusing: anon can execute public.current_access_can_see_employee';
  end if;
  if not has_function_privilege('authenticated', 'public.current_access_can_see_employee(text, text)', 'EXECUTE') then
    raise exception 'refusing: authenticated lost EXECUTE on public.current_access_can_see_employee (the live policies and smokes need it)';
  end if;
  if not has_function_privilege('service_role', 'public.current_access_can_see_employee(text, text)', 'EXECUTE') then
    raise exception 'refusing: service_role lost EXECUTE on public.current_access_can_see_employee';
  end if;
end
$$;
