-- f_sales_brick_detail_reads_the_period_price
--
-- WHAT THIS CHANGES: `au.f_sales_brick_detail` now takes its factory price from
--   public.phx_factory_price(product_code, period) instead of reading
--   source_of_sales_products.factory_price straight off the product master. Byte-identical to the
--   body on production apart from that one expression, and only where it VALUES a row.
--
-- WHY: owner instruction 2026-09-28, repricing Saginko — direct orders from that day, "the sales
--   and target of the retail to be adjusted from 1 October". The resolver falls back to the master
--   price when no override covers the period, so a product without an override row is valued
--   exactly as before and this file moves no number on its own. Rationale, the override table and
--   the resolver: 20260928184100_period_scoped_factory_prices.sql.
--
--   One function per file on purpose: several guards in tests/ resolve "the newest migration that
--   defines X" and then read that whole file, so a bundle of 31 functions makes one function's SQL
--   answer for another's.
--
-- ROLLBACK: re-apply the previous definition. The cheaper undo is to drop the override row —
--   delete from public.source_of_sales_product_price_history where product_code = 'SA001';
--   which restores the old valuation everywhere without touching a function.

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
  with fact as (
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
  priced as (
    select
      fa.*,
      lm.line_code,
      cw.canonical_area_code,
      coalesce(public.phx_factory_price(fa.product_code, p_period), 0) as factory_price
    from fact fa
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(fa.official_line))
    left join au.sos_area_crosswalk cw
      on cw.sos_area_code = fa.sos_area_code
    left join public.source_of_sales_products pp
      on upper(btrim(pp.product_code)) = fa.product_code
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

commit;
