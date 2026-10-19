-- A Training Manager can now be sent an offer worded for the job.
--
-- THE GAP. The Job Titles catalogue held three sales titles, Office Coordinator and Talent
-- Acquisition Specialist and no Training Manager, so choosing one meant typing the title by hand and
-- getting the role-neutral standard paragraph with no reporting line and no cost of living: the
-- letter's compensation table then had nothing to subtract and the hire it produces nothing to agree
-- with. This adds the title as a row, beside the others, with its own words.
--
-- THE FIGURES. Cost of living 3,500 is payroll's own pair for the title (3,000 allowance + 500
-- fuel, src/lib/payroll/salary-autofill.ts), the same agreement the three sales titles keep, so the
-- letter and the employee record describe the same money. Reports-to is the Marketing Manager, who is
-- the manager on the current Training Manager's employee record. All three are editable on the Job
-- Titles screen, and an offer can still override them.
--
-- THE WORDS. A starting paragraph about learning work, with no territory, field team or sales number
-- in it. `on conflict do nothing` plus the NULL guard below mean re-running this never overwrites
-- anything HR has since typed.

begin;

insert into public.offer_job_titles (title, cost_of_living, reports_to, contract_term)
values ('Training Manager', 3500, 'Marketing Manager', 'One year, renewable')
on conflict do nothing;

update public.offer_job_titles
set role_summary =
  'Throughout our selection process you demonstrated the expertise and the teaching skill this role '
  || 'calls for, and we would like you to bring both to {{territory}}. In this role you will own the '
  || 'learning of our teams ' || chr(8212) || ' designing and delivering product-knowledge, '
  || 'selling-skills and induction programmes, coaching representatives in the field, measuring what '
  || 'each programme changes in practice, and giving managers a clear view of how ready every team is.'
where role_summary is null
  and lower(btrim(title)) = 'training manager';

commit;
