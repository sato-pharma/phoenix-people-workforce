-- phoenix_crm_unplanned_visits
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_visits gains ONE column, is_unplanned, stamped by the server at save time from the
--      rep's own plan. It is not re-derivable later — the rep can edit or send his plan after the
--      visit — which is exactly why it is stamped rather than joined.
--   2. Two new tables carry the approval of an off-plan visit:
--        * phoenix_crm_unplanned_visits       — one row per unplanned visit: the rep's written
--                                               clarification and where the decision has got to.
--        * phoenix_crm_unplanned_visit_events — its append-only history (twin of
--                                               phoenix_crm_monthly_plan_events).
--   3. A view, phoenix_crm_countable_visits, is the ONE predicate for "does this visit count":
--      every visit that was on a sent plan, plus every off-plan visit that has been approved. All
--      four phoenix_crm_report_* functions are re-created to read it instead of the base table.
--   4. phoenix_crm_monthly_plans gains due_on and submitted_late: the plan is due on the last Thursday
--      of the month BEFORE the one it covers, and a late send is stamped, never blocked.
--   5. phoenix_crm_save_visit resolves is_unplanned, demands a clarification for an off-plan visit, and
--      raises the approval row; phoenix_crm_decide_unplanned_visit decides it.
--
-- WHY:
--   Owner, 2026-09-26. The rep chooses the kind of visit before he chooses the doctor: a PLANNED visit
--   offers only the doctors on today's plan, an UNPLANNED visit opens his whole list and asks him to
--   write why he went. An unplanned visit counts in NOTHING until it is approved — his direct manager
--   first, then the SFE. Unplanned is what replaces the old iReports360 "Campaign (Prospection)".
--   The monthly plan is due the last Thursday of the month before; he ruled that a late plan is
--   ACCEPTED and STAMPED, not refused.
--
-- THE ONE RULE THIS FILE EXISTS TO ENFORCE:
--   "planned" is NOT "the customer is on a plan row". The rep owns his own draft plan and today is an
--   editable day, so plan-row existence alone lets him place the doctor at the door, save thirty
--   seconds later, and never be unplanned — the approval would never happen and the feature would be
--   theatre. The test is: the plan had ALREADY GONE FOR REVIEW (a phoenix_crm_plan_events row reaching
--   'submitted' or 'approved') BEFORE this visit's server-issued captured_at. A draft plan and a
--   RETURNED plan are both still the rep's to edit, so neither is authority — which is deliberately
--   narrower than phoenix_crm_report_plan_vs_actual's sent_days, where the day is already past and a
--   returned plan was genuinely sent.
--
-- ROLLBACK:
--   begin;
--   drop function if exists public.phoenix_crm_decide_unplanned_visit(jsonb);
--   drop view if exists public.phoenix_crm_countable_visits;
--   drop table if exists public.phoenix_crm_unplanned_visit_events, public.phoenix_crm_unplanned_visits;  -- SAFE: new tables, no other reader
--   alter table public.phoenix_crm_visits drop column if exists is_unplanned;
--   alter table public.phoenix_crm_monthly_plans drop column if exists due_on, drop column if exists submitted_late;
--   -- then re-apply 20260925030047 (save_visit), 20260925165851 (monthly plan functions),
--   -- 20260922180258 (visits_by_day, plan_vs_actual, manager_visits) and 20260922233000 (coverage).
--   commit;
--   (Additive: every new column has a default and every existing row is correct without a backfill.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. Was this visit on a plan that had already gone for review? ────────────────────────────────
-- Stamped once, at save. `default false` makes every visit already on file correct with no backfill:
-- before today nothing was off-plan, because nothing could be.
alter table public.phoenix_crm_visits
  add column if not exists is_unplanned boolean not null default false;

comment on column public.phoenix_crm_visits.is_unplanned is
  'True when the customer was not on a plan that had reached review before captured_at. Stamped by '
  'phoenix_crm_save_visit from the plan''s own events, never sent by the phone. An unplanned visit '
  'counts in nothing until phoenix_crm_unplanned_visits says approved.';

-- Partial: the overwhelming majority of visits are planned and never touch this index.
create index if not exists phoenix_crm_visits_unplanned_idx
  on public.phoenix_crm_visits (seat_id, visit_date)
  where is_unplanned;

-- ── 2. The approval of an off-plan visit ─────────────────────────────────────────────────────────
-- Two stages in order (owner, 2026-09-26): the territory's own manager first, then the SFE Manager.
-- A refusal at either stage is terminal. A territory whose manager chain is vacant starts at the SFE
-- stage — the caller decides which, because only the application can read the organogram.
create table if not exists public.phoenix_crm_unplanned_visits (
  visit_id uuid primary key references public.phoenix_crm_visits (id),
  seat_id text not null,
  line_code text not null,
  -- The rep whose KPIs this visit is waiting on.
  rep_hr_id text not null,
  entered_by_hr_id text not null,
  customer_id uuid not null references public.phoenix_crm_customers (id),
  visit_date date not null,
  -- The rep's written "why I went". Mandatory at save; there is no draft state.
  clarification text not null,
  status text not null default 'manager_pending',
  manager_hr_id text,
  manager_decided_by_hr_id text,
  manager_decided_at timestamptz,
  manager_note text,
  sfe_decided_by_hr_id text,
  sfe_decided_at timestamptz,
  sfe_note text,
  decided_at timestamptz,
  version integer not null default 1,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_unplanned_visits_status
    check (status in ('manager_pending', 'sfe_pending', 'approved', 'refused')),
  constraint phoenix_crm_unplanned_visits_clarification
    check (char_length(clarification) between 10 and 500),
  constraint phoenix_crm_unplanned_visits_notes
    check ((manager_note is null or char_length(manager_note) <= 500) and (sfe_note is null or char_length(sfe_note) <= 500)),
  constraint phoenix_crm_unplanned_visits_settled
    check ((status in ('approved', 'refused')) = (decided_at is not null)),
  constraint phoenix_crm_unplanned_visits_version check (version >= 1)
);

create index if not exists phoenix_crm_unplanned_visits_queue_idx
  on public.phoenix_crm_unplanned_visits (seat_id, created_at)
  where status in ('manager_pending', 'sfe_pending');
create index if not exists phoenix_crm_unplanned_visits_rep_idx
  on public.phoenix_crm_unplanned_visits (rep_hr_id, visit_date);

create table if not exists public.phoenix_crm_unplanned_visit_events (
  id bigint generated always as identity primary key,
  visit_id uuid not null references public.phoenix_crm_unplanned_visits (visit_id),
  event_type text not null,
  actor_hr_id text not null,
  actor_role text,
  -- Which stage decided: the territory's own manager, or the SFE Manager.
  actor_stage text,
  from_status text,
  to_status text,
  version integer,
  note text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_unplanned_visit_events_type
    check (event_type in ('raised', 'approved', 'refused')),
  constraint phoenix_crm_unplanned_visit_events_stage
    check (actor_stage is null or actor_stage in ('manager', 'sfe')),
  constraint phoenix_crm_unplanned_visit_events_note
    check (note is null or char_length(note) <= 500)
);

create index if not exists phoenix_crm_unplanned_visit_events_visit_idx
  on public.phoenix_crm_unplanned_visit_events (visit_id, created_at);

-- ── 3. Service role only (the same four lines per table as every other module table) ─────────────
alter table public.phoenix_crm_unplanned_visits enable row level security;
create policy phoenix_crm_unplanned_visits_service_role
  on public.phoenix_crm_unplanned_visits for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_unplanned_visits from public, anon, authenticated;
grant all on table public.phoenix_crm_unplanned_visits to service_role;

alter table public.phoenix_crm_unplanned_visit_events enable row level security;
create policy phoenix_crm_unplanned_visit_events_service_role
  on public.phoenix_crm_unplanned_visit_events for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_unplanned_visit_events from public, anon, authenticated;
grant all on table public.phoenix_crm_unplanned_visit_events to service_role;

-- ── 4. The ONE predicate for "does this visit count" ─────────────────────────────────────────────
-- security_invoker so the view inherits the base table's row-level security instead of running as its
-- owner: without it the view would be a hole straight through the module's service-role-only rule.
create or replace view public.phoenix_crm_countable_visits
with (security_invoker = true) as
  select v.*
  from public.phoenix_crm_visits v
  left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
  where not v.is_unplanned or u.status = 'approved';

comment on view public.phoenix_crm_countable_visits is
  'Visits that count in a KPI: everything that was on a sent plan, plus an off-plan visit the manager '
  'and the SFE have approved. Every phoenix_crm_report_* function reads this, never phoenix_crm_visits. '
  'The anti-fraud path (phoenix_crm_location_integrity) deliberately does NOT — a visit waiting for a '
  'decision is exactly the one you most want judged.';

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

-- ── 5. The monthly plan's due date ───────────────────────────────────────────────────────────────
-- Owner, 2026-09-26: the month is due on the last Thursday of the month BEFORE it, and a late plan is
-- ACCEPTED and STAMPED — never refused, never blocked. Nothing here can stop a rep planning.
alter table public.phoenix_crm_monthly_plans
  add column if not exists due_on date,
  add column if not exists submitted_late boolean not null default false;

comment on column public.phoenix_crm_monthly_plans.due_on is
  'The last Thursday of the month before month_start. Stamped when the header is opened.';
comment on column public.phoenix_crm_monthly_plans.submitted_late is
  'The month was sent after due_on. Read from the SERVER clock at submit, never the phone''s.';

-- Every header already on file gets its due date, so the screens have one figure and not two rules.
update public.phoenix_crm_monthly_plans mp
set due_on = (mp.month_start - 1) - ((extract(isodow from (mp.month_start - 1))::integer - 4 + 7) % 7)
where mp.due_on is null;

-- ── 6. Opening a month header now stamps its due date ────────────────────────────────────────────
-- Carried over from 20260925165851 with one insertion: due_on on the insert.
create or replace function public.phoenix_crm_open_monthly_plan(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_month date := nullif(p ->> 'month_start', '')::date;
  v_due date;
  v_plan public.phoenix_crm_monthly_plans%rowtype;
begin
  if v_seat is null or v_line is null or v_actor is null or v_month is null
    or extract(day from v_month) <> 1 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- The last Thursday on or before the last day of the month before. isodow puts Thursday at 4.
  v_due := (v_month - 1) - ((extract(isodow from (v_month - 1))::integer - 4 + 7) % 7);

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:monthly:' || v_seat || ':' || v_month::text));

  select mp.* into v_plan
  from public.phoenix_crm_monthly_plans mp
  where mp.seat_id = v_seat and mp.month_start = v_month and mp.is_test = v_is_test
  for update;

  if not found then
    insert into public.phoenix_crm_monthly_plans (seat_id, line_code, month_start, status, version, created_by_hr_id, is_test, due_on)
    values (v_seat, v_line, v_month, 'draft', 1, v_actor, v_is_test, v_due)
    returning * into v_plan;

    insert into public.phoenix_crm_monthly_plan_events (monthly_plan_id, event_type, actor_hr_id, to_status, version)
    values (v_plan.id, 'created', v_actor, 'draft', 1);
  elsif v_plan.due_on is null then
    update public.phoenix_crm_monthly_plans mp set due_on = v_due where mp.id = v_plan.id returning mp.* into v_plan;
  end if;

  return jsonb_build_object(
    'monthly_plan_id', v_plan.id,
    'status', v_plan.status,
    'version', v_plan.version,
    'due_on', v_plan.due_on,
    'submitted_late', v_plan.submitted_late
  );
end;
$$;


-- ── 7. Sending a month stamps whether it was late ────────────────────────────────────────────────
-- Carried over from 20260925165851 with one insertion: submitted_late on the submit branch. Nothing
-- refuses a late send; the date is a fact on the row, not a gate.
create or replace function public.phoenix_crm_monthly_plan_transition(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_plan_id uuid := nullif(p ->> 'monthly_plan_id', '')::uuid;
  v_action text := coalesce(p ->> 'action', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_seat text;
  v_month date;
  v_month_end date;
  v_plan public.phoenix_crm_monthly_plans%rowtype;
  v_from text;
  v_event text;
  v_week_from text[];
  v_week_to text;
  v_late boolean;
begin
  if v_plan_id is null or v_actor is null or v_action not in ('submit', 'reopen', 'approve', 'return') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select mp.seat_id, mp.month_start into v_seat, v_month from public.phoenix_crm_monthly_plans mp where mp.id = v_plan_id;
  if not found then
    raise exception 'phoenix_crm:plan_not_found';
  end if;
  v_month_end := (v_month + interval '1 month' - interval '1 day')::date;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:monthly:' || v_seat || ':' || v_month::text));

  select mp.* into v_plan from public.phoenix_crm_monthly_plans mp where mp.id = v_plan_id for update;
  if v_plan.is_test <> v_is_test then
    raise exception 'phoenix_crm:plan_not_found';
  end if;
  if v_expected is distinct from v_plan.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  v_from := v_plan.status;
  if v_action <> 'approve' and v_month_end < v_today then
    raise exception 'phoenix_crm:month_passed';
  end if;

  if v_action = 'submit' then
    if v_from not in ('draft', 'returned') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if not exists (
      select 1
      from public.phoenix_crm_plans pl
      join public.phoenix_crm_plan_items i on i.plan_id = pl.id
      where pl.seat_id = v_seat and pl.is_test = v_is_test
        and date_trunc('month', pl.week_start)::date = v_month
    ) then
      raise exception 'phoenix_crm:empty_plan';
    end if;
    -- Late, from the server's own clock. A month with no due date on file (one opened before this
    -- migration and never reopened) is never called late.
    v_late := v_plan.due_on is not null and v_today > v_plan.due_on;
    update public.phoenix_crm_monthly_plans mp
    set status = 'submitted', submitted_at = now(), submitted_by_hr_id = v_actor, submitted_late = v_late,
        decided_at = null, decided_by_hr_id = null, decided_by_role = null, decision_note = null,
        version = mp.version + 1, updated_at = now()
    where mp.id = v_plan.id
    returning mp.* into v_plan;
    v_event := 'submitted';
    v_week_from := array['draft', 'returned'];
    v_week_to := 'submitted';

  elsif v_action = 'reopen' then
    if v_from not in ('submitted', 'approved') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    update public.phoenix_crm_monthly_plans mp
    set status = 'draft', decided_at = null, decided_by_hr_id = null, decided_by_role = null, decision_note = null,
        version = mp.version + 1, updated_at = now()
    where mp.id = v_plan.id
    returning mp.* into v_plan;
    v_event := 'reopened';
    v_week_from := array['submitted', 'approved'];
    v_week_to := 'draft';

  elsif v_action = 'approve' then
    if v_from <> 'submitted' then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    update public.phoenix_crm_monthly_plans mp
    set status = 'approved', decided_at = now(), decided_by_hr_id = v_actor, decided_by_role = v_role,
        decision_note = v_note, version = mp.version + 1, updated_at = now()
    where mp.id = v_plan.id
    returning mp.* into v_plan;
    v_event := 'approved';
    v_week_from := array['submitted'];
    v_week_to := 'approved';

  else
    if v_from not in ('submitted', 'approved') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if v_note is null then
      raise exception 'phoenix_crm:note_required';
    end if;
    update public.phoenix_crm_monthly_plans mp
    set status = 'returned', decided_at = now(), decided_by_hr_id = v_actor, decided_by_role = v_role,
        decision_note = v_note, version = mp.version + 1, updated_at = now()
    where mp.id = v_plan.id
    returning mp.* into v_plan;
    v_event := 'returned';
    v_week_from := array['submitted', 'approved'];
    v_week_to := 'returned';
  end if;

  -- Cascade the month's field-week plans and record each week's own event.
  with moved as (
    update public.phoenix_crm_plans pl
    set status = v_week_to,
        submitted_at = case when v_week_to = 'submitted' then now() else (case when v_week_to = 'draft' then null else pl.submitted_at end) end,
        submitted_by_hr_id = case when v_week_to = 'submitted' then v_actor else (case when v_week_to = 'draft' then null else pl.submitted_by_hr_id end) end,
        decided_at = case when v_week_to = 'approved' or v_week_to = 'returned' then now() else null end,
        decided_by_hr_id = case when v_week_to = 'approved' or v_week_to = 'returned' then v_actor else null end,
        decided_by_role = case when v_week_to = 'approved' or v_week_to = 'returned' then v_role else null end,
        decision_note = case when v_week_to = 'approved' or v_week_to = 'returned' then v_note else null end,
        version = pl.version + 1,
        updated_at = now()
    where pl.seat_id = v_seat and pl.is_test = v_is_test
      and date_trunc('month', pl.week_start)::date = v_month
      and pl.status = any (v_week_from)
      and (v_week_to <> 'submitted' or exists (select 1 from public.phoenix_crm_plan_items i where i.plan_id = pl.id))
    returning pl.id, pl.status, pl.version
  )
  insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, actor_role, to_status, version, note)
  select moved.id, v_event, v_actor, v_role, moved.status, moved.version, v_note from moved;

  insert into public.phoenix_crm_monthly_plan_events (monthly_plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note)
  values (v_plan.id, v_event, v_actor, v_role, v_from, v_plan.status, v_plan.version, v_note);

  return jsonb_build_object(
    'monthly_plan_id', v_plan.id,
    'seat_id', v_plan.seat_id,
    'line_code', v_plan.line_code,
    'month_start', v_plan.month_start,
    'status', v_plan.status,
    'version', v_plan.version,
    'due_on', v_plan.due_on,
    'submitted_late', v_plan.submitted_late
  );
end;
$$;


-- ── 8. The save, now stamping planned or unplanned ───────────────────────────────────────────────
-- Carried over from 20260925030047 mechanically. Four insertions: the locals, the sent-plan test after
-- the date is settled, is_unplanned on the insert, and the approval row.
create or replace function public.phoenix_crm_save_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_kind text := coalesce(p ->> 'kind', '');
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_senior text := upper(nullif(trim(coalesce(p ->> 'senior_hr_id', '')), ''));
  v_photo text := nullif(trim(coalesce(p ->> 'photo_path', '')), '');
  v_reuse boolean := coalesce((p ->> 'reuse_place_photo')::boolean, false);
  v_place_id uuid := nullif(p ->> 'place_id', '')::uuid;
  v_flag text := coalesce(p ->> 'location_flag', '');
  v_comment text := nullif(trim(coalesce(p ->> 'comment', '')), '');
  v_pharmacy text := nullif(trim(coalesce(p ->> 'pharmacy_name', '')), '');
  v_availability jsonb := coalesce(p -> 'product_availability', '{}'::jsonb);
  v_voice text := nullif(trim(coalesce(p ->> 'voice_note_path', '')), '');
  v_voice_seconds integer := nullif(p ->> 'voice_note_seconds', '')::integer;
  v_voice_bytes integer := nullif(p ->> 'voice_note_bytes', '')::integer;
  -- New: the rep's "why I went", and where his approval starts when he went off plan.
  v_clarification text := nullif(regexp_replace(trim(coalesce(p ->> 'unplanned_reason', '')), '\s+', ' ', 'g'), '');
  v_first_stage text := coalesce(p ->> 'unplanned_first_status', 'manager_pending');
  v_reviewer text := upper(nullif(trim(coalesce(p ->> 'reviewer_hr_id', '')), ''));
  v_on_sent_plan boolean;
  v_products text[];
  v_existing public.phoenix_crm_visits%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_captured_at timestamptz;
  v_date date;
begin
  if v_id is null or v_seat is null or v_line is null or v_actor is null or v_customer_id is null or v_photo is null
    or v_kind not in ('single', 'double', 'chain')
    or v_flag not in ('ok', 'far', 'weak_gps', 'no_place')
    or v_first_stage not in ('manager_pending', 'sfe_pending')
    or (v_pharmacy is not null and char_length(v_pharmacy) > 120) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if jsonb_typeof(v_availability) <> 'object' then
    v_availability := '{}'::jsonb;
  end if;
  if not (
    (v_kind = 'single' and v_senior is null and ((v_rep is null) <> (v_manager is null)))
    or (v_kind = 'double' and v_rep is not null and v_manager is not null and v_senior is null)
    or (v_kind = 'chain' and v_rep is not null and v_manager is not null and v_senior is not null)
  ) then
    raise exception 'phoenix_crm:bad_participants';
  end if;

  select array_agg(trim(e.value) order by e.ordinality)
  into v_products
  from jsonb_array_elements_text(coalesce(p -> 'products', '[]'::jsonb)) with ordinality as e (value, ordinality)
  where nullif(trim(e.value), '') is not null;
  if v_products is null or cardinality(v_products) > 12 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select v.* into v_existing from public.phoenix_crm_visits v where v.id = v_id;
  if not found then
    perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));
    -- A retry racing its own first attempt waits on the lock, then finds it here.
    select v.* into v_existing from public.phoenix_crm_visits v where v.id = v_id;
  end if;
  if found then
    if v_existing.seat_id <> v_seat or v_existing.entered_by_hr_id <> v_actor then
      raise exception 'phoenix_crm:id_conflict';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'visit_date', v_existing.visit_date,
      'captured_at', v_existing.captured_at,
      'customer_id', v_existing.customer_id,
      'is_unplanned', v_existing.is_unplanned,
      'duplicate', true
    );
  end if;

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id
    and c.seat_id = v_seat
    and c.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  -- A pending customer (carried over from iReports360, not validated yet) is a real, visitable
  -- customer, exactly as the list and the visit form treat him. Only a genuinely dropped customer
  -- is refused here, and 'phoenix_crm:customer_dropped' — "This customer has left the list." — is
  -- correct for that case.
  if v_customer.status not in ('active', 'pending') then
    raise exception 'phoenix_crm:customer_dropped';
  end if;
  if v_place_id is not null and not exists (
    select 1 from public.phoenix_crm_places pl where pl.id = v_place_id and pl.customer_id = v_customer.id
  ) then
    raise exception 'phoenix_crm:place_changed';
  end if;

  if v_reuse then
    select pl.captured_at into v_captured_at
    from public.phoenix_crm_places pl
    where pl.photo_path = v_photo
      and pl.customer_id = v_customer.id
      and pl.created_by_hr_id = v_actor
      and pl.is_test = v_is_test
      and pl.created_at > now() - interval '30 minutes';
    if not found then
      raise exception 'phoenix_crm:photo_not_issued';
    end if;
    if exists (select 1 from public.phoenix_crm_visits v where v.photo_path = v_photo) then
      raise exception 'phoenix_crm:photo_used';
    end if;
  else
    v_captured_at := public.phoenix_crm_take_photo(v_photo, v_actor, v_seat, 'visit', v_is_test);
  end if;

  v_date := (v_captured_at at time zone 'Africa/Cairo')::date;

  if exists (
    select 1
    from public.phoenix_crm_visits v
    where v.seat_id = v_seat
      and v.customer_id = v_customer.id
      and v.visit_date = v_date
      and v.is_test = v_is_test
  ) then
    raise exception 'phoenix_crm:already_visited';
  end if;

  -- WAS HE PLANNED? Not "is he on a plan row now" — the rep owns his own draft plan and today is an
  -- editable day, so that test would let him place the doctor at the door and never be unplanned.
  --
  -- And NOT "did this plan ever reach review", which is the same trap one step further in.
  -- phoenix_crm_plan_events is append-only: nothing deletes from it, so a Saturday 'submitted' row
  -- outlives every reopen and every return. An `exists` over those rows would let a rep standing at an
  -- unplanned door tap Reopen (his own seat, so it is allowed), add the doctor to today, and save —
  -- the Saturday event still satisfies it, no reason is asked, nobody is told, and it counts at once.
  -- The same looseness misfires with no misconduct at all: after a manager RETURNS a week, every visit
  -- to a customer on a plan row would read as planned for the rest of it.
  --
  -- So: the plan's status AS OF this visit's server-issued captured_at — the latest event wins, which
  -- is the shape phoenix_crm_report_plan_vs_actual's own sent_days uses, so the save and the report
  -- answer the same question. A draft or returned plan is the rep's to edit and is never authority.
  --
  -- A manager's own single visit (no rep on it) was never on anybody's plan by construction and
  -- belongs to nobody's call rate, so it is never raised for approval.
  v_on_sent_plan := v_rep is null or exists (
    select 1
    from public.phoenix_crm_plans pl
    join public.phoenix_crm_plan_items i on i.plan_id = pl.id
    where pl.seat_id = v_seat
      and pl.is_test = v_is_test
      and i.plan_date = v_date
      and i.customer_id = v_customer.id
      and (
        select e.to_status
        from public.phoenix_crm_plan_events e
        where e.plan_id = pl.id
          and e.to_status is not null
          and e.created_at <= v_captured_at
        order by e.created_at desc, e.id desc
        limit 1
      ) in ('submitted', 'approved')
  );

  if not v_on_sent_plan and (v_clarification is null or char_length(v_clarification) < 10 or char_length(v_clarification) > 500) then
    raise exception 'phoenix_crm:clarification_required';
  end if;

  -- The voice note, when there is one. Two things about this call are the point of the whole
  -- migration that introduced it. It happens AFTER v_date is settled, so nothing it does can reach the
  -- date. And phoenix_crm_take_voice returns VOID, where phoenix_crm_take_photo returns the issue time
  -- that becomes captured_at -- so there is no value here to assign to v_captured_at even by mistake.
  if v_voice is not null then
    perform public.phoenix_crm_take_voice(v_voice, v_actor, v_seat, v_is_test);
  end if;

  insert into public.phoenix_crm_visits (
    id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id,
    senior_hr_id, entered_by_hr_id, products, comment, pharmacy_name, product_availability, photo_path, lat, lon,
    accuracy_meters, place_id, distance_meters, location_flag, device_skew_minutes, is_test,
    voice_note_path, voice_note_seconds, voice_note_bytes, is_unplanned
  )
  values (
    v_id, v_seat, v_line, v_customer.id, v_customer.list_type, v_date, v_captured_at, v_kind, v_rep, v_manager,
    v_senior, v_actor, v_products, v_comment, v_pharmacy, v_availability, v_photo,
    (p ->> 'lat')::double precision,
    (p ->> 'lon')::double precision,
    (p ->> 'accuracy_meters')::numeric,
    v_place_id,
    (p ->> 'distance_meters')::integer,
    v_flag,
    (p ->> 'device_skew_minutes')::integer,
    v_is_test,
    v_voice, v_voice_seconds, v_voice_bytes, not v_on_sent_plan
  );

  if not v_on_sent_plan then
    insert into public.phoenix_crm_unplanned_visits (
      visit_id, seat_id, line_code, rep_hr_id, entered_by_hr_id, customer_id, visit_date,
      clarification, status, manager_hr_id, is_test
    )
    values (
      v_id, v_seat, v_line, coalesce(v_rep, v_actor), v_actor, v_customer.id, v_date,
      v_clarification, v_first_stage, v_reviewer, v_is_test
    );
    insert into public.phoenix_crm_unplanned_visit_events (visit_id, event_type, actor_hr_id, to_status, version, note)
    values (v_id, 'raised', v_actor, v_first_stage, 1, v_clarification);
  end if;

  return jsonb_build_object(
    'id', v_id,
    'visit_date', v_date,
    'captured_at', v_captured_at,
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'list_type', v_customer.list_type,
    'is_unplanned', not v_on_sent_plan,
    'duplicate', false
  );
end;
$$;


-- ── 9. Deciding an off-plan visit ────────────────────────────────────────────────────────────────
-- Two stages in order: the territory's manager, then the SFE. One refusal at either stage ends it.
-- Modelled on phoenix_crm_decide_request: the function never asks WHO the actor is — the application
-- does that (assertUnplannedVisitApprover) and passes the stage it proved.
--   p: visit_id, stage, decision, actor_hr_id, actor_role, note, expected_version, is_test
create or replace function public.phoenix_crm_decide_unplanned_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_visit_id uuid := nullif(p ->> 'visit_id', '')::uuid;
  v_stage text := coalesce(p ->> 'stage', '');
  v_decision text := coalesce(p ->> 'decision', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_row public.phoenix_crm_unplanned_visits%rowtype;
  v_from text;
  v_to text;
begin
  if v_visit_id is null or v_actor is null
    or v_stage not in ('manager', 'sfe')
    or v_decision not in ('approve', 'refuse')
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_decision = 'refuse' and v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;

  if not exists (select 1 from public.phoenix_crm_unplanned_visits u where u.visit_id = v_visit_id) then
    raise exception 'phoenix_crm:unplanned_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:unplanned:' || v_visit_id::text));

  select u.* into v_row from public.phoenix_crm_unplanned_visits u where u.visit_id = v_visit_id for update;
  -- A test/real mix-up must read as "not there", never as a permission error.
  if v_row.is_test <> v_is_test then
    raise exception 'phoenix_crm:unplanned_not_found';
  end if;
  if v_expected is distinct from v_row.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  v_from := v_row.status;
  if v_from not in ('manager_pending', 'sfe_pending') then
    raise exception 'phoenix_crm:unplanned_decided';
  end if;
  -- The stages run in order: the SFE cannot sign off a visit the manager has not seen, and the
  -- manager cannot decide one that has already left him.
  if (v_stage = 'manager') <> (v_from = 'manager_pending') then
    raise exception 'phoenix_crm:unplanned_wrong_stage';
  end if;

  if v_decision = 'refuse' then
    v_to := 'refused';
  elsif v_from = 'manager_pending' then
    v_to := 'sfe_pending';
  else
    v_to := 'approved';
  end if;

  update public.phoenix_crm_unplanned_visits u
  set status = v_to,
      manager_decided_by_hr_id = case when v_stage = 'manager' then v_actor else u.manager_decided_by_hr_id end,
      manager_decided_at = case when v_stage = 'manager' then now() else u.manager_decided_at end,
      manager_note = case when v_stage = 'manager' then v_note else u.manager_note end,
      sfe_decided_by_hr_id = case when v_stage = 'sfe' then v_actor else u.sfe_decided_by_hr_id end,
      sfe_decided_at = case when v_stage = 'sfe' then now() else u.sfe_decided_at end,
      sfe_note = case when v_stage = 'sfe' then v_note else u.sfe_note end,
      decided_at = case when v_to in ('approved', 'refused') then now() else null end,
      version = u.version + 1,
      updated_at = now()
  where u.visit_id = v_visit_id
  returning u.* into v_row;

  insert into public.phoenix_crm_unplanned_visit_events
    (visit_id, event_type, actor_hr_id, actor_role, actor_stage, from_status, to_status, version, note)
  values
    (v_visit_id, case when v_decision = 'refuse' then 'refused' else 'approved' end,
     v_actor, v_role, v_stage, v_from, v_to, v_row.version, v_note);

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

revoke execute on function public.phoenix_crm_decide_unplanned_visit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_unplanned_visit(jsonb) to service_role;

-- ── 10. Every report now counts through the view ─────────────────────────────────────────────────
-- Carried over unchanged except for the source table, and — where a number would otherwise just dip
-- with no explanation — a count of the off-plan visits still waiting for a decision.

create or replace function public.phoenix_crm_report_visits_by_day(
  p_seat_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with counted as (
    select
      v.seat_id,
      v.rep_hr_id,
      v.visit_date,
      v.list_type,
      count(*)::integer as visits,
      (count(*) filter (where v.kind = 'double'))::integer as double_visits,
      (count(*) filter (where v.kind = 'chain'))::integer as chain_visits,
      (count(*) filter (where v.location_flag = 'far'))::integer as far_visits,
      (count(*) filter (where v.is_test))::integer as test_visits
    -- The countable view, never the base table: an off-plan visit counts in nothing until the manager
    -- and then the SFE have approved it.
    from public.phoenix_crm_countable_visits v
    -- A visit counts only once its customer is validated; then every earlier one counts too.
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    group by v.seat_id, v.rep_hr_id, v.visit_date, v.list_type
  ),
  -- Beside the count, not inside it: a day whose figure is low because three visits are waiting for a
  -- decision must say so, or the dip reads as a rep who did not work.
  waiting as (
    select v.seat_id, v.rep_hr_id, v.visit_date, v.list_type, count(*)::integer as unplanned_waiting
    from public.phoenix_crm_visits v
    join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id and u.status in ('manager_pending', 'sfe_pending')
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    group by v.seat_id, v.rep_hr_id, v.visit_date, v.list_type
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.seat_id, t.visit_date, t.list_type, t.rep_hr_id), '[]'::jsonb)
  from (
    select
      coalesce(c.seat_id, w.seat_id) as seat_id,
      coalesce(c.rep_hr_id, w.rep_hr_id) as rep_hr_id,
      coalesce(c.visit_date, w.visit_date) as visit_date,
      coalesce(c.list_type, w.list_type) as list_type,
      coalesce(c.visits, 0) as visits,
      coalesce(c.double_visits, 0) as double_visits,
      coalesce(c.chain_visits, 0) as chain_visits,
      coalesce(c.far_visits, 0) as far_visits,
      coalesce(c.test_visits, 0) as test_visits,
      coalesce(w.unplanned_waiting, 0) as unplanned_waiting
    from counted c
    full join waiting w
      on w.seat_id = c.seat_id
     and w.visit_date = c.visit_date
     and w.list_type = c.list_type
     and w.rep_hr_id is not distinct from c.rep_hr_id
  ) t;
$$;


create or replace function public.phoenix_crm_report_plan_vs_actual(
  p_seat_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with plan_days as (
    select distinct pl.id as plan_id, i.plan_date
    from public.phoenix_crm_plans pl
    join public.phoenix_crm_plan_items i on i.plan_id = pl.id
    where pl.seat_id = any (p_seat_ids)
      and pl.week_start between p_from - 6 and p_to
      and i.plan_date between p_from and p_to
      and (p_include_test or not pl.is_test)
  ),
  sent_days as (
    select d.plan_id, d.plan_date
    from plan_days d
    where (
        select e.to_status
        from public.phoenix_crm_plan_events e
        where e.plan_id = d.plan_id
          and e.to_status is not null
          and e.created_at < ((d.plan_date + 1)::timestamp at time zone 'Africa/Cairo')
        order by e.created_at desc, e.id desc
        limit 1
      ) in ('submitted', 'approved', 'returned')
  ),
  planned as (
    select pl.seat_id, pl.is_test, i.plan_date, i.customer_id, i.list_type
    from sent_days s
    join public.phoenix_crm_plans pl on pl.id = s.plan_id
    join public.phoenix_crm_plan_items i on i.plan_id = s.plan_id and i.plan_date = s.plan_date
    -- The DENOMINATOR: planning a customer who is not validated yet is never held against the rep.
    join public.phoenix_crm_customers c on c.id = i.customer_id and c.validated_at is not null
  ),
  -- The base table on purpose, not the countable view: this report's job is to SHOW the manager the
  -- off-plan work, and a visit that has vanished from it cannot be approved by anyone. What the
  -- decision changes is the two columns beside it.
  visited as (
    select v.seat_id, v.is_test, v.visit_date, v.customer_id, v.list_type, v.is_unplanned, u.status as unplanned_status
    from public.phoenix_crm_visits v
    -- The NUMERATOR: the same filter, so both sides move together.
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
  ),
  joined as (
    select
      coalesce(pd.seat_id, vd.seat_id) as seat_id,
      coalesce(pd.plan_date, vd.visit_date) as day,
      coalesce(pd.list_type, vd.list_type) as list_type,
      pd.customer_id is not null as is_planned,
      vd.customer_id is not null as is_visited,
      coalesce(vd.is_unplanned, false) as is_unplanned,
      vd.unplanned_status
    from planned pd
    full join visited vd
      on vd.seat_id = pd.seat_id
     and vd.is_test = pd.is_test
     and vd.visit_date = pd.plan_date
     and vd.customer_id = pd.customer_id
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.seat_id, t.day, t.list_type), '[]'::jsonb)
  from (
    select
      j.seat_id,
      j.day,
      j.list_type,
      (count(*) filter (where j.is_planned))::integer as planned,
      -- A visit the rep did not plan is not a plan he kept, however the plan was edited afterwards.
      (count(*) filter (where j.is_planned and j.is_visited and not j.is_unplanned))::integer as visited_planned,
      -- Beside it, never silently a miss: he was there, and it is waiting on somebody.
      (count(*) filter (where j.is_planned and j.is_visited and j.is_unplanned and j.unplanned_status in ('manager_pending', 'sfe_pending')))::integer as planned_waiting,
      (count(*) filter (where j.is_planned and not j.is_visited))::integer as missed,
      (count(*) filter (where j.is_visited and not j.is_planned))::integer as unplanned,
      (count(*) filter (where j.is_visited and not j.is_planned and j.unplanned_status in ('manager_pending', 'sfe_pending')))::integer as unplanned_waiting,
      (count(*) filter (where j.is_visited and not j.is_planned and j.unplanned_status = 'refused'))::integer as unplanned_refused
    from joined j
    group by j.seat_id, j.day, j.list_type
  ) t;
$$;


create or replace function public.phoenix_crm_report_manager_visits(
  p_hr_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with people as (
    select distinct upper(trim(x.hr_id)) as hr_id
    from unnest(p_hr_ids) as x (hr_id)
    where nullif(trim(x.hr_id), '') is not null
  ),
  joined as (
    select pe.hr_id, 'manager'::text as role_on_visit, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits v on v.manager_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and v.kind in ('double', 'chain')
      and (p_include_test or not v.is_test)
    union all
    select pe.hr_id, 'senior'::text, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_countable_visits v on v.senior_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.hr_id, t.visit_date, t.seat_id), '[]'::jsonb)
  from (
    select
      j.hr_id,
      j.role_on_visit,
      j.visit_date,
      j.seat_id,
      j.rep_hr_id,
      (count(*) filter (where j.kind = 'double'))::integer as double_visits,
      (count(*) filter (where j.kind = 'chain'))::integer as chain_visits,
      (count(*) filter (where j.list_type = 'AM'))::integer as am_visits,
      (count(*) filter (where j.list_type = 'PM'))::integer as pm_visits
    from joined j
    group by j.hr_id, j.role_on_visit, j.visit_date, j.seat_id, j.rep_hr_id
  ) t;
$$;


create or replace function public.phoenix_crm_report_coverage(
  p_seat_ids text[],
  p_month_start date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with bounds as (
    select
      date_trunc('month', p_month_start::timestamp)::date as month_start,
      (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as next_month
  ),
  targets as (
    select s.grade_targets from public.phoenix_crm_settings s where s.id = 1
  ),
  listed as (
    select c.id, c.seat_id, c.list_type, c.grade
    from public.phoenix_crm_customers c
    cross join bounds b
    where c.seat_id = any (p_seat_ids)
      and (p_include_test or not c.is_test)
      and c.validated_at is not null
      and (c.status = 'active' or c.status_changed_at >= (b.month_start::timestamp at time zone 'Africa/Cairo'))
  ),
  month_visits as (
    select v.customer_id, count(*)::integer as visits
    from public.phoenix_crm_countable_visits v
    cross join bounds b
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.seat_id = any (p_seat_ids)
      and v.visit_date >= b.month_start
      and v.visit_date < b.next_month
      and (p_include_test or not v.is_test)
    group by v.customer_id
  ),
  scored as (
    select
      l.seat_id,
      l.list_type,
      coalesce(mv.visits, 0) as visits,
      case when l.grade is null then null else nullif(t.grade_targets -> l.list_type ->> l.grade, '')::integer end as target
    from listed l
    left join targets t on true
    left join month_visits mv on mv.customer_id = l.id
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.seat_id, r.list_type), '[]'::jsonb)
  from (
    select
      s.seat_id,
      s.list_type,
      count(*)::integer as customers,
      (count(*) filter (where s.visits > 0))::integer as covered,
      (count(*) filter (where s.target is not null))::integer as with_target,
      (count(*) filter (where s.target is not null and s.visits = s.target))::integer as on_target,
      (count(*) filter (where s.target is not null and s.visits < s.target))::integer as under,
      (count(*) filter (where s.target is not null and s.visits > s.target))::integer as over,
      coalesce(sum(s.visits), 0)::integer as visits
    from scored s
    group by s.seat_id, s.list_type
  ) r;
$$;


notify pgrst, 'reload schema';

commit;

-- Before you push, the rules that fail the required `validate` job:
--   * a public SECURITY DEFINER function must
--       revoke execute on function public.<fn>(<args>) from public, anon, authenticated;
--     and then re-grant what needs it (revoking PUBLIC also strips service_role).
--   * never  alter default privileges ... in schema public grant ... to anon|authenticated
--   * a snapshot table goes in <domain>_backup_YYYYMMDD, never in public
--   * DROP TABLE / TRUNCATE wants a  -- SAFE: <reason>  annotation
-- Timestamp 20260926163000 was minted to sort after every migration already on main.
