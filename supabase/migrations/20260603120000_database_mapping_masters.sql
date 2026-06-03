-- Database Mapping console support for Source of Sales master tables.
-- The /sales/database-mapping admin page exports + imports the six master
-- tables (regions, areas, blocks, bricks, products, distributors). Import is
-- add + update only (never delete) and runs through the service-role server
-- client, so the existing service_role CRUD grants already cover it.
--
-- This migration only adds the editable `description` column to the region
-- master so the Region Master sheet (Region Code / Region Name / Description)
-- round-trips faithfully. Region Code + Region Name stay locked in the export.

begin;

alter table public.source_of_sales_regions
  add column if not exists description text;

-- Re-assert server-only write grants (idempotent; matches existing grants).
grant select, insert, update on table public.source_of_sales_regions to service_role;
grant select, insert, update on table public.source_of_sales_areas to service_role;
grant select, insert, update on table public.source_of_sales_blocks to service_role;
grant select, insert, update on table public.source_of_sales_bricks to service_role;
grant select, insert, update on table public.source_of_sales_products to service_role;
grant select, insert, update on table public.source_of_sales_distributors to service_role;

notify pgrst, 'reload schema';

commit;
