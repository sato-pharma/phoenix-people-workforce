-- phoenix_crm_pharmacy_needs_no_validation
--
-- WHAT THIS CHANGES:
--   phoenix_crm_countable_visits.customer_validated is now TRUE for a visit to a PHARMACY customer,
--   whatever that pharmacy's validated_at says. Every other customer is unchanged: a doctor or an
--   account still counts only once he is validated and admitted to the list.
--
-- WHY:
--   Owner, 2026-10-03: "Pharmacies doesn't need a validation. Pharmacy don't need a validation. It is
--   visit is logged normally." A pharmacy is a third list (src/lib/phoenix-crm/pharmacy-call-rules.ts)
--   and is in no KPI denominator, so the validation gate that keeps an unvetted doctor out of a call
--   rate protects nothing for it. Until today every pharmacy visit was held back as "not counting yet"
--   because 568 of the 570 imported pharmacies are still `pending` (measured 2026-10-03).
--
--   This is the ONE place the answer is given. `crm_visits_unified.phoenix_customer_validated` reads
--   this column (20261002123958), and every TypeScript KPI reads `customer_validated = true` off this
--   view, so the rule reaches the rep's screens, his managers' screens and the shared reports at once.
--
--   🔴 The column list is written out, NOT `v.*`. `v.*` would expand today to 47 base columns —
--   product_manager_hr_id (20261002205436) arrived after this view was last replaced — and put a new
--   column BEFORE customer_validated, which `create or replace view` refuses. The list below is the
--   view's own, read from pg_attribute on production and staging (identical, 47 columns).
--
-- ROLLBACK: re-run 20261001060500_phoenix_crm_countable_visits_validated.sql's view body with this
--   same explicit column list and `(c.validated_at is not null) as customer_validated`.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change reads and writes no data: it redefines one derived boolean in a view.

begin;
set local lock_timeout = '5s';

create or replace view public.phoenix_crm_countable_visits
with (security_invoker = true) as
  select
    v.id, v.seat_id, v.line_code, v.customer_id, v.list_type, v.visit_date, v.captured_at, v.kind,
    v.rep_hr_id, v.manager_hr_id, v.senior_hr_id, v.entered_by_hr_id, v.products, v.comment,
    v.photo_path, v.lat, v.lon, v.accuracy_meters, v.place_id, v.distance_meters, v.location_flag,
    v.device_skew_minutes, v.is_test, v.created_at, v.pharmacy_name, v.product_availability,
    v.voice_note_path, v.voice_note_seconds, v.voice_note_bytes, v.is_unplanned, v.next_step,
    v.next_step_on, v.objection, v.objection_note, v.samples_given, v.dwell_seconds,
    v.form_open_seconds, v.capture_source, v.time_anchor_id, v.offline_seconds, v.synced_at,
    v.photo_lat, v.photo_lon, v.photo_accuracy_meters, v.photo_captured_at, v.unplanned_kind,
    -- A pharmacy needs no validation (owner, 2026-10-03); everyone else still does.
    (c.validated_at is not null or c.list_type = 'Pharmacy') as customer_validated
  from public.phoenix_crm_visits v
  join public.phoenix_crm_customers c on c.id = v.customer_id
  left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
  where not v.is_unplanned or u.status = 'approved' or v.unplanned_kind = 'out_of_list';

comment on view public.phoenix_crm_countable_visits is
  'Visits that count in a KPI, and the second half of that question beside each one. A row is here '
  'when it was on a sent plan, or it is an off-plan visit the manager and the SFE have approved, or '
  'it is an out-of-list visit (which has no approval of its own). `customer_validated` is the other '
  'half: false until the visit''s customer is validated and admitted to the list — except a PHARMACY, '
  'which needs no validation and is always true (owner, 2026-10-03). A KPI counts only the rows '
  'where it is true. The rep''s own "visits saved here, not counting yet" deliberately does not read '
  'it, because it is counting what he saved rather than what counts. The anti-fraud path reads the '
  'raw table and judges everything.';

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

commit;
