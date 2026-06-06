-- Compatibility columns required before employee master status backfills.

begin;

alter table public.employees
  add column if not exists bank_account text,
  add column if not exists social_insurance_number text,
  add column if not exists medical_insurance_number text,
  add column if not exists medical_insurance numeric,
  add column if not exists social_insurance numeric;

notify pgrst, 'reload schema';

commit;
