-- "Returns bigger than the month's sales" netted Direct orders from DIFFERENT REGIONS into one cell
-- that the closing does not have.
--
-- SoS audit finding, CONFIRMED critical:
-- `supabase/migrations/20260805001000_phx_closing_corrections.sql:72` — "Direct rows are booked by
-- AREA on this page but by REGION in the closing, inventing a cell that does not exist".
--
-- The 2026-09-05 fix (20260905150000) made `net_negative` the closing's own area x product cell,
-- every distributor together. It left one kind of row out of step with the closing: a Direct row
-- that carries NO AREA. Every Direct row from 2026-02 to 2026-06 is one of these (the retired
-- vintage, before the Direct Orders module stamped an area on each order). The closing never puts
-- such a row in an area cell. `phx_monthly_closing_direct` returns it by REGION, and
-- `injectDirectIntoMatrix` gives each region its own "Direct" row. `closing_cells` grouped it by
-- area anyway, so every region's no-area Direct money fell into the SAME blank-area cell and was
-- netted together.
--
-- Measured on production 2026-09-18, the one row it produces today, 2026-04 Pedia, Lacto Advanced 2:
--
--   the page    one row, area "(no area) ()", -350 units / -66,880.00 EGP
--   the closing Direct row in region AB   +82 units / +16,280.00 EGP
--               Direct row in region D1  -432 units / -83,160.00 EGP
--
-- The page's -66,880.00 is the net of two region rows. No such cell exists in the closing, the
-- region that really carries the credit (D1) is not named, and the real negative is understated by
-- 16,280.00 EGP. Every other net_negative row from 2026-01 to 2026-09 contains no no-area Direct
-- money and is unchanged. That includes July's D21 / Saginko, whose +100 Direct units carry their
-- own area and are folded into D21 by July's owner overlay, just as the closing does.
--
-- ── The fix ────────────────────────────────────────────────────────────────────────────────
-- `closing_cells` keys a Direct row with no area by its REGION (upper-cased and trimmed, as
-- `injectDirectIntoMatrix` normalises it), and the function returns that region as a new last
-- column, `region_code`. It is NULL on every other row: area cells, a Direct row that carries its
-- own area, and the reversal_pair and late_return kinds, which stay per distributor exactly as
-- before. Detection, sources, exclusions, the direct-value basis and the thresholds are untouched.
--
-- Adding a column changes the RETURNS TABLE, which CREATE OR REPLACE cannot do, so this drops and
-- recreates the function in one transaction and restates its grants. The new column is LAST and
-- `area_code` stays blank on the Direct cell, so a caller that ignores `region_code` still works.
-- The code deployed before this migration would simply print one row per region instead of one
-- netted row.

DROP FUNCTION IF EXISTS public.phx_closing_corrections(text);

CREATE FUNCTION public.phx_closing_corrections(p_period text)
 RETURNS TABLE(kind text, period text, other_period text, line text, distributor_code text, area_code text, product_code text, product_name text, client_name text, units numeric, value numeric, other_units numeric, other_value numeric, region_code text)
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
select 'reversal_pair'::text, pos.cell_period, neg.cell_period, pos.cell_line, pos.cell_dist,
       pos.cell_area, pos.cell_product, pos.cell_product_name, null::text,
       pos.cell_units, round(pos.cell_value::numeric, 2),
       neg.cell_units, round(neg.cell_value::numeric, 2), null::text
from cells pos
join cells neg
  on neg.cell_line = pos.cell_line
 and neg.cell_dist = pos.cell_dist
 and neg.cell_area = pos.cell_area
 and neg.cell_product = pos.cell_product
 and neg.cell_period = to_char((pos.cell_period || '-01')::date + interval '1 month', 'YYYY-MM')
cross join periods pr
where pos.cell_units >= 50
  and neg.cell_units < 0
  and abs(neg.cell_units) between 0.5 * pos.cell_units and 1.5 * pos.cell_units
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

-- DROP + CREATE drops the ACL with the function, so restate it: SECURITY DEFINER over the whole
-- fact rollup, reachable by the service role only.
revoke execute on function public.phx_closing_corrections(text) from public, anon, authenticated;
grant  execute on function public.phx_closing_corrections(text) to service_role;
