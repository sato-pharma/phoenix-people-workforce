-- phoenix_crm_plan_day_details
--
-- WHAT THIS CHANGES (the owner's walk of the old CRM's weekly plan, 2026-09-29 videos — the two Plan
-- items still open on his status sheet of 2026-09-30):
--   1. A planned day may carry MORE THAN ONE other activity. phoenix_crm_plan_activities allowed one a
--      day (unique plan_id, plan_date), while the old weekly plan lists its Other Activities as tick
--      boxes — a meeting and travel on one day is an ordinary day. The key widens to ONE OF EACH KIND
--      a day (plan_id, plan_date, activity_type), and phoenix_crm_save_plan_activities keeps a day's
--      several rows instead of folding them into one.
--   2. phoenix_crm_plan_day_starts: when the rep means to START his AM round and his PM round on a
--      planned day — the old weekly plan's "Start AM 11:00 AM · Start PM 2:00 PM" on every day, which
--      its Daily Plan report repeats in the day's header. Minutes of the Cairo day, as a plan item's
--      start_minute is. A plan RECORD only: it moves no call rate, and no visit is judged against it.
--   3. phoenix_crm_save_plan_day_starts replaces the start times of the days the caller may still
--      edit, under the same plan lock and the same draft/returned check as the activities.
--
-- EXPAND-ONLY: the one constraint dropped is re-added wider, and every row that satisfied the old key
-- satisfies the new one. A caller one release behind still sends at most one activity a day and gets
-- exactly what it got before.
--
-- ROLLBACK:
--   drop function public.phoenix_crm_save_plan_day_starts(jsonb);
--   drop table public.phoenix_crm_plan_day_starts (SAFE only while it is empty);
--   re-apply phoenix_crm_save_plan_activities from 20260929235555, then put the one-a-day key back —
--   which FAILS while any day holds two activities: keep one row a day first.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. One of each kind of other activity a day ──────────────────────────────────────────────────

alter table public.phoenix_crm_plan_activities drop constraint if exists phoenix_crm_plan_activities_one_a_day;
alter table public.phoenix_crm_plan_activities drop constraint if exists phoenix_crm_plan_activities_one_of_each;
alter table public.phoenix_crm_plan_activities
  add constraint phoenix_crm_plan_activities_one_of_each unique (plan_id, plan_date, activity_type);

comment on table public.phoenix_crm_plan_activities is
  'The other activities a rep PLANS on a day — one of each kind, shown at the top of the day as the old CRM''s weekly plan did (owner, 2026-09-29). A plan record only: no call rate, coverage or plan-against-actual reads it.';

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

  -- A kind the list no longer holds for its day comes off; the other kinds on that day stay.
  delete from public.phoenix_crm_plan_activities a
  where a.plan_id = v_plan.id
    and a.plan_date = any (v_days)
    and not exists (
      select 1
      from jsonb_to_recordset(v_items) as x (plan_date date, activity_type text)
      where x.plan_date = a.plan_date
        and x.activity_type = a.activity_type
    );

  -- One of each kind a day: a kind sent twice for one day is kept once, never a reason to lose the plan.
  insert into public.phoenix_crm_plan_activities (plan_id, plan_date, activity_type, half_day, note)
  select distinct on (x.plan_date, x.activity_type)
    v_plan.id, x.plan_date, x.activity_type, coalesce(x.half_day, false), nullif(trim(coalesce(x.note, '')), '')
  from jsonb_to_recordset(v_items) as x (plan_date date, activity_type text, half_day boolean, note text)
  order by x.plan_date, x.activity_type
  on conflict (plan_id, plan_date, activity_type) do update
    set half_day = excluded.half_day,
        note = excluded.note,
        updated_at = now();

  select count(*)::integer into v_count from public.phoenix_crm_plan_activities a where a.plan_id = v_plan.id;

  return jsonb_build_object('plan_id', v_plan.id, 'activity_count', v_count);
end;
$$;

-- ── 2. When the AM round and the PM round start on a planned day ─────────────────────────────────

create table if not exists public.phoenix_crm_plan_day_starts (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.phoenix_crm_plans (id),
  plan_date date not null,
  start_am_minute integer,
  start_pm_minute integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_plan_day_starts_am check (start_am_minute is null or start_am_minute between 0 and 1439),
  constraint phoenix_crm_plan_day_starts_pm check (start_pm_minute is null or start_pm_minute between 0 and 1439),
  constraint phoenix_crm_plan_day_starts_some check (start_am_minute is not null or start_pm_minute is not null),
  constraint phoenix_crm_plan_day_starts_one_a_day unique (plan_id, plan_date)
);

comment on table public.phoenix_crm_plan_day_starts is
  'When the rep means to start his AM round and his PM round on a planned day, in minutes of the Cairo day — the old CRM weekly plan''s Start AM and Start PM (owner''s walk, 2026-09-29). A plan record only: no call rate reads it and no visit is judged against it.';

alter table public.phoenix_crm_plan_day_starts enable row level security;
drop policy if exists phoenix_crm_plan_day_starts_service_role on public.phoenix_crm_plan_day_starts;
create policy phoenix_crm_plan_day_starts_service_role
  on public.phoenix_crm_plan_day_starts for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_plan_day_starts from public, anon, authenticated;
grant all on table public.phoenix_crm_plan_day_starts to service_role;

-- Replaces the start times of the days the caller may still edit, and nothing else. A day sent with
-- neither time, or not sent at all, keeps none. The plan must exist: this never creates one.
create or replace function public.phoenix_crm_save_plan_day_starts(p jsonb)
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
  v_items jsonb := coalesce(p -> 'starts', '[]'::jsonb);
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
    from jsonb_to_recordset(v_items) as x (plan_date date, start_am_minute integer, start_pm_minute integer)
    where x.plan_date is null or not (x.plan_date = any (v_days))
      or (x.start_am_minute is not null and x.start_am_minute not between 0 and 1439)
      or (x.start_pm_minute is not null and x.start_pm_minute not between 0 and 1439)
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

  delete from public.phoenix_crm_plan_day_starts s
  where s.plan_id = v_plan.id
    and s.plan_date = any (v_days)
    and not exists (
      select 1
      from jsonb_to_recordset(v_items) as x (plan_date date, start_am_minute integer, start_pm_minute integer)
      where x.plan_date = s.plan_date
        and (x.start_am_minute is not null or x.start_pm_minute is not null)
    );

  insert into public.phoenix_crm_plan_day_starts (plan_id, plan_date, start_am_minute, start_pm_minute)
  select distinct on (x.plan_date)
    v_plan.id, x.plan_date, x.start_am_minute, x.start_pm_minute
  from jsonb_to_recordset(v_items) as x (plan_date date, start_am_minute integer, start_pm_minute integer)
  where x.start_am_minute is not null or x.start_pm_minute is not null
  order by x.plan_date
  on conflict (plan_id, plan_date) do update
    set start_am_minute = excluded.start_am_minute,
        start_pm_minute = excluded.start_pm_minute,
        updated_at = now();

  select count(*)::integer into v_count from public.phoenix_crm_plan_day_starts s where s.plan_id = v_plan.id;

  return jsonb_build_object('plan_id', v_plan.id, 'start_count', v_count);
end;
$$;

revoke execute on function public.phoenix_crm_save_plan_activities(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_plan_activities(jsonb) to service_role;
revoke execute on function public.phoenix_crm_save_plan_day_starts(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_save_plan_day_starts(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
