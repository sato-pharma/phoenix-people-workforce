-- phoenix_crm_validation_gap_fixes
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_decide_request — approving an ADD request validates the customer only when he
--      holds an active place. With none he is admitted to "To validate" (status pending, grade and
--      potential kept, reopened_at stamped) and the rep captures his door again.
--   2. phoenix_crm_customers_validated_has_place — a deferred constraint trigger: an AM or PM
--      customer cannot BECOME validated in a transaction that leaves him with no active place.
--   3. phoenix_crm_refused_readings — a new refusal reason, `readings_apart`: a place capture whose
--      pin and photo reading cannot both be the door. Its distance is the gap between the two.
--   4. phoenix_crm_far_visit_holds.basis — why a visit is held: `stuck` (the 2026-11-10 rule, the
--      default, every existing row) or `before_place` (logged before the customer had a place, and
--      found past the line of the place he was then validated at).
--
-- WHY: the Phoenix CRM validation audit of 2026-11-11 (owner: "Build all six fixes").
--   * 23 customers were validated with NO place: each one's only place had been rejected and
--     retired (no signboard, wrong name), and the add request approved afterwards stamped
--     validated_at regardless — e.g. a validation rejected on 20 Oct and an add approved on 10 Nov.
--     25 visits by 8 reps were then saved against 14 of them with nothing to be measured against.
--   * 34 active places hold a pin and a photo reading more than 250 m apart; the door never
--     compared the two (far-visit-safeguards.ts, section E).
--   * 45 rep visits since 20 Oct were logged before the customer was validated and sit past the
--     far line of the place he was later validated at; all of them count.
--
-- ROLLBACK:
--   drop trigger phoenix_crm_customers_validated_has_place on public.phoenix_crm_customers;
--   drop trigger phoenix_crm_customers_born_validated_has_place on public.phoenix_crm_customers;
--   drop function public.phoenix_crm_customers_validated_has_place();
--   alter table public.phoenix_crm_far_visit_holds drop column basis;  -- after restoring the tries check to
--     (tries between 1 and 1000), which needs every before_place hold decided or removed first;
--   re-create the two refused-readings checks without 'readings_apart' (only once no such row exists);
--   re-create phoenix_crm_decide_request from its previous body: the ONE `create or replace function
--     public.phoenix_crm_decide_request` statement in 20260929235106_phoenix_crm_list_admission.sql
--     (md5(prosrc) 19ccb2eb1c3cbaddfedd57bf9ce30c7a). 🔴 NEVER run that file whole: it redefines eight
--     other functions, changes constraints and updates live rows.
--   The previous refused-readings checks are in 20261110170000_phoenix_crm_far_visit_safeguards.sql.
--   Nothing here rewrites or deletes a row, so there is no pre-image to take.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- ── 1 · an approved add validates only a customer who holds a place ─────────────────────────────

create or replace function public.phoenix_crm_decide_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_seat text;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_stage_in text := nullif(p ->> 'stage', '');
  v_approved_in text := nullif(p ->> 'approved_grade', '');
  v_potential_in text := nullif(p ->> 'potential_grade', '');
  v_request public.phoenix_crm_list_requests%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_status text;
  v_final boolean := true;
  v_has_place boolean;
begin
  if v_actor is null or v_request_id is null or v_decision not in ('approve', 'refuse') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if (v_approved_in is not null and v_approved_in not in ('A', 'B', 'C'))
    or (v_potential_in is not null and v_potential_in not in ('AA', 'AB', 'AC', 'BA', 'BB', 'BC')) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = v_request_id
    and q.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  v_seat := v_request.seat_id;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = v_request_id
  for update;
  if v_request.status <> 'pending' then
    raise exception 'phoenix_crm:request_decided';
  end if;
  -- Two people deciding at once: the second one's step has already moved on.
  if v_stage_in is not null and v_stage_in is distinct from v_request.stage then
    raise exception 'phoenix_crm:request_wrong_stage';
  end if;

  -- ── The district manager's step of a two-step request: approving hands it to SFE ──────────────
  if v_decision = 'approve' and v_request.stage = 'manager' then
    if v_request.kind = 'add' then
      if v_potential_in is null then
        raise exception 'phoenix_crm:potential_grade_required';
      end if;
      v_approved_in := coalesce(v_approved_in, v_request.proposed_grade);
    else
      v_approved_in := null;
      v_potential_in := null;
    end if;

    update public.phoenix_crm_list_requests q
    set stage = 'sfe',
        manager_decided_by_hr_id = v_actor,
        manager_decided_at = now(),
        manager_note = v_note,
        approved_grade = v_approved_in,
        potential_grade = v_potential_in
    where q.id = v_request.id
    returning q.* into v_request;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_request.customer_id, v_request.id, 'request_moved_on', v_actor,
      jsonb_build_object('kind', v_request.kind, 'to_stage', 'sfe', 'approved_grade', v_approved_in, 'potential_grade', v_potential_in),
      v_is_test
    );

    return jsonb_build_object(
      'request_id', v_request.id,
      'seat_id', v_seat,
      'kind', v_request.kind,
      'status', 'pending',
      'stage', 'sfe',
      'final', false,
      'customer_id', v_request.customer_id,
      'customer_name', v_request.customer_name,
      'list_type', v_request.list_type,
      'proposed_grade', v_request.proposed_grade,
      'drop_reason', v_request.drop_reason,
      'requested_by_hr_id', v_request.requested_by_hr_id
    );
  end if;

  if v_decision = 'approve' then
    v_status := 'approved';

    if v_request.kind = 'grade' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or v_customer.status <> 'active' then
        raise exception 'phoenix_crm:customer_dropped';
      end if;
      update public.phoenix_crm_customers c
      set grade = v_request.proposed_grade, updated_at = now()
      where c.id = v_customer.id;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'grade_changed', v_actor,
        jsonb_build_object('from', v_customer.grade, 'to', v_request.proposed_grade), v_is_test
      );

    elsif v_request.kind = 'add' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or not (
        v_customer.status = 'outside'
        or (v_customer.status = 'dropped' and v_customer.origin = 'new' and v_customer.validated_at is null)
      ) then
        raise exception 'phoenix_crm:not_outside';
      end if;
      -- 🔴 ADMITTED IS NOT VALIDATED (owner, 2026-11-11). Until this migration the approval stamped
      -- validated_at whatever had happened to the door since the request was filed, and 23 customers
      -- were validated with NO place — each one's only place had been rejected and retired first. A
      -- pharmacy is validated by its own pin and holds no place row, so it keeps the old door.
      v_has_place := v_customer.list_type not in ('AM', 'PM') or exists (
        select 1 from public.phoenix_crm_places pl
        where pl.customer_id = v_customer.id and pl.status = 'active'
      );
      if v_has_place then
        -- Admitted. validated_at is set NOW: the customer was validated at the door, and every visit
        -- logged against him since starts counting, in the month it happened (owner, 2026-09-29).
        update public.phoenix_crm_customers c
        set status = 'active',
            validated_at = now(),
            validated_by_hr_id = v_request.requested_by_hr_id,
            grade = coalesce(v_request.approved_grade, v_approved_in, v_request.proposed_grade),
            potential_grade = coalesce(v_request.potential_grade, v_potential_in),
            dropped_reason = null,
            dropped_note = null,
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_customer.id
        returning c.* into v_customer;
      else
        -- Admitted with no door on file: he goes to "To validate", graded as approved, and the rep
        -- captures his place again. reopened_at is the same stamp a rejected validation leaves.
        update public.phoenix_crm_customers c
        set status = 'pending',
            validated_at = null,
            validated_by_hr_id = null,
            grade = coalesce(v_request.approved_grade, v_approved_in, v_request.proposed_grade),
            potential_grade = coalesce(v_request.potential_grade, v_potential_in),
            dropped_reason = null,
            dropped_note = null,
            reopened_at = now(),
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_customer.id
        returning c.* into v_customer;
      end if;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_admitted', v_actor,
        jsonb_build_object('grade', v_customer.grade, 'potential_grade', v_customer.potential_grade,
          'validated', v_has_place, 'to', v_customer.status), v_is_test
      );

    elsif v_request.kind = 'restore' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or v_customer.status <> 'dropped' then
        raise exception 'phoenix_crm:not_archived';
      end if;
      -- Back where he was: on the list if he had been validated, waiting to be validated if not.
      update public.phoenix_crm_customers c
      set status = case when c.validated_at is not null then 'active' else 'pending' end,
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id
      returning c.* into v_customer;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (v_seat, v_customer.id, v_request.id, 'customer_restored', v_actor, jsonb_build_object('to', v_customer.status), v_is_test);

    elsif v_request.customer_id is not null then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      -- Active or pending: both leave the list. A pending one keeps validated_at null, so the visits
      -- logged against him never start counting — he was never validated. His places are KEPT
      -- (owner, 2026-09-29): the clinic is still where it was, and a bring-back needs no new photo.
      if not found or v_customer.status = 'dropped' then
        raise exception 'phoenix_crm:customer_dropped';
      end if;
      update public.phoenix_crm_customers c
      set status = 'dropped',
          dropped_reason = v_request.drop_reason,
          dropped_note = v_request.note,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id;

      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
            stage = null,
            decided_at = now(),
            decided_by_hr_id = v_actor,
            decision_note = 'The customer left the list'
        where q.customer_id = v_customer.id
          and q.status = 'pending'
          and q.id <> v_request.id
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'dropped'), v_is_test
      from withdrawn w;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_dropped', v_actor,
        jsonb_build_object('reason', v_request.drop_reason), v_is_test
      );

    else
      select c.* into v_customer
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.reference_contact_crm_id = v_request.reference_contact_crm_id
        and c.is_test = v_is_test
      for update;
      if found then
        if v_customer.status = 'active' then
          raise exception 'phoenix_crm:already_validated';
        end if;
        if v_customer.status = 'dropped' then
          raise exception 'phoenix_crm:customer_dropped';
        end if;
        -- Pending: the customer was carried over from iReports360 and never validated.
        update public.phoenix_crm_customers c
        set status = 'dropped',
            dropped_reason = v_request.drop_reason,
            dropped_note = v_request.note,
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_customer.id
        returning c.* into v_customer;
      else
        insert into public.phoenix_crm_customers (
          seat_id, line_code, list_type, name, grade, origin, reference_contact_crm_id, status, validated_at,
          dropped_reason, dropped_note, status_changed_at, created_by_hr_id, is_test
        )
        values (
          v_seat, v_request.line_code, v_request.list_type, left(v_request.customer_name, 200), v_request.current_grade, 'reference',
          v_request.reference_contact_crm_id, 'dropped', null, v_request.drop_reason, v_request.note, now(),
          v_request.requested_by_hr_id, v_is_test
        )
        returning * into v_customer;
      end if;

      update public.phoenix_crm_list_requests q set customer_id = v_customer.id where q.id = v_request.id;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_dropped', v_actor,
        jsonb_build_object('reason', v_request.drop_reason, 'reference_contact_crm_id', v_request.reference_contact_crm_id),
        v_is_test
      );
    end if;
  else
    v_status := 'refused';

    -- A refused add sends the customer to the Archive: he was never admitted, and the rep can still
    -- ask again from there.
    if v_request.kind = 'add' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if found and v_customer.status = 'outside' then
        update public.phoenix_crm_customers c
        set status = 'dropped',
            dropped_reason = 'not_admitted',
            dropped_note = v_note,
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_customer.id
        returning c.* into v_customer;

        insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
        values (v_seat, v_customer.id, v_request.id, 'customer_archived', v_actor, jsonb_build_object('why', 'add_refused'), v_is_test);
      end if;
    end if;
  end if;

  update public.phoenix_crm_list_requests q
  set status = v_status,
      stage = null,
      decided_at = now(),
      decided_by_hr_id = v_actor,
      decision_note = v_note,
      manager_decided_by_hr_id = case when v_request.stage = 'manager' then v_actor else q.manager_decided_by_hr_id end,
      manager_decided_at = case when v_request.stage = 'manager' then now() else q.manager_decided_at end,
      manager_note = case when v_request.stage = 'manager' then v_note else q.manager_note end,
      sfe_decided_by_hr_id = case when v_request.stage = 'sfe' then v_actor else q.sfe_decided_by_hr_id end,
      sfe_decided_at = case when v_request.stage = 'sfe' then now() else q.sfe_decided_at end,
      sfe_note = case when v_request.stage = 'sfe' then v_note else q.sfe_note end,
      potential_grade = coalesce(q.potential_grade, case when v_request.kind = 'add' and v_status = 'approved' then v_potential_in end)
  where q.id = v_request.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, coalesce(v_customer.id, v_request.customer_id), v_request.id, 'request_decided', v_actor,
    jsonb_build_object('kind', v_request.kind, 'decision', v_status, 'stage', v_request.stage), v_is_test
  );

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', v_status,
    'stage', null,
    'final', v_final,
    'customer_id', coalesce(v_customer.id, v_request.customer_id),
    'customer_name', v_request.customer_name,
    'list_type', v_request.list_type,
    'proposed_grade', v_request.proposed_grade,
    'drop_reason', v_request.drop_reason,
    'requested_by_hr_id', v_request.requested_by_hr_id
  );
end;
$function$;

revoke execute on function public.phoenix_crm_decide_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_request(jsonb) to service_role;

-- ── 2 · an AM or PM customer cannot BECOME validated and be left with no place ─────────────────
--
-- It guards the stamp going from empty to set, and nothing else: a customer who already holds the
-- stamp and returns to the list is the bring-back doors' own test (20261111013233), and the
-- nightly check reads whatever is left.
--
-- DEFERRED, so it reads the transaction's END state: phoenix_crm_validate_customer stamps the customer
-- before it inserts his place, and that order must keep working. It asks only when validated_at goes
-- from empty to set (or a row is born validated), so the customers already validated are never
-- re-judged by an unrelated edit, and a pharmacy — validated by its own pin, with no place row — is
-- left alone. Every door that validates today was read on 2026-11-11 and holds an active place when it
-- does: phoenix_crm_validate_customer, _decide_validation_review, _decide_shared_place,
-- _restore_validation, _restore_shared_place, _settle_venue_timetable, _place_on_trusted_point.

create or replace function public.phoenix_crm_customers_validated_has_place()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- The row as the transaction leaves it, never as the statement that fired this saw it.
  if not exists (
    select 1 from public.phoenix_crm_customers c
    where c.id = new.id and c.validated_at is not null and c.list_type in ('AM', 'PM')
  ) then
    return null;
  end if;
  if not exists (
    select 1 from public.phoenix_crm_places pl
    where pl.customer_id = new.id and pl.status = 'active'
  ) then
    raise exception 'phoenix_crm:validated_without_place';
  end if;
  return null;
end;
$function$;

revoke execute on function public.phoenix_crm_customers_validated_has_place() from public, anon, authenticated;
grant execute on function public.phoenix_crm_customers_validated_has_place() to service_role;

-- Two triggers, because a WHEN clause may read OLD only on an UPDATE: the update asks ONLY when the stamp
-- goes from empty to set, so an edit that merely carries validated_at along never re-judges a customer.
drop trigger if exists phoenix_crm_customers_validated_has_place on public.phoenix_crm_customers;
create constraint trigger phoenix_crm_customers_validated_has_place
  after update of validated_at on public.phoenix_crm_customers
  deferrable initially deferred
  for each row
  when (old.validated_at is null and new.validated_at is not null and new.list_type in ('AM', 'PM'))
  execute function public.phoenix_crm_customers_validated_has_place();

drop trigger if exists phoenix_crm_customers_born_validated_has_place on public.phoenix_crm_customers;
create constraint trigger phoenix_crm_customers_born_validated_has_place
  after insert on public.phoenix_crm_customers
  deferrable initially deferred
  for each row
  when (new.validated_at is not null and new.list_type in ('AM', 'PM'))
  execute function public.phoenix_crm_customers_validated_has_place();

-- ── 3 · a refused capture whose two readings cannot both be the door ────────────────────────────

alter table public.phoenix_crm_refused_readings
  drop constraint phoenix_crm_refused_readings_reason_check;
alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_reason_check check (reason = any (array[
    'no_fix'::text, 'rough'::text, 'off_listing'::text, 'blocked'::text, 'timetable_unreadable'::text,
    'timetable_missing'::text, 'signboard_unreadable'::text, 'signboard_no_plate'::text,
    'far_from_place'::text, 'impossible_travel'::text, 'readings_apart'::text
  ]));

-- `distance_meters` is the gap between the pin and the photo's reading; like an impossible reading it
-- is about the capture, never about a saved place.
alter table public.phoenix_crm_refused_readings
  drop constraint phoenix_crm_refused_readings_far_from_place_check;
alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_far_from_place_check check (
    reason = 'far_from_place'::text
    or (reason = any (array['impossible_travel'::text, 'readings_apart'::text]) and place_id is null)
    or (place_id is null and distance_meters is null)
  );

-- ── 4 · why a visit is held for the SFE ─────────────────────────────────────────────────────────

alter table public.phoenix_crm_far_visit_holds
  add column if not exists basis text not null default 'stuck';
alter table public.phoenix_crm_far_visit_holds
  drop constraint if exists phoenix_crm_far_visit_holds_basis;
alter table public.phoenix_crm_far_visit_holds
  add constraint phoenix_crm_far_visit_holds_basis check (basis in ('stuck', 'before_place'));

-- A visit held before its place was refused by nobody, so its `tries` is 0; a stuck rep's stays 1 to 1000.
alter table public.phoenix_crm_far_visit_holds
  drop constraint if exists phoenix_crm_far_visit_holds_tries;
alter table public.phoenix_crm_far_visit_holds
  add constraint phoenix_crm_far_visit_holds_tries check (
    tries between 0 and 1000 and (basis <> 'stuck' or tries >= 1)
  );

comment on column public.phoenix_crm_far_visit_holds.basis is
  'Why the visit waits for the SFE: stuck = saved after five far refusals from one spot (2026-11-10); before_place = logged before the customer had a place and found past the far line of the place he was then validated at (2026-11-11).';

commit;
