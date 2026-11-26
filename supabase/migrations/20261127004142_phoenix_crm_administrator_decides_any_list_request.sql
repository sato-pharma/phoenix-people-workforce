-- phoenix_crm_administrator_decides_any_list_request
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_list_requests gains returned_from_stage ('manager' | 'sfe' | null): the step a request
--      was at when it was returned to the rep for a comment.
--   2. phoenix_crm_return_request takes `as_administrator`. With it, the district manager's own step can
--      be returned too (without it that step is still refused, `phoenix_crm:cannot_return`, exactly as
--      before). Every return now records the step it left in returned_from_stage.
--   3. phoenix_crm_answer_request sends the rep's comment back to the step the request left
--      (returned_from_stage), and to SFE (a grade change: no step) when that is null — which is every
--      row returned before this migration, so nothing waiting today moves.
--   4. phoenix_crm_decide_request reads a request that is WITH THE REP as standing at the step it returns
--      to, so the Administrator's approve or refuse of it takes that step — the district manager's (it
--      moves on to SFE) or SFE's (final) — and skips none. The body is otherwise byte-identical to
--      20261114062049's, which is what production runs (md5 of prosrc compared on 2026-11-27).
--
-- WHY: owner, 2026-11-27: "make super admin can approve reject or return for edit any approval type in
--   phoenix crm … I must have the authority to respond whatever response in any step any status as super
--   admin". On a list request he could only Decline at the district manager's step of a grade change, on
--   a request sitting with the rep, and on one held on Place checks, and he could never return one.
--   WHO may act stays in the app (`canOverrideDecision`, server/access.ts); these functions are the state
--   machine.
--
-- ROLLBACK: re-apply the three function bodies from 20261114062049 (phoenix_crm_decide_request) and the
--   live definitions of 2026-11-27 (return/answer, the same text without as_administrator and
--   returned_from_stage), then `alter table public.phoenix_crm_list_requests drop column returned_from_stage;`.
--   Nothing is deleted or rewritten by this migration: the column is added empty.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Not destructive and not bulk: one empty nullable column and three function bodies.

begin;

alter table public.phoenix_crm_list_requests
  add column if not exists returned_from_stage text;

alter table public.phoenix_crm_list_requests
  drop constraint if exists phoenix_crm_list_requests_returned_from_stage_check;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_returned_from_stage_check
  check (returned_from_stage is null or returned_from_stage in ('manager', 'sfe'));

comment on column public.phoenix_crm_list_requests.returned_from_stage is
  'The step the request was at when it was returned to the rep for a comment; the rep''s answer sends it back there. Null: SFE for a two-step kind, no step for a grade change (the rule before 2026-11-27).';

-- 2. Return for a comment. Only the Administrator returns the district manager's own step.
create or replace function public.phoenix_crm_return_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_stage_in text := nullif(p ->> 'stage', '');
  v_as_administrator boolean := coalesce((p ->> 'as_administrator')::boolean, false);
  v_seat text;
  v_request public.phoenix_crm_list_requests%rowtype;
begin
  if v_actor is null or v_request_id is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;
  if char_length(v_note) > 500 then
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
  if v_request.stage = 'rep' then
    raise exception 'phoenix_crm:already_returned';
  end if;
  if v_stage_in is not null and v_stage_in is distinct from v_request.stage then
    raise exception 'phoenix_crm:request_wrong_stage';
  end if;
  -- The district manager's own step is never returned by him or by SFE; the Administrator, who may act
  -- at any step in its holder's place, may (owner, 2026-11-27).
  if v_request.stage = 'manager' and not v_as_administrator then
    raise exception 'phoenix_crm:cannot_return';
  end if;

  update public.phoenix_crm_list_requests q
  set returned_from_stage = v_request.stage,
      stage = 'rep',
      return_note = v_note,
      returned_by_hr_id = v_actor,
      returned_at = now(),
      rep_reply = null,
      replied_at = null
  where q.id = v_request.id
  returning q.* into v_request;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_request.customer_id, v_request.id, 'request_returned', v_actor,
    jsonb_build_object('kind', v_request.kind, 'from_stage', v_request.returned_from_stage, 'as_administrator', v_as_administrator),
    v_is_test
  );

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', 'pending',
    'stage', 'rep',
    'returned_from_stage', v_request.returned_from_stage,
    'returned_at', v_request.returned_at,
    'customer_id', v_request.customer_id,
    'customer_name', v_request.customer_name,
    'list_type', v_request.list_type,
    'requested_by_hr_id', v_request.requested_by_hr_id
  );
end;
$$;

revoke execute on function public.phoenix_crm_return_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_return_request(jsonb) to service_role;

-- 3. The rep's comment goes back to the step the request left.
create or replace function public.phoenix_crm_answer_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_reply text := nullif(regexp_replace(trim(coalesce(p ->> 'reply', '')), '\s+', ' ', 'g'), '');
  v_request public.phoenix_crm_list_requests%rowtype;
  v_back_to text;
  v_note text;
begin
  if v_seat is null or v_actor is null or v_request_id is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reply is null then
    raise exception 'phoenix_crm:note_required';
  end if;
  if char_length(v_reply) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = v_request_id
    and q.seat_id = v_seat
    and q.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'phoenix_crm:request_decided';
  end if;
  if v_request.stage is distinct from 'rep' then
    raise exception 'phoenix_crm:not_returned';
  end if;

  v_back_to := coalesce(v_request.returned_from_stage, case when v_request.kind = 'grade' then null else 'sfe' end);

  v_note := v_request.note;
  if v_request.kind = 'drop' then
    v_note := case
      when v_request.note is null then v_reply
      when char_length(v_request.note || ' — ' || v_reply) <= 500 then v_request.note || ' — ' || v_reply
      else v_reply
    end;
  end if;

  update public.phoenix_crm_list_requests q
  set stage = v_back_to,
      rep_reply = v_reply,
      replied_at = now(),
      note = v_note
  where q.id = v_request.id
  returning q.* into v_request;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (v_seat, v_request.customer_id, v_request.id, 'request_answered', v_actor, jsonb_build_object('kind', v_request.kind, 'to_stage', v_back_to), v_is_test);

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', 'pending',
    'stage', v_request.stage,
    'customer_name', v_request.customer_name,
    'returned_by_hr_id', v_request.returned_by_hr_id,
    'requested_by_hr_id', v_request.requested_by_hr_id,
    'replied_at', v_request.replied_at
  );
end;
$$;

revoke execute on function public.phoenix_crm_answer_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_answer_request(jsonb) to service_role;

-- 4. The decision. Byte-identical to 20261114062049's body except the one block marked 2026-11-27.
create or replace function public.phoenix_crm_decide_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
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
  -- 🔴 2026-11-27 — a request WITH THE REP stands at the step it returns to (the step it was returned
  -- from, else SFE, else none for a grade change: phoenix_crm_answer_request's own rule). Only the
  -- Administrator decides one there (the app refuses everyone else's approve); his decision takes that
  -- step and skips none (owner, 2026-11-27: "any step any status").
  if v_request.stage = 'rep' then
    v_request.stage := coalesce(v_request.returned_from_stage, case when v_request.kind = 'grade' then null else 'sfe' end);
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
            -- 2026-11-14 (left items): validated, so nothing waits to be captured again.
            reopened_at = null,
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
          -- 2026-11-14 (left items): back in use with his place, so the stamp of an old refusal goes.
          reopened_at = case
            when c.validated_at is not null and not v_has_place then now()
            when c.validated_at is not null and v_has_place then null
            else c.reopened_at
          end,
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
$$;

revoke execute on function public.phoenix_crm_decide_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_request(jsonb) to service_role;

commit;
