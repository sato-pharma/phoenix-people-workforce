-- Phase B seat-lifecycle hardening, part 1: never silently double-seat a person.
--
-- Background (diagnosed 2026-08-04): au.occupancy_history enforces one open span per SEAT
-- (occupancy_open_span) but nothing per PERSON. The auto-seat chain
-- (position_vacancies status -> 'filled' -> trg_position_vacancies_hire_into_seat ->
-- au.hire_into_seat) therefore can and did seat one person on two seats at once
-- (AI-0005 held SEAT-AIF-REP-CA2 + SEAT-AIF-REP-CA6 on 2026-08-01). The organogram
-- renders a filled box keyed by occupant HR_ID, so a double-seated person makes one of
-- their seats vanish from the chart with no error anywhere.
--
-- This migration adds the person-level guard at all three writers:
--   1. au.hire_into_seat itself refuses to seat an already-seated person
--      (new p_allow_dual_seat parameter, default false, for deliberate acting
--      arrangements like B-1 REP + ACTING_DM).
--   2. phx_hire_into_seat_on_vacancy_filled pre-checks and writes a LOUD
--      au_seat_hire_blocked audit row instead of seating (and a benign noop audit row
--      when the person already occupies exactly the target seat).
--   3. phx_reconcile_stale_replacement_vacancies only closes a stale vacancy as
--      "filled by X" when X actually occupies the au seat for that vacancy's
--      line + area, so it can never bind a vacancy to someone seated elsewhere.
--
-- Data impact: none. No rows are mutated; three function bodies are replaced.
-- Rollback: re-apply the previous bodies from migrations 20260727234500 (hire_into_seat),
-- 20260804090813 (vacancy-filled trigger) and 20260801150000 (reconciler).

-- ---------------------------------------------------------------------------
-- 1. au.hire_into_seat: person-level guard + explicit dual-seat opt-in.
--    The 4-parameter form must be DROPPED (not replaced) before creating the
--    5-parameter form, otherwise both overloads survive and every existing
--    4-argument call site becomes ambiguous.
-- ---------------------------------------------------------------------------

drop function if exists au.hire_into_seat(text, text, date, text);

create function au.hire_into_seat(
  p_seat_id text,
  p_hr_id text,
  p_effective_date date,
  p_actor text default null::text,
  p_allow_dual_seat boolean default false
)
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
    update au.occupancy_history set effective_to = p_effective_date where occupancy_id = v_cur.occupancy_id;
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

-- ---------------------------------------------------------------------------
-- 2. Vacancy-fill trigger: pre-check the person, audit loudly instead of
--    silently mis-seating. Body otherwise identical to 20260804090813.
-- ---------------------------------------------------------------------------

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

  -- Person-level guard: never auto-seat someone who already holds an open seat span.
  -- A silent double-seat is exactly what makes a seat vanish from the organogram
  -- (both boxes key on the same HR_ID), so refuse here and say so in the audit log.
  select string_agg(oh.seat_id, ', ' order by oh.seat_id)
    into v_existing_seats
    from au.occupancy_history oh
   where oh.occupant_canonical_hr_id = lower(v_new_hr_id)
     and oh.effective_to is null
     and oh.occupant_hr_id is not null;
  if v_existing_seats is not null then
    if v_existing_seats = v_seat_id then
      -- Benign: they already occupy exactly the target seat (e.g. the stale-vacancy
      -- reconciler closing a duplicate row). Nothing to change; record and move on.
      begin
        insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
        values (
          'system', 'au_seat_hire', v_new_hr_id,
          format('%s already occupies au seat %s - vacancy %s closed with no seat change',
            v_new_hr_id, v_seat_id, coalesce(new.vacancy_code, new.id::text)),
          jsonb_build_object(
            'seatId', v_seat_id,
            'vacancyId', new.id,
            'vacancyCode', new.vacancy_code,
            'resolvedBy', coalesce(v_resolved_by, 'unknown'),
            'noop', true
          )
        );
      exception when others then
        null;
      end;
    else
      begin
        insert into public.audit_logs(actor_login_id, entity_type, entity_id, summary, new_values)
        values (
          'system', 'au_seat_hire_blocked', v_new_hr_id,
          format('BLOCKED: %s already occupies seat(s) %s - refused to also seat them on %s via vacancy %s. Use the Transfer Seat action to move them instead.',
            v_new_hr_id, v_existing_seats, v_seat_id, coalesce(new.vacancy_code, new.id::text)),
          jsonb_build_object(
            'targetSeatId', v_seat_id,
            'existingSeatIds', v_existing_seats,
            'vacancyId', new.id,
            'vacancyCode', new.vacancy_code,
            'predecessorHrId', v_predecessor_hr_id,
            'resolvedBy', coalesce(v_resolved_by, 'unknown')
          )
        );
      exception when others then
        null;
      end;
    end if;
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

-- Replay safety: the public schema's default ACL auto-grants EXECUTE to authenticated
-- on every new function, so a fresh-database replay of this file must re-deny it.
revoke execute on function public.phx_hire_into_seat_on_vacancy_filled() from public, anon, authenticated;
grant execute on function public.phx_hire_into_seat_on_vacancy_filled() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Stale-vacancy reconciler: a candidate only satisfies a vacancy when the
--    au seat model agrees they actually occupy that vacancy's line+area seat.
--    Body otherwise identical to 20260801150000.
-- ---------------------------------------------------------------------------

create or replace function public.phx_reconcile_stale_replacement_vacancies()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_checked integer := 0;
  v_closed integer := 0;
  r record;
  v_replacement record;
  v_effective_date date;
begin
  for r in
    select
      v.id as vacancy_id,
      v.area_id as vacancy_area_id,
      d.hr_id as departed_hr_id,
      d.manager_hr_id as departed_manager_hr_id,
      d.line_id as departed_line_id,
      d.job_title as departed_job_title,
      coalesce(d.last_working_date, d.resignation_date) as departed_effective_date
    from public.position_vacancies v
    join public.employees d on d.hr_id = v.replacement_for_hr_id
    where lower(coalesce(v.status, 'open')) = 'open'
      and nullif(trim(coalesce(v.replacement_for_hr_id, '')), '') is not null
      and d.manager_hr_id is not null
      and d.line_id is not null
      and nullif(trim(coalesce(d.job_title, '')), '') is not null
  loop
    v_checked := v_checked + 1;

    select a.hr_id
    into v_replacement
    from public.employees a
    where a.manager_hr_id = r.departed_manager_hr_id
      and a.line_id = r.departed_line_id
      and lower(trim(a.job_title)) = lower(trim(r.departed_job_title))
      -- (1) Area guard: the replacement must sit in the seat's own area.
      and a.area_id is not distinct from r.vacancy_area_id
      and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
      and a.hr_id <> r.departed_hr_id
      and (
        r.departed_effective_date is null
        or a.hire_date is null
        or a.hire_date >= r.departed_effective_date
      )
      -- (2) Single-seat guard: never assign someone who already ACTIVELY fills another
      --     seat (status='filled' only — cancelled rows can carry a stale filled_by_hr_id,
      --     and excluding on those would wrongly skip a legitimate reconciliation).
      and not exists (
        select 1
        from public.position_vacancies pv2
        where pv2.filled_by_hr_id = a.hr_id
          and pv2.id <> r.vacancy_id
          and lower(coalesce(pv2.status, 'open')) = 'filled'
      )
      -- (3) Seat-truth guard: only close this vacancy as "filled by A" when the au
      --     seat model agrees - A must hold the open span on THIS vacancy's own
      --     line+area seat. Someone seated elsewhere (or unseated) never satisfies
      --     a vacancy here; that is exactly how hires got bound to the wrong seat.
      and exists (
        select 1
          from au.occupancy_history oh
          join au.seats s on s.seat_id = oh.seat_id
          join public.lines l on l.code = s.line_code
          join public.areas ar on ar.code = s.area_code
         where oh.occupant_canonical_hr_id = lower(btrim(a.hr_id))
           and oh.effective_to is null
           and oh.occupant_hr_id is not null
           and l.id = r.departed_line_id
           and ar.id = r.vacancy_area_id
      )
    order by a.hire_date asc nulls last
    limit 1;

    if found then
      update public.position_vacancies
      set
        status = 'filled',
        filled_by_hr_id = v_replacement.hr_id,
        filled_at = now(),
        replacement_for_hr_id = null,
        note = concat_ws(
          E'\n',
          nullif(note, ''),
          'Auto-closed by stale-replacement-vacancy reconciliation: seat for '
            || r.departed_hr_id || ' was already filled by ' || v_replacement.hr_id
            || ' on ' || (now() at time zone 'Africa/Cairo')::date::text || '.'
        ),
        updated_at = now()
      where id = r.vacancy_id;

      v_closed := v_closed + 1;
    end if;
  end loop;

  return jsonb_build_object('checked', v_checked, 'closed', v_closed);
exception
  when undefined_column then
    raise notice 'Stale-replacement-vacancy reconciliation skipped because expected lifecycle/vacancy columns are missing.';
    return jsonb_build_object('applied', false, 'reason', 'missing_schema_column');
end;
$function$;

revoke execute on function public.phx_reconcile_stale_replacement_vacancies() from public, anon, authenticated;
grant execute on function public.phx_reconcile_stale_replacement_vacancies() to service_role;
