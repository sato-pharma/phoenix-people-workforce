-- phoenix_crm_administrator_not_hr
--
-- WHAT THIS CHANGES: the request to edit a sent week no longer has an HR step.
--   * phoenix_crm_decide_plan_edit_request: SFE's approval REOPENS the week itself (the reopening HR's
--     acknowledgement used to do, body unchanged); stage 'hr' and decision 'acknowledge' are gone; a new
--     stage 'administrator' may DECLINE (decision 'refuse', note required) a request waiting at either step.
--   * phoenix_crm_plan_edit_requests gains admin_decided_by_hr_id, admin_decided_at and admin_note.
--   * the plan edit events' stage check accepts 'administrator'.
--
-- WHY (owner, 2026-10-08): take HR out of the approvals; he may decline or return anything with a comment,
--   but nothing waits for his approval. He is called the Administrator, never HR.
--
-- DATA: no row is rewritten. Measured on production 2026-10-08: 0 requests in 'hr_pending' (2 reopened,
--   3 manager_pending test). The migration REFUSES to run if one exists - it would be stranded.
--
-- ROLLBACK: re-apply 20261002221734_phoenix_crm_acknowledged_edit_opens_the_whole_week.sql (the old
--   body) and drop the three admin_* columns.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story.

begin;

set local lock_timeout = '5s';

do $guard$
begin
  if exists (select 1 from public.phoenix_crm_plan_edit_requests where status = 'hr_pending') then
    raise exception 'phoenix_crm_administrator_not_hr: a request is still waiting at HR - settle it first';
  end if;
end
$guard$;

alter table public.phoenix_crm_plan_edit_requests
  add column if not exists admin_decided_by_hr_id text,
  add column if not exists admin_decided_at timestamptz,
  add column if not exists admin_note text;

alter table public.phoenix_crm_plan_edit_requests
  drop constraint if exists phoenix_crm_plan_edit_requests_admin_note_len;
alter table public.phoenix_crm_plan_edit_requests
  add constraint phoenix_crm_plan_edit_requests_admin_note_len check (admin_note is null or char_length(admin_note) <= 500);

alter table public.phoenix_crm_plan_edit_request_events
  drop constraint if exists phoenix_crm_plan_edit_request_events_stage;
alter table public.phoenix_crm_plan_edit_request_events
  add constraint phoenix_crm_plan_edit_request_events_stage
  check (actor_stage is null or actor_stage in ('manager', 'sfe', 'hr', 'administrator'));

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
    or v_stage not in ('manager', 'sfe', 'administrator')
    or (v_stage = 'administrator' and v_decision <> 'refuse')
    or (v_stage <> 'administrator' and v_decision not in ('approve', 'refuse'))
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
  if v_from not in ('manager_pending', 'sfe_pending') then
    raise exception 'phoenix_crm:plan_edit_decided';
  end if;
  -- The steps run in order: SFE cannot sign off a request the manager has not seen. The Administrator
  -- is not a step - he may decline a request waiting at EITHER one, and nothing ever waits for him.
  if (v_stage = 'manager' and v_from <> 'manager_pending')
    or (v_stage = 'sfe' and v_from <> 'sfe_pending') then
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
  else
    -- SFE's approval is the last one: the week opens for the rep now (owner, 2026-10-08 - the
    -- Administrator is no longer a step in this chain).
    v_to := 'reopened';
    v_event := 'approved';
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
      values (v_plan.id, 'reopened', v_actor, 'sfe_manager', v_plan_from, v_plan.status, v_plan.version, null,
              jsonb_build_object('edit_request_id', v_request_id));
      v_reopened := true;
    -- 🔴 A WEEK RETURNED FOR ONE DAY IS OPENED WHOLE, AND THE DAY IS CLEARED HERE. It was left exactly
    -- as it stood, which is right about the STATUS — he may change it either way — and wrong about the
    -- day: he asked to edit the WEEK, his manager and SFE agreed, so every day is his again. While
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
      values (v_plan.id, 'reopened', v_actor, 'sfe_manager', v_plan_from, v_plan.status, v_plan.version, null,
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
      admin_decided_by_hr_id = case when v_stage = 'administrator' then v_actor else r.admin_decided_by_hr_id end,
      admin_decided_at = case when v_stage = 'administrator' then now() else r.admin_decided_at end,
      admin_note = case when v_stage = 'administrator' then v_note else r.admin_note end,
      -- hr_acknowledged_at is the moment the week WAS OPENED: its readers (plan-rules, offplan-day) ask
      -- "was this week opened after the return", not who opened it, so SFE's approval stamps it and the
      -- by-person column stays empty.
      hr_acknowledged_at = case when v_to = 'reopened' then now() else r.hr_acknowledged_at end,
      reopened_plan_version = case when v_to = 'reopened' then v_plan.version else r.reopened_plan_version end,
      decided_at = case when v_to in ('reopened', 'refused') then now() else null end,
      version = r.version + 1,
      updated_at = now()
  where r.id = v_request_id
  returning r.* into v_request;

  insert into public.phoenix_crm_plan_edit_request_events
    (request_id, event_type, actor_hr_id, actor_role, actor_stage, from_status, to_status, version, note, details)
  values
    (v_request_id, v_event, v_actor, v_role, v_stage, v_from, v_to, v_request.version, v_note,
     case when v_to = 'reopened' then jsonb_build_object('plan_reopened', v_reopened, 'plan_status_before', v_plan_from)
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
