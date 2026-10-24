-- crm_plan_door_narrows_on_the_plan_day_group_key
--
-- WHAT:     public.crm_plan_entries_unified returns its Phoenix day from the grouped plan-day subquery
--           (pd.plan_date) instead of from the items table (i.plan_date), in the five places that read it:
--           the day column, the month and year derived from it, and the two bounds of the rep's spell. The
--           two columns are equal by the join on the line below them, so every value, column, name, type,
--           order and grant is unchanged; no row is written and no figure changes.
-- WHY:      20261024002000 made the door fast for ONE DAY and slow for a RANGE, which is what the plan
--           screen actually reads. Measured on production 24 Oct 2026, mean over 185 calls: 1,428 ms, max
--           17,787 ms, against 66-191 ms on each of the four windows before it. A predicate on a grouping
--           column is pushed INTO the grouped subquery; one on the items table is not, and Postgres
--           propagates only an EQUALITY across i.plan_date = pd.plan_date, never a range. So
--           "plan_date = <day>" reached the group-by and stayed fast, while
--           "plan_date >= a and plan_date <= b" grouped all 14,037 items and ran the status function for
--           every one of the ~1,128 plan-days in the company to answer one rep's week.
-- HOW:      One expression, five times: pd.plan_date in place of i.plan_date. The range then lands on a
--           group key and is pushed below the aggregate - the plan shows
--           "Index Cond: ((plan_date >= $1) AND (plan_date <= $2))" inside the GroupAggregate, 290 groups
--           instead of 1,128, and it survives a generic plan (force_generic_plan), which is what PostgREST
--           sends. Everything else is 20261024002000, word for word.
--           Measured warm, best of two, on production: the plan screen's own shape (a week plus
--           agent_hr_id) 112.7 -> 39.3 ms; a range-only week 159.2 -> 89.5 ms; the single-day shape
--           22.3 -> 22.4 ms and the whole-view count 1,080 -> 999 ms, both unchanged.
--           Identity proven company-wide: 203,190 rows live and 203,190 new, 0 rows either way under
--           "except all".
-- ROLLBACK: re-apply 20261024002000_crm_plan_door_reads_each_plan_day_status_once.sql - and expect the
--           range regression back with it.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story. This file
-- writes no row: it replaces one view's definition.

begin;
set local lock_timeout = '5s';

create or replace view public.crm_plan_entries_unified
  with (security_invoker = true)
as
with reps as materialized (
  select * from public.phoenix_crm_started_team_reps()
)
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
      from reps r
     where r.hr_key = lower(btrim(pe.agent_hr_id))
       and pe.plan_date >= r.counted_from
       and (r.counted_until is null or pe.plan_date < r.counted_until)
  )
  -- A plan row the mirror left without an hr id is still his, by his CRM id.
  and not exists (
    select 1
      from reps r
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
  pd.plan_date,
  extract(month from pd.plan_date)::smallint,
  extract(year from pd.plan_date)::smallint,
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
  -- The week's verification as it stands NOW - the vendor's own 1 / 0, the same on every day of a plan.
  (case when pd.status_now = 'approved' then 1 else 0 end)::smallint,
  null::jsonb,
  greatest(pl.updated_at, i.updated_at),
  i.created_at,
  i.updated_at,
  'phoenix'::text
from public.phoenix_crm_plans pl
-- One answer per plan-day, not per plan item: a day carries about a dozen items, and the status asks the
-- plan's event log. The functions take the day through min(), so the planner must evaluate them once per
-- group - written on the plain column it pushed the filter below the grouping and called the function for
-- every item again.
--
-- 🔴 THE DAY THIS BRANCH RETURNS IS pd.plan_date, NOT i.plan_date, AND THAT IS WHAT MAKES A RANGE READ
-- NARROW. A predicate on a grouping column is pushed INTO this subquery; one on the items table is not,
-- and Postgres propagates only an EQUALITY across the i.plan_date = pd.plan_date join below, never a
-- range. While this branch returned i.plan_date, "plan_date = <one day>" reached the group-by and
-- "plan_date >= a and plan_date <= b" did not - so a range grouped every plan item in the company and
-- ran the status function for every plan-day to answer one rep's week (1,428 ms mean on production,
-- 24 Oct 2026). The two columns are equal by that join, so no value changes.
join (
  select
    x.plan_id,
    x.plan_date,
    -- SENT AS OF THAT DAY: by the end of that Cairo day, or by now for a day still to come.
    public.phoenix_crm_plan_day_status(
      x.plan_id,
      min(x.plan_date),
      least(now(), (min(x.plan_date) + 1)::timestamp at time zone 'Africa/Cairo')
    ) as status_that_day,
    -- The week's verification as it stands NOW.
    public.phoenix_crm_plan_day_status(x.plan_id, min(x.plan_date), now()) as status_now
  from public.phoenix_crm_plan_items x
  group by x.plan_id, x.plan_date
) pd on pd.plan_id = pl.id
join public.phoenix_crm_plan_items i on i.plan_id = pd.plan_id and i.plan_date = pd.plan_date
-- The rep who sat on the territory that day, within the team's start - the same people and days the
-- iReports360 branch above leaves out.
join reps r
  on r.seat_id = pl.seat_id
 and pd.plan_date >= r.counted_from
 and (r.counted_until is null or pd.plan_date < r.counted_until)
join public.phoenix_crm_customers customer on customer.id = i.customer_id
where not pl.is_test
  and pd.status_that_day is not null;

revoke all on table public.crm_plan_entries_unified from anon, authenticated;

notify pgrst, 'reload schema';

commit;
