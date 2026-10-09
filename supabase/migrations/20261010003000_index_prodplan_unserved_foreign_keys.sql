-- Add an index for each production-planning foreign key that has no index able to serve it, and
-- change nothing else.
--
-- WHAT
--   Nine btree indexes on the prodplan_* tables, one per foreign key whose referencing columns are
--   not the leading columns of any existing index:
--     prodplan_alarm_events      (product_id)
--     prodplan_compositions      (material_id, unit_kind)
--     prodplan_expiry_events     (location_id)
--     prodplan_expiry_events     (product_id)
--     prodplan_plan_lines        (material_id, unit_kind)
--     prodplan_product_materials (material_id)
--     prodplan_products          (factory_location_id)
--     prodplan_runs              (plan_id)
--     prodplan_stock_entries     (location_id)
--
-- WHY
--   Postgres does not index the referencing side of a foreign key. Deleting or re-keying a parent
--   row (a material, a product, a location, a plan) makes the engine look up the child rows, and
--   without an index that lookup scans the child table; ON DELETE CASCADE / SET NULL / RESTRICT
--   all pay it. Joins from the parent into these children (a material's compositions, a location's
--   stock) pay the same scan.
--
-- WHAT IS DELIBERATELY NOT INDEXED
--   Five more foreign keys read as unindexed to a strict checker but are already served, because an
--   existing index LEADS with their first column, which is what a parent-side lookup needs:
--     prodplan_alarm_events.material_fk       unique (material_id, evaluated_on, dry_run)
--     prodplan_expiry_events.material_fk      unique (material_id, location_id, ...)
--     prodplan_material_prices.material_fk    (material_id, currency, effective_from DESC)
--     prodplan_run_materials.material_fk      (material_id, run_id)
--     prodplan_stock_entries.material_fk      (material_id, location_id, ...)
--   Each of those composite keys is (material_id, unit_kind). unit_kind has two values at most
--   (`mass` or `count`), so the leading material_id column already narrows to the
--   one parent. A second index on the same leading column would add write cost and one more
--   idle-index reading for no change in plan.
--
-- SIZE AND LOCKING
--   Every table here is under 100 kB on production (largest: prodplan_stock_entries, 37 rows), so a
--   plain CREATE INDEX takes well under a second. It holds a SHARE lock, which blocks writes to that
--   one table for that moment; `lock_timeout` makes it give up rather than queue behind a long
--   transaction. CONCURRENTLY is not used because it cannot run inside a migration transaction.
--
-- ADVISOR BASELINE
--   These nine indexes will read as `unused_index` (idx_scan = 0) until the planning screens use
--   them. That count is 666 live against 722 accepted (scripts/advisor-baseline.json), so nine more
--   stays inside it. Not a reason to raise the number.
--
-- RE-APPLY / OTHER DATABASES
--   CREATE INDEX IF NOT EXISTS, so a second run is a no-op. A table that does not exist is skipped
--   with a notice. The block ends by re-asking the catalog and RAISES if any of the nine foreign
--   keys on a table that exists still has no index leading with its columns.
--
-- ROLLBACK
--   drop index public.prodplan_alarm_events_product_id_idx;
--   drop index public.prodplan_compositions_material_fk_idx;
--   drop index public.prodplan_expiry_events_location_id_idx;
--   drop index public.prodplan_expiry_events_product_id_idx;
--   drop index public.prodplan_plan_lines_material_fk_idx;
--   drop index public.prodplan_product_materials_material_id_idx;
--   drop index public.prodplan_products_factory_location_id_idx;
--   drop index public.prodplan_runs_plan_id_idx;
--   drop index public.prodplan_stock_entries_location_id_idx;

do $$
declare
  r        record;
  v_unserved integer;
begin
  set local lock_timeout = '5s';

  for r in
    select * from (values
      ('prodplan_alarm_events',      'prodplan_alarm_events_product_id_idx',         'product_id'),
      ('prodplan_compositions',      'prodplan_compositions_material_fk_idx',        'material_id, unit_kind'),
      ('prodplan_expiry_events',     'prodplan_expiry_events_location_id_idx',       'location_id'),
      ('prodplan_expiry_events',     'prodplan_expiry_events_product_id_idx',        'product_id'),
      ('prodplan_plan_lines',        'prodplan_plan_lines_material_fk_idx',          'material_id, unit_kind'),
      ('prodplan_product_materials', 'prodplan_product_materials_material_id_idx',   'material_id'),
      ('prodplan_products',          'prodplan_products_factory_location_id_idx',    'factory_location_id'),
      ('prodplan_runs',              'prodplan_runs_plan_id_idx',                    'plan_id'),
      ('prodplan_stock_entries',     'prodplan_stock_entries_location_id_idx',       'location_id')
    ) as t(tbl, idx, cols)
  loop
    if to_regclass('public.' || r.tbl) is null then
      raise notice 'public.% does not exist here - skipped', r.tbl;
      continue;
    end if;
    execute format('create index if not exists %I on public.%I (%s)', r.idx, r.tbl, r.cols);
  end loop;

  -- Re-read, never assume: no foreign key on a prodplan_* table that this file covers is left
  -- without an index whose leading columns are the key's columns, in key order.
  select count(*)
    into v_unserved
    from pg_constraint c
   where c.contype = 'f'
     and c.connamespace = 'public'::regnamespace
     and c.conrelid::regclass::text in (
       'prodplan_alarm_events', 'prodplan_compositions', 'prodplan_expiry_events', 'prodplan_plan_lines',
       'prodplan_product_materials', 'prodplan_products', 'prodplan_runs', 'prodplan_stock_entries')
     and c.conname in (
       'prodplan_alarm_events_product_id_fkey',
       'prodplan_compositions_material_fk',
       'prodplan_expiry_events_location_id_fkey',
       'prodplan_expiry_events_product_id_fkey',
       'prodplan_plan_lines_material_fk',
       'prodplan_product_materials_material_id_fkey',
       'prodplan_products_factory_location_id_fkey',
       'prodplan_runs_plan_id_fkey',
       'prodplan_stock_entries_location_id_fkey')
     and not exists (
       select 1
         from pg_index i
        where i.indrelid = c.conrelid
          and i.indisvalid
          and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey);

  if v_unserved > 0 then
    raise exception 'refusing: % prodplan foreign key(s) still have no index leading with their columns', v_unserved;
  end if;

  raise notice 'prodplan foreign-key indexes in place';
end
$$;
