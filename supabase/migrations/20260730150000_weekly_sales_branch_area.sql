-- Weekly Sales: give the branch→region map an OPTIONAL area, and stamp it onto the fact rows.
--
-- WHY: weekly_sales_rows has no area/brick/customer dimension — its grain is the distributor BRANCH
-- (a depot: "Kafr El Sheikh Branch", "Tanta Branch"). That made it impossible to scope a District
-- Manager by his actual areas, which matters because a district's areas are not always inside its
-- geographic region: CNS "Kafr El-Sheikh 1" (D16) is operationally owned by the Alex-BHR DM but sits
-- in Delta (1). Region-only scoping therefore hid that rep's weekly numbers from his own manager,
-- and widening his region to reach them would have exposed the whole of Delta (1).
--
-- A branch is a depot, not a rep territory, so an area is only ever asserted where the owner says the
-- branch genuinely belongs to one area. It stays NULL otherwise, and an unmapped branch keeps exactly
-- today's region-scoped behaviour — this migration cannot change what any viewer currently sees until
-- someone populates area_code.
--
-- Additive and reversible: both columns are nullable with no default and no code path requires them.

-- 1. The mapping gains an optional area target, validated against the Source-of-Sales area master.
alter table public.weekly_sales_branch_region_map
  add column if not exists area_code text,
  add column if not exists area_name text;

comment on column public.weekly_sales_branch_region_map.area_code is
  'Optional Source-of-Sales area this branch belongs to. NULL = region-only mapping (the default): '
  'rows from this branch stay region-scoped. Must sit inside region_code — enforced in the service '
  'layer and by the check below.';

-- 2. The fact rows carry the resolved area so the dashboard can filter on it without a join.
alter table public.weekly_sales_rows
  add column if not exists area_code text;

comment on column public.weekly_sales_rows.area_code is
  'Area resolved from the branch mapping at import time. NULL when the branch has no area mapping, '
  'in which case the row is scoped by region_code exactly as before.';

-- 3. An area, when set, must be a real active area inside the branch''s mapped region. Written as a
--    trigger rather than a FK because source_of_sales_areas is keyed by (area_code) but the region
--    consistency check spans two columns, and because a bad value must fail the WRITE loudly rather
--    than silently mis-scope a manager's dashboard later.
create or replace function public.weekly_branch_area_is_consistent()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_region text;
begin
  if new.area_code is null or btrim(new.area_code) = '' then
    new.area_code := null;
    new.area_name := null;
    return new;
  end if;

  select a.region_code, a.area_name
    into v_region, new.area_name
    from public.source_of_sales_areas a
   where upper(btrim(a.area_code)) = upper(btrim(new.area_code))
     and a.active
   limit 1;

  if v_region is null then
    raise exception 'Area code % is not an active Source-of-Sales area', new.area_code
      using errcode = '23514';
  end if;

  if upper(btrim(v_region)) <> upper(btrim(coalesce(new.region_code, ''))) then
    raise exception 'Area % belongs to region %, not the branch''s mapped region %',
      new.area_code, v_region, new.region_code
      using errcode = '23514';
  end if;

  new.area_code := upper(btrim(new.area_code));
  return new;
end;
$$;

revoke all on function public.weekly_branch_area_is_consistent() from public;

drop trigger if exists weekly_branch_area_is_consistent_trg on public.weekly_sales_branch_region_map;
create trigger weekly_branch_area_is_consistent_trg
  before insert or update on public.weekly_sales_branch_region_map
  for each row execute function public.weekly_branch_area_is_consistent();

-- 4. Backfill the existing fact rows from whatever the map already says. Today that is a no-op
--    (no branch has an area yet); it is here so re-running this migration after the owner populates
--    the map repairs history without waiting for the next weekly upload. Matched on the same
--    (distributor, normalized branch) key the parser uses, restricted to non-excluded rows.
update public.weekly_sales_rows r
   set area_code = m.area_code
  from public.weekly_sales_branch_region_map m
 where m.area_code is not null
   and not m.excluded
   and upper(btrim(m.distributor_code)) = upper(btrim(r.distributor_code))
   and upper(btrim(coalesce(m.raw_branch, ''))) in (
         upper(btrim(coalesce(r.branch_code, ''))),
         upper(btrim(coalesce(r.branch_name, '')))
       )
   and r.area_code is distinct from m.area_code;

create index if not exists weekly_sales_rows_area_code_idx
  on public.weekly_sales_rows (area_code)
  where area_code is not null;
