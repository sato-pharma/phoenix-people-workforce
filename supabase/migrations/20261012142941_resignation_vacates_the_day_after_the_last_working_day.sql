-- =============================================================================
-- A RESIGNATION VACATES THE SEAT THE DAY AFTER THE LAST WORKING DAY
-- =============================================================================
-- WHAT: the three resignation writers stop handing au.resign_occupant the
--       employee's LAST WORKING DAY and hand it the first VACANT day — the day
--       after it. No row is changed; only the writers.
--
-- WHY: every effective range in au.occupancy_history is read half-open,
--      effective_from <= d < effective_to:
--
--        au.f_seat_occupant_asof      resolves effective_from <= p_asof
--                                     and (effective_to is null or effective_to > p_asof)
--        au.hire_into_seat            writes effective_from = the hire date, the FIRST day in the seat
--        au.transfer_occupant         closes the OLD seat on the transfer date, the first day NOT in it
--        public.phx_transfer_au_seat  the same
--
--      So effective_to is the first day the person is NOT in the seat, and the
--      three resignation writers were passing the last day they WERE:
--
--        public.phx_resign_employee_and_open_vacancy  p_effective_date, which it also writes to employees.last_working_date
--        public.phx_vacate_au_seats_for_employee      the Approvals-Hub "complete" path, the same date
--        public.phx_decline_offer_and_open_vacancy    p_last_working_date
--
--      One day off, and the day lost is the last working day itself: it falls
--      inside the VACANT row, because au.resign_occupant opens that row on the
--      very same date it closes the person's.
--
--      Monthly attribution resolves every seat as of the period END
--      (au.f_monthly_achievement -> au.f_line_area_map_asof(period_end) +
--      au.f_seat_occupant_asof(seat, period_end)). When the last working day IS
--      a month end, the whole month therefore credits NOBODY — not the person
--      who sold it, and not a successor.
--
--      Measured read-only on production ozucdzovmcqvepbozvqf, 2026-10-12. Of 54
--      resignations whose occupancy boundary lands within 3 days of
--      employees.last_working_date, 51 sit exactly ON it and 18 of those are a
--      month end. Arm 1 of au.f_seat_occupant_asof (today's holder inherits the
--      seat's whole history — deliberate, and pinned by
--      tests/au-seat-occupant-resolver.test.ts section 3) masks it wherever the
--      seat is filled today, so 10 (seat, period) pairs actually resolve to NULL
--      and would resolve to the real person: 9 rep months plus Pedia Upper
--      Egypt's DM seat for 2026-08, whose 8 areas all report dm_hr_id = NULL for
--      a month its DM worked in full. Every flip is NULL -> a named person;
--      nobody loses credit in any month.
--
--      THIS MIGRATION CHANGES NO ROW. It fixes the writers, so the next
--      resignation is recorded correctly. The 51 historical boundaries are a
--      separate correction and the owner's decision, because moving one changes
--      who is credited in a month.
--
-- WHY THE ARITHMETIC IS AT THE THREE CALL SITES AND NOT INSIDE
-- au.resign_occupant: that primitive is ALSO what the transfer path calls, and
--      there the date passed really is the first vacant day. The primitive is
--      correct; the resignation callers were the ones holding the wrong KIND of
--      date. Moving the + 1 into the primitive would silently shift every
--      transfer by a day.
--
-- NULL DATE: all three callers already defaulted a missing date to "today" and
--      that is preserved exactly — a null last working day still vacates the
--      seat from TODAY, not tomorrow, so the organogram never shows a departed
--      person for the rest of the day.
--
-- ROLLBACK: re-apply the previous definition of each function —
--      20260903181500_departure_revokes_login_on_the_last_working_day.sql,
--      20260801190000_phx_vacate_au_seats_for_employee.sql and
--      20260911220000_phx_decline_offer_and_open_vacancy_rpc.sql. No data is
--      touched, so nothing else needs undoing.
--
-- Regression guard: tests/au-resignation-vacates-day-after-last-working-day.test.ts
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The Employees-page path. Body reproduced from production verbatim
--    (md5(prosrc) 4fd2e0292ee62c30462feb2fc203210f, read 2026-10-12); the only
--    changes are v_vacant_from and the date handed to au.resign_occupant.
-- ---------------------------------------------------------------------------
create or replace function public.phx_resign_employee_and_open_vacancy(
  p_actor text,
  p_effective_date date,
  p_employee_hr_id text,
  p_employee_status text,
  p_reason text,
  p_submitted_by_hr_id text,
  p_submitted_date date,
  p_vacancy_code text,
  p_workflow_notes text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_employee public.employees;
  v_line_name text;
  v_position_title text;
  v_manager_name text;
  v_vacancy_id bigint;
  v_resignation_id uuid;
  v_seat_id text;
  -- p_effective_date IS the last working day — it is written to
  -- employees.last_working_date below — so the seat falls vacant the day AFTER
  -- it, never on it. A null date keeps this function's original meaning:
  -- vacate from today.
  v_vacant_from date := coalesce(p_effective_date + 1, (now() at time zone 'Africa/Cairo')::date);
begin
  select * into v_employee from public.employees where hr_id = p_employee_hr_id;
  if not found then
    raise exception 'phx_resign_employee_and_open_vacancy: employee % not found', p_employee_hr_id;
  end if;
  select name into v_line_name from public.lines where id = v_employee.line_id;
  select title into v_position_title from public.positions where id = v_employee.position_id;
  select full_name into v_manager_name from public.employees where hr_id = v_employee.manager_hr_id;
  insert into public.position_vacancies (
    area_id, department_id, job_title, line_id, manager_hr_id, manager_name, note,
    position_id, region_name, replacement_for_hr_id, status, vacancy_code, created_at, updated_at
  ) values (
    v_employee.area_id, v_employee.department_id,
    coalesce(v_employee.job_title, v_position_title), v_employee.line_id,
    v_employee.manager_hr_id, v_manager_name,
    'Auto-opened from resignation of ' || v_employee.full_name || ' (' || v_employee.hr_id || '). Effective ' || p_effective_date,
    v_employee.position_id, v_employee.region_name, p_employee_hr_id, 'open', p_vacancy_code,
    now(), now()
  )
  returning id into v_vacancy_id;
  insert into public.employee_resignations (
    employee_hr_id, employee_name, job_title, line_name,
    submitted_date, effective_date, resignation_date, last_working_date,
    reason, notes, workflow_notes, exit_status, status,
    create_vacancy, vacancy_id, submitted_by_hr_id, created_by, created_at, updated_at
  ) values (
    p_employee_hr_id, v_employee.full_name, coalesce(v_position_title, v_employee.job_title), v_line_name,
    p_submitted_date, p_effective_date, p_submitted_date, p_effective_date,
    p_reason, coalesce(p_workflow_notes, p_reason), p_workflow_notes, 'submitted', 'submitted',
    true, v_vacancy_id, p_submitted_by_hr_id, p_actor, now(), now()
  )
  returning id into v_resignation_id;
  update public.employees set
    employment_status = p_employee_status,
    exit_reason = p_reason,
    exit_status = 'submitted',
    last_working_date = p_effective_date,
    organogram_visible = false,
    payroll_eligible = false,
    resignation_date = p_submitted_date,
    crm_id = null,
    updated_at = now()
  where hr_id = p_employee_hr_id;
  if p_effective_date is null or p_effective_date <= (now() at time zone 'Africa/Cairo')::date then
    update public.app_auth_users set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
    update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
  end if;
  for v_seat_id in
    select seat_id
    from au.occupancy_history
    where occupant_canonical_hr_id = lower(btrim(p_employee_hr_id))
      and effective_to is null
      and node_type = 'person'
    order by seat_id
  loop
    perform au.resign_occupant(v_seat_id, v_vacant_from, coalesce(p_reason, 'resignation'), p_actor);
  end loop;
  return jsonb_build_object(
    'employee_hr_id', p_employee_hr_id,
    'employee_status', p_employee_status,
    'resignation_id', v_resignation_id,
    'vacancy_code', p_vacancy_code
  );
end;
$$;

-- The `public` schema has a project-wide default ACL that auto-grants EXECUTE to
-- `authenticated` on every new function, and anon/authenticated also inherit through PUBLIC
-- membership — so the revoke names all three and the grant follows it. The resulting ACL must
-- read `postgres=X/postgres;service_role=X/postgres`, which is what it read before this
-- migration.
revoke execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) from public, anon, authenticated;
grant execute on function public.phx_resign_employee_and_open_vacancy(text,date,text,text,text,text,date,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The Approvals-Hub "complete" path — step 5 published on its own. Body
--    reproduced from production verbatim (md5(prosrc)
--    66b70d2c93eb84a4dbd59ab12cfe31c1); the only change is the date.
--
--    The returned `effective_date` keeps its old meaning — the date handed to
--    au.resign_occupant, which is now the first vacant day — and
--    `last_working_date` is added beside it so the two are never confused
--    again. Nothing reads the payload: vacateAuSeatsIfSupported in
--    src/lib/resignations/service.ts destructures `error` only.
-- ---------------------------------------------------------------------------
create or replace function public.phx_vacate_au_seats_for_employee(
  p_actor text,
  p_effective_date date,
  p_employee_hr_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seat_id text;
  v_vacant_from date;
  v_vacated text[] := array[]::text[];
begin
  if p_employee_hr_id is null or btrim(p_employee_hr_id) = '' then
    raise exception 'phx_vacate_au_seats_for_employee: employee hr_id is required';
  end if;

  -- p_effective_date is the resignation's effective date, i.e. the employee's LAST WORKING DAY,
  -- so the seat falls vacant the day after it. A null date keeps this function's original
  -- meaning: vacate from today, in Cairo (AGENTS.md § 4), never an unzoned current_date.
  v_vacant_from := coalesce(p_effective_date + 1, (now() at time zone 'Africa/Cairo')::date);

  -- Same lookup as step 5 of public.phx_resign_employee_and_open_vacancy: canonical HR_ID,
  -- open span only, person spans only, ordered for a stable and reproducible vacate order.
  -- Zero rows is the expected, non-error outcome for an employee who holds no seat.
  for v_seat_id in
    select seat_id
    from au.occupancy_history
    where occupant_canonical_hr_id = lower(btrim(p_employee_hr_id))
      and effective_to is null
      and node_type = 'person'
    order by seat_id
  loop
    perform au.resign_occupant(
      v_seat_id,
      v_vacant_from,
      coalesce(nullif(btrim(p_reason), ''), 'resignation'),
      coalesce(nullif(btrim(p_actor), ''), 'system')
    );
    v_vacated := v_vacated || v_seat_id;
  end loop;

  return jsonb_build_object(
    'employee_hr_id', p_employee_hr_id,
    'effective_date', v_vacant_from,
    'last_working_date', p_effective_date,
    'seats_vacated', to_jsonb(v_vacated),
    'vacated_count', coalesce(array_length(v_vacated, 1), 0)
  );
end;
$$;

revoke execute on function public.phx_vacate_au_seats_for_employee(text,date,text,text) from public, anon, authenticated;
grant execute on function public.phx_vacate_au_seats_for_employee(text,date,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The declined-offer path. Body reproduced from production verbatim
--    (md5(prosrc) 969ed335311c63c149220ce2d8cf5e52); the only change is step
--    4's date.
-- ---------------------------------------------------------------------------
create or replace function public.phx_decline_offer_and_open_vacancy(
  p_actor text,
  p_employee_hr_id text,
  p_employee_status text,
  p_last_working_date date,
  p_note text,
  p_submitted_by_hr_id text,
  p_submitted_date date,
  p_vacancy_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees;
  v_position_title text;
  v_manager_name text;
  v_vacancy_id bigint;
  v_seat_id text;
  -- p_last_working_date is the last day the person IS in the seat, so the seat falls vacant the
  -- day after it. A null date keeps the original meaning: vacate from today, Cairo-zoned.
  v_vacant_from date := coalesce(p_last_working_date + 1, (now() at time zone 'Africa/Cairo')::date);
begin
  if p_employee_status not in ('terminated', 'declined_offer') then
    raise exception 'phx_decline_offer_and_open_vacancy: employee status must be terminated or declined_offer, got %', p_employee_status;
  end if;

  select * into v_employee from public.employees where hr_id = p_employee_hr_id;
  if not found then
    raise exception 'phx_decline_offer_and_open_vacancy: employee % not found', p_employee_hr_id;
  end if;

  select title into v_position_title from public.positions where id = v_employee.position_id;
  select full_name into v_manager_name from public.employees where hr_id = v_employee.manager_hr_id;

  -- 1. Open the replacement vacancy (mirrors the resignation RPC's step 1).
  insert into public.position_vacancies (
    area_id, department_id, job_title, line_id, manager_hr_id, manager_name, note,
    position_id, region_name, replacement_for_hr_id, status, vacancy_code, created_at, updated_at
  ) values (
    v_employee.area_id, v_employee.department_id,
    coalesce(v_employee.job_title, v_position_title), v_employee.line_id,
    v_employee.manager_hr_id, v_manager_name,
    'Auto-opened from declined offer of ' || v_employee.full_name || ' (' || v_employee.hr_id || '). Last day ' || p_last_working_date,
    v_employee.position_id, v_employee.region_name, p_employee_hr_id, 'open', p_vacancy_code,
    now(), now()
  )
  returning id into v_vacancy_id;

  -- 2. Update the employee's own lifecycle fields. No employee_resignations row is
  --    written here — see the file header. exit_category is the durable, findable
  --    marker independent of which employment_status this exit lands on.
  update public.employees set
    employment_status = p_employee_status,
    exit_category = 'declined_offer',
    exit_reason = p_note,
    last_working_date = p_last_working_date,
    organogram_visible = false,
    payroll_eligible = false,
    resignation_date = p_submitted_date,
    updated_at = now()
  where hr_id = p_employee_hr_id;

  -- 3. Deactivate app access (DB-side only; Telegram deactivation is an external API
  --    call and stays in application code, same as the resignation RPC).
  update public.app_auth_users set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;
  update public.user_access_profiles set is_active = false, updated_at = now() where hr_id = p_employee_hr_id;

  -- 4. Vacate the au seat, if any, in the same transaction (identical guard to the
  --    resignation RPC's step 5). A brand-new hire with no replacement_for_hr_id never
  --    occupies a seat at all, so this is routinely a no-op.
  select seat_id into v_seat_id
  from au.occupancy_history
  where occupant_hr_id = p_employee_hr_id and effective_to is null and node_type = 'person'
  limit 1;
  if v_seat_id is not null then
    perform au.resign_occupant(v_seat_id, v_vacant_from, coalesce(p_note, 'declined offer after hire'), p_actor);
  end if;

  return jsonb_build_object(
    'employee_hr_id', p_employee_hr_id,
    'employee_status', p_employee_status,
    'vacancy_code', p_vacancy_code
  );
end;
$$;

revoke execute on function public.phx_decline_offer_and_open_vacancy(text,text,text,date,text,text,date,text) from public, anon, authenticated;
grant execute on function public.phx_decline_offer_and_open_vacancy(text,text,text,date,text,text,date,text) to service_role;

notify pgrst, 'reload schema';

commit;
