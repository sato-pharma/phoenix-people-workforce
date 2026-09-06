-- A retired marketing customer must name its successor in a COLUMN, not in prose.
--
-- `marketing_pharmacies` has recorded a venue merge machine-readably since it shipped:
-- `merged_into_pharmacy_id`, `merged_at`, `merged_by_hr_id`, an ON DELETE SET NULL foreign key, a
-- not-self check and a partial index. `marketing_customers` has none of that, and there is no
-- customer-merge code path at all — a customer merge here is hand SQL.
--
-- The cost of that gap, measured on production 2026-09-06. Customer MKT-HCP-20260812-A26BF1C7 was
-- retired on 2026-08-21 and its venue link re-pointed to ROI-C-CF7662DC8FAF. The successor was
-- written only into free-text `validation_notes`. Request MKT-REQ-20260814-6CD456E4 — approved,
-- live, 11,200 EGP — was left pointing at the retired row, and the only way to discover that was
-- to read the prose. No join could find it, because there was nothing to join on.
--
-- These columns are the join. They record which row a retirement went to; they do not decide
-- whether a given merge was right. Deliberately shipped with NOTHING backfilled: the one known
-- merge on production spans two sales lines (Pedia -> CNS), which is the shape the owner's
-- 2026-08-19 "never shift, never shift" rule protects as a SHARED customer, so its successor is a
-- question for him and not a fact this migration may assert.
--
-- Additive and nullable: no existing read or write changes behaviour.

alter table public.marketing_customers
  add column if not exists merged_into_customer_id uuid,
  add column if not exists merged_at timestamptz,
  add column if not exists merged_by_hr_id text;

-- ON DELETE SET NULL, matching marketing_pharmacies_merged_into_fkey: deleting a survivor must
-- never cascade into the rows it absorbed. Losing the pointer is recoverable, losing the customer
-- is not.
alter table public.marketing_customers
  drop constraint if exists marketing_customers_merged_into_fkey;
alter table public.marketing_customers
  add constraint marketing_customers_merged_into_fkey
  foreign key (merged_into_customer_id) references public.marketing_customers(id) on delete set null;

-- A row can never be its own successor. Spelled as the sibling spells it, NULL-permissive, because
-- a plain `<>` would reject every un-merged row.
alter table public.marketing_customers
  drop constraint if exists marketing_customers_merged_not_self_check;
alter table public.marketing_customers
  add constraint marketing_customers_merged_not_self_check
  check (merged_into_customer_id is null or merged_into_customer_id <> id);

create index if not exists marketing_customers_merged_into_idx
  on public.marketing_customers using btree (merged_into_customer_id)
  where merged_into_customer_id is not null;

comment on column public.marketing_customers.merged_into_customer_id is
  'The surviving customer this row was merged into. NULL for every live row. Set it and deactivate in the same statement — a merged row left active is a duplicate the pickers still offer.';
comment on column public.marketing_customers.merged_at is
  'When the merge was recorded (Cairo is the reporting zone; this column stores UTC like every other timestamptz here).';
comment on column public.marketing_customers.merged_by_hr_id is
  'Who recorded the merge. Free text rather than an employees FK, matching marketing_pharmacies.merged_by_hr_id, because a hand repair may be attributed to a script rather than a person.';
