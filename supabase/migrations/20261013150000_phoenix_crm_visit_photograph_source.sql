-- phoenix_crm_visit_photograph_source
--
-- WHAT THIS CHANGES: one CHECK constraint on `phoenix_crm_location_integrity`, and nothing else.
-- `source` widens from the eight detectors it has held since 2026-10-12 to admit a NINTH,
-- 'visit_photo'. No new table, no new column, no function, no policy, no grant, and not one
-- existing row touched.
--
-- WHY. The owner's instruction of 13 October 2026: "since u have the accurate validation the photo
-- with location then drop the suspected one and compare visits vs the accurate", and then "i want
-- the integrity report to show exactly this with story with the pictures and live loc numbers and
-- photos". A photograph carries the fix its own shutter took at the door, so it is the one reading
-- nobody can drag across a map — and until now NOTHING compared a rep's visit against it. The pin
-- is dropped from this judgement by his own word.
--
-- Measured on production the same day, with the detector's own rules: of 1,630 visits in the
-- 21-day window carrying a fix, 1,286 can be measured against a photograph captured before them;
-- 48 sit past the live 300 m line (`visit_far_meters`), 46 survive the accuracy guard, and 14 of
-- those are more than a kilometre out, the worst 5,864 m across 16 named reps. 47 of the 48
-- reached the owner's board through no case of their own.
--
-- WHY A NINTH SOURCE RATHER THAN A FLAG ON AN EXISTING CASE. `source` is part of
-- UNIQUE (subject_kind, subject_id, source), so each detector's verdict on a subject sits BESIDE
-- the others' instead of replacing one. A visit already carrying a `gps` case must keep it: the
-- two findings are different questions, and merging them would hide whichever was filed second.
--
-- 🔴 BOTH FLAGS IT FILES ARE WEAK, DELIBERATELY. `visit_far_from_photo` and
-- `visit_very_far_from_photo` are absent from `PHOENIX_CRM_STRONG_INTEGRITY_FLAGS`, which is the
-- one gate `countedIntegrityFlags` and the nightly rep-ranks score share (both read
-- `strong = true`), so not one of these 45 cases moves a number any rep can see. A visit is saved
-- where the phone is when the box is filled in — the car outside, the lift, the next clinic along —
-- which is not always the door, and that is an ordinary day, not a finding against a person.
--
-- 🔴 AND ONLY THIS TABLE'S CHECK IS WIDENED. `phoenix_crm_photo_fingerprints` and
-- `phoenix_crm_refused_readings` carry their own narrower CHECKs and are left exactly as they are:
-- they never receive this source, and a CHECK is the only record a column has of what may be in it.
--
-- REVERSIBILITY: the constraint is replaced, not dropped — re-running the previous definition
-- restores the old bounds, and the rows carrying 'visit_photo' would have to be deleted first.

begin;

alter table public.phoenix_crm_location_integrity
  drop constraint if exists phoenix_crm_location_integrity_source;
alter table public.phoenix_crm_location_integrity
  add constraint phoenix_crm_location_integrity_source
  check (source in ('gps', 'photo', 'behaviour', 'capture_trust', 'signboard', 'roster', 'cadence', 'coverage', 'visit_photo'));

comment on column public.phoenix_crm_location_integrity.source is
  'Which detector filed the case: gps, photo, behaviour, capture_trust, signboard, roster, cadence, coverage, or visit_photo (the rep''s own visit fix against the photograph taken at the place, added 2026-10-13). Part of UNIQUE (subject_kind, subject_id, source), so each detector''s verdict sits beside the others''. The reader derives its labels from INTEGRITY_SOURCES in server/integrity-board.ts — a value this CHECK allows and that list does not hold would be read as an unknown detector and printed as its raw code.';

notify pgrst, 'reload schema';

commit;
