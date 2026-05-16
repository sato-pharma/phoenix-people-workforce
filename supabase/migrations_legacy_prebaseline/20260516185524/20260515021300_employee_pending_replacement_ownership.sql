-- Pending replacement ownership model.
--
-- If a manager resigns before the replacement is hired, active children and
-- open subordinate vacancies must not keep pointing at the terminal manager.
-- They are temporarily held by the resigned manager's upstream manager and
-- marked so the eventual replacement can inherit them automatically.

alter table public.employees
  add column if not exists pending_manager_replacement_for_hr_id text;

alter table public.position_vacancies
  add column if not exists manager_replacement_for_hr_id text;

comment on column public.employees.pending_manager_replacement_for_hr_id is
  'Terminal manager HR_ID whose replacement should inherit this employee report when hired.';

comment on column public.position_vacancies.manager_replacement_for_hr_id is
  'Terminal manager HR_ID whose replacement should inherit this open subordinate vacancy when hired.';

create index if not exists employees_pending_manager_replacement_for_hr_id_idx
on public.employees (pending_manager_replacement_for_hr_id);

create index if not exists position_vacancies_manager_replacement_for_hr_id_idx
on public.position_vacancies (manager_replacement_for_hr_id);

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

  if to_regclass('public.sales_targets') is not null then
    begin
      execute
        'update public.sales_targets
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
      v_result := v_result || jsonb_build_object('sales_targets_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('sales_targets_reassigned', null);
    end;
  end if;

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

create or replace function public.phx_release_terminal_manager_ownership(
  p_previous_hr_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous public.employees%rowtype;
  v_upstream_name text;
  v_count integer := 0;
  v_result jsonb := '{}'::jsonb;
begin
  select *
  into v_previous
  from public.employees
  where hr_id = upper(trim(coalesce(p_previous_hr_id, '')));

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_found');
  end if;

  if lower(coalesce(v_previous.employment_status, 'active')) not in ('resigned', 'terminated', 'inactive') then
    return jsonb_build_object('applied', false, 'reason', 'previous_employee_not_terminal');
  end if;

  if nullif(trim(coalesce(v_previous.manager_hr_id, '')), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'upstream_manager_missing');
  end if;

  select full_name
  into v_upstream_name
  from public.employees
  where hr_id = v_previous.manager_hr_id;

  update public.employees
  set
    manager_hr_id = v_previous.manager_hr_id,
    pending_manager_replacement_for_hr_id = v_previous.hr_id,
    updated_at = now()
  where manager_hr_id = v_previous.hr_id
    and lower(coalesce(employment_status, 'active')) in ('active', 'on_leave');

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('employees_released_to_upstream', v_count);

  update public.position_vacancies
  set
    manager_hr_id = v_previous.manager_hr_id,
    manager_name = v_upstream_name,
    manager_replacement_for_hr_id = v_previous.hr_id,
    note = case
      when coalesce(note, '') ilike '%Pending replacement ownership:%' then note
      else concat_ws(
        E'\n',
        nullif(note, ''),
        'Pending replacement ownership: temporarily moved from terminal manager '
          || v_previous.hr_id || ' to upstream manager ' || v_previous.manager_hr_id
          || ' on ' || current_date::text || '.'
      )
    end,
    updated_at = now()
  where manager_hr_id = v_previous.hr_id
    and lower(coalesce(status, 'open')) = 'open';

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('vacancies_released_to_upstream', v_count);

  if to_regclass('public.app_auth_users') is not null then
    begin
      execute
        'update public.app_auth_users
         set manager_hr_id = $2, updated_at = now()
         where manager_hr_id = $1 and is_active is true'
        using v_previous.hr_id, v_previous.manager_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('app_auth_users_released_to_upstream', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('app_auth_users_released_to_upstream', null);
    end;
  end if;

  if to_regclass('public.user_access_profiles') is not null then
    begin
      execute
        'update public.user_access_profiles
         set manager_hr_id = $2, updated_at = now()
         where manager_hr_id = $1 and is_active is true'
        using v_previous.hr_id, v_previous.manager_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('user_access_profiles_released_to_upstream', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('user_access_profiles_released_to_upstream', null);
    end;
  end if;

  return jsonb_build_object(
    'applied', true,
    'previous_hr_id', v_previous.hr_id,
    'upstream_manager_hr_id', v_previous.manager_hr_id
  ) || v_result;
end;
$$;

revoke execute on function public.phx_release_terminal_manager_ownership(text)
from public, anon, authenticated;

grant execute on function public.phx_release_terminal_manager_ownership(text)
to service_role;

create or replace function public.phx_release_terminal_manager_ownership_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.employment_status, 'active')) in ('resigned', 'terminated', 'inactive') then
    perform public.phx_release_terminal_manager_ownership(new.hr_id);
  end if;

  return new;
end;
$$;

drop trigger if exists phx_employee_terminal_release_manager_ownership on public.employees;

create trigger phx_employee_terminal_release_manager_ownership
after update of employment_status, payroll_eligible, organogram_visible
on public.employees
for each row
when (
  lower(coalesce(new.employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
  and (
    lower(coalesce(old.employment_status, 'active')) not in ('resigned', 'terminated', 'inactive')
    or old.payroll_eligible is distinct from new.payroll_eligible
    or old.organogram_visible is distinct from new.organogram_visible
  )
)
execute function public.phx_release_terminal_manager_ownership_trigger();

do $$
declare
  r record;
begin
  for r in
    select hr_id
    from public.employees
    where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
  loop
    perform public.phx_release_terminal_manager_ownership(r.hr_id);
  end loop;

  for r in
    with terminal_managers as (
      select
        hr_id,
        area_id,
        line_id,
        position_id,
        manager_hr_id,
        coalesce(last_working_date, resignation_date, updated_at::date, created_at::date, current_date) as effective_date
      from public.employees
      where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
    ),
    replacement_candidates as (
      select
        t.hr_id as previous_hr_id,
        a.hr_id as replacement_hr_id,
        t.effective_date,
        count(*) over (partition by t.hr_id) as candidate_count
      from terminal_managers t
      join public.employees a
        on a.hr_id <> t.hr_id
       and a.area_id is not distinct from t.area_id
       and a.line_id is not distinct from t.line_id
       and a.position_id is not distinct from t.position_id
       and a.manager_hr_id is not distinct from t.manager_hr_id
       and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
       and coalesce(a.payroll_eligible, true) is true
       and coalesce(a.organogram_visible, true) is true
    )
    select previous_hr_id, replacement_hr_id, effective_date
    from replacement_candidates
    where candidate_count = 1
  loop
    perform public.phx_reassign_replacement_ownership(
      r.previous_hr_id,
      r.replacement_hr_id,
      r.effective_date
    );
  end loop;
end $$;

notify pgrst, 'reload schema';
