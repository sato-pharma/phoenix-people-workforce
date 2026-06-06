-- Compatibility repair for replaying legacy employee lifecycle migrations.
-- The following columns existed in production before this migration chain was
-- made replayable, but 20260502131147 references them before adding them.

begin;

alter table public.employees
  add column if not exists region_name text,
  add column if not exists contract_start_date date,
  add column if not exists contract_renewal_date date,
  add column if not exists probation_end_date date,
  add column if not exists birth_date date;

notify pgrst, 'reload schema';

commit;
