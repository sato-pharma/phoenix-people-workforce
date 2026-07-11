-- Payroll Copilot: add 'partial_balance' settlement method for unpaid vacation.
--
-- When an employee's vacation balance covers only PART of their unpaid leave
-- days, the CEO can now choose to consume all available balance days immediately
-- and deduct the remaining days from salary in the same payroll run — rather
-- than being forced to deduct everything from salary.
--
-- 'partial_balance' rows carry BOTH:
--   balance_days_consumed  — days consumed from vacation balance (non-null)
--   salary_deduction_amount — EGP amount deducted from salary for the remainder (non-null)
--
-- This is an additive change: existing 'salary' and 'balance' rows and all
-- queries that filter by those exact method values are completely unaffected.
-- Idempotent: drop-if-exists then recreate constraints. No data changes.

alter table public.payroll_copilot_vacation_settlements
  drop constraint if exists payroll_copilot_vacation_settlements_settlement_method_check;

alter table public.payroll_copilot_vacation_settlements
  add constraint payroll_copilot_vacation_settlements_settlement_method_check
  check (
    settlement_method = any (
      array[
        'salary'::text,
        'balance'::text,
        'partial_balance'::text,
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
      -- Partial: some days from balance, remaining from salary.
      -- Both columns are populated.
      settlement_method = 'partial_balance'::text
      and balance_days_consumed is not null
      and salary_deduction_amount is not null
    )
    or (
      settlement_method = 'holiday_bridge_excluded'::text
      and salary_deduction_amount is null
      and balance_days_consumed is null
    )
  );

comment on column public.payroll_copilot_vacation_settlements.settlement_method is
  'How the unpaid leave cost was settled: salary (full salary deduction), balance (full balance consumption), partial_balance (balance consumed + remaining from salary), holiday_bridge_excluded (mandatory bridging deduction suppressed by HR).';
