-- The CRM cutover (CRM phase 5): the one dated switch from iReports360 to Phoenix's own visits and plans.
--
-- WHAT THIS IS. Owner decision 17 is one cutover date for everyone, after the one-week Pedia pilot.
-- Decision 19 keeps the vendor copy read-only and joins it BY DATE. This migration builds that join
-- and leaves it switched OFF: `crm_cutover.cutover_date` is seeded null, and while it is null every
-- view below returns exactly the vendor rows it returns today and no native row at all. Nothing
-- changes for any report, KPI, deduction, probation count or payroll input until the owner sets a
-- date — and setting the date is a separate, announced production step (docs/crm-cutover-runbook.md).
--
-- WHAT IS HERE.
--   crm_cutover               one row. `cutover_date` is the first day Phoenix is the record: vendor
--                             rows BEFORE it, native rows ON AND AFTER it, never both for one day.
--                             `vendor_sync_retired_at` stands every vendor pull down (the poller, the
--                             four cron routes and the manual sync buttons read it); it cannot be set
--                             without a date.
--   legacy_id columns         a plain counter on crm_native_visits, crm_native_plans and
--                             crm_native_plan_items, so a native row gets a NEGATIVE stand-in for the
--                             vendor's numeric id. Every vendor id in production is positive (smallest
--                             visit 1103751, check-in 396140, plan 24335, plan entry 8548343), so the
--                             two can never collide, and a counter cannot collide with itself the way a
--                             hash of the uuid could.
--   crm_visits_unified        ireports360_visits before the date UNION ALL live native visits from it.
--   crm_checkins_unified      ireports360_checkins before the date UNION ALL native visits that carry a
--                             captured GPS fix (a missing fix is a flag, never a refusal — decision 7 —
--                             so it simply has no check-in, exactly like a vendor visit with none).
--   crm_plan_entries_unified  ireports360_plan_entries before the date UNION ALL live native plan items
--                             from it, on every plan that has been sent (a draft is not a filed plan).
--
-- SHAPE. Each view carries its base table's columns in the base table's order, plus `source`
-- ('ireports360' or 'phoenix'). The visits and check-ins views also carry `exclusion_crm_id`: the
-- read door's resigned-agent filter is `not in (…)`, and `null not in (…)` is null, so a native rep
-- with no CRM id would silently vanish from every read if the filter ran on agent_crm_id. The
-- column lists are EXPLICIT: a column added to a base table later is not exposed here until these
-- views are recreated, which is deliberate — `select *` would change a view's shape under a live read.
--
-- TIMESTAMPS. Vendor timestamps are Cairo wall clock labelled UTC; native ones are true UTC. The native
-- branch converts to the vendor's convention, `(t at time zone 'Africa/Cairo') at time zone 'UTC'`, so
-- one column never mixes the two.
--
-- NATIVE VALUES THE VENDOR SHAPE NEEDS.
--   agent_crm_id     employees.crm_id when it is a number, else null (exclusion_crm_id is then -1).
--   agent_name       employees.full_name.
--   double_*         the first partner who CONFIRMED, the direct manager first. A pending or rejected
--                    partner is not a double visit: the partner decides (decision 10).
--   visit_type       the legacy code the phase-3 check constraint already holds; the description is the
--                    vendor's own label for that code, and 'Unknown' where the vendor itself says so.
--   ampm             shift. customer_name the campaign prospect. crm_region_name the rep's area.
--   plan_status      1 once the manager verified the plan, else 0.
--   call_type, attendance, crm_region_id, raw_payload, start_am, start_pm, plan_frequency: null.
--
-- RLS on the table; nothing on any of the four is granted to anon or authenticated. The views are
-- security_invoker, so they can never read more than the caller could.

begin;

create table if not exists public.crm_cutover (
  id boolean primary key default true,
  cutover_date date,
  vendor_sync_retired_at timestamptz,
  note text,
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint crm_cutover_singleton check (id),
  constraint crm_cutover_retire_needs_date check (vendor_sync_retired_at is null or cutover_date is not null)
);

comment on table public.crm_cutover is
  'The one CRM cutover setting. cutover_date null = iReports360 is still the record for everyone. Set only through the cutover runbook, with the owner''s approval.';

insert into public.crm_cutover (id, cutover_date, vendor_sync_retired_at, note, updated_by)
values (true, null, null, 'No cutover date set. iReports360 stays the record until the owner sets one (decision 17).', 'migration')
on conflict (id) do nothing;

alter table public.crm_cutover enable row level security;
revoke all on table public.crm_cutover from anon, authenticated;

alter table public.crm_native_visits add column if not exists legacy_id bigint generated by default as identity;
alter table public.crm_native_plans add column if not exists legacy_id integer generated by default as identity;
alter table public.crm_native_plan_items add column if not exists legacy_id bigint generated by default as identity;

create unique index if not exists crm_native_visits_legacy_id_uidx on public.crm_native_visits (legacy_id);
create unique index if not exists crm_native_plans_legacy_id_uidx on public.crm_native_plans (legacy_id);
create unique index if not exists crm_native_plan_items_legacy_id_uidx on public.crm_native_plan_items (legacy_id);

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
  v.agent_crm_id as exclusion_crm_id
from public.ireports360_visits v
where v.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)
union all
select
  n.id,
  -n.legacy_id,
  n.visit_date,
  case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end,
  e.full_name,
  n.hr_id,
  partner.crm_id,
  partner.partner_name,
  partner.partner_hr_id,
  n.contact_crm_id,
  n.contact_name,
  n.prospect_name,
  n.comment,
  n.legacy_visit_type,
  case n.legacy_visit_type
    when 0 then 'Regular Visit'
    when -8 then 'Campaign (Prospection)'
    when -1 then 'Conference'
    when -2 then 'Group Meeting'
    when -4 then 'Annual Vacation'
    when -9 then 'Training'
    when -11 then 'Meeting'
    when -12 then 'Traveling'
    when -15 then 'Health Day'
    else 'Unknown'
  end,
  null::integer,
  n.shift,
  null::integer,
  (n.device_recorded_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  n.updated_at,
  n.created_at,
  n.updated_at,
  (n.device_recorded_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::integer,
  n.area_name,
  n.contact_speciality,
  n.contact_grade,
  'phoenix'::text,
  coalesce(case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end, -1)
from public.crm_native_visits n
left join public.employees e on e.hr_id = n.hr_id
left join lateral (
  select
    p.partner_hr_id,
    p.partner_name,
    case when pe.crm_id ~ '^[0-9]+$' then pe.crm_id::bigint end as crm_id
  from public.crm_native_visit_partners p
  left join public.employees pe on pe.hr_id = p.partner_hr_id
  where p.visit_id = n.id and p.status = 'confirmed'
  order by p.is_direct_manager desc, p.decided_at, p.id
  limit 1
) partner on true
where n.deleted_at is null
  and n.visit_date >= (select c.cutover_date from public.crm_cutover c where c.id);

comment on view public.crm_visits_unified is
  'Every CRM visit the read door serves: iReports360 before crm_cutover.cutover_date, Phoenix native visits from it. Vendor rows only while no date is set.';

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
union all
select
  n.id,
  -n.legacy_id,
  case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end,
  n.hr_id,
  n.contact_crm_id,
  coalesce(n.contact_name, n.prospect_name),
  n.latitude,
  n.longitude,
  n.gps_address,
  (n.device_recorded_at at time zone 'Africa/Cairo') at time zone 'UTC',
  null::jsonb,
  n.updated_at,
  n.created_at,
  n.updated_at,
  'phoenix'::text,
  coalesce(case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end, -1)
from public.crm_native_visits n
left join public.employees e on e.hr_id = n.hr_id
where n.deleted_at is null
  and n.gps_status = 'captured'
  and n.visit_date >= (select k.cutover_date from public.crm_cutover k where k.id);

comment on view public.crm_checkins_unified is
  'Every GPS check-in the read door serves: iReports360 before the cutover date (Cairo midnight), native visits with a captured fix from it.';

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
-- A monthly plan carries no date; it stays a vendor row whatever the cutover says.
where pe.plan_date is null
   or pe.plan_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date)
union all
select
  -i.legacy_id,
  'weekly'::text,
  -p.legacy_id,
  i.plan_date,
  extract(month from i.plan_date)::smallint,
  extract(year from i.plan_date)::smallint,
  null::smallint,
  case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end,
  p.hr_id,
  i.contact_crm_id,
  i.contact_name,
  i.contact_grade,
  p.area_name,
  i.contact_speciality,
  i.shift,
  null::text,
  null::text,
  (case when p.status = 'verified' then 1 else 0 end)::smallint,
  null::jsonb,
  i.updated_at,
  i.created_at,
  i.updated_at,
  'phoenix'::text
from public.crm_native_plan_items i
join public.crm_native_plans p on p.id = i.plan_id
left join public.employees e on e.hr_id = p.hr_id
where i.removed_at is null
  and p.status <> 'draft'
  and i.plan_date >= (select c.cutover_date from public.crm_cutover c where c.id);

comment on view public.crm_plan_entries_unified is
  'Every plan entry the plan boards serve: iReports360 before the cutover date, sent Phoenix plans from it. Verified = 1, otherwise 0.';

revoke all on table public.crm_visits_unified from anon, authenticated;
revoke all on table public.crm_checkins_unified from anon, authenticated;
revoke all on table public.crm_plan_entries_unified from anon, authenticated;

notify pgrst, 'reload schema';

commit;

-- ROLLBACK. The code reads the three views, so roll the code back FIRST (a read of a missing view
-- degrades to an empty screen, not to the vendor table). Then:
--   begin;
--   drop view if exists public.crm_plan_entries_unified;
--   drop view if exists public.crm_checkins_unified;
--   drop view if exists public.crm_visits_unified;
--   drop index if exists public.crm_native_plan_items_legacy_id_uidx;
--   drop index if exists public.crm_native_plans_legacy_id_uidx;
--   drop index if exists public.crm_native_visits_legacy_id_uidx;
--   alter table public.crm_native_plan_items drop column if exists legacy_id;
--   alter table public.crm_native_plans drop column if exists legacy_id;
--   alter table public.crm_native_visits drop column if exists legacy_id;
--   drop table if exists public.crm_cutover;
--   notify pgrst, 'reload schema';
--   commit;
-- To UNDO A CUTOVER without dropping anything, set the setting back instead — every read returns to
-- vendor rows within a minute:
--   update public.crm_cutover set vendor_sync_retired_at = null, cutover_date = null,
--     updated_by = '<who>', updated_at = now() where id;
