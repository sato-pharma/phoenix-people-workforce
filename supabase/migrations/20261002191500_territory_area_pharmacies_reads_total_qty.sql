-- Territory Management must report the SAME units and value the Monthly Closing reports. It now
-- reports 20% less for El Qema's August customers, and this puts it back on the closing's basis.
--
-- OWNER INSTRUCTION, 2026-10-02: "fix Territory Management to match the August closing".
--
-- WHAT WENT WRONG. 20260922220000 moved this function from `total_qty` to `effective_units` for the
-- units column, on the stated belief that effective_units is "the credited-to-area units" produced
-- by El Qema's warehouse bands and the city rule. It is not. Measured on production 2026-10-02:
--
--   · BOTH columns are written by the SAME expression. phx_refresh_sos_customer_directory_rollup
--     and phx_backfill_sos_customer_directory_rollup each compute
--         sum(coalesce(r.qty, 0)) as effective_units,
--         sum(coalesce(r.qty, 0)) as total_qty,
--     so for every row either writer has ever produced the two are identical by construction. No
--     split is recorded in this table at all — the El Qema bands and the city rule are applied in
--     the TypeScript closing engine (store-sales-city-split.ts) at read time, and the area-level
--     result is stored in au.monthly_store_split_net, never here.
--
--   · 41 rows in the whole table disagree, every one of them El Qema (QM) 2026-08, 30 customers,
--     0 direct, gap 1,772.08 packs. On those rows effective_units == the distributor's invoiced
--     value ÷ factory price, i.e. El Qema's own «خصم» trade discount (20% on client 3743, 22% on
--     2678) carried into the UNIT count. They are stale from an earlier importer; nothing in the
--     live code path can reproduce them.
--
--   · So the closing and this page disagreed on the same customer:
--         phx_closing_customers('Pedia','2026-08')  client 3743  4,532 packs  1,223,640.00
--         phx_territory_area_pharmacies(D11,…)      client 3743  3,625.60     978,912.00
--     1,772.08 packs / 478,461.60 EGP across El Qema's August, of which 1,371.04 packs /
--     370,180.80 EGP is one customer group (الفرسان).
--
-- WHY THE FUNCTION AND NOT THE 41 ROWS. Setting effective_units = total_qty on those rows is what
-- the live writer would produce, and it was attempted first — it is REFUSED by
-- phx_reject_write_to_locked_closing: "Monthly closing Pedia 2026-08 is LOCKED". That lock is the
-- owner's (monthly_closing_locks, locked_by b-10, 2026-09-23 02:18 Cairo, snapshot 22,762 units)
-- and AGENTS.md §4 says a published and announced month is never corrected and only he unlocks one.
-- So no row of a locked month is touched here. The pre-image of those 41 rows was taken before the
-- attempt and is kept: public.sos_backup_20261002_qm_directory_effective_units (RLS on,
-- service_role select only).
--
-- THE FIX is the two lines that read the unit column: `total_qty` for the units, and `total_qty` in
-- the non-direct value expression, so units and value still share ONE basis — now the closing's.
-- Everything else is byte-identical to the live definition read from production today: the direct
-- order rule (valued as it comes from the source, never × factory — owner rule, locked), the dated
-- price lookup phx_factory_price(code, period) that 20260928190020's family introduced, the
-- LA003/LA004/SS001 exclusion, the validated-batch join, the area predicate that the expression
-- index sos_customer_directory_rollup_area_period_idx matches, the window totals and the grants.
--
-- EFFECT. For every row except those 41 the output is unchanged, because the two columns are equal.
-- For those 41 the page now reads 4,532 / 1,223,640.00 where it read 3,625.60 / 978,912.00, which
-- is what the published closing has always said. The closing itself reads the fact rollup and is
-- not touched by this at all.

CREATE OR REPLACE FUNCTION public.phx_territory_area_pharmacies(p_area_codes text[], p_periods text[], p_lines text[])
 RETURNS TABLE(brick_id text, client_code text, client_name text, official_line text, product_code text, product_name text, period text, units numeric, value numeric, scope_total_units numeric, scope_total_value numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
#variable_conflict use_column
begin
  return query
  with filtered as (
    select
      coalesce(nullif(btrim(r.brick_id), ''), '(unmapped)') as brick_id,
      r.client_code,
      r.client_name,
      coalesce(nullif(btrim(r.official_line), ''), 'Unknown') as official_line,
      coalesce(nullif(btrim(r.product_code), ''), '') as product_code,
      coalesce(nullif(btrim(p.product_name), ''), 'Unknown product') as product_name,
      r.period,
      r.latest_row_created_at,
      -- The packs, on the Monthly Closing's own basis. effective_units is written by the identical
      -- expression as total_qty, so this changes nothing anywhere except the 41 stale El Qema
      -- 2026-08 rows, where effective_units carries that distributor's trade discount.
      r.total_qty as row_units,
      -- A direct order is valued as it is from the source, never × factory (owner rule, locked).
      case when r.is_direct then coalesce(r.direct_value, 0)
           else r.total_qty * coalesce(public.phx_factory_price(r.product_code, r.period), 0) end as row_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where upper(btrim(coalesce(r.area_code, ''))) in (
        select upper(btrim(x)) from unnest(p_area_codes) as x
      )
      and r.period = any (p_periods)
      and r.client_code is not null
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(r.official_line, ''))) in (
          select lower(btrim(x)) from unnest(p_lines) as x
        )
      )
      and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  latest_name as (
    select distinct on (client_code) client_code, client_name
    from filtered
    where client_name is not null
    order by client_code, latest_row_created_at desc
  ),
  agg as (
    select brick_id, client_code, official_line, product_code, product_name, period,
           sum(row_units) as units, sum(row_value) as value
    from filtered
    group by brick_id, client_code, official_line, product_code, product_name, period
  )
  select
    a.brick_id,
    a.client_code,
    coalesce(ln.client_name, 'Unknown'),
    a.official_line,
    a.product_code,
    a.product_name,
    a.period,
    a.units,
    a.value,
    sum(a.units) over (),
    sum(a.value) over ()
  from agg a
  left join latest_name ln using (client_code);
end;
$function$;

-- Grants stay exactly as they were live (service_role only); stated here so the file is complete.
revoke execute on function public.phx_territory_area_pharmacies(text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_territory_area_pharmacies(text[], text[], text[]) to service_role;
