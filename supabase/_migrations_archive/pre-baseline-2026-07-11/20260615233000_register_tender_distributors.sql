-- Register the five tender-channel distributors for the Source of Sales Upload dropdown and the
-- source_of_sales_import_rows.distributor_code FK. Each is its own distributor (kept separate from the
-- parent's regular pharmacy file) and has a code-defined raw layout profile in
-- src/lib/sales/normalizer/profiles.ts. They are also re-ensured by SYSTEM_DISTRIBUTORS after every
-- distributor-master import (src/lib/sales/master-data/import-service.ts), so they survive data resets.
-- Idempotent — mirrors 20260611035438_register_egd_ph_distributor.sql.
insert into public.source_of_sales_distributors
  (distributor_code, distributor_name, normalized_distributor_name, active)
values
  ('IS-T', 'Ibn Sina Tender', 'ibn sina tender', true),
  ('PS-T', 'Overseas Tender', 'overseas tender', true),
  ('RM-T', 'Ramco Tender', 'ramco tender', true),
  ('SF-T', 'Sofico Tender', 'sofico tender', true),
  ('EG-T', 'EGD Tender', 'egd tender', true)
on conflict (distributor_code) do update
  set distributor_name = excluded.distributor_name,
      normalized_distributor_name = excluded.normalized_distributor_name,
      active = true,
      updated_at = now();
