-- Fix the dead Direct Orders join in phx_marketing_request_roi_actuals_v2.
--
-- WHY: the direct_hits branch added by 20260719151000_marketing_roi_actuals_v2_direct_branch.sql
-- could never match a single row, because it compared two code namespaces that share no values:
--
--     join public.direct_order_pharmacy_distributor_codes dopdc
--       on lower(btrim(dopdc.distributor_code)) = lower(btrim(md.distributor_code))
--
--   * marketing_distributors.distributor_code holds SYNTHETIC surrogates minted by the marketing
--     module -- 'DST_IBN_SINA_9DBF268F', 'DST_CHIMIPHARM_D590ED0B', 'DST_EGD_1002_D380502C', ...
--   * direct_order_pharmacy_distributor_codes.distributor_code holds REAL Source-of-Sales codes --
--     'IS', 'PS', 'PS-T', 'Direct'.
--
-- Measured on production 2026-08-08: that join produces 0 pairs out of 12 marketing distributors
-- x 13 direct-order pharmacy codes, and marketing_distributors.distributor_code matches 0 rows in
-- source_of_sales_distributors. The branch was dead on arrival -- track_direct_sales could be
-- turned on for every request and the ROI actuals would still never pick up a direct-order sale.
--
-- The retail branch (req_targets) never had this problem because it routes the distributor hop
-- through the rollup that exists precisely to bridge the two namespaces:
--     marketing_distributors.normalized_name
--       -> marketing_roi_distributor_rollup.marketing_normalized_name
--       -> marketing_roi_distributor_rollup.sos_distributor_code
--       -> source_of_sales_distributors.distributor_code
-- The direct branch simply skipped that hop. This migration adds it, so direct_hits resolves a
-- marketing distributor to its whole SoS code family (e.g. 'ibn sina' -> IS / IS-S / IS-T) exactly
-- the way the retail branch already does. With the hop in place the same comparison yields 11
-- distributor pairs instead of 0.
--
-- NOTHING ELSE CHANGES. The customer-code equality, dor.status = 'approved',
-- reversal_of_request_id is null, sales_month = any(periods), the product-code equality and the
-- req.track_direct_sales = true guard are all carried over byte-identical, and the retail branch is
-- untouched.
--
-- THIS MOVES NO NUMBER TODAY. Verified on production before writing this migration, by replaying
-- the corrected direct_hits CTE as a read-only SELECT over all 218 marketing requests: it returns
-- 0 rows WITH the track_direct_sales guard and still 0 rows with the guard removed entirely.
-- Two independent reasons, either one sufficient:
--   1. track_direct_sales is true on 0 of 218 requests (218 false, 0 null), so the branch is gated
--      off everywhere; and
--   2. no approved direct order has reached Source of Sales yet -- all 3 approved
--      direct_order_requests carry sales_month = NULL and sos_batch_id = NULL, and there are 0
--      'DirectReq' batches and 0 'DirectReq' rows in SoS. That is a separate defect in the Direct
--      Orders module and is deliberately NOT addressed here.
-- So this is a latent-correctness fix: it repairs the join before the flag is ever switched on,
-- rather than changing any figure now.
--
-- CAUTION for whoever edits this next: CREATE OR REPLACE FUNCTION silently DROPS any setting
-- previously applied via ALTER FUNCTION ... SET. The live function carries
-- proconfig = {search_path=public, statement_timeout=45s} (confirmed from pg_proc on production
-- 2026-08-08); both are re-declared in the CREATE header below on purpose. Removing the timeout
-- would drop this RPC back to the 8s authenticator default and 500 the ROI page on a slow query --
-- tests/report-rpc-guardrails.test.ts exists to catch exactly that and replays every migration to
-- do it.
--
-- Re-runnable: CREATE OR REPLACE is idempotent, and the function is recreated in full.

begin;

create or replace function public.phx_marketing_request_roi_actuals_v2(p_request_ids uuid[], p_exclude_product_codes text[] DEFAULT '{}'::text[])
 returns TABLE(request_id uuid, actual_value numeric, actual_units numeric, sales_rows integer, exact_sales_rows integer, fallback_sales_rows integer, attribution_quality text)
 language sql
 stable
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with excl as (
    select array(select upper(btrim(c)) from unnest(coalesce(p_exclude_product_codes, '{}'::text[])) c) as codes
  ),
  req as (
    select mr.id, mr.pay_date, greatest(coalesce(mr.roi_duration_months, 1), 1) as months,
           coalesce(mr.track_direct_sales, false) as track_direct_sales
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
      r.id::text as row_id,
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
  -- Phase D: approved Direct Order Request sales at this campaign's own target
  -- pharmacies (shared distributor + customer code) for its own products.
  -- The distributor hop goes marketing_distributors -> marketing_roi_distributor_rollup ->
  -- source_of_sales_distributors, mirroring req_targets above, because
  -- marketing_distributors.distributor_code is a synthetic surrogate that shares no values with
  -- the real SoS codes stored on direct_order_pharmacy_distributor_codes. Matching those two
  -- columns directly is what made this branch unreachable; see the header of this migration.
  direct_hits as (
    select distinct
      mrph.request_id,
      dor.id::text as row_id,
      coalesce(dor.qty, 0)::numeric as units,
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
  ),
  actuals as (
    select
      request_id,
      coalesce(sum(value), 0)::numeric as actual_value,
      coalesce(sum(units), 0)::numeric as actual_units,
      count(distinct row_id)::integer as sales_rows
    from (
      select request_id, row_id, units, value from exact_hits
      union all
      select request_id, row_id, units, value from direct_hits
    ) h
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

notify pgrst, 'reload schema';

commit;
