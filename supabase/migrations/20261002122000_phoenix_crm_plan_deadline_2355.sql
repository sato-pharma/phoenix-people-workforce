-- Phoenix CRM — the plan deadline is 23:55 Cairo on the due date, not the end of that day.
--
-- Owner, 2026-10-02: "the deadline to submit the plan is thuersday 11:5pm and show themn this".
--
-- WHAT CHANGES. `submitted_late` was `v_today > phoenix_crm_week_due_on(week_start)` — a DATE against a
-- DATE, so the real cut-off was midnight and a send at 23:58 on the due Thursday counted as on time.
-- It is now an INSTANT: `now() > phoenix_crm_week_deadline_at(week_start)`, which is 23:55 Cairo on the
-- same due date, overrides included. Five minutes tighter, and the five minutes are the point: a
-- deadline a rep can read on his screen, instead of a day that quietly ends.
--
-- WHAT DOES NOT CHANGE. A late week is still ACCEPTED AND STAMPED, never refused (owner, 2026-09-29) —
-- a rep who cannot plan cannot work. Nothing here raises, nothing blocks a send, and the week_passed
-- guard keeps its own date arithmetic. `due_on` stays a DATE column holding the due date; the hour is a
-- rule, not a stored value, so no row needs rewriting and no earlier verdict moves. A week re-sent
-- after an acknowledged edit request still keeps the verdict its first send earned (owner, 2026-10-01).
--
-- THE ONCE-A-YEAR AMBIGUITY, MEASURED NOT ASSUMED. Egypt leaves DST at Cairo midnight on the last
-- Thursday of October (2026-10-29, which is itself a plan due date), so 23:55 that evening happens
-- TWICE. `at time zone 'Africa/Cairo'` resolves it to the LATER instant — 2026-10-29 21:55+00, read
-- back from production before this was written — which is the forgiving one: a rep whose own clock
-- reads 23:55 is on time on either pass of it. `planDeadlineAt` in src/lib/phoenix-crm/calendar.ts
-- lands on the same instant, and tests/phoenix-crm-plan-deadline.test.ts pins that the two agree.
--
-- The function is STABLE, not IMMUTABLE: `at time zone` with a zone NAME depends on the server's
-- timezone rules, which an upgrade can change. Marking it immutable would let a plan cache an instant
-- from before such a change.
--
-- Rollback (restores the midnight cut-off):
--   the previous body of phoenix_crm_plan_transition is in
--   supabase/migrations/20261002002251_phoenix_crm_plan_edit_requests.sql, section 4;
--   drop function public.phoenix_crm_week_deadline_at(date);

-- ── 1. When a week's plan is late, in one place ───────────────────────────────────────────────────

create or replace function public.phoenix_crm_week_deadline_at(p_week_start date)
returns timestamptz
language sql
stable
security definer
set search_path to 'public'
as $$
  select (public.phoenix_crm_week_due_on(p_week_start) + time '23:55') at time zone 'Africa/Cairo';
$$;

revoke execute on function public.phoenix_crm_week_deadline_at(date) from public, anon, authenticated;
grant execute on function public.phoenix_crm_week_deadline_at(date) to service_role;

-- ── 2. The weekly transition: the live body, with lateness read from the deadline instant ─────────

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
    -- Sent on its own, the week is judged against its own deadline — 23:55 Cairo on its due date, from
    -- the server's clock, and accepted whenever it arrives (owner, 2026-09-29; the hour, 2026-10-02).
    -- A week sent AGAIN after an acknowledged edit keeps the verdict its first send earned (owner,
    -- 2026-10-01): the change was agreed by his manager, SFE and HR, and must not read as lateness.
    update public.phoenix_crm_plans pl
    set status = 'submitted',
        submitted_at = now(),
        submitted_by_hr_id = v_actor,
        due_on = public.phoenix_crm_week_due_on(pl.week_start),
        submitted_late = case
          when exists (
            select 1 from public.phoenix_crm_plan_edit_requests r where r.plan_id = pl.id and r.status = 'reopened'
          ) then pl.submitted_late
          else now() > public.phoenix_crm_week_deadline_at(pl.week_start)
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
