-- Source-of-Sales: make the BLOCK a first-class reporting group.
--
-- Why this exists
-- ---------------
-- Sales roll up by area, brick, region, line, product, distributor, customer and period —
-- but NEVER by block. The grouping the business actually asks for ("what did Nasr City sell?")
-- already exists in the data as a block: B205 holds مدينة نصر + عباس العقاد + الحي السابع + 10
-- more. It was simply invisible, so reporting was forced to choose between one generic brick
-- (874 customers) or listing 13 rows.
--
-- Two things were missing and both are added here:
--   1. a MASTER brick per block — the place that NAMES the group, so a report can say
--      "مدينة نصر" instead of the block's street-list description;
--   2. a block-level rollup, so the group total is a real number.
--
-- Grouping also fixes the "brick sitting with no sales" complaint: 84 of 696 bricks carry no
-- customers, but only 9 of 154 blocks do. The thin bricks keep their precision for mapping
-- (the owner's standing rule is "always map on the smallest brick available") while reporting
-- rolls them into their group.
--
-- Safe to re-run. Additive only: no data is moved, renamed or deleted.

-- ---------------------------------------------------------------------------
-- 1. The group's master place + its display label
-- ---------------------------------------------------------------------------
alter table public.source_of_sales_blocks
  add column if not exists master_brick_id text,
  add column if not exists display_name    text;

comment on column public.source_of_sales_blocks.master_brick_id is
  'The brick that names this group in reports (e.g. مدينة نصر for B205). Nullable; falls back to display_name, then description.';
comment on column public.source_of_sales_blocks.display_name is
  'Optional human label for the group, overriding both the master brick name and the street-list description.';

-- ON DELETE SET NULL, never CASCADE: retiring a brick must never delete its block.
alter table public.source_of_sales_blocks
  drop constraint if exists source_of_sales_blocks_master_brick_fk;
alter table public.source_of_sales_blocks
  add  constraint source_of_sales_blocks_master_brick_fk
  foreign key (master_brick_id) references public.source_of_sales_bricks(brick_id)
  on update cascade on delete set null;

-- The master must belong to the block it names.
create or replace function public.phx_assert_master_brick_in_block() returns trigger
language plpgsql as $$
begin
  if new.master_brick_id is null then return new; end if;
  if not exists (
    select 1 from public.source_of_sales_bricks b
     where b.brick_id = new.master_brick_id and b.block_code = new.block_code
  ) then
    raise exception 'master_brick_id % does not belong to block %', new.master_brick_id, new.block_code;
  end if;
  return new;
end $$;

drop trigger if exists source_of_sales_blocks_master_brick_check on public.source_of_sales_blocks;
create trigger source_of_sales_blocks_master_brick_check
  before insert or update of master_brick_id, block_code on public.source_of_sales_blocks
  for each row execute function public.phx_assert_master_brick_in_block();

-- ---------------------------------------------------------------------------
-- 2. Backfill: the busiest brick names its group
-- ---------------------------------------------------------------------------
-- Only fills blanks, so an owner-chosen master is never overwritten by a re-run.
with ranked as (
  select b.block_code,
         b.brick_id,
         row_number() over (
           partition by b.block_code
           order by (select count(*) from public.source_of_sales_customer_map m
                      where m.brick_id = b.brick_id) desc,
                    b.brick_id
         ) as rn
  from public.source_of_sales_bricks b
)
update public.source_of_sales_blocks bl
   set master_brick_id = r.brick_id,
       updated_at      = now()
  from ranked r
 where r.block_code = bl.block_code
   and r.rn = 1
   and bl.master_brick_id is null;

-- ---------------------------------------------------------------------------
-- 3. The group itself, independent of whether any sales are loaded
-- ---------------------------------------------------------------------------
create or replace view public.source_of_sales_block_groups as
select bl.block_code,
       coalesce(bl.display_name, mb.brick_name, bl.description) as group_label,
       bl.description        as block_name,
       bl.display_name,
       bl.master_brick_id,
       mb.brick_name         as master_brick_name,
       bl.area_code,
       a.area_name,
       bl.region_code,
       bl.active,
       (select count(*) from public.source_of_sales_bricks b
         where b.block_code = bl.block_code)                     as brick_count,
       (select count(*) from public.source_of_sales_bricks b
         where b.block_code = bl.block_code
           and not exists (select 1 from public.source_of_sales_customer_map m
                            where m.brick_id = b.brick_id))      as bricks_without_customers,
       (select count(*) from public.source_of_sales_customer_map m
          join public.source_of_sales_bricks b on b.brick_id = m.brick_id
         where b.block_code = bl.block_code)                     as customer_count
from public.source_of_sales_blocks bl
join public.source_of_sales_areas a  on a.area_code = bl.area_code
left join public.source_of_sales_bricks mb on mb.brick_id = bl.master_brick_id;

comment on view public.source_of_sales_block_groups is
  'One row per reporting group (= block), with its master place, label and coverage. Read this instead of re-deriving the grouping.';

-- ---------------------------------------------------------------------------
-- 4. Sales rolled up to the group — the number that did not exist before
-- ---------------------------------------------------------------------------
-- Mirrors analytics.sos_by_area. sos_fact carries brick_id but no block_code, so the block is
-- resolved through the brick. Bricks are joined, not left-joined: a fact row whose brick has
-- been retired has no group, and silently inventing one would understate a real group.
create or replace view analytics.sos_by_block as
select f.period,
       f.year,
       f.month,
       f.region_code,
       f.region_name,
       f.area_code,
       f.area_name,
       b.block_code,
       coalesce(bl.display_name, mb.brick_name, bl.description) as group_label,
       bl.master_brick_id,
       f.channel,
       sum(f.units) as units,
       sum(f.value) as value
from analytics.sos_fact f
join public.source_of_sales_bricks b  on b.brick_id  = f.brick_id
join public.source_of_sales_blocks bl on bl.block_code = b.block_code
left join public.source_of_sales_bricks mb on mb.brick_id = bl.master_brick_id
group by f.period, f.year, f.month, f.region_code, f.region_name, f.area_code, f.area_name,
         b.block_code, bl.display_name, mb.brick_name, bl.description, bl.master_brick_id, f.channel;

comment on view analytics.sos_by_block is
  'Sales rolled up to the reporting group (block). The area/brick/region rollups already existed; this one did not.';

-- ---------------------------------------------------------------------------
-- 5. Self-check
-- ---------------------------------------------------------------------------
do $$
declare
  blocks_total   int;
  without_master int;
  bad_master     int;
begin
  select count(*) into blocks_total   from public.source_of_sales_blocks;
  select count(*) into without_master from public.source_of_sales_blocks where master_brick_id is null;
  select count(*) into bad_master
    from public.source_of_sales_blocks bl
    where bl.master_brick_id is not null
      and not exists (select 1 from public.source_of_sales_bricks b
                       where b.brick_id = bl.master_brick_id and b.block_code = bl.block_code);

  if bad_master > 0 then
    raise exception 'block grouping: % block(s) have a master brick outside their own block', bad_master;
  end if;

  raise notice 'block grouping ready: % groups, % still without a master (blocks with no bricks)',
    blocks_total, without_master;
end $$;
