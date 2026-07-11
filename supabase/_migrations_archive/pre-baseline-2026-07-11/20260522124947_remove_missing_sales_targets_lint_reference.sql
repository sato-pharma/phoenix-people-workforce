create or replace function public.phx_reassign_replacement_ownership(
  p_previous_hr_id text,
  p_replacement_hr_id text,
  p_effective_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_hr_id text := upper(trim(coalesce(p_previous_hr_id, '')));
  v_replacement_hr_id text := upper(trim(coalesce(p_replacement_hr_id, '')));
  v_effective_date date := coalesce(p_effective_date, current_date);
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
          || v_previous_hr_id || ' to ' || v_replacement_hr_id || ' on ' || current_date::text || '.'
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

  if to_regclass('public.sales_records') is not null then
    begin
      execute
        'update public.sales_records
         set manager_hr_id = $2
         where manager_hr_id = $1
           and (
             year > extract(year from $3::date)::integer
             or (
               year = extract(year from $3::date)::integer
               and month >= extract(month from $3::date)::integer
             )
           )'
        using v_previous_hr_id, v_replacement_hr_id, v_effective_date;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('sales_records_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('sales_records_reassigned', null);
    end;
  end if;

  v_result := v_result || jsonb_build_object('sales_targets_reassigned', null);

  return jsonb_build_object(
    'applied', true,
    'previous_hr_id', v_previous_hr_id,
    'replacement_hr_id', v_replacement_hr_id,
    'effective_date', v_effective_date
  ) || v_result;
end;
$$;
revoke execute on function public.phx_reassign_replacement_ownership(text, text, date)
from public, anon, authenticated;
grant execute on function public.phx_reassign_replacement_ownership(text, text, date)
to service_role;
notify pgrst, 'reload schema';
