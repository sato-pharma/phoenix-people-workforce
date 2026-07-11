-- Marketing ROI Filter-Engine support functions (additive; no existing object changed).
--
-- 1) phx_marketing_request_roi_actuals_v2(ids, exclude_codes): identical attribution to
--    phx_marketing_request_roi_actuals, but DROPS the excluded product codes from the
--    promoted-product set so confidential products (LA003/LA004/SS001) never contribute
--    to a non-revealing viewer's totals. Passing an empty array reproduces the base RPC
--    exactly. The ROI-only distributor rollup is preserved.
-- 2) phx_marketing_roi_latest_validated_period(): the latest validated Source-of-Sales
--    invoice period (YYYY-MM) backing attribution — the "sales data as of" trust badge.
--
-- Both are STABLE / read-only and service-role callable. APPROVAL-GATED: do not apply to
-- production without explicit per-migration approval.

create or replace function public.phx_marketing_request_roi_actuals_v2(
  p_request_ids uuid[],
  p_exclude_product_codes text[] default '{}'::text[]
)
 returns table(request_id uuid, actual_value numeric, actual_units numeric, sales_rows integer, exact_sales_rows integer, fallback_sales_rows integer, attribution_quality text)
 language sql
 stable
 set search_path to 'public'
as $function$
  with excl as (
    select array(select upper(btrim(c)) from unnest(coalesce(p_exclude_product_codes, '{}'::text[])) c) as codes
  ),
  req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months
    from public.marketing_requests mr
    where mr.id = any(p_request_ids) and mr.pay_date is not null
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
    cross join excl
    where mrp.request_id = any(p_request_ids)
      and upper(btrim(sp.product_code)) <> all(excl.codes)
  ),
  req_targets as (
    select distinct
      mrph.request_id,
      sd.distributor_code,
      mpdc.normalized_pharmacy_code as customer_code
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    where mrph.request_id = any(p_request_ids)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
  ),
  target_products as (
    select distinct rt.request_id, rt.distributor_code, rt.customer_code, rp.product_code
    from req_targets rt
    join req_products rp on rp.request_id = rt.request_id
  ),
  exact_hits as (
    select distinct
      tp.request_id,
      r.id as row_id,
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
  actuals as (
    select
      request_id,
      coalesce(sum(value), 0)::numeric as actual_value,
      coalesce(sum(units), 0)::numeric as actual_units,
      count(distinct row_id)::integer as sales_rows
    from exact_hits
    group by request_id
  )
  select
    req.id as request_id,
    coalesce(actuals.actual_value, 0)::numeric as actual_value,
    coalesce(actuals.actual_units, 0)::numeric as actual_units,
    coalesce(actuals.sales_rows, 0)::integer as sales_rows,
    coalesce(actuals.sales_rows, 0)::integer as exact_sales_rows,
    0::integer as fallback_sales_rows,
    case when coalesce(actuals.sales_rows, 0) = 0 then 'no_sales' else 'exact_customer' end as attribution_quality
  from req
  left join actuals on actuals.request_id = req.id;
$function$;

comment on function public.phx_marketing_request_roi_actuals_v2(uuid[], text[]) is
  'ROI per-request actuals with confidential-product exclusion (LA003/LA004/SS001 masking for non-revealing viewers). Empty exclude array == phx_marketing_request_roi_actuals.';

revoke all on function public.phx_marketing_request_roi_actuals_v2(uuid[], text[]) from public, anon, authenticated;
grant execute on function public.phx_marketing_request_roi_actuals_v2(uuid[], text[]) to service_role;

create or replace function public.phx_marketing_roi_latest_validated_period()
 returns text
 language sql
 stable
 set search_path to 'public'
as $function$
  select max(r.invoice_period)
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
  where r.validation_state = 'valid';
$function$;

comment on function public.phx_marketing_roi_latest_validated_period() is
  'Latest validated Source-of-Sales invoice period (YYYY-MM) — the "sales data as of" trust badge for the marketing ROI report.';

revoke all on function public.phx_marketing_roi_latest_validated_period() from public, anon, authenticated;
grant execute on function public.phx_marketing_roi_latest_validated_period() to service_role;

notify pgrst, 'reload schema';
