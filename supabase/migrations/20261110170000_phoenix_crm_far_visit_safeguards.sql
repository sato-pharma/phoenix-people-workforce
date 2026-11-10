-- phoenix_crm_far_visit_safeguards
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_refused_readings learns a tenth reason, 'impossible_travel': a place reading refused at
--      validation because the rep could not have reached it from his own last saved visit, or because it
--      repeats a point already refused that way. It may carry distance_meters (the metres from that visit),
--      exactly as far_from_place does, and never place_id.
--   2. A new table, phoenix_crm_far_visit_holds: a rep's visit saved and HELD for the SFE instead of refused,
--      after five far refusals from one tight spot on the same customer that day. One row per visit.
--   3. phoenix_crm_countable_visits and phoenix_crm_countable_visits_with_history leave out a visit whose
--      hold is not approved — the same shape as the recording review beside it.
--
-- WHY (owner, 10 Nov 2026, after Momen Fathy's Dr. Doria Darraz was saved 8.3 km from her clinic from an
--   indoor Wi-Fi guess and every visit to her was refused at her door): "how to avoid these issues so they
--   never happen again?" — he chose all four safeguards (src/lib/phoenix-crm/far-visit-safeguards.ts).
--
-- WHAT DOES NOT CHANGE: no existing row is touched, no visit is re-judged, and until the first hold row is
--   written the two views return exactly the rows they return today. A hold row is written only by the
--   server's rep save, BEFORE the visit itself (the visit's id is known up front), so a held visit is never
--   counted for an instant. No foreign key to phoenix_crm_visits for that reason: a hold whose save then
--   failed names a visit that does not exist, and no reader joins on it.
--
-- ROLLBACK:
--   Re-run the two view statements of 20261107044742 / 20261107044059 (the views without the held clause),
--   then: drop table public.phoenix_crm_far_visit_holds;
--   delete from public.phoenix_crm_refused_readings where reason = 'impossible_travel';
--   and re-add the two constraints below with their previous bodies (read live 10 Nov 2026 and kept in this
--   file's comments). Production has NO point-in-time recovery — 7 daily backups are the whole recovery
--   story; this file writes no rows and deletes nothing.

begin;
set local lock_timeout = '5s';

-- 1. The tenth refusal reason ---------------------------------------------------------------------------------
-- Previous body: check (reason = any (array['no_fix','rough','off_listing','blocked','timetable_unreadable',
--   'timetable_missing','signboard_unreadable','signboard_no_plate','far_from_place']))

alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_reason_check;
alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_reason_check
  check (reason = any (array[
    'no_fix'::text, 'rough'::text, 'off_listing'::text, 'blocked'::text,
    'timetable_unreadable'::text, 'timetable_missing'::text,
    'signboard_unreadable'::text, 'signboard_no_plate'::text,
    'far_from_place'::text, 'impossible_travel'::text
  ]));

-- Previous body: check (reason = 'far_from_place' or (place_id is null and distance_meters is null))
alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_far_from_place_check;
alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_far_from_place_check
  check (
    reason = 'far_from_place'::text
    or (reason = 'impossible_travel'::text and place_id is null)
    or (place_id is null and distance_meters is null)
  );

-- The repeat rule reads a rep's own impossible points of the last six hours.
create index if not exists phoenix_crm_refused_readings_impossible_idx
  on public.phoenix_crm_refused_readings (rep_hr_id, refused_at desc)
  where reason = 'impossible_travel';

-- 2. The held visit -------------------------------------------------------------------------------------------

create table if not exists public.phoenix_crm_far_visit_holds (
  visit_id uuid primary key,
  seat_id text not null,
  rep_hr_id text not null,
  customer_id uuid not null,
  -- The place the visit was measured to, and the metres and the line it was past.
  place_id uuid,
  distance_meters integer,
  far_meters integer not null,
  -- How many far refusals from the same spot came before it, and where that spot is.
  tries integer not null,
  spot_lat double precision,
  spot_lon double precision,
  visit_date date not null,
  is_test boolean not null default false,
  status text not null default 'sfe_pending',
  held_at timestamptz not null default now(),
  decided_by_hr_id text,
  decided_at timestamptz,
  decision_note text,
  constraint phoenix_crm_far_visit_holds_status check (status = any (array['sfe_pending'::text, 'approved'::text, 'refused'::text])),
  constraint phoenix_crm_far_visit_holds_decided check ((status = 'sfe_pending') = (decided_at is null) and (decided_at is null) = (decided_by_hr_id is null)),
  constraint phoenix_crm_far_visit_holds_tries check (tries between 1 and 1000),
  constraint phoenix_crm_far_visit_holds_note check (decision_note is null or char_length(decision_note) <= 500)
);

create index if not exists phoenix_crm_far_visit_holds_pending_idx
  on public.phoenix_crm_far_visit_holds (held_at desc)
  where status = 'sfe_pending';

alter table public.phoenix_crm_far_visit_holds enable row level security;
drop policy if exists phoenix_crm_far_visit_holds_service_role on public.phoenix_crm_far_visit_holds;
create policy phoenix_crm_far_visit_holds_service_role
  on public.phoenix_crm_far_visit_holds for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_far_visit_holds from public, anon, authenticated;
grant all on table public.phoenix_crm_far_visit_holds to service_role;

-- 3. The countable views leave a held visit out until the SFE approves it ------------------------------------
-- The live bodies (read 10 Nov 2026), each with ONE clause added after the recording review. A hashed NOT IN over the
-- table's primary key, never a join, for the reason the off-plan IN above it gives (no NULL can be in it).

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
    coalesce(c.validated_at is not null or c.list_type = 'Pharmacy', false) as customer_validated,
    v.product_manager_hr_id,
    v.imported_from_ireports360_at,
    v.ireports360_checkin_id,
    v.ireports360_kpi_counted,
    v.archived_at
  from public.phoenix_crm_visits v
  left join public.phoenix_crm_customers c on c.id = v.customer_id
  where (
      not v.is_unplanned
      or v.id in (
        select uv.visit_id from public.phoenix_crm_unplanned_visits uv where uv.status = 'approved'
      )
      or v.unplanned_kind = 'out_of_list'
    )
    and not exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = v.id and r.review_status <> 'approved'
    )
    -- 🔴 A VISIT HELD FOR THE SFE COUNTS ONCE THE SFE APPROVES IT (owner, 10 Nov 2026). Beside the recording
    -- review, its twin; before the import filter, which stays the view's last words.
    and v.id not in (
      select h.visit_id from public.phoenix_crm_far_visit_holds h where h.status <> 'approved'
    )
    and (v.imported_from_ireports360_at is null or v.ireports360_kpi_counted)
    and v.archived_at is null;

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

create or replace view public.phoenix_crm_countable_visits_with_history
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
    coalesce(c.validated_at is not null or c.list_type = 'Pharmacy', false) as customer_validated,
    v.product_manager_hr_id,
    v.imported_from_ireports360_at,
    v.ireports360_checkin_id,
    v.ireports360_kpi_counted,
    v.archived_at
  from public.phoenix_crm_visits v
  left join public.phoenix_crm_customers c on c.id = v.customer_id
  where (
      not v.is_unplanned
      or v.id in (
        select uv.visit_id from public.phoenix_crm_unplanned_visits uv where uv.status = 'approved'
      )
      or v.unplanned_kind = 'out_of_list'
    )
    and not exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = v.id and r.review_status <> 'approved'
    )
    and v.id not in (
      select h.visit_id from public.phoenix_crm_far_visit_holds h where h.status <> 'approved'
    )
    and v.archived_at is null;

revoke all on table public.phoenix_crm_countable_visits_with_history from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits_with_history to service_role;

notify pgrst, 'reload schema';
commit;

-- READBACK (reads only):
--   select count(*) from public.phoenix_crm_countable_visits;               -> the same as before the apply
--   select count(*) from public.phoenix_crm_countable_visits_with_history;  -> the same as before the apply
--   select count(*) from public.phoenix_crm_far_visit_holds;                     -> 0
