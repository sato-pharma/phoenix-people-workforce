-- phx_closing_distributor_product asks for each product's period price ONCE, not once per rollup row.
-- SPEED ONLY.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER, so Postgres never inlines it, and
-- the 2026-09-28 repoint (20260928190013) called it on every distributor-product rollup row: about
-- 2,008 calls at ~70 µs for one line-month (1,919 calls, 107 ms mean — production, 2026-10-16). This
-- is the read under the Monthly Closing matrix, so it runs on every closing screen and export.
--
-- WHAT CHANGED, AND ONLY THIS. The old FROM, JOIN and WHERE move unchanged into `base` — the product-
-- master left join included, because it can change row multiplicity. `period_price` resolves each
-- DISTINCT product code once through the same resolver with the same `p_period` every row passed
-- before; the outer query keeps the same grouping, `max(product_name)` and both sums. A product with no
-- price gets NULL -> 0, as before; production holds no NULL product code and
-- `phx_factory_price(null, …)` is NULL, so the equality join loses nothing.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-16, against the live function: all four lines (CNS, Anti
-- Infective, Pedia, Head Office) for every month January–October 2026 — 20,703 rows each way, EXCEPT ALL
-- empty in BOTH directions comparing every column with units::text and value::text; value total
-- 94,313,644.99034 on both sides. The pg_temp copy that was compared is this body verbatim. Speed on
-- production: 173 ms -> 25.6 ms for one line-month.
--
-- The rollup still stores UNITS only and the money is still priced live at read time, so a price edit
-- reprices history exactly as before. `create or replace` keeps the function's grants.

create or replace function public.phx_closing_distributor_product(p_line text, p_period text)
 returns table(distributor_code text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 language sql
 stable parallel safe security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with base as (
    select r.distributor_code, r.region_code, r.area_code, r.product_code, r.product_name, r.units_qty, r.eff_units
    from public.source_of_sales_distributor_product_rollup r
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where r.period = p_period
      and r.line_key = lower(btrim(p_line))
  ),
  period_price as (
    select d.product_code, public.phx_factory_price(d.product_code, p_period) as price
    from (select distinct base.product_code from base) d
  )
  select
    b.distributor_code,
    b.region_code,
    b.area_code,
    b.product_code,
    max(b.product_name)                                  as product_name,
    sum(b.units_qty)                                     as units,
    sum(b.eff_units * coalesce(period_price.price, 0))   as value
  from base b
  left join period_price on period_price.product_code = b.product_code
  group by b.distributor_code, b.region_code, b.area_code, b.product_code;
$function$;

revoke execute on function public.phx_closing_distributor_product(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_distributor_product(text, text) to service_role;
