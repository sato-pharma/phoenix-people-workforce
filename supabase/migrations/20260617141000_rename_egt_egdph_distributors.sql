-- Rename two distributor codes across the entire SoS database:
--   EG-T   (EGD Tender)  → EG-HOS (EGD Hospital)
--   EGD-PH (EGD-PH)      → EG-BR  (EGD Branch)
--
-- Order: insert new master rows first, migrate child tables, then remove old master rows.

-- 1. Ensure new distributor master rows exist (idempotent)
insert into public.source_of_sales_distributors (distributor_code, distributor_name, normalized_distributor_name, active)
values
  ('EG-HOS', 'EGD Hospital', 'egd hospital', true),
  ('EG-BR',  'EGD Branch',   'egd branch',   true)
on conflict (distributor_code) do update set
  distributor_name            = excluded.distributor_name,
  normalized_distributor_name = excluded.normalized_distributor_name,
  active                   = true;

-- 2. Migrate import rows (plain text column, no FK)
update public.source_of_sales_import_rows set distributor_code = 'EG-HOS' where distributor_code = 'EG-T';
update public.source_of_sales_import_rows set distributor_code = 'EG-BR'  where distributor_code = 'EGD-PH';

-- 3. Migrate import batches (FK → source_of_sales_distributors; new rows exist from step 1)
update public.source_of_sales_import_batches set distributor_code = 'EG-HOS' where distributor_code = 'EG-T';
update public.source_of_sales_import_batches set distributor_code = 'EG-BR'  where distributor_code = 'EGD-PH';

-- 4. Remove old distributor rows (no batches reference them anymore)
delete from public.source_of_sales_distributors where distributor_code in ('EG-T', 'EGD-PH');
