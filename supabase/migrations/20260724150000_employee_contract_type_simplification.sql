-- Simplify employees.contract_type to a work-time-commitment taxonomy:
-- "full time" / "semi-full time" / "part time" (or blank), replacing the old
-- contract-duration values (permanent/fixed-term/temporary/consultant/
-- internship) used by the bulk import template and the mismatched
-- full_time/part_time/temporary/contractor set used by the single-employee
-- edit form.
--
-- Owner-approved one-time data migration: existing 'fixed-term' and
-- 'full_time' values default to 'full time' (most fixed-term staff work
-- full-time hours; HR reviews/corrects individual exceptions afterward in
-- Employee Master). Blank values and any other legacy value are left
-- untouched rather than guessed at, since contract duration and work-time
-- commitment are different concepts.
update public.employees
set contract_type = 'full time'
where lower(trim(contract_type)) in ('fixed-term', 'fixed term', 'full_time', 'full time');

comment on column public.employees.contract_type is
  'Work-time commitment: full time / semi-full time / part time, or blank. Free text, set via Employee Master or bulk import.';
