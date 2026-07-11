-- Payroll Copilot: add 'defer_to_balance' settlement method for unpaid vacation.
--
-- When an employee's vacation balance covers only PART of their unpaid leave
-- days, or when they have 0 balance, the CEO can choose to defer the remaining
-- unpaid days to the employee's future vacation balance accruals.
--
-- 'defer_to_balance' rows carry:
--   balance_days_consumed  — the ENTIRE unpaid duration (which creates negative balance debt)
--   salary_deduction_amount — null (no salary deduction happens now)

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
        'defer_to_balance'::text,
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
      settlement_method = 'partial_balance'::text
      and balance_days_consumed is not null
      and salary_deduction_amount is not null
    )
    or (
      -- Defer: consume what's available and carry forward the rest as debt
      settlement_method = 'defer_to_balance'::text
      and balance_days_consumed is not null
      and salary_deduction_amount is null
    )
    or (
      settlement_method = 'holiday_bridge_excluded'::text
      and salary_deduction_amount is null
      and balance_days_consumed is null
    )
  );

comment on column public.payroll_copilot_vacation_settlements.settlement_method is
  'How the unpaid leave cost was settled: salary (full salary deduction), balance (full balance consumption), partial_balance (balance consumed + remaining from salary), defer_to_balance (creates negative balance debt for future accruals), holiday_bridge_excluded (mandatory bridging deduction suppressed by HR).';
