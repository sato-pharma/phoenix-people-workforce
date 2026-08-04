-- Closing Corrections — the detector behind /sales/closing-corrections.
--
-- WHY (owner request, 2026-08-05). Two real cases made a month's closing read wrong while every
-- total stayed arithmetically exact:
--   * GZ4 (Haram–Faisal): Ibn Sina-Sato posted +200/+204 units in June and −199/−197 in July —
--     a cross-month reversal that inflates one month and deflates the next (~34K EGP each way).
--   * UE9 (Beni Suef): a customer bought 120 units in March and returned them in June — a real
--     late return whose credit lands months after the sale it cancels.
-- The owner ruled: leave the data as booked, but SHOW these situations on their own page.
--
-- One RPC, three kinds, all sharing the closing's own valuation basis (Direct rows at their
-- submitted value, distributor rows at effective units × factory price, confidential products
-- excluded — the exact phx_monthly_closing_* predicates), so every EGP figure here relates
-- directly to the closing sheet the reader just left:
--
--   'reversal_pair'  (distributor, line, area, product) with positive units in one month and a
--                    negative of 50–150% of them the NEXT month, ≥50 units — the GZ4 shape.
--                    Emitted when either month is the requested one.
--   'net_negative'   a cell of the requested month whose net is < −20 units or < −1,000 EGP —
--                    returns exceeding sales.
--   'late_return'    a client-level negative in the requested month (≤ −10 units or ≤ −1,000 EGP)
--                    traced via the SAME distributor + client + product to its most recent
--                    positive month — the El-Borg shape. Client codes are only unique per
--                    distributor, so the origin join deliberately includes distributor_code.
--
-- Thresholds are deliberate noise floors, not policy: small everyday returns stay off the page.
-- SECURITY DEFINER + service_role-only EXECUTE, matching the sibling closing RPCs; the explicit
-- grant after the revokes is required because REVOKE FROM PUBLIC on a default ACL would strip
-- service_role too.

create or replace function public.phx_closing_corrections(p_period text)
returns table(
  kind text,
  period text,
  other_period text,
  line text,
  distributor_code text,
  area_code text,
  product_code text,
  product_name text,
  client_name text,
  units numeric,
  value numeric,
  other_units numeric,
  other_value numeric
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '45s'
as $function$
with periods as (
  select p_period as cur,
         to_char((p_period || '-01')::date - interval '1 month', 'YYYY-MM') as prev,
         to_char((p_period || '-01')::date + interval '1 month', 'YYYY-MM') as next
),
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
select 'net_negative'::text, c.cell_period, null, c.cell_line, c.cell_dist, c.cell_area,
       c.cell_product, c.cell_product_name, null,
       c.cell_units, round(c.cell_value::numeric, 2), null, null
from cells c
cross join periods pr
where c.cell_period = pr.cur
  and (c.cell_units < -20 or c.cell_value < -1000)

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

revoke execute on function public.phx_closing_corrections(text) from public, anon, authenticated;
grant execute on function public.phx_closing_corrections(text) to service_role;

notify pgrst, 'reload schema';
