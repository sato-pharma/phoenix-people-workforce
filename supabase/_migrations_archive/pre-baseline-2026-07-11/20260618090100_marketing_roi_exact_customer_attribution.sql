-- Marketing ROI actuals: prefer exact customer-code attribution.
--
-- Previous logic attributed realized sales by distributor + brick + product.
-- That could overstate a request's impact because every customer in the same
-- brick could be counted. This replacement matches the request pharmacy's
-- distributor code to source_of_sales_import_rows.client_code first, then keeps
-- the old brick fallback only for request brick/product pairs with no exact
-- customer-code sales rows.

drop function if exists public.phx_marketing_request_roi_actuals(uuid[]);

create function public.phx_marketing_request_roi_actuals(p_request_ids uuid[])
returns table (
  request_id uuid,
  actual_value numeric,
  actual_units numeric,
  sales_rows integer,
  exact_sales_rows integer,
  fallback_sales_rows integer,
  attribution_quality text
)
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
    select distinct mrp.request_id, sp.product_code
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    where mrp.request_id = any(p_request_ids)
  ),
  req_targets as (
    select distinct
      mrph.request_id,
      sd.distributor_code,
      mpdc.normalized_pharmacy_code as customer_code,
      cm.brick_id
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.source_of_sales_distributors sd on sd.normalized_distributor_name = md.normalized_name
    left join public.source_of_sales_customer_map cm
      on cm.distributor_code = sd.distributor_code
     and lower(btrim(regexp_replace(coalesce(cm.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
     and cm.active
    where mrph.request_id = any(p_request_ids)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
  ),
  target_products as (
    select distinct
      rt.request_id,
      rt.distributor_code,
      rt.customer_code,
      rt.brick_id,
      rp.product_code
    from req_targets rt
    join req_products rp on rp.request_id = rt.request_id
  ),
  exact_hits as (
    select distinct
      tp.request_id,
      r.id as row_id,
      r.distributor_code,
      tp.brick_id as fallback_brick_id,
      upper(btrim(r.product_code)) as product_code,
      r.qty as units,
      case when coalesce(r.is_direct, false)
           then coalesce(r.value, 0)
           else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(sp.factory_price, 0)
      end as value
    from target_products tp
    join periods on periods.id = tp.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.distributor_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
  ),
  exact_covered_keys as (
    select distinct request_id, distributor_code, coalesce(fallback_brick_id, '') as brick_id, product_code
    from exact_hits
  ),
  fallback_bricks as (
    select distinct
      request_id,
      distributor_code,
      brick_id,
      upper(btrim(product_code)) as product_code
    from target_products
    where coalesce(btrim(brick_id), '') <> ''
  ),
  fallback_hits as (
    select distinct
      fb.request_id,
      r.id as row_id,
      r.distributor_code,
      r.brick_id,
      upper(btrim(r.product_code)) as product_code,
      r.qty as units,
      case when coalesce(r.is_direct, false)
           then coalesce(r.value, 0)
           else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(sp.factory_price, 0)
      end as value
    from fallback_bricks fb
    join periods on periods.id = fb.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = fb.distributor_code
     and r.brick_id = fb.brick_id
     and upper(btrim(r.product_code)) = fb.product_code
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    where not exists (
      select 1
      from exact_covered_keys ek
      where ek.request_id = fb.request_id
        and ek.distributor_code = fb.distributor_code
        and ek.brick_id = coalesce(fb.brick_id, '')
        and ek.product_code = fb.product_code
    )
  ),
  all_hits as (
    select request_id, row_id, units, value, 'exact'::text as match_type
    from exact_hits
    union all
    select request_id, row_id, units, value, 'fallback'::text as match_type
    from fallback_hits
  ),
  actuals as (
    select
      request_id,
      coalesce(sum(value), 0)::numeric as actual_value,
      coalesce(sum(units), 0)::numeric as actual_units,
      count(distinct row_id)::integer as sales_rows,
      (count(distinct row_id) filter (where match_type = 'exact'))::integer as exact_sales_rows,
      (count(distinct row_id) filter (where match_type = 'fallback'))::integer as fallback_sales_rows
    from all_hits
    group by request_id
  )
  select
    req.id as request_id,
    coalesce(actuals.actual_value, 0)::numeric as actual_value,
    coalesce(actuals.actual_units, 0)::numeric as actual_units,
    coalesce(actuals.sales_rows, 0)::integer as sales_rows,
    coalesce(actuals.exact_sales_rows, 0)::integer as exact_sales_rows,
    coalesce(actuals.fallback_sales_rows, 0)::integer as fallback_sales_rows,
    case
      when coalesce(actuals.sales_rows, 0) = 0 then 'no_sales'
      when coalesce(actuals.exact_sales_rows, 0) > 0 and coalesce(actuals.fallback_sales_rows, 0) > 0 then 'mixed'
      when coalesce(actuals.exact_sales_rows, 0) > 0 then 'exact_customer'
      else 'brick_fallback'
    end as attribution_quality
  from req
  left join actuals on actuals.request_id = req.id;
$func$;

revoke all on function public.phx_marketing_request_roi_actuals(uuid[]) from public, anon, authenticated;
grant execute on function public.phx_marketing_request_roi_actuals(uuid[]) to service_role;

comment on function public.phx_marketing_request_roi_actuals(uuid[]) is
  'Realized marketing ROI sales per request. Prefers exact distributor + customer_code attribution; uses brick fallback only when no exact request/brick/product sales rows exist. Server-only (service_role).';
