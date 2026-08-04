-- A vacancy box created while its district-manager seat was empty keeps manager_hr_id NULL
-- forever. The autofill matched on `v.manager_hr_id is not distinct from new.manager_hr_id`, so
-- such a box matched NOBODY: no vacancy was flipped to 'filled', the vacancy-filled trigger never
-- fired at all, and the new hire got no au seat and no audit row anywhere. Found via PD-0007
-- (Bahaa Gamal, Pedia / Heliopolis, reporting to PD-0006) against VAC-PEDIA-CAIRO-HELIOPOLIS-MR.
--
-- The fallback is deliberately second-choice: an exact manager match still wins outright. Areas
-- 1096 and 1097 each hold BOTH an exact-manager vacancy and a NULL-manager one, so treating NULL
-- as a plain wildcard would have made them ambiguous and broken two paths that work today.

create or replace function public.phx_autofill_replacement_vacancy_from_employee_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_match_count   integer := 0;
  v_vacancy       record;
  v_effective_date date;
  v_manager_scope text;
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

  -- First choice: a vacancy already pointing at this hire's manager.
  select count(*)
  into v_match_count
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and v.area_id is not distinct from new.area_id
    and v.line_id is not distinct from new.line_id
    and v.position_id is not distinct from new.position_id
    and v.manager_hr_id is not distinct from new.manager_hr_id;

  if v_match_count = 1 then
    v_manager_scope := 'exact';
  elsif v_match_count = 0 then
    -- Second choice: the box exists but its manager was never recorded.
    select count(*)
    into v_match_count
    from public.position_vacancies v
    where lower(coalesce(v.status, 'open')) = 'open'
      and v.area_id is not distinct from new.area_id
      and v.line_id is not distinct from new.line_id
      and v.position_id is not distinct from new.position_id
      and v.manager_hr_id is null;

    if v_match_count = 1 then
      v_manager_scope := 'unknown_manager';
    end if;
  end if;

  -- Avoid guessing when more than one live vacancy has the same footprint.
  if v_manager_scope is null then
    return new;
  end if;

  select id, replacement_for_hr_id
  into v_vacancy
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and v.area_id is not distinct from new.area_id
    and v.line_id is not distinct from new.line_id
    and v.position_id is not distinct from new.position_id
    and (
      (v_manager_scope = 'exact' and v.manager_hr_id is not distinct from new.manager_hr_id)
      or (v_manager_scope = 'unknown_manager' and v.manager_hr_id is null)
    )
  order by v.created_at asc, v.id asc
  limit 1;

  update public.position_vacancies
  set
    status = 'filled',
    filled_by_hr_id = new.hr_id,
    filled_at = now(),
    -- Record the manager we matched through, so the closed box stops claiming "unknown".
    manager_hr_id = case when v_manager_scope = 'unknown_manager'
                         then new.manager_hr_id else manager_hr_id end,
    note = concat_ws(
      E'\n',
      nullif(note, ''),
      'Auto-filled by replacement ownership engine for ' || new.hr_id || ' on ' || (now() at time zone 'Africa/Cairo')::date::text
        || case when v_manager_scope = 'unknown_manager'
                then ' (matched on area/line/position; the box had no manager recorded).'
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
