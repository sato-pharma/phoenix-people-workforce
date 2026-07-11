-- Drop the now-inert editable distributor-profile override.
--
-- Distributor column mappings are defined ONLY by the code profiles (generated from the unified
-- Headers Mapping sheet) — the single source of truth. The runtime DB override was removed
-- (resolveDistributorProfile is code-only; the editable mapping tab + its API routes are gone), so
-- this table is no longer read or written. Its rows were already cleared in production.
--
-- Safe + reversible: re-creating the table (and re-enabling the editor) restores the old behaviour.
drop table if exists public.source_of_sales_distributor_profile cascade;
