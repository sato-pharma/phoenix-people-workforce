-- v_access_identity_health: stop reporting terminal-state employees as needing a Phoenix login.
--
-- THE DEFECT. The `active_employee_without_auth_user` branch excludes employment_status
-- resigned / terminated / inactive / left. It does NOT exclude `historical_payroll_record` or
-- `system_placeholder`, both of which are real, live values in public.employees. Measured 2026-08-12:
--
--                                staging    production
--   historical_payroll_record         16            15
--   system_placeholder                 2             2
--
-- So the view reported 19 issues on staging and 18 on production, of which 18 and 17 respectively
-- were a historical payroll row or a system placeholder — neither of which is a person, and neither
-- of which should ever hold a login. The single genuine finding on both projects (hr_id ADMIN-HR,
-- whose login is filed under hr_id PHX-1) was buried in that noise.
--
-- THE TWO STATUS NAMES ARE NOT INVENTED HERE. src/lib/imports/employee-lifecycle.ts:14 names the
-- terminal lifecycle states as "resigned / terminated / historical_payroll_record /
-- system_placeholder" and calls itself the single source of truth for employee activeness.
--
-- WHY THIS STAYS A DENY-LIST rather than adopting that file's allow-list
-- (activeImportEmployeeStatuses = {active, on_leave}). The two predicates answer different
-- questions: that one is "should the master import update this row?", this one is "should this person
-- hold a Phoenix login?" — and an `on_leave` employee should still have one. More importantly the
-- failure modes differ. A deny-list that misses a new terminal status OVER-reports: noisy, visible,
-- exactly the bug being fixed here, and safe. An allow-list that misses a new active-ish status
-- UNDER-reports: a real person with no login, silently absent from a health check. For a detector,
-- noisy beats silent. Add new terminal statuses here as they appear.
--
-- `inactive` and `left` are kept even though neither appears in either database today: removing them
-- would be an unrelated behaviour change, and they are harmless.
--
-- CREATE OR REPLACE, NOT DROP + CREATE, for two reasons:
--   1. `with (security_invoker = true)` is restated explicitly. The live view carries it on BOTH
--      projects (pg_class.reloptions, verified 2026-08-12) and a bare `create or replace view` that
--      omits it SILENTLY STRIPS IT — the exact regression 20260801104500 documents and that
--      scripts/check-migrations-applied.ts warns about for ireports360_visits_effective.
--   2. Replace preserves the grants; drop + create would discard them. postgres, service_role and
--      authenticated each hold full privileges here and must keep them.
--
-- Every other branch of the view is reproduced byte-for-byte from pg_get_viewdef() as it stands
-- today. The ONLY change is the two added array elements.
--
-- Rollback: re-run this file with the two added statuses removed from the ARRAY below.

begin;

create or replace view public.v_access_identity_health
  with (security_invoker = true)
as
 WITH active_profiles AS (
         SELECT user_access_profiles.auth_user_id,
            lower(TRIM(BOTH FROM COALESCE(user_access_profiles.hr_id, ''::text))) AS hr_key,
            lower(TRIM(BOTH FROM COALESCE(user_access_profiles.login_id, ''::text))) AS login_key,
            count(*) OVER (PARTITION BY user_access_profiles.auth_user_id) AS auth_user_active_profile_count,
            count(*) OVER (PARTITION BY (lower(TRIM(BOTH FROM COALESCE(user_access_profiles.hr_id, ''::text))))) AS hr_id_active_profile_count,
            count(*) OVER (PARTITION BY (lower(TRIM(BOTH FROM COALESCE(user_access_profiles.login_id, ''::text))))) AS login_id_active_profile_count
           FROM user_access_profiles
          WHERE COALESCE(user_access_profiles.is_active, true) = true
        )
 SELECT 'duplicate_active_auth_user_profile'::text AS issue_type,
    active_profiles.auth_user_id::text AS entity_key,
    jsonb_build_object('count', active_profiles.auth_user_active_profile_count) AS details
   FROM active_profiles
  WHERE active_profiles.auth_user_id IS NOT NULL AND active_profiles.auth_user_active_profile_count > 1
UNION ALL
 SELECT 'duplicate_active_hr_id_profile'::text AS issue_type,
    active_profiles.hr_key AS entity_key,
    jsonb_build_object('count', active_profiles.hr_id_active_profile_count) AS details
   FROM active_profiles
  WHERE active_profiles.hr_key <> ''::text AND active_profiles.hr_id_active_profile_count > 1
UNION ALL
 SELECT 'duplicate_active_login_id_profile'::text AS issue_type,
    active_profiles.login_key AS entity_key,
    jsonb_build_object('count', active_profiles.login_id_active_profile_count) AS details
   FROM active_profiles
  WHERE active_profiles.login_key <> ''::text AND active_profiles.login_id_active_profile_count > 1
UNION ALL
 SELECT 'active_employee_without_auth_user'::text AS issue_type,
    e.hr_id AS entity_key,
    jsonb_build_object('employee_status', e.employment_status) AS details
   FROM employees e
  WHERE NULLIF(TRIM(BOTH FROM COALESCE(e.hr_id, ''::text)), ''::text) IS NOT NULL AND (lower(COALESCE(e.employment_status, 'active'::text)) <> ALL (ARRAY['resigned'::text, 'terminated'::text, 'inactive'::text, 'left'::text, 'historical_payroll_record'::text, 'system_placeholder'::text])) AND NOT (EXISTS ( SELECT 1
           FROM app_auth_users a
          WHERE lower(TRIM(BOTH FROM COALESCE(a.hr_id, ''::text))) = lower(TRIM(BOTH FROM e.hr_id))))
UNION ALL
 SELECT 'auth_user_without_employee'::text AS issue_type,
    a.login_id AS entity_key,
    jsonb_build_object('hr_id', a.hr_id, 'role', a.role) AS details
   FROM app_auth_users a
  WHERE NULLIF(TRIM(BOTH FROM COALESCE(a.hr_id, ''::text)), ''::text) IS NOT NULL AND NOT (EXISTS ( SELECT 1
           FROM employees e
          WHERE lower(TRIM(BOTH FROM COALESCE(e.hr_id, ''::text))) = lower(TRIM(BOTH FROM a.hr_id))))
UNION ALL
 SELECT 'auth_user_missing_role'::text AS issue_type,
    a.login_id AS entity_key,
    jsonb_build_object('hr_id', a.hr_id) AS details
   FROM app_auth_users a
  WHERE NULLIF(TRIM(BOTH FROM COALESCE(a.role, ''::text)), ''::text) IS NULL;

comment on view public.v_access_identity_health is
  'Identity-layer health: duplicate active profiles, employees with no login, logins with no employee, '
  'logins with no role. The active-employee branch excludes terminal lifecycle statuses (resigned, '
  'terminated, inactive, left, historical_payroll_record, system_placeholder) — a historical payroll '
  'row and a system placeholder are not people and must never be reported as needing a login. Kept as '
  'a deny-list on purpose: a missed terminal status over-reports (visible), while an allow-list that '
  'missed an active status would hide a real person with no login.';

-- ── VERIFY. A create-or-replace that quietly dropped security_invoker or a grant would otherwise
-- look identical to a successful one, which is how this class of regression ships.
do $verify$
declare
  invoker text;
  missing_grants int;
begin
  select array_to_string(reloptions, ',') into invoker
  from pg_class where oid = 'public.v_access_identity_health'::regclass;

  if invoker is null or position('security_invoker=true' in invoker) = 0 then
    raise exception
      'security_invoker is no longer set on v_access_identity_health (reloptions=%) — the replace '
      'stripped it. Rolling back.', coalesce(invoker, '(null)');
  end if;

  select count(*) into missing_grants
  from unnest(array['service_role', 'authenticated']) as g(role_name)
  where not has_table_privilege(g.role_name, 'public.v_access_identity_health', 'SELECT');

  if missing_grants > 0 then
    raise exception
      '% expected grantee(s) lost SELECT on v_access_identity_health — rolling back.', missing_grants;
  end if;

  -- The fix itself: no terminal-status row may be reported any more.
  if exists (
    select 1 from public.v_access_identity_health
    where issue_type = 'active_employee_without_auth_user'
      and lower(coalesce(details->>'employee_status', '')) in ('historical_payroll_record', 'system_placeholder')
  ) then
    raise exception 'a terminal-status employee is still reported as needing a login — rolling back.';
  end if;

  raise notice 'verify: security_invoker intact, grants intact, terminal statuses no longer reported';
end
$verify$;

commit;
