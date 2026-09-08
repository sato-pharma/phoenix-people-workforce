-- Pin the customer map's cached area/region to its own brick.
--
-- source_of_sales_customer_map denormalizes area_code and region_code off the brick, and nothing
-- kept them in step. When Beni Suef (UE9) was split out of Fayoum (GZ6) on 2026-08-03 the blocks
-- were re-parented and the bricks followed, but 866 customer rows carried on caching Fayoum. A
-- further 27 rows kept a stale region after the owner-ruling backfill of 2026-08-10. Both sets were
-- repaired on 2026-09-09; the pre-image is sos_backup_20260909.customer_map_area_pre.
--
-- The sales path never read those columns (it derives the area from the brick), so no booked sale
-- and no published closing was affected. Direct orders and Customer 360 DO read them verbatim, so
-- the stale rows were a live trap for the next direct order at one of those pharmacies.
--
-- This is the guard bricks already have against blocks (source_of_sales_bricks_block_hierarchy_fk):
-- a composite FK, so the triple can never disagree, plus ON UPDATE CASCADE so a future territory
-- move re-stamps every customer row automatically instead of stranding it.
--
-- Rehearsed on staging before production. A wrong area write is rejected; re-parenting a block
-- moved all 991 affected customer rows with zero left stale.
--
-- brick_id is already the primary key of source_of_sales_bricks; the extra UNIQUE is only the
-- scaffolding a composite FK requires, exactly as source_of_sales_blocks_block_area_region_key is
-- for the bricks -> blocks FK.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'source_of_sales_bricks_brick_area_region_key'
       and conrelid = 'public.source_of_sales_bricks'::regclass
  ) then
    alter table public.source_of_sales_bricks
      add constraint source_of_sales_bricks_brick_area_region_key
      unique (brick_id, area_code, region_code);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'source_of_sales_customer_map_brick_hierarchy_fk'
       and conrelid = 'public.source_of_sales_customer_map'::regclass
  ) then
    alter table public.source_of_sales_customer_map
      add constraint source_of_sales_customer_map_brick_hierarchy_fk
      foreign key (brick_id, area_code, region_code)
      references public.source_of_sales_bricks (brick_id, area_code, region_code)
      on update cascade on delete restrict;
  end if;
end $$;
