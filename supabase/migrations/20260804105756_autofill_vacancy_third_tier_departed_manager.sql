-- Third and last matching tier for the hire -> vacancy -> au seat chain.
--
-- Tier 2 (previous migration) rescued a vacancy whose manager was never recorded (NULL). It did
-- NOT rescue one whose manager IS recorded but has since left: VAC-TERM-B99-2a1b4c and
-- VAC-TERM-B109-5e096f still point at B-180 (resigned) and VAC-TERM-B160-42e968 at B-101
-- (terminated). A hire into Nasr City / Anti Infective under any other manager matched nothing
-- and silently got no seat.
--
-- The tiers are strictly sequential and each demands exactly one candidate, so this is additive:
-- it can only fire where all earlier tiers found nothing. Widening tier 2 instead would have made
-- areas 1096/1097 ambiguous -- they hold BOTH a NULL-manager and a departed-manager vacancy --
-- and broken two paths that work today.
--
--   tier 1  exact manager match          (unchanged, always wins)
--   tier 2  manager never recorded       (NULL)
--   tier 3  manager recorded but gone    (missing, resigned or terminated)

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

  -- Avoid guessing when no tier produced exactly one candidate.
  if v_vacancy_id is null then
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
    -- Record the manager we matched through, so the closed box stops naming someone
    -- who is blank or long gone.
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

-- See the note in 20260804090813: a public function inherits EXECUTE to PUBLIC by default, and
-- anon/authenticated inherit it through PUBLIC membership. CREATE OR REPLACE keeps the live ACL,
-- so this is a no-op in production and a real fix on a fresh replay. service_role is re-granted
-- explicitly because revoking PUBLIC on a default ACL strips it as well.
revoke execute on function public.phx_autofill_replacement_vacancy_from_employee_insert() from public, anon, authenticated;
grant execute on function public.phx_autofill_replacement_vacancy_from_employee_insert() to service_role;
