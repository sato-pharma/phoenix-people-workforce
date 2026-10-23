-- countable_visits_customer_join_is_removable
--
-- WHAT THIS CHANGES:
--   public.phoenix_crm_countable_visits joins public.phoenix_crm_customers with a LEFT join instead of
--   an inner one, and customer_validated is coalesced to false. Nothing else in the view moves: the
--   same columns in the same order, the same WHERE, security_invoker kept, the same grants.
-- WHY:
--   Speed (owner, 2026-10-23: "speed up the rep entry-days step in crm_visits_unified").
--   phoenix_crm_rep_entry_days() rebuilds every Phoenix entry day from all of Phoenix CRM's history on
--   every read of crm_visits_unified and crm_checkins_unified, through this view. It never reads
--   customer_validated, yet the inner join made it look up the customer of every visit ever saved —
--   13,569 of its 18,025 buffer reads and most of its 53 ms on 23 October, growing with every visit.
--   Postgres removes a LEFT join to a unique key when the query reads none of that table's columns,
--   so after this the customer is read only by the readers that ask for customer_validated.
--   Measured on production, the function body with the join removable: 27.8 ms and 4,456 buffers,
--   against 45 ms and 18,025 — and the same 541 rows, 0 different either way.
--
--   The rows cannot change. phoenix_crm_visits.customer_id is NOT NULL and carries the foreign key to
--   phoenix_crm_customers(id) (0 visits without their customer on 23 October), so the left join
--   always finds its customer and never null-extends a row. The coalesce keeps customer_validated a
--   two-state column even in that impossible case, so no reader can ever be handed a third state.
--   Only service_role reads the view (it bypasses RLS) and the definer functions run as its owner, so
--   no caller sees fewer customers than visits either.
-- ROLLBACK:
--   Re-run the view block of 20261016161248_phoenix_crm_recorded_visit_waits_for_the_administrator.sql
--   (inner join, uncoalesced column). Reversible at any time; no data is touched.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one read-only view is replaced with the same rows.

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
    -- A pharmacy needs no validation (owner, 2026-10-03); everyone else still does. Coalesced so the
    -- column stays two-state although the join below is a left one.
    coalesce(c.validated_at is not null or c.list_type = 'Pharmacy', false) as customer_validated,
    -- Last, and not by preference: `create or replace view` only accepts an appended column, and this
    -- view has dependents, so it cannot be dropped to put the column beside manager_hr_id where it
    -- belongs. Read it by NAME — never by position.
    v.product_manager_hr_id
  from public.phoenix_crm_visits v
  -- LEFT, so the planner drops this join for every reader that never asks for customer_validated
  -- (phoenix_crm_rep_entry_days above all). It can never null-extend: customer_id is NOT NULL and
  -- carries the foreign key. Never "fix" it back to inner — that restores a customer lookup per visit.
  left join public.phoenix_crm_customers c on c.id = v.customer_id
  left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
  where (not v.is_unplanned or u.status = 'approved' or v.unplanned_kind = 'out_of_list')
    -- A recorded visit counts once the Administrator approves it (owner, 2026-10-16).
    and not exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = v.id and r.review_status <> 'approved'
    );

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

commit;

-- READBACK (reads only):
--   select position('left join phoenix_crm_customers' in pg_get_viewdef('public.phoenix_crm_countable_visits'::regclass)) > 0 as left_join,
--          (select reloptions from pg_class where oid = 'public.phoenix_crm_countable_visits'::regclass) as opts,
--          (select count(*) from public.phoenix_crm_countable_visits) as rows;
--   left_join true, opts {security_invoker=true}, rows unchanged from before the apply.
