-- Channel classification honours the owner's per-customer overrides.
--
-- WHY. On 2026-08-06 the owner reviewed all 22 store-classified Anti Infective customers and ruled
-- two of them pharmacies despite their names:
--   المتحدةشركة صيدليات عابدين فارما (421516)  — matched on فارم; صيدليات is in the name
--   مخزن الطرشوبى للادويه (0001577318)         — matched on مخزن, the keyword that looked safe
-- He also ruled the keyword list itself must stay exactly as it is, so the exceptions live in a
-- code-keyed list rather than in weakened words.
--
-- WHY A PARAMETER AND NOT A LITERAL. src/lib/sales/customer-channel.ts is the single edit point for
-- the channel rule; the TypeScript classifier and the store city split already read the list from
-- there. Hardcoding the codes here would give the ruling two homes, and the first edit to one of
-- them would silently make the workbook disagree with the Customers tab.
--
-- These functions are otherwise unchanged from 20260806160000 — only the signature and one CASE
-- branch differ.
--
-- WHY A DROP FIRST, when the rest of this file is `create or replace`. A function's identity in
-- Postgres is its name PLUS its input argument types, so adding a sixth parameter means `create or
-- replace` replaces NOTHING — it creates a second, overloaded function beside the five-argument one.
-- Two things then break, neither of them loudly:
--   1. A caller that supplies only the original five arguments now matches BOTH candidates, because
--      the sixth has a default, and the call fails with `function ... is not unique`.
--   2. The new function is created with a DEFAULT acl, and on a SECURITY DEFINER function that hands
--      EXECUTE to PUBLIC — which anon and authenticated inherit. The revoke at the foot of this file
--      would not have covered it, because it names the OLD five-argument signature. Production's acl
--      is {postgres, service_role} today; the overload would have opened a second door beside it.
-- Dropping the old identity first keeps exactly one function per name, and the revoke/grant below
-- now names the six-argument signature so the new function lands with the same acl as the old one.
drop function if exists public.phx_closing_channel_totals(text, text[], text[], text[], text[]);
drop function if exists public.phx_closing_channel_breakdown(text, text, text[], text[], text[]);

create or replace function public.phx_closing_channel_totals(
  p_line text,
  p_periods text[],
  p_store_stems text[],
  p_hospital_stems text[],
  p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text],
  -- Customers the owner has ruled are PHARMACIES despite a store word in their name.
  -- Passed in from PHARMACY_OVERRIDE_CLIENT_CODES in src/lib/sales/customer-channel.ts so the
  -- ruling has ONE home. Zero-padding is stripped on both sides: the same shop arrives as
  -- 421516 in one distributor's file and 0001577318 in another's.
  p_pharmacy_override_codes text[] default '{}'::text[]
)
returns table(period text, channel text, customers bigint, units numeric, value numeric)
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
  -- phx_closing_customers, so a channel total can never disagree with the closing beside it.
  --
  -- NO `client_code is not null` FILTER. A row without a client code is still money the closing
  -- published; it just has no customer to attribute it to. It is carried here and bucketed below.
  retail as (
    select
      f.period,
      -- The customer, for counting. NULL when the row carries no client code — count(distinct NULL)
      -- is 0, which is the honest answer to "how many customers is this", and the alternative
      -- (one synthetic customer per month) would be a number nobody could act on.
      f.client_code                                        as client_key,
      coalesce(n.client_name, '')                          as client_name,
      (f.client_code is null)                              as no_client_code,
      false                                                as is_direct,
      sum(f.total_qty)                                     as units,
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
  -- rollup aggregates, so this stays the published closing money, not a re-derivation.
  direct as (
    select
      r.invoice_period          as period,
      -- No code exists, so the customer IS its name for counting purposes. An order with NO name
      -- keys to NULL rather than to the string 'name:', which is what made every unnamed order in
      -- a month collapse into one confident, wrong "customer" filed under Pharmacies.
      case
        when btrim(coalesce(r.client_name, '')) = '' then null
        else 'name:' || public.phx_fold_customer_name(r.client_name)
      end                       as client_key,
      btrim(coalesce(r.client_name, '')) as client_name,
      false                     as no_client_code,
      true                      as is_direct,
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
        -- The three "this is not a channel" answers come FIRST. Each is checked before the name
        -- classifier, because the classifier's own fallback is "pharmacy" and a fallback is exactly
        -- what must never catch money whose customer is unknown.
        when u.is_direct and btrim(u.client_name) = '' then 'direct_unnamed'
        when u.no_client_code then 'unidentified_no_code'
        when btrim(u.client_name) = '' then 'unidentified_no_name'
        -- Hospital wins the overlap, matching classifyCustomerChannel(): a name carrying both a
        -- hospital word and a store word is the hospital that identifies the customer.
        when exists (
          select 1 from unnest(coalesce(p_hospital_stems, '{}'::text[])) s
          where s <> '' and public.phx_fold_customer_name(u.client_name) like '%' || s || '%'
        ) then 'hospital'
        -- The owner's ruling beats the keyword. Retail rows carry the client code as their
        -- client_key, so the comparison is against that; direct rows key on 'name:...' and can
        -- never collide with a code.
        when exists (
          select 1 from unnest(coalesce(p_pharmacy_override_codes, '{}'::text[])) c
          where c <> ''
            and ltrim(btrim(u.client_key), '0') = ltrim(btrim(c), '0')
        ) then 'pharmacy'
        when exists (
          select 1 from unnest(coalesce(p_store_stems, '{}'::text[])) s
          where s <> '' and public.phx_fold_customer_name(u.client_name) like '%' || s || '%'
        ) then 'store'
        else 'pharmacy'
      end as channel
    from (select * from retail union all select * from direct) u
  ),
  channels as (
    select
      t.period,
      t.channel,
      -- DISTINCT customer, never a row count: retail rows are one per customer-per-distributor, so
      -- counting rows would report a pharmacy buying from three distributors as three pharmacies.
      count(distinct t.client_key) as customers,
      sum(t.units)                 as units,
      sum(t.value)                 as value
    from tagged t
    group by t.period, t.channel
  ),
  -- ── The independent check ────────────────────────────────────────────────────────────────────
  -- Deliberately NOT `select sum(value) from channels`. That would prove only that addition works.
  -- These two re-read the same tables with the guards restated, so any future filter added to
  -- `retail` or `direct` shows up here as a difference the sheet prints in red.
  pop_retail as (
    select
      f.period,
      sum(f.total_qty)                                      as units,
      sum(f.effective_units * coalesce(p.factory_price, 0)) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    where f.period = any(p_periods)
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and not coalesce(f.is_direct, false)
      and upper(btrim(coalesce(f.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
    group by f.period
  ),
  pop_direct as (
    select
      r.invoice_period as period,
      sum(r.qty)       as units,
      sum(r.value)     as value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    where r.invoice_period = any(p_periods)
      and lower(btrim(r.official_line)) = lower(btrim(p_line))
      and coalesce(r.is_direct, false)
      and r.validation_state = 'valid'
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
    group by r.invoice_period
  ),
  population as (
    select
      coalesce(pr.period, pd.period)                    as period,
      coalesce(pr.units, 0) + coalesce(pd.units, 0)     as units,
      coalesce(pr.value, 0) + coalesce(pd.value, 0)     as value
    from pop_retail pr
    full outer join pop_direct pd on pd.period = pr.period
  )
  select c.period, c.channel, c.customers, c.units, c.value from channels c
  union all
  -- Not a channel and never displayed as one: the sheet reads it as the month's own population and
  -- checks itself against it. 0 customers because it is a money total, not a customer list.
  select p.period, '__population__'::text, 0::bigint, p.units, p.value from population p;
$function$;

create or replace function public.phx_closing_channel_breakdown(
  p_line text,
  p_period text,
  p_store_stems text[],
  p_hospital_stems text[],
  p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text],
  -- Customers the owner has ruled are PHARMACIES despite a store word in their name.
  -- Passed in from PHARMACY_OVERRIDE_CLIENT_CODES in src/lib/sales/customer-channel.ts so the
  -- ruling has ONE home. Zero-padding is stripped on both sides: the same shop arrives as
  -- 421516 in one distributor's file and 0001577318 in another's.
  p_pharmacy_override_codes text[] default '{}'::text[]
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
  -- Distributor sell-out, at the closing's own value formula. No `client_code is not null` filter —
  -- see the header: that filter is what made these grids sum to less than the Closing Matrix.
  retail as (
    select
      upper(btrim(coalesce(f.product_code, ''))) as product_code,
      nullif(btrim(coalesce(f.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(f.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '')     as brick_id,
      -- The key an owner override is matched on. This grid did not need the code before, because
      -- nothing here was ever keyed by customer — the override is the first rule that is.
      f.client_code                                   as client_key,
      coalesce(n.client_name, '')                     as client_name,
      (f.client_code is null)                         as no_client_code,
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
  -- are the only place the customer survives. They carry no area and no brick either — hence the
  -- __DIRECT__ buckets below.
  direct as (
    select
      upper(btrim(coalesce(r.product_code, ''))) as product_code,
      nullif(btrim(coalesce(r.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(r.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(r.brick_id, '')), '')     as brick_id,
      -- Direct orders carry no client code at all, so there is nothing for an override to match and
      -- this is null on purpose. It exists only so the union above it keeps one column list.
      null::text                                      as client_key,
      btrim(coalesce(r.client_name, ''))              as client_name,
      false                                           as no_client_code,
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
        -- The unattributable answers come first, ahead of the classifier whose fallback is
        -- `pharmacy`. See phx_closing_channel_totals for the money each one was hiding.
        when u.is_direct and btrim(u.client_name) = '' then 'direct_unnamed'
        when u.no_client_code then 'unidentified_no_code'
        when btrim(u.client_name) = '' then 'unidentified_no_name'
        -- Hospital wins the overlap, matching classifyCustomerChannel().
        when exists (
          select 1 from unnest(coalesce(p_hospital_stems, '{}'::text[])) s
          where s <> '' and public.phx_fold_customer_name(u.client_name) like '%' || s || '%'
        ) then 'hospital'
        -- The owner's ruling beats the keyword, on the same code and in the same position as
        -- phx_closing_channel_totals — the two must agree or the workbook's grids would disagree
        -- with its own channel totals. Direct rows carry a null client_key and never match.
        when exists (
          select 1 from unnest(coalesce(p_pharmacy_override_codes, '{}'::text[])) c
          where c <> ''
            and ltrim(btrim(u.client_key), '0') = ltrim(btrim(c), '0')
        ) then 'pharmacy'
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
  -- whose seat nobody occupies today, must still appear rather than vanishing.
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
  ),
  grids as (
    select
      k.dimension,
      k.key,
      -- max() rather than an extra group-by column: a key always carries one label, and a stray
      -- blank must never split a row in two.
      coalesce(max(nullif(k.label, '')), '')                                       as label,
      coalesce(sum(k.value) filter (where k.channel = 'hospital'), 0)              as hospital,
      coalesce(sum(k.value) filter (where k.channel = 'store'), 0)                 as store,
      coalesce(sum(k.value) filter (where k.channel = 'pharmacy'), 0)              as pharmacy,
      coalesce(sum(k.value) filter (where k.channel = 'unidentified_no_code'), 0)  as unidentified_no_code,
      coalesce(sum(k.value) filter (where k.channel = 'unidentified_no_name'), 0)  as unidentified_no_name,
      coalesce(sum(k.value) filter (where k.channel = 'direct_unnamed'), 0)        as direct_unnamed,
      -- The row's FULL total, every channel and every bucket. Deliberately not hospital+store+
      -- pharmacy: the app that reads this before the matching code is deployed shows `total`, and a
      -- complete month is the right thing for it to show.
      coalesce(sum(k.value), 0)                                                    as total
    from keyed k
    group by k.dimension, k.key
  ),
  -- WHICH REP OWNS EACH AREA — every area on the crosswalk, not only the ones that sold this month.
  -- An area can RECEIVE a share of a city's store sales while selling nothing itself, and it still
  -- has to reach a rep. Same four LEFT joins and the same key vocabulary as the rep grid above, so
  -- a key here always names a row there.
  area_reps as (
    select distinct
      x.sos_area_code as area_code,
      case when oh.occupant_hr_id is not null then oh.occupant_hr_id::text
           when s.seat_id is not null then '__VACANT__:' || s.seat_id::text
           else '__NO_SEAT__' end as rep_key,
      case when oh.occupant_hr_id is not null then coalesce(e.full_name, '')
           when s.seat_id is not null then coalesce(ca.area_name, '')
           else '' end as rep_label
    from au.sos_area_crosswalk x
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
    left join public.employees e on e.hr_id = oh.occupant_hr_id
    where x.effective_to is null
      and x.sos_area_code is not null
  ),
  -- WHICH AREA EACH BRICK'S STORE MONEY SITS IN. The city split moves a wholesaler's sell-in out of
  -- the area it was booked in; the brick it was booked on is no more the place it was consumed than
  -- the area was, so that money leaves the brick too. This says how much of it each brick holds.
  -- Direct rows are excluded: they carry no brick and no area and never take part in the split.
  -- Only non-zero store money is emitted, so this stays a short list.
  brick_area as (
    select
      case when sd.brick_id is null then '__NO_BRICK__' else sd.brick_id end as brick_key,
      coalesce(sd.area_code, '__NO_AREA__')                                  as area_key,
      sum(sd.value) filter (where sd.channel = 'store')                      as store
    from seated sd
    where not sd.is_direct
    group by 1, 2
    having coalesce(sum(sd.value) filter (where sd.channel = 'store'), 0) <> 0
  ),
  -- The same independent re-read as phx_closing_channel_totals, for this one month, so the
  -- breakdown sheet can check itself without trusting its own four grids to agree.
  population as (
    select
      (
        select coalesce(sum(f.effective_units * coalesce(p.factory_price, 0)), 0)
        from public.source_of_sales_fact_rollup f
        join public.source_of_sales_import_batches b
          on b.id = f.batch_id and b.status = 'validated'
        left join public.source_of_sales_products p
          on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
        where f.period = p_period
          and lower(btrim(f.official_line)) = lower(btrim(p_line))
          and not coalesce(f.is_direct, false)
          and upper(btrim(coalesce(f.product_code, ''))) <> all (
                select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
      )
      +
      (
        select coalesce(sum(r.value), 0)
        from public.source_of_sales_import_rows r
        join public.source_of_sales_import_batches b
          on b.id = r.batch_id and b.status = 'validated'
        where r.invoice_period = p_period
          and lower(btrim(r.official_line)) = lower(btrim(p_line))
          and coalesce(r.is_direct, false)
          and r.validation_state = 'valid'
          and upper(btrim(coalesce(r.product_code, ''))) <> all (
                select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
      ) as value
  ),
  -- One flat array, exactly as before, so a reader that only knows the four grid dimensions keeps
  -- working: it filters on `dimension` and never sees the rows below.
  emitted as (
    select g.dimension, g.key, g.label,
           g.hospital, g.store, g.pharmacy,
           g.unidentified_no_code, g.unidentified_no_name, g.direct_unnamed,
           g.total,
           null::text as rep_key,
           null::text as area_key
    from grids g
    union all
    select 'area_rep', a.area_code, a.rep_label,
           0, 0, 0, 0, 0, 0, 0,
           a.rep_key, null::text
    from area_reps a
    union all
    -- `store` carries the money and `area_key` says where it sits; `total` mirrors `store` so a
    -- reader that only knows the old fields still sees a self-consistent row.
    select 'brick_area', ba.brick_key, '',
           0, ba.store, 0, 0, 0, 0,
           ba.store,
           null::text, ba.area_key
    from brick_area ba
    union all
    select 'population', 'TOTAL', '',
           0, 0, 0, 0, 0, 0, p.value,
           null::text, null::text
    from population p
  )
  select coalesce(jsonb_agg(row_to_json(e) order by e.dimension, e.total desc, e.key), '[]'::jsonb)
  from emitted e;
$function$;

comment on function public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[]) is
  'Monthly Closing Channel Comparison: hospital/store/pharmacy units, value and distinct customers '
  'per period for one line, PLUS a named bucket for every row that reaches no customer (no client '
  'code / code with no name / unnamed direct order) and a __population__ row that re-adds the month '
  'from the source tables so the sheet can check itself. Channel vocabulary and the '
  'confidential-product list are parameters — src/lib/sales/customer-channel.ts and '
  'src/lib/sales/access-scope.ts remain their single sources.';

comment on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[]) is
  'Monthly Closing: the channel split of ONE month cut by product, rep, area and brick. '
  'Unattributable money gets a visible bucket row (__DIRECT__ / __NO_BRICK__ / __NO_SEAT__ / '
  '__VACANT__:seat) and money with no CUSTOMER gets its own column, so every grid sums to the '
  'published month total. Also emits area_rep (which seat owns each area) and brick_area (where each '
  'brick''s store money sits) for the store city split, and a population row for the sheet''s '
  'self-check. Channel vocabulary and the confidential-product list are parameters — '
  'customer-channel.ts and access-scope.ts own them.';

-- Both functions are SECURITY DEFINER and public, so EXECUTE has to be taken away from PUBLIC
-- itself: anon and authenticated inherit it through PUBLIC membership, and revoking only those two
-- is a no-op. Revoking PUBLIC on a default ACL also strips service_role, which is the role the app
-- actually calls with — hence the explicit re-grant. In 20260806160000 this pair was a no-op against
-- production, whose acl was already {postgres, service_role}. It is NOT a no-op here: the drop above
-- destroyed that acl, so these two functions are created fresh with the default one, which grants
-- EXECUTE to PUBLIC. These four lines are what puts the acl back — do not delete them as redundant.
revoke execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_closing_channel_totals(text, text[], text[], text[], text[], text[]) to service_role;

revoke execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[]) to service_role;
