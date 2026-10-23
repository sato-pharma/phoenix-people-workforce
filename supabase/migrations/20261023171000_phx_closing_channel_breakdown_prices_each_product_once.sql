-- phx_closing_channel_breakdown asks for each product's price ONCE, not once per rollup row — and
-- it was asking in TWO places, once for the grid and once for the population total.
-- SPEED ONLY — the answer is unchanged, and that was proven before this was written.
--
-- WHY. `public.phx_factory_price(code, period)` is SECURITY DEFINER and carries a `SET search_path`;
-- Postgres inlines a SQL function with NEITHER of those, so every mention in a row-level expression
-- is a real invocation with two correlated subqueries of its own. This function is what the
-- Monthly Closing's channel tab reads, and `retail` priced every non-direct fact row of the
-- line-month while `population` priced all of them a second time.
--
-- 🔴 DROPPING SECURITY DEFINER WOULD NOT HAVE DONE THIS. Measured on the sibling closing matrix on
-- 2026-10-23: the resolver's body written out inline — exactly what the planner substitutes when it
-- may inline a scalar SQL function — still showed `SubPlan 1` and `SubPlan 2` at one loop per row,
-- 1,193 ms against 2,278 ms, where hoisting gave 202 ms. Inlining leaves the correlated subqueries
-- where they are. Recorded independently on 2026-09-28 in tests/factory-price-resolved-once.test.ts.
--
-- WHY THE TWO BODIES ARE EQUIVALENT:
--
--   1. PRICE PER PRODUCT, NOT PER ROW. Both call sites sit under `f.period = p_period`, so the
--      resolver's second argument was already a constant across the whole call; the function is
--      STABLE, so within one call its value is a pure function of the product code. Resolving once
--      per DISTINCT code therefore gives every row the number it had before — and lets ONE lookup
--      serve both sites.
--   2. `period_price` IS A SUPERSET, WHICH IS SAFE. It holds the distinct product codes of the
--      whole period rather than of this line, so it may carry codes neither site asks for. A row
--      nothing joins to is never read.
--   3. THE LEFT JOIN CANNOT CHANGE MULTIPLICITY. `select distinct` makes it at most one row per
--      code, so each join adds exactly one row — which is why `keyed`, `grids`, `area_reps`,
--      `brick_area` and every `filter (where channel = …)` see the numbers they saw before.
--   4. THE NULL BRANCHES AGREE. `period` is NOT NULL on the fact rollup by column constraint. A
--      NULL product_code fails the equality join and falls to `coalesce(…, 0)` — which is what the
--      resolver itself returns for an unknown product.
--   5. THE DIRECT SIDE IS UNTOUCHED. `direct` and the second half of `population` read
--      `source_of_sales_import_rows.value` straight and never touched the resolver. 🔴 The
--      `p_period <> '2026-07'` area/brick floor is carried across verbatim: without it July's
--      manually-placed areas shrink the `__DIRECT__` bucket and break a published, LOCKED closing.
--   6. THE OUTPUT ORDER IS PINNED BY THE QUERY ITSELF — `jsonb_agg(row_to_json(e) order by
--      e.dimension, e.total desc, e.key)` — so the returned jsonb is byte-comparable, which is what
--      the proof below compares.
--
-- PROVEN IDENTICAL ON PRODUCTION, 2026-10-23, against the live function: five line x period pairs,
-- two of them inside the published 2026-07, the returned jsonb compared as TEXT in BOTH directions.
-- All five identical, 0 differences. The hoisting rule itself was proven over the WHOLE relation:
-- all 295,418 rows of `source_of_sales_fact_rollup`, 225 distinct (product_code, period) keys, 0
-- mismatches — which covers the Saginko override (SA001, 111.15 through 2026-09, 170.52 from
-- 2026-10) on every row carrying it, on both sides of the boundary.
--
-- A published month is never changed (owner, 2026-10-09). This is a closing screen's own read, so
-- the proof above is a text comparison run BEFORE this file was written, not a check run after.
--
-- ROLLBACK: re-apply
-- supabase/migrations/20260928190010_phx_closing_channel_breakdown_reads_the_period_price.sql,
-- which holds the previous body. Nothing is dropped, renamed or written here, no row is touched,
-- and `create or replace` keeps the existing ACL. This replaces one read-only function body and is
-- neither destructive nor bulk.

begin;

create or replace function public.phx_closing_channel_breakdown(p_line text, p_period text, p_store_stems text[], p_hospital_stems text[], p_exclude_codes text[] default array['LA003'::text, 'LA004'::text, 'SS001'::text], p_pharmacy_override_codes text[] default '{}'::text[], p_store_override_codes text[] default '{}'::text[], p_rule jsonb default '{}'::jsonb)
 returns jsonb
 language sql
 stable parallel safe security definer
 set search_path to 'public', 'au'
 set statement_timeout to '60s'
as $function$
  with
  period_price as (
    select d.product_code, public.phx_factory_price(d.product_code, p_period) as period_price
    from (
      select distinct f.product_code
      from public.source_of_sales_fact_rollup f
      where f.period = p_period
    ) d
  ),
  rule as (
    select case
             when p_rule is null or p_rule = '{}'::jsonb then jsonb_build_object(
               'hospitalStems', to_jsonb(coalesce(p_hospital_stems, '{}'::text[])),
               'storeStems', to_jsonb(coalesce(p_store_stems, '{}'::text[])),
               'pharmacyOverrideCodes', to_jsonb(coalesce(p_pharmacy_override_codes, '{}'::text[])),
               'storeOverrideKeys', to_jsonb(coalesce(p_store_override_codes, '{}'::text[]))
             )
             else p_rule
           end as payload
  ),
  names as (
    select r.distributor_code, r.client_code, r.client_name, r.folded_name
    from public.source_of_sales_channel_customer_rollup r
    where r.line_key = lower(btrim(p_line))
      and r.period = p_period
      and not r.is_direct
      and r.client_code is not null
  ),
  retail as (
    select
      upper(btrim(coalesce(f.product_code, ''))) as product_code,
      nullif(btrim(coalesce(f.product_name, '')), '') as product_name,
      nullif(btrim(coalesce(f.area_code, '')), '')    as area_code,
      nullif(btrim(coalesce(f.brick_id, '')), '')     as brick_id,
      f.client_code                                   as client_key,
      f.distributor_code                              as distributor_code,
      coalesce(n.client_name, '')                     as client_name,
      coalesce(n.folded_name, '')                     as folded_name,
      (f.client_code is null)                         as no_client_code,
      false                                           as is_direct,
      f.effective_units * coalesce(pp.period_price, 0) as value
    from public.source_of_sales_fact_rollup f
    join public.source_of_sales_import_batches b
      on b.id = f.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
    left join period_price pp
      on pp.product_code = f.product_code
    left join names n
      on n.distributor_code = f.distributor_code
     and n.client_code = f.client_code
    where f.period = p_period
      and lower(btrim(f.official_line)) = lower(btrim(p_line))
      and not coalesce(f.is_direct, false)
      and upper(btrim(coalesce(f.product_code, ''))) <> all (
            select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x)
  ),
  direct as (
    select
      upper(btrim(coalesce(r.product_code, ''))) as product_code,
      nullif(btrim(coalesce(r.product_name, '')), '') as product_name,
      case when p_period <> '2026-07'
           then nullif(btrim(coalesce(r.area_code, '')), '') end as area_code,
      case when p_period <> '2026-07'
           then nullif(btrim(coalesce(r.brick_id, '')), '') end  as brick_id,
      null::text                                      as client_key,
      null::text                                      as distributor_code,
      btrim(coalesce(r.client_name, ''))              as client_name,
      public.phx_fold_customer_name(btrim(coalesce(r.client_name, ''))) as folded_name,
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
        when u.is_direct and btrim(u.client_name) = '' then 'direct_unnamed'
        when u.no_client_code then 'unidentified_no_code'
        when btrim(u.client_name) = '' then 'unidentified_no_name'
        else public.phx_customer_channel(
               u.client_name, u.client_key, u.distributor_code, p_period, p_line, rule.payload)
      end as channel
    from (select * from retail union all select * from direct) u
    cross join rule
  ),
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
  keyed as (
    select 'product' as dimension,
           coalesce(nullif(sd.product_code, ''), '__NO_PRODUCT__') as key,
           coalesce(sd.product_name, '')                           as label,
           sd.channel, sd.value
    from seated sd
    union all
    select 'area',
           case when sd.area_code is not null then sd.area_code
                when sd.is_direct then '__DIRECT__'
                else '__NO_AREA__' end,
           '',
           sd.channel, sd.value
    from seated sd
    union all
    select 'brick',
           case when sd.brick_id is not null then sd.brick_id
                when sd.is_direct then '__DIRECT__'
                else '__NO_BRICK__' end,
           '',
           sd.channel, sd.value
    from seated sd
    union all
    select 'rep',
           case when sd.occupant_hr_id is not null then sd.occupant_hr_id::text
                when sd.seat_id is not null then '__VACANT__:' || sd.seat_id::text
                when sd.is_direct then '__DIRECT__'
                else '__NO_SEAT__' end,
           case when sd.occupant_hr_id is not null then coalesce(e.full_name, '')
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
      coalesce(max(nullif(k.label, '')), '')                                       as label,
      coalesce(sum(k.value) filter (where k.channel = 'hospital'), 0)              as hospital,
      coalesce(sum(k.value) filter (where k.channel = 'store'), 0)                 as store,
      coalesce(sum(k.value) filter (where k.channel = 'pharmacy'), 0)              as pharmacy,
      coalesce(sum(k.value) filter (where k.channel = 'unidentified_no_code'), 0)  as unidentified_no_code,
      coalesce(sum(k.value) filter (where k.channel = 'unidentified_no_name'), 0)  as unidentified_no_name,
      coalesce(sum(k.value) filter (where k.channel = 'direct_unnamed'), 0)        as direct_unnamed,
      coalesce(sum(k.value), 0)                                                    as total
    from keyed k
    group by k.dimension, k.key
  ),
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
  population as (
    select
      (
        select coalesce(sum(f.effective_units * coalesce(pp.period_price, 0)), 0)
        from public.source_of_sales_fact_rollup f
        join public.source_of_sales_import_batches b
          on b.id = f.batch_id and b.status = 'validated'
        left join public.source_of_sales_products p
          on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
        left join period_price pp
          on pp.product_code = f.product_code
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

revoke execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[], text[], jsonb) from public, anon, authenticated;
grant execute on function public.phx_closing_channel_breakdown(text, text, text[], text[], text[], text[], text[], jsonb) to service_role;

commit;
