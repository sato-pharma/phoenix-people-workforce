-- capture_phx_reassign_replacement_ownership_live_body
--
-- WHAT THIS CHANGES: nothing in either database. It writes down, as a repo file, the body that
-- public.phx_reassign_replacement_ownership(text, text, date) ALREADY has on production and on
-- staging — read live on 18 Nov 2026 with pg_get_functiondef, md5(prosrc) 6f4ad6cc6c93ab751681bafce6295950
-- on BOTH projects, SECURITY DEFINER, search_path public, EXECUTE held by postgres and service_role only.
--
-- WHY: that body (the "adopt an unowned vacancy on the replaced manager's own line and region" step)
-- reached production as ledger version 20261026034726 with no file in supabase/migrations. The last
-- file that defines the function is 20260814190000, which has no unowned-vacancy step at all. So a
-- database rebuilt from this folder would silently lose it, and the next migration written against
-- the 14 Aug file would quietly take it back out of production. Found by the Supabase audit of
-- 18 Nov 2026. CREATE OR REPLACE with the identical text is a no-op; the md5 above is the check.
--
-- ROLLBACK: none needed — the function text is unchanged. To return to the 14 Aug behaviour, re-run
-- the function block of 20260814190000_reassign_ownership_stop_writing_frozen_sales_records.sql.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

CREATE OR REPLACE FUNCTION public.phx_reassign_replacement_ownership(p_previous_hr_id text, p_replacement_hr_id text, p_effective_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_previous_hr_id text := upper(trim(coalesce(p_previous_hr_id, '')));
  v_replacement_hr_id text := upper(trim(coalesce(p_replacement_hr_id, '')));
  v_effective_date date := coalesce(p_effective_date, (now() at time zone 'Africa/Cairo')::date);
  v_previous_status text;
  v_previous_line_id integer;
  v_previous_region text;
  v_replacement_name text;
  v_replacement_status text;
  v_replacement_line_id integer;
  v_replacement_region text;
  v_adopt_line_id integer;
  v_adopt_region text;
  v_count integer := 0;
  v_result jsonb := '{}'::jsonb;
begin
  if v_previous_hr_id = '' or v_replacement_hr_id = '' then
    return jsonb_build_object('applied', false, 'reason', 'missing_hr_id');
  end if;

  if v_previous_hr_id = v_replacement_hr_id then
    return jsonb_build_object('applied', false, 'reason', 'same_hr_id');
  end if;

  select lower(coalesce(employment_status, 'active')), line_id, lower(trim(coalesce(region_name, '')))
  into v_previous_status, v_previous_line_id, v_previous_region
  from public.employees
  where hr_id = v_previous_hr_id;

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_found');
  end if;

  if v_previous_status not in ('resigned', 'terminated', 'inactive') then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_terminal');
  end if;

  select full_name, lower(coalesce(employment_status, 'active')), line_id, lower(trim(coalesce(region_name, '')))
  into v_replacement_name, v_replacement_status, v_replacement_line_id, v_replacement_region
  from public.employees
  where hr_id = v_replacement_hr_id
    and coalesce(payroll_eligible, true) is true
    and coalesce(organogram_visible, true) is true;

  if not found or v_replacement_status not in ('active', 'on_leave') then
    return jsonb_build_object('applied', false, 'reason', 'replacement_employee_not_active');
  end if;

  -- Unowned vacancies are adopted only when the replacement takes over the SAME line and region the
  -- replaced manager held; any difference (or a missing region) adopts nothing.
  if v_previous_line_id is not null
     and v_previous_line_id = v_replacement_line_id
     and v_previous_region <> ''
     and v_previous_region = v_replacement_region then
    v_adopt_line_id := v_previous_line_id;
    v_adopt_region := v_previous_region;
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

  -- A vacancy with NO manager is invisible to the update above (null = anything is never true).
  -- Adopt it when it sits on the replaced manager's line and region -- but never a vacancy that is
  -- itself a manager seat, which has no manager above it by design.
  if v_adopt_line_id is not null then
    update public.position_vacancies
    set
      manager_hr_id = v_replacement_hr_id,
      manager_name = v_replacement_name,
      note = case
        when coalesce(note, '') ilike '%Replacement ownership engine:%' then note
        else concat_ws(
          E'\n',
          nullif(note, ''),
          'Replacement ownership engine: gave the unowned live vacancy to ' || v_replacement_hr_id
            || ' on ' || (now() at time zone 'Africa/Cairo')::date::text || '.'
        )
      end,
      updated_at = now()
    where manager_hr_id is null
      and lower(coalesce(status, 'open')) = 'open'
      and line_id = v_adopt_line_id
      and lower(trim(coalesce(region_name, ''))) = v_adopt_region
      and coalesce(job_title, '') !~* '(manager|dsm)';

    get diagnostics v_count = row_count;
    v_result := v_result || jsonb_build_object('unowned_vacancies_adopted', v_count);
  end if;

  -- sales_records is FROZEN H1 history and is deliberately never touched here. See 20260814190000.
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

-- Already true on both projects (EXECUTE: postgres and service_role only); restated so a rebuild
-- from this folder lands the same grants. Revoking PUBLIC is what removes anon and authenticated.
revoke execute on function public.phx_reassign_replacement_ownership(text, text, date) from public, anon, authenticated;
grant execute on function public.phx_reassign_replacement_ownership(text, text, date) to service_role;

commit;
