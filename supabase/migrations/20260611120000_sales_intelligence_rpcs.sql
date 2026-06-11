-- Sales Intelligence RPCs — company-wide (ALL lines) Source of Sales aggregates with three
-- server-side scope filters baked into the query body: RESTRICTED-PRODUCT exclusion, line
-- scope, and region scope. These mirror the executive-report RPCs (phx_exec_*) one-for-one
-- but add p_exclude_codes / p_lines / p_regions so confidentiality and role visibility are
-- enforced BEFORE any total, share, ranking, or row ever leaves Postgres. SQL is the only
-- layer URL/API/filter/export tampering provably cannot reach, so the rules live here first.
--
-- The restricted products LA003 / LA004 ("Lacto Basic 1 & 2") are stripped unless p_exclude_codes
-- is empty (only a CEO/Super-Admin opt-in calls with '{}'). Line/region filters apply only when
-- their arrays are non-empty, so a company-wide caller passes '{}' for both. Pushing line scope
-- into SQL is essential for the brick/customer aggregates, which have no product/line dimension
-- in their output and so cannot be line-filtered after the fact.
--
-- Why new functions instead of editing phx_exec_* : the executive report + Sales Command
-- dashboard (and their tests) depend on the exact phx_exec_* output. Additive, reversible.
-- Value is recomputed Qty x (1 - discount) x live factory_price, identical to phx_exec_*. All
-- string comparisons are lower(btrim(...)) so case/whitespace drift never leaks or over-hides.

create or replace function public.phx_si_distributor_product(
  p_period text default null,
  p_exclude_codes text[] default '{}',
  p_lines text[] default '{}',
  p_regions text[] default '{}'
)
returns table (
  distributor_code text,
  official_line text,
  region_code text,
  area_code text,
  product_code text,
  product_name text,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  select
    r.distributor_code, r.official_line, r.region_code, r.area_code, r.product_code,
    max(r.product_name) as product_name,
    sum(r.qty) as units,
    sum(r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated' and r.invoice_period = b.period
    and (p_period is null or b.period = p_period)
    and upper(btrim(r.product_code)) <> all (
      select upper(btrim(c)) from unnest(p_exclude_codes) as c
    )
    and (
      cardinality(p_lines) = 0
      or lower(btrim(r.official_line)) in (select lower(btrim(x)) from unnest(p_lines) as x)
    )
    and (
      cardinality(p_regions) = 0
      or lower(btrim(r.region_code)) in (select lower(btrim(x)) from unnest(p_regions) as x)
    )
  group by r.distributor_code, r.official_line, r.region_code, r.area_code, r.product_code;
$$;

revoke all on function public.phx_si_distributor_product(text, text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_si_distributor_product(text, text[], text[], text[]) to service_role;

create or replace function public.phx_si_brick(
  p_period text default null,
  p_exclude_codes text[] default '{}',
  p_lines text[] default '{}',
  p_regions text[] default '{}'
)
returns table (
  distributor_code text,
  region_code text,
  area_code text,
  brick_id text,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  select
    r.distributor_code, r.region_code, r.area_code, r.brick_id,
    sum(r.qty) as units,
    sum(r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0)) as value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated' and r.invoice_period = b.period
    and (p_period is null or b.period = p_period)
    and upper(btrim(r.product_code)) <> all (
      select upper(btrim(c)) from unnest(p_exclude_codes) as c
    )
    and (
      cardinality(p_lines) = 0
      or lower(btrim(r.official_line)) in (select lower(btrim(x)) from unnest(p_lines) as x)
    )
    and (
      cardinality(p_regions) = 0
      or lower(btrim(r.region_code)) in (select lower(btrim(x)) from unnest(p_regions) as x)
    )
  group by r.distributor_code, r.region_code, r.area_code, r.brick_id;
$$;

revoke all on function public.phx_si_brick(text, text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_si_brick(text, text[], text[], text[]) to service_role;

create or replace function public.phx_si_customers(
  p_period text default null,
  p_exclude_codes text[] default '{}',
  p_lines text[] default '{}',
  p_regions text[] default '{}'
)
returns table (
  client_code text,
  client_name text,
  distributor_code text,
  region_code text,
  area_code text,
  brick_id text,
  units numeric,
  value numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  with scoped as (
    select
      r.client_code, r.distributor_code, r.client_name, r.region_code, r.area_code,
      r.brick_id, r.qty, r.created_at,
      r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b on b.id = r.batch_id
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where b.status = 'validated' and r.invoice_period = b.period
      and (p_period is null or b.period = p_period)
      and r.client_code is not null
      and upper(btrim(r.product_code)) <> all (
        select upper(btrim(c)) from unnest(p_exclude_codes) as c
      )
      and (
        cardinality(p_lines) = 0
        or lower(btrim(r.official_line)) in (select lower(btrim(x)) from unnest(p_lines) as x)
      )
      and (
        cardinality(p_regions) = 0
        or lower(btrim(r.region_code)) in (select lower(btrim(x)) from unnest(p_regions) as x)
      )
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code, distributor_code, client_name, region_code, area_code, brick_id
    from scoped
    order by client_code, distributor_code, created_at desc
  ),
  agg as (
    select client_code, distributor_code, sum(qty) as units, sum(line_value) as value
    from scoped
    group by client_code, distributor_code
  )
  select a.client_code, l.client_name, a.distributor_code, l.region_code, l.area_code,
         l.brick_id, a.units, a.value
  from agg a
  join latest l using (client_code, distributor_code);
$$;

revoke all on function public.phx_si_customers(text, text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_si_customers(text, text[], text[], text[]) to service_role;
