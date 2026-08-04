-- A new hire filling an ORIGINAL (seeded) vacancy never reached au.hire_into_seat: the function
-- returned early whenever replacement_for_hr_id was null, writing no seat and no audit row. The
-- employee was created correctly but never appeared on the organogram, and their seat kept
-- reading "vacant". Found via CN-0006 (Adel Srour), created 2026-08-04, vacancy 16.
--
-- Route 1 (unchanged): a replacement vacancy inherits the seat its predecessor vacated.
-- Route 2 (new): resolve the seat structurally from line + area. (line_code, area_code) is unique
-- across all 106 active REP seats and the seat must still be unoccupied, so the fallback can never
-- steal a staffed seat nor choose between two candidates.
-- Unresolved (new): always write an audit row. Silence was the actual defect.

create or replace function public.phx_hire_into_seat_on_vacancy_filled()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_predecessor_hr_id text := nullif(btrim(old.replacement_for_hr_id), '');
  v_new_hr_id         text := nullif(btrim(new.filled_by_hr_id), '');
  v_seat_id           text;
  v_resolved_by       text;
  v_line_code         text;
  v_area_code         text;
  v_position_code     text;
  v_match_count       integer := 0;
  v_effective_date    date := coalesce(
    (new.filled_at at time zone 'Africa/Cairo')::date,
    (now() at time zone 'Africa/Cairo')::date
  );
begin
  if v_new_hr_id is null then
    return new;
  end if;

  -- Route 1: inherit the predecessor's seat.
  if v_predecessor_hr_id is not null then
    v_seat_id := au.f_last_occupied_seat_by_hr_id(v_predecessor_hr_id);
    if v_seat_id is not null then
      v_resolved_by := 'predecessor_seat';
    end if;
  end if;

  -- Route 2: no predecessor (or their seat is gone) -- resolve from line + area.
  if v_seat_id is null then
    select l.code into v_line_code from public.lines l where l.id = new.line_id;
    select a.code into v_area_code from public.areas a where a.id = new.area_id;
    select p.code into v_position_code from public.positions p where p.id = new.position_id;

    if v_position_code = 'medical_representative'
       and v_line_code is not null
       and v_area_code is not null then
      select count(*), min(s.seat_id)
        into v_match_count, v_seat_id
        from au.seats s
       where s.seat_tier = 'REP'
         and s.is_active
         and s.effective_to is null
         and s.line_code = v_line_code
         and s.area_code = v_area_code
         and not exists (
           select 1
             from au.occupancy_history o
            where o.seat_id = s.seat_id
              and o.effective_to is null
              and o.occupant_hr_id is not null
         );

      if v_match_count = 1 then
        v_resolved_by := 'line_area_match';
      else
        v_seat_id := null;
      end if;
    end if;
  end if;

  -- Never fail silently.
  if v_seat_id is null then
    begin
      insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
      values (
        'system', 'au_seat_hire_unresolved', v_new_hr_id,
        format('No au seat resolved for %s via vacancy %s - they will not appear on the organogram until a seat is assigned',
          v_new_hr_id, coalesce(new.vacancy_code, new.id::text)),
        jsonb_build_object(
          'vacancyId', new.id,
          'vacancyCode', new.vacancy_code,
          'predecessorHrId', v_predecessor_hr_id,
          'lineCode', v_line_code,
          'areaCode', v_area_code,
          'positionCode', v_position_code,
          'candidateSeatMatches', v_match_count
        )
      );
    exception when others then
      null;
    end;
    return new;
  end if;

  begin
    perform au.hire_into_seat(v_seat_id, v_new_hr_id, v_effective_date, 'vacancy_fill_trigger');
    insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
    values (
      'system', 'au_seat_hire', v_new_hr_id,
      format('Auto-hired into au seat %s via vacancy %s (resolved by %s)',
        v_seat_id, coalesce(new.vacancy_code, new.id::text), v_resolved_by),
      jsonb_build_object(
        'seatId', v_seat_id,
        'predecessorHrId', v_predecessor_hr_id,
        'vacancyId', new.id,
        'vacancyCode', new.vacancy_code,
        'resolvedBy', v_resolved_by
      )
    );
  exception when others then
    raise warning 'phx_hire_into_seat_on_vacancy_filled: au.hire_into_seat(%, %) failed: %',
      v_seat_id, v_new_hr_id, sqlerrm;
    begin
      insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
      values (
        'system', 'au_seat_hire_failed', v_new_hr_id,
        format('Failed to auto-hire into au seat %s (resolved by %s): %s',
          v_seat_id, coalesce(v_resolved_by, 'unknown'), sqlerrm),
        jsonb_build_object(
          'seatId', v_seat_id,
          'predecessorHrId', v_predecessor_hr_id,
          'vacancyId', new.id,
          'resolvedBy', v_resolved_by,
          'error', sqlerrm
        )
      );
    exception when others then
      null;
    end;
  end;

  return new;
end;
$function$;

-- A function created in `public` inherits PostgreSQL's default EXECUTE grant to PUBLIC, and both
-- anon and authenticated are members of PUBLIC -- so revoking only those two is a no-op. CREATE OR
-- REPLACE preserves the existing ACL, so production (postgres + service_role only) is unaffected,
-- but replaying this file onto a fresh database would otherwise create it callable by the anon key.
-- Re-grant service_role explicitly: revoking PUBLIC on a default ACL strips it too.
revoke execute on function public.phx_hire_into_seat_on_vacancy_filled() from public, anon, authenticated;
grant execute on function public.phx_hire_into_seat_on_vacancy_filled() to service_role;
