-- Recruitment / ATS — scoping an admin-defined WhatsApp screening question to a role.
--
-- WHY. The extra-question feature (20260831150000) shipped with one audience: everybody.
-- `listActiveScreeningQuestions()` returns every active row and the loop walks them in sort order,
-- so a question written for one seat is asked to every applicant who sends a CV. That was fine while
-- the table was empty — measured 2026-09-02, it still holds zero rows and the feature has never been
-- used — and it stops being fine the moment the first question is written, because this pool is
-- overwhelmingly medical reps.
--
-- The owner asked for questions tailored to the Sheraton Office Coordinator opening. Two of those
-- questions are actively misleading if asked of the wrong person: "how long is your commute to our
-- office in Sheraton?" reads to a Qena field applicant as though the rep job is Cairo-based, and it
-- would be asked at the END of the flow, after the highest-friction question there is. A question
-- that costs applications is worse than no question.
--
-- ONE COLUMN, AND NULL KEEPS THE OLD MEANING. `applies_to_role_families = null` is "ask everyone",
-- which is exactly what every row would have meant before this migration — so this is additive in
-- behaviour as well as in schema, and a question written without thinking about scope still behaves
-- the way the feature already documented. A non-empty array narrows it to those families.
--
-- MEMBERSHIP IS NOT CHECKED HERE, deliberately. The vocabulary is `candidateRoleFamilies` in
-- candidate-role-family.ts, which gains a member whenever the company opens a kind of seat it has
-- not hired for before (office_coordinator was added in this same change). A CHECK listing them
-- would mean a migration every time that happens, and a stale one would reject a family the app
-- considers valid. So the shape is enforced here and the vocabulary in TypeScript
-- (screeningQuestionViolations) — the same split the options array already uses, where the 1-10
-- length is a constraint and the per-row title limits are not.
--
-- SINCE APPLIED — 2026-09-02, ~12:02 Cairo, about ten minutes after this shipped. The "zero rows
-- and never used" line above is a DATED MEASUREMENT and is left exactly as written, because an
-- applied migration is a record of what was true when it ran. It is no longer a description of the
-- table. Production now holds SIX active rows, every one of them scoped ['office_coordinator']:
-- oc_ms_office_outlook, oc_english_level, oc_booking_experience, oc_start_date, oc_age_band,
-- oc_sheraton_commute — the Sheraton Office Coordinator questions this change was written for.
--
-- Noted because the paragraph above is the most authoritative-looking description of this table in
-- the repo, and read as present tense it says the feature is dormant. It is live, populated, and
-- deciding which applicants are asked what. Anyone reasoning about an empty table from it will be
-- wrong. The scopes are all valid members of candidateRoleFamilies, so nothing is silently skipped.
--
-- Reversible: drop the column. Nothing reads it that does not tolerate its absence being "everyone".

begin;

alter table public.ats_whatsapp_screening_questions
  add column if not exists applies_to_role_families text[];

-- Null is the whole point (see above), so this only guards the shapes that would be ambiguous:
-- an EMPTY array reads as "ask nobody", which no admin means and which would silently retire a
-- question without setting is_active = false; and a null or blank element would match no family
-- while looking like a filled-in scope.
--
-- Written WITHOUT a subquery, because a CHECK constraint may not contain one — the obvious
-- "not exists (select 1 from unnest(...) where btrim(family) = '')" form is rejected by Postgres
-- outright rather than merely being slow. array_to_string collapses the array into a delimited token
-- list that the same lowercase-snake regex question_key already uses can judge in one pass, which
-- rejects a blank and a mis-cased code together. It SKIPS null elements, though, so the
-- array_position test carries that case on its own and is not redundant with it.
--
-- THE CARDINALITY TEST IS NOT DECORATION — it closes a hole the regex alone leaves open, found by
-- probing this constraint on staging rather than by reading it. A SINGLE element that itself
-- contains the delimiter, array['office,coordinator'], joins to the string 'office,coordinator',
-- which the regex reads as two perfectly well-formed tokens and accepts. Round-tripping the join
-- back through string_to_array yields two elements where the array had one, so the counts disagree
-- exactly when an element smuggled a delimiter in. Every other bad shape was already refused.
alter table public.ats_whatsapp_screening_questions
  drop constraint if exists ats_whatsapp_screening_questions_role_scope_shape;

alter table public.ats_whatsapp_screening_questions
  add constraint ats_whatsapp_screening_questions_role_scope_shape
    check (
      applies_to_role_families is null
      or (
        array_length(applies_to_role_families, 1) >= 1
        and array_position(applies_to_role_families, null) is null
        and array_to_string(applies_to_role_families, ',') ~ '^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*$'
        and cardinality(applies_to_role_families)
            = cardinality(string_to_array(array_to_string(applies_to_role_families, ','), ','))
      )
    );

comment on column public.ats_whatsapp_screening_questions.applies_to_role_families is
  'Which candidate role families are asked this question, as candidateRoleFamily codes (candidate-role-family.ts). NULL means every applicant — the behaviour every row had before this column existed. A non-empty array narrows it: only an applicant whose tapped role is in the list is asked. Membership is validated in TypeScript (screeningQuestionViolations), not by a CHECK, so opening a new kind of seat does not need a migration.';

commit;
