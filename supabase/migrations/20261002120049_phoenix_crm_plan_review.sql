-- phoenix_crm_plan_review
--
-- WHAT THIS CHANGES (owner rulings, 2026-10-02, on how a manager reviews a sent week):
--   1. phoenix_crm_plans.returned_day — a reviewer may return ONE day of a sent week ("Only that
--      day" reopens). The week goes back to the rep as `returned`, as a whole-week return does, and
--      the day is kept here; only that day is his to change, the others stay exactly as he sent them
--      (the application passes that one day as the only editable day to phoenix_crm_save_plan,
--      phoenix_crm_save_plan_activities and phoenix_crm_save_plan_day_starts, each of which already
--      touches the days it is given and nothing else). Sending the week again clears it. A CHECK keeps
--      it to a returned plan and to a day of that plan's own week.
--   2. phoenix_crm_plan_transition is replaced with its live body (20261002002251) and three changes:
--        - a RETURN may name `day`: a working day of the week (Saturday to Thursday) that has not
--          passed on the Cairo calendar, else phoenix_crm:day_not_returnable. Any other action naming
--          a day is bad_input. The returned event carries {"returned_day": …} in its details;
--        - a SUBMIT clears returned_day, and keeps WHAT WAS SENT on its own 'submitted' event — every
--          customer by day (id, list, name as it stood) and every planned activity — so when the week
--          comes back for review after a return or an acknowledged edit, the reviewer is shown only
--          what changed against the version sent before. Until today a submit stored no snapshot
--          (production: 4 'submitted' events, none with details);
--        - a REOPEN clears returned_day too (it only ever reopens a sent week, where it is already null).
--      Everything else is the live text: the Cairo day, the week_passed check before any action, the
--      due date from phoenix_crm_week_due_on, the kept late verdict after an acknowledged edit, and ONE
--      plan-event insert (now naming its details).
--
-- WHY: on 1 October district managers approved 13 weeks of 51-94 customers each in a median of two
--   minutes. The review becomes steps (the week and its coverage, its days, each day's AM then PM,
--   the decision), a re-sent week shows only what changed, and a manager can send back the one day
--   that is wrong instead of the whole week.
--
-- What it does NOT change: phoenix_crm_save_visit. A returned plan — whole or one day — stops counting
--   as sent for the planned-visit check until the rep sends it again, exactly as a whole-week return
--   always has (the check reads the plan's last event status). The month's own send, refused by the
--   application since 2026-10-01, would now also be refused by the CHECK on a week returned for one day.
--
-- ROLLBACK:
--   re-apply phoenix_crm_plan_transition from 20261002002251_phoenix_crm_plan_edit_requests.sql; then
--   alter table public.phoenix_crm_plans drop constraint if exists phoenix_crm_plans_returned_day;
--   alter table public.phoenix_crm_plans drop column if exists returned_day;
--   (a week returned for one day at that moment then reads as returned whole — every open day is the
--   rep's again; the snapshots already kept on 'submitted' events stay in their details, unread.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied. This file
-- adds one nullable column and one CHECK (every existing row passes it: the column starts empty) and
-- replaces one function; it deletes and rewrites no row.

begin;
set local lock_timeout = '5s';

-- ── 1. The one day a reviewer returned ───────────────────────────────────────────────────────────

alter table public.phoenix_crm_plans add column if not exists returned_day date;

comment on column public.phoenix_crm_plans.returned_day is
  'The ONE day of this week a reviewer returned to the rep (owner, 2026-10-02: "Only that day" reopens). Null for a week returned whole and for every week that is not returned; cleared when the rep sends the week again.';

alter table public.phoenix_crm_plans drop constraint if exists phoenix_crm_plans_returned_day;
alter table public.phoenix_crm_plans add constraint phoenix_crm_plans_returned_day
  check (returned_day is null or (status = 'returned' and returned_day between week_start and week_start + 5));

-- ── 2. The weekly transition: the live body, a one-day return, and what was sent ─────────────────

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
  v_day date := nullif(p ->> 'day', '')::date;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_seat text;
  v_week date;
  v_plan public.phoenix_crm_plans%rowtype;
  v_from text;
  v_event text;
  v_details jsonb := '{}'::jsonb;
begin
  if v_plan_id is null or v_actor is null or v_action not in ('submit', 'reopen', 'approve', 'return') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- Only a return names a day (owner, 2026-10-02).
  if v_day is not null and v_action <> 'return' then
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
    -- manager, SFE and HR, and must not read as lateness. A one-day return is answered by this send,
    -- so the week is whole again (owner, 2026-10-02).
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
        returned_day = null,
        decided_at = null,
        decided_by_hr_id = null,
        decided_by_role = null,
        decision_note = null,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'submitted';
    -- WHAT WAS SENT, kept on the send's own event (owner, 2026-10-02): a week that comes back for
    -- review after a return or an acknowledged edit is shown only what changed against the version
    -- sent before it. Customers by day with the name as it stood — so one who has since left the list
    -- is still named — and every planned activity.
    v_details := jsonb_build_object(
      'items', coalesce((
        select jsonb_agg(
                 jsonb_build_object('plan_date', i.plan_date, 'customer_id', i.customer_id, 'list_type', i.list_type, 'name', c.name)
                 order by i.plan_date, i.list_type, c.name, i.customer_id)
        from public.phoenix_crm_plan_items i
        left join public.phoenix_crm_customers c on c.id = i.customer_id
        where i.plan_id = v_plan.id
      ), '[]'::jsonb),
      'activities', coalesce((
        select jsonb_agg(
                 jsonb_build_object('plan_date', a.plan_date, 'activity_type', a.activity_type, 'half_day', a.half_day)
                 order by a.plan_date, a.activity_type)
        from public.phoenix_crm_plan_activities a
        where a.plan_id = v_plan.id
      ), '[]'::jsonb)
    );

  elsif v_action = 'reopen' then
    if v_from not in ('submitted', 'approved') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    update public.phoenix_crm_plans pl
    set status = 'draft',
        returned_day = null,
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
    -- ONE DAY (owner, 2026-10-02: "Only that day"): a working day of this week, Saturday to Thursday,
    -- that has not passed on the Cairo calendar — the rep must still be able to change it.
    if v_day is not null and (v_day < v_plan.week_start or v_day > v_plan.week_start + 5 or v_day < v_today) then
      raise exception 'phoenix_crm:day_not_returnable';
    end if;
    update public.phoenix_crm_plans pl
    set status = 'returned',
        returned_day = v_day,
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_by_role = v_role,
        decision_note = v_note,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'returned';
    if v_day is not null then
      v_details := jsonb_build_object('returned_day', v_day);
    end if;
  end if;

  insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)
  values (v_plan.id, v_event, v_actor, v_role, v_from, v_plan.status, v_plan.version, v_note, v_details);

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
    'submitted_via', v_plan.submitted_via,
    'returned_day', v_plan.returned_day
  );
end;
$$;

revoke execute on function public.phoenix_crm_plan_transition(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_plan_transition(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
