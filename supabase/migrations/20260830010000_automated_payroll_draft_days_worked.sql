-- Automated Payroll: give a leaver's confirmed DAYS WORKED a home of its own.
--
-- WHY (owner-reported 2026-08-30): "I choose and select and confirm working days
-- of resignations in the resignations step ... then I go to the CRM deductions of
-- the resignations. I found that the working days I set in the resignations is
-- different than this."
--
-- He was right, and the cause was structural. `days_worked` had no column. The
-- Resignations step persisted only `base_for_month`, and every screen that
-- needed the day count re-derived it a DIFFERENT way:
--
--   * the Resignations tab divided the saved money back out:
--       base_for_month / (base_salary / calendar_days)
--   * the Resignations CRM tab ignored the draft entirely and recomputed from
--       the calendar: day-of-month(last_working_date) - unpaid_days
--
-- So the moment HR corrected the days — which is the whole reason the field was
-- made editable on 2026-07-25 — the two tabs disagreed. Measured on the live
-- August 2026 run (715d41fa-1c0e-4387-ab01-e1eb4824a6cb) at the time of this
-- migration, 7 of the 20 settled leavers disagreed, the worst by 28 days:
--
--   B-34  Sherouk Wael     Resignations 12.00 -> Resignations CRM 28
--   CN-0003 Samia Ali       Resignations  0.00 -> Resignations CRM 28
--   B-52  Fiby Wagdy        Resignations  3.00 -> Resignations CRM  9
--   AI-0003 Soad Atef       Resignations  0.00 -> Resignations CRM  9
--   B-179 Ashraf Maged      Resignations  0.50 -> Resignations CRM  9
--   B-112 Gerges Sameh      Resignations  0.00 -> Resignations CRM  5
--   B-175 Ahmed Nashaat     Resignations  0.00 -> Resignations CRM  3
--
-- The CRM tab caps Working + Non-Working days at its own figure, so Sherouk —
-- who worked 12 days — could be marked non-working for up to 28 of them.
--
-- Reverse-deriving was already fragile and became wrong on 2026-08-29, when the
-- owner ruled that a resignation prorates the whole NET salary. base_for_month
-- is only the Base share, so dividing it by a Base day-rate is now one of three
-- components answering a question none of them owns.
--
-- Additive and nullable: a NULL means "nobody has confirmed a figure, use the
-- settlement's own count", which is exactly the pre-existing behaviour. Nothing
-- reads this column until the application code that writes it ships.

alter table public.automated_payroll_draft_rows
  add column if not exists days_worked numeric(10, 2);

comment on column public.automated_payroll_draft_rows.days_worked is
  'Leaver/joiner days worked this month as CONFIRMED by HR on the Resignations step. '
  'The single source of truth for every Part 1 tab that needs a leaver day count '
  '(Resignations, Resignations CRM). NULL = not confirmed; fall back to the '
  'computed settlement. Never re-derive this from base_for_month — that is the '
  'bug this column closes (owner-reported 2026-08-30).';

-- Backfill: recover what HR has ALREADY confirmed on open runs so this month's
-- work is not lost. The old reverse-derivation is the honest reading of a saved
-- base_for_month, so it is used ONCE here, at the moment it is retired.
--
-- Scoped deliberately:
--   * open runs only (phase not published/cancelled) — a published run is
--     history and must not move.
--   * base_for_month IS NOT NULL — an untouched row stays NULL so it keeps
--     falling back to the computed settlement.
--   * base_salary > 0 — no division by zero, and an employee with no salary
--     figure (a real population here) yields no day count either way.
--   * capped at the month's calendar days, floored at 0.
update public.automated_payroll_draft_rows d
set days_worked = greatest(
      least(
        round((d.base_for_month / (e.base_salary / cal.days))::numeric, 2),
        cal.days
      ),
      0
    )
-- `employees` is joined through the WHERE clause, not the FROM join tree: in an
-- UPDATE ... FROM, the join tree cannot reference the target table `d`, so
-- `join public.employees e on ... = d.employee_hr_id_compact` is a 42P01 error.
from public.automated_payroll_runs r
cross join lateral (
  select extract(day from (make_date(r.year, r.month, 1) + interval '1 month - 1 day'))::numeric as days
) cal,
  public.employees e
where d.run_id = r.id
  and lower(replace(e.hr_id, '-', '')) = d.employee_hr_id_compact
  and r.phase not in ('published', 'cancelled')
  and d.days_worked is null
  and d.base_for_month is not null
  and coalesce(e.base_salary, 0) > 0;
