-- crm_doors_carry_every_person_and_every_customer
--
-- WHAT THIS CHANGES (owner, 2026-10-07: "every single report that was pulling data from the CRM must
-- stop pulling data from the Go Live teams and pull from the Phoenix CRM … at the end of the day I want
-- everything appearing linkage, nothing show that a drop happened"):
--
--   1. EVERY PERSON WHO WAS ON THE VISIT REACHES THE OLD REPORTS. crm_visits_unified had ONE partner
--      slot and filled it from manager_hr_id alone, so:
--        · a 'product_manager' visit carried NOBODY — manager_hr_id is null on all 18 live ones, which
--          is why Ahmed SharafEldeen's 18 visits of 6-7 October read as a day he did not work;
--        · a 'chain' visit carried the manager and DROPPED the second person (6 product managers and
--          4 seniors on production today).
--      Slot 1 becomes coalesce(manager, product_manager, senior) — which fixes the product-manager
--      visit with NO new column, so every existing reader is repaired where it stands — and a SECOND
--      slot is appended for the chain's other person. Measured shapes on production (743 real visits,
--      2026-10-07): single none 636 · double mgr 75 · product_manager pm 18 · chain mgr+pm 6 ·
--      single mgr 4 (a district manager's own visit, rep_hr_id null) · chain mgr+senior 4. No row has
--      all three columns set, and senior never appears without manager — so at most two people stand
--      beside the rep and two slots carry every one of them.
--      THIS IS PARITY RESTORATION, NOT NEW POLICY: since 1 September iReports360's own partner slot
--      has carried Product Managers (121 rows), a Group Product Manager (11), an RSM (44), a Training
--      Manager (41) and a Marketing Manager (5). The vendor shape always held these people.
--
--   2. EVERY PHOENIX-BORN CUSTOMER GETS A REAL contact_crm_id, SO NO REPORT SILENTLY DROPS HIM.
--      923 of 12,574 Phoenix customers have no reference_contact_crm_id (production, 2026-10-07) and
--      the number grows every day a rep adds a doctor — one rep added 59 since his 3 October start, 16
--      of them with no vendor id. Every per-doctor report keys on contact_crm_id, so each one is a
--      silent drop or a permanent blank on the KPIs board, SFE doctor coverage, plan-vs-actual, the
--      Business Review and the brick punch-list. phoenix_crm_customers gains own_contact_crm_id out of
--      crm_contacts_phoenix_id_seq — THE RESERVED POSITIVE RANGE 1,000,000,000-2,000,000,000 created by
--      20260914020000 for exactly this, never yet drawn from (is_called false) — and all THREE doors
--      emit coalesce(reference_contact_crm_id, own_contact_crm_id).
--
-- WHY POSITIVE AND NOT A NEGATIVE SYNTHETIC ID. A negative id breaks three live constraints:
--   crm_contacts_real_contact (contact_crm_id > 0), direct_order_pharmacies_crm_contact_id_positive,
--   and ireports360_crm_customer_brick_resolutions.crm_contact_id which is INTEGER — a 52-bit negative
--   compares fine but cannot be inserted (22003 numeric field overflow), turning a permanent blank into
--   a permanent error. Under the reserved range ZERO positivity guards in TypeScript change, the
--   crm_contacts foreign key and all three PostgREST embeds are untouched, and the vendor id space tops
--   out at 109,791 so the two can never meet.
--
-- WHY ALL THREE DOORS IN ONE TRANSACTION: a visit that carries an id against a plan that does not reads
--   MISSED, which is worse than the blank it replaces. Visits, plans and check-ins move together or not
--   at all.
--
-- WHY A CUSTOMER CAN NEVER BE RE-POINTED AFTERWARDS: once he has carried his own id into a report,
--   setting reference_contact_crm_id would restate a month somebody has already read. The trigger
--   phoenix_crm_customers_no_late_reference refuses it.
--
-- ROLLBACK:
--   Re-run the crm_visits_unified block of 20261002123958, the crm_plan_entries_unified and
--   crm_checkins_unified blocks of 20261002142118, then drop the trigger, the function, the unique
--   index, the check constraint and the column. The column is additive and nothing writes it, so
--   dropping it loses no recorded fact.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This writes ONE new column on 12,574 rows of phoenix_crm_customers and changes no existing value.

begin;
set local lock_timeout = '5s';

-- ── 1. Every Phoenix customer owns an id in the reserved range ──────────────────────────────────────
-- Added nullable, backfilled, then made NOT NULL with its default: an ADD COLUMN carrying a volatile
-- default rewrites the table anyway, and spelling the backfill out makes what each row receives
-- reviewable instead of implied.
alter table public.phoenix_crm_customers
  add column if not exists own_contact_crm_id bigint;

update public.phoenix_crm_customers
   set own_contact_crm_id = nextval('public.crm_contacts_phoenix_id_seq')
 where own_contact_crm_id is null;

alter table public.phoenix_crm_customers
  alter column own_contact_crm_id set default nextval('public.crm_contacts_phoenix_id_seq'),
  alter column own_contact_crm_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.phoenix_crm_customers'::regclass
       and conname = 'phoenix_crm_customers_own_contact_crm_id_reserved'
  ) then
    alter table public.phoenix_crm_customers
      add constraint phoenix_crm_customers_own_contact_crm_id_reserved
      check (own_contact_crm_id between 1000000000 and 2000000000);
  end if;
end $$;

create unique index if not exists phoenix_crm_customers_own_contact_crm_id_key
  on public.phoenix_crm_customers (own_contact_crm_id);

comment on column public.phoenix_crm_customers.own_contact_crm_id is
  'The contact_crm_id this customer answers to in every report outside Phoenix CRM, drawn from the '
  'reserved positive range 1,000,000,000-2,000,000,000 (crm_contacts_phoenix_id_seq, created by '
  '20260914020000 for exactly this). The three doors emit '
  'coalesce(reference_contact_crm_id, own_contact_crm_id), so a doctor a rep added in Phoenix CRM is a '
  'real row in every per-doctor report instead of a silent drop. Positive on purpose: three live '
  'constraints and one integer column refuse a negative id. Never changed once issued.';

-- ── 2. A customer who has carried his own id can never be re-pointed ───────────────────────────────
-- Setting reference_contact_crm_id later would change the id a published month was computed against.
-- Clearing it, or filling it on a customer created in the same breath, stays allowed.
create or replace function public.phoenix_crm_customers_no_late_reference()
returns trigger
language plpgsql
as $$
begin
  if new.reference_contact_crm_id is distinct from old.reference_contact_crm_id
     and old.reference_contact_crm_id is null
     and new.reference_contact_crm_id is not null then
    raise exception 'phoenix_crm:customer_already_has_own_contact_id'
      using hint = 'This customer already answers to own_contact_crm_id ' || old.own_contact_crm_id
                || ' in every report outside Phoenix CRM. Pointing him at a vendor id now would '
                || 'restate every month already read. Merge the two records instead.';
  end if;
  return new;
end $$;

comment on function public.phoenix_crm_customers_no_late_reference() is
  'Refuses a reference_contact_crm_id arriving AFTER the customer has been issued his own id, because '
  'every report outside Phoenix CRM has already been keyed on it (owner, 2026-10-07: nothing may show '
  'that a change happened).';

drop trigger if exists phoenix_crm_customers_no_late_reference on public.phoenix_crm_customers;
create trigger phoenix_crm_customers_no_late_reference
  before update of reference_contact_crm_id on public.phoenix_crm_customers
  for each row execute function public.phoenix_crm_customers_no_late_reference();

-- ── 3. The visit door: both people, and every customer ─────────────────────────────────────────────
-- 20261002123958's view, with three changes and three appended columns. The first 31 columns keep
-- their names, types and order, so every caller's projection keeps working. The two iReports360
-- clauses and the whole vendor branch are untouched: not one vendor row moves, which is the whole
-- point — the history reads exactly as it always did and the Phoenix rows populate under it.
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
  null::boolean as phoenix_customer_validated,
  -- The second person beside the rep. The vendor shape has one partner column, so it is null on every
  -- vendor row — appended, never inserted, so nothing reading by position moves.
  null::bigint as double2_crm_id,
  null::text as double2_name,
  null::text as double2_hr_id
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
  case when p.rep_hr_id is not null then case when p.manager_hr_id is not null then coalesce(p.senior_hr_id, p.product_manager_hr_id) when p.product_manager_hr_id is not null then p.senior_hr_id end end
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
  null::boolean,
  null::bigint,
  null::text,
  null::text
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
  'TWO people stand beside the rep: double_* is the manager who rode along, else the product manager, '
  'else the senior; double2_* is the chain''s other person. Both are null on a vendor row, which carries '
  'one partner column. contact_crm_id is the customer''s vendor id, or the id he owns in the reserved '
  'range when he was born in Phoenix CRM — so no per-doctor report drops him (owner, 2026-10-07). '
  'See supabase/migrations/20261007193000_crm_doors_carry_every_person_and_every_customer.sql.';

revoke all on table public.crm_visits_unified from anon, authenticated;

-- ── 4. The plan door: every customer ───────────────────────────────────────────────────────────────
-- 20261002142118's view with ONE expression changed, in step with the visit door above: a visit that
-- carries an id against a plan that does not reads MISSED.
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
  pe.contact_name,
  pe.contact_grade,
  pe.crm_region_name,
  pe.speciality,
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

comment on view public.crm_plan_entries_unified is
  'Every planned call the plan door serves: iReports360 plan entries, and — for a team in '
  'phoenix_crm_team_starts, within its start — that team''s Phoenix weekly plans, day by day as sent, '
  'INSTEAD of its reps'' iReports360 entries (owner, 2026-10-02). Phoenix rows: real only, source '
  '''phoenix'', negative ids, plan_status 1 when the week is approved now. contact_crm_id is the '
  'customer''s vendor id, or the id he owns in the reserved range when he was born in Phoenix CRM — the '
  'same expression as the visit and check-in doors, because a visit with an id against a plan without '
  'one reads MISSED. '
  'See supabase/migrations/20261007193000_crm_doors_carry_every_person_and_every_customer.sql.';

revoke all on table public.crm_plan_entries_unified from anon, authenticated;

-- ── 5. The check-in door: every customer ───────────────────────────────────────────────────────────
-- 20261002142118's view with the same ONE expression changed. Still no accuracy, flag, distance, skew,
-- photo, dwell, capture source or offline column here: a check-in is a time and a place.
create or replace view public.crm_checkins_unified
  with (security_invoker = true)
as
select
  c.id,
  c.crm_checkin_id,
  c.agent_crm_id,
  c.agent_hr_id,
  c.contact_crm_id,
  c.contact_name,
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
from public.ireports360_checkins c
where c.check_date < coalesce(
  (select k.cutover_date::timestamp at time zone 'UTC' from public.crm_cutover k where k.id),
  'infinity'::timestamptz
)
  -- Within a start, a started team's people check in through Phoenix CRM only. A vendor check-in's
  -- day is its wall clock as stored (Cairo, labelled UTC — the vendor convention).
  and not exists (
    select 1
      from public.phoenix_crm_started_team_reps() r
     where r.hr_key = lower(btrim(c.agent_hr_id))
       and (c.check_date at time zone 'UTC')::date >= r.counted_from
       and (r.counted_until is null or (c.check_date at time zone 'UTC')::date < r.counted_until)
  )
  -- A check-in the sync could not give an hr id is still his, by his CRM id.
  and not exists (
    select 1
      from public.phoenix_crm_started_team_reps() r
     where nullif(btrim(c.agent_hr_id), '') is null
       and r.agent_crm_id = c.agent_crm_id
       and (c.check_date at time zone 'UTC')::date >= r.counted_from
       and (r.counted_until is null or (c.check_date at time zone 'UTC')::date < r.counted_until)
  )
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

comment on view public.crm_checkins_unified is
  'Every GPS check-in the read door serves: iReports360 check-ins, and — for a team in '
  'phoenix_crm_team_starts, within its start — each countable Phoenix CRM visit that carries a position, '
  'as that day''s check-in (time and position only), INSTEAD of its people''s iReports360 check-ins '
  '(owner, 2026-10-02). The app reads the Phoenix rows on SFE and manager screens only. contact_crm_id '
  'is the customer''s vendor id, or the id he owns in the reserved range when he was born in Phoenix CRM '
  '— the same expression as the visit and plan doors. '
  'See supabase/migrations/20261007193000_crm_doors_carry_every_person_and_every_customer.sql.';

revoke all on table public.crm_checkins_unified from anon, authenticated;

notify pgrst, 'reload schema';

commit;
