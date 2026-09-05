-- Recruitment / ATS — giving the SIX BUILT-IN WhatsApp questions the same "who is asked" control
-- the extra questions have had since 20260902120000.
--
-- WHY. The owner asked on 2026-09-05 for every single question on /admin/screening-questions to let
-- him choose which job titles are asked it, worded the same way it already works on the extra
-- questions below them. The six had exactly one such rule and it was not his to change: the area
-- question is asked to Medical Representatives only, hardcoded in `askAreaForRole` since 2026-08-30.
-- Everything else was asked to everybody, with no way to narrow it short of a deploy.
--
-- ── THREE STATES, AND THE MIDDLE ONE IS THE WHOLE POINT ─────────────────────────────────────────
--
--   NULL   nothing configured   -> the question takes its CODE default
--   '{}'   configured: EVERYONE -> beats the code default
--   {a,b}  configured: those    -> only those role families
--
-- The sibling column on ats_whatsapp_screening_questions has only two states and REFUSES '{}'. That
-- is not an inconsistency to tidy up later, so it is written down here: an extra question has no
-- code behind it, so an empty scope there could only mean "ask nobody", which would silently retire
-- a question still showing as active. A built-in question DOES have a code default, and one of them
-- — `area` — defaults to something narrower than everyone. Without a distinct "everyone" state,
-- widening the area question would write NULL, read back as untouched, and go on asking Medical Reps
-- only: a setting that saves cleanly and does nothing. That is precisely the failure this screen
-- exists to prevent, so the third state is carried in the data rather than inferred.
--
-- ── WHY THE DEFAULT IS NOT A SEED ROW ───────────────────────────────────────────────────────────
--
-- This migration deliberately inserts NOTHING. The area question's Medical-Rep rule moves from
-- `askAreaForRole` into BUILT_IN_DEFAULT_AUDIENCE in whatsapp-question-audience.ts, and stays in
-- code, because reads of this table are best-effort and never throw — a failed read returns an empty
-- override map so that a database hiccup cannot stop an applicant being asked a question. With the
-- rule in code, that degrades to "Medical Reps only", which is what it has always been. Had it been
-- a seed row, the same hiccup would have WIDENED the question to every applicant, asking every
-- manager which territory they want. A fallback may narrow; it must never widen.
--
-- So this change is behaviour-neutral on the day it ships: with the column empty everywhere, all six
-- questions resolve to exactly what they resolved to before it existed. Nothing moves until somebody
-- ticks a box.
--
-- ── QUESTION 1 CAN NEVER BE SCOPED ──────────────────────────────────────────────────────────────
--
-- `job_title` is the question that ESTABLISHES the role. Scoping it would mean deciding whether to
-- ask it from an answer it has not collected yet — not a restriction, an impossibility. Refused in
-- three places: the screen does not offer the control, `audienceViolations` refuses the save, and
-- the CHECK below refuses the row. A setting that is silently ignored reads on screen exactly like
-- one that works, which is the reason for all three rather than any one of them.
--
-- Reversible: drop the column and restore the previous not-empty constraint. Nothing reads it that
-- does not tolerate its absence as "use the code default".

begin;

alter table public.ats_whatsapp_question_prompts
  add column if not exists applies_to_role_families text[];

-- Shape only — the VOCABULARY is checked in TypeScript (audienceViolations), the same split the
-- sibling table uses and for the same reason: candidateRoleFamilies gains a member whenever the
-- company opens a kind of seat it has not hired for before, and a CHECK listing them would need a
-- migration every time one is added, with a stale one rejecting a family the app considers valid.
--
-- Written WITHOUT a subquery, because a CHECK constraint may not contain one. array_to_string
-- collapses the array into a delimited token list the lowercase-snake regex can judge in one pass,
-- which rejects a blank and a mis-cased code together; it SKIPS null elements, so array_position
-- carries that case separately and is not redundant.
--
-- THE CARDINALITY TEST IS NOT DECORATION — it is carried over verbatim from the sibling constraint,
-- where probing found the hole it closes: a SINGLE element containing the delimiter,
-- array['office,coordinator'], joins to a string the regex reads as two well-formed tokens and
-- accepts. Round-tripping the join back through string_to_array yields two elements where the array
-- had one, so the counts disagree exactly when an element smuggled a delimiter in.
alter table public.ats_whatsapp_question_prompts
  drop constraint if exists ats_whatsapp_question_prompts_audience_shape;

alter table public.ats_whatsapp_question_prompts
  add constraint ats_whatsapp_question_prompts_audience_shape
    check (
      applies_to_role_families is null
      or cardinality(applies_to_role_families) = 0
      or (
        array_position(applies_to_role_families, null) is null
        and array_to_string(applies_to_role_families, ',') ~ '^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*$'
        and cardinality(applies_to_role_families)
            = cardinality(string_to_array(array_to_string(applies_to_role_families, ','), ','))
      )
    );

-- The first question is never scoped — see the header. NULL is the only value it may hold, so even
-- the harmless "configured: everyone" is refused: on this one question that state would be a saved
-- decision that changes nothing, and a row asserting it invites the next reader to believe the
-- control exists there.
alter table public.ats_whatsapp_question_prompts
  drop constraint if exists ats_whatsapp_question_prompts_job_title_audience_check;

alter table public.ats_whatsapp_question_prompts
  add constraint ats_whatsapp_question_prompts_job_title_audience_check
    check (question_key <> 'job_title' or applies_to_role_families is null);

-- THE ONE THAT WOULD HAVE SHIPPED BROKEN. The original not-empty constraint predates this column, so
-- a row carrying ONLY an audience — the exact row written by narrowing a question whose wording is
-- untouched, which is the common case — was refused outright by a constraint whose message names
-- none of this. Extended rather than dropped: a row overriding nothing at all still overrides
-- nothing, and "is this question customised?" must stay answerable from the row's existence alone.
alter table public.ats_whatsapp_question_prompts
  drop constraint if exists ats_whatsapp_question_prompts_not_empty_check;

alter table public.ats_whatsapp_question_prompts
  add constraint ats_whatsapp_question_prompts_not_empty_check
    check (
      body_text is not null
      or option_labels <> '{}'::jsonb
      or hidden_options <> '[]'::jsonb
      or option_order <> '[]'::jsonb
      or applies_to_role_families is not null
    );

comment on column public.ats_whatsapp_question_prompts.applies_to_role_families is
  'Which candidate role families are asked this built-in question, as candidateRoleFamily codes (candidate-role-family.ts). THREE states, unlike the two-state column of the same name on ats_whatsapp_screening_questions: NULL means nothing configured, so the question takes its CODE default from BUILT_IN_DEFAULT_AUDIENCE (whatsapp-question-audience.ts) - which is every applicant for five of the six, and Medical Reps only for ''area''. An EMPTY array means configured as everyone, and beats that default; it is legal here and refused on the sibling table. A non-empty array narrows the question to those families. Membership is validated in TypeScript (audienceViolations), not by a CHECK, so opening a new kind of seat does not need a migration. NULL always, for question_key = ''job_title'': it establishes the role, so it cannot be scoped by it.';

commit;
