-- phoenix_crm_monthly_plans
--
-- WHAT THIS CHANGES:
--   Adds the monthly plan that sits above the existing Phoenix CRM weekly plan. A rep now lays out one
--   month of dated visits; the field weeks of that month are its derived weekly plans. Two new tables:
--     * phoenix_crm_monthly_plans        — one header per (seat, month), status draft|submitted|
--                                          approved|returned, mirroring the weekly plan header.
--     * phoenix_crm_monthly_plan_events  — the header's append-only history (twin of
--                                          phoenix_crm_plan_events).
--   And two new SECURITY DEFINER functions:
--     * phoenix_crm_open_monthly_plan(p)       — ensures the header exists, returns it.
--     * phoenix_crm_monthly_plan_transition(p) — submit / reopen / approve / return at the MONTH grain,
--                                          cascading the month's field-week plans (found by date, no FK)
--                                          to the same status and writing each week its own event.
--   The month owns the field weeks whose Saturday (week_start) falls in that calendar month, resolved
--   with date_trunc('month', week_start) — one month per week, no double-count and nothing to migrate.
--   NOTHING existing is altered: the shipped phoenix_crm_save_plan / phoenix_crm_plan_transition build
--   and edit the days and carry the per-week re-approval after the month is approved, unchanged.
--
-- WHY:
--   Owner, 2026-09-25: the weekly plan is no longer authored on its own — the rep makes one monthly
--   plan by exact days and his weekly plans appear from it; the district manager approves the month
--   once, and a later edit to a single week needs another approval (which the existing weekly
--   transition already provides). Over a doctor's grade norm is allowed and shown as a deviation
--   (derived on read, never stored, never blocked).
--
-- ROLLBACK:
--   begin;
--   drop function if exists public.phoenix_crm_monthly_plan_transition(jsonb);
--   drop function if exists public.phoenix_crm_open_monthly_plan(jsonb);
--   drop table if exists public.phoenix_crm_monthly_plan_events, public.phoenix_crm_monthly_plans;  -- SAFE: new tables, no other reader
--   commit;
--   (Additive only: no existing table, column, function, row or grant is changed, so applying this
--   cannot lose data and the rollback fully reverses it.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. The monthly plan header ─────────────────────────────────────────────────────────────────────
create table if not exists public.phoenix_crm_monthly_plans (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  line_code text not null,
  -- The first day of the calendar month the plan covers.
  month_start date not null,
  status text not null default 'draft',
  version integer not null default 1,
  submitted_at timestamptz,
  submitted_by_hr_id text,
  decided_at timestamptz,
  decided_by_hr_id text,
  decided_by_role text,
  decision_note text,
  created_by_hr_id text not null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_monthly_plans_first_of_month check (extract(day from month_start) = 1),
  constraint phoenix_crm_monthly_plans_status check (status in ('draft', 'submitted', 'approved', 'returned')),
  constraint phoenix_crm_monthly_plans_version check (version >= 1),
  constraint phoenix_crm_monthly_plans_decision_note check (decision_note is null or char_length(decision_note) <= 500),
  constraint phoenix_crm_monthly_plans_seat_month_uniq unique (seat_id, month_start, is_test)
);

create index if not exists phoenix_crm_monthly_plans_review_idx on public.phoenix_crm_monthly_plans (status, month_start);
create index if not exists phoenix_crm_monthly_plans_month_idx on public.phoenix_crm_monthly_plans (month_start, is_test);

-- ── 2. The header's history ─────────────────────────────────────────────────────────────────────────
create table if not exists public.phoenix_crm_monthly_plan_events (
  id bigint generated always as identity primary key,
  monthly_plan_id uuid not null references public.phoenix_crm_monthly_plans (id),
  event_type text not null,
  actor_hr_id text not null,
  actor_role text,
  from_status text,
  to_status text,
  version integer,
  note text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_monthly_plan_events_type check (event_type in ('created', 'submitted', 'reopened', 'approved', 'returned'))
);

create index if not exists phoenix_crm_monthly_plan_events_plan_idx on public.phoenix_crm_monthly_plan_events (monthly_plan_id, created_at);

-- ── 3. Service role only (same guarantee as every other Phoenix CRM table) ───────────────────────────
-- The same four lines per table that tests/phoenix-crm-boundary.test.ts holds every module table to,
-- so no table is locked by accident and none is left open to anon or authenticated.
alter table public.phoenix_crm_monthly_plans enable row level security;
create policy phoenix_crm_monthly_plans_service_role
  on public.phoenix_crm_monthly_plans for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_monthly_plans from public, anon, authenticated;
grant all on table public.phoenix_crm_monthly_plans to service_role;

alter table public.phoenix_crm_monthly_plan_events enable row level security;
create policy phoenix_crm_monthly_plan_events_service_role
  on public.phoenix_crm_monthly_plan_events for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_monthly_plan_events from public, anon, authenticated;
grant all on table public.phoenix_crm_monthly_plan_events to service_role;

-- ── 4. Open (ensure) a month header ──────────────────────────────────────────────────────────────────
-- Returns the header for (seat, month), creating a draft the first time. The field-week plans are found
-- by date, so there is nothing else to create here.
--   p: seat_id, line_code, month_start, actor_hr_id, is_test
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
  v_plan public.phoenix_crm_monthly_plans%rowtype;
begin
  if v_seat is null or v_line is null or v_actor is null or v_month is null
    or extract(day from v_month) <> 1 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:monthly:' || v_seat || ':' || v_month::text));

  select mp.* into v_plan
  from public.phoenix_crm_monthly_plans mp
  where mp.seat_id = v_seat and mp.month_start = v_month and mp.is_test = v_is_test
  for update;

  if not found then
    insert into public.phoenix_crm_monthly_plans (seat_id, line_code, month_start, status, version, created_by_hr_id, is_test)
    values (v_seat, v_line, v_month, 'draft', 1, v_actor, v_is_test)
    returning * into v_plan;

    insert into public.phoenix_crm_monthly_plan_events (monthly_plan_id, event_type, actor_hr_id, to_status, version)
    values (v_plan.id, 'created', v_actor, 'draft', 1);
  end if;

  return jsonb_build_object('monthly_plan_id', v_plan.id, 'status', v_plan.status, 'version', v_plan.version);
end;
$$;

-- ── 5. Month transition, cascading the month's field weeks ───────────────────────────────────────────
-- submit (rep: draft/returned → submitted) · reopen (rep: submitted/approved → draft) ·
-- approve (reviewer: submitted → approved) · return (reviewer or SFE: submitted/approved → returned,
-- with a note). The month's field-week plans (same seat, same is_test, week_start in this month) are
-- moved with the header, and each writes its own phoenix_crm_plan_events row so the weekly history is
-- honest. Once the month is over its plan can no longer be sent, reopened or returned; a late approval
-- still records. Editing a single week after the month is approved goes through the existing weekly
-- phoenix_crm_plan_transition and leaves the month approved.
--   p: monthly_plan_id, action, actor_hr_id, actor_role, is_test, expected_version, note
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
    update public.phoenix_crm_monthly_plans mp
    set status = 'submitted', submitted_at = now(), submitted_by_hr_id = v_actor,
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
    'from_status', v_from,
    'version', v_plan.version,
    'submitted_by_hr_id', v_plan.submitted_by_hr_id,
    'created_by_hr_id', v_plan.created_by_hr_id,
    'is_test', v_plan.is_test
  );
end;
$$;

revoke execute on function public.phoenix_crm_open_monthly_plan(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_monthly_plan_transition(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_open_monthly_plan(jsonb) to service_role;
grant execute on function public.phoenix_crm_monthly_plan_transition(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;

-- Before you push, the rules that fail the required `validate` job:
--   * a public SECURITY DEFINER function must
--       revoke execute on function public.<fn>(<args>) from public, anon, authenticated;
--     and then re-grant what needs it (revoking PUBLIC also strips service_role).
--   * never  alter default privileges ... in schema public grant ... to anon|authenticated
--   * a snapshot table goes in <domain>_backup_YYYYMMDD, never in public
--   * DROP TABLE / TRUNCATE wants a  -- SAFE: <reason>  annotation
-- Timestamp 20260925165851 was minted to sort after every migration already on main.
