-- Payroll Copilot: allow 'holiday_bridge_excluded' on payroll_copilot_vacation_settlements.
--
-- New owner-dictated rule: a leave day taken directly before or directly
-- after a national holiday is a MANDATORY salary deduction (no employee
-- balance touched), regardless of whether the employee otherwise has leave
-- balance. This is computed live every time the payroll sheet assembles
-- (application code, not this migration) and applies BY DEFAULT — there is
-- no "approve" step, mirroring the existing mandatory no-activity (CRM)
-- deduction. HR only needs to act to EXCLUDE a specific bridging day (e.g.
-- the holiday date turns out to be wrong, or the leave request shouldn't
-- count) — that exclusion is the one thing this migration adds storage for.
--
-- settlement_method='holiday_bridge_excluded' represents that HR-reviewed
-- exclusion for one (employee, bridging date) pair. Unlike 'salary'/'balance'
-- rows (which always carry exactly one of salary_deduction_amount /
-- balance_days_consumed), an exclusion carries neither — there is nothing to
-- pay out, it is purely a "don't apply the mandatory deduction here" marker.
-- Existing 'salary'/'balance' rows and their queries are untouched: every
-- application query for holiday-bridging state filters specifically on
-- settlement_method='holiday_bridge_excluded', so it can never collide with
-- an ordinary unpaid-vacation salary/balance settlement that happens to share
-- the same (employee, date) key.
--
-- Idempotent: drop-if-exists then recreate. No data change — no existing row
-- uses the new value.

alter table public.payroll_copilot_vacation_settlements
  drop constraint if exists payroll_copilot_vacation_settlements_settlement_method_check;

alter table public.payroll_copilot_vacation_settlements
  add constraint payroll_copilot_vacation_settlements_settlement_method_check
  check (
    settlement_method = any (
      array[
        'salary'::text,
        'balance'::text,
        'holiday_bridge_excluded'::text
      ]
    )
  );

alter table public.payroll_copilot_vacation_settlements
  drop constraint if exists payroll_copilot_vacation_settlements_method_values_check;

alter table public.payroll_copilot_vacation_settlements
  add constraint payroll_copilot_vacation_settlements_method_values_check
  check (
    (
      settlement_method = 'salary'::text
      and salary_deduction_amount is not null
      and balance_days_consumed is null
    )
    or (
      settlement_method = 'balance'::text
      and balance_days_consumed is not null
      and salary_deduction_amount is null
    )
    or (
      settlement_method = 'holiday_bridge_excluded'::text
      and salary_deduction_amount is null
      and balance_days_consumed is null
    )
  );
