-- phx_marketing_coverage_export_sales_detail_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_marketing_coverage_export_sales_detail` now takes its factory price from
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

create or replace function public.phx_marketing_coverage_export_sales_detail(p_request_ids uuid[], p_exclude_product_codes text[] DEFAULT '{LA003,LA004,SS001}'::text[])
 RETURNS TABLE(request_id uuid, distributor_code text, distributor_name text, invoice_period text, product_code text, product_name text, customer_code text, customer_name text, region_name text, qty numeric, value numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
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
           else r.qty * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0)
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

commit;
