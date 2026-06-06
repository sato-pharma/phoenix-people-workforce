-- Actual ROI for marketing requests, computed from realized sales.
--
-- For each request, sum the realized sales of THAT request's promoted products
-- (bridged to sales products by normalized name -- their codes differ), at THAT
-- request's pharmacies (bridged via distributor + pharmacy code -> brick), within ONLY
-- the request's ROI window (pay_date .. pay_date + roi_duration_months, matched against
-- the YYYY-MM invoice_period). Realized value uses the same formula as monthly closing:
-- qty * (1 - discount) * factory_price. Sales rows must be validation_state = 'valid'.
--
-- Distinct product codes and distinct (distributor_code, brick_id) pairs are pre-computed
-- per request so a single sales row is never double-counted when two pharmacy codes map to
-- the same brick or names collapse.

create or replace function public.phx_marketing_request_roi_actuals(p_request_ids uuid[])
returns table (request_id uuid, actual_value numeric, actual_units numeric, sales_rows integer)
language sql
stable
set search_path = public
as $func$
  with req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months
    from public.marketing_requests mr
    where mr.id = any(p_request_ids)
      and mr.pay_date is not null
  ),
  periods as (
    select req.id, array_agg(to_char(g, 'YYYY-MM')) as periods
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.months - 1),
      interval '1 month'
    ) as g
    group by req.id
  ),
  req_products as (
    -- distinct sales product codes for the request, bridged by normalized product name
    select distinct mrp.request_id, sp.product_code
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    where mrp.request_id = any(p_request_ids)
  ),
  req_bricks as (
    -- distinct (sales distributor_code, brick_id) for the request, bridged by distributor
    -- normalized name and pharmacy code -> customer map -> brick
    select distinct mrph.request_id, sd.distributor_code, cm.brick_id
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.source_of_sales_distributors sd on sd.normalized_distributor_name = md.normalized_name
    join public.source_of_sales_customer_map cm
      on cm.distributor_code = sd.distributor_code
     and lower(btrim(regexp_replace(coalesce(cm.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
     and cm.active
     -- brick_id can be NULL or an empty string; both must be excluded so empty-brick
     -- sales are never lumped together and mis-attributed.
     and coalesce(btrim(cm.brick_id), '') <> ''
    where mrph.request_id = any(p_request_ids)
  )
  select
    req.id as request_id,
    coalesce(sum(r.qty * (1 - coalesce(r.discount, 0)) * coalesce(sp.factory_price, 0)), 0)::numeric as actual_value,
    coalesce(sum(r.qty), 0)::numeric as actual_units,
    count(r.id)::integer as sales_rows
  from req
  join periods on periods.id = req.id
  join req_bricks rb on rb.request_id = req.id
  join req_products rp on rp.request_id = req.id
  join public.source_of_sales_import_rows r
    on r.distributor_code = rb.distributor_code
   and r.brick_id = rb.brick_id
   and upper(btrim(r.product_code)) = upper(btrim(rp.product_code))
   and r.invoice_period = any(periods.periods)
   and r.validation_state = 'valid'
  -- Only count rows from validated batches, matching the monthly-closing semantics.
  join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
  join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
  group by req.id;
$func$;

revoke all on function public.phx_marketing_request_roi_actuals(uuid[]) from public, anon, authenticated;
grant execute on function public.phx_marketing_request_roi_actuals(uuid[]) to service_role;

comment on function public.phx_marketing_request_roi_actuals(uuid[]) is
  'Realized sales (value/units/rows) per marketing request: its promoted products at its pharmacies within its ROI window. Server-only (service_role).';
