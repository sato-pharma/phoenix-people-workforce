-- Confidential-product exclusion for Customer Directory / Sales & Marketing Intelligence RPCs.
--
-- phx_customer_directory, phx_customer_directory_json, phx_customer_sales and
-- phx_sales_marketing_dashboard had no p_exclude_codes parameter, so the confidential
-- products (LA003 / LA004 "Lacto Basic 1 & 2" and SS001 "Satoslim") were mixed into every
-- customer total_value, per-customer product breakdown, and leadership dashboard aggregate
-- with no server-side opt-out — unlike every sibling SI/ROI RPC, which already accepts
-- p_exclude_codes (see 20260623090000_marketing_roi_exclude_codes.sql and
-- 20260611120000_sales_intelligence_rpcs.sql). The current app callers (Customer Directory
-- routes) already gate on Super Admin, so this was not reachable by an unauthorized role
-- through the app today; phx_sales_marketing_dashboard has no caller at all yet. Still, the
-- RPCs themselves had none of the defense-in-depth the rest of the codebase relies on. This
-- migration brings all four in line with that pattern: default '{}' (no exclusion, matching
-- every sibling RPC's default), callers pass RESTRICTED_PRODUCT_CODES unless the caller can
-- view them (src/lib/sales/access-scope.ts canViewRestrictedProducts).
--
-- Adding a parameter changes each function's signature, so each is DROPped and CREATEd fresh
-- (CREATE OR REPLACE cannot add a parameter to an existing signature — it would instead
-- create a second, overloaded function and leave the old unguarded one callable).

-- ── phx_customer_directory ──────────────────────────────────────────────────
drop function if exists public.phx_customer_directory(text[], text[], text[], text[], text, text);

create function public.phx_customer_directory(
  p_region_codes text[] default null,
  p_area_codes text[] default null,
  p_brick_codes text[] default null,
  p_distributor_codes text[] default null,
  p_from_period text default null,
  p_to_period text default null,
  p_exclude_codes text[] default '{}'::text[]
)
returns table (
  client_code text,
  client_name text,
  client_address text,
  distributor_code text,
  brick_id text,
  area_code text,
  region_code text,
  total_units numeric,
  total_value numeric
)
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  with filtered as materialized (
    select
      c.client_code,
      c.client_name,
      c.client_address,
      c.distributor_code,
      c.brick_id,
      c.area_code,
      c.region_code,
      c.latest_row_created_at,
      c.total_qty,
      c.effective_units * coalesce(p.factory_price, 0) as line_value
    from public.source_of_sales_customer_directory_rollup c
    left join public.source_of_sales_products p
      on upper(btrim(p.product_code)) = c.product_code
    where (p_distributor_codes is null or cardinality(p_distributor_codes) = 0 or c.distributor_code = any(p_distributor_codes))
      and (p_region_codes is null or cardinality(p_region_codes) = 0 or c.region_code = any(p_region_codes))
      and (p_area_codes is null or cardinality(p_area_codes) = 0 or c.area_code = any(p_area_codes))
      and (p_brick_codes is null or cardinality(p_brick_codes) = 0 or c.brick_id = any(p_brick_codes))
      and (p_from_period is null or c.period >= p_from_period)
      and (p_to_period is null or c.period <= p_to_period)
      and upper(btrim(coalesce(c.product_code, ''))) <> all (
        select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
      )
  ),
  latest as (
    select distinct on (client_code, distributor_code)
      client_code,
      distributor_code,
      client_name,
      client_address,
      brick_id,
      area_code,
      region_code
    from filtered
    order by client_code, distributor_code, latest_row_created_at desc
  ),
  agg as (
    select
      client_code,
      distributor_code,
      sum(total_qty) as total_units,
      sum(line_value) as total_value
    from filtered
    group by client_code, distributor_code
  )
  select
    a.client_code,
    l.client_name,
    l.client_address,
    a.distributor_code,
    l.brick_id,
    l.area_code,
    l.region_code,
    a.total_units,
    a.total_value
  from agg a
  join latest l using (client_code, distributor_code);
$$;

revoke all on function public.phx_customer_directory(text[], text[], text[], text[], text, text, text[]) from public, anon, authenticated;
grant execute on function public.phx_customer_directory(text[], text[], text[], text[], text, text, text[]) to service_role;

-- ── phx_customer_directory_json ─────────────────────────────────────────────
drop function if exists public.phx_customer_directory_json(text[], text[], text[], text[], text, text);

create function public.phx_customer_directory_json(
  p_region_codes text[] default null,
  p_area_codes text[] default null,
  p_brick_codes text[] default null,
  p_distributor_codes text[] default null,
  p_from_period text default null,
  p_to_period text default null,
  p_exclude_codes text[] default '{}'::text[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $$
  select coalesce(jsonb_agg(to_jsonb(row)), '[]'::jsonb)
  from (
    select *
    from public.phx_customer_directory(
      p_region_codes,
      p_area_codes,
      p_brick_codes,
      p_distributor_codes,
      p_from_period,
      p_to_period,
      p_exclude_codes
    )
  ) row;
$$;

revoke all on function public.phx_customer_directory_json(text[], text[], text[], text[], text, text, text[]) from public, anon, authenticated;
grant execute on function public.phx_customer_directory_json(text[], text[], text[], text[], text, text, text[]) to service_role;

-- ── phx_customer_sales ───────────────────────────────────────────────────────
drop function if exists public.phx_customer_sales(text, text, text, text);

create function public.phx_customer_sales(
  p_distributor_code text,
  p_client_code text,
  p_from_period text default null,
  p_to_period text default null,
  p_exclude_codes text[] default '{}'::text[]
)
returns table (
  invoice_period text,
  product_code text,
  product_name text,
  official_line text,
  brick_id text,
  area_code text,
  region_code text,
  client_name text,
  client_address text,
  qty numeric,
  line_value numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.invoice_period, r.product_code, r.product_name, r.official_line, r.brick_id,
    r.area_code, r.region_code, r.client_name, r.client_address, r.qty,
    r.qty * (1 - coalesce(r.discount, 0)) * coalesce(p.factory_price, 0) as line_value
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b on b.id = r.batch_id
  left join public.source_of_sales_products p
    on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
  where b.status = 'validated'
    and r.distributor_code = p_distributor_code
    and r.client_code = p_client_code
    and (p_from_period is null or r.invoice_period >= p_from_period)
    and (p_to_period is null or r.invoice_period <= p_to_period)
    and upper(btrim(coalesce(r.product_code, ''))) <> all (
      select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
    )
  order by r.invoice_period, r.product_name;
$$;

revoke all on function public.phx_customer_sales(text, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.phx_customer_sales(text, text, text, text, text[]) to service_role;

-- ── phx_sales_marketing_dashboard ───────────────────────────────────────────
-- Dead code today (no caller in app/ or src/), fixed for defense-in-depth so a future
-- caller cannot wire it up without inheriting the exclusion. Two injection points:
-- sales_base (the raw Source-of-Sales aggregate dimension: summary/trend/by-line/by-region/
-- by-distributor/by-product) and req_products (the marketing-ROI attribution dimension,
-- mirroring the exact fix already applied to the sibling phx_marketing_roi_customer_dashboard
-- in 20260623090000_marketing_roi_exclude_codes.sql) — target_products, exact_hits and
-- fallback_hits all derive from req_products, so filtering it there covers every downstream
-- "actual sales" aggregate too.
drop function if exists public.phx_sales_marketing_dashboard(text[], text[], text[], text[], integer);

create function public.phx_sales_marketing_dashboard(
  p_lines text[] default '{}',
  p_regions text[] default '{}',
  p_distributor_codes text[] default '{}',
  p_product_codes text[] default '{}',
  p_limit integer default 100,
  p_exclude_codes text[] default '{}'::text[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '45s'
as $func$
  with params as (
    select greatest(10, least(coalesce(p_limit, 100), 100)) as row_limit
  ),
  filter_lines as materialized (
    select lower(btrim(value)) as value from unnest(coalesce(p_lines, '{}'::text[])) as value where btrim(value) <> ''
  ),
  filter_regions as materialized (
    select lower(btrim(value)) as value from unnest(coalesce(p_regions, '{}'::text[])) as value where btrim(value) <> ''
  ),
  filter_distributors as materialized (
    select upper(btrim(value)) as value from unnest(coalesce(p_distributor_codes, '{}'::text[])) as value where btrim(value) <> ''
  ),
  filter_products as materialized (
    select upper(btrim(value)) as value from unnest(coalesce(p_product_codes, '{}'::text[])) as value where btrim(value) <> ''
  ),
  sales_base as materialized (
    select
      b.period,
      r.distributor_code,
      coalesce(sd.distributor_name, r.distributor_code) as distributor_name,
      coalesce(nullif(btrim(r.official_line), ''), 'Unassigned') as line_label,
      r.region_code,
      coalesce(sr.region_name, nullif(btrim(r.region_name), ''), r.region_code, 'Unassigned') as region_name,
      coalesce(nullif(btrim(r.area_code), ''), 'DIRECT') as area_code,
      coalesce(sa.area_name, nullif(btrim(r.area_name), ''), nullif(btrim(r.area_code), ''), 'Direct') as area_name,
      upper(btrim(r.product_code)) as product_code,
      coalesce(sp.product_name, nullif(btrim(r.product_name), ''), r.product_code) as product_name,
      nullif(btrim(r.client_code), '') as client_code,
      nullif(btrim(r.client_name), '') as client_name,
      nullif(btrim(r.brick_id), '') as brick_id,
      coalesce(r.qty, 0)::numeric as units,
      (
        case
          when coalesce(r.is_direct, false) then coalesce(r.value, 0)
          else coalesce(r.qty, 0) * (1 - coalesce(r.discount, 0)) * coalesce(sp.factory_price, 0)
        end
      )::numeric as sales_value
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id
     and b.status = 'validated'
     and b.period is not null
     and r.invoice_period = b.period
    left join public.source_of_sales_products sp
      on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    left join public.source_of_sales_distributors sd
      on sd.distributor_code = r.distributor_code
    left join public.source_of_sales_regions sr
      on sr.region_code = r.region_code
    left join public.source_of_sales_areas sa
      on sa.area_code = r.area_code
    where r.validation_state = 'valid'
      and (
        not exists (select 1 from filter_lines)
        or lower(btrim(r.official_line)) in (select value from filter_lines)
      )
      and (
        not exists (select 1 from filter_regions)
        or lower(btrim(r.region_code)) in (select value from filter_regions)
      )
      and (
        not exists (select 1 from filter_distributors)
        or upper(btrim(r.distributor_code)) in (select value from filter_distributors)
      )
      and (
        not exists (select 1 from filter_products)
        or upper(btrim(r.product_code)) in (select value from filter_products)
      )
      and upper(btrim(coalesce(r.product_code, ''))) <> all (
        select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
      )
  ),
  sales_summary as (
    select
      coalesce(sum(sales_value), 0)::numeric as total_sales_value,
      coalesce(sum(units), 0)::numeric as total_sales_units,
      count(distinct client_code)::integer as active_customers,
      count(distinct product_code)::integer as active_products,
      count(distinct period)::integer as validated_periods,
      count(*)::integer as matched_sales_rows
    from sales_base
  ),
  sales_trend as (
    select
      period,
      coalesce(sum(sales_value), 0)::numeric as sales_value,
      coalesce(sum(units), 0)::numeric as sales_units,
      count(distinct client_code)::integer as customer_count,
      count(distinct product_code)::integer as product_count
    from sales_base
    group by period
  ),
  sales_by_line as (
    select
      line_label,
      coalesce(sum(sales_value), 0)::numeric as sales_value,
      coalesce(sum(units), 0)::numeric as sales_units,
      count(distinct client_code)::integer as customer_count,
      count(distinct product_code)::integer as product_count
    from sales_base
    group by line_label
  ),
  sales_by_region as (
    select
      region_code,
      max(region_name) as region_name,
      coalesce(sum(sales_value), 0)::numeric as sales_value,
      coalesce(sum(units), 0)::numeric as sales_units,
      count(distinct client_code)::integer as customer_count,
      count(distinct product_code)::integer as product_count
    from sales_base
    group by region_code
  ),
  sales_by_distributor as (
    select
      distributor_code,
      max(distributor_name) as distributor_name,
      coalesce(sum(sales_value), 0)::numeric as sales_value,
      coalesce(sum(units), 0)::numeric as sales_units,
      count(distinct client_code)::integer as customer_count,
      count(distinct product_code)::integer as product_count
    from sales_base
    group by distributor_code
  ),
  sales_by_product as (
    select
      product_code,
      max(product_name) as product_name,
      max(line_label) as line_label,
      coalesce(sum(sales_value), 0)::numeric as sales_value,
      coalesce(sum(units), 0)::numeric as sales_units,
      count(distinct client_code)::integer as customer_count
    from sales_base
    group by product_code
  ),
  req_raw as materialized (
    select
      mr.id,
      mr.request_code,
      mr.status,
      mr.pay_date,
      greatest(coalesce(mr.roi_duration_months, 1), 1) as roi_duration_months,
      coalesce(mr.estimated_cost, 0)::numeric as estimated_cost,
      coalesce(mr.required_roi_value, coalesce(mr.estimated_cost, 0) * 10)::numeric as required_roi_value,
      coalesce(mr.expected_roi_value, 0)::numeric as expected_roi_value,
      coalesce(mr.roi_coverage_ratio, 0)::numeric as roi_coverage_ratio,
      mr.customer_id,
      mr.line_id,
      coalesce(l.name, 'Unassigned') as request_line,
      mc.display_name as customer_name
    from public.marketing_requests mr
    left join public.lines l on l.id = mr.line_id
    left join public.marketing_customers mc on mc.id = mr.customer_id
    where mr.status in ('approved', 'active', 'roi_tracking', 'closed', 'finance_hold')
      and mr.pay_date is not null
  ),
  req_products_all as materialized (
    select distinct
      mrp.request_id,
      upper(btrim(sp.product_code)) as product_code,
      coalesce(sp.product_name, mp.product_name, mrp.product_name_snapshot) as product_name,
      coalesce(nullif(btrim(sp.line), ''), nullif(btrim(mp.line), ''), nullif(btrim(mrp.line_snapshot), ''), 'Unassigned') as line_label,
      coalesce(mrp.expected_value, 0)::numeric as expected_value,
      coalesce(mrp.value_share, 0)::numeric as value_share
    from public.marketing_request_products mrp
    join public.marketing_products mp on mp.id = mrp.product_id
    join public.source_of_sales_products sp
      on lower(btrim(sp.normalized_product_name)) = lower(btrim(mp.normalized_name))
    where mrp.request_id in (select id from req_raw)
  ),
  req_targets_all as materialized (
    select distinct
      mrph.request_id,
      sd.distributor_code,
      coalesce(sd.distributor_name, md.display_name, sd.distributor_code) as distributor_name,
      mpdc.normalized_pharmacy_code as customer_code,
      cm.brick_id,
      cm.region_code,
      cm.area_code
    from public.marketing_request_pharmacies mrph
    join public.marketing_pharmacy_distributor_codes mpdc on mpdc.id = mrph.distributor_code_id
    join public.marketing_distributors md on md.id = mpdc.distributor_id
    join public.source_of_sales_distributors sd on sd.normalized_distributor_name = md.normalized_name
    left join public.source_of_sales_customer_map cm
      on cm.distributor_code = sd.distributor_code
     and lower(btrim(regexp_replace(coalesce(cm.customer_code, ''), '\s+', ' ', 'g'))) = mpdc.normalized_pharmacy_code
     and cm.active
    where mrph.request_id in (select id from req_raw)
      and coalesce(btrim(mpdc.normalized_pharmacy_code), '') <> ''
  ),
  req as materialized (
    select
      rr.*,
      coalesce(
        nullif(btrim(rr.request_line), ''),
        (select max(rpa.line_label) from req_products_all rpa where rpa.request_id = rr.id),
        'Unassigned'
      ) as line_label
    from req_raw rr
    where (
        not exists (select 1 from filter_lines)
        or lower(btrim(coalesce(rr.request_line, ''))) in (select value from filter_lines)
        or exists (
          select 1 from req_products_all rpa
          where rpa.request_id = rr.id
            and lower(btrim(rpa.line_label)) in (select value from filter_lines)
        )
      )
      and (
        not exists (select 1 from filter_distributors)
        or exists (
          select 1 from req_targets_all rta
          where rta.request_id = rr.id
            and upper(btrim(rta.distributor_code)) in (select value from filter_distributors)
        )
      )
      and (
        not exists (select 1 from filter_products)
        or exists (
          select 1 from req_products_all rpa
          where rpa.request_id = rr.id
            and upper(btrim(rpa.product_code)) in (select value from filter_products)
        )
      )
  ),
  req_products as materialized (
    select rpa.*
    from req_products_all rpa
    join req on req.id = rpa.request_id
    where (
      not exists (select 1 from filter_products)
      or upper(btrim(rpa.product_code)) in (select value from filter_products)
    )
    and upper(btrim(coalesce(rpa.product_code, ''))) <> all (
      select upper(btrim(x)) from unnest(coalesce(p_exclude_codes, '{}'::text[])) as x
    )
  ),
  req_targets as materialized (
    select rta.*
    from req_targets_all rta
    join req on req.id = rta.request_id
    where (
      not exists (select 1 from filter_distributors)
      or upper(btrim(rta.distributor_code)) in (select value from filter_distributors)
    )
  ),
  periods as materialized (
    select req.id, array_agg(to_char(g, 'YYYY-MM')) as periods
    from req
    cross join lateral generate_series(
      date_trunc('month', req.pay_date),
      date_trunc('month', req.pay_date) + make_interval(months => req.roi_duration_months - 1),
      interval '1 month'
    ) as g
    group by req.id
  ),
  target_products as materialized (
    select distinct
      rt.request_id,
      rt.distributor_code,
      rt.customer_code,
      rt.brick_id,
      rp.product_code
    from req_targets rt
    join req_products rp on rp.request_id = rt.request_id
  ),
  exact_hits as materialized (
    select distinct
      tp.request_id,
      r.id as row_id,
      r.distributor_code,
      coalesce(sd.distributor_name, r.distributor_code) as distributor_name,
      lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) as client_code,
      nullif(btrim(r.client_name), '') as client_name,
      r.region_code,
      coalesce(sr.region_name, r.region_name, r.region_code) as region_name,
      nullif(btrim(r.brick_id), '') as brick_id,
      upper(btrim(r.product_code)) as product_code,
      coalesce(sp.product_name, r.product_name, r.product_code) as product_name,
      coalesce(nullif(btrim(sp.line), ''), nullif(btrim(r.official_line), ''), 'Unassigned') as line_label,
      r.qty as units,
      case when coalesce(r.is_direct, false)
           then coalesce(r.value, 0)
           else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(sp.factory_price, 0)
      end as sales_value,
      'exact'::text as match_type
    from target_products tp
    join periods on periods.id = tp.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = tp.distributor_code
     and lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) = tp.customer_code
     and upper(btrim(r.product_code)) = upper(btrim(tp.product_code))
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    left join public.source_of_sales_distributors sd on sd.distributor_code = r.distributor_code
    left join public.source_of_sales_regions sr on sr.region_code = r.region_code
    where (
      not exists (select 1 from filter_regions)
      or lower(btrim(r.region_code)) in (select value from filter_regions)
    )
  ),
  exact_covered_keys as (
    select distinct request_id, distributor_code, coalesce(brick_id, '') as brick_id, product_code
    from exact_hits
  ),
  fallback_bricks as materialized (
    select distinct
      request_id,
      distributor_code,
      brick_id,
      upper(btrim(product_code)) as product_code
    from target_products
    where coalesce(btrim(brick_id), '') <> ''
  ),
  fallback_hits as materialized (
    select distinct
      fb.request_id,
      r.id as row_id,
      r.distributor_code,
      coalesce(sd.distributor_name, r.distributor_code) as distributor_name,
      lower(btrim(regexp_replace(coalesce(r.client_code, ''), '\s+', ' ', 'g'))) as client_code,
      nullif(btrim(r.client_name), '') as client_name,
      r.region_code,
      coalesce(sr.region_name, r.region_name, r.region_code) as region_name,
      nullif(btrim(r.brick_id), '') as brick_id,
      upper(btrim(r.product_code)) as product_code,
      coalesce(sp.product_name, r.product_name, r.product_code) as product_name,
      coalesce(nullif(btrim(sp.line), ''), nullif(btrim(r.official_line), ''), 'Unassigned') as line_label,
      r.qty as units,
      case when coalesce(r.is_direct, false)
           then coalesce(r.value, 0)
           else r.qty * (1 - coalesce(r.discount, 0)) * coalesce(sp.factory_price, 0)
      end as sales_value,
      'fallback'::text as match_type
    from fallback_bricks fb
    join periods on periods.id = fb.request_id
    join public.source_of_sales_import_rows r
      on r.distributor_code = fb.distributor_code
     and r.brick_id = fb.brick_id
     and upper(btrim(r.product_code)) = fb.product_code
     and r.invoice_period = any(periods.periods)
     and r.validation_state = 'valid'
    join public.source_of_sales_import_batches b on b.id = r.batch_id and b.status = 'validated'
    join public.source_of_sales_products sp on upper(btrim(sp.product_code)) = upper(btrim(r.product_code))
    left join public.source_of_sales_distributors sd on sd.distributor_code = r.distributor_code
    left join public.source_of_sales_regions sr on sr.region_code = r.region_code
    where not exists (
        select 1
        from exact_covered_keys ek
        where ek.request_id = fb.request_id
          and ek.distributor_code = fb.distributor_code
          and ek.brick_id = coalesce(fb.brick_id, '')
          and ek.product_code = fb.product_code
      )
      and (
        not exists (select 1 from filter_regions)
        or lower(btrim(r.region_code)) in (select value from filter_regions)
      )
  ),
  all_hits as materialized (
    select
      request_id,
      row_id,
      distributor_code,
      distributor_name,
      client_code,
      client_name,
      region_code,
      region_name,
      brick_id,
      product_code,
      product_name,
      line_label,
      units,
      sales_value,
      match_type
    from exact_hits
    union all
    select
      request_id,
      row_id,
      distributor_code,
      distributor_name,
      client_code,
      client_name,
      region_code,
      region_name,
      brick_id,
      product_code,
      product_name,
      line_label,
      units,
      sales_value,
      match_type
    from fallback_hits
  ),
  actuals as materialized (
    select
      request_id,
      coalesce(sum(sales_value), 0)::numeric as actual_value,
      coalesce(sum(units), 0)::numeric as actual_units,
      count(distinct row_id)::integer as sales_rows,
      (count(distinct row_id) filter (where match_type = 'exact'))::integer as exact_sales_rows,
      (count(distinct row_id) filter (where match_type = 'fallback'))::integer as fallback_sales_rows
    from all_hits
    group by request_id
  ),
  request_rows as materialized (
    select
      req.id,
      req.request_code,
      req.status,
      req.pay_date,
      req.roi_duration_months,
      req.estimated_cost,
      req.required_roi_value,
      req.expected_roi_value,
      req.roi_coverage_ratio,
      req.line_label,
      coalesce(req.customer_name, req.customer_id::text) as customer_name,
      coalesce(actuals.actual_value, 0)::numeric as actual_sales_value,
      coalesce(actuals.actual_units, 0)::numeric as actual_sales_units,
      coalesce(actuals.sales_rows, 0)::integer as sales_rows,
      coalesce(actuals.exact_sales_rows, 0)::integer as exact_sales_rows,
      coalesce(actuals.fallback_sales_rows, 0)::integer as fallback_sales_rows,
      case
        when coalesce(actuals.sales_rows, 0) = 0 then 'no_sales'
        when coalesce(actuals.exact_sales_rows, 0) > 0 and coalesce(actuals.fallback_sales_rows, 0) > 0 then 'mixed'
        when coalesce(actuals.exact_sales_rows, 0) > 0 then 'exact_customer'
        else 'brick_fallback'
      end as attribution_quality,
      case
        when coalesce(actuals.sales_rows, 0) = 0 then 'no_data'
        when coalesce(actuals.actual_value, 0) >= req.required_roi_value then 'on_track'
        else 'behind'
      end as actual_roi_status,
      case
        when req.required_roi_value > 0 then coalesce(actuals.actual_value, 0) / req.required_roi_value
        when coalesce(actuals.actual_value, 0) > 0 then 1
        else 0
      end as actual_coverage_ratio
    from req
    left join actuals on actuals.request_id = req.id
  ),
  request_product_counts as (
    select request_id, greatest(count(*), 1) as product_count
    from req_products
    group by request_id
  ),
  request_product_allocations as materialized (
    select
      rp.request_id,
      rp.product_code,
      rp.product_name,
      rp.line_label,
      case
        when rp.value_share > 0 then rp.value_share
        else 1.0 / rpc.product_count
      end as share,
      rp.expected_value
    from req_products rp
    join request_product_counts rpc on rpc.request_id = rp.request_id
  ),
  actuals_by_line as (
    select line_label, sum(sales_value)::numeric as actual_sales_value
    from all_hits
    group by line_label
  ),
  actuals_by_region as (
    select region_code, max(region_name) as region_name, sum(sales_value)::numeric as actual_sales_value
    from all_hits
    group by region_code
  ),
  actuals_by_distributor as (
    select distributor_code, max(distributor_name) as distributor_name, sum(sales_value)::numeric as actual_sales_value
    from all_hits
    group by distributor_code
  ),
  actuals_by_product as (
    select product_code, max(product_name) as product_name, sum(sales_value)::numeric as actual_sales_value
    from all_hits
    group by product_code
  ),
  marketing_by_line as (
    select
      line_label,
      count(*)::integer as request_count,
      sum(estimated_cost)::numeric as marketing_cost,
      sum(required_roi_value)::numeric as required_roi_value,
      sum(expected_roi_value)::numeric as expected_roi_value
    from req
    group by line_label
  ),
  marketing_region_requests as (
    select distinct
      coalesce(rt.region_code, 'Unassigned') as region_code,
      req.id,
      req.estimated_cost,
      req.required_roi_value,
      req.expected_roi_value
    from req
    join req_targets rt on rt.request_id = req.id
  ),
  marketing_by_region as (
    select
      region_code,
      count(*)::integer as request_count,
      sum(estimated_cost)::numeric as marketing_cost,
      sum(required_roi_value)::numeric as required_roi_value,
      sum(expected_roi_value)::numeric as expected_roi_value
    from marketing_region_requests
    group by region_code
  ),
  marketing_distributor_requests as (
    select distinct
      rt.distributor_code,
      rt.distributor_name,
      req.id,
      req.estimated_cost,
      req.required_roi_value,
      req.expected_roi_value
    from req
    join req_targets rt on rt.request_id = req.id
  ),
  marketing_by_distributor as (
    select
      distributor_code,
      max(distributor_name) as distributor_name,
      count(*)::integer as request_count,
      sum(estimated_cost)::numeric as marketing_cost,
      sum(required_roi_value)::numeric as required_roi_value,
      sum(expected_roi_value)::numeric as expected_roi_value
    from marketing_distributor_requests
    group by distributor_code
  ),
  marketing_by_product as (
    select
      rpa.product_code,
      max(rpa.product_name) as product_name,
      max(rpa.line_label) as line_label,
      count(distinct req.id)::integer as request_count,
      sum(req.estimated_cost * rpa.share)::numeric as marketing_cost,
      sum(req.required_roi_value * rpa.share)::numeric as required_roi_value,
      sum(rpa.expected_value)::numeric as expected_roi_value
    from req
    join request_product_allocations rpa on rpa.request_id = req.id
    group by rpa.product_code
  ),
  marketing_trend as (
    select
      to_char(date_trunc('month', pay_date), 'YYYY-MM') as period,
      count(*)::integer as request_count,
      sum(estimated_cost)::numeric as marketing_cost,
      sum(required_roi_value)::numeric as required_roi_value,
      sum(expected_roi_value)::numeric as expected_roi_value,
      sum(actual_sales_value)::numeric as actual_sales_value,
      count(*) filter (where actual_roi_status = 'on_track')::integer as on_track_count,
      count(*) filter (where actual_roi_status = 'behind')::integer as behind_count,
      count(*) filter (where actual_roi_status = 'no_data')::integer as no_data_count
    from request_rows
    group by to_char(date_trunc('month', pay_date), 'YYYY-MM')
  ),
  attribution_summary as (
    select
      coalesce(sum(exact_sales_rows), 0)::integer as exact_sales_rows,
      coalesce(sum(fallback_sales_rows), 0)::integer as fallback_sales_rows,
      count(*) filter (where attribution_quality = 'mixed')::integer as mixed_requests,
      count(*) filter (where attribution_quality = 'no_sales')::integer as no_sales_requests,
      (
        select count(*)::integer
        from req_targets rt
        where rt.brick_id is null
      ) as unmatched_mapping_count
    from request_rows
  ),
  marketing_summary as (
    select
      (select count(*)::integer from public.marketing_requests) as request_count,
      count(*)::integer as paid_request_count,
      coalesce(sum(estimated_cost), 0)::numeric as total_marketing_cost,
      coalesce(sum(required_roi_value), 0)::numeric as required_roi_value,
      coalesce(sum(expected_roi_value), 0)::numeric as expected_roi_value,
      coalesce(sum(actual_sales_value), 0)::numeric as actual_sales_value,
      count(*) filter (where actual_roi_status = 'on_track')::integer as on_track_count,
      count(*) filter (where actual_roi_status = 'behind')::integer as behind_count,
      count(*) filter (where actual_roi_status = 'no_data')::integer as no_data_count
    from request_rows
  ),
  line_comparison as (
    select
      coalesce(s.line_label, m.line_label, a.line_label) as label,
      coalesce(s.sales_value, 0)::numeric as sales_value,
      coalesce(s.sales_units, 0)::numeric as sales_units,
      coalesce(s.customer_count, 0)::integer as customer_count,
      coalesce(s.product_count, 0)::integer as product_count,
      coalesce(m.request_count, 0)::integer as request_count,
      coalesce(m.marketing_cost, 0)::numeric as marketing_cost,
      coalesce(m.required_roi_value, 0)::numeric as required_roi_value,
      coalesce(m.expected_roi_value, 0)::numeric as expected_roi_value,
      coalesce(a.actual_sales_value, 0)::numeric as actual_sales_value
    from sales_by_line s
    full join marketing_by_line m on lower(btrim(m.line_label)) = lower(btrim(s.line_label))
    full join actuals_by_line a on lower(btrim(a.line_label)) = lower(btrim(coalesce(s.line_label, m.line_label)))
  ),
  region_comparison as (
    select
      coalesce(s.region_code, m.region_code, a.region_code) as value,
      coalesce(s.region_name, a.region_name, m.region_code, 'Unassigned') as label,
      coalesce(s.sales_value, 0)::numeric as sales_value,
      coalesce(s.sales_units, 0)::numeric as sales_units,
      coalesce(s.customer_count, 0)::integer as customer_count,
      coalesce(s.product_count, 0)::integer as product_count,
      coalesce(m.request_count, 0)::integer as request_count,
      coalesce(m.marketing_cost, 0)::numeric as marketing_cost,
      coalesce(m.required_roi_value, 0)::numeric as required_roi_value,
      coalesce(m.expected_roi_value, 0)::numeric as expected_roi_value,
      coalesce(a.actual_sales_value, 0)::numeric as actual_sales_value
    from sales_by_region s
    full join marketing_by_region m on lower(btrim(m.region_code)) = lower(btrim(s.region_code))
    full join actuals_by_region a on lower(btrim(a.region_code)) = lower(btrim(coalesce(s.region_code, m.region_code)))
  ),
  distributor_comparison as (
    select
      coalesce(s.distributor_code, m.distributor_code, a.distributor_code) as value,
      coalesce(s.distributor_name, m.distributor_name, a.distributor_name, 'Unassigned') as label,
      coalesce(s.sales_value, 0)::numeric as sales_value,
      coalesce(s.sales_units, 0)::numeric as sales_units,
      coalesce(s.customer_count, 0)::integer as customer_count,
      coalesce(s.product_count, 0)::integer as product_count,
      coalesce(m.request_count, 0)::integer as request_count,
      coalesce(m.marketing_cost, 0)::numeric as marketing_cost,
      coalesce(m.required_roi_value, 0)::numeric as required_roi_value,
      coalesce(m.expected_roi_value, 0)::numeric as expected_roi_value,
      coalesce(a.actual_sales_value, 0)::numeric as actual_sales_value
    from sales_by_distributor s
    full join marketing_by_distributor m on upper(btrim(m.distributor_code)) = upper(btrim(s.distributor_code))
    full join actuals_by_distributor a on upper(btrim(a.distributor_code)) = upper(btrim(coalesce(s.distributor_code, m.distributor_code)))
  ),
  product_comparison as (
    select
      coalesce(s.product_code, m.product_code, a.product_code) as value,
      coalesce(s.product_name, m.product_name, a.product_name, 'Unassigned') as label,
      coalesce(s.line_label, m.line_label, 'Unassigned') as line_label,
      coalesce(s.sales_value, 0)::numeric as sales_value,
      coalesce(s.sales_units, 0)::numeric as sales_units,
      coalesce(s.customer_count, 0)::integer as customer_count,
      0::integer as product_count,
      coalesce(m.request_count, 0)::integer as request_count,
      coalesce(m.marketing_cost, 0)::numeric as marketing_cost,
      coalesce(m.required_roi_value, 0)::numeric as required_roi_value,
      coalesce(m.expected_roi_value, 0)::numeric as expected_roi_value,
      coalesce(a.actual_sales_value, 0)::numeric as actual_sales_value
    from sales_by_product s
    full join marketing_by_product m on upper(btrim(m.product_code)) = upper(btrim(s.product_code))
    full join actuals_by_product a on upper(btrim(a.product_code)) = upper(btrim(coalesce(s.product_code, m.product_code)))
  ),
  customer_impact as (
    select
      coalesce(nullif(client_code, ''), 'brick:' || coalesce(brick_id, 'unmapped')) as value,
      coalesce(max(client_name), max(nullif(client_code, '')), 'Brick fallback') as label,
      max(distributor_code) as distributor_code,
      max(distributor_name) as distributor_name,
      max(region_name) as region_name,
      count(distinct request_id)::integer as request_count,
      sum(units)::numeric as sales_units,
      sum(sales_value)::numeric as actual_sales_value,
      count(distinct row_id)::integer as sales_rows,
      count(distinct row_id) filter (where match_type = 'exact')::integer as exact_sales_rows,
      count(distinct row_id) filter (where match_type = 'fallback')::integer as fallback_sales_rows
    from all_hits
    group by coalesce(nullif(client_code, ''), 'brick:' || coalesce(brick_id, 'unmapped'))
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'limits', jsonb_build_object(
      'tableLimit', (select row_limit from params),
      'rawRowsReturned', 0
    ),
    'filters', jsonb_build_object(
      'selected', jsonb_build_object(
        'lines', coalesce(to_jsonb(p_lines), '[]'::jsonb),
        'regions', coalesce(to_jsonb(p_regions), '[]'::jsonb),
        'distributors', coalesce(to_jsonb(p_distributor_codes), '[]'::jsonb),
        'products', coalesce(to_jsonb(p_product_codes), '[]'::jsonb)
      ),
      'lines', (
        select coalesce(jsonb_agg(jsonb_build_object('value', label, 'label', label) order by label), '[]'::jsonb)
        from (
          select distinct coalesce(nullif(btrim(line), ''), 'Unassigned') as label
          from public.source_of_sales_products
          where active
          union
          select distinct coalesce(nullif(btrim(line), ''), 'Unassigned') as label
          from public.marketing_products
          where active
        ) options
      ),
      'regions', (
        select coalesce(jsonb_agg(jsonb_build_object('value', region_code, 'label', region_name) order by region_name), '[]'::jsonb)
        from public.source_of_sales_regions
        where active
      ),
      'distributors', (
        select coalesce(jsonb_agg(jsonb_build_object('value', distributor_code, 'label', distributor_name) order by distributor_name), '[]'::jsonb)
        from public.source_of_sales_distributors
        where active
      ),
      'products', (
        select coalesce(jsonb_agg(jsonb_build_object('value', product_code, 'label', product_name) order by product_name), '[]'::jsonb)
        from public.source_of_sales_products
        where active
      )
    ),
    'summary', (
      select jsonb_build_object(
        'totalSalesValue', ss.total_sales_value,
        'totalSalesUnits', ss.total_sales_units,
        'activeCustomers', ss.active_customers,
        'activeProducts', ss.active_products,
        'validatedPeriods', ss.validated_periods,
        'salesRowsScanned', ss.matched_sales_rows,
        'marketingRequestCount', ms.request_count,
        'paidRequestCount', ms.paid_request_count,
        'totalMarketingCost', ms.total_marketing_cost,
        'requiredRoiValue', ms.required_roi_value,
        'expectedRoiValue', ms.expected_roi_value,
        'actualAttributedSalesValue', ms.actual_sales_value,
        'actualRoiCoverage', case when ms.required_roi_value > 0 then ms.actual_sales_value / ms.required_roi_value else 0 end,
        'onTrackRequests', ms.on_track_count,
        'behindRequests', ms.behind_count,
        'noDataRequests', ms.no_data_count
      )
      from sales_summary ss cross join marketing_summary ms
    ),
    'attribution', (
      select jsonb_build_object(
        'exactSalesRows', exact_sales_rows,
        'fallbackSalesRows', fallback_sales_rows,
        'mixedRequests', mixed_requests,
        'noSalesRequests', no_sales_requests,
        'unmatchedMappingWarnings', unmatched_mapping_count
      )
      from attribution_summary
    ),
    'salesTrend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period', period,
        'salesValue', sales_value,
        'salesUnits', sales_units,
        'customerCount', customer_count,
        'productCount', product_count
      ) order by period), '[]'::jsonb)
      from sales_trend
    ),
    'marketingTrend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period', period,
        'requestCount', request_count,
        'marketingCost', marketing_cost,
        'requiredRoiValue', required_roi_value,
        'expectedRoiValue', expected_roi_value,
        'actualSalesValue', actual_sales_value,
        'onTrackCount', on_track_count,
        'behindCount', behind_count,
        'noDataCount', no_data_count
      ) order by period), '[]'::jsonb)
      from marketing_trend
    ),
    'lineComparison', (
      select coalesce(jsonb_agg(row_json order by sales_value desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', label,
          'label', label,
          'line', label,
          'salesValue', sales_value,
          'salesUnits', sales_units,
          'customerCount', customer_count,
          'productCount', product_count,
          'requestCount', request_count,
          'marketingCost', marketing_cost,
          'requiredRoiValue', required_roi_value,
          'expectedRoiValue', expected_roi_value,
          'actualSalesValue', actual_sales_value,
          'actualRoiCoverage', case when required_roi_value > 0 then actual_sales_value / required_roi_value else 0 end
        ) as row_json,
        sales_value
        from line_comparison
        order by sales_value desc
        limit (select row_limit from params)
      ) rows
    ),
    'regionComparison', (
      select coalesce(jsonb_agg(row_json order by sales_value desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', value,
          'label', label,
          'salesValue', sales_value,
          'salesUnits', sales_units,
          'customerCount', customer_count,
          'productCount', product_count,
          'requestCount', request_count,
          'marketingCost', marketing_cost,
          'requiredRoiValue', required_roi_value,
          'expectedRoiValue', expected_roi_value,
          'actualSalesValue', actual_sales_value,
          'actualRoiCoverage', case when required_roi_value > 0 then actual_sales_value / required_roi_value else 0 end
        ) as row_json,
        sales_value
        from region_comparison
        order by sales_value desc
        limit (select row_limit from params)
      ) rows
    ),
    'distributorComparison', (
      select coalesce(jsonb_agg(row_json order by sales_value desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', value,
          'label', label,
          'salesValue', sales_value,
          'salesUnits', sales_units,
          'customerCount', customer_count,
          'productCount', product_count,
          'requestCount', request_count,
          'marketingCost', marketing_cost,
          'requiredRoiValue', required_roi_value,
          'expectedRoiValue', expected_roi_value,
          'actualSalesValue', actual_sales_value,
          'actualRoiCoverage', case when required_roi_value > 0 then actual_sales_value / required_roi_value else 0 end
        ) as row_json,
        sales_value
        from distributor_comparison
        order by sales_value desc
        limit (select row_limit from params)
      ) rows
    ),
    'productComparison', (
      select coalesce(jsonb_agg(row_json order by sales_value desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', value,
          'label', label,
          'line', line_label,
          'salesValue', sales_value,
          'salesUnits', sales_units,
          'customerCount', customer_count,
          'productCount', product_count,
          'requestCount', request_count,
          'marketingCost', marketing_cost,
          'requiredRoiValue', required_roi_value,
          'expectedRoiValue', expected_roi_value,
          'actualSalesValue', actual_sales_value,
          'actualRoiCoverage', case when required_roi_value > 0 then actual_sales_value / required_roi_value else 0 end
        ) as row_json,
        sales_value
        from product_comparison
        order by sales_value desc
        limit (select row_limit from params)
      ) rows
    ),
    'requestComparison', (
      select coalesce(jsonb_agg(row_json order by actual_coverage_ratio asc, required_roi_value desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', id,
          'requestCode', request_code,
          'status', status,
          'payDate', pay_date,
          'roiDurationMonths', roi_duration_months,
          'customerName', customer_name,
          'line', line_label,
          'estimatedCost', estimated_cost,
          'requiredRoiValue', required_roi_value,
          'expectedRoiValue', expected_roi_value,
          'actualSalesValue', actual_sales_value,
          'actualSalesUnits', actual_sales_units,
          'actualRoiCoverage', actual_coverage_ratio,
          'actualRoiStatus', actual_roi_status,
          'attributionQuality', attribution_quality,
          'exactSalesRows', exact_sales_rows,
          'fallbackSalesRows', fallback_sales_rows,
          'salesRows', sales_rows
        ) as row_json,
        actual_coverage_ratio,
        required_roi_value
        from request_rows
        order by actual_coverage_ratio asc, required_roi_value desc
        limit (select row_limit from params)
      ) rows
    ),
    'customerImpact', (
      select coalesce(jsonb_agg(row_json order by actual_sales_value desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'value', value,
          'label', label,
          'distributorCode', distributor_code,
          'distributorName', distributor_name,
          'regionName', region_name,
          'requestCount', request_count,
          'actualSalesValue', actual_sales_value,
          'actualSalesUnits', sales_units,
          'salesRows', sales_rows,
          'exactSalesRows', exact_sales_rows,
          'fallbackSalesRows', fallback_sales_rows
        ) as row_json,
        actual_sales_value
        from customer_impact
        order by actual_sales_value desc
        limit (select row_limit from params)
      ) rows
    )
  );
$func$;

revoke all on function public.phx_sales_marketing_dashboard(text[], text[], text[], text[], integer, text[]) from public, anon, authenticated;
grant execute on function public.phx_sales_marketing_dashboard(text[], text[], text[], text[], integer, text[]) to service_role;

comment on function public.phx_sales_marketing_dashboard(text[], text[], text[], text[], integer, text[]) is
  'Leadership Sales & Marketing Intelligence snapshot. Aggregates validated Source-of-Sales and marketing ROI attribution in SQL, exact customer first with brick fallback, bounded JSON output, service-role only. p_exclude_codes strips confidential products (LA003/LA004/SS001) from every aggregate.';

notify pgrst, 'reload schema';
