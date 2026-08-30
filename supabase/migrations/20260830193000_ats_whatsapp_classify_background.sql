-- Recruitment / ATS — ask a CV sender what they graduated in, right after the role question.
--
-- WHY. Owner's instruction 2026-08-30: after "what are you applying for?", ask the applicant their
-- graduation background — Pharmacy, Science, Veterinary, or Other (typed). In this industry a field
-- applicant is one of those three far more often than not, and which one a hiring manager wants to
-- know before reading the CV. It is a NEW fact about the candidate: nothing else buckets people by
-- degree, so it gets its own declared column rather than being squeezed into an existing one.
--
-- Same instruction also made the AREA question a Medical-Rep-only cascade (asked after region), but
-- that is a code change only — it needs no schema, because area was already optional on the record.
--
-- Three changes, all additive:
--
-- 1. Two columns on the session for the answer: `background` (the CODE — pharmacy/science/vet, or
--    "other" when they typed their own) and `background_other_text` (the typed words). Kept apart
--    for the same reason `job_title_family` and `job_title_other_text` are: a code column read for a
--    label must never hold free text, or the label lookup returns `undefined` — the 2026-08-24 NaN
--    shape. The code stays "other", the words live beside it.
--
-- 2. Two new steps, `background` and `background_other`, between `job_title(_other)` and `region`.
--    The CHECK constraint names its allowed values explicitly, so it is replaced or the update is
--    rejected and the applicant silently dead-ends. The full set matches `classifySessionSteps`.
--
-- 3. One column on the CANDIDATE, `declared_background`, holding the read-back label (their typed
--    words for "Other", the code's label otherwise) — the same single-column shape as
--    `applied_for_job_title`, and written only by this flow.
--
-- No existing row is read, rewritten or moved. Reversible: drop the three columns and restore the
-- previous constraint. Rolling back with rows already on a new step would strand them, so the
-- constraint is replaced only after the columns exist.

-- ── 1. The answer, on the conversation ──────────────────────────────────────────────────────────

alter table public.ats_whatsapp_classification_sessions
    add column if not exists background text,
    add column if not exists background_other_text text;

comment on column public.ats_whatsapp_classification_sessions.background is
    'Graduation background the applicant chose: a code (pharmacy/science/vet), or "other" when they typed their own. Null until they answer. Read back through sessionBackgroundLabel, which resolves the code to a label or returns background_other_text.';
comment on column public.ats_whatsapp_classification_sessions.background_other_text is
    'What the applicant TYPED after choosing "Other" on the background question, cleaned and capped at 80 characters. Null for every other answer. Copied verbatim to ats_candidates.declared_background when it is their answer.';

-- ── 2. The two new steps ────────────────────────────────────────────────────────────────────────
-- Dropped and recreated rather than widened: Postgres has no "alter check constraint". The full
-- allowed set is named in one place so it reads against `classifySessionSteps`, which lists the same
-- nine values.

alter table public.ats_whatsapp_classification_sessions
    drop constraint if exists ats_whatsapp_classification_sessions_step_check;

alter table public.ats_whatsapp_classification_sessions
    add constraint ats_whatsapp_classification_sessions_step_check
        check (step in (
            'job_title', 'job_title_other',
            'background', 'background_other',
            'region', 'region_other',
            'area', 'area_other',
            'done'
        ));

comment on column public.ats_whatsapp_classification_sessions.step is
    'Outstanding question: job_title -> (job_title_other) -> background -> (background_other) -> region -> (region_other) -> area -> (area_other) -> done. The bracketed steps are the typed escapes. The area step is reached only by a Medical Rep; every other role finishes after region.';

-- ── 3. Where the background lands on the candidate ──────────────────────────────────────────────

alter table public.ats_candidates
    add column if not exists declared_background text;

comment on column public.ats_candidates.declared_background is
    'The graduation background the applicant stated themselves over WhatsApp (Pharmacy/Science/Veterinary, or their own typed words when they chose "Other"). Written only by the WhatsApp self-classification flow. Null means nobody asked them or they never answered — never inferred from the CV.';
