-- phoenix_crm_bring_back_never_validates_without_place
--
-- WHAT THIS CHANGES (two functions, no table, no row):
--   1. phoenix_crm_decide_request — approving a BRING-BACK (kind 'restore') puts the customer on the
--      list only when he was validated AND still holds an active place. With no place he goes to
--      "To validate": validated_at cleared, reopened_at stamped. Everything else is the function
--      exactly as 20261111004733 left it.
--   2. phoenix_crm_reverse_list_request — (a) the Administrator undoing an approved DROP uses the
--      same test; (b) undoing an approved ADD accepts a customer who is 'pending' as well as
--      'active', because since 20261111004733 an add with no place admits to "To validate" and
--      that decision could no longer be undone.
--
-- WHY: the review of 20261111004733 (2026-11-11). Its triggers fire only when validated_at goes
--   from empty to set. A customer in the Archive keeps his stamp while his last place is retired
--   (a venue or a validation review rejected un-validates only an ACTIVE customer), so a bring-back
--   or a reversed drop returned him to the list validated with no place, and no trigger saw it:
--   validated_at is not in that update. A pharmacy holds no place row and keeps the old door.
--
-- ROLLBACK: re-create the two functions from their previous bodies — phoenix_crm_decide_request
--   from 20261111004733_phoenix_crm_validation_gap_fixes.sql (the function statement only), and
--   phoenix_crm_reverse_list_request from 20261008190000_phoenix_crm_administrator_reverses.sql
--   (the function statement only, never the whole file). Nothing here rewrites or deletes a row,
--   so there is no pre-image to take.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- ── 1 · a bring-back returns a customer to the list only while he holds a place ─────────────────

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
      -- Back where he was: on the list if he had been validated AND still holds a place, waiting to be
      -- validated if not. His last place can be retired while he sits in the Archive (a venue or a
      -- review rejected: both un-validate only an ACTIVE customer), and the stamp would then put him
      -- back on the list with nothing to measure a visit against (2026-11-11).
      v_has_place := v_customer.list_type not in ('AM', 'PM') or exists (
        select 1 from public.phoenix_crm_places pl
        where pl.customer_id = v_customer.id and pl.status = 'active'
      );
      update public.phoenix_crm_customers c
      set status = case when c.validated_at is not null and v_has_place then 'active' else 'pending' end,
          validated_at = case when v_has_place then c.validated_at else null end,
          validated_by_hr_id = case when v_has_place then c.validated_by_hr_id else null end,
          reopened_at = case when c.validated_at is not null and not v_has_place then now() else c.reopened_at end,
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id
      returning c.* into v_customer;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (v_seat, v_customer.id, v_request.id, 'customer_restored', v_actor, jsonb_build_object('to', v_customer.status, 'place', v_has_place), v_is_test);

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

-- ── 2 · the Administrator's undo: the same test on a reversed drop, and a pending add is undoable ─

create or replace function public.phoenix_crm_reverse_list_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_seat text;
  v_request public.phoenix_crm_list_requests%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_old_grade text;
  v_reason text;
  v_has_place boolean;
begin
  if v_request_id is null or v_actor is null or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;

  select q.* into v_request from public.phoenix_crm_list_requests q where q.id = v_request_id and q.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  v_seat := v_request.seat_id;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request from public.phoenix_crm_list_requests q where q.id = v_request_id for update;
  if v_request.status <> 'approved' or v_request.customer_id is null then
    raise exception 'phoenix_crm:request_not_approved';
  end if;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
  if not found then
    raise exception 'phoenix_crm:reverse_customer_moved_on';
  end if;

  -- Anything that touched this customer after the decision (another request, a place, a move) means the
  -- picture is no longer the one the decision made: say so, change nothing.
  if exists (
    select 1 from public.phoenix_crm_list_events ev
    where ev.customer_id = v_customer.id
      and ev.created_at > v_request.decided_at
      and ev.request_id is distinct from v_request.id
  ) or exists (
    select 1 from public.phoenix_crm_list_requests q2
    where q2.customer_id = v_customer.id and q2.id <> v_request.id and q2.requested_at > v_request.decided_at
  ) then
    raise exception 'phoenix_crm:reverse_customer_moved_on';
  end if;

  if v_request.kind = 'grade' then
    if v_customer.status <> 'active' or v_customer.grade is distinct from v_request.proposed_grade then
      raise exception 'phoenix_crm:reverse_customer_moved_on';
    end if;
    select e.details ->> 'from' into v_old_grade
    from public.phoenix_crm_list_events e
    where e.request_id = v_request.id and e.event_type = 'grade_changed'
    order by e.id desc limit 1;
    if v_old_grade is null then
      raise exception 'phoenix_crm:reverse_customer_moved_on';
    end if;
    update public.phoenix_crm_customers c set grade = v_old_grade, updated_at = now() where c.id = v_customer.id;
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer.id, v_request.id, 'grade_change_reversed', v_actor,
            jsonb_build_object('from', v_customer.grade, 'to', v_old_grade), v_is_test);

  elsif v_request.kind = 'add' then
    -- 'pending' too (2026-11-11): an add approved for a customer with no place admits him to
    -- "To validate", and that decision must stay as undoable as one that validated him. Anything
    -- that moved him since is already refused above.
    if v_customer.status not in ('active', 'pending') then
      raise exception 'phoenix_crm:reverse_customer_moved_on';
    end if;
    -- Back out the way a refused add leaves: in the Archive, never admitted, the rep may ask again.
    update public.phoenix_crm_customers c
    set status = 'dropped',
        dropped_reason = 'not_admitted',
        dropped_note = v_note,
        validated_at = null,
        validated_by_hr_id = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer.id, v_request.id, 'customer_archived', v_actor, jsonb_build_object('why', 'add_reversed'), v_is_test);

  elsif v_request.kind = 'restore' then
    if v_customer.status not in ('active', 'pending') then
      raise exception 'phoenix_crm:reverse_customer_moved_on';
    end if;
    select coalesce(nullif(e.details ->> 'reason', ''), case when e.event_type = 'customer_archived' then 'not_admitted' end)
      into v_reason
    from public.phoenix_crm_list_events e
    where e.customer_id = v_customer.id and e.event_type in ('customer_dropped', 'customer_archived') and e.created_at <= v_request.decided_at
    order by e.id desc limit 1;
    update public.phoenix_crm_customers c
    set status = 'dropped',
        dropped_reason = coalesce(v_reason, 'other'),
        dropped_note = v_note,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer.id, v_request.id, 'customer_archived', v_actor, jsonb_build_object('why', 'restore_reversed'), v_is_test);

  elsif v_request.kind = 'drop' then
    if v_customer.status <> 'dropped' then
      raise exception 'phoenix_crm:reverse_customer_moved_on';
    end if;
    -- Back where he was: on the list if he had been validated, waiting to be validated if not. The
    -- other requests the drop withdrew stay withdrawn - the rep asks again if he still needs them.
    -- ...and on the list only while he still holds a place (2026-11-11, the same door as a bring-back).
    v_has_place := v_customer.list_type not in ('AM', 'PM') or exists (
      select 1 from public.phoenix_crm_places pl
      where pl.customer_id = v_customer.id and pl.status = 'active'
    );
    update public.phoenix_crm_customers c
    set status = case when c.validated_at is not null and v_has_place then 'active' else 'pending' end,
        validated_at = case when v_has_place then c.validated_at else null end,
        validated_by_hr_id = case when v_has_place then c.validated_by_hr_id else null end,
        reopened_at = case when c.validated_at is not null and not v_has_place then now() else c.reopened_at end,
        dropped_reason = null,
        dropped_note = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer.id, v_request.id, 'customer_restored', v_actor, jsonb_build_object('why', 'drop_reversed', 'place', v_has_place), v_is_test);

  else
    raise exception 'phoenix_crm:reverse_customer_moved_on';
  end if;

  update public.phoenix_crm_list_requests q
  set status = 'refused',
      stage = null,
      decided_at = now(),
      decided_by_hr_id = v_actor,
      decision_note = v_note,
      admin_decided_by_hr_id = v_actor,
      admin_decided_at = now(),
      admin_note = v_note
  where q.id = v_request.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (v_seat, v_customer.id, v_request.id, 'request_reversed', v_actor,
          jsonb_build_object('kind', v_request.kind, 'was', 'approved'), v_is_test);

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', 'refused',
    'stage', null,
    'final', true,
    'customer_id', v_customer.id,
    'customer_name', v_request.customer_name,
    'list_type', v_request.list_type,
    'proposed_grade', v_request.proposed_grade,
    'drop_reason', v_request.drop_reason,
    'requested_by_hr_id', v_request.requested_by_hr_id
  );
end;
$$;

revoke execute on function public.phoenix_crm_reverse_list_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_reverse_list_request(jsonb) to service_role;

commit;
