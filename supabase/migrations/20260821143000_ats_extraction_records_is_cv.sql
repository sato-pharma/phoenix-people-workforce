-- Record the AI's "is this document actually a CV?" answer next to the fields it pulled out of it.
--
-- SYMPTOM. On 2026-08-21 six recruitment "candidates" were deleted from production because none of
-- them was a job applicant: a vendor price quotation, an internal staff-insurance circular, two
-- sales-training pitches, a scales supplier's registration request -- and a DOCTOR'S PRESCRIPTION,
-- forwarded inside an employee's maternity-leave thread, whose clinic letterhead had been read as a
-- name, a phone and an Alexandria address and promoted into its own candidate record. Establishing
-- that took opening 171 distinct intake subjects and 605 events by hand.
--
-- CAUSE. The engine ALREADY knows. extractCvFieldsFromBytes asks the model `is_cv` on the very same
-- structured-output call that extracts the fields (src/lib/recruitment/cv-extraction.ts), and
-- inbound email intake reads it and suppresses the attachment -- 43 of them between 2026-07-28 and
-- 2026-08-18, all logged `ignored_unsupported_attachment`. But persistCvExtraction then dropped the
-- answer on the floor: `ats_candidate_cv_extractions` had no column for it. The judgement lived for
-- the length of one function call and was never written down.
--
-- So nothing downstream could ask it. Every path that reaches an extraction AFTER intake -- the
-- review board, a bulk re-read, and above all the ops scripts that build candidates out of files
-- that already exist -- had to re-derive "is this a CV" from the fields alone, or, as
-- scripts/recruitment-split-forwarded-candidates.ts did, not ask at all. That script's only content
-- guard re-asserted the extracted NAME. A prescription has a name on it, so it passed.
--
-- NULL IS NOT FALSE, AND THIS COLUMN MUST NEVER BE READ AS THOUGH IT WERE. Nullable with no
-- default and no backfill: every one of the 394 rows written before today keeps NULL, meaning
-- "nobody recorded a judgement", which is the truth. The model's answer for those rows is gone and
-- inventing one would be worse than admitting that. Readers gate on `is_cv = false` -- an explicit
-- negative, never a missing one -- exactly as the intake gate already does, so an outage, an older
-- row, or a rules-only read can never cost a real applicant their application.
--
-- No index. This is read one row at a time by candidate or by file, both already indexed, and a
-- boolean over ~400 rows would never be chosen anyway.

alter table public.ats_candidate_cv_extractions
  add column if not exists is_cv boolean;

comment on column public.ats_candidate_cv_extractions.is_cv is
  'Did the read judge this document to be a CV/resume? Answered by the same AI call that extracted '
  'the fields. NULL = no judgement was recorded (every row written before 2026-08-21, and any read '
  'that never reached the model). Gate on `is_cv = false` only: NULL and true both mean "do not '
  'block", so a missing answer can never discard a real applicant.';
