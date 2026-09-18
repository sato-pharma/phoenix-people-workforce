-- "Corrections that span two months" missed a reversal whenever the same month's OTHER sales hid it.
--
-- SoS audit finding, CONFIRMED high:
-- `supabase/migrations/20260805001000_phx_closing_corrections.sql:87` — "Reversals masked by
-- legitimate sales are never detected".
--
-- A reversal pair is one distributor posting units into an area and product in one month and taking
-- them back the next. The detector saw the take-back only through the NEXT month's whole cell for
-- that distributor (`neg.cell_units < 0`), so any ordinary sales to other pharmacies in that month
-- cancelled it. A take-back smaller than the rest of the month's sales was invisible, and one that
-- was only partly offset was reported at the offset size.
--
-- ── What the audit's figure actually was ──────────────────────────────────────────────────
-- The audit counted 23 pairs worth 206,518.65 EGP by summing every NEGATIVE import row. Most of
-- those are not cross-month reversals. Measured on production 2026-09-18, its own lead example,
-- Overseas (PS) / Menoufia 1 (D12) / Saginko, 2026-05: one pharmacy's +200 line was posted twice and taken
-- back (-200) inside May, and another's +50 likewise. May's own total is right; April's posting was
-- never touched. Others are returns by pharmacies that did not buy in that cell the month before,
-- which is what the late_return section is for. Summing negative rows counts both as reversals.
--
-- ── The fix ────────────────────────────────────────────────────────────────────────────────
-- The take-back is now measured PHARMACY BY PHARMACY: each client that nets negative in the next
-- month (its own same-month buys and returns netted first, so a same-month correction never counts),
-- matched to that SAME client's purchase in the same distributor, area and product the month before,
-- capped at what it bought then. The thresholds are unchanged (50 units posted, 50%-150% taken
-- back). The original whole-cell test stays as an OR, so nothing it found is lost.
--
-- When the clients' own take-back qualifies, it is what the row reports as taken back; the cell's
-- net understated it by exactly the other sales. A new last column, `other_net_units`, carries the
-- next month's whole-cell net on every reversal_pair row (NULL on the other two kinds), so the page
-- can say how much of the take-back the month's total actually shows.
--
-- Measured on production 2026-09-18, every month 2026-01 to 2026-09 (141 rows before, 145 after).
-- The net_negative and late_return sections are identical row for row. The reversal section:
--
--   NEWLY FOUND (each is listed on both of its months' pages):
--     2026-02 -> 2026-03  Overseas  Pedia  Qalubeya (D11)  Lacto Advanced 2
--                         +145 u, then 122 u / -32,940.00 EGP
--                         taken back; March's cell still nets -35 u, below the old 50% bar
--     2026-04 -> 2026-05  Overseas  Pedia  Alex West (AB3)  Lacto Advanced 1
--                         +109 u, then 61 u / -16,470.00 EGP
--                         taken back; May's cell still nets +13 u, so nothing showed at all
--   NOW AT THEIR REAL SIZE (the cell's net understated the take-back):
--     2026-03 -> 2026-04  Overseas       Gharbia 2 (Mahalla) Saginko       -194 u -> -250 u   (-21,563.10 -> -27,787.50 EGP)
--     2026-03 -> 2026-04  Ibn sina       Sohag1              Dolabactin     -75 u -> -100 u   ( -4,050.00 ->  -5,400.00 EGP)
--     2026-06 -> 2026-07  Ibn Sina-Sato  Dakahlia 1          Saginko       -179 u -> -200 u   (-19,895.85 -> -22,230.00 EGP)
--     2026-06 -> 2026-07  Ibn Sina-Sato  Dakahlia 1          Royafloxacin  -170 u -> -200 u   (-10,319.00 -> -12,140.00 EGP)
--     2026-06 -> 2026-07  Overseas       Behira 1            Royafloxacin   -34 u ->  -52 u   ( -2,063.80 ->  -3,156.40 EGP)
--   UNCHANGED: 2026-04 -> 2026-05 sofico / Cairo East 2 / Conviban (-80 u; the take-back is the whole cell's net).
--
-- This is a diagnostic page. Nothing here changes a closing figure or any published month.
--
-- Adding a column changes the RETURNS TABLE, which CREATE OR REPLACE cannot do, so this drops and
-- recreates the function in one transaction and restates its grants. The new column is LAST, so the
-- code deployed before this migration keeps working: it ignores the column and prints the take-back
-- figure without the sentence about the month's net.

DROP FUNCTION IF EXISTS public.phx_closing_corrections(text);

CREATE FUNCTION public.phx_closing_corrections(p_period text)
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
-- pattern is one distributor posting in one month and retracting in the next.
cells as (
  select f.period as cell_period, f.official_line as cell_line, b.distributor_code as cell_dist,
         f.area_code as cell_area, f.product_code as cell_product,
         max(f.product_name) as cell_product_name,
         sum(f.total_qty) as cell_units,
         sum(case when f.is_direct then f.direct_value
                  else f.effective_units * coalesce(p.factory_price, 0) end) as cell_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  cross join periods pr
  where f.period in (pr.prev, pr.cur, pr.next)
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.period, f.official_line, b.distributor_code, f.area_code, f.product_code
),
-- One client's own net in a per-distributor cell, per month. A client's buys and returns inside the
-- SAME month net here first: that is a same-month correction (a line posted twice, then taken back),
-- which leaves the month's own total right and is no cross-month reversal. Client codes are unique
-- per distributor only, which the cell's distributor key already respects. A blank client code is no
-- identity, so it never matches (the same rule late_return applies).
clients as (
  select f.period as cl_period, f.official_line as cl_line, b.distributor_code as cl_dist,
         f.area_code as cl_area, f.product_code as cl_product, btrim(f.client_code) as cl_client,
         sum(f.total_qty) as cl_units,
         sum(case when f.is_direct then f.direct_value
                  else f.effective_units * coalesce(p.factory_price, 0) end) as cl_value
  from public.source_of_sales_fact_rollup f
  join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  cross join periods pr
  where f.period in (pr.prev, pr.cur, pr.next)
    and nullif(btrim(f.client_code), '') is not null
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.period, f.official_line, b.distributor_code, f.area_code, f.product_code, btrim(f.client_code)
),
-- What a cell's month TOOK BACK from the month before: each client that nets negative this month,
-- matched to its OWN purchase in the same cell the month before, capped at what it bought then.
-- Ordinary sales to other clients in the same month cannot hide it, which is the point: a cell's
-- net only shows a reversal when the return is bigger than everything else sold there that month.
-- The value is the return's own value, prorated when the cap cuts it.
taken_back as (
  select ret.cl_period as tb_period, ret.cl_line as tb_line, ret.cl_dist as tb_dist,
         ret.cl_area as tb_area, ret.cl_product as tb_product,
         sum(least(-ret.cl_units, buy.cl_units)) as tb_units,
         sum(ret.cl_value * least(-ret.cl_units, buy.cl_units) / (-ret.cl_units)) as tb_value
  from clients ret
  join clients buy
    on buy.cl_line = ret.cl_line
   and buy.cl_dist = ret.cl_dist
   and buy.cl_area = ret.cl_area
   and buy.cl_product = ret.cl_product
   and buy.cl_client = ret.cl_client
   and buy.cl_period = to_char((ret.cl_period || '-01')::date - interval '1 month', 'YYYY-MM')
  where ret.cl_units < 0
    and buy.cl_units > 0
  group by ret.cl_period, ret.cl_line, ret.cl_dist, ret.cl_area, ret.cl_product
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
                  else f.effective_units * coalesce(p.factory_price, 0) end) as cell_value
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
-- (the original test, kept so nothing it found is lost), OR the same clients took back that much
-- (taken_back), however much else the cell sold that month. When the clients' own returns qualify,
-- they are what the row reports as taken back, because the cell's net understates them by exactly
-- the other sales. other_net_units is always the next month's whole-cell net for this distributor,
-- so the page can say how much of the take-back that month's own figures show.
select 'reversal_pair'::text, pos.cell_period, neg.cell_period, pos.cell_line, pos.cell_dist,
       pos.cell_area, pos.cell_product, pos.cell_product_name, null::text,
       pos.cell_units, round(pos.cell_value::numeric, 2),
       case when h.clients_hit then -tb.tb_units else neg.cell_units end,
       round((case when h.clients_hit then tb.tb_value else neg.cell_value end)::numeric, 2),
       null::text,
       neg.cell_units
from cells pos
join cells neg
  on neg.cell_line = pos.cell_line
 and neg.cell_dist = pos.cell_dist
 and neg.cell_area = pos.cell_area
 and neg.cell_product = pos.cell_product
 and neg.cell_period = to_char((pos.cell_period || '-01')::date + interval '1 month', 'YYYY-MM')
left join taken_back tb
  on tb.tb_line = neg.cell_line
 and tb.tb_dist = neg.cell_dist
 and tb.tb_area = neg.cell_area
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

-- DROP + CREATE drops the ACL with the function, so restate it: SECURITY DEFINER over the whole
-- fact rollup, reachable by the service role only.
revoke execute on function public.phx_closing_corrections(text) from public, anon, authenticated;
grant  execute on function public.phx_closing_corrections(text) to service_role;
