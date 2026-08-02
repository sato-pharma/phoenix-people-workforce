-- Deductions: record WHICH days a decision actually charges, not just how many.
--
-- `applied_value` has always been able to say "deduct 12 days instead of the 14
-- we detected", but nothing recorded which 2 days were dropped. The reviewer had
-- to hold that in their head, the publication snapshot still listed all 14 dates,
-- and the cross-category double-deduction gate still saw a day the reviewer had
-- already cleared — so clearing it in one category could not resolve the clash.
--
-- NULL is deliberately distinct from '[]'::jsonb:
--   NULL  -> the reviewer never narrowed the days; every detected day applies.
--   []    -> the reviewer explicitly cleared every day (0 days, 0.00 EGP).
-- Defaulting to '[]' instead would silently reinterpret every existing decision
-- as "charge nothing", which is a company-wide silent pay change.

alter table public.deductions_decisions
  add column if not exists applied_dates jsonb;

alter table public.deductions_decisions
  drop constraint if exists deductions_decisions_applied_dates_is_array;

alter table public.deductions_decisions
  add constraint deductions_decisions_applied_dates_is_array
    check (applied_dates is null or jsonb_typeof(applied_dates) = 'array');

comment on column public.deductions_decisions.applied_dates is
  'The exact days this decision charges, as a jsonb array of YYYY-MM-DD strings. NULL means the reviewer never narrowed the selection, so the candidate''s full `dates` array applies — NOT that nothing is charged. Always a subset of the parent candidate''s `dates`; the application layer rejects any day the detection engine did not find.';
