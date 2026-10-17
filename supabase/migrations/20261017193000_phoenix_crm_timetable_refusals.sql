-- phoenix_crm_timetable_refusals
--
-- WHAT THIS CHANGES:
--   phoenix_crm_refused_readings.reason accepts two more values, 'timetable_unreadable' and
--   'timetable_missing', beside 'no_fix', 'rough', 'off_listing' and 'blocked'. The table gains one
--   nullable column, shared_place_id, naming the BUILDING whose timetable was refused, and a CHECK
--   pairs the two: the two timetable reasons carry it, every other reason leaves it null. One partial
--   index serves the count the door asks before every seating. No policy, no grant and no row is
--   touched.
--
-- WHY:
--   Owner, 2026-10-17 (in chat): the timetable photo of a polyclinic must be read on the spot "like a
--   scanner" — an unreadable photo is retaken there and then, never accepted and called unreadable
--   afterwards — and it must not block the rep endlessly: "3 tries then held to confirmation by admin".
--   Measured that morning on production: 0 of 70 customers seated in polyclinics passed the timetable
--   read; 22 photos showed no timetable at all (a street, a pavement, a corridor floor) and 45 were
--   read as unreadable and let through as if they matched.
--
--   The door counts a rep's refused timetable photos of ONE building on ONE Cairo day, and the third
--   is saved and held instead of refused again. The building is the key, not the customer: the
--   timetable is the building's one board, and a brand-new customer has no id to count against. The
--   refused photo's pointer is kept (photo_path), as every other refusal here keeps its own.
--
-- ROLLBACK:
--   delete from public.phoenix_crm_refused_readings
--     where reason in ('timetable_unreadable', 'timetable_missing');
--   drop index if exists public.phoenix_crm_refused_readings_timetable_idx;
--   alter table public.phoenix_crm_refused_readings
--     drop constraint if exists phoenix_crm_refused_readings_shared_place_check;
--   alter table public.phoenix_crm_refused_readings
--     drop constraint phoenix_crm_refused_readings_reason_check;
--   alter table public.phoenix_crm_refused_readings
--     add constraint phoenix_crm_refused_readings_reason_check
--     check (reason = any (array['no_fix'::text, 'rough'::text, 'off_listing'::text, 'blocked'::text]));
--   alter table public.phoenix_crm_refused_readings drop column shared_place_id;
--   Additive in full: it widens one CHECK, adds one nullable column, one CHECK over it and one index.
--   Dropping the column loses only the timetable refusals recorded since it was applied.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This writes no rows and deletes nothing.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_refused_readings
  add column if not exists shared_place_id uuid
    references public.phoenix_crm_shared_places (id) on delete set null;

comment on column public.phoenix_crm_refused_readings.shared_place_id is
  'The building whose TIMETABLE photo was refused, for reason timetable_unreadable / timetable_missing only. Null for every other reason. See src/lib/phoenix-crm/schedule-rules.ts, scheduleDoorAction.';

alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_reason_check;

alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_reason_check
  check (reason = any (array[
    'no_fix'::text,
    'rough'::text,
    'off_listing'::text,
    'blocked'::text,
    'timetable_unreadable'::text,
    'timetable_missing'::text
  ]));

-- Half of the pairing is stated here: no other reason may carry a building. The other half — a
-- timetable row always names one — is the writer's (`recordTimetableRefusal` refuses to write
-- without it), deliberately NOT a CHECK: `on delete set null` must be able to run when a TEST venue
-- is cleared (scripts/phoenix-crm-clear-test-rows.ts), and a CHECK requiring the column would turn
-- that clearing into a constraint failure. Real venues are retired, never deleted.
alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_shared_place_check;

alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_shared_place_check
  check (
    reason = any (array['timetable_unreadable'::text, 'timetable_missing'::text])
    or shared_place_id is null
  );

-- The door's count: this rep, this building, this Cairo day.
create index if not exists phoenix_crm_refused_readings_timetable_idx
  on public.phoenix_crm_refused_readings (shared_place_id, rep_hr_id, visit_date)
  where shared_place_id is not null;

notify pgrst, 'reload schema';

commit;
