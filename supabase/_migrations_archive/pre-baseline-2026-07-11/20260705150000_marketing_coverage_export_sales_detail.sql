-- Marketing Coverage Report export — BULK per-sale detail across MANY requests at once
-- (product + invoice month + pharmacy), for the exported XLSX's new "Sales Detail" sheet.
--
-- Adapts phx_marketing_request_view_sales (20260621190000_marketing_request_view_sales.sql)
-- to take an ARRAY of request ids instead of one UUID, so the export never calls the
-- per-request RPC in a loop (that RPC is documented as ONE-request-at-a-time only — see
-- src/lib/export/marketing-coverage-workbook.ts's header comment — looping it over a large
-- filtered export risks a timeout). Same matching logic, same value formula, same
-- validated-batch gates, so results reconcile to the cent with the on-screen per-pharmacy
-- drill-down and the report's own actual-sales totals.
--
-- Each request always uses ITS OWN default ROI window (pay_date .. +roi_duration_months-1)
-- via a per-request lateral generate_series — the export has no per-request custom range to
-- honor (unlike the single-request RPC, which optionally accepts an explicit override).
--
-- APPROVAL-GATED: do not apply to production without explicit per-migration approval.

create or replace function public.phx_marketing_coverage_export_sales_detail(
  p_request_ids uuid[],
  p_exclude_product_codes text[] default '{LA003,LA004,SS001}'::text[]
)
 returns table(
   request_id uuid,
   distributor_code text,
   distributor_name text,
   invoice_period text,
   product_code text,
   product_name text,
   customer_code text,
   customer_name text,
   region_name text,
   qty numeric,
   value numeric
 )
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
  win as (
    select req.id as request_id, to_char(g, 'YYYY-MM') as period
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.months - 1),
      interval '1 month'
    ) g
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
    -- join source_of_sales_distributors so a rollup code with no SoS distributor row is
    -- dropped IDENTICALLY to phx_marketing_request_roi_actuals / the single-request RPC.
    select distinct
      mrph.request_id,
      sd.distributor_code as family_code,
      ru.parent_distributor_code,
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
    select distinct rt.request_id, rt.family_code, rt.parent_distributor_code, rt.customer_code, rp.product_code
    from req_targets rt
    join req_products rp on rp.request_id = rt.request_id
  ),
  hits as (
    -- dedup per (request, matched SoS row): the SAME underlying sale can legitimately
    -- satisfy more than one request in the batch, but must never appear twice for the
    -- SAME request (mirrors the single-request RPC's `distinct on (r.id)` exactly, just
    -- scoped per request instead of globally, since this now covers many requests at once).
    select distinct on (tp.request_id, r.id)
      tp.request_id,
      r.id as row_id,
      tp.parent_distributor_code,
      r.invoice_period,
      r.product_code,
      coalesce(sp.product_name, r.product_name, r.product_code) as product_name,
      tp.customer_code,
      r.client_name as customer_name,
      r.region_name,
      r.qty as qty,
      case when coalesce(r.is_direct, false)
           then coalesce(r.value, 0)
           else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(sp.factory_price, 0)
      end as value
    from target_products tp
    join win on win.request_id = tp.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.family_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = win.period
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    order by tp.request_id, r.id
  )
  select
    hits.request_id,
    hits.parent_distributor_code as distributor_code,
    coalesce(sd.distributor_name, hits.parent_distributor_code) as distributor_name,
    hits.invoice_period,
    hits.product_code,
    hits.product_name,
    hits.customer_code,
    hits.customer_name,
    hits.region_name,
    hits.qty::numeric,
    hits.value::numeric
  from hits
  left join public.source_of_sales_distributors sd on sd.distributor_code = hits.parent_distributor_code
  order by hits.request_id, hits.invoice_period, hits.parent_distributor_code, hits.product_code;
$function$;

comment on function public.phx_marketing_coverage_export_sales_detail(uuid[], text[]) is
  'Marketing Coverage Report export — BULK per-sale detail (product + invoice month + pharmacy) across MANY requests in one call, each using its own default ROI window. Confidential products excluded unless an empty exclude array is passed (CEO/Super Admin only). Never call phx_marketing_request_view_sales in a loop for export.';

revoke all on function public.phx_marketing_coverage_export_sales_detail(uuid[], text[]) from public, anon, authenticated;
grant execute on function public.phx_marketing_coverage_export_sales_detail(uuid[], text[]) to service_role;

notify pgrst, 'reload schema';
