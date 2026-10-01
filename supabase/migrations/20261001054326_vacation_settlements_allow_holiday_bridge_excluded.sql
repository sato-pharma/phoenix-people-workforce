-- WHAT
-- Adds the fifth branch, 'holiday_bridge_excluded', to
-- public.payroll_copilot_vacation_settlements_method_values_check. That branch carries NEITHER
-- salary_deduction_amount NOR balance_days_consumed: both must be NULL.
--
-- WHY
-- recordHolidayBridgingDecision (src/lib/payroll/copilot/holiday-bridging.ts) has never been able
-- to insert a row. It writes settlement_method = 'holiday_bridge_excluded' with both figures unset,
-- and the live constraint has exactly four branches — salary, balance, partial_balance,
-- defer_to_balance — so no branch can be satisfied and every insert is refused 23514. Measured
-- read-only on production ozucdzovmcqvepbozvqf on 2026-10-01: zero rows carrying that method have
-- ever existed, in a table holding 8 rows in total. The refusal was proved on staging
-- cifwmndunmlxjhyjugxa the same day inside a DO block that raised at the end, so nothing committed:
--   sqlstate=[23514] "violates check constraint
--   payroll_copilot_vacation_settlements_method_values_check"
--
-- The branch was intended from the start. The archived
-- 20260708020000_vacation_settlements_allow_holiday_bridge_excluded.sql added it, and the archived
-- 20260708220000_vacation_settlements_drop_all_method_checks.sql re-stated it alongside
-- partial_balance and defer_to_balance — five branches. The 2026-07-11 baseline dump
-- (20260711135352_phoenix_production_schema_baseline.sql) re-pinned the constraint with four,
-- dropping that one, and the Holiday Bridging tab has thrown a 500 at HR ever since: the route
-- (app/api/payroll/copilot/[runId]/deductions/holiday-bridging/route.ts) rethrows, so the Exclude
-- button fails loudly rather than silently — it was never a quiet no-op.
--
-- This does NOT change anyone's leave balance, now or later. balanceSettledDaysInPeriod
-- (src/lib/vacation/service.ts) sums balance_days_consumed only over
-- settlement_method IN ('balance','partial_balance','defer_to_balance'); 'holiday_bridge_excluded'
-- is outside that set, and this branch forces balance_days_consumed NULL regardless. A bridging
-- exclusion is a payroll-sheet-only marker meaning "do not apply the mandatory holiday-bridging
-- deduction here", exactly as the archived migration described.
--
-- NOT WIDENED, DELIBERATELY: payroll_copilot_vacation_settlements_live_idx is a UNIQUE index over
-- (employee_hr_id_compact, start_date) WHERE superseded_at IS NULL. So a bridging exclusion and an
-- ordinary unpaid-vacation settlement for the same employee and the same date still cannot both be
-- live — the archived migration's comment claimed they "can never collide", which is false against
-- this schema. Widening that index to include settlement_method would let two live rows share a
-- slot, and because balanceSettledDaysInPeriod sums across three methods that would double-count
-- somebody's consumed balance. The collision is therefore left in place and handled in the
-- application: the insert is attempted first, 23505 retires nothing, and HR is told the slot is
-- held. Exposure on production today is two live rows in the whole table.
--
-- ROLLBACK
-- Fully reversible, and the reverse statement is the four-branch definition this replaces:
--   alter table public.payroll_copilot_vacation_settlements
--     drop constraint if exists payroll_copilot_vacation_settlements_method_values_check;
--   alter table public.payroll_copilot_vacation_settlements
--     add constraint payroll_copilot_vacation_settlements_method_values_check check (
--       (settlement_method = 'salary' and salary_deduction_amount is not null and balance_days_consumed is null)
--       or (settlement_method = 'balance' and balance_days_consumed is not null and salary_deduction_amount is null)
--       or (settlement_method = 'partial_balance' and balance_days_consumed is not null and salary_deduction_amount is not null)
--       or (settlement_method = 'defer_to_balance' and balance_days_consumed is not null and salary_deduction_amount is null)
--     );
-- Rolling back once 'holiday_bridge_excluded' rows exist would make the constraint unvalidatable
-- against them, so the reverse must supersede or delete those rows first. No row loss either way
-- from THIS migration: it widens what is accepted and rejects nothing that is currently stored.
-- No data is written or removed here, and nothing is destructive or bulk.

alter table public.payroll_copilot_vacation_settlements
  drop constraint if exists payroll_copilot_vacation_settlements_method_values_check;

alter table public.payroll_copilot_vacation_settlements
  add constraint payroll_copilot_vacation_settlements_method_values_check check (
    (
      settlement_method = 'salary'
      and salary_deduction_amount is not null
      and balance_days_consumed is null
    )
    or (
      settlement_method = 'balance'
      and balance_days_consumed is not null
      and salary_deduction_amount is null
    )
    or (
      settlement_method = 'partial_balance'
      and balance_days_consumed is not null
      and salary_deduction_amount is not null
    )
    or (
      settlement_method = 'defer_to_balance'
      and balance_days_consumed is not null
      and salary_deduction_amount is null
    )
    or (
      -- HR's exclusion of one mandatory holiday-bridging day: nothing is paid and no balance is
      -- consumed, so BOTH figures must be NULL. Written only by recordHolidayBridgingDecision.
      settlement_method = 'holiday_bridge_excluded'
      and salary_deduction_amount is null
      and balance_days_consumed is null
    )
  );

comment on constraint payroll_copilot_vacation_settlements_method_values_check
  on public.payroll_copilot_vacation_settlements is
  'Five settlement methods. salary/balance/partial_balance/defer_to_balance each carry the figure(s) their method implies. holiday_bridge_excluded carries NEITHER — it is a payroll-sheet-only marker that HR excluded one mandatory holiday-bridging day, and it is deliberately outside the method set balanceSettledDaysInPeriod sums, so it can never move a leave balance.';
