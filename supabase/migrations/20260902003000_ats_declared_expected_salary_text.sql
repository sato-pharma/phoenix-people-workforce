-- ATS / WhatsApp screening — give the applicant's own salary answer a column it FITS in.
--
-- `ats_candidates.expected_salary` is `numeric`. The WhatsApp flow writes the applicant's answer
-- VERBATIM and says so in writeClassification ("never coerced, because 'negotiable', a range, or
-- Arabic numerals are all truthful answers a recruiter reads"). The column disagreed. Measured on
-- production 2026-09-02: of 42 applied sessions that carried a salary answer, 31 were not a bare
-- number — "Negotiable", "25 k to 30 k", "13,000 start up مع العمولات" — and every one of those 31
-- failed the cast.
--
-- The cost was never only the salary. The six answers are written in ONE update, so the failed cast
-- took the rest of that applicant's conversation down with it: 22 experience bands, 12 regions, 10
-- backgrounds and 8 areas never reached the record either. A screener then opened a CV for someone
-- who HAD answered and saw nothing, because there was nothing to see.
--
-- Verbatim text gets a text column. `expected_salary` stays numeric and keeps its meaning — a
-- figure somebody typed into the ATS, or one the CV reader parsed — so nothing that already reads
-- it changes. The new column is the applicant's own words, and the two are filled together when the
-- answer happens to be a clean number.

begin;

alter table public.ats_candidates
  add column if not exists declared_expected_salary text;

comment on column public.ats_candidates.declared_expected_salary is
  'The expected salary the applicant typed on WhatsApp, VERBATIM — "Negotiable", "25 k to 30 k", a range, Arabic numerals. Never coerced. expected_salary (numeric) is the parsed figure and is filled alongside this one only when the answer is a bare number; a recruiter reads THIS column.';

commit;
