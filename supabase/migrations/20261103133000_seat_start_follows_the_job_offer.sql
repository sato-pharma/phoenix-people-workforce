-- A new hire's seat starts on the job offer's start date, never the day they accepted.
--
-- Owner, 2026-11-03: "the start date must follow the date, the start date in the job offer, not the
-- date when he accepted". The start date reaches the Employee Master from the letter (`offerHireDate`)
-- and the Master is the only source of a hiring date (owner, 2026-07-18, au-occupancy-hiring-date-from-master),
-- so the seat now reads the Master. It used to read position_vacancies.filled_at, which is the moment the
-- record is created at acceptance: on all 42 live rows that disagreed, the seat date was the day the record
-- was created.
--
-- What changes:
--   1. phx_hire_into_seat_on_vacancy_filled dates the seat from employees.hire_date.
--   2. au.hire_into_seat closes the vacant row at the start date, and never before that row began. A start
--      before the vacant row began is a real hand-over, and the person's own date is still the start.
--   3. au.resign_occupant never writes an end before the span began, so someone who declines or moves before
--      their start leaves a zero-length span rather than an inverted one.
--   4. A later Master correction moves the seat with it, or a third mismatch appears the first time HR
--      corrects a date (Mohamed Saad's case). Only a span that was following the Master moves.
--
-- A person's date moving later means the seat reads vacant until they start, which is the truth. The rows
-- already written were corrected in one transaction OUTSIDE this file (pre-image in
-- au_backup_20261103.occupancy_hire_start), same as the 2026-10-12 boundary correction: a data correction
-- is a one-off, and it must not re-run on a database whose rows have moved on. 40 of the 42 moved on
-- 2026-11-03, with sales credit, the organogram and open vacancies unchanged. The other two start on
-- 2026-11-08 and were left as they stood, because a seat vacant today hands its past months to whoever held
-- it then. From that day, moving them changes no credit.

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
  v_existing_seats    text;
  v_fill_day          date := coalesce(
    (new.filled_at at time zone 'Africa/Cairo')::date,
    (now() at time zone 'Africa/Cairo')::date
  );
  v_hire_date         date;
  v_created_day       date;
  v_has_accepted_offer boolean := false;
  v_effective_date    date;
  v_date_source       text;
begin
  if v_new_hr_id is null then
    return new;
  end if;

  v_seat_id := nullif(btrim(coalesce(new.seat_id, '')), '');
  if v_seat_id is not null then
    v_resolved_by := 'vacancy_seat_id';
  end if;

  if v_seat_id is null and v_predecessor_hr_id is not null then
    v_seat_id := au.f_last_occupied_seat_by_hr_id(v_predecessor_hr_id);
    if v_seat_id is not null then
      v_resolved_by := 'predecessor_seat';
    end if;
  end if;

  if v_seat_id is null then
    select l.code into v_line_code from public.lines l where l.id = new.line_id;
    select a.code into v_area_code from public.areas a where a.id = new.area_id;
    select p.code into v_position_code from public.positions p where p.id = new.position_id;

    if v_position_code = 'medical_representative'
       and v_line_code is not null and v_area_code is not null then
      select count(*), min(s.seat_id)
        into v_match_count, v_seat_id
        from au.seats s
       where s.seat_tier = 'REP' and s.is_active and s.effective_to is null
         and s.line_code = v_line_code and s.area_code = v_area_code
         and not exists (
           select 1 from au.occupancy_history o
            where o.seat_id = s.seat_id and o.effective_to is null and o.occupant_hr_id is not null);

      if v_match_count = 1 then
        v_resolved_by := 'line_area_match';
      else
        v_seat_id := null;
      end if;
    end if;
  end if;

  if v_seat_id is null then
    begin
      insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
      values ('system', 'au_seat_hire_unresolved', v_new_hr_id,
        format('No au seat resolved for %s via vacancy %s - they will not appear on the organogram until a seat is assigned',
          v_new_hr_id, coalesce(new.vacancy_code, new.id::text)),
        jsonb_build_object('vacancyId', new.id, 'vacancyCode', new.vacancy_code,
          'predecessorHrId', v_predecessor_hr_id, 'lineCode', v_line_code, 'areaCode', v_area_code,
          'positionCode', v_position_code, 'candidateSeatMatches', v_match_count));
    exception when others then null;
    end;
    return new;
  end if;

  select string_agg(oh.seat_id, ', ' order by oh.seat_id)
    into v_existing_seats
    from au.occupancy_history oh
   where oh.occupant_canonical_hr_id = lower(v_new_hr_id)
     and oh.effective_to is null and oh.occupant_hr_id is not null;
  if v_existing_seats is not null then
    if v_existing_seats = v_seat_id then
      begin
        insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
        values ('system', 'au_seat_hire', v_new_hr_id,
          format('%s already occupies au seat %s - vacancy %s closed with no seat change',
            v_new_hr_id, v_seat_id, coalesce(new.vacancy_code, new.id::text)),
          jsonb_build_object('seatId', v_seat_id, 'vacancyId', new.id, 'vacancyCode', new.vacancy_code,
            'resolvedBy', coalesce(v_resolved_by, 'unknown'), 'noop', true));
      exception when others then null;
      end;
    else
      begin
        insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
        values ('system', 'au_seat_hire_blocked', v_new_hr_id,
          format('BLOCKED: %s already occupies seat(s) %s - refused to also seat them on %s via vacancy %s. Use the Transfer Seat action to move them instead.',
            v_new_hr_id, v_existing_seats, v_seat_id, coalesce(new.vacancy_code, new.id::text)),
          jsonb_build_object('targetSeatId', v_seat_id, 'existingSeatIds', v_existing_seats,
            'vacancyId', new.id, 'vacancyCode', new.vacancy_code,
            'predecessorHrId', v_predecessor_hr_id, 'resolvedBy', coalesce(v_resolved_by, 'unknown')));
      exception when others then null;
      end;
    end if;
    return new;
  end if;

  -- The seat starts on the Master's hire date, which is the job offer's start date. A date before the
  -- fill day is honoured only for someone arriving through this fill: a long-standing employee moved into
  -- a vacant seat took it on the fill day, and their hire date of years ago must not backdate it.
  begin
    select e.hire_date, (e.created_at at time zone 'Africa/Cairo')::date
      into v_hire_date, v_created_day
      from public.employees e
     where lower(btrim(e.hr_id)) = lower(v_new_hr_id)
     limit 1;

    select exists (
      select 1 from public.offers o
       where lower(btrim(o.employee_hr_id)) = lower(v_new_hr_id) and o.status = 'accepted'
    ) into v_has_accepted_offer;

    if v_hire_date is null then
      v_effective_date := v_fill_day;
      v_date_source := 'fill_day_no_hire_date';
    elsif v_hire_date >= v_fill_day or v_created_day >= v_fill_day or v_has_accepted_offer then
      v_effective_date := v_hire_date;
      v_date_source := 'employee_hire_date';
    else
      v_effective_date := v_fill_day;
      v_date_source := 'fill_day_long_standing_employee';
    end if;
  exception when others then
    v_effective_date := v_fill_day;
    v_date_source := 'fill_day_hire_date_read_failed';
  end;

  begin
    perform au.hire_into_seat(v_seat_id, v_new_hr_id, v_effective_date, 'vacancy_fill_trigger');
    insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
    values ('system', 'au_seat_hire', v_new_hr_id,
      format('Auto-hired into au seat %s via vacancy %s (resolved by %s)',
        v_seat_id, coalesce(new.vacancy_code, new.id::text), v_resolved_by),
      jsonb_build_object('seatId', v_seat_id, 'predecessorHrId', v_predecessor_hr_id,
        'vacancyId', new.id, 'vacancyCode', new.vacancy_code, 'resolvedBy', v_resolved_by,
        'effectiveDate', v_effective_date, 'dateSource', v_date_source));
  exception when others then
    raise warning 'phx_hire_into_seat_on_vacancy_filled: au.hire_into_seat(%, %) failed: %',
      v_seat_id, v_new_hr_id, sqlerrm;
    begin
      insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
      values ('system', 'au_seat_hire_failed', v_new_hr_id,
        format('Failed to auto-hire into au seat %s (resolved by %s): %s',
          v_seat_id, coalesce(v_resolved_by, 'unknown'), sqlerrm),
        jsonb_build_object('seatId', v_seat_id, 'predecessorHrId', v_predecessor_hr_id,
          'vacancyId', new.id, 'resolvedBy', v_resolved_by, 'error', sqlerrm));
    exception when others then null;
    end;
  end;

  return new;
end;
$function$;

revoke execute on function public.phx_hire_into_seat_on_vacancy_filled() from public, anon, authenticated;
grant execute on function public.phx_hire_into_seat_on_vacancy_filled() to service_role;

create or replace function au.hire_into_seat(p_seat_id text, p_hr_id text, p_effective_date date, p_actor text default null::text, p_allow_dual_seat boolean default false)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'au', 'public'
as $function$
declare
  v_cur au.occupancy_history;
  v_seat au.seats;
  v_mgr text;
  v_new bigint;
  v_other_seats text;
begin
  select * into v_seat from au.seats where seat_id = p_seat_id;
  if not found then raise exception 'hire: seat % not found', p_seat_id; end if;

  -- Person-level guard: one person, one open seat span. A deliberate acting
  -- arrangement (the only legitimate dual-seat state) must opt in explicitly.
  if not p_allow_dual_seat then
    select string_agg(seat_id, ', ' order by seat_id)
      into v_other_seats
      from au.occupancy_history
     where occupant_canonical_hr_id = lower(btrim(p_hr_id))
       and effective_to is null
       and occupant_hr_id is not null
       and seat_id <> p_seat_id;
    if v_other_seats is not null then
      raise exception 'hire: % already occupies seat(s) % - refusing to double-seat. Use public.phx_transfer_au_seat to move them, or pass p_allow_dual_seat => true for a deliberate acting arrangement.',
        p_hr_id, v_other_seats;
    end if;
  end if;

  select * into v_cur from au.occupancy_history where seat_id = p_seat_id and effective_to is null;
  if found then
    if v_cur.occupant_hr_id is not null then raise exception 'hire: seat % already occupied by %', p_seat_id, v_cur.occupant_hr_id; end if;
    -- A start before the vacant row began closes that row empty rather than inverted.
    update au.occupancy_history set effective_to = greatest(p_effective_date, v_cur.effective_from) where occupancy_id = v_cur.occupancy_id;
  end if;
  select occupant_hr_id into v_mgr from au.occupancy_history where seat_id = v_seat.parent_seat_id and effective_to is null;
  insert into au.occupancy_history(seat_id,occupant_hr_id,node_type,effective_from,event_type,line_code,region_code,area_code,manager_seat_id,manager_hr_id,prev_occupancy_id,change_reason,source_system,changed_by_hr_id)
  values (p_seat_id,p_hr_id,'person',p_effective_date,'hire',v_seat.line_code,v_seat.region_code,v_seat.area_code,v_seat.parent_seat_id,v_mgr,v_cur.occupancy_id,null,'hire_rpc',p_actor)
  returning occupancy_id into v_new;
  -- The seat is filled; the area is staffed again.
  perform au.sync_area_state_for_seat(p_seat_id, 'vacant_will_hire', 'occupied');
  return v_new;
end $function$;

revoke execute on function au.hire_into_seat(text, text, date, text, boolean) from public, anon, authenticated;
grant execute on function au.hire_into_seat(text, text, date, text, boolean) to service_role;

create or replace function au.resign_occupant(p_seat_id text, p_effective_date date, p_reason text default null::text, p_actor text default null::text)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'au', 'public'
as $function$
declare v_cur au.occupancy_history; v_seat au.seats; v_mgr text; v_new bigint; v_end date;
begin
  select * into v_seat from au.seats where seat_id = p_seat_id;
  if not found then raise exception 'resign: seat % not found', p_seat_id; end if;
  select * into v_cur from au.occupancy_history where seat_id = p_seat_id and effective_to is null;
  if not found then raise exception 'resign: seat % has no open span', p_seat_id; end if;
  if v_cur.occupant_hr_id is null then raise exception 'resign: seat % is already vacant', p_seat_id; end if;
  -- Someone leaving before their start date never held the seat: an empty span, never an inverted one.
  v_end := greatest(p_effective_date, v_cur.effective_from);
  update au.occupancy_history set effective_to = v_end where occupancy_id = v_cur.occupancy_id;
  select occupant_hr_id into v_mgr from au.occupancy_history where seat_id = v_seat.parent_seat_id and effective_to is null;
  insert into au.occupancy_history(seat_id,occupant_hr_id,node_type,effective_from,event_type,line_code,region_code,area_code,manager_seat_id,manager_hr_id,prev_occupancy_id,change_reason,source_system,changed_by_hr_id)
  values (p_seat_id,null,'vacant_placeholder',v_end,'resign',v_seat.line_code,v_seat.region_code,v_seat.area_code,v_seat.parent_seat_id,v_mgr,v_cur.occupancy_id,p_reason,'resignation_rpc',p_actor)
  returning occupancy_id into v_new;
  -- The seat is now vacant; the area it serves must say so too.
  perform au.sync_area_state_for_seat(p_seat_id, 'occupied', 'vacant_will_hire');
  return v_new;
end $function$;

revoke execute on function au.resign_occupant(text, date, text, text) from public, anon, authenticated;
grant execute on function au.resign_occupant(text, date, text, text) to service_role;

-- A Master correction moves the seat too. Only a span that was following the Master moves (its start equals
-- the OLD hire date, or there was none): a long-standing employee seated on a fill day keeps that day, a
-- transfer is not a hire, and a closed span is history. A Master save must never fail because of this.
create or replace function public.phx_seat_start_follows_hire_date()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_span record;
begin
  for v_span in
    select oh.occupancy_id, oh.seat_id, oh.effective_from, oh.prev_occupancy_id
      from au.occupancy_history oh
     where oh.occupant_canonical_hr_id = lower(btrim(new.hr_id))
       and oh.effective_to is null
       and oh.node_type = 'person'
       and oh.event_type = 'hire'
       and oh.source_system = 'hire_rpc'
       and oh.effective_from is distinct from new.hire_date
       and (old.hire_date is null or oh.effective_from = old.hire_date)
  loop
    begin
      update au.occupancy_history
         set effective_from = new.hire_date
       where occupancy_id = v_span.occupancy_id;

      update au.occupancy_history p
         set effective_to = greatest(new.hire_date, p.effective_from)
       where p.occupancy_id = v_span.prev_occupancy_id
         and p.node_type = 'vacant_placeholder';

      insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, old_values, new_values)
      values ('system', 'au_seat_start_moved', new.hr_id,
        format('Seat %s start moved from %s to %s with the Employee Master hire date',
          v_span.seat_id, v_span.effective_from, new.hire_date),
        jsonb_build_object('seatId', v_span.seat_id, 'effectiveFrom', v_span.effective_from),
        jsonb_build_object('seatId', v_span.seat_id, 'effectiveFrom', new.hire_date));
    exception when others then
      raise warning 'phx_seat_start_follows_hire_date: seat % for % failed: %', v_span.seat_id, new.hr_id, sqlerrm;
    end;
  end loop;

  return null;
exception when others then
  raise warning 'phx_seat_start_follows_hire_date: % failed: %', new.hr_id, sqlerrm;
  return null;
end;
$function$;

revoke execute on function public.phx_seat_start_follows_hire_date() from public, anon, authenticated;
grant execute on function public.phx_seat_start_follows_hire_date() to service_role;

drop trigger if exists trg_employees_seat_start_follows_hire_date on public.employees;
create trigger trg_employees_seat_start_follows_hire_date
  after update of hire_date on public.employees
  for each row
  when (old.hire_date is distinct from new.hire_date and new.hire_date is not null)
  execute function public.phx_seat_start_follows_hire_date();
