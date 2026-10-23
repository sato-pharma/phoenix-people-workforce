-- crm_plan_door_reads_started_team_reps_once
--
-- WHAT:     public.crm_plan_entries_unified asks phoenix_crm_started_team_reps() ONCE per read instead of
--           three times. Its columns, names, types, order, rows and security are unchanged; no row is
--           written and no figure changes.
-- WHY:      Measured on production ozucdzovmcqvepbozvqf (pg_stat_statements, 23 Oct 2026): the plan door's
--           reads cost about 380 s of database time, and the cause is the function being a security-definer
--           SQL function the planner cannot inline - each of the three calls (two NOT EXISTS on the
--           iReports360 branch, one join on the Phoenix branch) is its own scan of
--           au.occupancy_history joined to the team seats. The set is ~40 rows and does not depend on the
--           row being tested, so one evaluation answers all three.
-- HOW:      A MATERIALIZED common table expression holds the function's rows once; the two NOT EXISTS and
--           the join read it. The view is 20261022163000_phoenix_wins_the_old_crm_doors.sql section 4, word
--           for word, except that the three `public.phoenix_crm_started_team_reps() r` are `reps r`.
--           Predicates a caller adds (plan_date, agent) still push into both branches: the CTE only holds
--           the team set.
-- ROLLBACK: re-apply section 4 of 20261022163000_phoenix_wins_the_old_crm_doors.sql.
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
  (case when public.phoenix_crm_plan_day_status(pl.id, i.plan_date, now()) = 'approved' then 1 else 0 end)::smallint,
  null::jsonb,
  greatest(pl.updated_at, i.updated_at),
  i.created_at,
  i.updated_at,
  'phoenix'::text
from public.phoenix_crm_plan_items i
join public.phoenix_crm_plans pl on pl.id = i.plan_id
-- The rep who sat on the territory that day, within the team's start - the same people and days the
-- iReports360 branch above leaves out.
join reps r
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

revoke all on table public.crm_plan_entries_unified from anon, authenticated;

notify pgrst, 'reload schema';

commit;
