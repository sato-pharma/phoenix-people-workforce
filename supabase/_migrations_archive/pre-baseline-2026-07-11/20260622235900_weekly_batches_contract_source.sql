-- Phase 6B safety net: stamp each weekly sales batch with the column-contract it was parsed under
-- ('code' = built-in column positions, 'override' = an in-app edit was active). Lets an operator find
-- exactly which uploads were parsed under a given mapping if an edit ever turns out wrong, so the blast
-- radius of a bad column edit is scoped + re-importable instead of guessed. Additive + idempotent;
-- defaults to 'code' so existing rows + the no-override path are unchanged.

alter table public.weekly_sales_batches
  add column if not exists column_contract_source text not null default 'code';

alter table public.weekly_sales_batches
  drop constraint if exists weekly_sales_batches_column_contract_source_check;
alter table public.weekly_sales_batches
  add constraint weekly_sales_batches_column_contract_source_check
  check (column_contract_source in ('code', 'override'));
