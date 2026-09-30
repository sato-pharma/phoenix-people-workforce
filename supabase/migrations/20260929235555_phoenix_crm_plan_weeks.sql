-- phoenix_crm_plan_weeks
--
-- WHAT THIS CHANGES (owner rulings, 2026-09-29 — the rep's flow rebuilt):
--   1. A weekly plan has its own due date — the Thursday before its week (week_start − 2) — and is
--      stamped late from the server's own clock when it is sent after it. "If he chooses the weekly
--      plan it is the last Thursday of every week." A late week is ACCEPTED and stamped, never
--      blocked, exactly as a late month is (owner, 2026-09-26 and again 2026-09-29).
--      submitted_via records how the week was sent: alone ('week', judged against its own Thursday)
--      or with its month ('month', judged against the month's own date).
--   2. phoenix_crm_plan_activities: the OTHER ACTIVITIES a rep plans on a day — meeting,
--      conference, health day, sales day, training, admin work, travel — shown at the top of the day,
--      as the old CRM's weekly plan showed them. A plan RECORD only: it changes no call rate.
--   3. phoenix_crm_plan_transition and phoenix_crm_monthly_plan_transition stamp the week's due date
--      and lateness. Everything else in them is unchanged — the Cairo day, the week_passed check, and
--      exactly one plan-event insert each.
--
-- ROLLBACK:
--   re-apply the plan_transition body from 20260916150000 and the monthly_plan_transition body from
--   20260926163000; drop function public.phoenix_crm_save_plan_activities(jsonb);
--   drop table public.phoenix_crm_plan_activities (SAFE only while it is empty); the three columns on
--   phoenix_crm_plans can stay.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. The weekly plan's own due date ────────────────────────────────────────────────────────────

alter table public.phoenix_crm_plans
  add column if not exists due_on date,
  add column if not exists submitted_late boolean not null default false,
  add column if not exists submitted_via text;

update public.phoenix_crm_plans pl
set due_on = pl.week_start - 2
where pl.due_on is null;

alter table public.phoenix_crm_plans drop constraint if exists phoenix_crm_plans_submitted_via;
alter table public.phoenix_crm_plans
  add constraint phoenix_crm_plans_submitted_via check (submitted_via is null or submitted_via in ('week', 'month'));

comment on column public.phoenix_crm_plans.due_on is
  'The Thursday before the week (week_start − 2): when a week sent on its own is due (owner, 2026-09-29). A late week is accepted and stamped, never refused.';
comment on column public.phoenix_crm_plans.submitted_via is
  'How the week was last sent: week (alone — judged against due_on) or month (with its month — judged against the month''s own due date).';

-- ── 2. Other activities planned on a day ─────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_plan_activities (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.phoenix_crm_plans (id),
  plan_date date not null,
  activity_type text not null,
  half_day boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_plan_activities_type
    check (activity_type in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day')),
  constraint phoenix_crm_plan_activities_note check (note is null or char_length(note) <= 300),
  constraint phoenix_crm_plan_activities_one_a_day unique (plan_id, plan_date)
);

comment on table public.phoenix_crm_plan_activities is
  'The other activity a rep PLANS on a day — shown at the top of the day, as the old CRM''s weekly plan did (owner, 2026-09-29). A plan record only: no call rate, coverage or plan-against-actual reads it.';

alter table public.phoenix_crm_plan_activities enable row level security;
drop policy if exists phoenix_crm_plan_activities_service_role on public.phoenix_crm_plan_activities;
create policy phoenix_crm_plan_activities_service_role
  on public.phoenix_crm_plan_activities for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_plan_activities from public, anon, authenticated;
grant all on table public.phoenix_crm_plan_activities to service_role;

-- Replaces the planned activities of the days the caller may still edit, and nothing else. The plan
-- itself is written first by phoenix_crm_save_plan; this never creates one.
create or replace function public.phoenix_crm_save_plan_activities(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_week date := nullif(p ->> 'week_start', '')::date;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_items jsonb := coalesce(p -> 'activities', '[]'::jsonb);
  v_days date[];
  v_plan public.phoenix_crm_plans%rowtype;
  v_count integer;
begin
  if v_seat is null or v_actor is null or v_week is null
    or extract(isodow from v_week) <> 6
    or jsonb_typeof(v_items) is distinct from 'array'
    or jsonb_typeof(p -> 'editable_days') is distinct from 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select coalesce(array_agg(distinct d.value::date), '{}'::date[])
  into v_days
  from jsonb_array_elements_text(p -> 'editable_days') d;

  if exists (select 1 from unnest(v_days) d where d < v_today or d < v_week or d > v_week + 5) then
    raise exception 'phoenix_crm:day_not_editable';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (plan_date date, activity_type text, note text)
    where x.plan_date is null or not (x.plan_date = any (v_days))
      or x.activity_type not in ('meeting', 'training', 'conference', 'admin_work', 'travel', 'health_day', 'sales_day')
      or (x.note is not null and char_length(x.note) > 300)
  ) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));

  select pl.* into v_plan
  from public.phoenix_crm_plans pl
  where pl.seat_id = v_seat
    and pl.week_start = v_week
    and pl.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:plan_not_found';
  end if;
  if v_plan.status not in ('draft', 'returned') then
    raise exception 'phoenix_crm:not_editable';
  end if;

  delete from public.phoenix_crm_plan_activities a
  where a.plan_id = v_plan.id
    and a.plan_date = any (v_days)
    and not exists (
      select 1 from jsonb_to_recordset(v_items) as x (plan_date date) where x.plan_date = a.plan_date
    );

  insert into public.phoenix_crm_plan_activities (plan_id, plan_date, activity_type, half_day, note)
  select distinct on (x.plan_date)
    v_plan.id, x.plan_date, x.activity_type, coalesce(x.half_day, false), nullif(trim(coalesce(x.note, '')), '')
  from jsonb_to_recordset(v_items) as x (plan_date date, activity_type text, half_day boolean, note text)
  order by x.plan_date
  on conflict (plan_id, plan_date) do update
    set activity_type = excluded.activity_type,
        half_day = excluded.half_day,
        note = excluded.note,
        updated_at = now();

  select count(*)::integer into v_count from public.phoenix_crm_plan_activities a where a.plan_id = v_plan.id;

  return jsonb_build_object('plan_id', v_plan.id, 'activity_count', v_count);
end;
$$;

-- ── 3. The weekly transition stamps the week's own due date ──────────────────────────────────────

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
    -- Sent on its own, the week is judged against its own Thursday — from the server's clock, and
    -- accepted whenever it arrives (owner, 2026-09-29).
    update public.phoenix_crm_plans pl
    set status = 'submitted',
        submitted_at = now(),
        submitted_by_hr_id = v_actor,
        due_on = pl.week_start - 2,
        submitted_late = v_today > pl.week_start - 2,
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

-- ── 4. The monthly transition stamps its weeks with the month's verdict ──────────────────────────

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

  -- Cascade the month's field-week plans and record each week's own event. A week sent with its
  -- month carries the MONTH's verdict: it is judged against the month's date, not its own Thursday.
  with moved as (
    update public.phoenix_crm_plans pl
    set status = v_week_to,
        submitted_at = case when v_week_to = 'submitted' then now() else (case when v_week_to = 'draft' then null else pl.submitted_at end) end,
        submitted_by_hr_id = case when v_week_to = 'submitted' then v_actor else (case when v_week_to = 'draft' then null else pl.submitted_by_hr_id end) end,
        due_on = coalesce(pl.due_on, pl.week_start - 2),
        submitted_late = case when v_week_to = 'submitted' then coalesce(v_late, false) else pl.submitted_late end,
        submitted_via = case when v_week_to = 'submitted' then 'month' else pl.submitted_via end,
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

revoke execute on function public.phoenix_crm_save_plan_activities(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_plan_activities(jsonb) to service_role;
revoke execute on function public.phoenix_crm_plan_transition(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_plan_transition(jsonb) to service_role;
revoke execute on function public.phoenix_crm_monthly_plan_transition(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_monthly_plan_transition(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
