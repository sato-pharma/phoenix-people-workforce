-- "Returns bigger than the month's sales" was reporting ONE DISTRIBUTOR'S share as the closing's cell.
--
-- SoS audit finding, CONFIRMED critical: `src/components/sales/closing-corrections-view.tsx`.
-- Re-verified against production 2026-09-05, where it is worse than the audit recorded.
--
-- The page says, above that table: "The area×product cell nets below zero this month — the closing
-- shows a negative there, which is real, not a bug." The columns read "Net units" / "Net EGP".
--
-- But `cells` groups by `b.distributor_code` as well as area and product, while the closing
-- (`phx_monthly_closing_matrix`) groups by `f.area_code, f.product_code` ONLY. So the row was one
-- distributor's net position inside the cell, presented as the cell. When another distributor sold
-- the same product in the same area that month — the normal case — the two disagree, and can
-- disagree in SIGN.
--
-- Measured on production over 2026-05..07, all 10 rows the page flagged:
--
--   THE CLOSING'S CELL IS POSITIVE — the page claimed a negative that does not exist:
--     2026-05  CA2/TE003   page  -15 u   ->  cell  +1,084 u
--     2026-06  CA1/TE003   page  -20 u   ->  cell    +346 u
--     2026-07  AB4/RO001   page  -34 u   ->  cell     +31 u
--   NEGATIVE BUT THE WRONG SIZE:
--     2026-07  D21/SA001   page -179 u   ->  cell     -13 u   (overstated 13x)
--     2026-07  D21/RO001   page -170 u   ->  cell    -151 u
--     2026-05  CA4/CO002   page  -80 u   ->  cell     -76 u
--     2026-06  UE5/TE001   page  -31 u   ->  cell     -29 u
--   CORRECT, and only because a single distributor sold that cell:
--     2026-06  AB3/LA002, GZ1/LA002, UE9/LA001
--
-- 7 of 10 rows were wrong. The reader is the Super Admin — the only role that can open this page —
-- and the page exists precisely to tell him a negative in the closing is real rather than a bug.
-- Told to check, he finds the opposite sign, and reasonably concludes one of the two screens is
-- broken. Any manual adjustment made off these numbers moves a rep's reported sales.
--
-- ── The fix: make the number mean what the label says ───────────────────────────────────────
-- `net_negative` now aggregates the AREA x PRODUCT cell, with no distributor in the grouping, so it
-- is the same cell the closing shows. It reports `distributor_code` as NULL, because a cell built
-- from several distributors has no single one — the loader and the view drop that column for this
-- section rather than print a misleading name.
--
-- Everything else about the detection is deliberately untouched: the same source (validated batches
-- only), the same confidential-product exclusions (LA003/LA004/SS001), the same direct-order value
-- basis (`direct_value` for a direct row, never units x factory price — the owner's rule; 114 direct
-- rows in these three months do carry a batch and do reach this join, so the branch is live), and
-- the same thresholds (< -20 units or < -1,000 EGP). Those thresholds now describe the real cell,
-- which is what they were always meant to describe.
--
-- `reversal_pair` and `late_return` KEEP the per-distributor grouping, and that is correct, not an
-- oversight. A reversal pair is one distributor posting then retracting — cross-distributor netting
-- would erase the very pattern it looks for. A late return is traced by client code, which the
-- migration's own comment notes is unique only per distributor, so dropping the distributor there
-- would merge different customers.
--
-- Effect on what the page shows for 2026-05..07: 10 rows become 7. The three sign-flip rows
-- disappear, correctly — the closing shows no negative in those cells — and four keep their row
-- with the true figure.
--
-- The RETURNS TABLE signature is unchanged, so this is a plain CREATE OR REPLACE and every caller
-- keeps working; `distributor_code` simply arrives NULL on net_negative rows.

CREATE OR REPLACE FUNCTION public.phx_closing_corrections(p_period text)
 RETURNS TABLE(kind text, period text, other_period text, line text, distributor_code text, area_code text, product_code text, product_name text, client_name text, units numeric, value numeric, other_units numeric, other_value numeric)
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
closing_cells as (
  select f.period as cell_period, f.official_line as cell_line,
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
  where f.period = pr.cur
    and upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
  group by f.period, f.official_line, f.area_code, f.product_code
)
select 'reversal_pair'::text, pos.cell_period, neg.cell_period, pos.cell_line, pos.cell_dist,
       pos.cell_area, pos.cell_product, pos.cell_product_name, null::text,
       pos.cell_units, round(pos.cell_value::numeric, 2),
       neg.cell_units, round(neg.cell_value::numeric, 2)
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
       c.cell_units, round(c.cell_value::numeric, 2), null, null
from closing_cells c
where c.cell_units < -20 or c.cell_value < -1000

union all
select 'late_return'::text, neg.neg_period, origin.origin_period, neg.neg_line, neg.neg_dist,
       neg.neg_area, neg.neg_product, neg.neg_product_name, neg.neg_client_name,
       neg.neg_units, round(neg.neg_value::numeric, 2), origin.origin_units, null
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

-- CREATE OR REPLACE keeps the existing ACL, but state it anyway so a replay from a clean database
-- lands in the same place: SECURITY DEFINER over the whole fact rollup.
revoke execute on function public.phx_closing_corrections(text) from public, anon, authenticated;
grant  execute on function public.phx_closing_corrections(text) to service_role;
