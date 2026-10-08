-- phoenix_crm_cairo_and_giza_start_10_october
--
-- WHAT THIS CHANGES (owner, 2026-10-07, asked which Saturday and answered "Saturday 10 October"):
--   Cairo's and Giza's six teams are counted from Phoenix CRM from Saturday 10 October 2026, the week
--   after Delta (1). Same shape as Delta (1)'s three rows (20261002123958): `started_by =
--   'owner_ruling'`, no hr id, the ruling in the note.
--
-- WHY A MIGRATION RATHER THAN THE START BUTTON: six teams on one day is one decision, and the panel
--   takes one team at a time. The RPC's own refusals are satisfied here — a Saturday, inside the
--   twelve-week window, no overlapping start — and the panel keeps working for every later wave.
--
-- THE SAFETY CHECK THIS RESTS ON, run on production 2026-10-07 and passing: all 17 OCCUPIED rep seats
--   under these six district managers already carry a Phoenix CRM list (155, 120, 129, 107 · 110, 114,
--   136 · 170, 167, 174 · 183, 166 · 178, 192, 179, 167 customers), so nobody is taken off the vendor
--   on the 10th with an empty list in front of him — which is the one way a go-live can read as "a
--   drop happened" (owner, 2026-10-07: "nothing show that a drop happened"). Their iReports360 rows
--   for 3-9 October and every month before are untouched, and the doors keep serving them: the start
--   is a half-open window, so the vendor answers up to 9 October and Phoenix from the 10th, with no
--   gap and no overlap.
--
-- PEDIA CAIRO IS STARTED WITH NO REPS AT ALL, deliberately. All five of its rep seats are vacant and it
--   holds 0 Phoenix customers, so the start counts nobody and changes no figure; it is here so the
--   wave is complete and nobody has to come back to it when the seats are filled.
--
-- ROLLBACK:
--   delete from public.phoenix_crm_team_starts
--    where starts_on = date '2026-10-10'
--      and team_seat_id in ('SEAT-AIF-DM-CA','SEAT-AIF-DM-GZ','SEAT-CNS-DM-CA','SEAT-CNS-DM-GZ',
--                           'SEAT-PED-DM-CA','SEAT-PED-DM-GZ');
--   Nothing else has to be undone: a start is read live by the doors, so removing the row puts every
--   report straight back on iReports360 for those teams.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This inserts SIX configuration rows and changes no recorded visit, plan, list or figure.

begin;
set local lock_timeout = '5s';

insert into public.phoenix_crm_team_starts (team_seat_id, starts_on, started_by, started_by_hr_id, note)
select
  seat.team_seat_id,
  date '2026-10-10',
  'owner_ruling',
  null,
  'Owner''s ruling, 2026-10-07: Cairo and Giza are counted from Phoenix CRM from Saturday 10 October '
  || '2026, the week after Delta (1). All 17 occupied rep seats already carried a Phoenix list, so no '
  || 'rep is moved off iReports360 with an empty list. iReports360 keeps every row up to 9 October.'
from (values
  ('SEAT-AIF-DM-CA'),
  ('SEAT-AIF-DM-GZ'),
  ('SEAT-CNS-DM-CA'),
  ('SEAT-CNS-DM-GZ'),
  ('SEAT-PED-DM-CA'),
  ('SEAT-PED-DM-GZ')
) as seat(team_seat_id)
-- Idempotent, and it never argues with a start somebody made by hand in the panel first: a team that
-- already has one keeps it, whatever day it names.
where not exists (
  select 1 from public.phoenix_crm_team_starts existing
   where existing.team_seat_id = seat.team_seat_id
     and existing.stops_on is null
);

commit;
