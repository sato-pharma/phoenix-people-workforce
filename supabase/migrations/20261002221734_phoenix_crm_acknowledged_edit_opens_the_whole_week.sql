-- phoenix_crm_acknowledged_edit_opens_the_whole_week
--
-- WHAT THIS CHANGES: phoenix_crm_decide_plan_edit_request's HR branch. When the acknowledgement finds a
--   plan that a reviewer had RETURNED FOR ONE DAY, it now clears phoenix_crm_plans.returned_day and
--   writes a 'reopened' plan event for it ('returned' → 'returned', details {edit_request_id,
--   opened_whole_week}). Everything else is the live body (20261002002251_phoenix_crm_plan_edit_requests.sql,
--   identical to production and staging before this file: md5(prosrc) 12294c5770708c725faeb432a63fef0c,
--   7086 bytes) word for word, plus one comment line dropped where it stopped being true.
--
-- WHY: the acknowledgement opens the WHOLE week to the rep — his district manager, the SFE and HR all
--   agreed to the change he asked for — and plan-rules.ts standingReturnedDay has said so since
--   20261002125244. The DATABASE did not: it left the returned plan exactly as it stood, day and all, and
--   both readers of the "Still planned" rule (phoenix_crm_save_visit's v_on_sent_plan, and
--   phoenix_crm_plan_day_status) answer from the plan's LATEST event, comparing it with
--   hr_acknowledged_at. The rep's next save writes a 'saved' event that CARRIES returned_day
--   (20261002142625) and is newer than the acknowledgement, so that comparison fails from then on and the
--   week's other days went back to counting as SENT. A visit to a customer he had just added on one of
--   those days was then stamped PLANNED — with no district-manager and no SFE approval behind it, and
--   with the reason he typed dropped — which is exactly what the owner's rule of 2026-09-26 forbids ("an
--   off-plan visit counts in nothing until it is approved").
--
--   Found by the Phoenix CRM audit of 2026-10-02. Nothing to repair: measured on production the same day,
--   0 returned plans, 0 plans carrying a returned_day, 0 'returned' plan events and 0 acknowledged edit
--   requests, so the sequence has never run.
--
-- WHAT DOES NOT CHANGE: phoenix_crm_save_visit, phoenix_crm_plan_day_status and phoenix_crm_save_plan are
--   not replaced. With the day cleared at the acknowledgement they read a plain whole-week return, which
--   is authority on no day — the answer they already give. No table, column, view, grant or policy changes.
--
-- ROLLBACK: re-apply the phoenix_crm_decide_plan_edit_request block of
--   20261002002251_phoenix_crm_plan_edit_requests.sql. A returned_day already cleared by this function
--   stays cleared (that is the correct state either way), and the extra 'reopened' event is harmless to
--   every reader — a whole-week return is what it says.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This file is neither: one function is replaced, no row is written.

begin;

set local lock_timeout = '5s';

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
    -- Reopened exactly as the rep's own take-back used to reopen it.
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
    -- 🔴 A WEEK RETURNED FOR ONE DAY IS OPENED WHOLE, AND THE DAY IS CLEARED HERE. It was left exactly
    -- as it stood, which is right about the STATUS — he may change it either way — and wrong about the
    -- day: he asked to edit the WEEK, his manager, SFE and HR agreed, so every day is his again. While
    -- returned_day stood, the plan's latest event still named it, and both readers of that event
    -- (phoenix_crm_save_visit's "was he planned", phoenix_crm_plan_day_status) went on counting the
    -- week's OTHER days as SENT — so a customer he added on one of them was stamped PLANNED, with no
    -- district manager and no SFE behind it and the reason he typed dropped. Clearing the day leaves
    -- those readers a plain whole-week return, which is authority on no day at all; the event is what
    -- they read, so it is written as well as the column being cleared.
    elsif v_plan_from = 'returned' and v_plan.returned_day is not null then
      update public.phoenix_crm_plans pl
      set returned_day = null,
          version = pl.version + 1,
          updated_at = now()
      where pl.id = v_plan.id
      returning pl.* into v_plan;
      insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
      values (v_plan.id, 'reopened', v_actor, 'hr', v_plan_from, v_plan.status, v_plan.version, null,
              jsonb_build_object('edit_request_id', v_request_id, 'opened_whole_week', true));
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
