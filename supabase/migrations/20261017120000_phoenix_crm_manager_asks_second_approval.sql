-- phoenix_crm_manager_asks_second_approval
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_manager_plan_edit_requests (a district manager's ask to reopen a sent week) gains a
--      second approver and the first approver's decision: second_approver_hr_id, first_decided_at,
--      first_decided_by_hr_id, first_decided_role, first_decision_note, and a status 'first_approved' —
--      the regional manager agreed, and the ask now waits on the national sales manager above him. The
--      one-open-ask-per-week index now covers both open statuses.
--   2. phoenix_crm_manager_customers (Manager's own list) gains the same for an ask to take a customer
--      off it: removal_second_approver_hr_id, removal_first_decided_at, removal_first_decided_by_hr_id,
--      removal_first_decided_role, removal_first_decision_note, and a status 'removal_first_approved'.
--   3. phoenix_crm_manager_plan_events takes one more event, 'edit_first_approved'.
--   4. Five functions, replaced: phoenix_crm_raise_manager_plan_edit and
--      phoenix_crm_request_manager_customer_removal store the second approver the application names;
--      phoenix_crm_decide_manager_plan_edit and phoenix_crm_decide_manager_customer_removal decide one
--      STAGE at a time; phoenix_crm_expire_manager_plan_edit_requests closes an ask at either open stage.
--
-- WHY (owner, 2026-10-17):
--   "if regional manager applicable then after the rm approve the nsm also must approve never skip" —
--   and, asked which approvals that covers, "Week + edit asks + removals". A district manager's week
--   already goes from his regional manager on to the national sales manager above him
--   (phoenix_crm_manager_plans.second_approver_hr_id, 20261017000000). His ask to reopen a sent week and
--   his ask to take a customer off his own list were decided by the regional manager ALONE; now, when a
--   second approver is stored on the ask, the regional manager's approval passes it on and only the
--   national sales manager's approval reopens the week or removes the customer. A refusal at either
--   step closes the ask. The Administrator may act in place of either holder, as for the week.
--
--   🔴 THE STAGE NEVER DEPENDS ON WHO DECIDES. An ask closes at the first approval only when no second
--   approver was stored on it — the same rule the week's own transition keeps — so the Administrator
--   acting for the regional manager still passes it on.
--
--   🔴 THE CODE RUNNING BEFORE THIS DEPLOYS KEEPS WORKING UNCHANGED. It names no second approver, so every
--   ask it raises is one stage, as before; it sends no stage, so the decide functions read the stage off
--   the ask's own status. No existing row changes: every table touched held 0 rows on production and on
--   staging when this was written (17 Oct 2026, ~11:30 Cairo).
--
--   The application proves who acts and passes the approvers in, as every Phoenix CRM function does
--   (managerPlanApprovers: after a regional manager, the national sales manager above his seat; an empty
--   national seat passes the step to the CEO).
--
-- ROLLBACK:
--   re-apply the five function bodies from 20261017000000_phoenix_crm_manager_plan.sql; then
--   drop index if exists public.phoenix_crm_manager_plan_edit_requests_second_idx;
--   drop index if exists public.phoenix_crm_manager_customers_second_removal_idx;
--   drop index if exists public.phoenix_crm_manager_plan_edit_requests_open_uniq;
--   create unique index phoenix_crm_manager_plan_edit_requests_open_uniq
--     on public.phoenix_crm_manager_plan_edit_requests (plan_id) where status = 'pending';
--   restore the four CHECKs below from 20261017000000 (status, role, decided on the edit requests; status
--   and removal on the own list; the events type), after any 'first_approved' / 'removal_first_approved'
--   / 'edit_first_approved' row is closed or deleted; then drop the ten columns added here.
--   DATA COST: the first approver's decision on any ask still waiting on its second approver.
--
-- Verification after apply:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid in ('public.phoenix_crm_manager_plan_edit_requests'::regclass, 'public.phoenix_crm_manager_customers'::regclass)
--      and contype = 'c' order by 1;                                                         -- the new definitions
--   select proname, prosecdef from pg_proc where proname in ('phoenix_crm_raise_manager_plan_edit',
--     'phoenix_crm_decide_manager_plan_edit', 'phoenix_crm_expire_manager_plan_edit_requests',
--     'phoenix_crm_request_manager_customer_removal', 'phoenix_crm_decide_manager_customer_removal');  -- 5 rows, all t
--   select has_function_privilege('anon', 'public.phoenix_crm_decide_manager_plan_edit(jsonb)', 'execute');      -- f
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration adds ten nullable columns to two empty tables, widens four CHECKs and one partial index,
-- adds two indexes, and replaces five function bodies; no existing row is touched.

begin;
set local lock_timeout = '5s';

-- ── 1. His ask to reopen a sent week: a second step ────────────────────────────────────────────

alter table public.phoenix_crm_manager_plan_edit_requests
  add column if not exists second_approver_hr_id text,
  add column if not exists first_decided_at timestamptz,
  add column if not exists first_decided_by_hr_id text,
  add column if not exists first_decided_role text,
  add column if not exists first_decision_note text;

alter table public.phoenix_crm_manager_plan_edit_requests
  drop constraint if exists phoenix_crm_manager_plan_edit_requests_status,
  drop constraint if exists phoenix_crm_manager_plan_edit_requests_role,
  drop constraint if exists phoenix_crm_manager_plan_edit_requests_decided,
  drop constraint if exists phoenix_crm_manager_plan_edit_requests_first_step,
  drop constraint if exists phoenix_crm_manager_plan_edit_requests_second_upper;

alter table public.phoenix_crm_manager_plan_edit_requests
  add constraint phoenix_crm_manager_plan_edit_requests_status
    check (status in ('pending', 'first_approved', 'reopened', 'refused', 'expired')),
  add constraint phoenix_crm_manager_plan_edit_requests_role
    check (decided_role is null or decided_role in ('first', 'second', 'administrator', 'system')),
  -- Open (waiting on the first OR the second approver) exactly while it carries no final decision.
  add constraint phoenix_crm_manager_plan_edit_requests_decided
    check ((status in ('pending', 'first_approved')) = (decided_at is null)),
  add constraint phoenix_crm_manager_plan_edit_requests_first_step check (
    (status <> 'first_approved' or (second_approver_hr_id is not null and first_decided_at is not null))
    and ((first_decided_at is null) = (first_decided_by_hr_id is null))
    and ((first_decided_at is null) = (first_decided_role is null))
    and (first_decided_role is null or first_decided_role in ('first', 'administrator'))
    and (first_decision_note is null or char_length(first_decision_note) <= 500)
  ),
  add constraint phoenix_crm_manager_plan_edit_requests_second_upper check (
    (second_approver_hr_id is null or second_approver_hr_id = upper(second_approver_hr_id))
    and (first_decided_by_hr_id is null or first_decided_by_hr_id = upper(first_decided_by_hr_id))
  );

-- One ask open per week, at either of its two steps.
drop index if exists public.phoenix_crm_manager_plan_edit_requests_open_uniq;
create unique index if not exists phoenix_crm_manager_plan_edit_requests_open_uniq
  on public.phoenix_crm_manager_plan_edit_requests (plan_id) where status in ('pending', 'first_approved');
create index if not exists phoenix_crm_manager_plan_edit_requests_second_idx
  on public.phoenix_crm_manager_plan_edit_requests (second_approver_hr_id, status, is_test);

-- ── 2. His ask to take a customer off his own list: a second step ──────────────────────────────

alter table public.phoenix_crm_manager_customers
  add column if not exists removal_second_approver_hr_id text,
  add column if not exists removal_first_decided_at timestamptz,
  add column if not exists removal_first_decided_by_hr_id text,
  add column if not exists removal_first_decided_role text,
  add column if not exists removal_first_decision_note text;

alter table public.phoenix_crm_manager_customers
  drop constraint if exists phoenix_crm_manager_customers_status,
  drop constraint if exists phoenix_crm_manager_customers_removal,
  drop constraint if exists phoenix_crm_manager_customers_second_upper;

alter table public.phoenix_crm_manager_customers
  add constraint phoenix_crm_manager_customers_status
    check (status in ('active', 'removal_pending', 'removal_first_approved', 'removed')),
  add constraint phoenix_crm_manager_customers_removal check (
    (status = 'active' or (removal_reason is not null and removal_requested_at is not null and removal_approver_hr_id is not null))
    and (status <> 'removed' or removal_decided_at is not null)
    and (status <> 'removal_first_approved' or (removal_second_approver_hr_id is not null and removal_first_decided_at is not null))
    and ((removal_first_decided_at is null) = (removal_first_decided_by_hr_id is null))
    and ((removal_first_decided_at is null) = (removal_first_decided_role is null))
    and (removal_reason is null or char_length(removal_reason) <= 500)
    and (removal_decision_note is null or char_length(removal_decision_note) <= 500)
    and (removal_first_decision_note is null or char_length(removal_first_decision_note) <= 500)
    and (removal_decided_role is null or removal_decided_role in ('first', 'second', 'administrator'))
    and (removal_first_decided_role is null or removal_first_decided_role in ('first', 'administrator'))
  ),
  add constraint phoenix_crm_manager_customers_second_upper check (
    (removal_second_approver_hr_id is null or removal_second_approver_hr_id = upper(removal_second_approver_hr_id))
    and (removal_first_decided_by_hr_id is null or removal_first_decided_by_hr_id = upper(removal_first_decided_by_hr_id))
  );

create index if not exists phoenix_crm_manager_customers_second_removal_idx
  on public.phoenix_crm_manager_customers (removal_second_approver_hr_id, status, is_test);

-- ── 3. The trail: the regional manager's agreement to reopen ───────────────────────────────────

alter table public.phoenix_crm_manager_plan_events
  drop constraint if exists phoenix_crm_manager_plan_events_type;
alter table public.phoenix_crm_manager_plan_events
  add constraint phoenix_crm_manager_plan_events_type check (
    event_type in ('created', 'submitted', 'first_approved', 'approved', 'returned', 'edit_asked', 'edit_first_approved', 'reopened', 'edit_refused', 'edit_expired')
  );

-- ── 4. Raise his ask to reopen a sent week ─────────────────────────────────────────────────────
--
-- p: plan_id, actor_hr_id, approver_hr_id, second_approver_hr_id (null: one step), reason, is_test
create or replace function public.phoenix_crm_raise_manager_plan_edit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_plan_id uuid := nullif(p ->> 'plan_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_approver text := upper(nullif(trim(coalesce(p ->> 'approver_hr_id', '')), ''));
  v_second text := upper(nullif(trim(coalesce(p ->> 'second_approver_hr_id', '')), ''));
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_manager text;
  v_week date;
  v_plan public.phoenix_crm_manager_plans%rowtype;
  v_request public.phoenix_crm_manager_plan_edit_requests%rowtype;
begin
  if v_plan_id is null or v_actor is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:note_required';
  end if;
  if v_approver is null then
    raise exception 'phoenix_crm:manager_plan_no_approver';
  end if;
  if v_second is not null and v_second = v_approver then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select pl.manager_hr_id, pl.week_start into v_manager, v_week
  from public.phoenix_crm_manager_plans pl where pl.id = v_plan_id;
  if not found then
    raise exception 'phoenix_crm:manager_plan_not_found';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  select pl.* into v_plan from public.phoenix_crm_manager_plans pl where pl.id = v_plan_id for update;
  if v_plan.is_test <> v_is_test then
    raise exception 'phoenix_crm:manager_plan_not_found';
  end if;
  if v_approver = v_plan.manager_hr_id or v_second = v_plan.manager_hr_id then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_plan.status not in ('submitted', 'first_approved', 'approved') then
    raise exception 'phoenix_crm:bad_transition';
  end if;
  if v_plan.week_start + 5 < v_today then
    raise exception 'phoenix_crm:week_passed';
  end if;
  if exists (
    select 1 from public.phoenix_crm_manager_plan_edit_requests r
    where r.plan_id = v_plan.id and r.status in ('pending', 'first_approved')
  ) then
    raise exception 'phoenix_crm:manager_plan_edit_already_open';
  end if;

  insert into public.phoenix_crm_manager_plan_edit_requests
    (plan_id, manager_hr_id, week_start, approver_hr_id, second_approver_hr_id, reason, status, plan_status_at_raise, is_test)
  values
    (v_plan.id, v_plan.manager_hr_id, v_plan.week_start, v_approver, v_second, v_reason, 'pending', v_plan.status, v_plan.is_test)
  returning * into v_request;

  insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
  values (v_plan.id, 'edit_asked', v_actor, case when v_actor = v_plan.manager_hr_id then 'manager' else 'administrator' end,
          v_plan.status, v_plan.status, v_plan.version, v_reason, jsonb_build_object('request_id', v_request.id));

  return jsonb_build_object(
    'request_id', v_request.id,
    'plan_id', v_plan.id,
    'manager_hr_id', v_plan.manager_hr_id,
    'week_start', v_plan.week_start,
    'approver_hr_id', v_request.approver_hr_id,
    'second_approver_hr_id', v_request.second_approver_hr_id,
    'status', v_request.status,
    'version', v_request.version,
    'is_test', v_request.is_test
  );
end;
$$;

-- ── 5. Decide one step of his ask: reopen (or pass it on) or refuse ────────────────────────────
--
-- p: request_id, decision ('reopen' | 'refuse'), actor_hr_id, actor_role ('first' | 'second' |
--    'administrator'), stage ('first' | 'second'; absent: read off the ask's own status), note (required
--    to refuse), expected_version (the request's), is_test
create or replace function public.phoenix_crm_decide_manager_plan_edit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_decision text := coalesce(p ->> 'decision', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_stage text := nullif(trim(coalesce(p ->> 'stage', '')), '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_manager text;
  v_week date;
  v_plan_id uuid;
  v_request public.phoenix_crm_manager_plan_edit_requests%rowtype;
  v_plan public.phoenix_crm_manager_plans%rowtype;
  v_from text;
begin
  if v_request_id is null or v_actor is null or v_decision not in ('reopen', 'refuse')
     or v_role is null or v_role not in ('first', 'second', 'administrator')
     or (v_stage is not null and v_stage not in ('first', 'second')) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.manager_hr_id, r.week_start, r.plan_id into v_manager, v_week, v_plan_id
  from public.phoenix_crm_manager_plan_edit_requests r where r.id = v_request_id;
  if not found then
    raise exception 'phoenix_crm:manager_plan_edit_not_found';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  select r.* into v_request from public.phoenix_crm_manager_plan_edit_requests r where r.id = v_request_id for update;
  select pl.* into v_plan from public.phoenix_crm_manager_plans pl where pl.id = v_plan_id for update;
  if v_request.is_test <> v_is_test or v_plan.is_test <> v_is_test then
    raise exception 'phoenix_crm:manager_plan_edit_not_found';
  end if;
  if v_expected is distinct from v_request.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  -- The step is the ask's own: a caller that names none (the code running before this migration) decides
  -- the step the ask is waiting on.
  v_stage := coalesce(v_stage, case when v_request.status = 'first_approved' then 'second' else 'first' end);
  if (v_role = 'first' and v_stage <> 'first') or (v_role = 'second' and v_stage <> 'second') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if (v_stage = 'first' and v_request.status <> 'pending')
     or (v_stage = 'second' and (v_request.status <> 'first_approved' or v_request.second_approver_hr_id is null)) then
    raise exception 'phoenix_crm:manager_plan_edit_decided';
  end if;
  if v_plan.week_start + 5 < v_today then
    raise exception 'phoenix_crm:week_passed';
  end if;

  if v_decision = 'refuse' then
    if v_note is null then
      raise exception 'phoenix_crm:note_required';
    end if;
    update public.phoenix_crm_manager_plan_edit_requests r
    set status = 'refused',
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_role = v_role,
        decision_note = v_note,
        version = r.version + 1,
        updated_at = now()
    where r.id = v_request.id
    returning r.* into v_request;
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
    values (v_plan.id, 'edit_refused', v_actor, v_role, v_plan.status, v_plan.status, v_plan.version, v_note,
            jsonb_build_object('request_id', v_request.id, 'stage', v_stage));
  elsif v_stage = 'first' and v_request.second_approver_hr_id is not null then
    -- The regional manager agrees: the ask passes on to the national sales manager above him. The week
    -- is NOT reopened until that second approval — whoever decided this first step.
    if v_plan.status not in ('submitted', 'first_approved', 'approved') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    update public.phoenix_crm_manager_plan_edit_requests r
    set status = 'first_approved',
        first_decided_at = now(),
        first_decided_by_hr_id = v_actor,
        first_decided_role = v_role,
        first_decision_note = v_note,
        version = r.version + 1,
        updated_at = now()
    where r.id = v_request.id
    returning r.* into v_request;
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
    values (v_plan.id, 'edit_first_approved', v_actor, v_role, v_plan.status, v_plan.status, v_plan.version, v_note,
            jsonb_build_object('request_id', v_request.id));
  else
    if v_plan.status not in ('submitted', 'first_approved', 'approved') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    v_from := v_plan.status;
    update public.phoenix_crm_manager_plans pl
    set status = 'draft',
        returned_day = null,
        returned_stage = null,
        first_decided_at = null,
        first_decided_by_hr_id = null,
        first_decided_role = null,
        first_decision_note = null,
        decided_at = null,
        decided_by_hr_id = null,
        decided_by_role = null,
        decision_note = null,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    update public.phoenix_crm_manager_plan_edit_requests r
    set status = 'reopened',
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_role = v_role,
        decision_note = v_note,
        reopened_plan_version = v_plan.version,
        version = r.version + 1,
        updated_at = now()
    where r.id = v_request.id
    returning r.* into v_request;
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
    values (v_plan.id, 'reopened', v_actor, v_role, v_from, 'draft', v_plan.version, v_note,
            jsonb_build_object('request_id', v_request.id));
  end if;

  return jsonb_build_object(
    'request_id', v_request.id,
    'plan_id', v_plan.id,
    'manager_hr_id', v_plan.manager_hr_id,
    'week_start', v_plan.week_start,
    'status', v_request.status,
    'stage', v_stage,
    'second_approver_hr_id', v_request.second_approver_hr_id,
    'version', v_request.version,
    'plan_status', v_plan.status,
    'plan_version', v_plan.version,
    'is_test', v_request.is_test
  );
end;
$$;

-- ── 6. An ask nobody finished deciding before its week ended ───────────────────────────────────
--
-- p: unused (the module's one calling shape). It picks its rows itself, in this transaction.
create or replace function public.phoenix_crm_expire_manager_plan_edit_requests(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_expired jsonb;
begin
  with expired as (
    update public.phoenix_crm_manager_plan_edit_requests r
    set status = 'expired',
        decided_at = now(),
        decided_by_hr_id = null,
        decided_role = 'system',
        version = r.version + 1,
        updated_at = now()
    where r.status in ('pending', 'first_approved')
      and r.week_start + 5 < v_today
    returning r.*
  ), trail as (
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, details)
    select e.plan_id, 'edit_expired', 'SYSTEM', 'system', pl.status, pl.status, pl.version, jsonb_build_object('request_id', e.id)
    from expired e
    join public.phoenix_crm_manager_plans pl on pl.id = e.plan_id
    returning 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'request_id', e.id, 'plan_id', e.plan_id, 'manager_hr_id', e.manager_hr_id,
           'approver_hr_id', e.approver_hr_id, 'week_start', e.week_start, 'is_test', e.is_test)), '[]'::jsonb)
  into v_expired
  from expired e;
  -- A data-modifying WITH runs to completion whether or not the outer query reads it, so the trail is
  -- written for every row the update expired.
  return jsonb_build_object('expired', v_expired);
end;
$$;

-- ── 7. His ask to take a customer off his own list ─────────────────────────────────────────────
--
-- p: manager_customer_id, actor_hr_id, approver_hr_id, second_approver_hr_id (null: one step), reason, is_test
create or replace function public.phoenix_crm_request_manager_customer_removal(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'manager_customer_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_approver text := upper(nullif(trim(coalesce(p ->> 'approver_hr_id', '')), ''));
  v_second text := upper(nullif(trim(coalesce(p ->> 'second_approver_hr_id', '')), ''));
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_row public.phoenix_crm_manager_customers%rowtype;
begin
  if v_id is null or v_actor is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:note_required';
  end if;
  if v_approver is null then
    raise exception 'phoenix_crm:manager_plan_no_approver';
  end if;
  if v_second is not null and v_second = v_approver then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select m.* into v_row from public.phoenix_crm_manager_customers m where m.id = v_id for update;
  if not found or v_row.is_test <> v_is_test then
    raise exception 'phoenix_crm:manager_customer_not_found';
  end if;
  if v_approver = v_row.manager_hr_id or v_second = v_row.manager_hr_id then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_row.status <> 'active' then
    raise exception 'phoenix_crm:manager_customer_not_active';
  end if;

  update public.phoenix_crm_manager_customers m
  set status = 'removal_pending',
      removal_reason = v_reason,
      removal_requested_at = now(),
      removal_requested_by_hr_id = v_actor,
      removal_approver_hr_id = v_approver,
      removal_second_approver_hr_id = v_second,
      removal_first_decided_at = null,
      removal_first_decided_by_hr_id = null,
      removal_first_decided_role = null,
      removal_first_decision_note = null,
      removal_decided_at = null,
      removal_decided_by_hr_id = null,
      removal_decided_role = null,
      removal_decision_note = null,
      updated_at = now()
  where m.id = v_row.id
  returning m.* into v_row;

  return jsonb_build_object(
    'manager_customer_id', v_row.id,
    'manager_hr_id', v_row.manager_hr_id,
    'name', v_row.name,
    'status', v_row.status,
    'approver_hr_id', v_row.removal_approver_hr_id,
    'second_approver_hr_id', v_row.removal_second_approver_hr_id,
    'is_test', v_row.is_test
  );
end;
$$;

-- p: manager_customer_id, decision ('approve' | 'refuse'), actor_hr_id, actor_role ('first' | 'second' |
--    'administrator'), stage ('first' | 'second'; absent: read off the row's own status), note (required
--    to refuse), is_test
create or replace function public.phoenix_crm_decide_manager_customer_removal(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'manager_customer_id', '')::uuid;
  v_decision text := coalesce(p ->> 'decision', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_stage text := nullif(trim(coalesce(p ->> 'stage', '')), '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_row public.phoenix_crm_manager_customers%rowtype;
begin
  if v_id is null or v_actor is null or v_decision not in ('approve', 'refuse')
     or v_role is null or v_role not in ('first', 'second', 'administrator')
     or (v_stage is not null and v_stage not in ('first', 'second')) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_decision = 'refuse' and v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;

  select m.* into v_row from public.phoenix_crm_manager_customers m where m.id = v_id for update;
  if not found or v_row.is_test <> v_is_test then
    raise exception 'phoenix_crm:manager_customer_not_found';
  end if;
  v_stage := coalesce(v_stage, case when v_row.status = 'removal_first_approved' then 'second' else 'first' end);
  if (v_role = 'first' and v_stage <> 'first') or (v_role = 'second' and v_stage <> 'second') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if (v_stage = 'first' and v_row.status <> 'removal_pending')
     or (v_stage = 'second' and (v_row.status <> 'removal_first_approved' or v_row.removal_second_approver_hr_id is null)) then
    raise exception 'phoenix_crm:manager_customer_removal_decided';
  end if;

  if v_decision = 'approve' and v_stage = 'first' and v_row.removal_second_approver_hr_id is not null then
    -- The regional manager agrees: the customer stays on the list until the national sales manager above
    -- him approves too — whoever decided this first step.
    update public.phoenix_crm_manager_customers m
    set status = 'removal_first_approved',
        removal_first_decided_at = now(),
        removal_first_decided_by_hr_id = v_actor,
        removal_first_decided_role = v_role,
        removal_first_decision_note = v_note,
        updated_at = now()
    where m.id = v_row.id
    returning m.* into v_row;
  else
    update public.phoenix_crm_manager_customers m
    set status = case when v_decision = 'approve' then 'removed' else 'active' end,
        removal_decided_at = now(),
        removal_decided_by_hr_id = v_actor,
        removal_decided_role = v_role,
        removal_decision_note = v_note,
        updated_at = now()
    where m.id = v_row.id
    returning m.* into v_row;
  end if;

  return jsonb_build_object(
    'manager_customer_id', v_row.id,
    'manager_hr_id', v_row.manager_hr_id,
    'name', v_row.name,
    'status', v_row.status,
    'decision', v_decision,
    'stage', v_stage,
    'second_approver_hr_id', v_row.removal_second_approver_hr_id,
    'is_test', v_row.is_test
  );
end;
$$;

-- check:migrations refuses a file whose SECURITY DEFINER functions carry no revoke from PUBLIC.
revoke execute on function public.phoenix_crm_raise_manager_plan_edit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_raise_manager_plan_edit(jsonb) to service_role;
revoke execute on function public.phoenix_crm_decide_manager_plan_edit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_manager_plan_edit(jsonb) to service_role;
revoke execute on function public.phoenix_crm_expire_manager_plan_edit_requests(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_expire_manager_plan_edit_requests(jsonb) to service_role;
revoke execute on function public.phoenix_crm_request_manager_customer_removal(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_request_manager_customer_removal(jsonb) to service_role;
revoke execute on function public.phoenix_crm_decide_manager_customer_removal(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_manager_customer_removal(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
