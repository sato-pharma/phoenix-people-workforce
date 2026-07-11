-- Sales Intelligence v2 RPCs — executive rebuild data layer.
--
-- 1) FIXES a live bug: the original phx_si_* (20260611120000) recompute value from factory price
--    for ALL rows, but the Direct (company) channel's truth is its stored sheet value
--    (r.is_direct → r.value). Confirmed live: April DIRECT = 1,033,169 via phx_exec_* (correct)
--    vs 910,080 via phx_si_* (wrong, ~EGP 123k/month understated). The three functions are
--    re-created here with the canonical exec expressions; the pinned 20260611120000 file is never
--    edited (structural tests read its source).
-- 2) ADDS the v2 analytics grains: one-scan period totals (trend + MoM/YoY + KPI sparklines),
--    the day grain (invoice_date), and a fail-closed bounded customer×product drill.
--
-- Every function keeps the locked phx_si_* security contract: restricted-product exclusion via
-- p_exclude_codes (LA003/LA004 — ~80% of value — must be stripped INSIDE SQL even where no product
-- column is output), line scope via p_lines, region scope via p_regions, security definer,
-- statement_timeout 45s, revoked from anon/authenticated, granted only to service_role.

-- ── 1. phx_si_distributor_product — Direct fix (stored value + 'DIRECT' area bucket) ─────────

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
    r.distributor_code, r.official_line, r.region_code,
    coalesce(nullif(r.area_code, ''), 'DIRECT') as area_code,
    r.product_code,
    max(r.product_name) as product_name,
    sum(r.qty) as units,
    sum(case when coalesce(r.is_direct, false)
             then r.value
             else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) end) as value
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
  group by r.distributor_code, r.official_line, r.region_code,
           coalesce(nullif(r.area_code, ''), 'DIRECT'), r.product_code;
$$;

revoke all on function public.phx_si_distributor_product(text, text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_si_distributor_product(text, text[], text[], text[]) to service_role;

-- ── 2. phx_si_brick — Direct rows excluded (they carry no brick), mirroring phx_exec_brick ───

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
    and coalesce(r.is_direct, false) = false
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

-- ── 3. phx_si_customers — Direct rows excluded, mirroring phx_exec_customers ─────────────────

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
      and coalesce(r.is_direct, false) = false
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

-- ── 4. phx_si_period_totals — ONE grouped scan across all validated months ──────────────────
-- Replaces the O(months) sequential per-period trend loop and yields headline MoM/YoY plus every
-- KPI sparkline (value, units, customers, products, areas) for free.

create or replace function public.phx_si_period_totals(
  p_exclude_codes text[] default '{}',
  p_lines text[] default '{}',
  p_regions text[] default '{}'
)
returns table (
  period text,
  units numeric,
  value numeric,
  customer_count integer,
  product_count integer,
  area_count integer
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  select
    b.period,
    sum(r.qty) as units,
    sum(case when coalesce(r.is_direct, false)
             then r.value
             else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) end) as value,
    count(distinct r.client_code)::integer as customer_count,
    count(distinct upper(btrim(r.product_code)))::integer as product_count,
    count(distinct nullif(btrim(r.area_code), ''))::integer as area_count
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated' and r.invoice_period = b.period
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
  group by b.period;
$$;

revoke all on function public.phx_si_period_totals(text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_si_period_totals(text[], text[], text[]) to service_role;

-- ── 5. phx_si_daily — the day grain (sales AND customers per day) ───────────────────────────
-- p_period is effectively REQUIRED: a null period returns zero rows (a day-grain scan across all
-- history is never allowed). The NULL invoice_date bucket is returned deliberately so undated
-- residue is reported honestly instead of silently dropped. Output ≤ ~31 days × distributors.

create or replace function public.phx_si_daily(
  p_period text default null,
  p_exclude_codes text[] default '{}',
  p_lines text[] default '{}',
  p_regions text[] default '{}',
  p_product_codes text[] default '{}',
  p_distributor_codes text[] default '{}'
)
returns table (
  invoice_date date,
  distributor_code text,
  units numeric,
  value numeric,
  customer_count integer
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  select
    r.invoice_date,
    r.distributor_code,
    sum(r.qty) as units,
    sum(case when coalesce(r.is_direct, false)
             then r.value
             else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) end) as value,
    count(distinct r.client_code)::integer as customer_count
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where p_period is not null
    and b.status = 'validated' and r.invoice_period = b.period
    and b.period = p_period
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
    and (
      cardinality(p_product_codes) = 0
      or upper(btrim(r.product_code)) in (select upper(btrim(x)) from unnest(p_product_codes) as x)
    )
    and (
      cardinality(p_distributor_codes) = 0
      or upper(btrim(r.distributor_code)) in (select upper(btrim(x)) from unnest(p_distributor_codes) as x)
    )
  group by r.invoice_date, r.distributor_code;
$$;

revoke all on function public.phx_si_daily(text, text[], text[], text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.phx_si_daily(text, text[], text[], text[], text[], text[]) to service_role;

-- ── 6. phx_si_customer_product — bounded customer×product drill (28,877 pairs/month) ─────────
-- FAIL-CLOSED: with BOTH filter arrays empty the function returns zero rows, so the full
-- customer×product grain is unreachable by any tampering path. Output is value-ranked and
-- LIMIT-clamped in SQL. Direct rows excluded (no customer identity), mirroring phx_si_customers.

create or replace function public.phx_si_customer_product(
  p_period text default null,
  p_exclude_codes text[] default '{}',
  p_lines text[] default '{}',
  p_regions text[] default '{}',
  p_product_codes text[] default '{}',
  p_client_codes text[] default '{}',
  p_limit integer default 100
)
returns table (
  client_code text,
  client_name text,
  distributor_code text,
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
  with scoped as (
    select
      r.client_code, r.client_name, r.distributor_code, r.region_code, r.area_code,
      r.product_code, r.product_name, r.qty, r.created_at,
      case when coalesce(r.is_direct, false)
           then r.value
           else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) end as line_value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b on b.id = r.batch_id
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
    where (cardinality(p_product_codes) > 0 or cardinality(p_client_codes) > 0)
      and b.status = 'validated' and r.invoice_period = b.period
      and (p_period is null or b.period = p_period)
      and r.client_code is not null
      and coalesce(r.is_direct, false) = false
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
    sum(s.qty) as units,
    sum(s.line_value) as value
  from scoped s
  group by s.client_code, s.distributor_code, s.product_code
  order by sum(s.line_value) desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

revoke all on function public.phx_si_customer_product(text, text[], text[], text[], text[], text[], integer) from public, anon, authenticated;
grant execute on function public.phx_si_customer_product(text, text[], text[], text[], text[], text[], integer) to service_role;
