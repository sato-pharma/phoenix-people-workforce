-- Recruitment — record the job the candidate is applying FOR, separately from the job they DO.
--
-- Until now the system could only ever answer "what is this person's title?" (current_job_title).
-- The prompt went out of its way to forbid the other question: rule 5 of the extraction
-- instructions read "currentJobTitle is the CANDIDATE'S OWN title from their CV, never the vacancy
-- they are applying for." That was correct as far as it went — a National Sales Manager CV must not
-- be relabelled by whatever vacancy it was sent against — but it left the vacancy recorded nowhere
-- at all, so a recruiter opening the pool could not tell an Accountant applicant from a District
-- Sales Manager applicant without opening the CV and the covering email.
--
-- Measured in production 2026-08-15, the answer was almost always sitting in plain sight:
--   * 185 of the 199 email candidates carry a subject line with real words in it, and only 3 of
--     them are literally just "cv". "Application for National Sales Manager - Anti-Infective Line",
--     "UE-DSM", "Apply for a : \" Office coordinator \"", "Cairo 2 DM vacancy".
--   * 140 of 223 candidates already have the covering note stored on ats_candidates.notes (the
--     first 500 characters of the email body, captured at intake since the beginning). 123 of them
--     run past 40 characters. "I am writing to express my interest in the Accounts Payable
--     Accountant position at Sato Pharma" is already on the row.
--   * 5 WhatsApp candidates carry the sender's own words, one of whom pasted the entire Office
--     Coordinator advert back at us.
--
-- So the data was never missing. Nothing read it.
--
-- applied_for_evidence is the exact wording the answer came from, kept verbatim. It exists because
-- this field is INFERRED rather than transcribed: the recruiter has to be able to see the sentence
-- and disagree with it. A title with no evidence beside it is a guess wearing a uniform.
--
-- Deliberately NOT indexed. 223 candidates is a sub-millisecond sequential scan, and every real
-- query here is already filtered by stage or recency; an index would be pure write cost.

alter table public.ats_candidates
  add column if not exists applied_for_job_title text,
  add column if not exists applied_for_evidence  text;

comment on column public.ats_candidates.applied_for_job_title is
  'The vacancy this person is applying FOR, as they named it. Distinct from current_job_title, which is the job they already hold. Null = they never said.';
comment on column public.ats_candidates.applied_for_evidence is
  'The verbatim wording the applied-for title was read from -- an email subject, a line of the covering note, or a sentence of the CV. Shown next to the title so a recruiter can overrule it.';
