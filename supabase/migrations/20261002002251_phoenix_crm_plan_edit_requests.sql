-- phoenix_crm_plan_edit_requests
--
-- WHAT THIS CHANGES (owner rulings, 2026-10-01, after the first Delta (1) session on the plan board):
--   1. A rep plans ONE week — the week that begins on the coming Saturday — and a week he has SENT is
--      no longer taken back by him. He asks to edit it instead, and the request runs: the territory's
--      district manager APPROVES, then the SFE Manager APPROVES, then HR (Omar Gawish, B-10)
--      ACKNOWLEDGES — and only that acknowledgement reopens the week. Any refusal ends it.
--        phoenix_crm_plan_edit_requests          one row per request, the three steps' decisions on it
--        phoenix_crm_plan_edit_request_events    raised / approved / refused / acknowledged / expired
--        phoenix_crm_raise_plan_edit_request     the rep's one button
--        phoenix_crm_decide_plan_edit_request    each step's decision; HR's acknowledgement reopens the
--                                                week (draft) and writes the plan's 'reopened' event
--   2. phoenix_crm_week_due_on: when a week is due, in ONE place — the Thursday before it, except a
--      week the owner moved by hand. The week of 3 October 2026 is due Friday 2 October: the Delta
--      reps sent it on Thursday in the old screen, it was wiped, and they send it again on Friday —
--      on time, by his ruling. calendar.ts PLAN_WEEK_DUE_OVERRIDES holds the same table.
--   3. phoenix_crm_plan_transition is replaced with its live body (20260929235555) and two changes in
--      the SUBMIT branch only: due_on / submitted_late read phoenix_crm_week_due_on, and a week sent
--      again after an acknowledged edit KEEPS its first send's late verdict — the rep sent it on time
--      once, and a change his managers agreed to must not stamp him late. Everything else is the live
--      text: the Cairo day, the week_passed check before any action, one plan-event insert.
--
-- WHY: on 1 October the board opened on September, four of fourteen reps pressed "Send the month"
--   (stamped late, the month being due 24 September), and one planned a week that had passed. The
--   rule is now one week at a time, enforced by the server; this file carries the half that lives in
--   the database — the edit request and the due date.
--
-- ROLLBACK:
--   re-apply phoenix_crm_plan_transition from 20260929235555; then
--   drop function public.phoenix_crm_decide_plan_edit_request(jsonb);
--   drop function public.phoenix_crm_raise_plan_edit_request(jsonb);
--   drop function public.phoenix_crm_week_due_on(date);
--   drop table public.phoenix_crm_plan_edit_request_events; drop table public.phoenix_crm_plan_edit_requests;
--   (the tables only while nothing in them is wanted — a reopened week's 'reopened' plan event names
--   its request in details and stays valid without it).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. The request to edit a sent week ───────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_plan_edit_requests (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.phoenix_crm_plans (id),
  seat_id text not null,
  line_code text not null,
  week_start date not null,
  -- The rep who asked. No reason is asked of him (owner, 2026-10-01: "no, just the button").
  rep_hr_id text not null,
  status text not null,
  -- The territory's reviewing manager when the request was raised; null when the chain was vacant
  -- and the request started at SFE.
  manager_hr_id text,
  plan_status_at_raise text not null,
  manager_decided_by_hr_id text,
  manager_decided_at timestamptz,
  manager_note text,
  sfe_decided_by_hr_id text,
  sfe_decided_at timestamptz,
  sfe_note text,
  hr_acknowledged_by_hr_id text,
  hr_acknowledged_at timestamptz,
  -- The plan's version once the acknowledgement reopened it.
  reopened_plan_version integer,
  decided_at timestamptz,
  version integer not null default 1,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_plan_edit_requests_status
    check (status in ('manager_pending', 'sfe_pending', 'hr_pending', 'reopened', 'refused', 'expired')),
  constraint phoenix_crm_plan_edit_requests_settled
    check ((status in ('reopened', 'refused', 'expired')) = (decided_at is not null)),
  constraint phoenix_crm_plan_edit_requests_saturday check (extract(isodow from week_start) = 6),
  constraint phoenix_crm_plan_edit_requests_raised_from check (plan_status_at_raise in ('submitted', 'approved')),
  constraint phoenix_crm_plan_edit_requests_notes
    check ((manager_note is null or char_length(manager_note) <= 500) and (sfe_note is null or char_length(sfe_note) <= 500)),
  constraint phoenix_crm_plan_edit_requests_version check (version >= 1)
);

-- One request at a time per week: a second press while one is on its way is refused, never queued.
create unique index if not exists phoenix_crm_plan_edit_requests_open_uniq
  on public.phoenix_crm_plan_edit_requests (plan_id)
  where status in ('manager_pending', 'sfe_pending', 'hr_pending');
create index if not exists phoenix_crm_plan_edit_requests_queue_idx
  on public.phoenix_crm_plan_edit_requests (seat_id, created_at)
  where status in ('manager_pending', 'sfe_pending', 'hr_pending');
create index if not exists phoenix_crm_plan_edit_requests_plan_idx
  on public.phoenix_crm_plan_edit_requests (plan_id, created_at);

create table if not exists public.phoenix_crm_plan_edit_request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.phoenix_crm_plan_edit_requests (id),
  event_type text not null,
  actor_hr_id text not null,
  actor_role text,
  actor_stage text,
  from_status text,
  to_status text,
  version integer,
  note text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_plan_edit_request_events_type
    check (event_type in ('raised', 'approved', 'refused', 'acknowledged', 'expired')),
  constraint phoenix_crm_plan_edit_request_events_stage
    check (actor_stage is null or actor_stage in ('manager', 'sfe', 'hr')),
  constraint phoenix_crm_plan_edit_request_events_note
    check (note is null or char_length(note) <= 500)
);

create index if not exists phoenix_crm_plan_edit_request_events_request_idx
  on public.phoenix_crm_plan_edit_request_events (request_id, created_at);

-- ── 2. Service role only (the same four lines per table as every other module table) ─────────────
alter table public.phoenix_crm_plan_edit_requests enable row level security;
create policy phoenix_crm_plan_edit_requests_service_role
  on public.phoenix_crm_plan_edit_requests for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_plan_edit_requests from public, anon, authenticated;
grant all on table public.phoenix_crm_plan_edit_requests to service_role;

alter table public.phoenix_crm_plan_edit_request_events enable row level security;
create policy phoenix_crm_plan_edit_request_events_service_role
  on public.phoenix_crm_plan_edit_request_events for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_plan_edit_request_events from public, anon, authenticated;
grant all on table public.phoenix_crm_plan_edit_request_events to service_role;

-- ── 3. When a week is due, in one place ──────────────────────────────────────────────────────────

create or replace function public.phoenix_crm_week_due_on(p_week_start date)
returns date
language sql
immutable
security definer
set search_path to 'public'
as $$
  select case p_week_start
    -- Owner, 2026-10-02: the Delta reps' week of 3 October, sent again on Friday after the wipe, is on time.
    when date '2026-10-03' then date '2026-10-02'
    else p_week_start - 2
  end;
$$;

revoke execute on function public.phoenix_crm_week_due_on(date) from public, anon, authenticated;
grant execute on function public.phoenix_crm_week_due_on(date) to service_role;

-- ── 4. The weekly transition: the live body, with the due date read from one place ───────────────

create or replace function public.phoenix_crm_plan_transition(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_plan_id uuid := nullif(p ->> 'plan_id', '')::uuid;
  v_action text := coalesce(p ->> 'action', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_seat text;
  v_week date;
  v_plan public.phoenix_crm_plans%rowtype;
  v_from text;
  v_event text;
begin
  if v_plan_id is null or v_actor is null or v_action not in ('submit', 'reopen', 'approve', 'return') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select pl.seat_id, pl.week_start into v_seat, v_week from public.phoenix_crm_plans pl where pl.id = v_plan_id;
  if not found then
    raise exception 'phoenix_crm:plan_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));

  select pl.* into v_plan from public.phoenix_crm_plans pl where pl.id = v_plan_id for update;
  if v_plan.is_test <> v_is_test then
    raise exception 'phoenix_crm:plan_not_found';
  end if;
  if v_expected is distinct from v_plan.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  v_from := v_plan.status;
  if v_action <> 'approve' and v_plan.week_start + 5 < v_today then
    raise exception 'phoenix_crm:week_passed';
  end if;

  if v_action = 'submit' then
    if v_from not in ('draft', 'returned') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if not exists (select 1 from public.phoenix_crm_plan_items i where i.plan_id = v_plan.id) then
      raise exception 'phoenix_crm:empty_plan';
    end if;
    -- Sent on its own, the week is judged against its own due date — from the server's clock, and
    -- accepted whenever it arrives (owner, 2026-09-29). A week sent AGAIN after an acknowledged edit
    -- keeps the verdict its first send earned (owner, 2026-10-01): the change was agreed by his
    -- manager, SFE and HR, and must not read as lateness.
    update public.phoenix_crm_plans pl
    set status = 'submitted',
        submitted_at = now(),
        submitted_by_hr_id = v_actor,
        due_on = public.phoenix_crm_week_due_on(pl.week_start),
        submitted_late = case
          when exists (
            select 1 from public.phoenix_crm_plan_edit_requests r where r.plan_id = pl.id and r.status = 'reopened'
          ) then pl.submitted_late
          else v_today > public.phoenix_crm_week_due_on(pl.week_start)
        end,
        submitted_via = 'week',
        decided_at = null,
        decided_by_hr_id = null,
        decided_by_role = null,
        decision_note = null,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'submitted';

  elsif v_action = 'reopen' then
    if v_from not in ('submitted', 'approved') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    update public.phoenix_crm_plans pl
    set status = 'draft',
        decided_at = null,
        decided_by_hr_id = null,
        decided_by_role = null,
        decision_note = null,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'reopened';

  elsif v_action = 'approve' then
    if v_from <> 'submitted' then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    update public.phoenix_crm_plans pl
    set status = 'approved',
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_by_role = v_role,
        decision_note = v_note,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'approved';

  else
    if v_from not in ('submitted', 'approved') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if v_note is null then
      raise exception 'phoenix_crm:note_required';
    end if;
    update public.phoenix_crm_plans pl
    set status = 'returned',
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_by_role = v_role,
        decision_note = v_note,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'returned';
  end if;

  insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note)
  values (v_plan.id, v_event, v_actor, v_role, v_from, v_plan.status, v_plan.version, v_note);

  return jsonb_build_object(
    'plan_id', v_plan.id,
    'seat_id', v_plan.seat_id,
    'line_code', v_plan.line_code,
    'week_start', v_plan.week_start,
    'status', v_plan.status,
    'from_status', v_from,
    'version', v_plan.version,
    'submitted_by_hr_id', v_plan.submitted_by_hr_id,
    'created_by_hr_id', v_plan.created_by_hr_id,
    'is_test', v_plan.is_test,
    'due_on', v_plan.due_on,
    'submitted_late', v_plan.submitted_late,
    'submitted_via', v_plan.submitted_via
  );
end;
$$;

revoke execute on function public.phoenix_crm_plan_transition(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_plan_transition(jsonb) to service_role;

-- ── 5. The rep's one button: ask to edit a sent week ─────────────────────────────────────────────

create or replace function public.phoenix_crm_raise_plan_edit_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_plan_id uuid := nullif(p ->> 'plan_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_first text := coalesce(p ->> 'first_status', '');
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_expected integer := nullif(p ->> 'expected_plan_version', '')::integer;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_seat text;
  v_week date;
  v_plan public.phoenix_crm_plans%rowtype;
  v_request public.phoenix_crm_plan_edit_requests%rowtype;
begin
  if v_plan_id is null or v_actor is null or v_first not in ('manager_pending', 'sfe_pending') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A request that starts with the manager names him; one that starts at SFE names nobody.
  if (v_first = 'manager_pending') <> (v_manager is not null) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select pl.seat_id, pl.week_start into v_seat, v_week from public.phoenix_crm_plans pl where pl.id = v_plan_id;
  if not found then
    raise exception 'phoenix_crm:plan_not_found';
  end if;

  -- The plan's own lock, so a request and a send, a decision or a save of the same week never cross.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));

  select pl.* into v_plan from public.phoenix_crm_plans pl where pl.id = v_plan_id for update;
  if v_plan.is_test <> v_is_test then
    raise exception 'phoenix_crm:plan_not_found';
  end if;
  if v_expected is distinct from v_plan.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  if v_plan.week_start + 5 < v_today then
    raise exception 'phoenix_crm:week_passed';
  end if;
  if v_plan.status not in ('submitted', 'approved') then
    raise exception 'phoenix_crm:plan_edit_not_sent';
  end if;
  if exists (
    select 1 from public.phoenix_crm_plan_edit_requests r
    where r.plan_id = v_plan.id and r.status in ('manager_pending', 'sfe_pending', 'hr_pending')
  ) then
    raise exception 'phoenix_crm:plan_edit_already_open';
  end if;

  insert into public.phoenix_crm_plan_edit_requests
    (plan_id, seat_id, line_code, week_start, rep_hr_id, status, manager_hr_id, plan_status_at_raise, is_test)
  values
    (v_plan.id, v_plan.seat_id, v_plan.line_code, v_plan.week_start, v_actor, v_first,
     case when v_first = 'manager_pending' then v_manager else null end, v_plan.status, v_plan.is_test)
  returning * into v_request;

  insert into public.phoenix_crm_plan_edit_request_events
    (request_id, event_type, actor_hr_id, actor_role, actor_stage, from_status, to_status, version, details)
  values
    (v_request.id, 'raised', v_actor, 'rep', null, null, v_request.status, v_request.version,
     jsonb_build_object('plan_id', v_plan.id, 'plan_status', v_plan.status, 'plan_version', v_plan.version));

  return jsonb_build_object(
    'request_id', v_request.id,
    'plan_id', v_request.plan_id,
    'seat_id', v_request.seat_id,
    'week_start', v_request.week_start,
    'rep_hr_id', v_request.rep_hr_id,
    'status', v_request.status,
    'version', v_request.version
  );
end;
$$;

revoke execute on function public.phoenix_crm_raise_plan_edit_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_raise_plan_edit_request(jsonb) to service_role;

-- ── 6. Each step's decision; HR's acknowledgement reopens the week ───────────────────────────────
-- The function never asks WHO the actor is — the application does that (access.ts
-- canDecidePlanEdit) and passes the stage it proved. What it does check is that the stage is the one
-- the row is waiting on, so no step can be skipped and none taken twice.

create or replace function public.phoenix_crm_decide_plan_edit_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_stage text := coalesce(p ->> 'stage', '');
  v_decision text := coalesce(p ->> 'decision', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_seat text;
  v_week date;
  v_request public.phoenix_crm_plan_edit_requests%rowtype;
  v_plan public.phoenix_crm_plans%rowtype;
  v_from text;
  v_to text;
  v_event text;
  v_plan_from text;
  v_reopened boolean := false;
begin
  if v_request_id is null or v_actor is null
    or v_stage not in ('manager', 'sfe', 'hr')
    or (v_stage = 'hr' and v_decision <> 'acknowledge')
    or (v_stage <> 'hr' and v_decision not in ('approve', 'refuse'))
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_decision = 'refuse' and v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;

  select r.seat_id, r.week_start into v_seat, v_week from public.phoenix_crm_plan_edit_requests r where r.id = v_request_id;
  if not found then
    raise exception 'phoenix_crm:plan_edit_not_found';
  end if;

  -- The PLAN's lock, the same key every plan transition takes: an acknowledgement reopens the plan,
  -- so it must queue behind a send or a manager's decision on that week, never cross one.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));

  select r.* into v_request from public.phoenix_crm_plan_edit_requests r where r.id = v_request_id for update;
  -- A test/real mix-up must read as "not there", never as a permission error.
  if v_request.is_test <> v_is_test then
    raise exception 'phoenix_crm:plan_edit_not_found';
  end if;
  if v_expected is distinct from v_request.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  v_from := v_request.status;
  if v_from not in ('manager_pending', 'sfe_pending', 'hr_pending') then
    raise exception 'phoenix_crm:plan_edit_decided';
  end if;
  -- The steps run in order: SFE cannot sign off a request the manager has not seen, and HR cannot
  -- acknowledge one SFE has not approved.
  if (v_stage = 'manager' and v_from <> 'manager_pending')
    or (v_stage = 'sfe' and v_from <> 'sfe_pending')
    or (v_stage = 'hr' and v_from <> 'hr_pending') then
    raise exception 'phoenix_crm:plan_edit_wrong_stage';
  end if;

  -- A week that is over has nothing left to change. The request is closed as expired and that is
  -- WRITTEN — no exception, so the transaction commits and the queue stops showing it.
  if v_request.week_start + 5 < v_today then
    update public.phoenix_crm_plan_edit_requests r
    set status = 'expired', decided_at = now(), version = r.version + 1, updated_at = now()
    where r.id = v_request_id
    returning r.* into v_request;
    insert into public.phoenix_crm_plan_edit_request_events
      (request_id, event_type, actor_hr_id, actor_role, actor_stage, from_status, to_status, version, note)
    values
      (v_request_id, 'expired', v_actor, v_role, v_stage, v_from, 'expired', v_request.version, null);
    return jsonb_build_object(
      'request_id', v_request.id,
      'plan_id', v_request.plan_id,
      'seat_id', v_request.seat_id,
      'week_start', v_request.week_start,
      'rep_hr_id', v_request.rep_hr_id,
      'status', v_request.status,
      'version', v_request.version,
      'plan_version', null
    );
  end if;

  if v_decision = 'refuse' then
    v_to := 'refused';
    v_event := 'refused';
  elsif v_stage = 'manager' then
    v_to := 'sfe_pending';
    v_event := 'approved';
  elsif v_stage = 'sfe' then
    v_to := 'hr_pending';
    v_event := 'approved';
  else
    v_to := 'reopened';
    v_event := 'acknowledged';
    select pl.* into v_plan from public.phoenix_crm_plans pl where pl.id = v_request.plan_id for update;
    v_plan_from := v_plan.status;
    -- Reopened exactly as the rep's own take-back used to reopen it. A week a manager RETURNED in the
    -- meantime is already his to change, so it is left as it stands.
    if v_plan_from in ('submitted', 'approved') then
      update public.phoenix_crm_plans pl
      set status = 'draft',
          decided_at = null,
          decided_by_hr_id = null,
          decided_by_role = null,
          decision_note = null,
          version = pl.version + 1,
          updated_at = now()
      where pl.id = v_plan.id
      returning pl.* into v_plan;
      insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
      values (v_plan.id, 'reopened', v_actor, 'hr', v_plan_from, v_plan.status, v_plan.version, null,
              jsonb_build_object('edit_request_id', v_request_id));
      v_reopened := true;
    end if;
  end if;

  update public.phoenix_crm_plan_edit_requests r
  set status = v_to,
      manager_decided_by_hr_id = case when v_stage = 'manager' then v_actor else r.manager_decided_by_hr_id end,
      manager_decided_at = case when v_stage = 'manager' then now() else r.manager_decided_at end,
      manager_note = case when v_stage = 'manager' then v_note else r.manager_note end,
      sfe_decided_by_hr_id = case when v_stage = 'sfe' then v_actor else r.sfe_decided_by_hr_id end,
      sfe_decided_at = case when v_stage = 'sfe' then now() else r.sfe_decided_at end,
      sfe_note = case when v_stage = 'sfe' then v_note else r.sfe_note end,
      hr_acknowledged_by_hr_id = case when v_stage = 'hr' then v_actor else r.hr_acknowledged_by_hr_id end,
      hr_acknowledged_at = case when v_stage = 'hr' then now() else r.hr_acknowledged_at end,
      reopened_plan_version = case when v_stage = 'hr' then v_plan.version else r.reopened_plan_version end,
      decided_at = case when v_to in ('reopened', 'refused') then now() else null end,
      version = r.version + 1,
      updated_at = now()
  where r.id = v_request_id
  returning r.* into v_request;

  insert into public.phoenix_crm_plan_edit_request_events
    (request_id, event_type, actor_hr_id, actor_role, actor_stage, from_status, to_status, version, note, details)
  values
    (v_request_id, v_event, v_actor, v_role, v_stage, v_from, v_to, v_request.version, v_note,
     case when v_stage = 'hr' then jsonb_build_object('plan_reopened', v_reopened, 'plan_status_before', v_plan_from)
          else '{}'::jsonb end);

  return jsonb_build_object(
    'request_id', v_request.id,
    'plan_id', v_request.plan_id,
    'seat_id', v_request.seat_id,
    'week_start', v_request.week_start,
    'rep_hr_id', v_request.rep_hr_id,
    'status', v_request.status,
    'version', v_request.version,
    'plan_version', v_request.reopened_plan_version
  );
end;
$$;

revoke execute on function public.phoenix_crm_decide_plan_edit_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_plan_edit_request(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
