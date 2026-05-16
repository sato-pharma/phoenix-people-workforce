-- Generic employee replacement ownership engine.
--
-- Business rule:
-- When a resigned/terminated/inactive employee is replaced, the replacement
-- inherits the departed employee's live operational footprint. This includes
-- active direct reports, open subordinate vacancies, future sales ownership,
-- and active access reporting lines. Historical records remain unchanged.

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

  update public.employees
  set
    manager_hr_id = v_replacement_hr_id,
    updated_at = now()
  where manager_hr_id = v_previous_hr_id
    and lower(coalesce(employment_status, 'active')) in ('active', 'on_leave');

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('employees_reassigned', v_count);

  update public.position_vacancies
  set
    manager_hr_id = v_replacement_hr_id,
    manager_name = v_replacement_name,
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
  where manager_hr_id = v_previous_hr_id
    and lower(coalesce(status, 'open')) = 'open';

  get diagnostics v_count = row_count;
  v_result := v_result || jsonb_build_object('vacancies_reassigned', v_count);

  if to_regclass('public.app_auth_users') is not null then
    begin
      execute
        'update public.app_auth_users
         set manager_hr_id = $2, updated_at = now()
         where manager_hr_id = $1 and is_active is true'
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
        'update public.user_access_profiles
         set manager_hr_id = $2, updated_at = now()
         where manager_hr_id = $1 and is_active is true'
        using v_previous_hr_id, v_replacement_hr_id;

      get diagnostics v_count = row_count;
      v_result := v_result || jsonb_build_object('user_access_profiles_reassigned', v_count);
    exception
      when undefined_column then
        v_result := v_result || jsonb_build_object('user_access_profiles_reassigned', null);
    end;
  end if;

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

create or replace function public.phx_autofill_replacement_vacancy_from_employee_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match_count integer := 0;
  v_vacancy record;
  v_effective_date date;
begin
  if lower(coalesce(new.employment_status, 'active')) not in ('active', 'on_leave') then
    return new;
  end if;

  if coalesce(new.payroll_eligible, true) is not true
     or coalesce(new.organogram_visible, true) is not true then
    return new;
  end if;

  if new.area_id is null
     or new.line_id is null
     or new.position_id is null
     or nullif(trim(coalesce(new.manager_hr_id, '')), '') is null then
    return new;
  end if;

  select count(*)
  into v_match_count
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and v.area_id is not distinct from new.area_id
    and v.line_id is not distinct from new.line_id
    and v.position_id is not distinct from new.position_id
    and v.manager_hr_id is not distinct from new.manager_hr_id;

  -- Avoid guessing when more than one live vacancy has the same footprint.
  if v_match_count <> 1 then
    return new;
  end if;

  select id, replacement_for_hr_id
  into v_vacancy
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and v.area_id is not distinct from new.area_id
    and v.line_id is not distinct from new.line_id
    and v.position_id is not distinct from new.position_id
    and v.manager_hr_id is not distinct from new.manager_hr_id
  order by v.created_at asc, v.id asc
  limit 1;

  update public.position_vacancies
  set
    status = 'filled',
    filled_by_hr_id = new.hr_id,
    filled_at = now(),
    note = concat_ws(
      E'\n',
      nullif(note, ''),
      'Auto-filled by replacement ownership engine for ' || new.hr_id || ' on ' || current_date::text || '.'
    ),
    updated_at = now()
  where id = v_vacancy.id
    and lower(coalesce(status, 'open')) = 'open';

  if nullif(trim(coalesce(v_vacancy.replacement_for_hr_id, '')), '') is null then
    return new;
  end if;

  select coalesce(last_working_date, effective_date, resignation_date, current_date)
  into v_effective_date
  from public.employee_resignations
  where vacancy_id = v_vacancy.id
     or employee_hr_id = v_vacancy.replacement_for_hr_id
  order by created_at desc
  limit 1;

  perform public.phx_reassign_replacement_ownership(
    v_vacancy.replacement_for_hr_id,
    new.hr_id,
    coalesce(v_effective_date, current_date)
  );

  return new;
exception
  when undefined_column then
    raise notice 'Replacement ownership auto-fill skipped because expected lifecycle/vacancy columns are missing.';
    return new;
end;
$$;

drop trigger if exists phx_employee_insert_autofill_replacement_vacancy on public.employees;

create trigger phx_employee_insert_autofill_replacement_vacancy
after insert on public.employees
for each row
execute function public.phx_autofill_replacement_vacancy_from_employee_insert();

do $$
declare
  r record;
begin
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
