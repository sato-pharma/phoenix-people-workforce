-- Fix: The original inline check constraint `check (settlement_method in ('salary', 'balance'))`
-- was likely auto-named by Postgres (e.g. payroll_copilot_vacation_settlements_settlement_method_check)
-- and might not have been successfully dropped by the previous migrations if the auto-generated name differed slightly.
-- This block dynamically finds and drops any check constraints on this table that reference `settlement_method`.

DO $$ 
DECLARE
  r RECORD;
BEGIN
  FOR r IN 
    SELECT conname, pg_get_constraintdef(oid) as def
    FROM pg_constraint 
    WHERE conrelid = 'public.payroll_copilot_vacation_settlements'::regclass
      AND contype = 'c'
  LOOP
    IF r.def ILIKE '%settlement_method%' THEN
      EXECUTE 'ALTER TABLE public.payroll_copilot_vacation_settlements DROP CONSTRAINT ' || quote_ident(r.conname);
    END IF;
  END LOOP;
END $$;

-- Re-apply the unified check constraint encompassing all 4 valid methods:
alter table public.payroll_copilot_vacation_settlements
  add constraint payroll_copilot_vacation_settlements_method_values_check check (
    (settlement_method = 'salary' and salary_deduction_amount is not null and balance_days_consumed is null)
    or
    (settlement_method = 'balance' and balance_days_consumed is not null and salary_deduction_amount is null)
    or
    (settlement_method = 'partial_balance' and balance_days_consumed is not null and salary_deduction_amount is not null)
    or
    (settlement_method = 'defer_to_balance' and balance_days_consumed is not null and salary_deduction_amount is null)
    or
    (settlement_method = 'holiday_bridge_excluded' and balance_days_consumed is null and salary_deduction_amount is null)
  );
