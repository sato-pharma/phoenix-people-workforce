-- phoenix_crm_visits_everywhere
--
-- WHAT THIS CHANGES (owner's rulings, 2026-10-02 — "From the team's start", then "Only when I start
-- it"):
--   Once a TEAM is started, every screen outside Phoenix CRM counts that team's Phoenix visits — and its
--   recorded day activities — INSTEAD OF its reps' iReports360 visits, from the team's start. Before the
--   start, and from a stop, iReports360 stays the source. Nothing is counted twice: for the days a rep
--   sits on a started team's territory, his iReports360 rows are left out of the same view that carries
--   the team's Phoenix rows.
--
--   1. public.phoenix_crm_team_starts — one row per START of a TEAM. A team is the territories (REP
--      seats) under one district-manager seat, and it is KEYED BY THAT SEAT (au.seats.parent_seat_id of
--      the territory), never by the person on it: a new district manager, or a vacant seat, keeps the
--      team and its dates. `starts_on` and `stops_on` are Saturdays; a row with no `stops_on` is running.
--      WHO STARTS A TEAM (owner, 2026-10-02 — "Only when I start it"):
--        - Delta (1)'s three teams, seeded here from his ruling: Saturday 3 October 2026.
--        - every other team ONLY when the Super Admin presses Start on the CRM hub, from the Saturday he
--          picks — never before the first day of the current Cairo month, so a published or collected
--          month is never restated. Stop ends a running start from a Saturday under the same floor, or
--          cancels a start that has not been reached yet.
--      NOTHING ELSE WRITES THE TABLE — no trigger, no backfill. Every line has been open in the module
--      since 18 September, so a stray draft plan or one visit must never start a whole team, and a stop
--      sticks because nothing but the Super Admin starts a team again.
--   2. public.phoenix_crm_set_team_start(p jsonb) — the ONE writer (start, stop, cancel). SECURITY
--      DEFINER, executable by the service role only, and it writes its own audit row in the same
--      transaction; the route in front of it (app/api/crm/phoenix-team-starts) is Super Admin only and
--      asserts the permission before calling it.
--   3. public.phoenix_crm_team_start_notices — the first REAL weekly plan SENT on a territory whose team
--      has no start tells the Super Admin, once per team, in-app and Telegram, never email. The app claims
--      the team's row here first, so a second send claims nothing and tells nobody.
--   4. crm_visits_unified gains two Phoenix branches, both on a started team's territory and only for the
--      days of its start:
--        - every real (`is_test = false`) row of phoenix_crm_countable_visits — the module's own predicate
--          for "this visit counts", read, never re-typed: an off-plan visit appears once it is approved;
--        - every real RECORDED day activity (phoenix_crm_day_activities — never a planned one), as the
--          iReports360 code the compliance and deduction readers already treat as a WORKED day
--          (src/lib/crm/visit-type-meaning.ts): meeting -11, conference -1, health day -15, training -9,
--          admin work -20, travel -12, and a sales day as -7 with its comment beginning "Sales day" —
--          exactly how iReports360 itself carried a sales day (visit-types.ts classifyAmbiguousComment).
--      Its iReports360 branch leaves out the rows of the people who sat on those territories — and of the
--      district manager who held the team's own seat ("Yes, the whole team", owner, 2026-10-02) — for the
--      days they sat there within a start (au.occupancy_history): matched on the hr id, or — on a vendor
--      row that carries no hr id — on the person's CRM id. The manager's own Phoenix visits are carried
--      with him as the agent (his single visits) or the partner (the double and chain visits he makes),
--      exactly as the vendor shape credits a rep's. The 30 columns keep their names, types and
--      order, and ONE is appended: `phoenix_customer_validated` (null on every other row) — the countable
--      view's own `customer_validated`. A visit to a customer not validated yet IS in the view, because
--      "did he work today" readers (field-work compliance, the deductions connectors, attendance, the
--      outstation workload) must see it, exactly as Phoenix CRM's own adoption board does; the call rate
--      reads the column and leaves such a visit out of the rate until the customer is validated ("not
--      counted in KPIs till validated", owner, 2026-10-01).
--   5. crm_visits_checkin_flags: a Phoenix row is its own check-in (a visit is captured live, with its
--      location read silently; a day activity is no call). Without this every Phoenix visit would sit on
--      the CRM Master's "Regular · No Check-in" list. Its 32 columns are unchanged — they are now listed by
--      name, so the column appended above does not reach it.
--
-- HOW A PHOENIX VISIT LOOKS IN THE VENDOR SHAPE (every reader of the read door, src/lib/crm/reads.ts):
--   id                      the Phoenix row's uuid (keyset pages order by it; every branch's id is a uuid)
--   crm_visit_id            NEGATIVE: -1 - (52 bits of md5(id)). Every vendor id is positive, so the two
--                           never meet, and 52 bits stay exact in a JavaScript number.
--   visit_date              the Phoenix visit day — already the Cairo day of (capture − 2 h): a visit day
--                           ends at 02:00 Cairo (phoenix_crm_save_visit). A day activity's own day.
--   agent_*                 the rep; on a manager's own single visit (no rep) the manager. agent_crm_id is
--                           his employees.crm_id when numeric — the Delta reps' all equal their old vendor
--                           id, so a reader keyed on agent_crm_id still finds him.
--   double_*                the district manager on a double or chain visit. A chain visit's senior
--                           manager has no column in this shape and is NOT credited (see the module note).
--   contact_crm_id          the customer's reference_contact_crm_id (his iReports360 contact), or NULL for
--                           a customer created new in Phoenix — and for every day activity.
--   visit_type              0 'Regular Visit' for every visit: a countable Phoenix visit is a call, planned
--                           or approved off-plan, and counts as one in Phoenix's own reports. A day
--                           activity carries its worked-day code (above), never 0 and never -8.
--   ampm                    the customer's list (AM / PM); null on a day activity. A pharmacy is feedback
--                           ON a Phoenix visit, never a row, so no Phoenix row is a pharmacy and none is
--                           counted inside AM/PM.
--   visit_date_time,
--   crm_save_date           the capture instant as Cairo wall clock labelled UTC — the vendor convention.
--                           A day activity: when it was recorded, and its own day at midnight.
--   synced_at, created_at,
--   updated_at              when the row reached the server. Phoenix's own `synced_at` (an offline
--                           capture's sync) is a silent column and is never carried.
--   No location, accuracy, distance, flag, photo, voice, dwell or capture-source column is carried.
--   crm_region_id/_name     NULL: the vendor's region vocabulary has no Phoenix equivalent, and the
--                           contact master's activity pass would otherwise rename contacts' regions.
--   speciality, grade       the Phoenix customer's; null on a day activity.
--   source                  'phoenix'; exclusion_crm_id = coalesce(agent_crm_id, -1) as before.
--   phoenix_customer_validated  APPENDED (31st column): whether a visit's customer is validated —
--                           null on every iReports360 row and every day activity.
--   NO row is added to crm_checkins_unified: a Phoenix visit's location is never shown as a GPS
--   check-in (the rep is never told his location is read — Phoenix CRM golden rule #1).
--
-- ORDER: apply this file BEFORE the code that reads `crm_visits_unified.phoenix_customer_validated`
--   (src/lib/crm/call-rate-service.ts, src/lib/crm/rep-visits-data.ts) or calls phoenix_crm_set_team_start
--   is deployed — the old code never names either, so it is safe on either shape, and the new code needs
--   both. 20261002142118_phoenix_crm_plans_everywhere.sql follows it.
--
-- WHY: from 3 October the Delta (1) reps plan and log in Phoenix CRM only, and every screen outside it
--   (field-work compliance, Reps List and KPIs, the Business Review, Employee 360, Early Birds, the
--   outstation visit workload, probation double visits) reads crm_visits_unified — which until now held
--   iReports360 rows only. They would have read as idle.
--
-- ROLLBACK (roll the CODE back first — it names the appended column and the writer; the old code works
--   on either shape):
--   begin;
--   -- A view cannot lose a column by `create or replace`, so both views are dropped and re-created:
--   drop view if exists public.crm_visits_checkin_flags;
--   drop view if exists public.crm_visits_unified;
--   -- re-apply crm_visits_unified from 20260925150000_drop_crm_native_pilot_tables.sql and
--   -- crm_visits_checkin_flags from 20260914000000_crm_unify_vendor_reads.sql (with its revokes), then:
--   drop function if exists public.phoenix_crm_set_team_start(jsonb);
--   drop function if exists public.phoenix_crm_started_team_reps();
--   drop function if exists public.phoenix_crm_started_team_seats();
--   drop table if exists public.phoenix_crm_team_start_notices;  -- SAFE: only the once-per-team notice claims
--   drop table if exists public.phoenix_crm_team_starts;  -- SAFE: only the team start dates this file wrote
--   notify pgrst, 'reload schema';
--   commit;
--   To take ONE team back to iReports360 without dropping anything, press Stop on it on the CRM hub —
--   the stop is a date on its row, it sticks, and every reader returns to that team's vendor rows from
--   it on the next read.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This file deletes and rewrites no data. It changes WHAT EVERY CRM READER RETURNS for a started team,
-- including the money-adjacent ones: the field-work compliance matrix and the CRM no-activity, DSM
-- no-record and holiday-bridge deductions connectors that read the same rows, the attendance CRM day
-- maps that cancel a fingerprint deduction, and the outstation visit workload. It only stops a working
-- rep reading as idle there; it writes, approves and publishes no deduction, allowance or payroll row.

begin;
set local lock_timeout = '5s';

-- ── 1. The team starts ──────────────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_team_starts (
  id uuid primary key default gen_random_uuid(),
  -- The district-manager seat (au.seats) the team's territories hang from. Not a person.
  team_seat_id text not null,
  -- The Saturday the team is counted from Phoenix CRM.
  starts_on date not null,
  -- The Saturday it is counted from iReports360 again; null while the start runs.
  stops_on date,
  -- The owner's own ruling (Delta (1)), or the Super Admin's Start on the CRM hub.
  started_by text not null,
  started_by_hr_id text,
  started_at timestamptz not null default now(),
  stopped_by_hr_id text,
  stopped_at timestamptz,
  note text,
  constraint phoenix_crm_team_starts_saturday check (extract(isodow from starts_on) = 6),
  constraint phoenix_crm_team_starts_stop_saturday check (stops_on is null or extract(isodow from stops_on) = 6),
  constraint phoenix_crm_team_starts_stop_after_start check (stops_on is null or stops_on > starts_on),
  constraint phoenix_crm_team_starts_started_by check (started_by in ('owner_ruling', 'super_admin')),
  constraint phoenix_crm_team_starts_stop_recorded check ((stops_on is null) = (stopped_at is null))
);

-- At most one RUNNING start per team. A team that was stopped may be started again, from a Saturday on
-- or after its stop — phoenix_crm_set_team_start refuses any overlap, so a day is never in two starts.
create unique index if not exists phoenix_crm_team_starts_one_running
  on public.phoenix_crm_team_starts (team_seat_id) where stops_on is null;

comment on table public.phoenix_crm_team_starts is
  'Each START of a TEAM (the territories under one district-manager seat, keyed by that seat): the '
  'Saturday it is counted from Phoenix CRM instead of iReports360 on every other screen, and the Saturday '
  'it stops (owner, 2026-10-02). Delta (1) is seeded from his ruling; every other team only by the Super '
  'Admin''s Start on the CRM hub (phoenix_crm_set_team_start, the one writer). crm_visits_unified reads it.';

alter table public.phoenix_crm_team_starts enable row level security;
revoke all on table public.phoenix_crm_team_starts from public, anon, authenticated;
revoke all on table public.phoenix_crm_team_starts from service_role;
-- The app READS it (the CRM hub shows it to the Super Admin) and writes only through the function below.
grant select on table public.phoenix_crm_team_starts to service_role;

-- The owner's ruling, 2026-10-02: Delta (1)'s three teams count from Phoenix CRM from Saturday
-- 3 October 2026 — NOT the week of 26 September, although the Delta day activities of Thursday
-- 1 October exist, and never anything that drops their real iReports360 visits of 30 September.
-- Only seats that exist are seeded, and a team that already has a row is left exactly as it is.
insert into public.phoenix_crm_team_starts (team_seat_id, starts_on, started_by, note)
select s.seat_id,
       date '2026-10-03',
       'owner_ruling',
       'Owner''s ruling, 2026-10-02: Delta (1) is counted from Phoenix CRM from its first Phoenix week, Saturday 3 October 2026.'
  from au.seats s
 where s.seat_id in ('SEAT-AIF-DM-D1', 'SEAT-CNS-DM-D1', 'SEAT-PED-DM-D1')
   and not exists (select 1 from public.phoenix_crm_team_starts t where t.team_seat_id = s.seat_id);

-- ── 2. The one writer: start, stop, cancel ────────────────────────────────────────────────────────

-- p: { action: 'start' | 'stop', team_seat_id, day (a Saturday; required to start, optional to stop),
--      actor_hr_id, actor_login_id }. Answers the row as it now stands, with what was done: 'started',
--      'stopped' or 'cancelled' (a start not reached yet, or a stop on its own first Saturday, is taken
--      back whole — its row is deleted, so no day was ever counted from Phoenix by it).
-- THE MONTH FLOOR: no start and no stop reaches back before the first day of the current Cairo month.
-- THE AUDIT ROW is written here, in the same transaction as the change, so a start or a stop can never
-- land without it: who, which team, and the row before and after.
create or replace function public.phoenix_crm_set_team_start(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_action text := coalesce(p ->> 'action', '');
  v_team text := nullif(btrim(coalesce(p ->> 'team_seat_id', '')), '');
  v_day date := nullif(p ->> 'day', '')::date;
  v_actor text := upper(nullif(btrim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_login text := nullif(btrim(coalesce(p ->> 'actor_login_id', '')), '');
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_floor date := date_trunc('month', (now() at time zone 'Africa/Cairo'))::date;
  v_row public.phoenix_crm_team_starts%rowtype;
  v_before jsonb;
begin
  if v_action not in ('start', 'stop') or v_team is null or v_actor is null then
    raise exception 'phoenix_crm_team_start:bad_input';
  end if;
  -- Only a team with territories can be started; one the organogram has since emptied can still be stopped.
  if v_action = 'start'
     and not exists (select 1 from au.seats s where s.parent_seat_id = v_team and s.seat_tier = 'REP') then
    raise exception 'phoenix_crm_team_start:no_team';
  end if;
  if v_day is not null and extract(isodow from v_day) <> 6 then
    raise exception 'phoenix_crm_team_start:not_saturday';
  end if;
  if v_day is not null and v_day < v_floor then
    raise exception 'phoenix_crm_team_start:before_month';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:team_start:' || v_team));

  if v_action = 'start' then
    if v_day is null then
      raise exception 'phoenix_crm_team_start:bad_input';
    end if;
    if exists (select 1 from public.phoenix_crm_team_starts t where t.team_seat_id = v_team and t.stops_on is null) then
      raise exception 'phoenix_crm_team_start:already_started';
    end if;
    -- A team started again begins on or after its last stop: no day is ever in two starts.
    if exists (select 1 from public.phoenix_crm_team_starts t where t.team_seat_id = v_team and t.stops_on > v_day) then
      raise exception 'phoenix_crm_team_start:overlaps';
    end if;
    insert into public.phoenix_crm_team_starts (team_seat_id, starts_on, started_by, started_by_hr_id)
    values (v_team, v_day, 'super_admin', v_actor)
    returning * into v_row;
    insert into public.audit_logs (actor_login_id, entity_type, entity_id, summary, new_values)
    values (coalesce(v_login, v_actor), 'crm_phoenix_team_start', v_team,
            'Team counted from Phoenix CRM from ' || to_char(v_day, 'Dy DD Mon YYYY'), to_jsonb(v_row));
    return to_jsonb(v_row) || jsonb_build_object('done', 'started');
  end if;

  select t.* into v_row
    from public.phoenix_crm_team_starts t
   where t.team_seat_id = v_team and t.stops_on is null
   for update;
  if not found then
    raise exception 'phoenix_crm_team_start:not_started';
  end if;
  v_before := to_jsonb(v_row);

  -- Not reached yet, or stopped on its own first Saturday: no day was ever counted from Phoenix by it,
  -- so it is taken back whole. A start that began in an earlier month can never get here: the stop day
  -- would have to be on or before it, and the month floor refuses that.
  if v_row.starts_on > v_today or (v_day is not null and v_day <= v_row.starts_on) then
    if v_row.starts_on < v_floor then
      raise exception 'phoenix_crm_team_start:before_month';
    end if;
    delete from public.phoenix_crm_team_starts t where t.id = v_row.id;
    insert into public.audit_logs (actor_login_id, entity_type, entity_id, summary, old_values)
    values (coalesce(v_login, v_actor), 'crm_phoenix_team_start', v_team,
            'Team start of ' || to_char(v_row.starts_on, 'Dy DD Mon YYYY') || ' taken back', v_before);
    return v_before || jsonb_build_object('done', 'cancelled');
  end if;

  if v_day is null then
    raise exception 'phoenix_crm_team_start:bad_input';
  end if;
  update public.phoenix_crm_team_starts t
     set stops_on = v_day,
         stopped_by_hr_id = v_actor,
         stopped_at = now()
   where t.id = v_row.id
  returning * into v_row;
  insert into public.audit_logs (actor_login_id, entity_type, entity_id, summary, old_values, new_values)
  values (coalesce(v_login, v_actor), 'crm_phoenix_team_start', v_team,
          'Team back on iReports360 from ' || to_char(v_day, 'Dy DD Mon YYYY'), v_before, to_jsonb(v_row));
  return to_jsonb(v_row) || jsonb_build_object('done', 'stopped');
end;
$$;

comment on function public.phoenix_crm_set_team_start(jsonb) is
  'The one writer of phoenix_crm_team_starts: start a team from a Saturday, stop it from a Saturday, or take back a start not reached yet — never before the first day of the current Cairo month — and write its audit row in the same transaction. Service role only; the route in front of it is Super Admin only.';

revoke execute on function public.phoenix_crm_set_team_start(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_set_team_start(jsonb) to service_role;

-- ── 3. The once-per-team notice claim ─────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_team_start_notices (
  -- The team (district-manager seat) the Super Admin was told about. One row per team, ever.
  team_seat_id text primary key,
  -- The first real weekly plan sent on one of its territories while it had no start.
  plan_id uuid not null,
  rep_hr_id text,
  week_start date not null,
  created_at timestamptz not null default now()
);

comment on table public.phoenix_crm_team_start_notices is
  'One row per team: the first real weekly plan sent on a territory whose team was not counted from '
  'Phoenix CRM. The app inserts it BEFORE telling the Super Admin, so a team is told about once (owner, 2026-10-02).';

alter table public.phoenix_crm_team_start_notices enable row level security;
revoke all on table public.phoenix_crm_team_start_notices from public, anon, authenticated;
revoke all on table public.phoenix_crm_team_start_notices from service_role;
grant select, insert on table public.phoenix_crm_team_start_notices to service_role;

-- ── 4. Who and where, for the views ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER because the organogram's tables (au.seats, au.occupancy_history) are not granted to
-- the service role, while the views are security_invoker and read by it.

-- Every territory of a started team, once per start, with the days of that start: [starts_on, stops_on).
create or replace function public.phoenix_crm_started_team_seats()
returns table (seat_id text, team_seat_id text, starts_on date, stops_on date)
language sql
stable
security definer
set search_path to 'public'
rows 60
as $$
  select s.seat_id, s.parent_seat_id, t.starts_on, t.stops_on
    from public.phoenix_crm_team_starts t
    join au.seats s on s.parent_seat_id = t.team_seat_id and s.seat_tier = 'REP'
$$;

revoke execute on function public.phoenix_crm_started_team_seats() from public, anon, authenticated;
grant execute on function public.phoenix_crm_started_team_seats() to service_role;

-- Every person who sat on one of those territories — or on the team's own district-manager seat (owner,
-- 2026-10-02: "Yes, the whole team") — within a start, for exactly the days he sat there within it:
-- [counted_from, counted_until), counted_until null while both still run. The same occupancy rule for the
-- manager as for his reps, read from the seat history, never a list of names. hr_key is the lower-cased
-- hr id, the same key on both sides of the match; agent_crm_id is his CRM id, for the vendor rows that
-- carry no hr id.
create or replace function public.phoenix_crm_started_team_reps()
returns table (seat_id text, hr_id text, hr_key text, agent_crm_id bigint, counted_from date, counted_until date)
language sql
stable
security definer
set search_path to 'public'
rows 60
as $$
  select w.seat_id,
         btrim(o.occupant_hr_id),
         lower(btrim(o.occupant_hr_id)),
         person.agent_crm_id,
         greatest(o.effective_from, w.starts_on),
         least(o.effective_to, w.stops_on)
    from (
      select territory.seat_id, territory.starts_on, territory.stops_on
        from public.phoenix_crm_started_team_seats() territory
      union all
      -- The team's own district-manager seat: his own iReports360 rows stop counting with his team's.
      select t.team_seat_id, t.starts_on, t.stops_on
        from public.phoenix_crm_team_starts t
    ) w
    join au.occupancy_history o on o.seat_id = w.seat_id
    left join lateral (
      select case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end as agent_crm_id
        from public.employees e
       where upper(btrim(e.hr_id)) = upper(btrim(o.occupant_hr_id))
       order by e.hr_id
       limit 1
    ) person on true
   where nullif(btrim(o.occupant_hr_id), '') is not null
     and (least(o.effective_to, w.stops_on) is null
          or least(o.effective_to, w.stops_on) > greatest(o.effective_from, w.starts_on))
$$;

revoke execute on function public.phoenix_crm_started_team_reps() from public, anon, authenticated;
grant execute on function public.phoenix_crm_started_team_reps() to service_role;

-- ── 5. The read door ───────────────────────────────────────────────────────────────────────────────
-- The iReports360 branch is 20260925150000's, word for word, with TWO clauses added (the started teams'
-- reps within a start: by hr id, and by CRM id on a row with no hr id) and the appended column, null on
-- every vendor row. The two Phoenix branches are new. The first 30 columns keep their names, types and
-- order, so every caller's projection keeps working.
create or replace view public.crm_visits_unified
  with (security_invoker = true)
as
select
  v.id,
  v.crm_visit_id,
  v.visit_date,
  v.agent_crm_id,
  v.agent_name,
  v.agent_hr_id,
  v.double_crm_id,
  v.double_name,
  v.double_hr_id,
  v.contact_crm_id,
  v.contact_name,
  v.customer_name,
  v.comment,
  v.visit_type,
  v.visit_type_description,
  v.call_type,
  v.ampm,
  v.attendance,
  v.crm_save_date,
  v.raw_payload,
  v.synced_at,
  v.created_at,
  v.updated_at,
  v.visit_date_time,
  v.crm_region_id,
  v.crm_region_name,
  v.speciality,
  v.crm_contact_grade,
  'ireports360'::text as source,
  v.agent_crm_id as exclusion_crm_id,
  null::boolean as phoenix_customer_validated
from public.ireports360_visits v
where v.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)
  -- Within a start, a started team's rep is counted from Phoenix CRM only.
  and not exists (
    select 1
      from public.phoenix_crm_started_team_reps() r
     where r.hr_key = lower(btrim(v.agent_hr_id))
       and v.visit_date >= r.counted_from
       and (r.counted_until is null or v.visit_date < r.counted_until)
  )
  -- A vendor row the sync could not give an hr id is still his, by his CRM id.
  and not exists (
    select 1
      from public.phoenix_crm_started_team_reps() r
     where nullif(btrim(v.agent_hr_id), '') is null
       and r.agent_crm_id = v.agent_crm_id
       and v.visit_date >= r.counted_from
       and (r.counted_until is null or v.visit_date < r.counted_until)
  )
union all
select
  p.id,
  -1 - ('x' || substr(md5(p.id::text), 1, 13))::bit(52)::bigint,
  p.visit_date,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  agent.full_name,
  coalesce(p.rep_hr_id, p.manager_hr_id),
  case when p.rep_hr_id is not null and manager.crm_id ~ '^[0-9]+$' then manager.crm_id::bigint end,
  case when p.rep_hr_id is not null then manager.full_name end,
  case when p.rep_hr_id is not null then p.manager_hr_id end,
  customer.reference_contact_crm_id,
  customer.name,
  null::text,
  p.comment,
  0,
  'Regular Visit'::text,
  null::integer,
  p.list_type,
  null::integer,
  (p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  -- When the row reached the server — NEVER phoenix_crm_visits.synced_at, which is the offline-capture
  -- fact golden rule #1 keeps off every rep-facing read (tests/phoenix-crm-blind-half.test.ts).
  p.created_at,
  p.created_at,
  p.created_at,
  (p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::integer,
  null::text,
  customer.speciality,
  customer.grade,
  'phoenix'::text,
  coalesce(case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end, -1::bigint),
  p.customer_validated
from public.phoenix_crm_countable_visits p
join public.phoenix_crm_started_team_seats() team
  on team.seat_id = p.seat_id
 and p.visit_date >= team.starts_on
 and (team.stops_on is null or p.visit_date < team.stops_on)
join public.phoenix_crm_customers customer on customer.id = p.customer_id
-- One row per person whatever the casing, so a person can never double a visit.
left join (
  select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, e.crm_id, e.full_name
    from public.employees e
   order by upper(btrim(e.hr_id)), e.hr_id
) agent on agent.hr_key = upper(btrim(coalesce(p.rep_hr_id, p.manager_hr_id)))
left join (
  select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, e.crm_id, e.full_name
    from public.employees e
   order by upper(btrim(e.hr_id)), e.hr_id
) manager on manager.hr_key = upper(btrim(p.manager_hr_id))
-- phoenix_crm_countable_visits is the module's one predicate for "this visit counts" (an off-plan visit
-- only once approved) — read, never re-typed. Its other half, customer_validated (owner, 2026-10-01), is
-- CARRIED rather than filtered: a working rep's visit to a customer he has not validated yet is still a
-- day's work for every "did he work" reader, and the call rate leaves it out of the rate by the column.
where not p.is_test
union all
select
  a.id,
  -1 - ('x' || substr(md5(a.id::text), 1, 13))::bit(52)::bigint,
  a.activity_date,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  agent.full_name,
  a.rep_hr_id,
  null::bigint,
  null::text,
  null::text,
  null::bigint,
  null::text,
  null::text,
  -- A sales day reads as iReports360 carried one: code -7, its comment beginning "Sales day".
  case when a.activity_type = 'sales_day' then btrim('Sales day ' || coalesce(a.note, '')) else a.note end,
  case a.activity_type
    when 'meeting' then -11
    when 'conference' then -1
    when 'health_day' then -15
    when 'sales_day' then -7
    when 'training' then -9
    when 'admin_work' then -20
    when 'travel' then -12
  end,
  case a.activity_type
    when 'meeting' then 'Meeting'
    when 'conference' then 'Conference'
    when 'health_day' then 'Health Day'
    when 'sales_day' then 'Sales day'
    when 'training' then 'Training'
    when 'admin_work' then 'Admin Work'
    when 'travel' then 'Traveling'
  end,
  null::integer,
  null::text,
  null::integer,
  (a.created_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  a.created_at,
  a.created_at,
  a.updated_at,
  a.activity_date::timestamp at time zone 'UTC',
  null::integer,
  null::text,
  null::text,
  null::text,
  'phoenix'::text,
  coalesce(case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end, -1::bigint),
  null::boolean
from public.phoenix_crm_day_activities a
join public.phoenix_crm_started_team_seats() team
  on team.seat_id = a.seat_id
 and a.activity_date >= team.starts_on
 and (team.stops_on is null or a.activity_date < team.stops_on)
left join (
  select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, e.crm_id, e.full_name
    from public.employees e
   order by upper(btrim(e.hr_id)), e.hr_id
) agent on agent.hr_key = upper(btrim(a.rep_hr_id))
-- A RECORDED day activity (never a planned one), real, of a kind this branch names: a kind the module
-- adds later is left out until it is given its worked-day code here.
where not a.is_test
  and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel');

comment on view public.crm_visits_unified is
  'Every CRM visit the read door serves: iReports360 rows, and — for a team in phoenix_crm_team_starts, '
  'within its start — that team''s Phoenix CRM visits and recorded day activities INSTEAD of its reps'' '
  'iReports360 rows (owner, 2026-10-02). Phoenix rows: real only, source ''phoenix'', negative crm_visit_id; '
  'a visit is countable, visit_type 0, ampm = the customer''s list; a day activity carries its worked-day '
  'code. phoenix_customer_validated says whether a visit''s customer is validated yet (null otherwise). '
  'See supabase/migrations/20261002123958_phoenix_crm_visits_everywhere.sql.';

-- ── 6. The check-in flags: a Phoenix row is its own check-in ───────────────────────────────────────
-- 20260914000000's view but for two things: the Phoenix branch of the CASE, which looked for a Phoenix
-- row in crm_checkins_unified — there is none, and there will be none (the rep's location is never shown
-- back as a check-in) — and `v.*`, now spelled out as the 30 columns it expanded to, so the column
-- appended to crm_visits_unified above does not change this view's shape.
create or replace view public.crm_visits_checkin_flags
  with (security_invoker = true)
as
select
  v.id,
  v.crm_visit_id,
  v.visit_date,
  v.agent_crm_id,
  v.agent_name,
  v.agent_hr_id,
  v.double_crm_id,
  v.double_name,
  v.double_hr_id,
  v.contact_crm_id,
  v.contact_name,
  v.customer_name,
  v.comment,
  v.visit_type,
  v.visit_type_description,
  v.call_type,
  v.ampm,
  v.attendance,
  v.crm_save_date,
  v.raw_payload,
  v.synced_at,
  v.created_at,
  v.updated_at,
  v.visit_date_time,
  v.crm_region_id,
  v.crm_region_name,
  v.speciality,
  v.crm_contact_grade,
  v.source,
  v.exclusion_crm_id,
  ck.has_checkin,
  (v.visit_type = 0 and not ck.has_checkin) as regular_no_checkin
from public.crm_visits_unified v
cross join lateral (
  select case
    when v.source = 'phoenix' then true
    else exists (
      select 1
        from public.crm_checkins_unified c
       where c.source = 'ireports360'
         and c.agent_crm_id = v.agent_crm_id
         and c.contact_crm_id = v.contact_crm_id
         and c.check_date >= v.visit_date::timestamp
         and c.check_date < (v.visit_date + 1)::timestamp
    )
  end as has_checkin
) ck;

comment on view public.crm_visits_checkin_flags is
  'crm_visits_unified plus has_checkin and regular_no_checkin. A flag only: a regular visit with no GPS check-in stays regular (owner decisions 1 and 7). A Phoenix CRM row is its own check-in: a visit is captured live, a day activity is no call.';

revoke all on table public.crm_visits_unified from anon, authenticated;
revoke all on table public.crm_visits_checkin_flags from anon, authenticated;

notify pgrst, 'reload schema';

commit;
