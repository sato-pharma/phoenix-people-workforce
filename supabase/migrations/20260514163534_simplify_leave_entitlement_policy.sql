-- Phoenix Workforce Leave Management entitlement simplification.
-- Keeps only the real company annual entitlement policy:
-- < 1 year service = 15 days, >= 1 year service = 21 days.
-- This migration removes obsolete extended-entitlement policy columns only.

begin;

update public.leave_policies
set annual_days_first_year = 15,
    annual_days_after_first_year = 21,
    accrual_method = 'monthly',
    accrual_frequency = 'monthly',
    updated_at = now()
where annual_days_first_year <> 15
   or annual_days_after_first_year <> 21
   or accrual_method <> 'monthly'
   or accrual_frequency <> 'monthly'
   or is_default = true;

alter table public.leave_policies
  drop column if exists annual_days_senior,
  drop column if exists annual_days_disability,
  drop column if exists senior_after_years,
  drop column if exists senior_after_age;

alter table public.leave_policies
  drop constraint if exists leave_policies_accrual_method_check,
  add constraint leave_policies_accrual_method_check
    check (accrual_method = 'monthly');

alter table public.leave_policies
  drop constraint if exists leave_policies_accrual_frequency_check,
  add constraint leave_policies_accrual_frequency_check
    check (accrual_frequency = 'monthly');

alter table public.employees
  drop column if exists has_disability;

commit;
