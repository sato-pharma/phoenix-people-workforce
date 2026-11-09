-- Source Normalizer: El Ezaby's (EZB) recognition profile — the Phoenix upload template's own columns.
--
-- WHY
--   The Phoenix template resolves the "Distributor Name" it reads against the MERGED profile list
--   (listMergedDistributorProfiles — RAW_DISTRIBUTOR_PROFILES ∪ source_of_sales_distributor_profile),
--   not against source_of_sales_distributors. A distributor with no profile is refused as "a
--   distributor the system does not know" even though its distributor row exists — measured
--   2026-11-10 on El Ezaby's first upload. El Ezaby sends no export of its own (its sales arrive on
--   the Phoenix template), so a DB-only profile — the table's documented "newly-onboarded
--   distributor" case — carrying the template's headers is its whole profile.
--
--   Seeded 2026-11-10 by the session that imported El Ezaby's October 2026 book; this file records
--   it so a rebuilt database has it too.
--
-- ROLLBACK (additive):
--   delete from public.source_of_sales_distributor_profile where distributor_code = 'EZB';
--
-- Idempotent: on conflict do nothing, so a row edited in the profile editor survives a re-run.

insert into public.source_of_sales_distributor_profile (
  distributor_code, distributor_name, product_code_columns, product_name_columns, qty_columns, date_columns,
  customer_code_columns, customer_name_columns, customer_address_columns, area_name_columns,
  value_source, region_only, active, updated_by
)
values (
  'EZB', 'El Ezaby', '{"Product Code"}', '{"Product Name"}', '{"Quantity"}', '{"Invoice Date"}',
  '{"Customer Code"}', '{"Customer Name"}', '{"Customer Address"}', '{"Territory / Area"}',
  'recompute', false, true, 'B-10'
)
on conflict (distributor_code) do nothing;
