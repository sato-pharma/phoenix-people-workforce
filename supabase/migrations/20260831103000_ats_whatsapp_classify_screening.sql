-- Recruitment / ATS — two screening questions at the END of the WhatsApp self-classification flow.
--
-- WHY. Owner's instruction 2026-08-30 (bucket 1, free in-window screening): after the geography
-- questions, ask every applicant two more things a hiring manager wants before reading the CV —
-- how many years of experience they have, and what salary they expect. Both are asked to EVERYONE
-- (unlike area, which stays Medical-Rep-only), and both are NEW facts about the candidate, so each
-- gets its own declared column rather than being squeezed into an existing one.
--
-- The two questions differ in kind on purpose:
--   • Experience is a fixed, EXHAUSTIVE set of bands (fresh graduate .. more than five years), so it
--     is a tappable list with NO "Other" escape — nothing falls outside the ranges. It stores a CODE
--     and is read back to a label, the same shape as the role and background answers.
--   • Expected salary is FREE TEXT, stored VERBATIM and never coerced to a number: an applicant
--     writes "12000", a range, "negotiable", or Arabic numerals, and every one of those is a
--     truthful answer a recruiter reads. A numeric column would throw the honest ones away.
--
-- Four changes, all additive:
--
-- 1. Two columns on the session for the answers: `experience` (the CODE — fresh/lt_1/1_3/3_5/gt_5)
--    and `expected_salary` (the typed words, verbatim). Experience needs no `_other_text` twin
--    because it has no "Other"; salary is inherently free text, so it is a words column from the
--    start and never a code column — the 2026-08-24 rule that free text in a code column returns
--    `undefined`/NaN is honoured by giving salary its own text column, not a code.
--
-- 2. Two new steps, `experience` and `salary`, AFTER `area(_other)` and before `done`. The CHECK
--    constraint names its allowed values explicitly, so it is replaced or the update is rejected and
--    the applicant silently dead-ends. The full set matches `classifySessionSteps` (eleven values).
--
-- 3. One column on the CANDIDATE, `declared_experience`, holding the read-back label for the band —
--    the same single-column shape as `applied_for_job_title` and `declared_background`.
--
-- 4. One column on the CANDIDATE, `expected_salary`, holding the typed figure verbatim.
--
-- No existing row is read, rewritten or moved. In-flight conversations (a row parked on `region` or
-- `area`) are untouched: the new columns are nullable and the new steps only extend the tail. The
-- new step set is a strict SUPERSET of the previous one, so every existing row still satisfies the
-- constraint. Reversible: drop the four columns and restore the previous nine-value constraint.
-- Rolling back with rows already on a new step would strand them, so the constraint is replaced only
-- after the columns exist.

-- ── 1. The answers, on the conversation ─────────────────────────────────────────────────────────

alter table public.ats_whatsapp_classification_sessions
    add column if not exists experience text,
    add column if not exists expected_salary text;

comment on column public.ats_whatsapp_classification_sessions.experience is
    'Years-of-experience band the applicant chose: a code (fresh/lt_1/1_3/3_5/gt_5). No "other" — the bands are exhaustive. Null until they answer. Read back through sessionExperienceLabel, which resolves the code to a label.';
comment on column public.ats_whatsapp_classification_sessions.expected_salary is
    'Expected monthly salary the applicant TYPED, cleaned and capped at 60 characters, stored VERBATIM. May read "12000", a range, "negotiable", or Arabic numerals — never coerced to a number. Copied verbatim to ats_candidates.expected_salary.';

-- ── 2. The two new steps ────────────────────────────────────────────────────────────────────────
-- Dropped and recreated rather than widened: Postgres has no "alter check constraint". The full
-- allowed set is named in one place so it reads against `classifySessionSteps`, which lists the same
-- eleven values. `salary` is a typed step with no menu and no row ids — the same kind as the
-- `_other` steps — so it is a legal `step` value but never a parseable interactive row id.

alter table public.ats_whatsapp_classification_sessions
    drop constraint if exists ats_whatsapp_classification_sessions_step_check;

alter table public.ats_whatsapp_classification_sessions
    add constraint ats_whatsapp_classification_sessions_step_check
        check (step in (
            'job_title', 'job_title_other',
            'background', 'background_other',
            'region', 'region_other',
            'area', 'area_other',
            'experience', 'salary',
            'done'
        ));

comment on column public.ats_whatsapp_classification_sessions.step is
    'Outstanding question: job_title -> (job_title_other) -> background -> (background_other) -> region -> (region_other) -> area -> (area_other) -> experience -> salary -> done. The bracketed steps and salary are typed (no menu). The area step is reached only by a Medical Rep; every other role skips from region straight to experience. Experience and salary are asked to everyone.';

-- ── 3. Where the experience band lands on the candidate ─────────────────────────────────────────

alter table public.ats_candidates
    add column if not exists declared_experience text;

comment on column public.ats_candidates.declared_experience is
    'The years-of-experience band the applicant stated themselves over WhatsApp (Fresh graduate / Less than 1 year / 1 - 3 years / 3 - 5 years / More than 5 years). Written only by the WhatsApp self-classification flow. Null means nobody asked them or they never answered — never inferred from the CV.';

-- ── 4. Where the expected salary lands on the candidate ─────────────────────────────────────────

alter table public.ats_candidates
    add column if not exists expected_salary text;

comment on column public.ats_candidates.expected_salary is
    'The expected monthly salary the applicant stated themselves over WhatsApp, verbatim as typed (a number, a range, "negotiable", or Arabic numerals). Never coerced to a number. Written only by the WhatsApp self-classification flow. Null means nobody asked them or they never answered.';
