-- crm_plan_door_reads_only_the_rows_it_returns
--
-- WHAT:     public.crm_plan_entries_unified builds its Phoenix rows with the rep ALREADY in the plan-day
--           group, and reads the customer table once per call instead of once per plan item. Every row,
--           column, name, type, order and grant is unchanged; no row is written and no figure changes.
--           The iReports360 branch is 20261024004000 word for word.
-- WHY:      Stage 2a of the infrastructure roadmap (docs/infrastructure, 28 Oct 2026): the database box is
--           swapping, and the two heaviest statements in Phoenix were both this door - ten hr ids over a
--           month (2,455 calls, 191 GB of pages touched since the 25 Oct boot) and fifty CRM ids over a
--           month (1,763 calls, 121 GB). The rep was joined AFTER the plan-day group, so a filter on
--           agent_hr_id or agent_crm_id could not reach the group: one rep's month grouped every plan item
--           in the company for that month and ran the status function for every plan-day, then threw
--           almost all of it away. And each surviving item looked its customer up by index, one at a time.
-- HOW:      Two moves in the Phoenix branch, nothing else.
--           1. The reps join moves INSIDE the grouped subquery, and the rep's own columns join the group
--              key. A filter on agent_hr_id or agent_crm_id is then a filter on a group key, pushed below
--              the aggregate onto the reps scan - only that rep's items are grouped, and the status
--              function runs only for his plan-days. The items travel through the group as arrays and are
--              unnested after it, so the items table is read once, not twice.
--              The reps CTE numbers its rows (rep_row) and the group carries that number, so two reps who
--              share a seat and a day still give one row each - the view's row multiplicity is exactly
--              what it was.
--           2. The customer columns are read through OFFSET 0, so the planner hashes the customer table
--              once (594 pages, 20,748 rows) instead of an index probe for every plan item. A one-rep, one-
--              day read now pays that fixed 594 pages; every shape below still comes out far ahead.
--           Pages touched per call, measured on production 28 Oct 2026 (pg_stat_statements, the exact
--           statement each screen sends, today's view against this body):
--
--             | Shape                      | Today  | This file | Change |
--             | 10 hr ids, October         | 17,954 |     5,887 |  -67 % |
--             | 50 CRM ids, October        | 35,120 |     9,190 |  -74 % |
--             | 1 rep, October             | 10,432 |     2,343 |  -78 % |
--             | company, 1 day             |  5,626 |     3,333 |  -41 % |
--             | 10 hr ids, 1 week          |  6,913 |     2,857 |  -59 % |
--             | 1 rep, 1 week              |  4,238 |     1,989 |  -53 % |
--
--           Identity proven company-wide on production the same night, this body against the live view:
--           10,065 Phoenix rows each, 0 rows either way under "except all", and the same md5 over every
--           row in (crm_plan_entry_id, row text) order on both - 5d78eb0fc213a968393250eca44cab47.
-- ROLLBACK: re-apply 20261024004000_crm_plan_door_narrows_on_the_plan_day_group_key.sql - and expect the
--           pages above back with it.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story. This file
-- writes no row: it replaces one view's definition.

begin;
set local lock_timeout = '5s';

create or replace view public.crm_plan_entries_unified
  with (security_invoker = true)
as
-- rep_row tells apart two rows of the function that are otherwise equal, so the Phoenix group below keeps
-- one row per rep row, as the join after the group did.
with reps as materialized (
  select t.*, row_number() over () as rep_row from public.phoenix_crm_started_team_reps() t
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
  -1 - ('x' || substr(md5(pd.plan_id::text), 1, 8))::bit(30)::integer,
  pd.plan_date,
  extract(month from pd.plan_date)::smallint,
  extract(year from pd.plan_date)::smallint,
  null::smallint,
  pd.agent_crm_id,
  pd.hr_id,
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
  greatest(pd.plan_updated_at, i.updated_at),
  i.created_at,
  i.updated_at,
  'phoenix'::text
-- One answer per plan-day AND REP, not per plan item: a day carries about a dozen items, and the status
-- asks the plan's event log. The functions take the day through min(), so the planner must evaluate them
-- once per group - written on the plain column it pushed the filter below the grouping and called the
-- function for every item again.
--
-- 🔴 THE DAY THIS BRANCH RETURNS IS pd.plan_date, AND ITS REP IS pd.hr_id / pd.agent_crm_id - ALL THREE
-- ARE GROUP KEYS, AND THAT IS WHAT MAKES A READ NARROW. A predicate on a grouping column is pushed INTO
-- this subquery; one on a table joined after it is not, and Postgres propagates only an EQUALITY across
-- a join, never a range or an "= any (…)". While the day came from the items table, a date range grouped
-- every plan item in the company (1,428 ms mean, 24 Oct 2026, fixed by 20261024004000); while the rep
-- was joined after the group, ten hr ids over a month did the same (17,954 pages a call, 28 Oct 2026).
-- Never move any of the three back outside the group.
from (
  select
    x.plan_id,
    x.plan_date,
    r.agent_crm_id,
    r.hr_id,
    p.updated_at as plan_updated_at,
    -- The week's verification as it stands NOW.
    public.phoenix_crm_plan_day_status(x.plan_id, min(x.plan_date), now()) as status_now,
    -- The day's items ride through the group and are unnested below, so the items table is read once.
    array_agg(x.id) as item_ids,
    array_agg(x.customer_id) as customer_ids,
    array_agg(x.list_type) as list_types,
    array_agg(x.created_at) as created_ats,
    array_agg(x.updated_at) as updated_ats
  from public.phoenix_crm_plan_items x
  join public.phoenix_crm_plans p on p.id = x.plan_id and not p.is_test
  -- The rep who sat on the territory that day, within the team's start - the same people and days the
  -- iReports360 branch above leaves out.
  join reps r
    on r.seat_id = p.seat_id
   and x.plan_date >= r.counted_from
   and (r.counted_until is null or x.plan_date < r.counted_until)
  group by x.plan_id, x.plan_date, r.rep_row, r.agent_crm_id, r.hr_id, p.updated_at
  -- SENT AS OF THAT DAY: by the end of that Cairo day, or by now for a day still to come.
  having public.phoenix_crm_plan_day_status(
    x.plan_id,
    min(x.plan_date),
    least(now(), (min(x.plan_date) + 1)::timestamp at time zone 'Africa/Cairo')
  ) is not null
) pd
cross join lateral unnest(pd.item_ids, pd.customer_ids, pd.list_types, pd.created_ats, pd.updated_ats)
  as i(id, customer_id, list_type, created_at, updated_at)
-- OFFSET 0 keeps this a table read once and hashed, not an index probe per plan item.
join (
  select c.id, c.reference_contact_crm_id, c.own_contact_crm_id, c.name, c.grade, c.speciality
    from public.phoenix_crm_customers c
  offset 0
) customer on customer.id = i.customer_id;

revoke all on table public.crm_plan_entries_unified from anon, authenticated;

notify pgrst, 'reload schema';

commit;
