-- Channels by Rep, on the shared channel rule.
--
-- Split from 20260907170000_one_channel_rule_in_sql.sql so each migration matches one ledger entry:
-- that one defines the rule, this one moves the first caller onto it.
--
-- The signature gains `p_rule`, so this DROPs and re-CREATEs rather than CREATE OR REPLACE — which
-- would leave the old six-argument function in place as an overload and make every named-argument
-- call ambiguous. Grants are restored explicitly: dropping loses them.
--
-- An empty payload rebuilds the pre-2026-09-07 rule from the array parameters and answers exactly
-- as this function did before. That is not decoration: a migration lands on production before the
-- deploy that uses it, and for that window the running app still calls with arrays only. Measured
-- on production for 2026-08 immediately after this applied — arrays only, no payload: store
-- 491,013.16 EGP, identical to the reading taken before the change.

drop function if exists public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[]);

create function public.phx_sales_channels_by_rep(
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
    -- An empty payload is the deploy window: the app is still calling with arrays only, so rebuild
    -- the pre-2026-09-07 rule from them and answer exactly as this function did yesterday.
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
    select r.client_code,
           r.distributor_code,
           r.area_code,
           r.official_line,
           r.invoice_period,
           r.client_name,
           coalesce(r.value, 0) as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
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
  'Sales value per rep split into hospital / store / pharmacy. Classification is delegated to phx_customer_channel so this tab cannot drift from customer-channel.ts again.';

revoke execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb)
  from public, anon, authenticated;
grant execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[], jsonb)
  to service_role;
