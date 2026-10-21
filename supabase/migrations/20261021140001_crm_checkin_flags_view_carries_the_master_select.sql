-- crm_checkin_flags_view_carries_the_master_select
--
-- WHAT THIS CHANGES: public.crm_visits_checkin_flags gains 32 columns, APPENDED after regular_no_checkin:
--   double2_crm_id, double2_name, double2_hr_id  (the chain visit's second manager)
--   and the 29 Phoenix visit-detail columns crm_visits_unified has carried since 20261008010000
--   (visit_kind … phoenix_synced_at — the list src/lib/crm/phoenix-visit-detail.ts calls
--   PHOENIX_VISIT_DETAIL_COLUMNS). Every existing column keeps its name, type and position; the
--   WHERE-shape, the lateral has_checkin test, security_invoker and the grants are restated unchanged.
--   phoenix_customer_validated stays out, exactly as it did: nothing asks the flags view for it.
--
-- WHY: #5499 (8 Oct 2026) made CRM Master's VISIT_SELECT ask for those 32 columns on EVERY visit
--   dataset, and two of the datasets — "Regular · No Check-in" and "Regular · DV No Check-in" — read this
--   view, which 20261002123958 had deliberately frozen to 30 spelled-out columns plus its two flags. A
--   missing column fails the WHOLE PostgREST read, so both tabs (and their export, which uses the same
--   select) have answered an error on every open for 13 days. Found in the 24-hour Postgres log audit of
--   21 Oct 2026: crm_visits_checkin_flags.double2_crm_id does not exist, 42703, once at 21:04 Cairo on 20 Oct.
--
-- ROLLBACK: the view has no dependents, so  drop view public.crm_visits_checkin_flags;  and then re-run
--   section 6 of 20261002123958_phoenix_crm_visits_everywhere.sql (its create, comment and revoke) puts the
--   30 + 2 column shape back. Nothing is lost either way — it is a view — but CRM Master's two
--   Regular · No Check-in tabs would fail again until the code stops asking for the extra columns.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: a view definition, no rows touched.

begin;

-- `create or replace view` takes a new column only at the END and replaces reloptions wholesale, so the
-- security_invoker option is restated and the new columns follow regular_no_checkin.
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
  (v.visit_type = 0 and not ck.has_checkin) as regular_no_checkin,
  -- appended 20261021140001: the chain visit's second manager …
  v.double2_crm_id,
  v.double2_name,
  v.double2_hr_id,
  -- … and the Phoenix visit detail, in crm_visits_unified's own order.
  v.visit_kind,
  v.entered_by_hr_id,
  v.products,
  v.samples_given,
  v.product_availability,
  v.objection,
  v.objection_note,
  v.next_step,
  v.next_step_on,
  v.visit_pharmacy_name,
  v.is_unplanned,
  v.unplanned_kind,
  v.photo_path,
  v.voice_note_path,
  v.voice_note_seconds,
  v.lat,
  v.lon,
  v.accuracy_meters,
  v.distance_meters,
  v.location_flag,
  v.photo_lat,
  v.photo_lon,
  v.photo_accuracy_meters,
  v.dwell_seconds,
  v.form_open_seconds,
  v.capture_source,
  v.offline_seconds,
  v.device_skew_minutes,
  v.phoenix_synced_at
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
  'crm_visits_unified plus has_checkin and regular_no_checkin. A flag only: a regular visit with no GPS check-in stays regular (owner decisions 1 and 7). A Phoenix CRM row is its own check-in: a visit is captured live, a day activity is no call. Carries every column CRM Master''s VISIT_SELECT asks for (the second manager and the Phoenix visit detail, appended 20261021140001) — a column the page asks for and this view lacks fails the whole read.';

revoke all on table public.crm_visits_checkin_flags from anon, authenticated;

notify pgrst, 'reload schema';

commit;
