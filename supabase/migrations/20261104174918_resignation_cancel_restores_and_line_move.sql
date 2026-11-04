-- resignation_cancel_restores_and_line_move
--
-- WHAT THIS CHANGES:
--   1. employee_resignations.crm_id_before — phx_resign_employee_and_open_vacancy clears the
--      employee's crm_id; it now keeps the old value on the resignation row so a cancel can give
--      it back. The function is otherwise byte-for-byte the production definition.
--   2. public.phx_restore_employee_after_cancelled_resignation(p_resignation_id, p_actor) — undoes
--      a resignation that took the person out: active again, on payroll and the organogram, the
--      seat span reopened (the resignation's vacant placeholder removed), the replacement vacancy
--      cancelled, the login and access profile switched back on, the CRM id restored. Refuses when
--      the seat or the vacancy has since gone to someone else, when a newer exit record exists, or
--      when the record is completed. A resignation that never took the person out restores nothing.
--   3. public.phx_move_employee_to_line(p_actor, p_employee_hr_id, p_to_seat_id, p_effective_date,
--      p_reason) — moves an active employee onto a vacant seat on ANOTHER line without a
--      resignation: line_id changes, then phx_transfer_au_seat moves the seat (area, region and
--      manager follow it), the destination seat's open vacancy is closed as filled by them, and a
--      vacancy is opened for the seat they leave. Same HR ID, same salary, same contract.
--   4. public.phx_transfer_au_seat — unchanged except that it no longer writes employees.area_name,
--      a label column dropped from employees: every transfer onto a seat with an area failed with
--      42703, so the Transfer Seat button on the Employee Master could not move a rep at all.
-- WHY: Omaima Wael (AI-0009) moved from Anti Infective to Pedia in Dokki - Mohandseen - Bolak and the
--   only route was a resignation, which switched her off pay, emptied her seat and disabled her login
--   (owner, 2026-11-04: "u automate this", choosing "Full cancel + line move"). Cancel on the
--   Resignations screen stamped the record only and left all of that in place. Ahmed Nabil
--   (2026-10-22) lost his October days the same way.
-- ROLLBACK:
--   drop function if exists public.phx_move_employee_to_line(text, text, text, date, text);
--   drop function if exists public.phx_restore_employee_after_cancelled_resignation(uuid, text);
--   re-create phx_resign_employee_and_open_vacancy from 20261012142941 (without crm_id_before);
--   alter table public.employee_resignations drop column if exists crm_id_before;  -- loses the kept ids
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here touches an existing row; both new functions act only when called.

begin;

alter table public.employee_resignations add column if not exists crm_id_before text;

comment on column public.employee_resignations.crm_id_before is
  'The employee''s crm_id the moment this resignation cleared it, so cancelling the resignation can restore it.';

create or replace function public.phx_resign_employee_and_open_vacancy(p_actor text, p_effective_date date, p_employee_hr_id text, p_employee_status text, p_reason text, p_submitted_by_hr_id text, p_submitted_date date, p_vacancy_code text, p_workflow_notes text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
    create_vacancy, vacancy_id, submitted_by_hr_id, created_by, created_at, updated_at,
    crm_id_before
  ) values (
    p_employee_hr_id, v_employee.full_name, coalesce(v_position_title, v_employee.job_title), v_line_name,
    p_submitted_date, p_effective_date, p_submitted_date, p_effective_date,
    p_reason, coalesce(p_workflow_notes, p_reason), p_workflow_notes, 'submitted', 'submitted',
    true, v_vacancy_id, p_submitted_by_hr_id, p_actor, now(), now(),
    v_employee.crm_id
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
$function$;

revoke execute on function public.phx_resign_employee_and_open_vacancy(text, date, text, text, text, text, date, text, text) from public, anon, authenticated;
grant execute on function public.phx_resign_employee_and_open_vacancy(text, date, text, text, text, text, date, text, text) to service_role;

-- ── 4. The seat transfer stops writing the dropped employees.area_name ───────────────────────
create or replace function public.phx_transfer_au_seat(p_actor text, p_employee_hr_id text, p_to_seat_id text, p_effective_date date default null::date, p_from_seat_id text default null::text, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_hr_input text := nullif(btrim(p_employee_hr_id), '');
  v_to_seat_id text := nullif(btrim(p_to_seat_id), '');
  v_from_input text := nullif(btrim(p_from_seat_id), '');
  v_effective date := coalesce(p_effective_date, (now() at time zone 'Africa/Cairo')::date);
  v_emp record;
  v_emp_line_code text;
  v_seat au.seats;
  v_target_occupant text;
  v_open_spans text[];
  v_from_seat_id text;
  v_remaining integer;
  v_mode text;
  v_new_occupancy bigint;
  v_area record;
  v_region_code text;
  v_region_name text;
  v_new_manager text;
  v_synced jsonb := '{}'::jsonb;
begin
  if v_hr_input is null then
    raise exception 'transfer: employee HR ID is required';
  end if;
  if v_to_seat_id is null then
    raise exception 'transfer: destination seat is required';
  end if;

  select hr_id, full_name, line_id, employment_status
    into v_emp
    from public.employees
   where lower(btrim(hr_id)) = lower(v_hr_input)
   limit 1;
  if not found then
    raise exception 'transfer: employee % not found', v_hr_input;
  end if;
  if lower(coalesce(v_emp.employment_status, '')) not in ('active', 'on_leave') then
    raise exception 'transfer: employee % is % - only an active employee can be moved onto a seat',
      v_emp.hr_id, coalesce(v_emp.employment_status, 'missing employment status');
  end if;

  select * into v_seat
    from au.seats
   where seat_id = v_to_seat_id and is_active and effective_to is null;
  if not found then
    raise exception 'transfer: seat % not found or inactive', v_to_seat_id;
  end if;

  select l.code into v_emp_line_code from public.lines l where l.id = v_emp.line_id;
  if v_emp_line_code is distinct from v_seat.line_code then
    raise exception 'transfer: seat % belongs to line % but % is on line % - cross-line moves are not supported here',
      v_to_seat_id, v_seat.line_code, v_emp.hr_id, coalesce(v_emp_line_code, 'none');
  end if;

  select occupant_hr_id into v_target_occupant
    from au.occupancy_history
   where seat_id = v_to_seat_id and effective_to is null and occupant_hr_id is not null;
  if v_target_occupant is not null then
    raise exception 'transfer: seat % is already occupied by %', v_to_seat_id, v_target_occupant;
  end if;

  select coalesce(array_agg(seat_id order by seat_id), '{}')
    into v_open_spans
    from au.occupancy_history
   where occupant_canonical_hr_id = lower(btrim(v_emp.hr_id))
     and effective_to is null
     and occupant_hr_id is not null;

  if cardinality(v_open_spans) = 0 then
    -- Unseated active employee (the "hired but never reached the seat model" repair).
    if v_from_input is not null then
      raise exception 'transfer: % holds no seat, so a source seat cannot be specified - leave it empty to seat them directly', v_emp.hr_id;
    end if;
    v_mode := 'seated';
    v_from_seat_id := null;
    v_new_occupancy := au.hire_into_seat(v_to_seat_id, v_emp.hr_id, v_effective, p_actor, false);
  else
    if cardinality(v_open_spans) = 1 then
      v_from_seat_id := v_open_spans[1];
      if v_from_input is not null and v_from_input <> v_from_seat_id then
        raise exception 'transfer: % occupies seat %, not % - refusing the mismatched source', v_emp.hr_id, v_from_seat_id, v_from_input;
      end if;
    else
      if v_from_input is null then
        raise exception 'transfer: % occupies more than one seat (%) - specify which one to vacate',
          v_emp.hr_id, array_to_string(v_open_spans, ', ');
      end if;
      if not (v_from_input = any(v_open_spans)) then
        raise exception 'transfer: % does not occupy seat % (their seats: %)',
          v_emp.hr_id, v_from_input, array_to_string(v_open_spans, ', ');
      end if;
      v_from_seat_id := v_from_input;
    end if;
    if v_from_seat_id = v_to_seat_id then
      raise exception 'transfer: % already occupies seat %', v_emp.hr_id, v_to_seat_id;
    end if;

    v_mode := 'transferred';
    v_remaining := cardinality(v_open_spans) - 1;

    -- Same sequence as au.transfer_occupant, but with the source verified above and
    -- the dual-seat opt-in derived from reality: a dual-seat holder moving ONE of
    -- their seats keeps the others open, which the strict hire guard must allow.
    perform au.resign_occupant(v_from_seat_id, v_effective, coalesce(p_reason, 'seat transfer'), p_actor);
    update au.occupancy_history set event_type = 'transfer_out'
     where seat_id = v_from_seat_id and effective_to is null;
    v_new_occupancy := au.hire_into_seat(v_to_seat_id, v_emp.hr_id, v_effective, p_actor, v_remaining > 0);
    update au.occupancy_history set event_type = 'transfer_in'
     where occupancy_id = v_new_occupancy;
  end if;

  -- Sync the employee master so the legacy columns follow the seat model instead of
  -- drifting. Area fields only exist for REP seats (manager seats carry no area_code).
  -- employees keeps the area as a link (area_id) only; its area_name label column is dropped.
  if v_seat.area_code is not null then
    select ar.id, ar.name into v_area
      from public.areas ar
     where ar.code = v_seat.area_code and ar.is_active
     order by ar.id
     limit 1;
    select lam.operational_region_code into v_region_code
      from au.line_area_map lam
     where lam.line_code = v_seat.line_code
       and lam.area_code = v_seat.area_code
       and lam.effective_to is null;
    select r.region_name into v_region_name from au.regions r where r.region_code = v_region_code;
    if v_area.id is not null then
      update public.employees
         set area_id = v_area.id,
             region_code = coalesce(v_region_code, region_code),
             region_name = coalesce(v_region_name, region_name),
             updated_at = now()
       where hr_id = v_emp.hr_id;
      v_synced := v_synced || jsonb_build_object(
        'areaId', v_area.id, 'areaName', v_area.name,
        'regionCode', v_region_code, 'regionName', v_region_name);
    end if;
  end if;

  select occupant_hr_id into v_new_manager
    from au.occupancy_history
   where seat_id = v_seat.parent_seat_id and effective_to is null and occupant_hr_id is not null;
  if v_new_manager is not null then
    update public.employees set manager_hr_id = v_new_manager, updated_at = now()
     where hr_id = v_emp.hr_id;
    v_synced := v_synced || jsonb_build_object('managerHrId', v_new_manager);
  else
    v_synced := v_synced || jsonb_build_object('managerUnchanged', 'destination manager seat is vacant');
  end if;

  begin
    insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
    values (
      coalesce(nullif(btrim(p_actor), ''), 'system'),
      'au_seat_transfer',
      v_emp.hr_id,
      case
        when v_mode = 'seated' then
          format('Seated %s on au seat %s effective %s', v_emp.hr_id, v_to_seat_id, v_effective)
        else
          format('Transferred %s from au seat %s to %s effective %s', v_emp.hr_id, v_from_seat_id, v_to_seat_id, v_effective)
      end,
      jsonb_build_object(
        'mode', v_mode,
        'employeeHrId', v_emp.hr_id,
        'fromSeatId', v_from_seat_id,
        'toSeatId', v_to_seat_id,
        'effectiveDate', v_effective,
        'reason', p_reason,
        'occupancyId', v_new_occupancy,
        'employeesSync', v_synced
      )
    );
  exception when others then
    null;
  end;

  return jsonb_build_object(
    'mode', v_mode,
    'employeeHrId', v_emp.hr_id,
    'fromSeatId', v_from_seat_id,
    'toSeatId', v_to_seat_id,
    'effectiveDate', v_effective,
    'occupancyId', v_new_occupancy,
    'employeesSync', v_synced
  );
end;
$function$;

revoke execute on function public.phx_transfer_au_seat(text, text, text, date, text, text) from public, anon, authenticated;
grant execute on function public.phx_transfer_au_seat(text, text, text, date, text, text) to service_role;

-- ── 2. Cancelling a resignation gives the person back everything it took ─────────────────────
create or replace function public.phx_restore_employee_after_cancelled_resignation(
  p_resignation_id uuid,
  p_actor text
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_res public.employee_resignations;
  v_emp public.employees;
  v_last_day date;
  v_newer integer;
  v_taken text;
  v_filled text;
  v_span record;
  v_seats text[] := array[]::text[];
  v_cancelled text[] := array[]::text[];
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'system');
begin
  select * into v_res from public.employee_resignations where id = p_resignation_id for update;
  if not found then
    raise exception 'restore: resignation % not found', p_resignation_id;
  end if;
  if lower(coalesce(v_res.status, v_res.exit_status, '')) = 'completed' then
    raise exception 'restore: a completed resignation cannot be cancelled';
  end if;

  select * into v_emp
    from public.employees
   where lower(btrim(hr_id)) = lower(btrim(v_res.employee_hr_id))
   for update;
  if not found then
    raise exception 'restore: employee % not found', v_res.employee_hr_id;
  end if;

  -- A resignation filed on the Resignations screen and never completed left the person active:
  -- there is nothing to give back.
  if lower(coalesce(v_emp.employment_status, '')) not in ('resigned', 'terminated') then
    return jsonb_build_object('restored', false, 'reason', 'employee_not_terminal', 'employeeHrId', v_emp.hr_id);
  end if;

  -- Only the exit that took them out is undone, never an older one under a newer exit.
  select count(*) into v_newer
    from public.employee_resignations r
   where lower(btrim(r.employee_hr_id)) = lower(btrim(v_emp.hr_id))
     and r.id <> v_res.id
     and r.created_at > v_res.created_at
     and lower(coalesce(r.status, r.exit_status, '')) not in ('cancelled', 'rejected');
  if v_newer > 0 then
    raise exception 'restore: % has a newer exit record — cancel that one instead', v_emp.hr_id;
  end if;

  v_last_day := coalesce(v_res.last_working_date, v_res.effective_date);
  if v_emp.last_working_date is distinct from v_last_day then
    raise exception 'restore: % ended on % on the employee record but this resignation says % — they were taken out by something else',
      v_emp.hr_id, coalesce(v_emp.last_working_date::text, 'no date'), coalesce(v_last_day::text, 'no date');
  end if;

  -- Refuse before touching anything when a seat or a vacancy has gone to someone else.
  select string_agg(p.seat_id || ' (now ' || cur.occupant_hr_id || ')', ', ' order by p.seat_id)
    into v_taken
    from au.occupancy_history p
    join au.occupancy_history cur
      on cur.seat_id = p.seat_id and cur.effective_to is null and cur.occupant_hr_id is not null
   where p.occupant_canonical_hr_id = lower(btrim(v_emp.hr_id))
     and p.node_type = 'person'
     and p.effective_to in (v_last_day, v_last_day + 1)
     and cur.occupant_canonical_hr_id <> lower(btrim(v_emp.hr_id));
  if v_taken is not null then
    raise exception 'restore: the seat % left has since been given to someone else: % — move them first', v_emp.hr_id, v_taken;
  end if;

  select string_agg(coalesce(v.vacancy_code, v.id::text) || ' (' || v.filled_by_hr_id || ')', ', ')
    into v_filled
    from public.position_vacancies v
   where (v.id = v_res.vacancy_id or v.replacement_for_hr_id = v_emp.hr_id)
     and lower(coalesce(v.status, 'open')) = 'filled'
     and v.filled_at >= v_res.created_at;
  if v_filled is not null then
    raise exception 'restore: the replacement vacancy for % was already filled: % — move that person first', v_emp.hr_id, v_filled;
  end if;

  -- The vacancies first, so the employee update below finds no open replacement to fill.
  with closed as (
    update public.position_vacancies v
       set status = 'cancelled',
           note = concat_ws(E'\n', nullif(v.note, ''),
             format('Cancelled %s: the resignation of %s was cancelled and they are back in this job.', v_today, v_emp.hr_id)),
           updated_at = now()
     where (v.id = v_res.vacancy_id or v.replacement_for_hr_id = v_emp.hr_id)
       and lower(coalesce(v.status, 'open')) = 'open'
    returning coalesce(v.vacancy_code, v.id::text) as code
  )
  select coalesce(array_agg(code order by code), array[]::text[]) into v_cancelled from closed;

  -- The seat: drop the resignation's vacant placeholder and reopen their own span, so the history
  -- reads as if they never left.
  for v_span in
    select ph.occupancy_id as placeholder_id, ph.seat_id, ph.prev_occupancy_id
      from au.occupancy_history ph
      join au.occupancy_history p on p.occupancy_id = ph.prev_occupancy_id
     where ph.effective_to is null
       and ph.occupant_hr_id is null
       and ph.event_type = 'resign'
       and p.occupant_canonical_hr_id = lower(btrim(v_emp.hr_id))
       and p.effective_to = ph.effective_from
       and ph.effective_from in (v_last_day, v_last_day + 1)
     order by ph.seat_id
  loop
    delete from au.occupancy_history where occupancy_id = v_span.placeholder_id;
    update au.occupancy_history set effective_to = null where occupancy_id = v_span.prev_occupancy_id;
    perform au.sync_area_state_for_seat(v_span.seat_id, 'vacant_will_hire', 'occupied');
    v_seats := v_seats || v_span.seat_id::text;
  end loop;

  perform set_config('request.phx_allow_terminal_employee_reactivation', 'on', true);
  update public.employees
     set employment_status = 'active',
         payroll_eligible = true,
         organogram_visible = true,
         exit_reason = null,
         exit_status = null,
         exit_category = null,
         last_working_date = null,
         resignation_date = null,
         crm_id = coalesce(crm_id, v_res.crm_id_before),
         updated_at = now()
   where hr_id = v_emp.hr_id;
  perform set_config('request.phx_allow_terminal_employee_reactivation', '', true);

  update public.app_auth_users set is_active = true, updated_at = now() where hr_id = v_emp.hr_id;
  update public.user_access_profiles set is_active = true, updated_at = now() where hr_id = v_emp.hr_id;

  begin
    insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
    values (
      v_actor,
      'employee_resignation_cancel_restore',
      v_emp.hr_id,
      format('Resignation cancelled: %s is active again, on payroll, back on %s', v_emp.hr_id,
        coalesce(nullif(array_to_string(v_seats, ', '), ''), 'no seat')),
      jsonb_build_object(
        'resignationId', v_res.id,
        'lastWorkingDayUndone', v_last_day,
        'seatsRestored', to_jsonb(v_seats),
        'vacanciesCancelled', to_jsonb(v_cancelled),
        'crmIdRestored', v_emp.crm_id is null and v_res.crm_id_before is not null
      )
    );
  exception when others then
    null;
  end;

  return jsonb_build_object(
    'restored', true,
    'employeeHrId', v_emp.hr_id,
    'seatsRestored', to_jsonb(v_seats),
    'vacanciesCancelled', to_jsonb(v_cancelled),
    'crmIdRestored', v_emp.crm_id is null and v_res.crm_id_before is not null
  );
end;
$function$;

revoke execute on function public.phx_restore_employee_after_cancelled_resignation(uuid, text) from public, anon, authenticated;
grant execute on function public.phx_restore_employee_after_cancelled_resignation(uuid, text) to service_role;

-- ── 3. A move to another line is a seat transfer, never a resignation ────────────────────────
create or replace function public.phx_move_employee_to_line(
  p_actor text,
  p_employee_hr_id text,
  p_to_seat_id text,
  p_effective_date date default null,
  p_reason text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_hr_input text := nullif(btrim(p_employee_hr_id), '');
  v_to_seat_id text := nullif(btrim(p_to_seat_id), '');
  v_effective date := coalesce(p_effective_date, (now() at time zone 'Africa/Cairo')::date);
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'system');
  v_emp public.employees;
  v_seat au.seats;
  v_from_line public.lines;
  v_to_line public.lines;
  v_transfer jsonb;
  v_from_seat_id text;
  v_filled text[] := array[]::text[];
  v_opened text;
  v_reason text;
begin
  if v_hr_input is null then
    raise exception 'line move: employee HR ID is required';
  end if;
  if v_to_seat_id is null then
    raise exception 'line move: destination seat is required';
  end if;

  select * into v_emp from public.employees where lower(btrim(hr_id)) = lower(v_hr_input) limit 1;
  if not found then
    raise exception 'line move: employee % not found', v_hr_input;
  end if;
  if lower(coalesce(v_emp.employment_status, '')) not in ('active', 'on_leave') then
    raise exception 'line move: % is % — only an active employee can move line',
      v_emp.hr_id, coalesce(v_emp.employment_status, 'missing employment status');
  end if;

  select * into v_seat from au.seats where seat_id = v_to_seat_id and is_active and effective_to is null;
  if not found then
    raise exception 'line move: seat % not found or inactive', v_to_seat_id;
  end if;
  select * into v_to_line from public.lines where code = v_seat.line_code limit 1;
  if not found then
    raise exception 'line move: seat % is on line %, which has no line record', v_to_seat_id, v_seat.line_code;
  end if;
  select * into v_from_line from public.lines where id = v_emp.line_id;
  if v_emp.line_id is not distinct from v_to_line.id then
    raise exception 'line move: % is already on the % line — use the seat transfer', v_emp.hr_id, v_to_line.name;
  end if;

  v_reason := coalesce(nullif(btrim(p_reason), ''),
    format('moved from %s to %s line', coalesce(v_from_line.name, 'no'), v_to_line.name));

  -- The line first, so phx_transfer_au_seat's same-line guard sees the seat's own line; the
  -- transfer then refuses an occupied seat and syncs area, region and manager from the seat.
  update public.employees set line_id = v_to_line.id, updated_at = now() where hr_id = v_emp.hr_id;
  v_transfer := public.phx_transfer_au_seat(v_actor, v_emp.hr_id, v_to_seat_id, v_effective, null, v_reason);
  v_from_seat_id := v_transfer ->> 'fromSeatId';

  -- The seat they take: its open vacancy is filled by them (the fill trigger finds them already
  -- seated there and changes nothing).
  with filled as (
    update public.position_vacancies v
       set status = 'filled',
           filled_by_hr_id = v_emp.hr_id,
           filled_at = now(),
           note = concat_ws(E'\n', nullif(v.note, ''),
             format('Filled %s by the line move of %s from %s.', v_effective, v_emp.hr_id, coalesce(v_from_line.name, 'no line'))),
           updated_at = now()
     where v.seat_id = v_to_seat_id
       and lower(coalesce(v.status, 'open')) = 'open'
    returning coalesce(v.vacancy_code, v.id::text) as code
  )
  select coalesce(array_agg(code order by code), array[]::text[]) into v_filled from filled;

  -- The seat they leave: one open vacancy, unless it already has one.
  if v_from_seat_id is not null and not exists (
    select 1 from public.position_vacancies v
     where v.seat_id = v_from_seat_id and lower(coalesce(v.status, 'open')) = 'open'
  ) then
    v_opened := 'VAC-' || regexp_replace(upper(v_emp.hr_id), '[^A-Z0-9]+', '', 'g') || '-LM'
      || upper(substr(md5(v_emp.hr_id || '|' || v_from_seat_id || '|' || clock_timestamp()::text), 1, 4));
    begin
      insert into public.position_vacancies (
        area_id, department_id, job_title, line_id, note, position_id, region_name,
        replacement_for_hr_id, seat_id, status, vacancy_code, created_at, updated_at
      ) values (
        v_emp.area_id, v_emp.department_id, v_emp.job_title, v_emp.line_id,
        format('Opened by the line move of %s (%s) to the %s line, effective %s.',
          coalesce(v_emp.nickname, v_emp.full_name), v_emp.hr_id, v_to_line.name, v_effective),
        v_emp.position_id, v_emp.region_name,
        v_emp.hr_id, v_from_seat_id, 'open', v_opened, now(), now()
      );
    exception when unique_violation then
      v_opened := null;
    end;
  end if;

  begin
    insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
    values (
      v_actor,
      'employee_line_move',
      v_emp.hr_id,
      format('Moved %s from the %s line to the %s line on seat %s, effective %s',
        v_emp.hr_id, coalesce(v_from_line.name, 'no'), v_to_line.name, v_to_seat_id, v_effective),
      jsonb_build_object(
        'fromLine', v_from_line.name, 'toLine', v_to_line.name,
        'transfer', v_transfer, 'vacanciesFilled', to_jsonb(v_filled), 'vacancyOpened', v_opened,
        'reason', v_reason
      )
    );
  exception when others then
    null;
  end;

  return v_transfer || jsonb_build_object(
    'lineMove', jsonb_build_object(
      'fromLine', v_from_line.name,
      'toLine', v_to_line.name,
      'vacanciesFilled', to_jsonb(v_filled),
      'vacancyOpened', v_opened
    )
  );
end;
$function$;

revoke execute on function public.phx_move_employee_to_line(text, text, text, date, text) from public, anon, authenticated;
grant execute on function public.phx_move_employee_to_line(text, text, text, date, text) to service_role;

commit;
