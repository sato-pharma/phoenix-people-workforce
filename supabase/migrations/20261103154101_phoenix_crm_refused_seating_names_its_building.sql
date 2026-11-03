-- phoenix_crm_refused_seating_names_its_building
--
-- WHAT THIS CHANGES:
--   phoenix_crm_refused_readings_shared_place_check also lets a far_from_place row of subject_kind
--   'place' name its building in shared_place_id. No column, function, policy or grant changes, and no
--   existing row is touched.
--
-- WHY:
--   Owner, 3 Nov 2026: seating a doctor in a polyclinic now reads the rep's location silently and refuses
--   it past the far line (visit_far_meters, 300 m) from that building. A refusal creates no place row, so
--   this table is the only record of it, and "which building" is the one thing the SFE needs to read it:
--   Hadeer Abdelnaser Osman Hassan's Dr Farid Shawky was seated in a look-alike building 3.9 km from
--   the door they stood at. The timetable tries stay counted by their two reasons, so a row of this
--   kind can never spend a try (countTimetableRefusals filters on reason).
--
-- ROLLBACK:
--   update public.phoenix_crm_refused_readings set shared_place_id = null
--    where reason = 'far_from_place' and shared_place_id is not null;
--   alter table public.phoenix_crm_refused_readings
--     drop constraint phoenix_crm_refused_readings_shared_place_check;
--   alter table public.phoenix_crm_refused_readings
--     add constraint phoenix_crm_refused_readings_shared_place_check
--     check (reason = any (array['timetable_unreadable'::text, 'timetable_missing'::text]) or shared_place_id is null);
--   Additive in full: it only widens what the table accepts. Production has NO point-in-time recovery
--   and 7 daily backups are the whole recovery story; this writes no rows and deletes nothing.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_shared_place_check;

alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_shared_place_check
  check (
    reason = any (array['timetable_unreadable'::text, 'timetable_missing'::text])
    or (reason = 'far_from_place'::text and subject_kind = 'place'::text)
    or shared_place_id is null
  );

notify pgrst, 'reload schema';

commit;
