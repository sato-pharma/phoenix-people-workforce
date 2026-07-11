-- Rollup-completion (PR 2): cut the remaining confirmed raw-scanning executive /
-- sales-intelligence RPCs over to the pre-aggregated rollups, mirroring the exact
-- precedent from 20260624093000_sos_exec_si_read_from_rollup.sql. Signatures, return
-- columns, attributes (STABLE SECURITY DEFINER, search_path, statement_timeout) and
-- output semantics match the previous bodies (verified via parity check against live
-- production data before this migration was applied — see phx_si_customers below for
-- the one deliberate, documented behavior change). Pricing stays live: effective_units
-- * current factory_price; direct rows use the stored direct_value.
--
-- phx_exec_sos_trend and phx_si_brick read source_of_sales_fact_rollup (unchanged
-- schema — it already carried every dimension these two need). phx_si_customer_product
-- and phx_si_customers read source_of_sales_customer_directory_rollup (just widened by
-- the prior migration to add is_direct + official_line).
--
-- phx_si_daily is NOT migrated here: it needs day-level grain (invoice_date) that
-- neither rollup carries (both are period/month-grain). Unlike the four functions
-- below, it is already period-bounded (p_period is required, scanning one period's
-- slice via the sos_import_rows_invoice_date_idx index) rather than an unbounded scan,
-- so it does not share the same performance risk profile. Left as a raw reader,
-- disclosed as follow-up work rather than silently skipped.

create or replace function public.phx_exec_sos_trend(
  p_periods text[] default '{}'::text[],
  p_lines text[] default '{}'::text[],
  p_distributors text[] default '{}'::text[],
  p_regions text[] default '{}'::text[],
  p_areas text[] default '{}'::text[],
  p_products text[] default '{}'::text[],
  p_exclude_codes text[] default '{}'::text[]
)
 returns table(period text, units numeric, value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  select
    f.period,
    sum(f.total_qty) as units,
    sum(case when f.is_direct
             then f.direct_value
             else f.effective_units * coalesce(p.factory_price, 0) end) as value
  from public.source_of_sales_fact_rollup f
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where (cardinality(p_periods) = 0 or f.period = any (p_periods))
    and (
      cardinality(p_lines) = 0
      or lower(btrim(coalesce(f.official_line, ''))) in (select lower(btrim(x)) from unnest(p_lines) as x)
    )
    and (
      cardinality(p_distributors) = 0
      or upper(btrim(coalesce(f.distributor_code, ''))) in (select upper(btrim(x)) from unnest(p_distributors) as x)
    )
    and (
      cardinality(p_regions) = 0
      or upper(btrim(coalesce(f.region_code, ''))) in (select upper(btrim(x)) from unnest(p_regions) as x)
    )
    and (
      cardinality(p_areas) = 0
      or upper(btrim(coalesce(nullif(f.area_code, ''), 'DIRECT'))) in (select upper(btrim(x)) from unnest(p_areas) as x)
    )
    and (
      cardinality(p_products) = 0
      or upper(btrim(coalesce(f.product_code, ''))) in (select upper(btrim(x)) from unnest(p_products) as x)
    )
    and (
      cardinality(p_exclude_codes) = 0
      or upper(btrim(coalesce(f.product_code, ''))) <> all (select upper(btrim(x)) from unnest(p_exclude_codes) as x)
    )
  group by f.period;
$function$;

create or replace function public.phx_si_brick(
  p_period text default null::text,
  p_exclude_codes text[] default '{}'::text[],
  p_lines text[] default '{}'::text[],
  p_regions text[] default '{}'::text[]
)
 returns table(distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  select
    f.distributor_code,
    f.region_code,
    f.area_code,
    f.brick_id,
    sum(f.total_qty) as units,
    sum(f.effective_units * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_fact_rollup f
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
  where (p_period is null or f.period = p_period)
    and f.is_direct = false
    and upper(btrim(coalesce(f.product_code, ''))) <> all (
      select upper(btrim(c)) from unnest(p_exclude_codes) as c
    )
    and (
      cardinality(p_lines) = 0
      or lower(btrim(coalesce(f.official_line, ''))) in (select lower(btrim(x)) from unnest(p_lines) as x)
    )
    and (
      cardinality(p_regions) = 0
      or lower(btrim(coalesce(f.region_code, ''))) in (select lower(btrim(x)) from unnest(p_regions) as x)
    )
  group by f.distributor_code, f.region_code, f.area_code, f.brick_id;
$function$;

create or replace function public.phx_si_customer_product(
  p_period text default null::text,
  p_exclude_codes text[] default '{}'::text[],
  p_lines text[] default '{}'::text[],
  p_regions text[] default '{}'::text[],
  p_product_codes text[] default '{}'::text[],
  p_client_codes text[] default '{}'::text[],
  p_limit integer default 100
)
 returns table(client_code text, client_name text, distributor_code text, region_code text, area_code text, product_code text, product_name text, units numeric, value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with scoped as (
    select
      r.client_code, r.client_name, r.distributor_code, r.region_code, r.area_code,
      r.product_code, p.product_name, r.total_qty,
      r.effective_units * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (cardinality(p_product_codes) > 0 or cardinality(p_client_codes) > 0)
      and (p_period is null or r.period = p_period)
      and r.client_code is not null
      and r.is_direct = false
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
        select upper(btrim(c)) from unnest(p_exclude_codes) as c
      )
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(r.official_line, ''))) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_regions) = 0
        or lower(btrim(coalesce(r.region_code, ''))) in (select lower(btrim(x)) from unnest(p_regions) as x)
      )
      and (
        cardinality(p_product_codes) = 0
        or upper(btrim(r.product_code)) in (select upper(btrim(x)) from unnest(p_product_codes) as x)
      )
      and (
        cardinality(p_client_codes) = 0
        or upper(btrim(r.client_code)) in (select upper(btrim(x)) from unnest(p_client_codes) as x)
      )
  )
  select
    s.client_code,
    max(s.client_name) as client_name,
    s.distributor_code,
    max(s.region_code) as region_code,
    max(s.area_code) as area_code,
    s.product_code,
    max(s.product_name) as product_name,
    sum(s.total_qty) as units,
    sum(s.line_value) as value
  from scoped s
  group by s.client_code, s.distributor_code, s.product_code
  order by sum(s.line_value) desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$function$;

create or replace function public.phx_si_customers(
  p_period text default null::text,
  p_exclude_codes text[] default '{}'::text[],
  p_lines text[] default '{}'::text[],
  p_regions text[] default '{}'::text[]
)
 returns table(client_code text, client_name text, distributor_code text, region_code text, area_code text, brick_id text, units numeric, value numeric)
 language sql
 stable security definer
 set search_path to 'public'
 set statement_timeout to '45s'
as $function$
  with filtered as (
    select
      r.client_code, r.client_name, r.distributor_code, r.region_code, r.area_code, r.brick_id,
      r.product_code, r.latest_row_created_at, r.total_qty,
      r.effective_units * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_customer_directory_rollup r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated'
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (p_period is null or r.period = p_period)
      and r.client_code is not null
      and r.is_direct = false
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
        select upper(btrim(c)) from unnest(p_exclude_codes) as c
      )
      and (
        cardinality(p_lines) = 0
        or lower(btrim(coalesce(r.official_line, ''))) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_regions) = 0
        or lower(btrim(coalesce(r.region_code, ''))) in (select lower(btrim(x)) from unnest(p_regions) as x)
      )
  ),
  latest as (
    -- product_code is a deterministic secondary tiebreak for the rare case where two rows
    -- for the same client+distributor share the exact same latest_row_created_at (observed
    -- in production parity testing: two product lines imported in the same batch, identical
    -- timestamp to the microsecond). Without it, which row "wins" is Postgres-plan-dependent
    -- and can vary run to run; this makes the pick reproducible. Only affects the tied case —
    -- verified against production data to be a no-op everywhere the timestamp already differs.
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc, product_code asc
  ),
  agg as (
    select client_code, distributor_code, sum(total_qty) as units, sum(line_value) as value
    from filtered
    group by client_code, distributor_code
  )
  select a.client_code, l.client_name, a.distributor_code, l.region_code, l.area_code, l.brick_id, a.units, a.value
  from agg a
  join latest l using (client_code, distributor_code);
$function$;
