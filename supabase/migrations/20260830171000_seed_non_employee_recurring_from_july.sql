-- Seed the standing Non-Employees Payroll roster from the last hand-built month.
-- Owner request 2026-08-30, following the audit of the July 2026 run.
--
-- The July 2026 run (published) carried seven hand-typed entries totalling
-- EGP 381,535.00 — six on Part 1 for EGP 291,535.00 and one on Part 2 for
-- EGP 90,000.00 — and the August run, open since 2026-08-01, had none of them.
-- This copies that month's list onto the register so the first automatically
-- seeded month reproduces the last hand-built one exactly.
--
-- The values are READ OUT OF THE DATABASE rather than written here on purpose.
-- These are real people's names and real bank account numbers; no migration in
-- this repository has ever put either in Git, and this one is not going to be
-- the first. The July run is the authority for what July paid, so copying from
-- it is also the more truthful source — a literal list in this file would be a
-- second copy of the same facts, free to drift from the run it claims to
-- reproduce.
--
-- Idempotent twice over: `on conflict do nothing` against the
-- (lower(btrim(full_name_en)), part) unique index, and `do nothing` rather than
-- `do update` because this file is a starting point, not the authority. Once the
-- register is live the register wins, and re-running this must never overwrite an
-- amount an admin has since corrected.
--
-- On an environment with no July 2026 run (a fresh developer database) this
-- selects zero rows and does nothing, which is correct: there is nothing to
-- reproduce.
--
-- Note for whoever reads this next: three of the seven (HR ids AA, AB, OF-0002)
-- DO hold employee records and are marked active, but have never had a row in
-- salary_records — this list is their only payroll channel, which is why they
-- belong on the register rather than in the normal payroll population. Confirmed
-- with the owner on 2026-08-30.

insert into public.automated_payroll_non_employee_recurring
  (full_name_en, full_name_ar, total_salary, bank_name, bank_account, part, active, note, created_by)
select distinct on (lower(btrim(ne.full_name_en)), ne.part)
       ne.full_name_en,
       ne.full_name_ar,
       ne.total_salary,
       ne.bank_name,
       ne.bank_account,
       ne.part,
       true,
       'Seeded from the July 2026 run.',
       'system'
from public.automated_payroll_non_employees ne
join public.automated_payroll_runs r on r.id = ne.run_id
where r.year = 2026
  and r.month = 7
order by lower(btrim(ne.full_name_en)), ne.part, ne.created_at
on conflict do nothing;
