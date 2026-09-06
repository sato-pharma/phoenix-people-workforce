-- Channels by Rep ignored the owner's PHARMACY rulings.
--
-- `classifyCustomerChannel()` (src/lib/sales/customer-channel.ts) resolves a customer's channel in
-- this order:
--
--   1. hospital keywords          -> hospital
--   2. PHARMACY override by code  -> pharmacy
--   3. store override by dist|code-> store
--   4. store keywords             -> store
--   5. otherwise                  -> pharmacy
--
-- `phx_sales_channels_by_rep` implemented 1, 3, 4 and 5 and had no parameter for 2 at all, so the
-- owner's per-customer pharmacy rulings of 2026-08-06 could not reach it. The Customer Directory
-- and the monthly-closing channel comparison both pass `p_pharmacy_override_codes`; this tab did
-- not exist in that conversation.
--
-- Measured on production before this change, the two overridden customers carried 578,248.77 EGP
-- that read as STORE here and PHARMACY on its sibling tabs:
--   مخزن الطرشوبى للادويه        (1577318, PS)        570,178.46
--   المتحدةشركة صيدليات عابدين فارما (421516, IS-S + IS)   8,070.31
--
-- The pharmacy override is keyed by CUSTOMER CODE ALONE (a pharmacy is a pharmacy at every
-- distributor), while the store override is keyed by distributor + code. Both compare on the digits
-- with leading zeros stripped, because codes arrive with distributor-specific padding.
--
-- The signature gains a parameter, so this DROPs and re-CREATEs rather than CREATE OR REPLACE —
-- which would have left the old five-argument function in place as an overload and made every
-- named-argument call ambiguous. Grants are restored explicitly: dropping loses them, and the
-- function is SECURITY DEFINER reached only through the service role.

drop function if exists public.phx_sales_channels_by_rep(text[], text[], text[], text, text[]);

create function public.phx_sales_channels_by_rep(
  p_store_stems text[],
  p_hospital_stems text[],
  p_excluded_product_codes text[],
  p_period text default null::text,
  p_store_override_keys text[] default '{}'::text[],
  p_pharmacy_override_codes text[] default '{}'::text[]
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
  with rows_in_scope as (
    select r.client_code,
           r.distributor_code,
           r.area_code,
           r.official_line,
           coalesce(r.value, 0) as value,
           public.phx_fold_customer_name(r.client_name) as folded_name
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where (p_period is null or r.invoice_period = p_period)
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(code))
            from unnest(coalesce(p_excluded_product_codes, '{}')) code)
  ),
  tagged as (
    select client_code,
           distributor_code,
           area_code,
           official_line,
           value,
           case
             -- Hospital wins the name overlap, exactly as classifyCustomerChannel() does.
             when exists (select 1 from unnest(p_hospital_stems) s
                          where s <> '' and folded_name like '%' || s || '%') then 'hospital'
             -- Owner PHARMACY rulings outrank both store tests, and are keyed by customer code
             -- alone: the same shop is a pharmacy whichever distributor sold to it.
             when exists (select 1 from unnest(coalesce(p_pharmacy_override_codes, '{}')) c
                          where ltrim(btrim(client_code), '0') =
                                ltrim(btrim(c), '0')) then 'pharmacy'
             -- Owner store rulings are keyed by distributor + normalized customer code. A code
             -- collision at another distributor therefore remains on its own keyword answer.
             when exists (select 1 from unnest(coalesce(p_store_override_keys, '{}')) k
                          where upper(btrim(distributor_code)) = upper(btrim(split_part(k, '|', 1)))
                            and ltrim(btrim(client_code), '0') =
                                ltrim(btrim(split_part(k, '|', 2)), '0')) then 'store'
             when exists (select 1 from unnest(p_store_stems) s
                          where s <> '' and folded_name like '%' || s || '%') then 'store'
             else 'pharmacy'
           end as channel
    from rows_in_scope
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
    coalesce(sum(rp.value) filter (where rp.channel = 'hospital'), 0)             as hospital_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'store'), 0)                as store_value,
    coalesce(sum(rp.value) filter (where rp.channel = 'pharmacy'), 0)             as pharmacy_value,
    coalesce(sum(rp.value), 0)                                                    as total_value,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'hospital')                                      as hospital_customers,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'store')                                         as store_customers,
    count(distinct concat_ws('|', rp.distributor_code, rp.client_code))
      filter (where rp.channel = 'pharmacy')                                      as pharmacy_customers
  from repped rp
  left join public.employees e on e.hr_id = rp.occupant_hr_id
  left join au.canonical_areas ca on ca.area_code = rp.seat_area_code
  group by 1, 2, 3, 4, 5, 6
  order by 10 desc;
$function$;

-- Dropping the function dropped its explicit grants with it, but CREATE FUNCTION grants EXECUTE to
-- PUBLIC by default — and anon/authenticated inherit EXECUTE through PUBLIC membership, so revoking
-- only those two is a no-op. Revoke PUBLIC first, which also strips service_role, then re-grant it
-- explicitly. Restores the pre-migration state: postgres=X/postgres, service_role=X/postgres.
revoke execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_sales_channels_by_rep(text[], text[], text[], text, text[], text[]) to service_role;
