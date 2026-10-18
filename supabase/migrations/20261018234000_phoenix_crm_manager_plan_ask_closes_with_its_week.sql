-- phoenix_crm_manager_plan_ask_closes_with_its_week
--
-- WHAT THIS CHANGES (two functions replaced; no table, column, index, constraint or row is touched):
--   1. phoenix_crm_manager_plan_transition — when a week is RETURNED to its manager, or SENT (again), every
--      ask to edit it that is still open (status 'pending' or 'first_approved') is closed in the same
--      transaction, the way the daily expiry closes one: status 'expired', decided_at now, decided_role
--      'system', version + 1, and one 'edit_expired' event on the week's trail (actor 'SYSTEM', role 'system',
--      details { request_id } plus a 'reason': 'week_returned' or 'week_sent_again'). The other branch
--      (approve) and every other line of the function are the live body's, unchanged.
--   2. phoenix_crm_decide_manager_plan_edit — the REOPEN branch (an approver agrees to reopen a sent week,
--      which goes back to 'draft') also clears hr_acknowledged_at and hr_acknowledged_by_hr_id. The refuse
--      and first-step branches and every other line are the live body's, unchanged.
--
-- WHY (audit of the manager's weekly plan, 2026-10-18):
--   1. An open ask was never closed by anything but the daily expiry, which only acts once the week has
--      passed. Scenario: a manager sends his week and asks to edit it; his approver presses RETURN on the
--      week. The ask stayed 'pending' in the Hub queue while its Reopen failed with bad_transition; the
--      manager then sent the week again, the stale ask came alive, and ONE click reopened the freshly sent
--      week to 'draft' (wiping its approvals if it had been approved) while his NEW ask was refused as
--      phoenix_crm:manager_plan_edit_already_open. A returned or re-sent week is no longer one an approver
--      can reopen, so its ask ends with that.
--   2. HR acknowledges an approved regional, national or product manager's week by itself (20261017213000);
--      the return and the send clear that stamp, but the reopen did not, so a week back in 'draft' kept
--      "HR acknowledgement: done" in the Hub's tracker until it was sent again.
--
--   Nothing about who approves, the stages, the late stamp (a re-send after a reopen still keeps the verdict
--   its first send earned — that rule reads 'reopened' asks, which this never touches), the one-open-ask
--   index or any grant changes. No notice is sent for a closed ask: the manager is already told the week
--   came back, and the approver's "ask waiting" notice drops out of his queue by itself.
--
--   Live bodies, read from production (ozucdzovmcqvepbozvqf) and staging (cifwmndunmlxjhyjugxa) on
--   18 Oct 2026 before this was written — md5(pg_proc.prosrc), identical on both and md5-equal to the
--   files named: phoenix_crm_manager_plan_transition ce07420c77d4953c73701817894347ee
--   (20261017213000_phoenix_crm_manager_plan_wider_writers.sql, its last definer) and
--   phoenix_crm_decide_manager_plan_edit ed3d6b906dee579b07ea4bdbd5867428
--   (20261017120000_phoenix_crm_manager_asks_second_approval.sql, its last definer). Production held 3 weeks
--   and 1 ask (a live one on a submitted week) when it was written, so no existing row is stale and none is
--   changed here.
--
-- ROLLBACK:
--   re-apply phoenix_crm_manager_plan_transition from 20261017213000_phoenix_crm_manager_plan_wider_writers.sql
--   and phoenix_crm_decide_manager_plan_edit from 20261017120000_phoenix_crm_manager_asks_second_approval.sql
--   (their digests are above). DATA COST: none — an ask closed by this stays 'expired', which is a status
--   the schema always allowed.
--
-- Verification after apply:
--   select proname, prosecdef, md5(prosrc) from pg_proc
--    where proname in ('phoenix_crm_manager_plan_transition', 'phoenix_crm_decide_manager_plan_edit');   -- 2 rows, both t
--   select has_function_privilege('anon', 'public.phoenix_crm_manager_plan_transition(jsonb)', 'execute');       -- f
--   select has_function_privilege('authenticated', 'public.phoenix_crm_decide_manager_plan_edit(jsonb)', 'execute'); -- f
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration replaces two function bodies and changes no row.

begin;
set local lock_timeout = '5s';

-- ── 1. Send, approve, return — an open ask ends with the week it was raised on ─────────────────
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

  -- 🔴 AN ASK TO EDIT NEVER OUTLIVES THE SENT WEEK IT WAS RAISED ON. A week returned to its manager, or sent
  -- again, is no longer a week an approver can reopen — so any ask still open on it is closed in this same
  -- transaction, exactly as the daily expiry closes one (status 'expired', decided by 'system', one
  -- 'edit_expired' event). Left open, it would sit in the Hub, fail its Reopen with bad_transition, then
  -- come alive when the manager sent the week again and reopen the FRESHLY SENT week with one click (and
  -- refuse his next ask as already open). No notice goes with it: the manager is told the week came back, and
  -- the approver's "ask waiting" notice clears itself once the ask is no longer in his queue.
  if v_action in ('submit', 'return') then
    with closed as (
      update public.phoenix_crm_manager_plan_edit_requests r
      set status = 'expired',
          decided_at = now(),
          decided_by_hr_id = null,
          decided_role = 'system',
          version = r.version + 1,
          updated_at = now()
      where r.plan_id = v_plan.id
        and r.status in ('pending', 'first_approved')
      returning r.id
    )
    insert into public.phoenix_crm_manager_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, details)
    select v_plan.id, 'edit_expired', 'SYSTEM', 'system', v_plan.status, v_plan.status, v_plan.version,
           jsonb_build_object('request_id', c.id, 'reason', case when v_action = 'return' then 'week_returned' else 'week_sent_again' end)
    from closed c;
  end if;

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

-- ── 2. Decide one step of his ask — a reopen takes HR's acknowledgement down with the approval ──
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
        hr_acknowledged_at = null,
        hr_acknowledged_by_hr_id = null,
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

-- check:migrations refuses a file whose SECURITY DEFINER functions carry no revoke from PUBLIC.
revoke execute on function public.phoenix_crm_manager_plan_transition(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_manager_plan_transition(jsonb) to service_role;
revoke execute on function public.phoenix_crm_decide_manager_plan_edit(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_manager_plan_edit(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
