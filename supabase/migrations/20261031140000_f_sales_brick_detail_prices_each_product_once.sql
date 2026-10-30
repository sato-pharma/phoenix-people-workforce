-- f_sales_brick_detail_prices_each_product_once
--
-- WHAT THIS CHANGES: `au.f_sales_brick_detail` (behind `public.phx_sales_brick_detail`, the read
--   behind the Sales vs Target brick drill-down) resolves each product's factory price ONCE, in a
--   `period_price` CTE, instead of calling public.phx_factory_price on every fact row. It also
--   drops a `left join public.source_of_sales_products` that no column of the body ever read.
--
-- WHY: owner, 2026-10-31 — "make the Sales vs Target brick drill-down load faster". The bricks API
--   took ~6,029 ms on production for one area. Measured on production with EXPLAIN ANALYZE of
--   phx_sales_brick_detail('2026-09'): 5,132 ms, 1,068 rows — 21,510 fact rows each paying a
--   SECURITY DEFINER resolver call (two correlated subqueries apiece) to price 22 distinct
--   products. The same body with the price hoisted and the dead join removed: 499 ms, 1,068 rows.
--   This is the rule tests/sales-reads-price-each-pair-once.test.ts already holds 13 reads to.
--
--   The period is fixed for the whole call, so the lookup is keyed on product_code alone — never
--   the product_code || '|' || period pair the varying-period reads need.
--
--   The dropped join: source_of_sales_products holds no duplicate upper(btrim(product_code))
--   (checked on production 2026-10-31: zero groups with count > 1), so as a LEFT join it could
--   neither add nor remove a row, and nothing selected from it.
--
-- EQUIVALENCE: the new body's output was compared with the live function's for 2026-07, 2026-08,
--   2026-09 and 2026-10 with EXCEPT ALL in both directions before this was applied — zero rows
--   either way. Everything else is production's own definition unchanged: signature, STABLE
--   PARALLEL SAFE SECURITY DEFINER, search_path, and the service_role-only grant.
--
-- ROLLBACK: re-apply 20260928190003_f_sales_brick_detail_reads_the_period_price.sql.

begin;

create or replace function au.f_sales_brick_detail(p_period text)
 RETURNS TABLE(period text, line_code text, region_code text, area_code text, area_state text, rep_seat_id text, rep_hr_id text, dm_seat_id text, dm_hr_id text, brick_id text, brick_name text, block_code text, sales_units numeric, sales_value numeric, direct_value numeric, indirect_value numeric)
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'au', 'public'
AS $function$
declare
  v_period_end date;
begin
  if p_period !~ '^\d{4}-\d{2}$' then
    return;
  end if;
  if to_date(p_period || '-01', 'YYYY-MM-DD') < date '2026-07-01' then
    return;
  end if;

  v_period_end := (date_trunc('month', to_date(p_period || '-01', 'YYYY-MM-DD'))
                   + interval '1 month - 1 day')::date;

  return query
  with fact as materialized (
    select
      f.official_line,
      nullif(btrim(f.area_code), '')            as sos_area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '') as brick_id,
      upper(btrim(coalesce(f.product_code, ''))) as product_code,
      f.is_direct,
      f.total_qty,
      f.effective_units,
      f.direct_value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period = p_period
      and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  ),
  period_price as (
    select d.product_code,
           public.phx_factory_price(d.product_code, p_period) as period_price
    from (
      select distinct fa.product_code
      from fact fa
    ) d
  ),
  priced as materialized (
    select
      fa.*,
      lm.line_code,
      cw.canonical_area_code,
      coalesce(pp.period_price, 0) as factory_price
    from fact fa
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))
    left join au.sos_area_crosswalk cw
      on cw.sos_area_code = fa.sos_area_code
    left join period_price pp
      on pp.product_code = fa.product_code
  ),
  lam_asof as materialized (
    select
      l.line_code, l.area_code, l.operational_region_code, l.area_state,
      l.dm_seat_id, l.rep_seat_id,
      au.f_seat_occupant_asof(l.rep_seat_id, v_period_end) as rep_occupant_hr_id,
      au.f_seat_occupant_asof(l.dm_seat_id, v_period_end)  as dm_occupant_hr_id
    from au.f_line_area_map_asof(v_period_end) l
  )
  select
    p_period,
    lam.line_code,
    lam.operational_region_code,
    lam.area_code,
    lam.area_state,
    lam.rep_seat_id,
    lam.rep_occupant_hr_id,
    lam.dm_seat_id,
    lam.dm_occupant_hr_id,
    pr.brick_id,
    b.brick_name,
    b.block_code,
    sum(pr.total_qty),
    sum(case when pr.is_direct then pr.direct_value else pr.effective_units * pr.factory_price end),
    sum(case when pr.is_direct then pr.direct_value else 0 end),
    sum(case when pr.is_direct then 0 else pr.effective_units * pr.factory_price end)
  from priced pr
  join lam_asof lam
    on lam.line_code = pr.line_code and lam.area_code = pr.canonical_area_code
  left join public.source_of_sales_bricks b
    on b.brick_id = pr.brick_id
  where pr.line_code is not null and pr.canonical_area_code is not null
  group by
    lam.line_code, lam.operational_region_code, lam.area_code, lam.area_state,
    lam.rep_seat_id, lam.rep_occupant_hr_id, lam.dm_seat_id, lam.dm_occupant_hr_id,
    pr.brick_id, b.brick_name, b.block_code;
end;
$function$;

revoke execute on function au.f_sales_brick_detail(text) from public, anon, authenticated;
grant execute on function au.f_sales_brick_detail(text) to service_role;

commit;
