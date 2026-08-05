-- Monthly Closing — Channel by Product / Rep / Area / Brick, for ONE month.
--
-- The companion to phx_closing_channel_totals (20260805230000). That one answers "how did the three
-- channels move month by month"; this one cuts the EXPORTED month four ways so a reader can see
-- which products, reps, areas and bricks the store or hospital money actually sits in.
--
-- SAME MONEY, SAME RULES as the month-by-month sheet, and that is the point: every grid this
-- returns must sum to the same month total the Closing Matrix publishes. Specifically it keeps
--   * the closing's value formula (distributor rows re-priced at factory price, direct rows at the
--     direct value the sheet stated),
--   * the RAW distributor-sent customer name (the mapped name is blank for ~25% of customers), and
--   * direct orders classified by their OWN customer name rather than lumped into pharmacies.
--
-- NOTHING IS EVER DROPPED. A row that cannot be attributed gets a visible bucket instead:
--   __DIRECT__     direct orders carry no area and no brick at all, so they cannot appear in the
--                  Area or Brick grid under a real place. They get their own labelled row there.
--   __NO_BRICK__   distributor rows whose brick did not map (10 of 1,483 on Anti Infective 2026-07).
--   __NO_SEAT__    an area that is not on the AU seat model, so no rep owns it (~15% of value).
--   __VACANT__:id  a seat that exists but has no current occupant (~12% of value).
-- A grid that quietly sums to less than the month is exactly what gets questioned, so the buckets
-- are rows, never omissions.
--
-- The keyword vocabulary and the confidential-product list are PARAMETERS for the same reason as
-- everywhere else: src/lib/sales/customer-channel.ts and src/lib/sales/access-scope.ts are their
-- single sources, and a second copy in SQL would break that promise the first time one was edited.
--
-- Returns jsonb rather than a table: bricks alone run to hundreds of rows per line and PostgREST
-- caps a table-returning RPC at 1000 rows per page, which would re-execute this whole query per
-- page. One aggregation, one round trip — the same shape phx_customer_directory_json uses.

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
  -- Distributor sell-out, at the closing's own value formula.
  retail as (
    select
      upper(btrim(coalesce(f.product_code, ''))) as product_code,
      nullif(btrim(coalesce(f.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(f.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '')     as brick_id,
      coalesce(n.client_name, '')                     as client_name,
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
      and f.client_code is not null
      and upper(btrim(coalesce(f.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
  ),
  -- Direct orders. They carry no client_code, so the fact rollup cannot name them; the import rows
  -- are the only place the customer survives. Their `value` IS the direct_value the rollup
  -- aggregates. They carry no area and no brick either — hence the __DIRECT__ buckets below.
  direct as (
    select
      upper(btrim(coalesce(r.product_code, ''))) as product_code,
      nullif(btrim(coalesce(r.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(r.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(r.brick_id, '')), '')     as brick_id,
      btrim(coalesce(r.client_name, ''))              as client_name,
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
      coalesce(sum(k.value), 0)                                          as total
    from keyed k
    group by k.dimension, k.key
    order by k.dimension, 7 desc
  ) g;
$function$;

comment on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[]) is
  'Monthly Closing: the hospital/store/pharmacy split of ONE month cut by product, rep, area and '
  'brick. Unattributable money gets a visible bucket row (__DIRECT__ / __NO_BRICK__ / __NO_SEAT__ / '
  '__VACANT__:seat) so every grid sums to the published month total. Channel vocabulary and the '
  'confidential-product list are parameters — customer-channel.ts and access-scope.ts own them.';

revoke execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[]) to service_role;
