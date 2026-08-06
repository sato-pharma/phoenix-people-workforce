-- Monthly Closing — the channel sheets were dropping every sale that has no client code.
--
-- Both channel RPCs filtered `f.client_code is not null` on their retail CTE, inherited from
-- phx_closing_customers where the filter is correct (that function's whole purpose is to list
-- CUSTOMERS, and a row with no customer cannot be one of them). Here it is wrong: these sheets
-- report MONEY, the Closing Matrix counts that money, and the Data sheet prints it. A missing
-- client code is a data-quality flag in this module, never an exclusion — monthly-closing-details.ts
-- says so in its header and proves it (adding a client-code filter there understated CNS by 11,205
-- units), and the Data sheet lists those rows with In Closing = "Yes".
--
-- So the channel sheets quietly summed to less than the month beside them. Measured on production
-- 2026-08-06, retail value the channel sheets could not see:
--
--   CNS 2026-05   4,363,635.38 EGP of 8,354,429.79   (52% of the month)
--   CNS 2026-02   4,091,645.37 EGP of 8,514,910.94
--   CNS 2026-03   2,112,250.86 EGP of 6,168,996.99
--   CNS 2026-01   1,352,367.37 EGP of 5,653,799.98
--   CNS 2026-04     924,966.00 EGP of 6,677,084.96
--   CNS 2026-06     400,219.65 EGP of 4,109,041.65
--
-- Anti Infective, Pedia and Head Office are clean in every 2026 month, which is exactly why the
-- defect survived review: the workbook it was verified against could not show it. Nearly all of the
-- missing rows are the CNS "Office" distributor, which sends no client code at all.
--
-- THE FIX IS NOT TO LET THEM FALL INTO PHARMACIES. With no client code there is no name, and the
-- channel CASE ends in `else 'pharmacy'` — so simply deleting the filter would have moved 4.36M EGP
-- into Pharmacies and reported it as fact. This module's own rule (see the header of
-- 20260806100000_closing_channel_breakdown.sql: "NOTHING IS EVER DROPPED ... a row that cannot be
-- attributed gets a visible bucket instead") is the right answer, and it is applied here: rows with
-- no customer identity get their own channel, `unidentified`, so the sheet adds up to the month AND
-- says plainly which part of it nobody can attribute.
--
-- Customers are NOT invented for those rows. `client_key` stays null and count(distinct) ignores
-- nulls, so the bucket reports its money and units with a customer count of 0 — honest, rather than
-- one fictional mega-customer or thousands of fictional small ones.
--
-- Verified read-only against production before writing this migration: with these two changes,
-- CNS 2026-05 totals 8,354,429.79 and CNS 2026-02 totals 8,514,910.94 — equal to the Data sheet to
-- the pound — and CNS 2026-07, which has no identity-less rows, emits no bucket row at all.

-- ── phx_closing_channel_totals ───────────────────────────────────────────────
create or replace function public.phx_closing_channel_totals(
  p_line text,
  p_periods text[],
  p_store_stems text[],
  p_hospital_stems text[],
  p_exclude_codes text[] default array['LA003', 'LA004', 'SS001']
)
returns table (
  period text,
  channel text,
  customers bigint,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
  with
  -- The name the distributor actually sent, newest wins — the same rule phx_customer_directory
  -- uses. Not narrowed by product: a customer's name does not depend on what it bought.
  names as (
    select distinct on (d.period, d.distributor_code, d.client_code)
      d.period, d.distributor_code, d.client_code, d.client_name
    from public.source_of_sales_customer_directory_rollup d
    where d.period = any(p_periods)
      and lower(btrim(d.official_line)) = lower(btrim(p_line))
    order by d.period, d.distributor_code, d.client_code, d.latest_row_created_at desc
  ),
  -- Distributor sell-out. Same source, same guards and the SAME value formula as
  -- phx_closing_customers. NO client-code filter: this sheet reports the month's money, and a row
  -- with no client code is money the closing counts (see the header).
  retail as (
    select
      f.period,
      f.client_code                                   as client_key,
      coalesce(n.client_name, '')                     as client_name,
      sum(f.total_qty)                                as units,
      sum(f.effective_units * coalesce(p.factory_price, 0)) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join names n
      on n.period = f.period
     and n.distributor_code = f.distributor_code
     and n.client_code = f.client_code
    where f.period = any(p_periods)
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and not coalesce(f.is_direct, false)
      and upper(btrim(coalesce(f.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
    group by f.period, f.client_code, coalesce(n.client_name, '')
  ),
  -- Direct orders. They carry no client_code at all, so the fact rollup cannot name them and the
  -- import rows are the only place the customer survives. Their `value` IS the direct_value the
  -- rollup aggregates (verified equal to phx_monthly_closing_direct on all seven 2026 months of
  -- Anti Infective), so this stays the published closing money, not a re-derivation.
  direct as (
    select
      r.invoice_period          as period,
      -- No code exists, so the customer IS its name for counting purposes. A direct order with no
      -- name at all collapses into one "unnamed" bucket rather than inflating the customer count.
      'name:' || public.phx_fold_customer_name(r.client_name) as client_key,
      btrim(coalesce(r.client_name, '')) as client_name,
      sum(r.qty)                as units,
      sum(r.value)              as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where r.invoice_period = any(p_periods)
      and lower(btrim(r.official_line)) = lower(btrim(p_line))
      and coalesce(r.is_direct, false)
      and r.validation_state = 'valid'
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
    group by r.invoice_period, 2, 3
  ),
  tagged as (
    select
      u.period,
      u.client_key,
      u.units,
      u.value,
      case
        -- FIRST, before any name test: a row with no client code has no name to test, and the
        -- final `else` would silently call it a pharmacy. Direct rows never reach this branch —
        -- their key is 'name:...', never null.
        when u.client_key is null then 'unidentified'
        -- Hospital wins the overlap, matching classifyCustomerChannel(): a name carrying both a
        -- hospital word and a store word is the hospital that identifies the customer.
        when exists (
          select 1 from unnest(coalesce(p_hospital_stems, '{}'::text[])) s
          where s <> '' and public.phx_fold_customer_name(u.client_name) like '%' || s || '%'
        ) then 'hospital'
        when exists (
          select 1 from unnest(coalesce(p_store_stems, '{}'::text[])) s
          where s <> '' and public.phx_fold_customer_name(u.client_name) like '%' || s || '%'
        ) then 'store'
        else 'pharmacy'
      end as channel
    from (select * from retail union all select * from direct) u
  )
  select
    t.period,
    t.channel,
    -- DISTINCT customer, never a row count: retail rows are one per customer-per-distributor, so
    -- counting rows would report a pharmacy buying from three distributors as three pharmacies.
    -- The unidentified bucket's key is null, which count(distinct) ignores — it reports 0
    -- customers rather than inventing any.
    count(distinct t.client_key) as customers,
    sum(t.units)                 as units,
    sum(t.value)                 as value
  from tagged t
  group by t.period, t.channel;
$function$;

comment on function public.phx_closing_channel_totals(text, text[], text[], text[], text[]) is
  'Monthly Closing Channel Comparison: hospital/store/pharmacy units, value and distinct customers '
  'per period for one line, plus an `unidentified` bucket for rows carrying no client code so the '
  'sheet always sums to the month the Closing Matrix publishes. Channel vocabulary and the '
  'confidential-product list are parameters — src/lib/sales/customer-channel.ts and '
  'src/lib/sales/access-scope.ts remain their single sources.';

revoke execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[]) to service_role;

-- ── phx_closing_channel_breakdown ────────────────────────────────────────────
create or replace function public.phx_closing_channel_breakdown(
  p_line text,
  p_period text,
  p_store_stems text[],
  p_hospital_stems text[],
  p_exclude_codes text[] default array['LA003', 'LA004', 'SS001']
)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'au'
set statement_timeout to '60s'
as $function$
  with
  -- The name the distributor actually sent, newest wins — same rule as phx_customer_directory.
  names as (
    select distinct on (d.distributor_code, d.client_code)
      d.distributor_code, d.client_code, d.client_name
    from public.source_of_sales_customer_directory_rollup d
    where d.period = p_period
      and lower(btrim(d.official_line)) = lower(btrim(p_line))
    order by d.distributor_code, d.client_code, d.latest_row_created_at desc
  ),
  -- Distributor sell-out, at the closing's own value formula. NO client-code filter — see header.
  retail as (
    select
      upper(btrim(coalesce(f.product_code, ''))) as product_code,
      nullif(btrim(coalesce(f.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(f.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '')     as brick_id,
      coalesce(n.client_name, '')                     as client_name,
      -- Whether this row can be attributed to a customer at all. False only when the distributor
      -- sent no client code, in which case there is no name and no channel can be inferred.
      (f.client_code is not null)                     as has_customer_identity,
      false                                           as is_direct,
      f.effective_units * coalesce(p.factory_price, 0) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join names n
      on n.distributor_code = f.distributor_code
     and n.client_code = f.client_code
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and not coalesce(f.is_direct, false)
      and upper(btrim(coalesce(f.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
  ),
  -- Direct orders. They carry no client_code, so the fact rollup cannot name them; the import rows
  -- are the only place the customer survives. Their `value` IS the direct_value the rollup
  -- aggregates. They carry no area and no brick either — hence the __DIRECT__ buckets below.
  -- Their identity is their NAME, so they are classified normally, exactly as before.
  direct as (
    select
      upper(btrim(coalesce(r.product_code, ''))) as product_code,
      nullif(btrim(coalesce(r.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(r.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(r.brick_id, '')), '')     as brick_id,
      btrim(coalesce(r.client_name, ''))              as client_name,
      true                                            as has_customer_identity,
      true                                            as is_direct,
      r.value                                         as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where r.invoice_period = p_period
      and lower(btrim(r.official_line)) = lower(btrim(p_line))
      and coalesce(r.is_direct, false)
      and r.validation_state = 'valid'
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
  ),
  tagged as (
    select
      u.*,
      case
        -- FIRST: no client code means no name, and the final `else` would call it a pharmacy.
        when not u.has_customer_identity then 'unidentified'
        -- Hospital wins the overlap, matching classifyCustomerChannel().
        when exists (
          select 1 from unnest(coalesce(p_hospital_stems, '{}'::text[])) s
          where s <> '' and public.phx_fold_customer_name(u.client_name) like '%' || s || '%'
        ) then 'hospital'
        when exists (
          select 1 from unnest(coalesce(p_store_stems, '{}'::text[])) s
          where s <> '' and public.phx_fold_customer_name(u.client_name) like '%' || s || '%'
        ) then 'store'
        else 'pharmacy'
      end as channel
    from (select * from retail union all select * from direct) u
  ),
  -- Rep attribution: sales area -> canonical area -> the line's active REP seat -> its current
  -- occupant. Every join is a LEFT join on purpose — a sale whose area is not on the seat model, or
  -- whose seat nobody occupies today, must still appear rather than vanishing. All four joins were
  -- verified to have no duplicate key, so none of them can fan out and double the money.
  seated as (
    select
      t.*,
      s.seat_id,
      ca.area_name as seat_area_name,
      oh.occupant_hr_id
    from tagged t
    left join au.sos_area_crosswalk x
      on x.sos_area_code = t.area_code and x.effective_to is null
    left join au.sos_official_line_map lm
      on lower(btrim(lm.official_line)) = lower(btrim(p_line))
    left join au.seats s
      on s.area_code = x.canonical_area_code
     and s.line_code = lm.line_code
     and s.seat_tier = 'REP'
     and s.is_active
    left join au.occupancy_history oh
      on oh.seat_id = s.seat_id and oh.effective_to is null
    left join au.canonical_areas ca
      on ca.area_code = s.area_code
  ),
  -- One long table of (dimension, key, label) so the four grids share one aggregation.
  keyed as (
    select 'product' as dimension,
           coalesce(nullif(sd.product_code, ''), '__NO_PRODUCT__') as key,
           coalesce(sd.product_name, '')                           as label,
           sd.channel, sd.value
    from seated sd
    union all
    select 'area',
           case when sd.is_direct then '__DIRECT__' else coalesce(sd.area_code, '__NO_AREA__') end,
           '',
           sd.channel, sd.value
    from seated sd
    union all
    select 'brick',
           case when sd.is_direct then '__DIRECT__'
                when sd.brick_id is null then '__NO_BRICK__'
                else sd.brick_id end,
           '',
           sd.channel, sd.value
    from seated sd
    union all
    select 'rep',
           case when sd.is_direct then '__DIRECT__'
                when sd.occupant_hr_id is not null then sd.occupant_hr_id::text
                when sd.seat_id is not null then '__VACANT__:' || sd.seat_id::text
                else '__NO_SEAT__' end,
           case when sd.is_direct then ''
                when sd.occupant_hr_id is not null then coalesce(e.full_name, '')
                when sd.seat_id is not null then coalesce(sd.seat_area_name, '')
                else '' end,
           sd.channel, sd.value
    from seated sd
    left join public.employees e on e.hr_id = sd.occupant_hr_id
  )
  select coalesce(jsonb_agg(row_to_json(g)), '[]'::jsonb)
  from (
    select
      k.dimension,
      k.key,
      -- max() rather than an extra group-by column: a key always carries one label, and a stray
      -- blank must never split a row in two.
      coalesce(max(nullif(k.label, '')), '')                              as label,
      coalesce(sum(k.value) filter (where k.channel = 'hospital'), 0)     as hospital,
      coalesce(sum(k.value) filter (where k.channel = 'store'), 0)        as store,
      coalesce(sum(k.value) filter (where k.channel = 'pharmacy'), 0)     as pharmacy,
      -- Money whose row carries no client code. Its own column so hospital + store + pharmacy +
      -- unidentified = total stays true, instead of `total` quietly exceeding the three columns.
      coalesce(sum(k.value) filter (where k.channel = 'unidentified'), 0) as unidentified,
      coalesce(sum(k.value), 0)                                          as total
    from keyed k
    group by k.dimension, k.key
    -- Position 8, not 7: `total` moved one right when `unidentified` was inserted above it.
    order by k.dimension, 8 desc
  ) g;
$function$;

comment on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[]) is
  'Monthly Closing: the hospital/store/pharmacy split of ONE month cut by product, rep, area and '
  'brick, plus an `unidentified` column for rows carrying no client code. Unattributable money gets '
  'a visible bucket row (__DIRECT__ / __NO_BRICK__ / __NO_SEAT__ / __VACANT__:seat) so every grid '
  'sums to the published month total. Channel vocabulary and the confidential-product list are '
  'parameters — customer-channel.ts and access-scope.ts own them.';

revoke execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[]) to service_role;
