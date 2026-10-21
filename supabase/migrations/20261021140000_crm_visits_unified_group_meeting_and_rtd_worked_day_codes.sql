-- crm_visits_unified_group_meeting_and_rtd_worked_day_codes
--
-- WHAT:     A recorded RTD or Group meeting reaches the iReports360-shaped visits door as a worked day, the way
--           every other recorded day activity already does. Group meeting carries the vendor's own code -2
--           ("Group Meeting", already classified CP in src/lib/crm/visit-type-meaning.ts); RTD takes code -22,
--           a Phoenix-side code the vendor does not send, which that same file now classifies CP.
-- WHY:      Owner, 2026-10-21: "should either one get its own worked-day code for attendance? yes" - after RTD
--           and Group meeting were added to the rep's Record the day screen and the weekly plan
--           (20261021120000, 20261021130000). Until a kind is named in this view, "a kind the module adds later is
--           left out", so the day it records would not read as worked on any door.
-- HOW:      phoenix_crm_rep_entry_days() (20261016201551) and 20261019121747's crm_visits_unified, word for word, with two more WHEN branches in each of the two
--           CASEs and two more kinds in the activity branch's IN list. Columns, names, types and order are
--           unchanged; no row of any other kind moves, and no data is touched.
-- ROLLBACK: re-apply the function from 20261016201551_phoenix_crm_wins_the_day_for_medical_reps.sql and section 1 of
--           20261019121747_crm_doors_ask_phoenix_wins_the_day_only_from_its_first_day.sql.

begin;
set local lock_timeout = '5s';

-- ── 1. The entry days ────────────────────────────────────────────────────────────────────────────────
-- 20261016201551's function, word for word, with the two kinds added to the day-activity branch: a rep who
-- records RTD or a Group meeting has a Phoenix entry for that day, as for every other kind, so Phoenix wins it.
create or replace function public.phoenix_crm_rep_entry_days()
returns table (hr_key text, agent_crm_id bigint, entry_day date)
language sql
stable
security definer
set search_path to 'public'
rows 400
as $$
  with entries as (
    select lower(btrim(p.rep_hr_id)) as hr_key, p.visit_date as entry_day
      from public.phoenix_crm_countable_visits p
      join public.phoenix_crm_started_team_seats() team
        on team.seat_id = p.seat_id
       and p.visit_date >= team.starts_on
       and (team.stops_on is null or p.visit_date < team.stops_on)
     where not p.is_test
       and nullif(btrim(p.rep_hr_id), '') is not null
    union
    select lower(btrim(a.rep_hr_id)), a.activity_date
      from public.phoenix_crm_day_activities a
      join public.phoenix_crm_started_team_seats() team on team.seat_id = a.seat_id
      left join public.phoenix_crm_team_starts run
        on run.team_seat_id = team.team_seat_id
       and run.starts_on = team.starts_on
       and run.stops_on is not distinct from team.stops_on
     where not a.is_test
       and nullif(btrim(a.rep_hr_id), '') is not null
       and a.activity_date >= least(team.starts_on, coalesce(run.day_activities_from, team.starts_on))
       and (team.stops_on is null or a.activity_date < team.stops_on)
       and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel', 'group_meeting', 'rtd')
  )
  select e.hr_key, person.agent_crm_id, e.entry_day
    from entries e
    left join lateral (
      select case when emp.crm_id ~ '^[0-9]+$' then emp.crm_id::bigint end as agent_crm_id
        from public.employees emp
       where upper(btrim(emp.hr_id)) = upper(e.hr_key)
       order by emp.hr_id
       limit 1
    ) person on true
$$;

revoke execute on function public.phoenix_crm_rep_entry_days() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days() to service_role;

-- ── 2. The visits door ───────────────────────────────────────────────────────────────────────────────
create or replace view public.crm_visits_unified
  with (security_invoker = true)
as
-- THE ENTRY DAYS, BUILT ONCE PER READ (2026-10-19). phoenix_crm_rep_entry_days() rebuilds every Phoenix
-- entry day from the whole of Phoenix CRM's history each time it runs, and the two checks below used to run
-- it once each. Materialized, so one read builds it at most once — and only when that read reaches a vendor
-- row dated from Phoenix CRM's first day on.
with entry_days as materialized (
  select e.hr_key, e.agent_crm_id, e.entry_day from public.phoenix_crm_rep_entry_days() e
)
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
  null::boolean as phoenix_customer_validated,
  -- The second person beside the rep. The vendor shape has one partner column, so it is null on every
  -- vendor row — appended, never inserted, so nothing reading by position moves.
  null::bigint as double2_crm_id,
  null::text as double2_name,
  null::text as double2_hr_id,
  -- THE PHOENIX FIELD SET (owner, 2026-10-07: "everything, GPS and evidence included" on the admin
  -- reports). Null on every iReports360 row, because the vendor feed never carried any of it —
  -- appended, never inserted, so nothing reading by position moves. What each READER may see of the
  -- location and timing half is golden rule #1's three tiers, decided per role in TypeScript
  -- (src/lib/crm/phoenix-visit-detail.ts), never by hiding a column here.
  null::text as visit_kind,
  null::text as entered_by_hr_id,
  null::text[] as products,
  null::jsonb as samples_given,
  null::jsonb as product_availability,
  null::text as objection,
  null::text as objection_note,
  null::text as next_step,
  null::date as next_step_on,
  null::text as visit_pharmacy_name,
  null::boolean as is_unplanned,
  null::text as unplanned_kind,
  null::text as photo_path,
  null::text as voice_note_path,
  null::integer as voice_note_seconds,
  null::double precision as lat,
  null::double precision as lon,
  null::numeric as accuracy_meters,
  null::integer as distance_meters,
  null::text as location_flag,
  null::double precision as photo_lat,
  null::double precision as photo_lon,
  null::numeric as photo_accuracy_meters,
  null::integer as dwell_seconds,
  null::integer as form_open_seconds,
  null::text as capture_source,
  null::integer as offline_seconds,
  null::integer as device_skew_minutes,
  null::timestamptz as phoenix_synced_at
from (
  -- BEFORE PHOENIX CRM'S FIRST DAY (2026-10-19): no rep has a Phoenix entry on a day earlier than the first
  -- team start, or than that start's earlier day_activities_from, so "Phoenix wins the day" can drop nothing
  -- there and is not asked. Every read of a July, August or September day used to build every Phoenix entry
  -- day, twice, to learn that. The bound is read live, so a team started later moves nothing.
  select x.*
    from public.ireports360_visits x
   where x.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)
     and x.visit_date < (
       select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)
         from public.phoenix_crm_team_starts t
     )
  union all
  -- FROM PHOENIX CRM'S FIRST DAY — PHOENIX WINS THE DAY, FOR A MEDICAL REP (owner, 2026-10-16): on a day he has
  -- a countable entry in Phoenix CRM his iReports360 row is dropped; on a day he has none, the vendor row
  -- counts. A district manager has no entry day (the function reads rep seats only), so he keeps both.
  select x.*
    from public.ireports360_visits x
   where x.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)
     and x.visit_date >= (
       select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)
         from public.phoenix_crm_team_starts t
     )
     and not exists (
       select 1
         from entry_days e
        where e.hr_key = lower(btrim(x.agent_hr_id))
          and e.entry_day = x.visit_date
     )
     -- A vendor row the sync could not give an hr id is still his, by his CRM id.
     and not exists (
       select 1
         from entry_days e
        where nullif(btrim(x.agent_hr_id), '') is null
          and e.agent_crm_id = x.agent_crm_id
          and e.entry_day = x.visit_date
     )
) v
union all
select
  p.id,
  -1 - ('x' || substr(md5(p.id::text), 1, 13))::bit(52)::bigint,
  p.visit_date,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  agent.full_name,
  coalesce(p.rep_hr_id, p.manager_hr_id),
  case when p.rep_hr_id is not null and partner1.crm_id ~ '^[0-9]+$' then partner1.crm_id::bigint end,
  case when p.rep_hr_id is not null then partner1.full_name end,
  case when p.rep_hr_id is not null then coalesce(p.manager_hr_id, p.product_manager_hr_id, p.senior_hr_id) end,
  -- A doctor a rep added in Phoenix CRM has no vendor id and answers to his own, so no per-doctor
  -- report drops him. 923 of 12,574 customers are in that position today.
  coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id),
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
  p.customer_validated,
  case when p.rep_hr_id is not null and partner2.crm_id ~ '^[0-9]+$' then partner2.crm_id::bigint end,
  case when p.rep_hr_id is not null then partner2.full_name end,
  -- One line, like every other select item: the door's own row-shape pin reads this list a LINE at a
  -- time, so an expression wrapped over six lines counts as six columns and the two branches stop
  -- matching item for item.
  case when p.rep_hr_id is not null then case when p.manager_hr_id is not null then coalesce(p.senior_hr_id, p.product_manager_hr_id) when p.product_manager_hr_id is not null then p.senior_hr_id end end,
  -- THE PHOENIX FIELD SET, in the order the columns were appended. One select item per line: the
  -- door's row-shape pin reads this list a LINE at a time.
  p.kind,
  p.entered_by_hr_id,
  p.products,
  p.samples_given,
  p.product_availability,
  p.objection,
  p.objection_note,
  p.next_step,
  p.next_step_on,
  p.pharmacy_name,
  p.is_unplanned,
  p.unplanned_kind,
  p.photo_path,
  p.voice_note_path,
  p.voice_note_seconds,
  p.lat,
  p.lon,
  p.accuracy_meters,
  p.distance_meters,
  p.location_flag,
  p.photo_lat,
  p.photo_lon,
  p.photo_accuracy_meters,
  p.dwell_seconds,
  p.form_open_seconds,
  p.capture_source,
  p.offline_seconds,
  p.device_skew_minutes,
  p.synced_at
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
-- SLOT 1 — the first person beside the rep, in the order the rep's own form puts them: the manager who
-- rode along, else the product manager (whose visits carried nobody at all before this), else the
-- senior. Taking the product manager here is what repairs every existing reader without a new column.
left join (
  select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, e.crm_id, e.full_name
    from public.employees e
   order by upper(btrim(e.hr_id)), e.hr_id
) partner1 on partner1.hr_key = upper(btrim(coalesce(p.manager_hr_id, p.product_manager_hr_id, p.senior_hr_id)))
-- SLOT 2 — the chain's other person: the senior above the manager, or the product manager who came
-- with him. Never the same person as slot 1, because each column is read once.
left join (
  select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, e.crm_id, e.full_name
    from public.employees e
   order by upper(btrim(e.hr_id)), e.hr_id
) partner2 on partner2.hr_key = upper(btrim(
  case
    when p.manager_hr_id is not null then coalesce(p.senior_hr_id, p.product_manager_hr_id)
    when p.product_manager_hr_id is not null then p.senior_hr_id
  end
))
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
    when 'group_meeting' then -2
    when 'rtd' then -22
  end,
  case a.activity_type
    when 'meeting' then 'Meeting'
    when 'conference' then 'Conference'
    when 'health_day' then 'Health Day'
    when 'sales_day' then 'Sales day'
    when 'training' then 'Training'
    when 'admin_work' then 'Admin Work'
    when 'travel' then 'Traveling'
    when 'group_meeting' then 'Group Meeting'
    when 'rtd' then 'RTD'
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
  null::boolean,
  null::bigint,
  null::text,
  null::text,
  null::text,
  null::text,
  null::text[],
  null::jsonb,
  null::jsonb,
  null::text,
  null::text,
  null::text,
  null::date,
  null::text,
  null::boolean,
  null::text,
  null::text,
  null::text,
  null::integer,
  null::double precision,
  null::double precision,
  null::numeric,
  null::integer,
  null::text,
  null::double precision,
  null::double precision,
  null::numeric,
  null::integer,
  null::integer,
  null::text,
  null::integer,
  null::integer,
  null::timestamptz
from public.phoenix_crm_day_activities a
join (
  select t.seat_id, t.team_seat_id, t.starts_on, t.stops_on from public.phoenix_crm_started_team_seats() t
  union
  -- The manager's OWN seat ("Yes, the whole team"): a district manager has no territory of his own, so
  -- a day he recorded sits on his team seat. phoenix_crm_started_team_reps counts that seat the same way.
  select s.team_seat_id, s.team_seat_id, s.starts_on, s.stops_on from public.phoenix_crm_team_starts s
) team
  on team.seat_id = a.seat_id
left join public.phoenix_crm_team_starts run
  on run.team_seat_id = team.team_seat_id
 and run.starts_on = team.starts_on
 and run.stops_on is not distinct from team.stops_on
left join (
  select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, e.crm_id, e.full_name
    from public.employees e
   order by upper(btrim(e.hr_id)), e.hr_id
) agent on agent.hr_key = upper(btrim(a.rep_hr_id))
-- A RECORDED day activity (never a planned one), real, of a kind this branch names: a kind the module
-- adds later is left out until it is given its worked-day code here.
where not a.is_test
  -- Counted from the team's start, or from its day_activities_from when that is EARLIER (never later).
  and a.activity_date >= least(team.starts_on, coalesce(run.day_activities_from, team.starts_on))
  and (team.stops_on is null or a.activity_date < team.stops_on)
  and a.activity_type in ('meeting', 'conference', 'health_day', 'sales_day', 'training', 'admin_work', 'travel', 'group_meeting', 'rtd');

commit;
