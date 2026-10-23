-- crm_plan_door_reads_each_plan_day_status_once
--
-- WHAT:     public.crm_plan_entries_unified asks phoenix_crm_plan_day_status() once per PLAN-DAY instead of
--           twice per plan item. Its columns, names, types, order, rows and security are unchanged; no row
--           is written and no figure changes.
-- WHY:      After 20261024001000 the team-set function was read once, and a one-month read of the door still
--           took ~1.4 s on production (23 Oct 2026). Its plan showed the cost: the status function ran twice
--           for each of ~14,000 Phoenix plan items (a filter and a column), when only ~1,100 distinct
--           plan-days exist - about a dozen items share each one - and each run reads the plan's event log.
--           Whole door on production: 2,541 ms before, 168 ms after, same 9,946 Phoenix rows.
-- HOW:      A grouped subquery over the plan items computes, for each (plan, day), the status as of that day's
--           end and the status now; the items join it. The arguments go through min(plan_date) on purpose:
--           on the plain column the planner moved the filter below the grouping and called the function per
--           item again. Everything else is 20261024001000, word for word.
-- ROLLBACK: re-apply 20261024001000_crm_plan_door_reads_started_team_reps_once.sql.
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
-- every item again. The caller's own plan_date predicate still pushes into this subquery (a group key).
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
 and i.plan_date >= r.counted_from
 and (r.counted_until is null or i.plan_date < r.counted_until)
join public.phoenix_crm_customers customer on customer.id = i.customer_id
where not pl.is_test
  and pd.status_that_day is not null;

revoke all on table public.crm_plan_entries_unified from anon, authenticated;

notify pgrst, 'reload schema';

commit;
