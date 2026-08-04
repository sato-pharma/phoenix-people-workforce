-- Phase B seat-lifecycle hardening, part 2: a real transfer primitive.
--
-- Until now there was NO application path to move an active employee between au seats:
-- editing area/line on the employee record touches au not at all, so every correction
-- (e.g. AI-0005 wrongly auto-seated in Nasr City on 2026-08-01) was hand-written SQL.
-- au.transfer_occupant exists but trusts its arguments blindly - it will happily vacate
-- whoever sits on p_from_seat without checking the person actually occupies it.
--
-- public.phx_transfer_au_seat is the safe wrapper the app calls (service_role only):
--   * derives the source seat from the person's own open span (explicit p_from_seat_id
--     only needed for a dual-seat holder, e.g. an acting arrangement);
--   * seats an UNSEATED active employee directly (the CN-0006-class repair);
--   * refuses cross-line moves, occupied targets, inactive employees, unknown seats;
--   * syncs the employee master (area_id/area_name/region_code/region_name and, when
--     the destination's manager seat is occupied, manager_hr_id) so the legacy columns
--     stop drifting away from the seat model on every correction;
--   * writes an au_seat_transfer audit row with the full payload.
--
-- Data impact of the migration itself: none (creates one function).
-- Rollback: drop function public.phx_transfer_au_seat(text, text, text, date, text, text);
--           notify pgrst, 'reload schema';

create or replace function public.phx_transfer_au_seat(
  p_actor text,
  p_employee_hr_id text,
  p_to_seat_id text,
  p_effective_date date default null,
  p_from_seat_id text default null,
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
             area_name = v_area.name,
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

notify pgrst, 'reload schema';
