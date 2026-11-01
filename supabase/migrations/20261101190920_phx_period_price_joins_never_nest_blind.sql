-- phx_period_price_joins_never_nest_blind
--
-- WHAT THIS CHANGES: two functions, for speed only. public.phx_market_awareness_tracking gains
-- `set enable_nestloop to 'off'`, its body unchanged. public.phx_sales_channels_by_rep joins its price
-- lookup on one concatenated (product, period) key instead of two `is not distinct from`, and tests
-- its excluded codes through array( … ). No filter, select list, signature, grant or row is touched.
--
-- WHY. 20261101142535 found phx_customer_directory walking its whole price list per row, because a
-- SQL function is planned with its parameters unknown. These are the two of the other 14 functions
-- with a `period_price` CTE where the plan they really get wastes that work. Staging, 2026-11-01:
--
-- * Market awareness gets a Nested Loop Left Join over an unmaterialised price subquery, so
--   phx_factory_price runs again for each outer row. One product over two months: 2,270 ms and
--   57,200 rows removed, against 279 ms with nested loops off. The widest call fixed: 2,054 ms.
--   🔴 The widest ANALYZE of the unfixed plan began 2 min 23 s before an unclean staging restart.
--   Very likely the cause, though memory as the mechanism is unproven. Never run it again.
-- * Channels by Rep cannot hash its join at all, because `is not distinct from` is not an equality
--   operator a hash join can use, so enable_nestloop does nothing for it. The pricing piece over the
--   whole history: 8,043 ms and 29,849,634 rows removed, against 2,365 ms on the pair key. The bare
--   sublink ran 47,769 times for 239 ms.
--   🔴 THIS DOES NOT MAKE THE TAB FAST. The whole function is 235 s against 226 s over the history
--   and 33.4 s against 32.2 s for a month. Its real cost is phx_customer_channel evaluated repeatedly
--   per row, which this does not touch.
--
-- The other 12 were measured and left alone. Corrections and area pharmacies get SLOWER with the
-- switch (2,530 to 5,652 ms, 216 to 633 ms), so it is not a blanket setting.
--
-- WHY THE ANSWER IS UNCHANGED. A join method cannot change a join's result. The pair key could only
-- differ on a NULL or a "|" in either column, and both environments hold 0 of each across 317,806
-- rows on staging and 415,376 on production. `array( … )` over an empty list is empty, not NULL, so
-- a caller excluding nothing keeps every row. Old against new, staging, as text through EXCEPT ALL
-- in both directions:
-- * Market awareness: 84 calls, every product of Anti Infective, CNS and Pedia across 2-month
--   windows, 396 rows, 0 differences. The widest new call equals the sum of the narrow old results
--   on all three lines, 66 rows, 0 differences.
-- * Channels by Rep, 111 rows for a month with the confidential three excluded, with an empty list
--   and with a NULL list, 112 rows for the whole history: 0 differences.
-- A published month is not changed: neither function writes.
--
-- ROLLBACK: re-run the definitions in 20261023170800_phx_market_awareness_tracking_prices_each_product_once.sql
-- and 20261023171100_phx_sales_channels_by_rep_prices_each_product_once.sql.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.phx_market_awareness_tracking(
  p_line_code text,
  p_from_period text,
  p_to_period text,
  p_area_code text,
  p_brick_ids text[],
  p_product_codes text[]
)
returns table(period text, scope text, indirect_units numeric, indirect_value numeric, direct_units numeric, direct_value numeric)
language sql
stable security definer
set search_path to 'public'
set statement_timeout to '45s'
set enable_nestloop to 'off'
as $function$
  with period_price as (
    select d.product_code, d.period,
           public.phx_factory_price(d.product_code, d.period) as period_price
    from (
      select distinct f.product_code, f.period
      from public.source_of_sales_fact_rollup f
      where f.period between p_from_period and p_to_period
    ) d
  ),
  rows_in_window as (
    select
      f.period,
      f.area_code,
      f.brick_id,
      f.is_direct,
      f.total_qty,
      f.effective_units,
      f.direct_value,
      f.product_code
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    where f.period between p_from_period and p_to_period
      and lower(btrim(f.official_line)) in (
        select lower(btrim(m.official_line))
        from au.sos_official_line_map m
        where lower(btrim(m.line_code)) = lower(btrim(p_line_code))
      )
      and upper(btrim(f.product_code)) = any (
        select upper(btrim(code)) from unnest(p_product_codes) as code
      )
      and (
        not f.is_direct
        or upper(btrim(coalesce(f.product_code, ''))) not in ('LA003', 'LA004', 'SS001')
      )
      and not (f.is_direct and f.period = '2026-07')
  ),
  priced as (
    select
      r.*,
      r.effective_units * coalesce(pp.period_price, 0) as indirect_value
    from rows_in_window r
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    left join period_price pp
      on pp.product_code = r.product_code and pp.period = r.period
  ),
  scoped as (
    select 'brick'::text as scope, * from priced
     where brick_id = any (p_brick_ids)
    union all
    select 'area'::text, * from priced
     where btrim(area_code) = btrim(p_area_code)
    union all
    select 'area_bricked'::text, * from priced
     where btrim(area_code) = btrim(p_area_code)
       and brick_id is not null
       and btrim(brick_id) <> ''
  )
  select
    s.period,
    s.scope,
    coalesce(sum(s.total_qty)      filter (where not s.is_direct), 0) as indirect_units,
    coalesce(sum(s.indirect_value) filter (where not s.is_direct), 0) as indirect_value,
    coalesce(sum(s.total_qty)      filter (where s.is_direct), 0)     as direct_units,
    coalesce(sum(s.direct_value)   filter (where s.is_direct), 0)     as direct_value
  from scoped s
  group by s.period, s.scope;
$function$;

revoke execute on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_market_awareness_tracking(text, text, text, text, text[], text[]) to service_role;

create or replace function public.phx_sales_channels_by_rep(
  p_store_stems text[],
  p_hospital_stems text[],
  p_excluded_product_codes text[],
  p_period text default null::text,
  p_store_override_keys text[] default '{}'::text[],
  p_pharmacy_override_codes text[] default '{}'::text[],
  p_rule jsonb default '{}'::jsonb
)
returns table(seat_id text, rep_hr_id text, rep_name text, line_code text, area_code text, area_name text, hospital_value numeric, store_value numeric, pharmacy_value numeric, total_value numeric, hospital_customers bigint, store_customers bigint, pharmacy_customers bigint)
language sql
stable security definer
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
  period_price as (
    select d.product_code || '|' || d.invoice_period as pair,
           public.phx_factory_price(d.product_code, d.invoice_period) as period_price
    from (
      select distinct r.product_code, r.invoice_period
      from public.source_of_sales_import_rows r
      where (p_period is null or r.invoice_period = p_period)
    ) d
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
             else coalesce(r.qty, 0) * coalesce(pp.period_price, 0)
           end as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    left join period_price pp
      on pp.pair = r.product_code || '|' || r.invoice_period
    where (p_period is null or r.invoice_period = p_period)
      and upper(btrim(coalesce(r.product_code, ''))) <> all (array(
            select upper(btrim(code))
            from unnest(coalesce(p_excluded_product_codes, '{}')) code))
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
