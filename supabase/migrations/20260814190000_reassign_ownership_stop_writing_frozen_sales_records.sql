-- phx_reassign_replacement_ownership must stop rewriting the frozen sales_records table.
--
-- The Rule #1 work froze `public.sales_records` by revoking service_role's INSERT/UPDATE/DELETE, so
-- the 11,267 H1 rows -- the only record of what H1 2026 was actually paid on -- could not be changed.
--
-- That revoke does not hold here. This function is SECURITY DEFINER and is owned by `postgres`, so
-- its body runs with the owner's rights and the revoke on service_role never applies. The function
-- carried this block:
--
--     update public.sales_records
--        set manager_hr_id = $2
--      where manager_hr_id = $1
--        and (year > extract(year from $3::date)::integer
--             or (year = extract(year from $3::date)::integer
--                 and month >= extract(month from $3::date)::integer))
--
-- `$3` is p_effective_date, which the application sources from `employee_resignations.effective_date`
-- (falling back to `last_working_date`) for the person being replaced -- see
-- `replacementForVacancy` / `reassignLiveManagerOwnership` in src/lib/employees/employee-directory.ts.
-- That date is routinely in the past: production holds 20 resignations with an H1-2026 effective
-- date. So a resignation date corrected backwards, followed by a replacement hire, silently restates
-- settled H1 sales attribution.
--
-- Measured on production before this change -- the armed set is terminal-status employees who still
-- own sales_records rows, because the function refuses unless the previous employee is
-- resigned/terminated/inactive:
--
--   HR_ID   rows  periods          target_value    recorded resignation
--   B-5      600  202601..202606   3,555,233.84    2026-07-31
--   B-28     140  202601..202605     997,096.88    2026-07-31
--   B-175    120  202601..202605   1,555,268.33    2026-08-03
--   B-157     20  202601..202605     328,742.96    2026-08-31
--                 ------------------------------
--                 880 rows        6,436,342.01 EGP
--
-- Nothing rewrites today: every recorded date is July or later and sales_records stops at 202606, so
-- the month floor excludes every row. The exposure is the correction, not the current state.
--
-- The write is also pointless now. Sales attribution comes from SoS Monthly Closing, which resolves
-- the manager from the seat model per period, so there is nothing here left to keep in sync. This is
-- the same defect PR #2135 removed from the TypeScript fallback in `reassignLiveManagerOwnership`;
-- that fallback only runs when this RPC is MISSING, so the live path kept doing it.
--
-- The block is replaced by a null report, exactly as `sales_targets_reassigned` already reports null.
-- Every other reassignment this function performs -- app_auth_users, user_access_profiles, employees,
-- position_vacancies -- is unchanged and still runs.
--
-- CREATE OR REPLACE preserves the function's owner and its existing grants.

create or replace function public.phx_reassign_replacement_ownership(
  p_previous_hr_id text,
  p_replacement_hr_id text,
  p_effective_date date default null::date
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_previous_hr_id text := upper(trim(coalesce(p_previous_hr_id, '')));
  v_replacement_hr_id text := upper(trim(coalesce(p_replacement_hr_id, '')));
  v_effective_date date := coalesce(p_effective_date, (now() at time zone 'Africa/Cairo')::date);
  v_previous_status text;
  v_replacement_name text;
  v_replacement_status text;
  v_count integer := 0;
  v_result jsonb := '{}'::jsonb;
begin
  if v_previous_hr_id = '' or v_replacement_hr_id = '' then
    return jsonb_build_object('applied', false, 'reason', 'missing_hr_id');
  end if;

  if v_previous_hr_id = v_replacement_hr_id then
    return jsonb_build_object('applied', false, 'reason', 'same_hr_id');
  end if;

  select lower(coalesce(employment_status, 'active'))
  into v_previous_status
  from public.employees
  where hr_id = v_previous_hr_id;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_found');
  end if;

  if v_previous_status not in ('resigned', 'terminated', 'inactive') then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_terminal');
  end if;

  select full_name, lower(coalesce(employment_status, 'active'))
  into v_replacement_name, v_replacement_status
  from public.employees
  where hr_id = v_replacement_hr_id
    and coalesce(payroll_eligible, true) is true
    and coalesce(organogram_visible, true) is true;

  if not found or v_replacement_status not in ('active', 'on_leave') then
    return jsonb_build_object('applied', false, 'reason', 'replacement_employee_not_active');
  end if;

  if to_regclass('public.app_auth_users') is not null then
    begin
      execute
        'update public.app_auth_users u
         set manager_hr_id = $2, updated_at = now()
         where u.is_active is true
           and (
             u.manager_hr_id = $1
             or exists (
               select 1
               from public.employees e
               where e.hr_id = u.hr_id
                 and e.pending_manager_replacement_for_hr_id = $1
             )
           )'
        using v_previous_hr_id, v_replacement_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('app_auth_users_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('app_auth_users_reassigned', null);
    end;
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    begin
      execute
        'update public.user_access_profiles u
         set manager_hr_id = $2, updated_at = now()
         where u.is_active is true
           and (
             u.manager_hr_id = $1
             or exists (
               select 1
               from public.employees e
               where e.hr_id = u.hr_id
                 and e.pending_manager_replacement_for_hr_id = $1
             )
           )'
        using v_previous_hr_id, v_replacement_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('user_access_profiles_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('user_access_profiles_reassigned', null);
    end;
  end if;

  update public.employees
  set
    manager_hr_id = v_replacement_hr_id,
    pending_manager_replacement_for_hr_id = null,
    updated_at = now()
  where (
      manager_hr_id = v_previous_hr_id
      or pending_manager_replacement_for_hr_id = v_previous_hr_id
    )
    and lower(coalesce(employment_status, 'active')) in ('active', 'on_leave');

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('employees_reassigned', v_count);

  update public.position_vacancies
  set
    manager_hr_id = v_replacement_hr_id,
    manager_name = v_replacement_name,
    manager_replacement_for_hr_id = null,
    note = case
      when coalesce(note, '') ilike '%Replacement ownership engine:%' then note
      else concat_ws(
        E'\n',
        nullif(note, ''),
        'Replacement ownership engine: moved live vacancy manager from '
          || v_previous_hr_id || ' to ' || v_replacement_hr_id || ' on ' || (now() at time zone 'Africa/Cairo')::date::text || '.'
      )
    end,
    updated_at = now()
  where (
      manager_hr_id = v_previous_hr_id
      or manager_replacement_for_hr_id = v_previous_hr_id
    )
    and lower(coalesce(status, 'open')) = 'open';

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('vacancies_reassigned', v_count);

  -- sales_records is FROZEN H1 history and is deliberately never touched here. See the header.
  v_result := v_result || jsonb_build_object('sales_records_reassigned', null);
  v_result := v_result || jsonb_build_object('sales_targets_reassigned', null);

  return jsonb_build_object(
    'applied', true,
    'previous_hr_id', v_previous_hr_id,
    'replacement_hr_id', v_replacement_hr_id,
    'effective_date', v_effective_date
  ) || v_result;
end;
$function$;

-- Production's live ACL is already {postgres=X/postgres,service_role=X/postgres}, and CREATE OR
-- REPLACE preserves it -- so on production these two statements change nothing. They are here for
-- the replay case: against a database where this function does NOT exist (a fresh environment, a
-- db reset, a branch), the statement above is a CREATE, and a newly created function carries the
-- default ACL granting EXECUTE to PUBLIC. anon and authenticated are members of PUBLIC, so the
-- function would be callable with the anonymous key -- and it reassigns org ownership.
--
-- Revoking PUBLIC on a default ACL also strips service_role, so the grant has to be re-stated.
revoke execute on function public.phx_reassign_replacement_ownership(text, text, date)
  from public, anon, authenticated;

grant execute on function public.phx_reassign_replacement_ownership(text, text, date)
  to service_role;

-- Fail loudly if the replacement did not land, or landed still carrying the write. A partial or
-- silently-skipped apply must not be mistakable for success.
do $verify$
declare
  v_src text;
  v_secdef boolean;
  v_oid oid;
begin
  select p.prosrc, p.prosecdef, p.oid
    into v_src, v_secdef, v_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'phx_reassign_replacement_ownership';

  if v_src is null then
    raise exception 'phx_reassign_replacement_ownership is MISSING after the replace';
  end if;

  if v_src ~* '(update|insert\s+into|delete\s+from)\s+(public\.)?sales_records\M' then
    raise exception
      'phx_reassign_replacement_ownership still writes sales_records - the SECURITY DEFINER back door around the freeze is still open';
  end if;

  if not v_secdef then
    raise exception 'phx_reassign_replacement_ownership lost SECURITY DEFINER; it needs owner rights for the tables it legitimately updates';
  end if;

  -- The reassignments that must survive this change.
  if v_src !~* 'update\s+public\.employees' or v_src !~* 'update\s+public\.position_vacancies' then
    raise exception 'phx_reassign_replacement_ownership lost a legitimate reassignment - employees/position_vacancies must still be updated';
  end if;

  -- The function reassigns org ownership. It must never be reachable with the anonymous key.
  if has_function_privilege('anon', v_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception
      'phx_reassign_replacement_ownership is EXECUTEable by anon/authenticated - the revoke did not take';
  end if;

  if not has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception
      'phx_reassign_replacement_ownership lost service_role EXECUTE - the application calls it through PostgREST and would 404';
  end if;
end
$verify$;
