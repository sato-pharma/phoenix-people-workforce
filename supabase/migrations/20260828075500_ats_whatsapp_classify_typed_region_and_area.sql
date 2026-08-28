-- Recruitment / ATS — let an applicant TYPE a region or an area the organogram does not have yet.
--
-- WHY. Questions 2 and 3 are tappable lists, and a list is a closed vocabulary. The owner hit the
-- consequence himself on 2026-08-28 while opening a District Manager seat in Delta (3): D3 was live
-- and carrying target in `au.regions`, had ZERO rows in `au.canonical_areas`, and was absent from
-- the offered region list entirely. So a candidate for that seat could not pick the region, could
-- not pick an area, and had no way to type either. His instruction: "the other must be a free text.
-- Even consider the area she is applying is not in our organogram now."
--
-- That window is not an edge case — it is exactly when a new district hires. A district exists, and
-- carries a target, for some time before anyone draws its areas, and its FIRST candidates arrive in
-- precisely that gap.
--
-- Three changes, all additive:
--
-- 1. Two steps, `region_other` and `area_other`, mirroring `job_title_other` from 20260828071500.
--    The CHECK constraint names its allowed values explicitly, so it is replaced or the update is
--    rejected and the applicant dead-ends mid-conversation.
--
-- 2. Two columns on the session, for the typed words.
--
-- 3. One column on the CANDIDATE, `preferred_region_name`. Deliberately NOT reusing
--    `preferred_region_code`: that column holds a CODE from a fixed vocabulary and is read as one
--    (`candidateRegionLabels` is keyed on it). Free text there would produce an undefined label at
--    every read site — the identical shape to the 2026-08-24 incident, where a role family outside
--    an exhaustive Record produced NaN sort keys and scattered 63 real candidates through the
--    screening queue. `preferred_area_name` needs no twin: an area is a name either way.
--
-- No existing row is read, rewritten or moved. Reversible: drop the three columns and restore the
-- previous constraint.

-- ── 1. The typed answers, on the conversation ───────────────────────────────────────────────────

alter table public.ats_whatsapp_classification_sessions
    add column if not exists region_other_text text,
    add column if not exists area_other_text text;

comment on column public.ats_whatsapp_classification_sessions.region_other_text is
    'The region the applicant TYPED after choosing "My region is not listed", cleaned and capped at 80 characters. Null for every other answer. Copied to ats_candidates.preferred_region_name when the conversation completes — never to preferred_region_code, which holds codes.';

comment on column public.ats_whatsapp_classification_sessions.area_other_text is
    'The area the applicant TYPED, either after choosing "My area is not listed" or because the region they chose has no areas drawn yet (Delta (3), 2026-08-28). Cleaned and capped at 80 characters. Copied to ats_candidates.preferred_area_name.';

-- ── 2. The two new steps ────────────────────────────────────────────────────────────────────────
-- Dropped and recreated rather than widened: Postgres has no "alter check constraint". The full
-- allowed set is named in one place so it reads against `classifySessionSteps`, which lists the
-- same seven values.

alter table public.ats_whatsapp_classification_sessions
    drop constraint if exists ats_whatsapp_classification_sessions_step_check;

alter table public.ats_whatsapp_classification_sessions
    add constraint ats_whatsapp_classification_sessions_step_check
        check (step in ('job_title', 'job_title_other', 'region', 'region_other', 'area', 'area_other', 'done'));

comment on column public.ats_whatsapp_classification_sessions.step is
    'Outstanding question: job_title -> (job_title_other) -> region -> (region_other) -> area -> (area_other) -> done. The bracketed steps are the typed escapes, reached only when the applicant says the list does not contain their answer.';

-- ── 3. Where a typed region lands on the candidate ──────────────────────────────────────────────

alter table public.ats_candidates
    add column if not exists preferred_region_name text;

comment on column public.ats_candidates.preferred_region_name is
    'The region the applicant stated in their own words, when it is not one of the company regions in preferred_region_code. Written only by the WhatsApp self-classification flow. Read it ALONGSIDE preferred_region_code, never instead of it: a candidate has one or the other, never both.';
