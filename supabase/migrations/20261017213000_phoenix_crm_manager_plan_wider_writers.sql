-- phoenix_crm_manager_plan_wider_writers
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_manager_plans — a week now says WHO plans it: planner_kind 'dm' (a district manager,
--      every row so far), 'rsm' (a regional sales manager), 'nsm' (a national sales manager) or 'pm' (a
--      product manager, who holds no organogram seat — so manager_seat_id drops NOT NULL, and a CHECK
--      keeps it required for every kind but 'pm'). Two new columns record HR's automatic acknowledgement
--      of an approved week: hr_acknowledged_at, hr_acknowledged_by_hr_id — never on a district manager's.
--   2. phoenix_crm_manager_plan_slots — a half-day records the scope it was planned in:
--      scope_dm_seat_id (the district manager seat he picked) and scope_line_code (its line; a product
--      manager's "any rep in the line" carries the line alone). Admin gains one more activity, 'office',
--      and an admin half-day carries no scope.
--   3. phoenix_crm_manager_plan_events takes one more event, 'hr_acknowledged'.
--   4. Two functions, replaced:
--        phoenix_crm_save_manager_plan_slot  takes planner_kind and the scope; a seat is required unless
--                                            'pm'; 'office' only for a planner who is not a district manager
--        phoenix_crm_manager_plan_transition the approval that closes a week that is not a district
--                                            manager's is acknowledged by HR at once (SYSTEM-AUTO-HR-ACK,
--                                            an 'hr_acknowledged' event); a send or a return clears it
--      Both live bodies were proven to be 20261017000000's before this was written: md5(prosrc)
--      8001428dc75b22ba565674c39b83029f (save) and a29033c32db8acb97e2c487e286e21a0 (transition), the
--      file's own text, on staging and on production (17 Oct 2026, 18:49 Cairo).
--
-- WHY (owner, 2026-10-17):
--   "Now do the same for the product managers and the national sales managers and the regional manager.
--   The only difference is that he first choose the region or the district manager, then the areas of
--   this district manager appear." Asked in chat: the approvers are "as today, HR auto acknowledge" — the
--   person's own manager, then the CEO (one step when that manager IS the CEO), then HR's automatic
--   acknowledgement, exactly as their legacy weekly plan runs; the district manager is picked "once per
--   day by default but have the option to half-day"; the product managers are Rasha Sabry and Ahmed
--   SharafEldeen, who "choose between the 2 lines pedia and anti infective" and may "skip district
--   manager and choose a rep without district manager".
--
--   Office is new because these managers are judged on attendance by the days their plan marks Office
--   (attendance/plan-office-days.ts); a district manager's own board never offers it, and the database
--   refuses it for one.
--
--   🔴 A DISTRICT MANAGER'S WEEK IS EXACTLY AS IT WAS: planner_kind defaults to 'dm', every existing row
--   reads 'dm', the code running before this deploys sends no kind and no scope, and no HR acknowledgement
--   is ever written on a 'dm' week (his ruling of 2026-10-16: no HR step for them).
--
--   The application proves who acts and passes the approvers in, as every Phoenix CRM function does.
--
-- ROLLBACK:
--   re-apply phoenix_crm_save_manager_plan_slot and phoenix_crm_manager_plan_transition from
--   20261017000000_phoenix_crm_manager_plan.sql; then, once every non-'dm' week and every 'office' half-day
--   is deleted (their planners go back to the legacy weekly plan):
--   alter table public.phoenix_crm_manager_plan_events drop constraint if exists phoenix_crm_manager_plan_events_type;
--   alter table public.phoenix_crm_manager_plan_events add constraint phoenix_crm_manager_plan_events_type check (
--     event_type in ('created', 'submitted', 'first_approved', 'approved', 'returned', 'edit_asked', 'edit_first_approved', 'reopened', 'edit_refused', 'edit_expired'));
--   restore phoenix_crm_manager_plan_slots_kind from 20261017000000; drop the CHECKs added here; drop the
--   columns scope_dm_seat_id, scope_line_code, planner_kind, hr_acknowledged_at, hr_acknowledged_by_hr_id;
--   alter table public.phoenix_crm_manager_plans alter column manager_seat_id set not null;
--   DATA COST: every regional, national and product manager week since it went live.
--
-- Verification after apply:
--   select proname, prosecdef, md5(prosrc) from pg_proc
--    where proname in ('phoenix_crm_save_manager_plan_slot', 'phoenix_crm_manager_plan_transition');           -- 2 rows, both t
--   select has_function_privilege('anon', 'public.phoenix_crm_manager_plan_transition(jsonb)', 'execute');      -- f
--   select has_function_privilege('authenticated', 'public.phoenix_crm_save_manager_plan_slot(jsonb)', 'execute'); -- f
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.phoenix_crm_manager_plans'::regclass and contype = 'c' order by 1;                -- the new CHECKs
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration adds five nullable columns and one defaulted column to tables that held 0 rows on
-- production when it was written, widens two CHECKs, adds four, and replaces two function bodies; no
-- existing row is touched.

begin;
set local lock_timeout = '5s';

-- ── 1. Who plans the week ──────────────────────────────────────────────────────────────────────

alter table public.phoenix_crm_manager_plans
  add column if not exists planner_kind text not null default 'dm',
  add column if not exists hr_acknowledged_at timestamptz,
  add column if not exists hr_acknowledged_by_hr_id text;

alter table public.phoenix_crm_manager_plans
  alter column manager_seat_id drop not null;

alter table public.phoenix_crm_manager_plans
  drop constraint if exists phoenix_crm_manager_plans_planner_kind,
  drop constraint if exists phoenix_crm_manager_plans_seat_unless_pm,
  drop constraint if exists phoenix_crm_manager_plans_hr_ack;

alter table public.phoenix_crm_manager_plans
  add constraint phoenix_crm_manager_plans_planner_kind check (planner_kind in ('dm', 'rsm', 'nsm', 'pm')),
  -- A product manager holds no organogram seat; everybody else plans from his own.
  add constraint phoenix_crm_manager_plans_seat_unless_pm check (planner_kind = 'pm' or manager_seat_id is not null),
  -- Never tied to the status: a reopened week (20261017120000) goes back to draft and keeps the stamp
  -- until it is sent again, which clears it.
  add constraint phoenix_crm_manager_plans_hr_ack check (
    (hr_acknowledged_at is null) = (hr_acknowledged_by_hr_id is null)
    and coalesce(hr_acknowledged_by_hr_id, '') = upper(coalesce(hr_acknowledged_by_hr_id, ''))
    and (hr_acknowledged_at is null or planner_kind <> 'dm')
  );

comment on column public.phoenix_crm_manager_plans.planner_kind is
  'Who plans this week (owner, 2026-10-17): dm (district manager), rsm (regional sales manager), nsm (national sales manager), pm (product manager — no seat). Only a week that is not a district manager''s is acknowledged by HR.';

-- ── 2. The scope a half-day was planned in, and Office ─────────────────────────────────────────

alter table public.phoenix_crm_manager_plan_slots
  add column if not exists scope_dm_seat_id text,
  add column if not exists scope_line_code text;

alter table public.phoenix_crm_manager_plan_slots
  drop constraint if exists phoenix_crm_manager_plan_slots_kind,
  drop constraint if exists phoenix_crm_manager_plan_slots_scope;

alter table public.phoenix_crm_manager_plan_slots
  add constraint phoenix_crm_manager_plan_slots_kind check (
    (kind = 'with_rep' and rep_seat_id is not null and rep_hr_id is not null and activity_type is null
      and area_code is null and area_seat_id is null)
    or (kind = 'admin' and activity_type in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'office')
      and rep_seat_id is null and rep_hr_id is null and area_code is null and area_seat_id is null
      and scope_dm_seat_id is null and scope_line_code is null)
    or (kind = 'single_visit' and area_code is not null and rep_seat_id is null and rep_hr_id is null and activity_type is null)
  ),
  -- A district manager seat always sits on a line; "any rep in the line" names the line alone.
  add constraint phoenix_crm_manager_plan_slots_scope check (scope_dm_seat_id is null or scope_line_code is not null);

-- ── 3. The trail: HR's automatic acknowledgement ───────────────────────────────────────────────

alter table public.phoenix_crm_manager_plan_events
  drop constraint if exists phoenix_crm_manager_plan_events_type;
alter table public.phoenix_crm_manager_plan_events
  add constraint phoenix_crm_manager_plan_events_type check (
    event_type in ('created', 'submitted', 'first_approved', 'approved', 'returned', 'edit_asked', 'edit_first_approved', 'reopened', 'edit_refused', 'edit_expired', 'hr_acknowledged')
  );

-- ── 4. Setting, changing or clearing one half-day ──────────────────────────────────────────────
--
-- p: manager_hr_id, manager_seat_id (null only for 'pm'), planner_kind ('dm' when absent), line_code,
--    actor_hr_id, plan_date, half,
--    kind ('with_rep' | 'admin' | 'single_visit'; null clears the half-day),
--    rep_seat_id, rep_hr_id (with_rep), activity_type (admin), area_seat_id, area_code, area_name
--    (single_visit), scope_dm_seat_id, scope_line_code (with_rep and single_visit; never for 'dm'),
--    note, customers: [{ customer_id } | { manager_customer_id }],
--    expected_version (the week's version the screen showed; null while it has no row), is_test
create or replace function public.phoenix_crm_save_manager_plan_slot(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_seat text := nullif(trim(coalesce(p ->> 'manager_seat_id', '')), '');
  v_planner text := coalesce(nullif(trim(coalesce(p ->> 'planner_kind', '')), ''), 'dm');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_date date := nullif(p ->> 'plan_date', '')::date;
  v_half text := coalesce(p ->> 'half', '');
  v_kind text := nullif(trim(coalesce(p ->> 'kind', '')), '');
  v_rep_seat text := nullif(trim(coalesce(p ->> 'rep_seat_id', '')), '');
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_activity text := nullif(trim(coalesce(p ->> 'activity_type', '')), '');
  v_area_seat text := nullif(trim(coalesce(p ->> 'area_seat_id', '')), '');
  v_area_code text := nullif(trim(coalesce(p ->> 'area_code', '')), '');
  v_area_name text := nullif(trim(coalesce(p ->> 'area_name', '')), '');
  v_scope_seat text := nullif(trim(coalesce(p ->> 'scope_dm_seat_id', '')), '');
  v_scope_line text := nullif(trim(coalesce(p ->> 'scope_line_code', '')), '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_customers jsonb := coalesce(p -> 'customers', '[]'::jsonb);
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_week date;
  v_this_week date;
  v_plan public.phoenix_crm_manager_plans%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_slot_id uuid;
  v_entry jsonb;
  v_cid uuid;
  v_mcid uuid;
begin
  if v_planner not in ('dm', 'rsm', 'nsm', 'pm') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A product manager holds no seat; everybody else plans from his own.
  if v_manager is null or (v_seat is null and v_planner <> 'pm') or v_actor is null or v_date is null or v_half not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if jsonb_typeof(v_customers) <> 'array' or jsonb_array_length(v_customers) > 60 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A scope is the district manager seat (and its line) or a line alone; a district manager plans his
  -- own district, so his half-days carry none, and Admin never does.
  if (v_scope_seat is not null and v_scope_line is null)
     or ((v_scope_seat is not null or v_scope_line is not null) and (v_planner = 'dm' or v_kind is distinct from 'with_rep' and v_kind is distinct from 'single_visit')) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- Each kind carries its own fields and nothing else; a clear carries nothing.
  if v_kind is null then
    if jsonb_array_length(v_customers) > 0 then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_kind = 'with_rep' then
    if v_rep_seat is null or v_rep is null or v_activity is not null or v_area_code is not null then
      raise exception 'phoenix_crm:bad_input';
    end if;
  elsif v_kind = 'admin' then
    if v_activity is null or v_activity not in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day', 'office')
       or v_rep_seat is not null or v_area_code is not null or jsonb_array_length(v_customers) > 0 then
      raise exception 'phoenix_crm:bad_input';
    end if;
    -- Office belongs to the managers judged by their office days, never to a district manager's board.
    if v_activity = 'office' and v_planner = 'dm' then
      raise exception 'phoenix_crm:manager_plan_bad_kind';
    end if;
  elsif v_kind = 'single_visit' then
    if v_area_code is null or v_rep_seat is not null or v_activity is not null then
      raise exception 'phoenix_crm:bad_input';
    end if;
  else
    raise exception 'phoenix_crm:manager_plan_bad_kind';
  end if;
  -- A half-day with a rep or on a single visit names the customers he will see.
  if v_kind in ('with_rep', 'single_visit') and jsonb_array_length(v_customers) = 0 then
    raise exception 'phoenix_crm:manager_plan_slot_empty';
  end if;

  -- The field week: Saturday to Wednesday, AM and PM; Thursday a morning; never a Friday.
  if extract(isodow from v_date) = 5 or (extract(isodow from v_date) = 4 and v_half = 'PM') then
    raise exception 'phoenix_crm:manager_plan_not_field_time';
  end if;
  -- A day that has passed keeps its plan, so actual against planned still reads what was planned.
  if v_date < v_today then
    raise exception 'phoenix_crm:manager_plan_day_passed';
  end if;
  -- calendar.ts fieldWeekStart in SQL. The week he is in and the coming one — the application narrows
  -- it to the one he plans (the coming week, or the week he is in while he never sent it).
  v_week := v_date - ((extract(isodow from v_date)::integer + 1) % 7);
  v_this_week := v_today - ((extract(isodow from v_today)::integer + 1) % 7);
  if v_week not in (v_this_week, v_this_week + 7) then
    raise exception 'phoenix_crm:manager_plan_week_closed';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('phoenix_crm:manager_plan:' || v_manager || ':' || v_week::text || ':' || v_is_test::text)
  );

  select pl.* into v_plan
  from public.phoenix_crm_manager_plans pl
  where pl.manager_hr_id = v_manager and pl.week_start = v_week and pl.is_test = v_is_test
  for update;

  if not found then
    -- The screen showed no week, so it sends no version. Anything else means another screen made it.
    if v_expected is not null then
      raise exception 'phoenix_crm:version_conflict';
    end if;
    if v_kind is null then
      return jsonb_build_object('plan_id', null, 'version', null, 'status', null, 'week_start', v_week, 'slot_id', null);
    end if;
    insert into public.phoenix_crm_manager_plans
      (manager_hr_id, manager_seat_id, planner_kind, line_code, week_start, status, version, due_on, created_by_hr_id, is_test)
    values
      (v_manager, v_seat, v_planner, v_line, v_week, 'draft', 1, public.phoenix_crm_week_due_on(v_week), v_actor, v_is_test)
    returning * into v_plan;
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version)
    values (v_plan.id, 'created', v_actor, case when v_actor = v_manager then 'manager' else 'administrator' end, null, 'draft', v_plan.version);
  else
    if v_expected is distinct from v_plan.version then
      raise exception 'phoenix_crm:version_conflict';
    end if;
    -- A sent week changes only through his ask to edit it, decided above him.
    if v_plan.status not in ('draft', 'returned') then
      raise exception 'phoenix_crm:manager_plan_not_editable';
    end if;
    -- A week returned for ONE day changes on that day alone.
    if v_plan.status = 'returned' and v_plan.returned_day is not null and v_date <> v_plan.returned_day then
      raise exception 'phoenix_crm:manager_plan_day_not_returned';
    end if;
  end if;

  delete from public.phoenix_crm_manager_plan_slots s
  where s.plan_id = v_plan.id and s.plan_date = v_date and s.half = v_half;

  if v_kind is not null then
    insert into public.phoenix_crm_manager_plan_slots
      (plan_id, week_start, plan_date, half, kind, rep_seat_id, rep_hr_id, activity_type, area_seat_id, area_code, area_name,
       scope_dm_seat_id, scope_line_code, note)
    values
      (v_plan.id, v_week, v_date, v_half, v_kind,
       case when v_kind = 'with_rep' then v_rep_seat end,
       case when v_kind = 'with_rep' then v_rep end,
       case when v_kind = 'admin' then v_activity end,
       case when v_kind = 'single_visit' then v_area_seat end,
       case when v_kind = 'single_visit' then v_area_code end,
       case when v_kind = 'single_visit' then v_area_name end,
       case when v_kind <> 'admin' then v_scope_seat end,
       case when v_kind <> 'admin' then v_scope_line end,
       v_note)
    returning id into v_slot_id;

    for v_entry in select value from jsonb_array_elements(v_customers) loop
      v_cid := nullif(v_entry ->> 'customer_id', '')::uuid;
      v_mcid := nullif(v_entry ->> 'manager_customer_id', '')::uuid;
      if (v_cid is null) = (v_mcid is null) then
        raise exception 'phoenix_crm:bad_input';
      end if;
      if v_cid is not null then
        select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_cid;
        if not found or v_customer.is_test <> v_is_test or v_customer.status = 'dropped' then
          raise exception 'phoenix_crm:manager_plan_customer_gone';
        end if;
        -- With a rep, every customer is that rep's own.
        if v_kind = 'with_rep' and v_customer.seat_id <> v_rep_seat then
          raise exception 'phoenix_crm:manager_plan_customer_not_reps';
        end if;
        insert into public.phoenix_crm_manager_plan_customers (slot_id, customer_id, source_seat_id, list_type)
        values (v_slot_id, v_cid, v_customer.seat_id, v_customer.list_type)
        on conflict do nothing;
      else
        -- His own list belongs to his single visits, and to him.
        if v_kind <> 'single_visit' then
          raise exception 'phoenix_crm:bad_input';
        end if;
        if not exists (
          select 1 from public.phoenix_crm_manager_customers m
          where m.id = v_mcid and m.manager_hr_id = v_manager and m.is_test = v_is_test and m.status <> 'removed'
        ) then
          raise exception 'phoenix_crm:manager_plan_customer_gone';
        end if;
        insert into public.phoenix_crm_manager_plan_customers (slot_id, manager_customer_id)
        values (v_slot_id, v_mcid)
        on conflict do nothing;
      end if;
    end loop;
  end if;

  -- The week follows who plans it now: a person whose post changed between two saves of an open week
  -- plans it under his new kind and seat (a send then refuses an Office half-day left on a district
  -- manager's week).
  update public.phoenix_crm_manager_plans pl
  set version = pl.version + 1,
      planner_kind = v_planner,
      manager_seat_id = v_seat,
      line_code = coalesce(v_line, pl.line_code),
      updated_at = now()
  where pl.id = v_plan.id
  returning pl.* into v_plan;

  return jsonb_build_object(
    'plan_id', v_plan.id,
    'version', v_plan.version,
    'status', v_plan.status,
    'week_start', v_plan.week_start,
    'planner_kind', v_plan.planner_kind,
    'slot_id', v_slot_id
  );
end;
$$;

-- ── 5. Send, approve, return — and HR's automatic acknowledgement ──────────────────────────────
--
-- p: plan_id, action ('submit' | 'approve' | 'return'), actor_hr_id,
--    actor_role ('manager' or 'administrator' on a send; 'first', 'second' or 'administrator' on a
--    decision), stage ('first' | 'second' on a decision — whose turn is being decided),
--    first_approver_hr_id, second_approver_hr_id (on a send), note, day (a one-day return),
--    expected_version, is_test
create or replace function public.phoenix_crm_manager_plan_transition(p jsonb)
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
  v_stage text := nullif(trim(coalesce(p ->> 'stage', '')), '');
  v_first text := upper(nullif(trim(coalesce(p ->> 'first_approver_hr_id', '')), ''));
  v_second text := upper(nullif(trim(coalesce(p ->> 'second_approver_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_day date := nullif(p ->> 'day', '')::date;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_hr_ack constant text := 'SYSTEM-AUTO-HR-ACK';
  v_manager text;
  v_week date;
  v_plan public.phoenix_crm_manager_plans%rowtype;
  v_from text;
  v_event text;
  v_details jsonb := '{}'::jsonb;
begin
  if v_plan_id is null or v_actor is null or v_action not in ('submit', 'approve', 'return') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_day is not null and v_action <> 'return' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_action = 'submit' and (v_role is null or v_role not in ('manager', 'administrator')) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_action <> 'submit' and (v_stage is null or v_stage not in ('first', 'second')
     or v_role is null or v_role not in ('first', 'second', 'administrator')) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- An approver decides only his own stage; the Administrator may decide either.
  if v_action <> 'submit' and v_role <> 'administrator' and v_role <> v_stage then
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
    if not exists (select 1 from public.phoenix_crm_manager_plan_slots s where s.plan_id = v_plan.id) then
      raise exception 'phoenix_crm:empty_plan';
    end if;
    -- Office is never a district manager's (a post that changed under an open week leaves one behind).
    if v_plan.planner_kind = 'dm' and exists (
      select 1 from public.phoenix_crm_manager_plan_slots s where s.plan_id = v_plan.id and s.activity_type = 'office'
    ) then
      raise exception 'phoenix_crm:manager_plan_bad_kind';
    end if;
    if v_first is null then
      raise exception 'phoenix_crm:manager_plan_no_approver';
    end if;
    if v_first = v_plan.manager_hr_id or v_second = v_plan.manager_hr_id or v_second = v_first then
      raise exception 'phoenix_crm:bad_input';
    end if;
    -- Judged against its own deadline, 23:55 Cairo on its due date, from the server's clock, and
    -- accepted whenever it arrives. A week sent again after his approver reopened it keeps the verdict
    -- its first send earned: the change was agreed above him and must not read as lateness.
    update public.phoenix_crm_manager_plans pl
    set status = 'submitted',
        submitted_at = now(),
        submitted_by_hr_id = v_actor,
        due_on = public.phoenix_crm_week_due_on(pl.week_start),
        submitted_late = case
          when pl.submitted_late is not null and exists (
            select 1 from public.phoenix_crm_manager_plan_edit_requests r where r.plan_id = pl.id and r.status = 'reopened'
          ) then pl.submitted_late
          else now() > public.phoenix_crm_week_deadline_at(pl.week_start)
        end,
        first_approver_hr_id = v_first,
        second_approver_hr_id = v_second,
        first_decided_at = null,
        first_decided_by_hr_id = null,
        first_decided_role = null,
        first_decision_note = null,
        decided_at = null,
        decided_by_hr_id = null,
        decided_by_role = null,
        decision_note = null,
        returned_day = null,
        returned_stage = null,
        hr_acknowledged_at = null,
        hr_acknowledged_by_hr_id = null,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'submitted';
    -- WHAT WAS SENT, kept on the send's own event: every half-day with its customers' names as they stood.
    v_details := jsonb_build_object(
      'slots', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'plan_date', s.plan_date, 'half', s.half, 'kind', s.kind,
                   'rep_seat_id', s.rep_seat_id, 'rep_hr_id', s.rep_hr_id,
                   'activity_type', s.activity_type, 'area_code', s.area_code, 'area_name', s.area_name,
                   'scope_dm_seat_id', s.scope_dm_seat_id, 'scope_line_code', s.scope_line_code,
                   'customers', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'customer_id', pc.customer_id,
                              'manager_customer_id', pc.manager_customer_id,
                              'name', coalesce(c.name, m.name))
                            order by coalesce(c.name, m.name), pc.id)
                     from public.phoenix_crm_manager_plan_customers pc
                     left join public.phoenix_crm_customers c on c.id = pc.customer_id
                     left join public.phoenix_crm_manager_customers m on m.id = pc.manager_customer_id
                     where pc.slot_id = s.id
                   ), '[]'::jsonb))
                 order by s.plan_date, s.half)
        from public.phoenix_crm_manager_plan_slots s
        where s.plan_id = v_plan.id
      ), '[]'::jsonb)
    );

  elsif v_action = 'approve' then
    if v_stage = 'first' then
      if v_from <> 'submitted' then
        raise exception 'phoenix_crm:bad_transition';
      end if;
      update public.phoenix_crm_manager_plans pl
      set status = case when pl.second_approver_hr_id is null then 'approved' else 'first_approved' end,
          first_decided_at = now(),
          first_decided_by_hr_id = v_actor,
          first_decided_role = v_role,
          first_decision_note = v_note,
          decided_at = case when pl.second_approver_hr_id is null then now() end,
          decided_by_hr_id = case when pl.second_approver_hr_id is null then v_actor end,
          decided_by_role = case when pl.second_approver_hr_id is null then v_role end,
          decision_note = case when pl.second_approver_hr_id is null then v_note end,
          version = pl.version + 1,
          updated_at = now()
      where pl.id = v_plan.id
      returning pl.* into v_plan;
    else
      if v_from <> 'first_approved' or v_plan.second_approver_hr_id is null then
        raise exception 'phoenix_crm:bad_transition';
      end if;
      update public.phoenix_crm_manager_plans pl
      set status = 'approved',
          decided_at = now(),
          decided_by_hr_id = v_actor,
          decided_by_role = v_role,
          decision_note = v_note,
          version = pl.version + 1,
          updated_at = now()
      where pl.id = v_plan.id
      returning pl.* into v_plan;
    end if;
    v_event := case when v_plan.status = 'first_approved' then 'first_approved' else 'approved' end;

  else
    -- The first approver returns a week waiting on him (or one he closed alone); the second returns one
    -- waiting on him or one he approved.
    if v_stage = 'first' and not (v_from = 'submitted' or (v_from = 'approved' and v_plan.second_approver_hr_id is null)) then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if v_stage = 'second' and not (v_from in ('first_approved', 'approved') and v_plan.second_approver_hr_id is not null) then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if v_note is null then
      raise exception 'phoenix_crm:note_required';
    end if;
    -- ONE DAY: a working day of this week that has not passed — he must still be able to change it.
    if v_day is not null and (v_day < v_plan.week_start or v_day > v_plan.week_start + 5 or v_day < v_today) then
      raise exception 'phoenix_crm:day_not_returnable';
    end if;
    update public.phoenix_crm_manager_plans pl
    set status = 'returned',
        returned_day = v_day,
        returned_stage = v_stage,
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_by_role = v_role,
        decision_note = v_note,
        hr_acknowledged_at = null,
        hr_acknowledged_by_hr_id = null,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'returned';
    v_details := jsonb_build_object('stage', v_stage)
      || case when v_day is not null then jsonb_build_object('returned_day', v_day) else '{}'::jsonb end;
  end if;

  insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
  values (v_plan.id, v_event, v_actor, v_role, v_from, v_plan.status, v_plan.version, v_note, v_details);

  -- "As today, HR auto acknowledge" (owner, 2026-10-17): the approval that closes a regional, national or
  -- product manager's week is acknowledged by HR at once, signed by the system, exactly as the legacy
  -- weekly plan's. Never on a district manager's week — his ruling for them is no HR step at all.
  if v_action = 'approve' and v_plan.status = 'approved' and v_plan.planner_kind <> 'dm' then
    update public.phoenix_crm_manager_plans pl
    set hr_acknowledged_at = now(),
        hr_acknowledged_by_hr_id = v_hr_ack,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version)
    values (v_plan.id, 'hr_acknowledged', v_hr_ack, 'system', v_plan.status, v_plan.status, v_plan.version);
  end if;

  return jsonb_build_object(
    'plan_id', v_plan.id,
    'manager_hr_id', v_plan.manager_hr_id,
    'manager_seat_id', v_plan.manager_seat_id,
    'planner_kind', v_plan.planner_kind,
    'week_start', v_plan.week_start,
    'status', v_plan.status,
    'from_status', v_from,
    'version', v_plan.version,
    'due_on', v_plan.due_on,
    'submitted_late', v_plan.submitted_late,
    'first_approver_hr_id', v_plan.first_approver_hr_id,
    'second_approver_hr_id', v_plan.second_approver_hr_id,
    'returned_day', v_plan.returned_day,
    'hr_acknowledged', v_plan.hr_acknowledged_at is not null,
    'is_test', v_plan.is_test
  );
end;
$$;

-- check:migrations refuses a file whose SECURITY DEFINER functions carry no revoke from PUBLIC.
revoke execute on function public.phoenix_crm_save_manager_plan_slot(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_manager_plan_slot(jsonb) to service_role;
revoke execute on function public.phoenix_crm_manager_plan_transition(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_manager_plan_transition(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
