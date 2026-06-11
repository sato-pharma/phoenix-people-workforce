-- Register the EPDA "Bulk" (wholesale / جملة) distributor branch (code EP-B) so it appears in the
-- Upload Sales dropdown, passes the unknown-distributor check, and satisfies the
-- source_of_sales_import_rows.distributor_code FK. Its normalizer profile (RAW_DISTRIBUTOR_PROFILES
-- "EP-B" in src/lib/sales/normalizer/profiles.ts) reads the Phoenix Brick ID straight from the sheet's
-- "Column1" and resolves products from class_code/class_name via the alias dictionary. Idempotent +
-- reversible — additive reference row only.

insert into public.source_of_sales_distributors
  (distributor_code, distributor_name, normalized_distributor_name, active)
values ('EP-B', 'EPDA Bulk', 'epda bulk', true)
on conflict (distributor_code) do update
  set distributor_name = excluded.distributor_name,
      normalized_distributor_name = excluded.normalized_distributor_name,
      active = true,
      updated_at = now();
