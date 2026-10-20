-- phoenix_crm_refused_visit_far_from_place
--
-- WHAT THIS CHANGES:
--   phoenix_crm_refused_readings.reason accepts one more value, 'far_from_place'. The table gains two
--   nullable columns — place_id (the validated place the refused visit was measured to) and
--   distance_meters (how far it was) — and a CHECK that no other reason carries either of them.
--   No function, no policy, no grant is changed, and no existing row is touched.
--
-- WHY:
--   Owner, 2026-10-20: "MAKE THE SYSTEM NOT ACCEPT MEDICAL REPS VISITS LOGGED AWAYS FROM THE VALIDATED
--   PICTURE OF THE CUSTOMER WITH MAXIMUM 300 M APPART". Until that day a rep's visit past the 300 m
--   line (visit_far_meters) saved and was only flagged for his managers. It is now REFUSED at the save
--   (src/lib/phoenix-crm/entry-rules.ts, visitAwayFromValidatedPlace) — and a refusal that left no row
--   would put the attempt nowhere at all: a refused visit creates no visit row. So each one is kept
--   here, beside the other refusals, for the SFE's refused-readings board, carrying the metres and the
--   place they were measured to. max_accuracy_meters holds the far line the save was refused against,
--   so an old row reads against its own rule if the line ever moves.
--   Measured on production for 6-19 October 2026: 97 of 2,558 measurable rep visits (3.8%) sat past
--   the line — about seven a day is what this table should now expect.
--
-- ROLLBACK:
--   delete from public.phoenix_crm_refused_readings where reason = 'far_from_place';
--   alter table public.phoenix_crm_refused_readings
--     drop constraint if exists phoenix_crm_refused_readings_far_from_place_check;
--   alter table public.phoenix_crm_refused_readings
--     drop constraint phoenix_crm_refused_readings_reason_check;
--   alter table public.phoenix_crm_refused_readings
--     add constraint phoenix_crm_refused_readings_reason_check
--     check (reason = any (array['no_fix'::text, 'rough'::text, 'off_listing'::text, 'blocked'::text,
--                                'timetable_unreadable'::text, 'timetable_missing'::text,
--                                'signboard_unreadable'::text, 'signboard_no_plate'::text]));
--   alter table public.phoenix_crm_refused_readings drop column distance_meters;
--   alter table public.phoenix_crm_refused_readings drop column place_id;
--   Additive in full. Production has NO point-in-time recovery — 7 daily backups are the whole
--   recovery story. This writes no rows and deletes nothing.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_refused_readings
  add column if not exists place_id uuid;

alter table public.phoenix_crm_refused_readings
  add column if not exists distance_meters integer;

comment on column public.phoenix_crm_refused_readings.place_id is
  'For reason far_from_place only: the nearest validated place (phoenix_crm_places.id) the refused visit was measured to. No foreign key, deliberately — a refusal must outlive a place later retired or moved. Null for every other reason.';

comment on column public.phoenix_crm_refused_readings.distance_meters is
  'For reason far_from_place only: whole metres from the visit''s reading to that place''s validated photograph (or its validated point when the photograph carries no sharp reading). max_accuracy_meters holds the far line it was refused against. Null for every other reason.';

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
    'timetable_missing'::text,
    'signboard_unreadable'::text,
    'signboard_no_plate'::text,
    'far_from_place'::text
  ]));

-- Half of the pairing, as the signboard key's: no other reason may carry the place or the metres. The
-- other half — a far_from_place row always names its metres — is the writer's (recordFarVisitRefusal).
alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_far_from_place_check;

alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_far_from_place_check
  check (
    reason = 'far_from_place'::text
    or (place_id is null and distance_meters is null)
  );

notify pgrst, 'reload schema';

commit;
