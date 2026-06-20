-- Marketing ROI "View Sales" drill-down — per-request DETAIL rows (additive, read-only).
--
-- Returns one row per matched Source-of-Sales import row for ONE marketing request: the
-- realized sales of the request's promoted products, at its target pharmacy distributor
-- codes, over a period range. Mirrors phx_marketing_request_roi_actuals EXACTLY (same
-- ROI-only distributor rollup, same customer-code-only match, same value formula, same
-- validated-batch gates) so the drill-down reconciles to the cent with the ROI report
-- totals — it just emits detail instead of a per-request sum.
--
-- Period window: when p_from_period/p_to_period are both NULL (or malformed) the request's
-- own ROI window (pay_date .. +roi_duration_months-1) is used; otherwise the explicit
-- YYYY-MM..YYYY-MM range replaces it. Confidential products (LA003/LA004/SS001) are
-- excluded inside the function (defense in depth) unless the caller passes an empty
-- exclude array (CEO/Super Admin opt-in only, enforced in the service layer).
--
-- APPROVAL-GATED: do not apply to production without explicit per-migration approval.

create or replace function public.phx_marketing_request_view_sales(
  p_request_id uuid,
  p_from_period text default null,
  p_to_period text default null,
  p_exclude_product_codes text[] default '{LA003,LA004,SS001}'::text[]
)
 returns table(
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
    where mr.id = p_request_id and mr.pay_date is not null
  ),
  win as (
    select case
      when p_from_period ~ '^\d{4}-\d{2}$' and p_to_period ~ '^\d{4}-\d{2}$' and p_from_period <= p_to_period
        then array(
          select to_char(g, 'YYYY-MM')
          from generate_series(to_date(p_from_period, 'YYYY-MM'), to_date(p_to_period, 'YYYY-MM'), interval '1 month') g
        )
      else (
        select array_agg(to_char(g, 'YYYY-MM'))
        from req
        cross join lateral generate_series(
          date_trunc('month', req.pay_date),
          date_trunc('month', req.pay_date) + make_interval(months => req.months - 1),
          interval '1 month'
        ) g
      )
    end as periods
  ),
  req_products as (
    select distinct sp.product_code
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    cross join excl
    where mrp.request_id = p_request_id
      and upper(btrim(sp.product_code)) <> all(excl.codes)
  ),
  req_targets as (
    -- join source_of_sales_distributors so a rollup code with no SoS distributor row is
    -- dropped IDENTICALLY to phx_marketing_request_roi_actuals (keeps the two reconciled).
    select distinct
      sd.distributor_code as family_code,
      ru.parent_distributor_code,
      mpdc.normalized_pharmacy_code as customer_code
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.marketing_roi_distributor_rollup ru on ru.marketing_normalized_name = md.normalized_name
    join public.source_of_sales_distributors sd on sd.distributor_code = ru.sos_distributor_code
    where mrph.request_id = p_request_id
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
  ),
  target_products as (
    select distinct rt.family_code, rt.parent_distributor_code, rt.customer_code, rp.product_code
    from req_targets rt
    cross join req_products rp
  ),
  hits as (
    select distinct on (r.id)
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
    cross join win
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.family_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = any(win.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    order by r.id
  )
  select
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
  order by hits.invoice_period, hits.parent_distributor_code, hits.product_code;
$function$;

comment on function public.phx_marketing_request_view_sales(uuid, text, text, text[]) is
  'Marketing ROI View-Sales drill-down: per-request realized sales DETAIL rows (rolled-up distributors, customer-code-only match, canonical value formula, validated-batch gated). Confidential products excluded unless an empty exclude array is passed (CEO/Super Admin only).';

revoke all on function public.phx_marketing_request_view_sales(uuid, text, text, text[]) from public, anon, authenticated;
grant execute on function public.phx_marketing_request_view_sales(uuid, text, text, text[]) to service_role;

notify pgrst, 'reload schema';
