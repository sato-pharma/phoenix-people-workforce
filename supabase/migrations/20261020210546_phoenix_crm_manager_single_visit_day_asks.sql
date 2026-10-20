-- phoenix_crm_manager_single_visit_day_asks
--
-- WHAT THIS CHANGES:
--   1. A new table, phoenix_crm_manager_single_visit_days: a district manager's ask for ONE MORE day of
--      single visits on a named date — his second or third day of the week. It goes to his regional manager
--      and then the national sales manager above him (or straight to the national sales manager where there
--      is no regional manager), the same two steps as his ask to edit a sent week.
--   2. Three functions: phoenix_crm_raise_manager_single_visit_day, phoenix_crm_decide_manager_single_visit_day
--      and phoenix_crm_expire_manager_single_visit_days (an ask nobody finished before its date passed).
--
-- WHY (owner, 2026-10-20):
--   "regarding the district sales managers, single visit days, cap per week. Make it as it now. One per week.
--   With no approval. But if you need to do the second or the third day maximum, he need to send an approval
--   from his manager, national sales manager or regional manager. If regional manager, then he need to
--   approval. Regional manager and the national sales manager. If no regional manager, then approval direct
--   from national sales manager. And not from the first day, from the second day." Asked how he asks, he
--   chose "Ask first, then plan"; what one approval covers, "One named date"; and whether an approved date
--   also covers the visits he logs without planning them, "Yes, planned and unplanned".
--
--   The first day stays free — two half-days, any mix, exactly as today (manager-plan-rules.ts,
--   DM_SINGLE_VISIT_HALF_DAYS_MAX). An APPROVED date holds single visits on both its halves without spending
--   that free day. At most two dates a week are asked or approved — the second and the third day — and each
--   is asked on its own.
--
--   🔴 THE STAGE NEVER DEPENDS ON WHO DECIDES. An ask closes at the first approval only when no second
--   approver was stored on it, so the Administrator acting for the regional manager still passes it on.
--   The application proves who acts and passes the approvers in (managerApproversFor), as every Phoenix CRM
--   function does.
--
--   🔴 THE ASK TAKES THE WEEK'S OWN LOCK — the same advisory key as phoenix_crm_save_manager_plan_slot — so
--   two asks for one week cannot both pass the two-a-week count.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_expire_manager_single_visit_days(jsonb);
--   drop function if exists public.phoenix_crm_decide_manager_single_visit_day(jsonb);
--   drop function if exists public.phoenix_crm_raise_manager_single_visit_day(jsonb);
--   drop table if exists public.phoenix_crm_manager_single_visit_days;  -- SAFE only while it holds no ask
--   DATA COST: every ask and its decision. Before the drop, every date it approved stops holding single
--   visits beyond the free day, so a week planned on an approved date is refused at its next save.
--
-- Verification after apply:
--   select relname, relrowsecurity from pg_class where relname = 'phoenix_crm_manager_single_visit_days';  -- 1 row, t
--   select proname, prosecdef from pg_proc where proname in ('phoenix_crm_raise_manager_single_visit_day',
--     'phoenix_crm_decide_manager_single_visit_day', 'phoenix_crm_expire_manager_single_visit_days');       -- 3 rows, all t
--   select has_function_privilege('anon', 'public.phoenix_crm_raise_manager_single_visit_day(jsonb)', 'execute');  -- f
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration creates one empty table and three functions; no existing row is touched.

begin;
set local lock_timeout = '5s';

-- ── 1. His ask for another day of single visits ────────────────────────────────────────────────

create table if not exists public.phoenix_crm_manager_single_visit_days (
  id uuid primary key default gen_random_uuid(),
  manager_hr_id text not null,
  manager_seat_id text,
  week_start date not null,
  visit_date date not null,
  reason text not null,
  status text not null default 'pending',
  approver_hr_id text not null,
  second_approver_hr_id text,
  first_decided_at timestamptz,
  first_decided_by_hr_id text,
  first_decided_role text,
  first_decision_note text,
  decided_at timestamptz,
  decided_by_hr_id text,
  decided_role text,
  decision_note text,
  version integer not null default 1,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_manager_single_visit_days_status
    check (status in ('pending', 'first_approved', 'approved', 'refused', 'expired')),
  constraint phoenix_crm_manager_single_visit_days_reason check (char_length(reason) between 3 and 500),
  constraint phoenix_crm_manager_single_visit_days_notes check (
    (decision_note is null or char_length(decision_note) <= 500)
    and (first_decision_note is null or char_length(first_decision_note) <= 500)
  ),
  constraint phoenix_crm_manager_single_visit_days_role
    check (decided_role is null or decided_role in ('first', 'second', 'administrator', 'system')),
  -- Open (waiting on the first OR the second approver) exactly while it carries no final decision.
  constraint phoenix_crm_manager_single_visit_days_decided
    check ((status in ('pending', 'first_approved')) = (decided_at is null)),
  constraint phoenix_crm_manager_single_visit_days_first_step check (
    (status <> 'first_approved' or (second_approver_hr_id is not null and first_decided_at is not null))
    and ((first_decided_at is null) = (first_decided_by_hr_id is null))
    and ((first_decided_at is null) = (first_decided_role is null))
    and (first_decided_role is null or first_decided_role in ('first', 'administrator'))
  ),
  -- The week is the date's own field week, Saturday to Thursday — never a Friday.
  constraint phoenix_crm_manager_single_visit_days_week check (
    extract(isodow from week_start) = 6
    and visit_date between week_start and week_start + 5
  ),
  constraint phoenix_crm_manager_single_visit_days_upper check (
    manager_hr_id = upper(manager_hr_id)
    and approver_hr_id = upper(approver_hr_id)
    and (second_approver_hr_id is null or second_approver_hr_id = upper(second_approver_hr_id))
    and (first_decided_by_hr_id is null or first_decided_by_hr_id = upper(first_decided_by_hr_id))
    and (decided_by_hr_id is null or decided_by_hr_id = upper(decided_by_hr_id))
  ),
  constraint phoenix_crm_manager_single_visit_days_people check (
    approver_hr_id <> manager_hr_id
    and (second_approver_hr_id is null or (second_approver_hr_id <> manager_hr_id and second_approver_hr_id <> approver_hr_id))
  )
);

comment on table public.phoenix_crm_manager_single_visit_days is
  'A district manager''s ask for a second or third day of single visits on one named date (owner, 2026-10-20). His first day a week needs no approval; an APPROVED date holds single visits, planned and unplanned, on both its halves. Decided by his regional manager, then the national sales manager above him.';

-- One live ask (waiting or approved) per date.
create unique index if not exists phoenix_crm_manager_single_visit_days_live_uniq
  on public.phoenix_crm_manager_single_visit_days (manager_hr_id, visit_date, is_test)
  where status in ('pending', 'first_approved', 'approved');
create index if not exists phoenix_crm_manager_single_visit_days_week_idx
  on public.phoenix_crm_manager_single_visit_days (manager_hr_id, week_start, is_test);
create index if not exists phoenix_crm_manager_single_visit_days_approver_idx
  on public.phoenix_crm_manager_single_visit_days (approver_hr_id, status, is_test);
create index if not exists phoenix_crm_manager_single_visit_days_second_idx
  on public.phoenix_crm_manager_single_visit_days (second_approver_hr_id, status, is_test);

-- Row security: the same four statements as every table in this module. Revoking from public also strips
-- service_role (a member of it), so the grant that follows is mandatory.
alter table public.phoenix_crm_manager_single_visit_days enable row level security;
drop policy if exists phoenix_crm_manager_single_visit_days_service_role on public.phoenix_crm_manager_single_visit_days;
create policy phoenix_crm_manager_single_visit_days_service_role
  on public.phoenix_crm_manager_single_visit_days for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_manager_single_visit_days from public, anon, authenticated;
grant all on table public.phoenix_crm_manager_single_visit_days to service_role;

-- ── 2. Raise his ask for one more day ──────────────────────────────────────────────────────────
--
-- p: manager_hr_id, manager_seat_id, actor_hr_id, visit_date, approver_hr_id, second_approver_hr_id (null:
--    one step), reason, is_test
create or replace function public.phoenix_crm_raise_manager_single_visit_day(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_seat text := nullif(trim(coalesce(p ->> 'manager_seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_date date := nullif(p ->> 'visit_date', '')::date;
  v_approver text := upper(nullif(trim(coalesce(p ->> 'approver_hr_id', '')), ''));
  v_second text := upper(nullif(trim(coalesce(p ->> 'second_approver_hr_id', '')), ''));
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_week date;
  v_row public.phoenix_crm_manager_single_visit_days%rowtype;
begin
  if v_manager is null or v_actor is null or v_date is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:note_required';
  end if;
  if v_approver is null then
    raise exception 'phoenix_crm:manager_plan_no_approver';
  end if;
  if v_approver = v_manager or v_second = v_manager or (v_second is not null and v_second = v_approver) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if extract(isodow from v_date) = 5 then
    raise exception 'phoenix_crm:single_visit_day_not_field';
  end if;
  if v_date < v_today then
    raise exception 'phoenix_crm:single_visit_day_passed';
  end if;
  -- This week or the coming one: the application names the exact weeks; this is the outer fence.
  if v_date > v_today + 13 then
    raise exception 'phoenix_crm:single_visit_day_too_far';
  end if;

  -- Saturday is isodow 6, so (isodow + 1) % 7 days back is the week's Saturday.
  v_week := v_date - ((extract(isodow from v_date)::integer + 1) % 7);

  -- The week's own lock, the one every half-day save of his week takes.
  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  if exists (
    select 1 from public.phoenix_crm_manager_single_visit_days d
    where d.manager_hr_id = v_manager and d.visit_date = v_date and d.is_test = v_is_test
      and d.status in ('pending', 'first_approved', 'approved')
  ) then
    raise exception 'phoenix_crm:single_visit_day_already_asked';
  end if;
  -- The second and the third day: two asked or approved a week at most.
  if (
    select count(*) from public.phoenix_crm_manager_single_visit_days d
    where d.manager_hr_id = v_manager and d.week_start = v_week and d.is_test = v_is_test
      and d.status in ('pending', 'first_approved', 'approved')
  ) >= 2 then
    raise exception 'phoenix_crm:single_visit_days_full';
  end if;

  insert into public.phoenix_crm_manager_single_visit_days
    (manager_hr_id, manager_seat_id, week_start, visit_date, reason, status, approver_hr_id, second_approver_hr_id, is_test)
  values
    (v_manager, v_seat, v_week, v_date, v_reason, 'pending', v_approver, v_second, v_is_test)
  returning * into v_row;

  return jsonb_build_object(
    'request_id', v_row.id,
    'manager_hr_id', v_row.manager_hr_id,
    'week_start', v_row.week_start,
    'visit_date', v_row.visit_date,
    'approver_hr_id', v_row.approver_hr_id,
    'second_approver_hr_id', v_row.second_approver_hr_id,
    'status', v_row.status,
    'version', v_row.version,
    'is_test', v_row.is_test
  );
end;
$$;

-- ── 3. Decide one step of his ask: approve (or pass it on) or refuse ───────────────────────────
--
-- p: request_id, decision ('approve' | 'refuse'), actor_hr_id, actor_role ('first' | 'second' |
--    'administrator'), stage ('first' | 'second'; absent: read off the ask's own status), note (required
--    to refuse), expected_version (the ask's), is_test
create or replace function public.phoenix_crm_decide_manager_single_visit_day(p jsonb)
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
  v_row public.phoenix_crm_manager_single_visit_days%rowtype;
begin
  if v_request_id is null or v_actor is null or v_decision not in ('approve', 'refuse')
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

  select d.manager_hr_id, d.week_start into v_manager, v_week
  from public.phoenix_crm_manager_single_visit_days d where d.id = v_request_id;
  if not found then
    raise exception 'phoenix_crm:single_visit_day_not_found';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  select d.* into v_row from public.phoenix_crm_manager_single_visit_days d where d.id = v_request_id for update;
  if v_row.is_test <> v_is_test then
    raise exception 'phoenix_crm:single_visit_day_not_found';
  end if;
  if v_expected is distinct from v_row.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  v_stage := coalesce(v_stage, case when v_row.status = 'first_approved' then 'second' else 'first' end);
  if (v_role = 'first' and v_stage <> 'first') or (v_role = 'second' and v_stage <> 'second') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if (v_stage = 'first' and v_row.status <> 'pending')
     or (v_stage = 'second' and (v_row.status <> 'first_approved' or v_row.second_approver_hr_id is null)) then
    raise exception 'phoenix_crm:single_visit_day_decided';
  end if;
  if v_row.visit_date < v_today then
    raise exception 'phoenix_crm:single_visit_day_passed';
  end if;

  if v_decision = 'refuse' then
    update public.phoenix_crm_manager_single_visit_days d
    set status = 'refused',
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_role = v_role,
        decision_note = v_note,
        version = d.version + 1,
        updated_at = now()
    where d.id = v_row.id
    returning d.* into v_row;
  elsif v_stage = 'first' and v_row.second_approver_hr_id is not null then
    -- The regional manager agrees: the ask passes on to the national sales manager above him. The date
    -- holds no extra single visits until that second approval — whoever decided this first step.
    update public.phoenix_crm_manager_single_visit_days d
    set status = 'first_approved',
        first_decided_at = now(),
        first_decided_by_hr_id = v_actor,
        first_decided_role = v_role,
        first_decision_note = v_note,
        version = d.version + 1,
        updated_at = now()
    where d.id = v_row.id
    returning d.* into v_row;
  else
    update public.phoenix_crm_manager_single_visit_days d
    set status = 'approved',
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_role = v_role,
        decision_note = v_note,
        version = d.version + 1,
        updated_at = now()
    where d.id = v_row.id
    returning d.* into v_row;
  end if;

  return jsonb_build_object(
    'request_id', v_row.id,
    'manager_hr_id', v_row.manager_hr_id,
    'week_start', v_row.week_start,
    'visit_date', v_row.visit_date,
    'status', v_row.status,
    'stage', v_stage,
    'second_approver_hr_id', v_row.second_approver_hr_id,
    'version', v_row.version,
    'is_test', v_row.is_test
  );
end;
$$;

-- ── 4. An ask nobody finished deciding before its date passed ──────────────────────────────────
--
-- p: unused (the module's one calling shape). It picks its rows itself, in this transaction.
create or replace function public.phoenix_crm_expire_manager_single_visit_days(p jsonb)
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
    update public.phoenix_crm_manager_single_visit_days d
    set status = 'expired',
        decided_at = now(),
        decided_by_hr_id = null,
        decided_role = 'system',
        version = d.version + 1,
        updated_at = now()
    where d.status in ('pending', 'first_approved')
      and d.visit_date < v_today
    returning d.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'request_id', e.id, 'manager_hr_id', e.manager_hr_id, 'manager_seat_id', e.manager_seat_id,
           'visit_date', e.visit_date, 'week_start', e.week_start, 'is_test', e.is_test)), '[]'::jsonb)
  into v_expired
  from expired e;
  return jsonb_build_object('expired', v_expired);
end;
$$;

-- check:migrations refuses a file whose SECURITY DEFINER functions carry no revoke from PUBLIC.
revoke execute on function public.phoenix_crm_raise_manager_single_visit_day(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_raise_manager_single_visit_day(jsonb) to service_role;
revoke execute on function public.phoenix_crm_decide_manager_single_visit_day(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_manager_single_visit_day(jsonb) to service_role;
revoke execute on function public.phoenix_crm_expire_manager_single_visit_days(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_expire_manager_single_visit_days(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
