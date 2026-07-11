-- Restore the "Direct (Company)" channel row in source_of_sales_distributors.
--
-- It was originally seeded by 20260604101304_direct_channel.sql, but the manual
-- Source-of-Sales data reset (2026-06-08 TRUNCATE) wiped the distributors table and
-- the re-seed only restored the 10 normalizer distributors — "Direct" is a coded
-- (company-direct) channel, not a normalizer profile, so it was dropped from the
-- Upload Sales dropdown. The is_direct column and the phx_*_direct / exec functions
-- from the original migration are unaffected (schema/functions survive a data TRUNCATE);
-- only this reference row is missing. Idempotent + reversible — no other data touched.

insert into public.source_of_sales_distributors
  (distributor_code, distributor_name, normalized_distributor_name, active)
values ('Direct', 'Direct (Company)', 'direct (company)', true)
on conflict (distributor_code) do update
  set distributor_name = excluded.distributor_name,
      normalized_distributor_name = excluded.normalized_distributor_name,
      active = true,
      updated_at = now();
