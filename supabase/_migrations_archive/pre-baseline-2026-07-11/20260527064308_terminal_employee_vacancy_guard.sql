-- Terminal employee vacancy guard.
--
-- App routes already open resignation vacancies, but direct Supabase edits can
-- bypass the route. This trigger makes terminal lifecycle edits idempotently
-- mirror into position_vacancies so Organogram remains a read-only mirror of
-- Employee Master instead of relying only on UI/API behavior.

alter table public.position_vacancies
  add column if not exists replacement_for_hr_id text,
  add column if not exists filled_by_hr_id text,
  add column if not exists filled_at timestamptz,
  add column if not exists manager_replacement_for_hr_id text;
create index if not exists position_vacancies_replacement_for_hr_id_idx
on public.position_vacancies (replacement_for_hr_id);
create index if not exists position_vacancies_manager_replacement_for_hr_id_idx
on public.position_vacancies (manager_replacement_for_hr_id);
create or replace function public.phx_ensure_terminal_employee_vacancy(
  p_employee_hr_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee public.employees%rowtype;
  v_existing_vacancy_id bigint;
  v_manager_name text;
  v_vacancy_code text;
  v_effective_date date;
begin
  if nullif(trim(coalesce(p_employee_hr_id, '')), '') is null then
    return jsonb_build_object('applied', false, 'reason', 'missing_employee_hr_id');
  end if;

  select *
  into v_employee
  from public.employees
  where hr_id = upper(trim(p_employee_hr_id));

  if not found then
    return jsonb_build_object('applied', false, 'reason', 'employee_not_found');
  end if;

  if lower(coalesce(v_employee.employment_status, 'active')) not in ('resigned', 'terminated', 'inactive') then
    return jsonb_build_object('applied', false, 'reason', 'employee_not_terminal');
  end if;

  select full_name
  into v_manager_name
  from public.employees
  where hr_id = v_employee.manager_hr_id;

  v_effective_date := coalesce(
    v_employee.last_working_date,
    v_employee.resignation_date,
    v_employee.updated_at::date,
    v_employee.created_at::date,
    current_date
  );

  select id
  into v_existing_vacancy_id
  from public.position_vacancies
  where lower(coalesce(status, 'open')) = 'open'
    and (
      replacement_for_hr_id = v_employee.hr_id
      or (
        nullif(trim(coalesce(replacement_for_hr_id, '')), '') is null
        and area_id is not distinct from v_employee.area_id
        and line_id is not distinct from v_employee.line_id
        and position_id is not distinct from v_employee.position_id
        and manager_hr_id is not distinct from v_employee.manager_hr_id
      )
    )
  order by
    case when replacement_for_hr_id = v_employee.hr_id then 0 else 1 end,
    created_at asc,
    id asc
  limit 1;

  if v_existing_vacancy_id is not null then
    update public.position_vacancies
    set
      area_id = v_employee.area_id,
      department_id = v_employee.department_id,
      job_title = v_employee.job_title,
      line_id = v_employee.line_id,
      manager_hr_id = v_employee.manager_hr_id,
      manager_name = v_manager_name,
      position_id = v_employee.position_id,
      region_name = v_employee.region_name,
      replacement_for_hr_id = v_employee.hr_id,
      note = case
        when coalesce(note, '') ilike '%Terminal employee vacancy guard:%' then note
        else concat_ws(
          E'\n',
          nullif(note, ''),
          'Terminal employee vacancy guard: linked open vacancy to terminal employee '
            || v_employee.hr_id || ' on ' || current_date::text || '.'
        )
      end,
      updated_at = now()
    where id = v_existing_vacancy_id;
  else
    v_vacancy_code := 'VAC-TERM-'
      || regexp_replace(upper(v_employee.hr_id), '[^A-Z0-9]+', '', 'g')
      || '-'
      || substr(md5(v_employee.hr_id || '|' || coalesce(v_effective_date::text, current_date::text)), 1, 6);

    insert into public.position_vacancies (
      area_id,
      created_at,
      department_id,
      job_title,
      line_id,
      manager_hr_id,
      manager_name,
      note,
      position_id,
      region_name,
      replacement_for_hr_id,
      status,
      updated_at,
      vacancy_code
    )
    values (
      v_employee.area_id,
      now(),
      v_employee.department_id,
      v_employee.job_title,
      v_employee.line_id,
      v_employee.manager_hr_id,
      v_manager_name,
      'Terminal employee vacancy guard: auto-opened from direct lifecycle edit for '
        || v_employee.full_name || ' (' || v_employee.hr_id || '). Effective '
        || coalesce(v_effective_date::text, current_date::text) || '.',
      v_employee.position_id,
      v_employee.region_name,
      v_employee.hr_id,
      'open',
      now(),
      v_vacancy_code
    )
    returning id into v_existing_vacancy_id;
  end if;

  if to_regprocedure('public.phx_release_terminal_manager_ownership(text)') is not null then
    perform public.phx_release_terminal_manager_ownership(v_employee.hr_id);
  end if;

  return jsonb_build_object(
    'applied', true,
    'employee_hr_id', v_employee.hr_id,
    'vacancy_id', v_existing_vacancy_id,
    'replacement_for_hr_id', v_employee.hr_id
  );
exception
  when undefined_column then
    raise notice 'Terminal employee vacancy guard skipped because expected lifecycle/vacancy columns are missing.';
    return jsonb_build_object('applied', false, 'reason', 'missing_schema_column');
end;
$$;
revoke execute on function public.phx_ensure_terminal_employee_vacancy(text)
from public, anon, authenticated;
grant execute on function public.phx_ensure_terminal_employee_vacancy(text)
to service_role;
create or replace function public.phx_terminal_employee_vacancy_guard_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.employment_status, 'active')) in ('resigned', 'terminated', 'inactive') then
    perform public.phx_ensure_terminal_employee_vacancy(new.hr_id);
  end if;

  return new;
end;
$$;
drop trigger if exists phx_employee_terminal_vacancy_guard on public.employees;
create trigger phx_employee_terminal_vacancy_guard
after insert or update of
  employment_status,
  payroll_eligible,
  organogram_visible,
  manager_hr_id,
  department_id,
  line_id,
  area_id,
  position_id,
  job_title,
  region_name
on public.employees
for each row
execute function public.phx_terminal_employee_vacancy_guard_trigger();
notify pgrst, 'reload schema';
