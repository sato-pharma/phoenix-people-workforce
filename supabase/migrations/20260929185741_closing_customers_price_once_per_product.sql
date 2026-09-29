-- Resolve the factory price ONCE PER PRODUCT instead of once per sales row.
--
-- 🔴 A LIVE REGRESSION, NOT A TIDY-UP. `phx_closing_customers` went from 685 ms to 2,739 ms
-- between 2026-09-27 and 2026-09-29, and it is called ~480 times a day. Measured from
-- public.pg_stat_statements_snapshots, which holds 50 days of history:
--
--     27 Sep   685 ms      28 Sep   888 ms      29 Sep  2,739 ms
--
-- Every other sales RPC moved the same way on the same days, while a non-sales control
-- (crm_contact_master_refresh) stayed flat at 612 -> 630 -> 708 ms. So this is the sales path,
-- not the database.
--
-- WHAT CHANGED. public.source_of_sales_product_price_history holds exactly one row, created
-- 2026-09-28 15:59:48 UTC — the Saginko retail repricing. public.phx_factory_price(code, period)
-- reads it, and 31 functions call that per sales row.
--
-- WHY THE OBVIOUS FIXES DO NOT WORK. Both were measured on production against 2026-08
-- (32,304 fact rows) before this one was written:
--
--   the function as it stands              1,374 ms   66,231 shared buffers
--   the same logic written out inline      1,332 ms   (so making the function inlinable by
--                                                     dropping SECURITY DEFINER / SET would
--                                                     have bought nothing — the cost is the
--                                                     per-row correlated subqueries, not the
--                                                     function-call overhead)
--   + indexes on upper(btrim(product_code)) 1,320 ms  (created, measured, dropped again)
--   resolving the price once per product      140 ms      763 shared buffers
--
-- Ten times faster, eighty-seven times fewer buffers. The index scan over the facts only ever
-- touched 766 buffers; the other 65,465 were the per-row price lookups — chiefly a Seq Scan of
-- the 30-row product table repeated 32,304 times.
--
-- 🔴 NO PRICE VALUE CHANGES, AND NO PRICING RULE MOVES. The CTE below is the body of
-- phx_factory_price verbatim: the history override for the period if one exists, else the
-- master price. SA001 stays 111.15 through 2026-09 and 170.52 from 2026-10, which is the
-- owner's locked ruling. phx_factory_price itself is untouched and keeps its other 30 callers.
--
-- SAFE TO JOIN RATHER THAN CALL: upper(btrim(product_code)) is UNIQUE across all 30 rows of
-- source_of_sales_products, and (product_code, effective_period) is unique in the price
-- history, so the join cannot fan out. Checked immediately before writing this — a duplicate
-- folded code is exactly how a whole line got doubled once before.
--
-- The `left join public.source_of_sales_products p` this replaces was dead: `p` was never
-- referenced in the select list, the group by, or the where clause.
--
-- PROVEN EQUAL ON PRODUCTION before applying, CNS / 2026-08:
--     rows       10,554  =  10,554
--     value   4,277,306.58 = 4,277,306.58
--     units      68,553.00 =    68,553.00
--     EXCEPT in both directions: 0 rows
create or replace function public.phx_closing_customers(p_line text, p_period text)
 returns table(client_code text, client_name text, distributor_code text, region_code text,
               area_code text, brick_id text, units numeric, value numeric)
 language sql
 stable parallel safe security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with price as (
    -- One row per product. Identical to public.phx_factory_price(code, p_period), evaluated
    -- 30 times instead of once per fact row.
    select
      upper(btrim(pr.product_code)) as code,
      coalesce(
        (select h.factory_price
           from public.source_of_sales_product_price_history h
          where upper(btrim(h.product_code)) = upper(btrim(pr.product_code))
            and h.effective_period <= p_period
          order by h.effective_period desc
          limit 1),
        pr.factory_price
      ) as factory_price
    from public.source_of_sales_products pr
  ),
  agg as (
    select
      f.client_code,
      f.distributor_code,
      nullif(f.region_code, '') as fact_region,
      nullif(f.area_code, '')   as fact_area,
      nullif(f.brick_id, '')    as fact_brick,
      sum(f.total_qty) as units,
      sum(
        case
          when coalesce(f.is_direct, false) then coalesce(f.direct_value, 0)
          else f.effective_units * coalesce(pp.factory_price, 0)
        end
      ) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join price pp
      on pp.code = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and f.client_code is not null
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
    group by
      f.client_code, f.distributor_code,
      nullif(f.region_code, ''), nullif(f.area_code, ''), nullif(f.brick_id, '')
  )
  select
    a.client_code,
    coalesce(cm.customer_name, '') as client_name,
    a.distributor_code,
    coalesce(a.fact_region, cm.region_code) as region_code,
    coalesce(a.fact_area,   cm.area_code)   as area_code,
    coalesce(a.fact_brick,  cm.brick_id)    as brick_id,
    a.units,
    a.value
  from agg a
  left join public.source_of_sales_customer_map cm
    on cm.distributor_code = a.distributor_code
   and cm.customer_code    = a.client_code
   and cm.active;
$function$;

revoke execute on function public.phx_closing_customers(text, text) from public;
grant execute on function public.phx_closing_customers(text, text) to service_role;

comment on function public.phx_closing_customers(text, text) is
  'Closing detail by customer for one line and period. Resolves the factory price once per '
  'product (30 rows) rather than once per fact row — the per-row form measured 1,374 ms against '
  '140 ms on 2026-08. Price arithmetic is identical to public.phx_factory_price.';
