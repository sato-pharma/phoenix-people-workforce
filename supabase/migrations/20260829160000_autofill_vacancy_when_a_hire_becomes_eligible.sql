-- The replacement ownership engine only ever got ONE chance, at INSERT.
--
-- phx_employee_insert_autofill_replacement_vacancy is an AFTER INSERT trigger, and its first four
-- guards return silently when the row is not yet a complete, eligible hire: a non-active status, a
-- false payroll_eligible or organogram_visible, or a null area / line / position / manager. That is
-- correct for the row as it stands at that instant. What was missing is the second look: a hire
-- created incomplete and COMPLETED a moment later by an UPDATE never re-entered the engine, so its
-- vacancy stayed open forever.
--
-- Measured on production 2026-08-29. Vacancies 352 (HR Operations Coordinator) and 354 (HR Business
-- Partner) were auto-opened from two resignations at 05:05 and 05:07 Cairo on 2026-08-28. The two
-- replacements were created at 20:07 the same day carrying area 80 / line 4 / position 12 and 14 /
-- manager B-10 -- an EXACT tier-1 match against those vacancies. Neither closed. Both stayed 'open'
-- for a day, and because organogram-head-office.ts draws every open line_id = 4 vacancy as its own
-- "Vacant" box, each new hire rendered TWICE on the organogram: once as herself, once as the seat
-- she already filled. The owner reported it as duplicated HR seats.
--
-- The silence is the diagnostic. When the engine reaches the matching step and finds nothing it
-- writes a hire_vacancy_unmatched audit row (20260804121032). audit_logs holds no such row for
-- either hire -- and no row for anyone else either -- so the engine never reached that step at all.
-- It bailed at a guard above it, which is the one path that produces no record of having run.
--
-- The app-side closer could not have covered for it: the account-provisioning audit row for both
-- hires reads "Provisioned a missing login for an active employee created outside the manual-add
-- route", so upsertEmployee() -- the only caller of closeVacancyOnHire() -- never ran either.
--
-- WHAT CHANGES
--
-- The matching body moves, verbatim, into phx_autofill_replacement_vacancy_for_employee(). The
-- INSERT trigger becomes a thin wrapper over it, so the insert path's behaviour is unchanged in
-- every respect including its own guards and its audit row.
--
-- A companion AFTER UPDATE trigger calls the same body when a row BECOMES eligible -- ineligible
-- before, eligible after. That deliberately narrow condition is what keeps this safe:
--
--   * an ordinary edit to an already-active employee (a move, a retitle) leaves OLD eligible, so
--     the engine is not re-entered and no vacancy is touched;
--   * only a row crossing INTO eligibility -- the exact shape that was silently dropped -- is
--     re-offered to the matcher;
--   * a hire who already owns a filled vacancy is skipped outright, so a second open vacancy on an
--     identical footprint can never be closed by the same person twice.
--
-- Tier 1 still requires EXACTLY ONE open vacancy at the footprint, so an ambiguous match remains a
-- no-op and is logged rather than guessed at. The failure mode this fixes was never a wrong match;
-- it was no match ever being attempted.

-- ── The eligibility predicate, lifted from the insert trigger's four guards ───────────────────────
create or replace function public.phx_employee_is_vacancy_autofill_eligible(p_emp public.employees)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select lower(coalesce(p_emp.employment_status, 'active')) in ('active', 'on_leave')
     and coalesce(p_emp.payroll_eligible, true) is true
     and coalesce(p_emp.organogram_visible, true) is true
     and p_emp.area_id is not null
     and p_emp.line_id is not null
     and p_emp.position_id is not null
     and nullif(trim(coalesce(p_emp.manager_hr_id, '')), '') is not null;
$function$;

-- ── The matching body, moved verbatim from the insert trigger ────────────────────────────────────
create or replace function public.phx_autofill_replacement_vacancy_for_employee(p_emp public.employees)
returns void
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
  if not public.phx_employee_is_vacancy_autofill_eligible(p_emp) then
    return;
  end if;

  -- Tier 1: a vacancy already pointing at this hire's manager.
  select count(*), min(v.id)
  into v_match_count, v_vacancy_id
  from public.position_vacancies v
  where lower(coalesce(v.status, 'open')) = 'open'
    and v.area_id is not distinct from p_emp.area_id
    and v.line_id is not distinct from p_emp.line_id
    and v.position_id is not distinct from p_emp.position_id
    and v.manager_hr_id is not distinct from p_emp.manager_hr_id;

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
      and v.area_id is not distinct from p_emp.area_id
      and v.line_id is not distinct from p_emp.line_id
      and v.position_id is not distinct from p_emp.position_id
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
      and v.area_id is not distinct from p_emp.area_id
      and v.line_id is not distinct from p_emp.line_id
      and v.position_id is not distinct from p_emp.position_id
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
        'system', 'hire_vacancy_unmatched', p_emp.hr_id,
        format('No open vacancy matched %s - they will not appear on the organogram until a vacancy or seat is prepared',
          p_emp.hr_id),
        jsonb_build_object(
          'employeeHrId', p_emp.hr_id,
          'fullName', p_emp.full_name,
          'lineId', p_emp.line_id,
          'areaId', p_emp.area_id,
          'positionId', p_emp.position_id,
          'managerHrId', p_emp.manager_hr_id,
          'openVacanciesForFootprint', (
            select count(*) from public.position_vacancies v
            where lower(coalesce(v.status, 'open')) = 'open'
              and v.area_id is not distinct from p_emp.area_id
              and v.line_id is not distinct from p_emp.line_id
              and v.position_id is not distinct from p_emp.position_id
          )
        )
      );
    exception when others then
      null; -- logging must never block a hire
    end;
    return;
  end if;

  select id, replacement_for_hr_id
  into v_vacancy
  from public.position_vacancies
  where id = v_vacancy_id;

  update public.position_vacancies
  set
    status = 'filled',
    filled_by_hr_id = p_emp.hr_id,
    filled_at = now(),
    manager_hr_id = case when v_manager_scope in ('unknown_manager', 'departed_manager')
                         then p_emp.manager_hr_id else manager_hr_id end,
    note = concat_ws(
      E'\n',
      nullif(note, ''),
      'Auto-filled by replacement ownership engine for ' || p_emp.hr_id || ' on ' || (now() at time zone 'Africa/Cairo')::date::text
        || case v_manager_scope
             when 'unknown_manager' then ' (matched on area/line/position; the box had no manager recorded).'
             when 'departed_manager' then ' (matched on area/line/position; the box named a manager who has left).'
             else '.' end
    ),
    updated_at = now()
  where id = v_vacancy.id
    and lower(coalesce(status, 'open')) = 'open';

  if nullif(trim(coalesce(v_vacancy.replacement_for_hr_id, '')), '') is null then
    return;
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
    p_emp.hr_id,
    coalesce(v_effective_date, (now() at time zone 'Africa/Cairo')::date)
  );

  return;
exception
  when undefined_column then
    raise notice 'Replacement ownership auto-fill skipped because expected lifecycle/vacancy columns are missing.';
    return;
end;
$function$;

-- ── INSERT wrapper: unchanged behaviour, now delegating ──────────────────────────────────────────
create or replace function public.phx_autofill_replacement_vacancy_from_employee_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.phx_autofill_replacement_vacancy_for_employee(new);
  return new;
end;
$function$;

-- ── UPDATE wrapper: the second look this migration exists to add ─────────────────────────────────
create or replace function public.phx_autofill_replacement_vacancy_from_employee_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Already eligible before this edit: an ordinary change to a live employee, not a hire being
  -- completed. Re-entering the matcher here is what would let a retitle or a transfer close some
  -- other open vacancy, so it is explicitly out of scope.
  if public.phx_employee_is_vacancy_autofill_eligible(old) then
    return new;
  end if;

  if not public.phx_employee_is_vacancy_autofill_eligible(new) then
    return new;
  end if;

  -- This person already owns a seat the engine closed for them. Never let one hire consume a
  -- second vacancy on an identical footprint.
  if exists (
    select 1
    from public.position_vacancies v
    where v.filled_by_hr_id = new.hr_id
      and lower(coalesce(v.status, 'open')) = 'filled'
  ) then
    return new;
  end if;

  perform public.phx_autofill_replacement_vacancy_for_employee(new);
  return new;
end;
$function$;

drop trigger if exists phx_employee_update_autofill_replacement_vacancy on public.employees;
create trigger phx_employee_update_autofill_replacement_vacancy
after update of employment_status, payroll_eligible, organogram_visible, manager_hr_id, area_id, line_id, position_id
on public.employees
for each row
execute function public.phx_autofill_replacement_vacancy_from_employee_update();

-- See 20260804090813: a public function inherits EXECUTE to PUBLIC by default and anon /
-- authenticated inherit it through PUBLIC membership. CREATE OR REPLACE keeps the live ACL, so
-- this is a no-op in production and a real fix on a fresh replay. service_role is re-granted
-- explicitly because revoking PUBLIC on a default ACL strips it too.
revoke execute on function public.phx_autofill_replacement_vacancy_from_employee_insert() from public, anon, authenticated;
grant execute on function public.phx_autofill_replacement_vacancy_from_employee_insert() to service_role;
revoke execute on function public.phx_autofill_replacement_vacancy_from_employee_update() from public, anon, authenticated;
grant execute on function public.phx_autofill_replacement_vacancy_from_employee_update() to service_role;
revoke execute on function public.phx_autofill_replacement_vacancy_for_employee(public.employees) from public, anon, authenticated;
grant execute on function public.phx_autofill_replacement_vacancy_for_employee(public.employees) to service_role;
revoke execute on function public.phx_employee_is_vacancy_autofill_eligible(public.employees) from public, anon, authenticated;
grant execute on function public.phx_employee_is_vacancy_autofill_eligible(public.employees) to service_role;
