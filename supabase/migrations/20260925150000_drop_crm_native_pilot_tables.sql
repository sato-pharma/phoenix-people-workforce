-- Retire the Phoenix CRM native-visit pilot's own tables (2026-09-14/16 pilot, ended 2026-09-25).
--
-- Nothing in the app reads or writes any of these eight tables any more: the pilot's visit entry,
-- on-behalf entry, roster and plans backend and API routes are deleted, and every production row
-- count checked at 0 immediately before this migration was written. crm_native_visit_pilots is NOT
-- touched here -- it holds 3 real rows and its own original migration (20260914170000) says to keep
-- it forever as pilot history; the two vacation_day_request(s) tables are the live vacation-day-work
-- feature and are also untouched.
--
-- Three live reporting views (20260913230000_crm_cutover.sql) each union the vendor mirror with a
-- second branch reading crm_native_visits / crm_native_visit_partners / crm_native_plans /
-- crm_native_plan_items, gated on visit_date/plan_date >= crm_cutover.cutover_date. That date has
-- always been null (the CRM cutover was never switched on) and, with the whole native-visit pilot
-- retired, never will be -- so that branch has never returned a row and never will. Each view is
-- rewritten below to the vendor-only branch alone, with its column list, names and types byte-for-
-- byte unchanged, so crm_visits_checkin_flags (which reads crm_visits_unified.* and
-- crm_checkins_unified) needs no change and every caller's output is unaffected. crm_cutover itself
-- and its cutover_date column are untouched -- isOnOrAfterCrmCutover() still gates the live
-- vacation-day-work dormant/active check.
--
-- Rollback: re-apply the two SELECT branches and the eight CREATE TABLE statements from
--   supabase/migrations/20260913170000_crm_native_visits_pilot.sql
--   supabase/migrations/20260913210000_crm_native_rep_plans_pilot.sql
--   supabase/migrations/20260913230000_crm_cutover.sql (the three view definitions)
--   supabase/migrations/20260914170000_phoenix_crm_pilot_reps.sql

begin;

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
where v.visit_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date);

comment on view public.crm_visits_unified is
  'Every CRM visit the read door serves: iReports360 only, now that the Phoenix native-visit pilot is retired (2026-09-25). Kept as a view, not inlined, so nothing that reads it has to change.';

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
);

comment on view public.crm_checkins_unified is
  'Every GPS check-in the read door serves: iReports360 only, now that the Phoenix native-visit pilot is retired (2026-09-25).';

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
where pe.plan_date is null or pe.plan_date < coalesce((select c.cutover_date from public.crm_cutover c where c.id), 'infinity'::date);

comment on view public.crm_plan_entries_unified is
  'Every CRM plan entry the read door serves: iReports360 only, now that the Phoenix native-visit pilot is retired (2026-09-25).';

drop table if exists public.crm_native_visit_partners;
drop table if exists public.crm_native_visit_events;
drop table if exists public.crm_native_visits;

drop table if exists public.crm_native_plan_items;
drop table if exists public.crm_native_plan_events;
drop table if exists public.crm_native_plans;

drop table if exists public.crm_native_pilot_rep_events;
drop table if exists public.crm_native_pilot_reps;

notify pgrst, 'reload schema';

commit;
