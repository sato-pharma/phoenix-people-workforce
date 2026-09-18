-- channels_by_rep_values_like_the_closing
--
-- WHAT THIS CHANGES: phx_sales_channels_by_rep values each sale the way the monthly closing does.
--   A distributor row is worth its paid units x the product's factory price. A direct-order row keeps
--   its own order value. Before this, every row was worth the `value` column the distributor typed
--   into its own sheet. The body is otherwise the live one, byte for byte: the channel rule, the seat
--   chain, the restricted-product strip and the per-channel customer counts are untouched.
--
-- WHY: owner decision 2026-09-18, "make Channels by Rep use the closing's value", on top of his rule
--   of 2026-09-07 that a distributor sheet's value and bonus are neglected: "we take the units and
--   multiply by factory". The closing already reads it that way (phx_closing_distributor_product:
--   units x factory_price; phx_monthly_closing_direct: the direct order's own value). Channels by Rep
--   was the one surface left on the sheet's typed value. Source of Sales audit, finding
--   `src/lib/sales/channels-by-rep.ts:178` (high), still open on the 2026-09-06 re-measure.
--
--   Measured on production 2026-09-18, restricted products stripped, before this applied:
--     El Qema, Pedia, 2026-08, 8,768 paid units: the closing 2,367,360.00 EGP, this tab 1,888,898.40.
--     Their sheet carries the invoice at 79.8% of list.
--     All months: the tab moves +656,488.87 EGP in total, +478,370.20 of it in 2026-08 and
--     +178,228.19 in 2026-04 (RM's discount column). Every other month moves by under 1,500 EGP.
--     Direct orders move by nothing: 8,666,034.70 EGP before and after.
--
--   Bonus is not counted, before or after. `qty` holds paid units only: the importer never reads a
--   sheet's paid+free total, skips a whole-line bonus row, and keeps free units in `bonus_qty`. No
--   distributor row on production has ever stored a bonus unit. The only bonus units stored (267 in
--   2026-08, 54 in 2026-09) sit on direct-order rows, which keep their own order value here.
--
--   The factory-price join cannot fan out: source_of_sales_products has product_code as its primary
--   key, and its 30 codes stay distinct upper-cased and trimmed.
--
-- ROLLBACK: re-apply the body from 20260907170500_channels_by_rep_on_the_shared_channel_rule.sql,
--   where `rows_in_scope` selects `coalesce(r.value, 0) as value` and has no join to
--   source_of_sales_products. No stored row is written by either version, so there is nothing else
--   to undo.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one function body is replaced and no row is written.

begin;

-- Same signature, so CREATE OR REPLACE keeps the function in place and callers keep working.
create or replace function public.phx_sales_channels_by_rep(
  p_store_stems text[],
  p_hospital_stems text[],
  p_excluded_product_codes text[],
  p_period text default null::text,
  p_store_override_keys text[] default '{}'::text[],
  p_pharmacy_override_codes text[] default '{}'::text[],
  p_rule jsonb default '{}'::jsonb
)
returns table(
  seat_id text, rep_hr_id text, rep_name text, line_code text, area_code text, area_name text,
  hospital_value numeric, store_value numeric, pharmacy_value numeric, total_value numeric,
  hospital_customers bigint, store_customers bigint, pharmacy_customers bigint
)
language sql
stable
security definer
set search_path to 'public', 'au'
set statement_timeout to '60s'
as $function$
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
             else coalesce(r.qty, 0) * coalesce(p.factory_price, 0)
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

comment on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb) is
  'Sales value per rep split into hospital / store / pharmacy, valued as the monthly closing values it: paid units x factory price for a distributor row, the order''s own value for a direct order. Classification is delegated to phx_customer_channel so this tab cannot drift from customer-channel.ts again.';

revoke execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb)
  from public, anon, authenticated;
grant execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb)
  to service_role;

commit;
