-- phoenix_crm_shared_place_timetable_exempt
--
-- WHAT THIS CHANGES:
--   TWO new nullable columns on `public.phoenix_crm_shared_places` — `timetable_exempt_at` and
--   `timetable_exempt_by_hr_id` — and one check that keeps them together (both set or both null).
--   Nothing existing is altered and no row is rewritten: every venue reads NULL/NULL, which is
--   exactly the behaviour it has today.
--
-- WHY:
--   Owner, 2026-10-18, about City clinic (Giza): "the city clinic is the polyclinic itself … this
--   polyclinic does not have a timetable. So you will make the place validated, and make those
--   doctors validated by the admin as an exception for this polyclinic and show this."
--
--   A polyclinic's doctors are normally validated by the building's TIMETABLE. This building has none,
--   so the board drew a rose "No timetable on file, and 6 customers are seated here" and a "No
--   timetable in the photo" warning beside every doctor — the board reading as a defect what the owner
--   had decided is an exception. These columns are the per-venue marker that lets the screen say what
--   the owner decided: who set it and when. They are a MARKER ONLY — nothing in the database reads
--   them to validate anybody, so a doctor seated there later is still held for the administrator.
--
-- ROLLBACK:
--   `alter table public.phoenix_crm_shared_places drop constraint if exists
--   phoenix_crm_shared_places_timetable_exempt_pair, drop column if exists timetable_exempt_at,
--   drop column if exists timetable_exempt_by_hr_id;` — loses only the marker; the venue and its
--   doctors stay validated. The code that selects the columns must be reverted first, or the board
--   read answers 42703.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied. This
-- file adds two nullable columns and one check; it writes no data.

begin;

alter table public.phoenix_crm_shared_places
  add column if not exists timetable_exempt_at timestamptz,
  add column if not exists timetable_exempt_by_hr_id text;

alter table public.phoenix_crm_shared_places
  drop constraint if exists phoenix_crm_shared_places_timetable_exempt_pair;
alter table public.phoenix_crm_shared_places
  add constraint phoenix_crm_shared_places_timetable_exempt_pair
  check ((timetable_exempt_at is null) = (timetable_exempt_by_hr_id is null));

comment on column public.phoenix_crm_shared_places.timetable_exempt_at is
  'When the administrator declared this building has no timetable and its doctors are validated by him as an exception. A marker for the screen; nothing validates a customer off it.';
comment on column public.phoenix_crm_shared_places.timetable_exempt_by_hr_id is
  'Who declared it (the administrator). Set and cleared together with timetable_exempt_at.';

commit;
