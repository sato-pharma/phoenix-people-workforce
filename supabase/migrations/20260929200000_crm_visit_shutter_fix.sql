-- ---------------------------------------------------------------------------
-- The CRM visit photo's OWN position, read at the shutter.
--
-- Phoenix CRM already had the strongest capture design in the app: a CONTINUOUS `watchPosition`
-- while the camera is open, best-accuracy wins with a 15-second staleness escape so a lucky early
-- reading can never be the one stamped, and the burned-in stamp carries the shutter time AND the
-- fix's own time. It never had the copied-coordinate defect that #4781 removed from marketing and
-- direct orders.
--
-- What it still could not answer is the question the owner asked on 2026-09-29: whether the camera
-- was still where the pin said when the shutter fired. `phoenix_crm_visits` stores ONE position,
-- so the distance between the pin and the photo was not merely zero — it was unaskable. His words:
-- "lazm el gps b location w el live b location tany w n compare", and then, asked directly whether
-- to change the rep's camera for it, "Both".
--
-- GOLDEN RULE #1 GOVERNS THIS. The second reading is silent and adds no tap: nothing new is asked
-- of the rep, nothing is refused, no warning appears, and a difference between the two readings
-- never changes a number or a word on his own screens. It is readable by the Super Admin and the
-- SFE Manager, like every other integrity signal. The capture never waits on it — a refused or
-- slow fix leaves these NULL and the visit saves exactly as before, because a completed field
-- visit must never be lost to a missing satellite lock.
--
-- NULL MEANS NOT MEASURED, never "the same place as the pin". Nothing may default these to
-- `lat`/`lon`/`accuracy_meters` beside them: that substitution is precisely the defect #4781
-- removed from the other two modules, and downstream it is indistinguishable from a real second
-- reading. Every row that exists today is therefore NULL, which is the truth about it.
--
-- Additive only. No backfill, no default, no constraint, no index — evidence to read later, not a
-- key to search on.
-- ---------------------------------------------------------------------------

alter table public.phoenix_crm_visits
  add column if not exists photo_lat double precision,
  add column if not exists photo_lon double precision,
  add column if not exists photo_accuracy_meters numeric,
  add column if not exists photo_captured_at timestamptz;

comment on column public.phoenix_crm_visits.photo_lat is
  'The PHOTO''s own latitude, read fresh at the shutter. Never a copy of lat. NULL means not measured, never "same place as the pin".';

comment on column public.phoenix_crm_visits.photo_lon is
  'The PHOTO''s own longitude, read fresh at the shutter. Never a copy of lon. NULL means not measured, never "same place as the pin".';

comment on column public.phoenix_crm_visits.photo_accuracy_meters is
  'Reported accuracy of the shutter fix. Stored only; it refuses nothing, decides nothing, and never reaches the rep.';

comment on column public.phoenix_crm_visits.photo_captured_at is
  'When the shutter fired, from the capturing device. Distinct from captured_at, which is the visit''s own pin. NULL on every row written before 2026-09-29.';
