-- Recruitment / ATS — let a CV sender type their own job title when they choose "Other".
--
-- WHY. The three-question WhatsApp flow (20260828060000) asks role, region, then area as tappable
-- lists. A list is a closed vocabulary, so "Other" was a dead end: it recorded the literal label
-- "Other", which tells a hiring manager nothing and is strictly worse than the free text an
-- extractor might have guessed off the CV.
--
-- Owner's instruction, 2026-08-28: "if he choose other, he free text what he want." So "Other" now
-- opens one plain-text question, and whatever they type becomes `applied_for_job_title` verbatim —
-- the TOP rung of the applied-for ladder in applied-for.ts ("a human typed it. Always wins"), which
-- is exactly what this is: the applicant themselves, stating their own intent.
--
-- Two changes, both additive:
--
-- 1. A new step, `job_title_other`, between `job_title` and `region`. The conversation parks there
--    and the sender's NEXT plain text message is taken as the answer. The existing CHECK constraint
--    lists the allowed steps explicitly, so it has to be replaced or the update is rejected and the
--    applicant silently dead-ends on question 1.
--
-- 2. A column to hold the typed answer. Deliberately NOT reusing `job_title_family`: that column
--    holds a CODE from a fixed vocabulary and is read as one everywhere (`candidateRoleFamilyLabels`
--    is keyed on it). Writing free text there would produce a label lookup of `undefined` at every
--    read site — the same shape as the 2026-08-24 incident where a family outside an exhaustive
--    Record produced NaN sort keys in production. The two are kept apart on purpose: the family
--    stays `other`, and the words live beside it.
--
-- No existing row is read, rewritten or moved. Reversible: drop the column and restore the previous
-- constraint. Rolling back with rows already on the new step would strand them, so the constraint is
-- replaced rather than widened in place only after the column exists.

-- ── 1. The typed answer ─────────────────────────────────────────────────────────────────────────

alter table public.ats_whatsapp_classification_sessions
    add column if not exists job_title_other_text text;

comment on column public.ats_whatsapp_classification_sessions.job_title_other_text is
    'The job title the applicant TYPED after choosing "Other" on question 1, cleaned and capped at 120 characters. Null for every other answer. Copied verbatim to ats_candidates.applied_for_job_title when the conversation completes.';

-- ── 2. The new step ─────────────────────────────────────────────────────────────────────────────
-- Dropped and recreated rather than widened: Postgres has no "alter check constraint", and naming
-- the full allowed set in one place keeps this readable against the session state machine, which
-- lists the same five values as `classifySessionSteps`.

alter table public.ats_whatsapp_classification_sessions
    drop constraint if exists ats_whatsapp_classification_sessions_step_check;

alter table public.ats_whatsapp_classification_sessions
    add constraint ats_whatsapp_classification_sessions_step_check
        check (step in ('job_title', 'job_title_other', 'region', 'area', 'done'));

comment on column public.ats_whatsapp_classification_sessions.step is
    'Outstanding question: job_title -> (job_title_other, only when they chose "Other") -> region -> area -> done.';
