-- Recruitment / ATS — the admin's answer on a graduation background, kept apart from the applicant's.
--
-- The owner, 2026-08-31: "you will start backfilling from the historicals. For example, the two
-- hundred eligible, you will backfill them. But anyone non eligible, you will make the admin be able
-- to check first their CV and confirm."
--
-- The eligible half needs no column — the rule reads the CV and routes. This migration is entirely
-- for the OTHER half: the 111 CVs the judge reads as paramedical and the 167 whose faculty string it
-- cannot parse at all. Those wait for a person, and when that person answers, the answer has to live
-- somewhere durable or the queue re-asks the same question every time the page loads.
--
-- ── WHY NOT WRITE THE ANSWER INTO declared_background ───────────────────────────────────────────
--
-- Because that column means ONE thing: what the applicant themselves answered when the apply flow
-- asked what they studied. An admin's judgement written into it would be indistinguishable from the
-- applicant's own words a week later, and the judge reads that column FIRST — so the confirmation
-- would silently rewrite the evidence it was based on, and nobody could ever tell which of the two
-- a row was carrying. This repository has already paid for that exact shape once, when an
-- applicant's answer was written into the manager_notified_* columns and wiped the notify trail.
-- A separate column costs three fields and keeps both facts recoverable.
--
-- ── TWO OUTCOMES, AND ONLY ONE OF THEM ALSO FILES ───────────────────────────────────────────────
--
-- 'eligible'    — a person read the CV and says this graduate is in the five disciplines. The CV
--                 starts routing to district managers. Nothing is filed; they stay in the pool.
-- 'paramedical' — a person read the CV and says they are not. The application layer ALSO files them
--                 onto the Paramedical shelf in the same action, because that is the folder the
--                 owner asked for; this column is what records that a human decided it, which the
--                 folder alone does not say.
--
-- The confirmation OUTRANKS the judge in both directions, deliberately. A CV whose faculty reads
-- "Faculty of Pharmacy" and whose owner is confirmed paramedical stays paramedical, because a person
-- looked at the document and the parser looked at a string.
--
-- ── NOT APPLIED YET ─────────────────────────────────────────────────────────────────────────────
--
-- Applying a migration to production is one of the two protected actions in AGENTS.md 6 and needs
-- the owner's explicit approval in the conversation. This file is written and reviewed; it has been
-- run against NOTHING. When it is approved, apply it BEFORE the merge reaches production — the code
-- half reads these columns through `select *`, so a deploy that landed first would leave the review
-- queue asking the same question forever and every Confirm press would 400 on an unknown column.
--
-- ADDITIVE AND REVERSIBLE. Three nullable columns and two CHECKs; no existing row changes, no
-- default is written, and every candidate begins unconfirmed — which is the correct starting state,
-- since nobody has been asked yet.

begin;

alter table public.ats_candidates
  add column if not exists background_confirmed_outcome text,
  add column if not exists background_confirmed_at timestamptz,
  add column if not exists background_confirmed_by_hr_id text;

-- The vocabulary, pinned in the database as well as in TypeScript. 'unknown' is deliberately NOT a
-- value: it is what the judge says when it cannot tell, and a person who has read the CV and still
-- cannot tell has not confirmed anything — that row simply stays in the queue.
alter table public.ats_candidates
  drop constraint if exists ats_candidates_background_confirmed_outcome_known;

alter table public.ats_candidates
  add constraint ats_candidates_background_confirmed_outcome_known check (
    background_confirmed_outcome is null
    or background_confirmed_outcome in ('eligible', 'paramedical')
  );

-- Complete or empty, the same shape as ats_candidates_folder_complete and for the same reason: a row
-- carrying an outcome with no timestamp would read as confirmed to one query and unconfirmed to
-- another, and a CV two screens disagree about is exactly how one gets lost. The hr_id is outside
-- the pairing on purpose — it is null for a caller with no HR id, exactly as folder_filed_by_hr_id
-- is, and refusing the write in that case would lose the decision to keep its attribution.
alter table public.ats_candidates
  drop constraint if exists ats_candidates_background_confirmation_complete;

alter table public.ats_candidates
  add constraint ats_candidates_background_confirmation_complete check (
    (background_confirmed_outcome is null and background_confirmed_at is null)
    or (background_confirmed_outcome is not null and background_confirmed_at is not null)
  );

comment on column public.ats_candidates.background_confirmed_outcome is
  'eligible | paramedical — an ADMIN''s answer on whether this graduate is in the five field-force disciplines (pharmacy, science, veterinary, medicine, dentistry). Distinct from declared_background, which is the APPLICANT''s own answer, and from faculty, which the CV extractor read off the document. This column outranks both: see src/lib/recruitment/background-review.ts. Null means nobody has been asked yet, which is where every row starts.';

comment on column public.ats_candidates.background_confirmed_at is
  'When the admin answered. Paired with background_confirmed_outcome by ats_candidates_background_confirmation_complete — one is never present without the other.';

comment on column public.ats_candidates.background_confirmed_by_hr_id is
  'Who answered. Nullable for the same reason folder_filed_by_hr_id is: a caller without an HR id must not lose the decision in order to keep its attribution.';

commit;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- Purely additive, so dropping the columns restores the previous shape exactly. It DOES discard
-- every admin decision recorded in the meantime, so read the count first and expect 0 if this is
-- being reverted before anyone has used the queue:
--
--   select background_confirmed_outcome, count(*)
--   from public.ats_candidates
--   where background_confirmed_outcome is not null
--   group by 1;
--
-- begin;
--   alter table public.ats_candidates
--     drop constraint if exists ats_candidates_background_confirmation_complete,
--     drop constraint if exists ats_candidates_background_confirmed_outcome_known;
--   alter table public.ats_candidates
--     drop column if exists background_confirmed_by_hr_id,
--     drop column if exists background_confirmed_at,
--     drop column if exists background_confirmed_outcome;
-- commit;
