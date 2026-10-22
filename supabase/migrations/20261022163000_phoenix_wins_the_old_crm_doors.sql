-- phoenix_wins_the_old_crm_doors
--
-- WHAT:     On every iReports360 row the three doors serve (visits, check-ins, plan entries), what Phoenix
--           holds REPLACES what the old CRM sent:
--             · the doctor's NAME and SPECIALITY come from his VALIDATED Phoenix CRM customer, when there is
--               one for that vendor contact (new view public.crm_contact_phoenix_truth);
--             · on the visits door, the AGENT and the DOUBLE-VISIT PARTNER print the Phoenix employee's own
--               name whenever the row's hr id resolves, keeping the vendor's "( territory )" suffix.
--           Columns, names, types and order are unchanged; no row is added, dropped or moved between doors,
--           no figure changes, and no data is written.
-- WHY:      Owner, 2026-10-22 04:0x Cairo: "CRM Master page and all crm old sources once got data from phoenix
--           crm then phoenix is the source of trust and its data override old crm data". Measured on
--           production ozucdzovmcqvepbozvqf the same night:
--             · 2,269 vendor contacts have a validated Phoenix customer; 22,857 iReports360 visit rows are
--               to them, and on 15,816 of those the vendor's spelling of the doctor differs from the one his
--               rep validated in Phoenix (22 of them carry a different speciality).
--             · 6,040 iReports360 visits made BEFORE the account's current holder was hired carry the
--               EARLIER holder's hr id, but the vendor's agent_name is the account's current name — when an
--               account changes hands iReports360 relabels the old rows (Osama Mohamed Ali's account,
--               re-assigned to him on 1 Oct 2026, prints his name on 825 visits from May to August). The
--               hr id was right; the printed name was the vendor's.
-- HOW:      · TRUSTED means VALIDATED. A pending or unvalidated reference customer is a copy of the vendor
--               list awaiting a rep's check, and some of those copies name a different doctor (read the same
--               night: contact 71036 is "سمر وديع" in the vendor list and "جاكلين انور" on a pending row), so
--               they override nothing. One doctor on several seats: an active row beats a dropped one, then
--               the latest validation.
--           · The person's name is the employees row the visit branch already reads (one row per person,
--               whatever the casing). A row with NO hr id keeps the vendor label in the door: reconciliation
--               check 9 reads that label through this door and settles a relabelled row by the person it
--               names (src/lib/crm/identity.ts, isSettledUnmappedRow), so the CRM Master prints such a row
--               as "Previous holder" in TypeScript instead (master.ts, relabelHandedOverRows).
--           · The grade is NOT replaced: a grade is a dated period (a regrade is a new period, never an edit,
--               because it sets the frequency norm a month was scored against), and Phoenix's periods
--               already govern from each team's start through crm_contact_assignments.
--           · Each door is its newest definition word for word except those select items and one join:
--               crm_visits_unified 20261021140000, crm_checkins_unified 20261019121747,
--               crm_plan_entries_unified 20261007193000.
-- SPEED:    The truth view is answered from a new partial index of the validated reference rows (2,271
--           rows on production), so a door read pays a small index scan, never a scan of the customer table.
-- ROLLBACK: re-apply section 2 of 20261021140000_crm_visits_unified_group_meeting_and_rtd_worked_day_codes.sql,
--           section 2 of 20261019121747_crm_doors_ask_phoenix_wins_the_day_only_from_its_first_day.sql and
--           section 4 of 20261007193000_crm_doors_carry_every_person_and_every_customer.sql; then
--           `drop view public.crm_contact_phoenix_truth` and
--           `drop index public.phoenix_crm_customers_validated_reference_idx`.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This file
-- writes no row: it adds one view and one index and replaces three views' definitions.

begin;
set local lock_timeout = '5s';

-- ── 1. What Phoenix holds about a vendor contact ────────────────────────────────────────────────────
create index if not exists phoenix_crm_customers_validated_reference_idx
  on public.phoenix_crm_customers (reference_contact_crm_id)
  where reference_contact_crm_id is not null
    and validated_at is not null
    and not is_test;

create or replace view public.crm_contact_phoenix_truth
  with (security_invoker = true)
as
select distinct on (c.reference_contact_crm_id)
       c.reference_contact_crm_id as contact_crm_id,
       nullif(btrim(c.name), '') as name,
       nullif(btrim(c.speciality), '') as speciality
  from public.phoenix_crm_customers c
 where c.reference_contact_crm_id is not null
   and c.validated_at is not null
   and not c.is_test
   and c.status in ('active', 'pending', 'dropped')
 order by c.reference_contact_crm_id, (c.status = 'active') desc, c.validated_at desc, c.updated_at desc;

comment on view public.crm_contact_phoenix_truth is
  'One row per iReports360 contact that a VALIDATED Phoenix CRM customer references: the name and '
  'speciality Phoenix holds for him, which replace the vendor''s on every iReports360 row the CRM doors '
  'serve (owner, 2026-10-22: Phoenix is the source of trust and its data override old CRM data). An '
  'active customer beats a dropped one, then the latest validation. '
  'See supabase/migrations/20261022163000_phoenix_wins_the_old_crm_doors.sql.';

revoke all on table public.crm_contact_phoenix_truth from anon, authenticated;

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
  -- PHOENIX NAMES THE PERSON (owner, 2026-10-22): the employee the row's hr id resolves to, with the vendor's
  -- "( territory )" kept so every board that reads the territory off this label still finds it. A row with
  -- no hr id keeps the vendor label here (see the header).
  case when agent_person.full_name is not null then concat_ws(' ', agent_person.full_name, substring(v.agent_name from '(\([^()]*\))\s*$')) else v.agent_name end as agent_name,
  v.agent_hr_id,
  v.double_crm_id,
  case when double_person.full_name is not null then concat_ws(' ', double_person.full_name, substring(v.double_name from '(\([^()]*\))\s*$')) else v.double_name end as double_name,
  v.double_hr_id,
  v.contact_crm_id,
  -- PHOENIX NAMES THE DOCTOR: his validated Phoenix customer's name and speciality, when he has one.
  coalesce(truth.name, v.contact_name) as contact_name,
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
  coalesce(truth.speciality, v.speciality) as speciality,
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
left join public.crm_contact_phoenix_truth truth on truth.contact_crm_id = v.contact_crm_id
-- One row per person whatever the casing, so a person can never double a visit.
left join (
  select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, nullif(btrim(e.full_name), '') as full_name
    from public.employees e
   order by upper(btrim(e.hr_id)), e.hr_id
) agent_person on agent_person.hr_key = upper(btrim(v.agent_hr_id))
left join (
  select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, nullif(btrim(e.full_name), '') as full_name
    from public.employees e
   order by upper(btrim(e.hr_id)), e.hr_id
) double_person on double_person.hr_key = upper(btrim(v.double_hr_id))
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

-- ── 3. The check-in door ─────────────────────────────────────────────────────────────────────────────
-- 20261019121747's view, word for word, with the doctor's name taken from Phoenix when Phoenix holds him.
create or replace view public.crm_checkins_unified
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
  c.id,
  c.crm_checkin_id,
  c.agent_crm_id,
  c.agent_hr_id,
  c.contact_crm_id,
  coalesce(truth.name, c.contact_name) as contact_name,
  c.lat,
  c.lon,
  c.address,
  c.check_date,
  c.raw_payload,
  c.synced_at,
  c.created_at,
  c.updated_at,
  'ireports360'::text as source,
  c.agent_crm_id as exclusion_crm_id
from (
  -- BEFORE PHOENIX CRM'S FIRST DAY (2026-10-19): the visit door's split, on the check-in's wall-clock day. A
  -- vendor check-in's day is its wall clock as stored (Cairo, labelled UTC — the vendor convention), so a
  -- check-in before that day's midnight "UTC" is on a day before it.
  select x.*
    from public.ireports360_checkins x
   where x.check_date < coalesce(
     (select k.cutover_date::timestamp at time zone 'UTC' from public.crm_cutover k where k.id),
     'infinity'::timestamptz
   )
     and x.check_date < (
       select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)::timestamp at time zone 'UTC'
         from public.phoenix_crm_team_starts t
     )
  union all
  -- FROM PHOENIX CRM'S FIRST DAY — PHOENIX WINS THE DAY, FOR A MEDICAL REP: the same rule as the visit door,
  -- on the same entry days.
  select x.*
    from public.ireports360_checkins x
   where x.check_date < coalesce(
     (select k.cutover_date::timestamp at time zone 'UTC' from public.crm_cutover k where k.id),
     'infinity'::timestamptz
   )
     and x.check_date >= (
       select coalesce(min(least(t.starts_on, coalesce(t.day_activities_from, t.starts_on))), 'infinity'::date)::timestamp at time zone 'UTC'
         from public.phoenix_crm_team_starts t
     )
     and not exists (
       select 1
         from entry_days e
        where e.hr_key = lower(btrim(x.agent_hr_id))
          and e.entry_day = (x.check_date at time zone 'UTC')::date
     )
     -- A check-in the sync could not give an hr id is still his, by his CRM id.
     and not exists (
       select 1
         from entry_days e
        where nullif(btrim(x.agent_hr_id), '') is null
          and e.agent_crm_id = x.agent_crm_id
          and e.entry_day = (x.check_date at time zone 'UTC')::date
     )
) c
left join public.crm_contact_phoenix_truth truth on truth.contact_crm_id = c.contact_crm_id
union all
select
  p.id,
  -1 - ('x' || substr(md5(p.id::text), 1, 13))::bit(52)::bigint,
  case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end,
  coalesce(p.rep_hr_id, p.manager_hr_id),
  -- The same expression as the visit door and the plan door, to the character.
  coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id),
  customer.name,
  p.lat,
  p.lon,
  null::text,
  (p.captured_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  p.created_at,
  p.created_at,
  p.created_at,
  'phoenix'::text,
  coalesce(case when agent.crm_id ~ '^[0-9]+$' then agent.crm_id::bigint end, -1::bigint)
from public.phoenix_crm_countable_visits p
join public.phoenix_crm_started_team_seats() team
  on team.seat_id = p.seat_id
 and p.visit_date >= team.starts_on
 and (team.stops_on is null or p.visit_date < team.stops_on)
join public.phoenix_crm_customers customer on customer.id = p.customer_id
-- One row per person whatever the casing, so a person can never double a check-in.
left join (
  select distinct on (upper(btrim(e.hr_id))) upper(btrim(e.hr_id)) as hr_key, e.crm_id
    from public.employees e
   order by upper(btrim(e.hr_id)), e.hr_id
) agent on agent.hr_key = upper(btrim(coalesce(p.rep_hr_id, p.manager_hr_id)))
-- Real only, and only a visit whose position was read: a check-in is a time AND a place.
where not p.is_test
  and p.lat is not null
  and p.lon is not null;

-- ── 4. The plan door ─────────────────────────────────────────────────────────────────────────────────
-- 20261007193000's view, word for word, with the doctor's name and speciality taken from Phoenix when
-- Phoenix holds him. The planned GRADE stays the vendor's: it is the norm that plan was made against.
create or replace view public.crm_plan_entries_unified
  with (security_invoker = true)
as
select
  pe.crm_plan_entry_id,
  pe.plan_kind,
  pe.crm_plan_id,
  pe.plan_date,
  pe.plan_month,
  pe.plan_year,
  pe.plan_frequency,
  pe.agent_crm_id,
  pe.agent_hr_id,
  pe.contact_crm_id,
  coalesce(truth.name, pe.contact_name) as contact_name,
  pe.contact_grade,
  pe.crm_region_name,
  coalesce(truth.speciality, pe.speciality) as speciality,
  pe.ampm,
  pe.start_am,
  pe.start_pm,
  pe.plan_status,
  pe.raw_payload,
  pe.synced_at,
  pe.created_at,
  pe.updated_at,
  'ireports360'::text as source
from public.ireports360_plan_entries pe
left join public.crm_contact_phoenix_truth truth on truth.contact_crm_id = pe.contact_crm_id
where (pe.plan_date is null or pe.plan_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date))
  -- Within a start, a started team's people (its reps and its district manager) are planned from Phoenix
  -- CRM only.
  and not exists (
    select 1
      from public.phoenix_crm_started_team_reps() r
     where r.hr_key = lower(btrim(pe.agent_hr_id))
       and pe.plan_date >= r.counted_from
       and (r.counted_until is null or pe.plan_date < r.counted_until)
  )
  -- A plan row the mirror left without an hr id is still his, by his CRM id.
  and not exists (
    select 1
      from public.phoenix_crm_started_team_reps() r
     where nullif(btrim(pe.agent_hr_id), '') is null
       and r.agent_crm_id = pe.agent_crm_id
       and pe.plan_date >= r.counted_from
       and (r.counted_until is null or pe.plan_date < r.counted_until)
  )
union all
select
  -1 - ('x' || substr(md5(i.id::text), 1, 13))::bit(52)::bigint,
  'weekly'::text,
  -1 - ('x' || substr(md5(pl.id::text), 1, 8))::bit(30)::integer,
  i.plan_date,
  extract(month from i.plan_date)::smallint,
  extract(year from i.plan_date)::smallint,
  null::smallint,
  r.agent_crm_id,
  r.hr_id,
  -- The same expression as the visit door and the check-in door, to the character.
  coalesce(customer.reference_contact_crm_id, customer.own_contact_crm_id),
  customer.name,
  customer.grade,
  null::text,
  customer.speciality,
  i.list_type,
  null::text,
  null::text,
  -- The week's verification as it stands NOW — the vendor's own 1 / 0, the same on every day of a plan.
  (case when public.phoenix_crm_plan_day_status(pl.id, i.plan_date, now()) = 'approved' then 1 else 0 end)::smallint,
  null::jsonb,
  greatest(pl.updated_at, i.updated_at),
  i.created_at,
  i.updated_at,
  'phoenix'::text
from public.phoenix_crm_plan_items i
join public.phoenix_crm_plans pl on pl.id = i.plan_id
-- The rep who sat on the territory that day, within the team's start — the same people and days the
-- iReports360 branch above leaves out.
join public.phoenix_crm_started_team_reps() r
  on r.seat_id = pl.seat_id
 and i.plan_date >= r.counted_from
 and (r.counted_until is null or i.plan_date < r.counted_until)
join public.phoenix_crm_customers customer on customer.id = i.customer_id
where not pl.is_test
  -- SENT AS OF THAT DAY: by the end of that Cairo day, or by now for a day still to come.
  and public.phoenix_crm_plan_day_status(
        pl.id,
        i.plan_date,
        least(now(), (i.plan_date + 1)::timestamp at time zone 'Africa/Cairo')
      ) is not null;

revoke all on table public.crm_visits_unified from anon, authenticated;
revoke all on table public.crm_checkins_unified from anon, authenticated;
revoke all on table public.crm_plan_entries_unified from anon, authenticated;

notify pgrst, 'reload schema';

commit;
