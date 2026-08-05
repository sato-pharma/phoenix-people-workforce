-- Last silent path in the hire chain.
--
-- When no tier matched a vacancy the function just returned, so the employee was created with no
-- seat, no error and NOTHING in audit_logs -- the seat trigger never runs, so its own
-- au_seat_hire_unresolved row is never written either. That is how a hire into an area whose seat
-- is already staffed disappeared without trace (verified live 2026-08-04: adding a second Pedia rep
-- to Imbaba produced no vacancy, no seat and no audit row).
--
-- Now every hire that reaches the matching step and finds nothing writes hire_vacancy_unmatched,
-- naming the employee and the line/area/position that had no free vacancy. The insert is wrapped
-- in its own handler: provisioning must never block a hire.
--
-- Only reached when area, line, position AND manager are all set (the guards above), so this
-- cannot fire for head-office records that legitimately have no vacancy footprint.

create or replace function public.phx_autofill_replacement_vacancy_from_employee_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_match_count    integer := 0;
  v_vacancy_id     bigint;
  v_vacancy        record;
  v_effective_date date;
  v_manager_scope  text;
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

  -- Tier 1: a vacancy already pointing at this hire's manager.
  select count(*), min(v.id)
  into v_match_count, v_vacancy_id
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and v.area_id is not distinct from new.area_id
    and v.line_id is not distinct from new.line_id
    and v.position_id is not distinct from new.position_id
    and v.manager_hr_id is not distinct from new.manager_hr_id;

  if v_match_count = 1 then
    v_manager_scope := 'exact';
  else
    v_vacancy_id := null;
  end if;

  -- Tier 2: the box exists but its manager was never recorded.
  if v_manager_scope is null then
    select count(*), min(v.id)
    into v_match_count, v_vacancy_id
    from public.position_vacancies v
    where lower(coalesce(v.status, 'open')) = 'open'
      and v.area_id is not distinct from new.area_id
      and v.line_id is not distinct from new.line_id
      and v.position_id is not distinct from new.position_id
      and v.manager_hr_id is null;

    if v_match_count = 1 then
      v_manager_scope := 'unknown_manager';
    else
      v_vacancy_id := null;
    end if;
  end if;

  -- Tier 3: the box names a manager who has since left the company.
  if v_manager_scope is null then
    select count(*), min(v.id)
    into v_match_count, v_vacancy_id
    from public.position_vacancies v
    left join public.employees m on m.hr_id = v.manager_hr_id
    where lower(coalesce(v.status, 'open')) = 'open'
      and v.area_id is not distinct from new.area_id
      and v.line_id is not distinct from new.line_id
      and v.position_id is not distinct from new.position_id
      and v.manager_hr_id is not null
      and (m.hr_id is null or lower(coalesce(m.employment_status, '')) <> 'active');

    if v_match_count = 1 then
      v_manager_scope := 'departed_manager';
    else
      v_vacancy_id := null;
    end if;
  end if;

  -- No tier produced exactly one candidate. Say so instead of returning silently.
  if v_vacancy_id is null then
    begin
      insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
      values (
        'system', 'hire_vacancy_unmatched', new.hr_id,
        format('No open vacancy matched %s - they will not appear on the organogram until a vacancy or seat is prepared',
          new.hr_id),
        jsonb_build_object(
          'employeeHrId', new.hr_id,
          'fullName', new.full_name,
          'lineId', new.line_id,
          'areaId', new.area_id,
          'positionId', new.position_id,
          'managerHrId', new.manager_hr_id,
          'openVacanciesForFootprint', (
            select count(*) from public.position_vacancies v
            where lower(coalesce(v.status, 'open')) = 'open'
              and v.area_id is not distinct from new.area_id
              and v.line_id is not distinct from new.line_id
              and v.position_id is not distinct from new.position_id
          )
        )
      );
    exception when others then
      null; -- logging must never block a hire
    end;
    return new;
  end if;

  select id, replacement_for_hr_id
  into v_vacancy
  from public.position_vacancies
  where id = v_vacancy_id;

  update public.position_vacancies
  set
    status = 'filled',
    filled_by_hr_id = new.hr_id,
    filled_at = now(),
    manager_hr_id = case when v_manager_scope in ('unknown_manager', 'departed_manager')
                         then new.manager_hr_id else manager_hr_id end,
    note = concat_ws(
      E'\n',
      nullif(note, ''),
      'Auto-filled by replacement ownership engine for ' || new.hr_id || ' on ' || (now() at time zone 'Africa/Cairo')::date::text
        || case v_manager_scope
             when 'unknown_manager' then ' (matched on area/line/position; the box had no manager recorded).'
             when 'departed_manager' then ' (matched on area/line/position; the box named a manager who has left).'
             else '.' end
    ),
    updated_at = now()
  where id = v_vacancy.id
    and lower(coalesce(status, 'open')) = 'open';

  if nullif(trim(coalesce(v_vacancy.replacement_for_hr_id, '')), '') is null then
    return new;
  end if;

  select coalesce(last_working_date, effective_date, resignation_date, (now() at time zone 'Africa/Cairo')::date)
  into v_effective_date
  from public.employee_resignations
  where vacancy_id = v_vacancy.id
     or employee_hr_id = v_vacancy.replacement_for_hr_id
  order by created_at desc
  limit 1;

  perform public.phx_reassign_replacement_ownership(
    v_vacancy.replacement_for_hr_id,
    new.hr_id,
    coalesce(v_effective_date, (now() at time zone 'Africa/Cairo')::date)
  );

  return new;
exception
  when undefined_column then
    raise notice 'Replacement ownership auto-fill skipped because expected lifecycle/vacancy columns are missing.';
    return new;
end;
$function$;

-- See 20260804090813: a public function inherits EXECUTE to PUBLIC by default and anon /
-- authenticated inherit it through PUBLIC membership. CREATE OR REPLACE keeps the live ACL, so
-- this is a no-op in production and a real fix on a fresh replay. service_role is re-granted
-- explicitly because revoking PUBLIC on a default ACL strips it too.
revoke execute on function public.phx_autofill_replacement_vacancy_from_employee_insert() from public, anon, authenticated;
grant execute on function public.phx_autofill_replacement_vacancy_from_employee_insert() to service_role;
