-- phx_closing_corrections_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_closing_corrections` now takes its factory price from
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

create or replace function public.phx_closing_corrections(p_period text)
 RETURNS TABLE(kind text, period text, other_period text, line text, distributor_code text, area_code text, product_code text, product_name text, client_name text, units numeric, value numeric, other_units numeric, other_value numeric, region_code text, other_net_units numeric)
 LANGUAGE sql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
with periods as (
  select p_period as cur,
         to_char((p_period || '-01')::date - interval '1 month', 'YYYY-MM') as prev,
         to_char((p_period || '-01')::date + interval '1 month', 'YYYY-MM') as next
),
-- Per-distributor cells. Used by reversal_pair ONLY, where the distributor is the point: the
-- pattern is one distributor posting in one month and retracting in the next. A Direct row with no
-- area is keyed by its region, as the closing books it (see closing_cells).
cells as (
  select f.period as cell_period, f.official_line as cell_line, b.distributor_code as cell_dist,
         f.area_code as cell_area, f.product_code as cell_product,
         case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
              then upper(btrim(coalesce(f.region_code, ''))) end as cell_region,
         max(f.product_name) as cell_product_name,
         sum(f.total_qty) as cell_units,
         sum(case when f.is_direct then f.direct_value
                  else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) end) as cell_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  cross join periods pr
  where f.period in (pr.prev, pr.cur, pr.next)
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.period, f.official_line, b.distributor_code, f.area_code,
           case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
                then upper(btrim(coalesce(f.region_code, ''))) end,
           f.product_code
),
-- One pharmacy's own net in a per-distributor cell, per month. Its buys and returns inside the SAME
-- month net here first: a line posted twice and taken back leaves the month's own total right and
-- undoes nothing in the month before. Client codes are unique per distributor only, which the
-- distributor key already respects. A blank client code is no identity, so it never matches (the
-- same rule late_return applies).
clients as (
  select f.period as cl_period, f.official_line as cl_line, b.distributor_code as cl_dist,
         f.area_code as cl_area, f.product_code as cl_product,
         case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
              then upper(btrim(coalesce(f.region_code, ''))) end as cl_region,
         btrim(f.client_code) as cl_client,
         sum(f.total_qty) as cl_units,
         sum(case when f.is_direct then f.direct_value
                  else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) end) as cl_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  cross join periods pr
  where f.period in (pr.prev, pr.cur, pr.next)
    and nullif(btrim(f.client_code), '') is not null
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.period, f.official_line, b.distributor_code, f.area_code,
           case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
                then upper(btrim(coalesce(f.region_code, ''))) end,
           f.product_code, btrim(f.client_code)
),
-- What a cell's month TOOK BACK from the month before: each pharmacy that nets negative this month,
-- matched to its OWN purchase in the same cell the month before, capped at what it bought then.
-- Ordinary sales to other pharmacies that month cannot hide it. The value is the return's own
-- value, prorated when the cap cuts it.
taken_back as (
  select ret.cl_period as tb_period, ret.cl_line as tb_line, ret.cl_dist as tb_dist,
         ret.cl_area as tb_area, ret.cl_region as tb_region, ret.cl_product as tb_product,
         sum(least(-ret.cl_units, buy.cl_units)) as tb_units,
         sum(ret.cl_value * least(-ret.cl_units, buy.cl_units) / (-ret.cl_units)) as tb_value
  from clients ret
  join clients buy
    on buy.cl_line = ret.cl_line
   and buy.cl_dist = ret.cl_dist
   and buy.cl_area = ret.cl_area
   and buy.cl_region is not distinct from ret.cl_region
   and buy.cl_product = ret.cl_product
   and buy.cl_client = ret.cl_client
   and buy.cl_period = to_char((ret.cl_period || '-01')::date - interval '1 month', 'YYYY-MM')
  where ret.cl_units < 0
    and buy.cl_units > 0
  group by ret.cl_period, ret.cl_line, ret.cl_dist, ret.cl_area, ret.cl_region, ret.cl_product
),
-- THE CLOSING'S OWN CELL: area x product, every distributor together, exactly as
-- phx_monthly_closing_matrix groups it. This is what "the closing shows a negative there" means.
--
-- A direct row with NO AREA is the one exception, because the closing does not put it in an area
-- cell at all: phx_monthly_closing_direct returns it by REGION, and injectDirectIntoMatrix gives each
-- region its own "Direct" row. So such a row is keyed by its region here too (cell_region). Every
-- other row, a direct row that carries an area included, keeps cell_region NULL and groups by area
-- exactly as before, because the closing folds that direct money into the area's own row.
closing_cells as (
  select f.period as cell_period, f.official_line as cell_line,
         f.area_code as cell_area, f.product_code as cell_product,
         case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
              then upper(btrim(coalesce(f.region_code, ''))) end as cell_region,
         max(f.product_name) as cell_product_name,
         sum(f.total_qty) as cell_units,
         sum(case when f.is_direct then f.direct_value
                  else f.effective_units * coalesce(public.phx_factory_price(f.product_code, f.period), 0) end) as cell_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  cross join periods pr
  where f.period = pr.cur
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.period, f.official_line, f.area_code,
           case when f.is_direct and btrim(coalesce(f.area_code, '')) = ''
                then upper(btrim(coalesce(f.region_code, ''))) end,
           f.product_code
)
-- A pair is found two ways, with the same thresholds: the next month's whole cell nets below zero
-- (the original test, kept so nothing it found is lost), OR the same pharmacies took back that much
-- (taken_back), however much else the cell sold that month. When the pharmacies' take-back
-- qualifies, it is what the row reports, because the cell's net understates it by exactly the other
-- sales. other_net_units is always the next month's whole-cell net for this distributor, so the
-- page can say how much of the take-back that month's own figures show.
select 'reversal_pair'::text, pos.cell_period, neg.cell_period, pos.cell_line, pos.cell_dist,
       pos.cell_area, pos.cell_product, pos.cell_product_name, null::text,
       pos.cell_units, round(pos.cell_value::numeric, 2),
       case when h.clients_hit then -tb.tb_units else neg.cell_units end,
       round((case when h.clients_hit then tb.tb_value else neg.cell_value end)::numeric, 2),
       pos.cell_region,
       neg.cell_units
from cells pos
join cells neg
  on neg.cell_line = pos.cell_line
 and neg.cell_dist = pos.cell_dist
 and neg.cell_area = pos.cell_area
 and neg.cell_region is not distinct from pos.cell_region
 and neg.cell_product = pos.cell_product
 and neg.cell_period = to_char((pos.cell_period || '-01')::date + interval '1 month', 'YYYY-MM')
left join taken_back tb
  on tb.tb_line = neg.cell_line
 and tb.tb_dist = neg.cell_dist
 and tb.tb_area = neg.cell_area
 and tb.tb_region is not distinct from neg.cell_region
 and tb.tb_product = neg.cell_product
 and tb.tb_period = neg.cell_period
cross join lateral (
  select coalesce(tb.tb_units, 0) between 0.5 * pos.cell_units and 1.5 * pos.cell_units as clients_hit
) h
cross join periods pr
where pos.cell_units >= 50
  and ((neg.cell_units < 0
        and abs(neg.cell_units) between 0.5 * pos.cell_units and 1.5 * pos.cell_units)
       or h.clients_hit)
  and (pos.cell_period = pr.cur or neg.cell_period = pr.cur)

union all
-- distributor_code is NULL here on purpose: this row is the whole cell, not one distributor's
-- share of it, and naming any single distributor would be the bug this replaced.
select 'net_negative'::text, c.cell_period, null, c.cell_line, null::text, c.cell_area,
       c.cell_product, c.cell_product_name, null,
       c.cell_units, round(c.cell_value::numeric, 2), null, null, c.cell_region, null::numeric
from closing_cells c
where c.cell_units < -20 or c.cell_value < -1000

union all
select 'late_return'::text, neg.neg_period, origin.origin_period, neg.neg_line, neg.neg_dist,
       neg.neg_area, neg.neg_product, neg.neg_product_name, neg.neg_client_name,
       neg.neg_units, round(neg.neg_value::numeric, 2), origin.origin_units, null, null::text, null::numeric
from (
  select b.period as neg_period, r.official_line as neg_line, b.distributor_code as neg_dist,
         r.area_code as neg_area, r.product_code as neg_product,
         max(r.product_name) as neg_product_name,
         btrim(r.client_code) as neg_client_code,
         max(r.client_name) as neg_client_name,
         sum(r.qty) as neg_units, sum(r.value) as neg_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
  cross join periods pr
  where b.period = pr.cur
    and nullif(btrim(r.client_code), '') is not null
    and upper(btrim(coalesce(r.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by b.period, r.official_line, b.distributor_code, r.area_code, r.product_code, btrim(r.client_code)
  having sum(r.qty) <= -10 or sum(r.value) <= -1000
) neg
left join lateral (
  select b2.period as origin_period, sum(r2.qty) as origin_units
  from public.source_of_sales_import_rows r2
  join public.source_of_sales_import_batches b2 on b2.id = r2.batch_id and b2.status = 'validated'
  where b2.period < neg.neg_period
    and b2.distributor_code = neg.neg_dist
    and btrim(r2.client_code) = neg.neg_client_code
    and upper(btrim(r2.product_code)) = upper(btrim(neg.neg_product))
    and r2.qty > 0
  group by b2.period
  order by b2.period desc
  limit 1
) origin on true;
$function$;

revoke execute on function public.phx_closing_corrections(text) from public, anon, authenticated;
grant execute on function public.phx_closing_corrections(text) to service_role;

commit;
