-- phx_sales_channels_by_rep_reads_the_period_price
--
-- WHAT THIS CHANGES: `public.phx_sales_channels_by_rep` now takes its factory price from
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

create or replace function public.phx_sales_channels_by_rep(p_store_stems text[], p_hospital_stems text[], p_excluded_product_codes text[], p_period text DEFAULT NULL::text, p_store_override_keys text[] DEFAULT '{}'::text[], p_pharmacy_override_codes text[] DEFAULT '{}'::text[], p_rule jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(seat_id text, rep_hr_id text, rep_name text, line_code text, area_code text, area_name text, hospital_value numeric, store_value numeric, pharmacy_value numeric, total_value numeric, hospital_customers bigint, store_customers bigint, pharmacy_customers bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'au'
 SET statement_timeout TO '60s'
AS $function$
  with rule as (
    select case
             when p_rule is null or p_rule = '{}'::jsonb then jsonb_build_object(
               'hospitalStems', to_jsonb(coalesce(p_hospital_stems, '{}'::text[])),
               'storeStems', to_jsonb(coalesce(p_store_stems, '{}'::text[])),
               'pharmacyOverrideCodes', to_jsonb(coalesce(p_pharmacy_override_codes, '{}'::text[])),
               'storeOverrideKeys', to_jsonb(coalesce(p_store_override_keys, '{}'::text[]))
             )
             else p_rule
           end as payload
  ),
  rows_in_scope as (
    -- The closing's value: a distributor row is its paid units x factory price, and a direct order
    -- keeps its own order value. The sheet's typed value is never read for a distributor row.
    select r.client_code,
           r.distributor_code,
           r.area_code,
           r.official_line,
           r.invoice_period,
           r.client_name,
           case
             when coalesce(r.is_direct, false) then coalesce(r.value, 0)
             else coalesce(r.qty, 0) * coalesce(public.phx_factory_price(r.product_code, r.invoice_period), 0)
           end as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (p_period is null or r.invoice_period = p_period)
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(code))
            from unnest(coalesce(p_excluded_product_codes, '{}')) code)
  ),
  tagged as (
    select t.client_code,
           t.distributor_code,
           t.area_code,
           t.official_line,
           t.value,
           public.phx_customer_channel(
             t.client_name, t.client_code, t.distributor_code,
             t.invoice_period, t.official_line, rule.payload
           ) as channel
    from rows_in_scope t
    cross join rule
  ),
  seated as (
    select t.channel,
           t.value,
           t.client_code,
           t.distributor_code,
           s.seat_id,
           s.line_code,
           s.area_code as seat_area_code
    from tagged t
    left join au.sos_area_crosswalk x
      on x.sos_area_code = t.area_code and x.effective_to is null
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(t.official_line))
    left join au.seats s
      on s.area_code = x.canonical_area_code
     and s.line_code = lm.line_code
     and s.seat_tier = 'REP'
     and s.is_active
  ),
  repped as (
    select sd.*, oh.occupant_hr_id
    from seated sd
    left join au.occupancy_history oh
      on oh.seat_id = sd.seat_id and oh.effective_to is null
  )
  select
    rp.seat_id::text                                                             as seat_id,
    rp.occupant_hr_id::text                                                      as rep_hr_id,
    e.full_name::text                                                            as rep_name,
    rp.line_code::text                                                           as line_code,
    rp.seat_area_code::text                                                      as area_code,
    ca.area_name::text                                                           as area_name,
    coalesce(sum(rp.value) filter (where rp.channel = 'hospital'), 0)            as hospital_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'store'), 0)               as store_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'pharmacy'), 0)            as pharmacy_value,
    coalesce(sum(rp.value), 0)                                                   as total_value,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'hospital')                                     as hospital_customers,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'store')                                        as store_customers,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'pharmacy')                                     as pharmacy_customers
  from repped rp
  left join public.employees e on e.hr_id = rp.occupant_hr_id
  left join au.canonical_areas ca on ca.area_code = rp.seat_area_code
  group by 1, 2, 3, 4, 5, 6
  order by 10 desc;
$function$;

revoke execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb) from public, anon, authenticated;
grant execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb) to service_role;

commit;
