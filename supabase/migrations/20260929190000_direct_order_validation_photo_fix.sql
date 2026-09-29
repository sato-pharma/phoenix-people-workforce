-- ---------------------------------------------------------------------------
-- The live photo's OWN position, kept apart from the venue's *Capture Location* fix.
--
-- Until now every live-capture camera in Phoenix took ONE GPS reading — when the rep pressed
-- *Capture Location* — and reused it for the photo. `direct_order_pharmacy_validations` therefore
-- stored a single `captured_latitude/longitude/accuracy_meters` triple that described BOTH the
-- venue and the photograph of it, so the two could never disagree and no reader could tell whether
-- the camera was still at the pin when the shutter fired.
--
-- Measured on production 2026-09-29 in the sibling marketing flow, which had the identical shape
-- (capture `MKT-PHA-20260929-9A9A45F5`, Nashwah, Zagazig): the location fix was taken at 17:10:09
-- Cairo and the shutter fired at 17:28:40 — 18 minutes 31 seconds later — yet both rows carried
-- latitude 30.4954306, longitude 31.4770646 and accuracy 43.8289985656738 identically to thirteen
-- decimal places. Two genuine GPS reads never agree to thirteen decimals. The identity WAS the
-- copy. The marketing side needed no migration because `marketing_evidence_files` already had its
-- own coordinate columns, wrongly fed; this table has nowhere to put the second reading at all.
--
-- Owner's instruction, 2026-09-29: "lazm el gps b location w el live b location tany w n compare",
-- and "the photo + the location of photo is the more trustable".
--
-- NULL MEANS NOT MEASURED — never "the same place". The shutter never blocks on a second fix (a rep
-- in a doorway with a weak signal keeps working), so nulls are expected and benign. Nothing may
-- default these columns to the `captured_*` triple beside them: that substitution is exactly the
-- defect being removed, and it would be indistinguishable downstream from a real second reading.
-- Every row that exists today is therefore backfilled to NULL, which is the truth about it.
--
-- Additive only. No backfill, no default, no constraint, no index: this is evidence to read later,
-- not a key to search on, and the table is small.
-- ---------------------------------------------------------------------------

alter table public.direct_order_pharmacy_validations
  add column if not exists photo_captured_at timestamptz,
  add column if not exists photo_latitude double precision,
  add column if not exists photo_longitude double precision,
  add column if not exists photo_accuracy_meters double precision;

comment on column public.direct_order_pharmacy_validations.photo_captured_at is
  'When the shutter fired, from the capturing device. Distinct from captured_at, which is when the location pin was taken. NULL on every row written before 2026-09-29.';

comment on column public.direct_order_pharmacy_validations.photo_latitude is
  'The PHOTO''s own latitude, read fresh at the shutter. Never a copy of captured_latitude. NULL means not measured, never "same place as the pin".';

comment on column public.direct_order_pharmacy_validations.photo_longitude is
  'The PHOTO''s own longitude, read fresh at the shutter. Never a copy of captured_longitude. NULL means not measured, never "same place as the pin".';

comment on column public.direct_order_pharmacy_validations.photo_accuracy_meters is
  'Reported accuracy of the shutter fix. Stored only; it refuses nothing and decides nothing.';
