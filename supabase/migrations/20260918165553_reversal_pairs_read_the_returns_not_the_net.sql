-- "Corrections that span two months" only saw a return big enough to drag the WHOLE next-month cell
-- below zero, so a return masked by that month's ordinary sales was never reported.
--
-- SoS audit finding, CONFIRMED high:
-- `supabase/migrations/20260805001000_phx_closing_corrections.sql:87` — "Reversals masked by
-- legitimate sales are never detected - 23 real pairs worth 206,518.65 EGP are invisible".
--
-- WHAT THIS CHANGES:
-- A reversal pair needed `neg.cell_units < 0`: the next month's NET for that distributor, area and
-- product. A distributor that returned most of a posting while also selling normally in that cell
-- netted positive, so the pair was invisible, and on a quiet month the page printed its all-clear
-- ("Nothing on this page distorts the month's closing") over it.
--
-- Now the next month's RETURNS are read on their own: the negative rows of the same cell, from
-- phx_sos_rows_attributed, the attributed feed the fact rollup itself is built from, so a return
-- lands in the same area as the sale it reverses (city splits and all). The rollup cannot be used
-- for this: it keeps one row per client, which nets a client's same-month return into its own
-- purchases. Measured, it finds 9 of the 28 masked pairs below and neither of the audit's two named
-- examples (Pharma Overseas Saginko in D15 and in D12). A pair is reported when EITHER
--   * the next month's net is the reversal, exactly as before (so no pair reported today is lost), or
--   * the next month's returns are, under the SAME thresholds: 50 units posted or more, returns
--     between 50% and 150% of them.
-- The pair now shows what was taken back (the returns, valued at factory price, or the Direct value
-- for a Direct row, as every other figure on this page) instead of the next month's net, which is
-- what the page's sentence "then took N units back" always said. On 5 of the 6 pairs reported
-- today the figure grows, e.g. Pharma Overseas, D15, Saginko, April: -194 net becomes -250 returned.
--
-- A Direct row with NO AREA is keyed by its REGION here too, as 20260918164000 did for the
-- "returns bigger than the month's sales" section and for the same reason: the closing books it by
-- region, one "Direct orders (company)" row each. Without it every region's no-area Direct money
-- nets into one blank-area cell, which hides Delta (1)'s own reversals of March in April: Pedia
-- Lacto Advanced 1, +1,224 posted and -856 back (-164,780.00), and Lacto Advanced 2, +648 posted
-- and -432 back (-83,160.00). The pair carries its region out in `region_code`, NULL otherwise.
--
-- WHY (production, 2026-09-18 17:00 Cairo, read-only, 2026-01 to 2026-09, the function's own rules):
--   today        6 pairs
--   after this  36 pairs: the 6, the 2 Direct pairs above, and 28 masked by ordinary sales, whose
--               returns come to -278,193.31 EGP at factory price (the audit counted 23 pairs /
--               -206,518.65 at the distributors' own invoice value, to July)
--   the largest masked ones
--               Pedia Lacto Advanced 2, Pharma Overseas, D11, Feb +145 -> March -131 back (-35,370.00)
--               Anti Infective Saginko, Pharma Overseas, D15, Feb +267 -> March -300 back, net +277
--               Anti Infective Saginko, Pharma Overseas, D12, April +480 -> May -251 back, net +434
--
-- Untouched: the thresholds, the net_negative and late_return kinds, the closing_cells source, the
-- exclusions and the grants. The RETURNS TABLE is unchanged, so this is CREATE OR REPLACE and the
-- ACL survives (restated below anyway).
--
-- The function is no longer PARALLEL SAFE: it now calls phx_sos_rows_attributed, which is marked
-- parallel unsafe, and a function must not claim more than what it calls.
--
-- ROLLBACK: re-run the CREATE FUNCTION in 20260918164000_closing_corrections_direct_rows_by_region.sql
-- as CREATE OR REPLACE. Nothing is stored; this is a read-only function.

begin;

CREATE OR REPLACE FUNCTION public.phx_closing_corrections(p_period text)
 RETURNS TABLE(kind text, period text, other_period text, line text, distributor_code text, area_code text, product_code text, product_name text, client_name text, units numeric, value numeric, other_units numeric, other_value numeric, region_code text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
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
                  else f.effective_units * coalesce(p.factory_price, 0) end) as cell_value
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
-- What each of those cells TOOK BACK in the month: its negative rows only, so ordinary sales in the
-- same cell cannot hide a return. Read from phx_sos_rows_attributed, the feed the fact rollup is
-- built from, so the keys match `cells` exactly. Only the two months a reversal can land in (the
-- pair's second month is always this period or the next). MATERIALIZED so it runs once: inlined,
-- the planner guesses 1,000 rows for the function scan and re-runs it inside a nested loop.
returns as materialized (
  select m.period as ret_period, a.official_line as ret_line, b.distributor_code as ret_dist,
         a.area_code as ret_area, a.product_code as ret_product,
         case when coalesce(a.is_direct, false) and btrim(coalesce(a.area_code, '')) = ''
              then upper(btrim(coalesce(a.region_code, ''))) end as ret_region,
         sum(a.qty) as ret_units,
         sum(case when a.is_direct then a.value
                  else a.qty * coalesce(p.factory_price, 0) end) as ret_value
  from (select pr.cur as period from periods pr
        union all
        select pr.next from periods pr) m
  cross join lateral public.phx_sos_rows_attributed(m.period) a
  join public.source_of_sales_import_batches b
    on b.id = a.batch_id and b.status = 'validated' and b.period = m.period
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(a.product_code))
  where a.qty < 0
    and coalesce(a.validation_state, 'valid') <> 'failed'
    and upper(btrim(coalesce(a.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by m.period, a.official_line, b.distributor_code, a.area_code, a.product_code,
           case when coalesce(a.is_direct, false) and btrim(coalesce(a.area_code, '')) = ''
                then upper(btrim(coalesce(a.region_code, ''))) end
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
-- other_units / other_value are what was TAKEN BACK in the second month (its returns). The net is
-- the fallback only if no return row is found, which a net-negative cell cannot really produce.
select 'reversal_pair'::text, pos.cell_period, neg.cell_period, pos.cell_line, pos.cell_dist,
       pos.cell_area, pos.cell_product, pos.cell_product_name, null::text,
       pos.cell_units, round(pos.cell_value::numeric, 2),
       coalesce(ret.ret_units, neg.cell_units), round(coalesce(ret.ret_value, neg.cell_value)::numeric, 2),
       pos.cell_region
from cells pos
join cells neg
  on neg.cell_line = pos.cell_line
 and neg.cell_dist = pos.cell_dist
 and neg.cell_area = pos.cell_area
 and neg.cell_region is not distinct from pos.cell_region
 and neg.cell_product = pos.cell_product
 and neg.cell_period = to_char((pos.cell_period || '-01')::date + interval '1 month', 'YYYY-MM')
left join returns ret
  on ret.ret_period = neg.cell_period
 and ret.ret_line = neg.cell_line
 and ret.ret_dist = neg.cell_dist
 and ret.ret_area = neg.cell_area
 and ret.ret_region is not distinct from neg.cell_region
 and ret.ret_product = neg.cell_product
cross join periods pr
where pos.cell_units >= 50
  and (
        -- the net is the reversal (the only case caught before)
        (neg.cell_units < 0 and abs(neg.cell_units) between 0.5 * pos.cell_units and 1.5 * pos.cell_units)
        -- or the returns are, while that month's ordinary sales keep the net positive
     or (ret.ret_units < 0 and abs(ret.ret_units) between 0.5 * pos.cell_units and 1.5 * pos.cell_units)
      )
  and (pos.cell_period = pr.cur or neg.cell_period = pr.cur)

union all
-- distributor_code is NULL here on purpose: this row is the whole cell, not one distributor's
-- share of it, and naming any single distributor would be the bug this replaced.
select 'net_negative'::text, c.cell_period, null, c.cell_line, null::text, c.cell_area,
       c.cell_product, c.cell_product_name, null,
       c.cell_units, round(c.cell_value::numeric, 2), null, null, c.cell_region
from closing_cells c
where c.cell_units < -20 or c.cell_value < -1000

union all
select 'late_return'::text, neg.neg_period, origin.origin_period, neg.neg_line, neg.neg_dist,
       neg.neg_area, neg.neg_product, neg.neg_product_name, neg.neg_client_name,
       neg.neg_units, round(neg.neg_value::numeric, 2), origin.origin_units, null, null::text
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

-- SECURITY DEFINER over the whole fact rollup, reachable by the service role only.
revoke execute on function public.phx_closing_corrections(text) from public, anon, authenticated;
grant  execute on function public.phx_closing_corrections(text) to service_role;

commit;
