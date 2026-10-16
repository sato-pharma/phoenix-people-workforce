-- phx_closing_brick asks for each product's period price ONCE, not once per rollup row. SPEED ONLY.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER, so Postgres never inlines it, and
-- the 2026-09-28 repoint (20260928190009) called it on every fact-rollup row: CNS September is 18,558
-- rows at about 144 µs a call, 1,760 ms of a function whose scans and joins take about 110 ms
-- (117 calls, 830 ms mean, 8.4 s max — measured on production 2026-10-16).
--
-- WHAT CHANGED, AND ONLY THIS. The old FROM, JOINs and WHERE move unchanged into `base` — the unused
-- product-master left join included, because it can change row multiplicity. `period_price` resolves
-- each DISTINCT product code once through the same resolver with `p_period`, which is exactly what each
-- row passed before (`f.period = p_period` is in the WHERE). The outer query sums the same columns.
-- A product with no price gets NULL -> 0, as before; production holds no NULL product code in either
-- rollup and `phx_factory_price(null, …)` is NULL, so the equality join loses nothing.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-16, against the live function: all four lines (CNS, Anti
-- Infective, Pedia, Head Office) for every month January–October 2026 — 23,252 rows each way, EXCEPT ALL
-- empty in BOTH directions comparing units::text and value::text; value totals 46,145,066.770775
-- (Jan–May) and 48,168,578.219565 (Jun–Oct) on both sides. The pg_temp copy that was compared is this
-- body verbatim. Speed on production: 1,760 ms -> 183 ms for CNS September.
--
-- Nothing about the money rule moves: the per-period price (Saginko 170.52 from 2026-10) is the same
-- resolver call, and `create or replace` keeps the function's grants.

create or replace function public.phx_closing_brick(p_line text, p_period text)
 returns table(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 language sql
 stable parallel safe security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with base as (
    select f.distributor_code, f.region_code, f.area_code, f.brick_id, f.product_code, f.total_qty, f.effective_units
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and not f.is_direct
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  period_price as (
    select d.product_code, public.phx_factory_price(d.product_code, p_period) as price
    from (select distinct base.product_code from base) d
  )
  select
    b.distributor_code,
    b.region_code,
    b.area_code,
    b.brick_id,
    sum(b.total_qty)                                     as units,
    sum(b.effective_units * coalesce(period_price.price, 0)) as value
  from base b
  left join period_price on period_price.product_code = b.product_code
  group by b.distributor_code, b.region_code, b.area_code, b.brick_id;
$function$;

revoke execute on function public.phx_closing_brick(text, text) from public, anon, authenticated;
grant execute on function public.phx_closing_brick(text, text) to service_role;
