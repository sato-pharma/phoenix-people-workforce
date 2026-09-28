-- phx_marketing_request_sales_lines_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_marketing_request_sales_lines` now takes its factory price from
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

create or replace function public.phx_marketing_request_sales_lines(p_request_ids uuid[], p_exclude_product_codes text[] DEFAULT ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text], p_from_period text DEFAULT NULL::text, p_to_period text DEFAULT NULL::text)
 RETURNS TABLE(request_id uuid, channel text, source_row_id text, distributor_code text, distributor_name text, customer_code text, customer_name text, product_code text, product_name text, invoice_period text, region_name text, qty numeric, value numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
  with excl as (
    select array(select upper(btrim(c)) from unnest(coalesce(p_exclude_product_codes, '{}'::text[])) c) as codes
  ),
  req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months,
           coalesce(mr.track_direct_sales, false) as track_direct_sales
    from public.marketing_requests mr
    where mr.id = any(p_request_ids) and mr.pay_date is not null
  ),
  win as (
    select case
      when p_from_period ~ '^\d{4}-\d{2}$' and p_to_period ~ '^\d{4}-\d{2}$' and p_from_period <= p_to_period
        then array(
          select to_char(g, 'YYYY-MM')
          from generate_series(to_date(p_from_period, 'YYYY-MM'), to_date(p_to_period, 'YYYY-MM'), interval '1 month') g
        )
      else null::text[]
    end as periods
  ),
  pay_periods as (
    select req.id, array_agg(to_char(g, 'YYYY-MM')) as periods
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.months - 1),
      interval '1 month'
    ) as g
    group by req.id
  ),
  periods as (
    select ids.id, coalesce(win.periods, pay_periods.periods) as periods
    from (select distinct u.id from unnest(coalesce(p_request_ids, '{}'::uuid[])) as u(id)) ids
    cross join win
    left join pay_periods on pay_periods.id = ids.id
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
  retail_hits as (
    select distinct on (tp.request_id, r.id)
      tp.request_id,
      'retail'::text as channel,
      r.id::text as source_row_id,
      tp.parent_distributor_code::text as distributor_code,
      coalesce(sd.distributor_name, tp.parent_distributor_code)::text as distributor_name,
      tp.customer_code::text as customer_code,
      r.client_name::text as customer_name,
      r.product_code::text as product_code,
      coalesce(sp.product_name, r.product_name, r.product_code)::text as product_name,
      r.invoice_period::text as invoice_period,
      r.region_name::text as region_name,
      r.qty::numeric as qty,
      (case when coalesce(r.is_direct, false)
            then coalesce(r.value, 0)
            else r.qty * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0)
       end)::numeric as value
    from target_products tp
    join periods on periods.id = tp.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.family_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    left join public.source_of_sales_distributors sd on sd.distributor_code = tp.parent_distributor_code
    order by tp.request_id, r.id
  ),
  direct_hits as (
    select distinct on (mrph.request_id, dor.id)
      mrph.request_id,
      'direct'::text as channel,
      dor.id::text as source_row_id,
      sd.distributor_code::text as distributor_code,
      sd.distributor_name::text as distributor_name,
      mpdc.normalized_pharmacy_code::text as customer_code,
      null::text as customer_name,
      dor.product_code::text as product_code,
      null::text as product_name,
      dor.sales_month::text as invoice_period,
      null::text as region_name,
      coalesce(dor.qty, 0)::numeric as qty,
      coalesce(dor.sales_value, 0)::numeric as value
    from req
    join periods on periods.id = req.id
    join req_products rp on rp.request_id = req.id
    join public.marketing_request_pharmacies mrph on mrph.request_id = req.id
    join public.marketing_pharmacy_distributor_codes mpdc
      on mpdc.id = mrph.distributor_code_id and coalesce(mpdc.active, true)
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    join public.direct_order_pharmacy_distributor_codes dopdc
      on lower(btrim(dopdc.distributor_code)) = lower(btrim(sd.distributor_code))
     and lower(btrim(regexp_replace(coalesce(dopdc.customer_code, ''), '\s+', ' ', 'g')))
       = lower(btrim(regexp_replace(coalesce(mpdc.normalized_pharmacy_code, ''), '\s+', ' ', 'g')))
    join public.direct_order_requests dor
      on dor.pharmacy_id = dopdc.pharmacy_id
     and dor.status = 'approved'
     and dor.reversal_of_request_id is null
     and dor.sales_month = any(periods.periods)
     and upper(btrim(dor.product_code)) = upper(btrim(rp.product_code))
    where req.track_direct_sales = true
    order by mrph.request_id, dor.id
  )
  select * from retail_hits
  union all
  select * from direct_hits;
$function$;

commit;
