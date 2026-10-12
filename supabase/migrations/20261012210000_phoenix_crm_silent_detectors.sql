-- phoenix_crm_silent_detectors
--
-- WHAT THIS CHANGES: two CHECK constraints on `phoenix_crm_location_integrity`, and nothing else.
--   1. `source` widens from ('gps','photo','behaviour','capture_trust','signboard') to admit three
--      more detectors — 'roster', 'cadence' and 'coverage'.
--   2. `subject_kind` widens from ('visit','place') to admit 'shared_place' and 'customer'.
--   No new table, no new column, no function, no policy, no grant, and not one existing row touched.
--
-- WHY THE SOURCE LIST GROWS. `source` is part of UNIQUE (subject_kind, subject_id, source), so each
-- detector's verdict on a subject sits BESIDE the others' instead of replacing one. Three checks the
-- second-pass CRM audit found nobody was making:
--
--   roster   — a visit saved on a day the roster says the rep was not in the field: approved
--              FULL-DAY leave, a full-day away activity, or a named companion who was himself off
--              duty. Measured on production 12 Oct 2026: 22 visits by 3 reps on full-day away
--              activities; 0 on full-day leave (every one of the audit's leave and companion hits
--              was a HALF-day leave, i.e. a false positive, which is why day_part is read here).
--   cadence  — the same customer called 3+ times by one rep inside a rolling 7 days. 14 customers.
--   coverage — an active place sitting further from the brick it is filed under than any brick is
--              wide. 71 places. The brick distance is already on the row; nobody read it.
--
-- WHY THE SUBJECT LIST GROWS. Two of those checks are not about a visit or a place:
--   'customer'     — a cadence finding is about the customer who was called too often, and the rep
--                    who made the calls is on the row's `rep_hr_id` as usual.
--   'shared_place' — a shared venue (`phoenix_crm_shared_places`) reached NO detector at all. It
--                    carries the same two independent fixes an ordinary place does — the photo's
--                    shutter reading and the capture pin — so the EXISTING capture-trust comparison
--                    is simply run over it. 24 active venues on 12 Oct 2026, all 24 with both
--                    fixes, worst gap 62 m and none over 150 m: the detector files on nobody today
--                    and can fire tomorrow, which is the right shape for a check nobody has
--                    calibrated.
--
-- 🔴 EVERY FLAG THESE THREE FILE IS WEAK, DELIBERATELY. A weak flag corroborates and never accuses:
-- `PHOENIX_CRM_STRONG_INTEGRITY_FLAGS` does not hold one of them, so none of them moves a number any
-- rep can see (`countedIntegrityFlags` and the ranks reader both ask for `strong`). A rep saving a
-- visit on a conference day has very often simply been at a conference AND at a doctor.
--
-- 🔴 AND ONLY THIS TABLE'S CHECK IS WIDENED. `phoenix_crm_photo_fingerprints` and
-- `phoenix_crm_refused_readings` carry the same ('visit','place') CHECK and are left exactly as they
-- are: they never receive the new kinds, and a CHECK is the only record a column has of what may be
-- in it. Widening one that nothing writes would throw that record away for nothing.
--
-- REVERSIBILITY: both constraints are replaced, not dropped — re-running the previous definitions
-- restores the old bounds, and a row carrying a new value would then have to be deleted first.

begin;

alter table public.phoenix_crm_location_integrity
  drop constraint if exists phoenix_crm_location_integrity_source;
alter table public.phoenix_crm_location_integrity
  add constraint phoenix_crm_location_integrity_source
  check (source in ('gps', 'photo', 'behaviour', 'capture_trust', 'signboard', 'roster', 'cadence', 'coverage'));

alter table public.phoenix_crm_location_integrity
  drop constraint if exists phoenix_crm_location_integrity_subject_kind_check;
alter table public.phoenix_crm_location_integrity
  add constraint phoenix_crm_location_integrity_subject_kind_check
  check (subject_kind in ('visit', 'place', 'shared_place', 'customer'));

comment on column public.phoenix_crm_location_integrity.subject_kind is
  'What the case is about: visit, place, shared_place (a venue in phoenix_crm_shared_places) or customer (a cadence finding). Part of UNIQUE (subject_kind, subject_id, source). The reader derives its labels from INTEGRITY_SUBJECT_KINDS in server/integrity-board.ts — a value this CHECK allows and that list does not hold would print on the owner''s board as a visit.';

notify pgrst, 'reload schema';

commit;
