-- phoenix_crm_administrator_reverses
--
-- WHAT THIS ADDS: the Administrator (Omar Gawish) can REVERSE a decision that was already taken, with a
-- comment the rep reads (owner, 2026-10-08: "build reversing approved items for the Administrator").
-- Three new functions, one per kind of item. Nothing existing is replaced.
--   * phoenix_crm_reverse_plan_edit_request  - a REOPENED week closes again, ONLY while the rep has not
--     touched it (the plan is still the draft the reopening made); it goes back to exactly how it was
--     sent, with the original approver's decision restored from the plan's own event history.
--   * phoenix_crm_reverse_unplanned_visit    - an APPROVED off-plan visit becomes refused.
--   * phoenix_crm_reverse_list_request       - an APPROVED list request is undone: a grade change goes
--     back to the old grade, an add leaves the list again (the Archive), a bring-back returns to the
--     Archive, a drop returns to the list. REFUSED if anything touched that customer after the decision.
-- Each ends in status 'refused' with admin_decided_by_hr_id / admin_decided_at / admin_note filled in.
--
-- DATA: no existing row is rewritten. Two tables gain three nullable columns each.
-- ROLLBACK: drop the three functions and the six columns.
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.

begin;

set local lock_timeout = '5s';

alter table public.phoenix_crm_unplanned_visits
  add column if not exists admin_decided_by_hr_id text,
  add column if not exists admin_decided_at timestamptz,
  add column if not exists admin_note text;

alter table public.phoenix_crm_list_requests
  add column if not exists admin_decided_by_hr_id text,
  add column if not exists admin_decided_at timestamptz,
  add column if not exists admin_note text;

-- ── A reopened week closes again ────────────────────────────────────────────────────────────────
create or replace function public.phoenix_crm_reverse_plan_edit_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_seat text;
  v_week date;
  v_request public.phoenix_crm_plan_edit_requests%rowtype;
  v_plan public.phoenix_crm_plans%rowtype;
  v_opened jsonb;
  v_before text;
  v_approval public.phoenix_crm_plan_events%rowtype;
begin
  if v_request_id is null or v_actor is null or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;

  select r.seat_id, r.week_start into v_seat, v_week from public.phoenix_crm_plan_edit_requests r where r.id = v_request_id;
  if not found then
    raise exception 'phoenix_crm:plan_edit_not_found';
  end if;

  -- The PLAN's lock, the same key every plan transition takes.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));

  select r.* into v_request from public.phoenix_crm_plan_edit_requests r where r.id = v_request_id for update;
  if v_request.is_test <> v_is_test then
    raise exception 'phoenix_crm:plan_edit_not_found';
  end if;
  if v_expected is distinct from v_request.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  if v_request.status <> 'reopened' then
    raise exception 'phoenix_crm:plan_edit_not_reopened';
  end if;

  -- What the reopening did to the plan, as its own event wrote it down.
  select e.details into v_opened
  from public.phoenix_crm_plan_edit_request_events e
  where e.request_id = v_request_id and e.to_status = 'reopened'
  order by e.id desc
  limit 1;
  v_before := v_opened ->> 'plan_status_before';

  select pl.* into v_plan from public.phoenix_crm_plans pl where pl.id = v_request.plan_id for update;

  -- Only a week that is still exactly the draft the reopening made, and still in its own week. Anything
  -- else (the rep changed it, sent it again, the week passed, it was only a returned day opened whole)
  -- cannot be put back without losing someone's work.
  if coalesce((v_opened ->> 'plan_reopened')::boolean, false) is not true
    or v_before not in ('submitted', 'approved')
    or v_plan.status <> 'draft'
    or v_plan.version is distinct from v_request.reopened_plan_version
    or v_request.week_start + 5 < v_today then
    raise exception 'phoenix_crm:plan_edit_cannot_reverse';
  end if;

  if v_before = 'approved' then
    -- The approval is put back as it was taken: who approved it, when, and what they wrote.
    select e.* into v_approval
    from public.phoenix_crm_plan_events e
    where e.plan_id = v_plan.id and e.event_type = 'approved' and e.created_at < v_request.decided_at
    order by e.id desc
    limit 1;
    if not found then
      raise exception 'phoenix_crm:plan_edit_cannot_reverse';
    end if;
    update public.phoenix_crm_plans pl
    set status = 'approved',
        decided_at = v_approval.created_at,
        decided_by_hr_id = v_approval.actor_hr_id,
        decided_by_role = v_approval.actor_role,
        decision_note = v_approval.note,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
    values (v_plan.id, 'approved', v_approval.actor_hr_id, v_approval.actor_role, 'draft', v_plan.status, v_plan.version, v_approval.note,
            jsonb_build_object('edit_request_id', v_request_id, 'restored_by', v_actor));
  else
    update public.phoenix_crm_plans pl
    set status = 'submitted',
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
    values (v_plan.id, 'submitted', v_actor, 'administrator', 'draft', v_plan.status, v_plan.version, null,
            jsonb_build_object('edit_request_id', v_request_id, 'restored_by', v_actor));
  end if;

  update public.phoenix_crm_plan_edit_requests r
  set status = 'refused',
      admin_decided_by_hr_id = v_actor,
      admin_decided_at = now(),
      admin_note = v_note,
      hr_acknowledged_at = null,
      reopened_plan_version = null,
      decided_at = now(),
      version = r.version + 1,
      updated_at = now()
  where r.id = v_request_id
  returning r.* into v_request;

  insert into public.phoenix_crm_plan_edit_request_events
    (request_id, event_type, actor_hr_id, actor_role, actor_stage, from_status, to_status, version, note, details)
  values
    (v_request_id, 'refused', v_actor, 'administrator', 'administrator', 'reopened', 'refused', v_request.version, v_note,
     jsonb_build_object('reversed', true, 'plan_restored_to', v_before));

  return jsonb_build_object(
    'request_id', v_request.id,
    'plan_id', v_request.plan_id,
    'seat_id', v_request.seat_id,
    'week_start', v_request.week_start,
    'rep_hr_id', v_request.rep_hr_id,
    'status', v_request.status,
    'version', v_request.version,
    'plan_version', v_plan.version
  );
end;
$$;

-- ── An approved off-plan visit stops counting ───────────────────────────────────────────────────
create or replace function public.phoenix_crm_reverse_unplanned_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_visit_id uuid := nullif(p ->> 'visit_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_row public.phoenix_crm_unplanned_visits%rowtype;
begin
  if v_visit_id is null or v_actor is null or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;
  if not exists (select 1 from public.phoenix_crm_unplanned_visits u where u.visit_id = v_visit_id) then
    raise exception 'phoenix_crm:unplanned_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:unplanned:' || v_visit_id::text));

  select u.* into v_row from public.phoenix_crm_unplanned_visits u where u.visit_id = v_visit_id for update;
  if v_row.is_test <> v_is_test then
    raise exception 'phoenix_crm:unplanned_not_found';
  end if;
  if v_expected is distinct from v_row.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  if v_row.status <> 'approved' then
    raise exception 'phoenix_crm:unplanned_not_approved';
  end if;

  update public.phoenix_crm_unplanned_visits u
  set status = 'refused',
      admin_decided_by_hr_id = v_actor,
      admin_decided_at = now(),
      admin_note = v_note,
      decided_at = now(),
      version = u.version + 1,
      updated_at = now()
  where u.visit_id = v_visit_id
  returning u.* into v_row;

  insert into public.phoenix_crm_unplanned_visit_events
    (visit_id, event_type, actor_hr_id, actor_role, actor_stage, from_status, to_status, version, note, details)
  values
    (v_visit_id, 'refused', v_actor, 'administrator', null, 'approved', 'refused', v_row.version, v_note,
     jsonb_build_object('reversed', true));

  return jsonb_build_object(
    'visit_id', v_row.visit_id,
    'seat_id', v_row.seat_id,
    'rep_hr_id', v_row.rep_hr_id,
    'customer_id', v_row.customer_id,
    'visit_date', v_row.visit_date,
    'status', v_row.status,
    'version', v_row.version
  );
end;
$$;

-- ── An approved list request is undone ──────────────────────────────────────────────────────────
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
    if v_customer.status <> 'active' then
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
    update public.phoenix_crm_customers c
    set status = case when c.validated_at is not null then 'active' else 'pending' end,
        dropped_reason = null,
        dropped_note = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer.id, v_request.id, 'customer_restored', v_actor, jsonb_build_object('why', 'drop_reversed'), v_is_test);

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

revoke execute on function public.phoenix_crm_reverse_plan_edit_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_reverse_plan_edit_request(jsonb) to service_role;
revoke execute on function public.phoenix_crm_reverse_unplanned_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_reverse_unplanned_visit(jsonb) to service_role;
revoke execute on function public.phoenix_crm_reverse_list_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_reverse_list_request(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
