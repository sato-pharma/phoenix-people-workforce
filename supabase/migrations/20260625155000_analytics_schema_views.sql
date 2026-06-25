-- Analytics schema: read-only views for BI/Metabase over the three sales pipelines.
--
-- Three pipelines, three view families, one unified view:
--   1. source_of_sales_*  → analytics.sos_*   (distributor invoice aggregates)
--   2. sales_records / sales_import_batches → analytics.closing_*  (monthly closing)
--   3. weekly_sales_*    → analytics.weekly_*  (weekly distributor files)
--
-- Rules:
--   • No raw invoice rows exposed — always aggregated to the brick/product/period grain.
--   • Confidential products (LA003, LA004, SS001) are EXCLUDED from all standard views.
--     CEO/admin-only "_all" variants include them explicitly.
--   • These are regular (not materialized) views — performance handled by the underlying
--     source_of_sales_fact_rollup and its indexes.
--   • analytics_readonly role gets SELECT on the analytics schema only; service_role
--     retains full access to public schema tables.
--   • All views are SECURITY INVOKER (default) — Metabase connects as analytics_readonly.

begin;

-- ── Schema ────────────────────────────────────────────────────────────────────

create schema if not exists analytics;

-- ── Read-only role for Metabase ───────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'analytics_readonly') then
    create role analytics_readonly nologin noinherit;
  end if;
end $$;

grant usage on schema analytics to analytics_readonly;
-- Default privilege: any future view in analytics schema is auto-granted
alter default privileges in schema analytics grant select on tables to analytics_readonly;

-- ── Confidential product codes (single source of truth matching access-scope.ts) ─

-- Used as inline filter in every standard view.
-- "Nonconfidential" = not in this set.

-- ═══════════════════════════════════════════════════════════════════════════════
-- DIMENSION VIEWS  (no numeric facts — pure lookup/filter helpers for Metabase)
-- ═══════════════════════════════════════════════════════════════════════════════

-- All active periods from the SoS pipeline
create or replace view analytics.dim_periods as
select distinct
  b.period,
  left(b.period, 4)::integer                          as year,
  right(b.period, 2)::integer                         as month,
  to_char(to_date(b.period, 'YYYY-MM'), 'Month YYYY') as period_label
from public.source_of_sales_import_batches b
where b.status = 'validated'
  and b.period is not null
order by b.period desc;

grant select on analytics.dim_periods to analytics_readonly;

-- All active weeks from the weekly pipeline
create or replace view analytics.dim_weeks as
select distinct
  b.week_start,
  extract(year  from b.week_start)::integer as year,
  extract(month from b.week_start)::integer as month,
  extract(week  from b.week_start)::integer as iso_week,
  to_char(b.week_start, 'YYYY-"W"IW')      as week_label
from public.weekly_sales_batches b
where b.status = 'validated'
  and b.week_start is not null
order by b.week_start desc;

grant select on analytics.dim_weeks to analytics_readonly;

-- Product dimension (excludes confidential by default)
create or replace view analytics.dim_products as
select
  product_code,
  product_name,
  family,
  family_code,
  line,
  factory_price,
  active
from public.source_of_sales_products
where product_code not in ('LA003', 'LA004', 'SS001')
  and active = true;

grant select on analytics.dim_products to analytics_readonly;

-- Product dimension including confidential (CEO/admin Metabase questions only)
create or replace view analytics.dim_products_all as
select
  product_code,
  product_name,
  family,
  family_code,
  line,
  factory_price,
  active
from public.source_of_sales_products
where active = true;

grant select on analytics.dim_products_all to analytics_readonly;

-- Distributor dimension
create or replace view analytics.dim_distributors as
select
  distributor_code,
  distributor_name,
  active
from public.source_of_sales_distributors
where active = true;

grant select on analytics.dim_distributors to analytics_readonly;

-- Region + area hierarchy
create or replace view analytics.dim_areas as
select
  area_code,
  area_name,
  region_code,
  region_name,
  active
from public.source_of_sales_area_regions
where active = true
order by region_name, area_name;

grant select on analytics.dim_areas to analytics_readonly;

-- ═══════════════════════════════════════════════════════════════════════════════
-- SOURCE OF SALES FACT VIEWS  (from source_of_sales_fact_rollup)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Core SoS fact — by period × distributor × line × region × area × brick × product
-- Excludes confidential products. Joins factory_price live.
create or replace view analytics.sos_fact as
select
  f.period,
  left(f.period, 4)::integer                          as year,
  right(f.period, 2)::integer                         as month,
  f.distributor_code,
  coalesce(d.distributor_name, f.distributor_code)    as distributor_name,
  f.official_line                                     as line,
  f.region_code,
  coalesce(ar.region_name, f.region_code)             as region_name,
  f.area_code,
  coalesce(ar.area_name,   f.area_code)               as area_name,
  f.brick_id,
  f.product_code,
  coalesce(p.product_name, f.product_name)            as product_name,
  coalesce(p.family,       '')                        as family,
  coalesce(p.family_code,  '')                        as family_code,
  f.is_direct,
  case when f.is_direct then 'Direct' else 'Distributor' end as channel,
  -- Units: total_qty (excludes bonus)
  sum(f.total_qty)                                    as units,
  -- Bonus units
  sum(f.total_bonus_qty)                              as bonus_units,
  -- Value: direct = stored value; distributor = effective_units × factory_price
  sum(case
        when f.is_direct then f.direct_value
        else f.effective_units * coalesce(p.factory_price, 0)
      end)                                            as value
from public.source_of_sales_fact_rollup f
join public.source_of_sales_import_batches b
  on b.id = f.batch_id and b.status = 'validated'
left join public.source_of_sales_products p
  on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
left join public.source_of_sales_distributors d
  on d.distributor_code = f.distributor_code
left join public.source_of_sales_area_regions ar
  on ar.area_code = f.area_code
-- Exclude confidential products from standard view
where coalesce(f.product_code, '') not in ('LA003', 'LA004', 'SS001')
group by
  f.period, f.distributor_code, d.distributor_name,
  f.official_line, f.region_code, ar.region_name,
  f.area_code, ar.area_name, f.brick_id,
  f.product_code, f.product_name, p.product_name, p.family, p.family_code,
  f.is_direct;

grant select on analytics.sos_fact to analytics_readonly;

-- Same view WITH confidential products (CEO/admin only)
create or replace view analytics.sos_fact_all as
select
  f.period,
  left(f.period, 4)::integer                          as year,
  right(f.period, 2)::integer                         as month,
  f.distributor_code,
  coalesce(d.distributor_name, f.distributor_code)    as distributor_name,
  f.official_line                                     as line,
  f.region_code,
  coalesce(ar.region_name, f.region_code)             as region_name,
  f.area_code,
  coalesce(ar.area_name,   f.area_code)               as area_name,
  f.brick_id,
  f.product_code,
  coalesce(p.product_name, f.product_name)            as product_name,
  coalesce(p.family,       '')                        as family,
  coalesce(p.family_code,  '')                        as family_code,
  f.is_direct,
  case when f.is_direct then 'Direct' else 'Distributor' end as channel,
  sum(f.total_qty)                                    as units,
  sum(f.total_bonus_qty)                              as bonus_units,
  sum(case
        when f.is_direct then f.direct_value
        else f.effective_units * coalesce(p.factory_price, 0)
      end)                                            as value
from public.source_of_sales_fact_rollup f
join public.source_of_sales_import_batches b
  on b.id = f.batch_id and b.status = 'validated'
left join public.source_of_sales_products p
  on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
left join public.source_of_sales_distributors d
  on d.distributor_code = f.distributor_code
left join public.source_of_sales_area_regions ar
  on ar.area_code = f.area_code
group by
  f.period, f.distributor_code, d.distributor_name,
  f.official_line, f.region_code, ar.region_name,
  f.area_code, ar.area_name, f.brick_id,
  f.product_code, f.product_name, p.product_name, p.family, p.family_code,
  f.is_direct;

grant select on analytics.sos_fact_all to analytics_readonly;

-- ── Rollup views ──────────────────────────────────────────────────────────────

-- SoS by period (trend over time — monthly totals)
create or replace view analytics.sos_by_period as
select
  period, year, month, channel,
  sum(units)       as units,
  sum(bonus_units) as bonus_units,
  sum(value)       as value
from analytics.sos_fact
group by period, year, month, channel;

grant select on analytics.sos_by_period to analytics_readonly;

-- SoS by distributor × period
create or replace view analytics.sos_by_distributor as
select
  period, year, month,
  distributor_code, distributor_name,
  channel,
  sum(units) as units,
  sum(value) as value
from analytics.sos_fact
group by period, year, month, distributor_code, distributor_name, channel;

grant select on analytics.sos_by_distributor to analytics_readonly;

-- SoS by line × period
create or replace view analytics.sos_by_line as
select
  period, year, month,
  line,
  channel,
  sum(units) as units,
  sum(value) as value
from analytics.sos_fact
group by period, year, month, line, channel;

grant select on analytics.sos_by_line to analytics_readonly;

-- SoS by region × area × period
create or replace view analytics.sos_by_area as
select
  period, year, month,
  region_code, region_name,
  area_code,  area_name,
  channel,
  sum(units) as units,
  sum(value) as value
from analytics.sos_fact
group by period, year, month, region_code, region_name, area_code, area_name, channel;

grant select on analytics.sos_by_area to analytics_readonly;

-- SoS by brick × period (most granular geography)
create or replace view analytics.sos_by_brick as
select
  period, year, month,
  region_code, region_name,
  area_code,  area_name,
  brick_id,
  channel,
  sum(units) as units,
  sum(value) as value
from analytics.sos_fact
where brick_id is not null and btrim(brick_id) <> ''
group by period, year, month, region_code, region_name, area_code, area_name, brick_id, channel;

grant select on analytics.sos_by_brick to analytics_readonly;

-- SoS by product × period
create or replace view analytics.sos_by_product as
select
  period, year, month,
  product_code, product_name,
  family, family_code,
  line,
  channel,
  sum(units) as units,
  sum(value) as value
from analytics.sos_fact
group by period, year, month, product_code, product_name, family, family_code, line, channel;

grant select on analytics.sos_by_product to analytics_readonly;

-- SoS by family × period
create or replace view analytics.sos_by_family as
select
  period, year, month,
  family, family_code,
  line,
  channel,
  sum(units) as units,
  sum(value) as value
from analytics.sos_fact
group by period, year, month, family, family_code, line, channel;

grant select on analytics.sos_by_family to analytics_readonly;

-- SoS customer presence by period × region (from customer_presence_rollup)
create or replace view analytics.sos_by_customer as
select
  cp.period,
  left(cp.period, 4)::integer                          as year,
  right(cp.period, 2)::integer                         as month,
  cp.client_code,
  cp.official_line                                     as line,
  cp.region_code,
  coalesce(ar.region_name, cp.region_code)             as region_name,
  count(*) filter (where cp.present_nonexcluded)       as active_batches
from public.source_of_sales_customer_presence_rollup cp
join public.source_of_sales_import_batches b
  on b.id = cp.batch_id and b.status = 'validated'
left join public.source_of_sales_area_regions ar
  on ar.region_code = cp.region_code
group by cp.period, cp.client_code, cp.official_line, cp.region_code, ar.region_name;

grant select on analytics.sos_by_customer to analytics_readonly;

-- ═══════════════════════════════════════════════════════════════════════════════
-- MONTHLY CLOSING FACT VIEWS  (from sales_records / sales_import_batches)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Monthly closing fact — employee-attributed, target vs actual
-- Excludes confidential products by name (legacy pipeline has no product_code column).
create or replace view analytics.closing_fact as
select
  r.year,
  r.month,
  lpad(r.month::text, 2, '0')                          as month_str,
  r.year::text || '-' || lpad(r.month::text, 2, '0')   as period,
  b.id                                                  as batch_id,
  b.file_name                                           as batch_file,
  b.status                                              as batch_status,
  b.line,
  r.employee_hr_id,
  r.employee_name,
  r.manager_hr_id,
  r.territory,
  r.sales_type,
  r.product,
  r.family,
  r.sales_units,
  r.sales_value,
  r.target_units,
  r.target_value,
  r.validation_state,
  r.link_status,
  case
    when r.target_value > 0
    then round((r.sales_value / r.target_value * 100)::numeric, 2)
    else null
  end as achievement_pct
from public.sales_records r
left join public.sales_import_batches b on b.id = r.batch_id
where b.status = 'approved'
  -- Strip confidential products by normalized name
  and lower(btrim(r.product)) not in ('lacto basic 1', 'lacto basic 2', 'satoslim');

grant select on analytics.closing_fact to analytics_readonly;

-- Monthly closing summary by period × line × employee
create or replace view analytics.closing_by_employee as
select
  year, month, period,
  batch_id, line,
  employee_hr_id, employee_name, manager_hr_id,
  territory,
  sum(sales_value)   as sales_value,
  sum(target_value)  as target_value,
  sum(sales_units)   as sales_units,
  sum(target_units)  as target_units,
  case
    when sum(target_value) > 0
    then round((sum(sales_value) / sum(target_value) * 100)::numeric, 2)
    else null
  end as achievement_pct
from analytics.closing_fact
group by year, month, period, batch_id, line, employee_hr_id, employee_name, manager_hr_id, territory;

grant select on analytics.closing_by_employee to analytics_readonly;

-- Monthly closing summary by period × product
create or replace view analytics.closing_by_product as
select
  year, month, period, batch_id, line,
  product, family,
  sum(sales_value)   as sales_value,
  sum(target_value)  as target_value,
  sum(sales_units)   as sales_units,
  sum(target_units)  as target_units,
  case
    when sum(target_value) > 0
    then round((sum(sales_value) / sum(target_value) * 100)::numeric, 2)
    else null
  end as achievement_pct
from analytics.closing_fact
group by year, month, period, batch_id, line, product, family;

grant select on analytics.closing_by_product to analytics_readonly;

-- Monthly closing summary by period × line (line-level totals)
create or replace view analytics.closing_by_line as
select
  year, month, period, batch_id, line,
  sum(sales_value)   as sales_value,
  sum(target_value)  as target_value,
  sum(sales_units)   as sales_units,
  sum(target_units)  as target_units,
  case
    when sum(target_value) > 0
    then round((sum(sales_value) / sum(target_value) * 100)::numeric, 2)
    else null
  end as achievement_pct
from analytics.closing_fact
group by year, month, period, batch_id, line;

grant select on analytics.closing_by_line to analytics_readonly;

-- ═══════════════════════════════════════════════════════════════════════════════
-- WEEKLY SALES FACT VIEWS  (from weekly_sales_batches / weekly_sales_rows)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Weekly fact — by week × distributor × region × branch × product
create or replace view analytics.weekly_fact as
select
  b.week_start,
  extract(year  from b.week_start)::integer          as year,
  extract(month from b.week_start)::integer          as month,
  extract(week  from b.week_start)::integer          as iso_week,
  to_char(b.week_start, 'YYYY-"W"IW')               as week_label,
  left(to_char(b.week_start, 'YYYY-MM'), 7)         as period,
  r.distributor_code,
  coalesce(d.distributor_name, r.distributor_name)  as distributor_name,
  r.region_code,
  coalesce(ar.region_name, r.region_name)           as region_name,
  r.branch_code,
  r.branch_name,
  r.product_code,
  coalesce(p.product_name, r.product_name)          as product_name,
  coalesce(p.family,       '')                      as family,
  coalesce(p.family_code,  '')                      as family_code,
  r.official_line                                   as line,
  -- Quantities
  sum(r.sales_qty)   as sales_qty,
  sum(r.bonus_qty)   as bonus_qty,
  sum(r.sales_value) as sales_value,
  -- Stock units only (no stock value by design)
  sum(r.stock_qty)   as stock_qty
from public.weekly_sales_rows r
join public.weekly_sales_batches b
  on b.id = r.batch_id and b.status = 'validated'
left join public.source_of_sales_products p
  on upper(btrim(p.product_code)) = upper(btrim(r.product_code))
left join public.source_of_sales_distributors d
  on d.distributor_code = r.distributor_code
left join public.source_of_sales_area_regions ar
  on ar.region_code = r.region_code
-- Exclude confidential products
where coalesce(r.product_code, '') not in ('LA003', 'LA004', 'SS001')
  and r.validation_state in ('valid', 'warning')
group by
  b.week_start, r.distributor_code, d.distributor_name, r.distributor_name,
  r.region_code, ar.region_name, r.region_name,
  r.branch_code, r.branch_name,
  r.product_code, p.product_name, r.product_name,
  p.family, p.family_code, r.official_line;

grant select on analytics.weekly_fact to analytics_readonly;

-- Weekly by distributor × week
create or replace view analytics.weekly_by_distributor as
select
  week_start, year, month, iso_week, week_label, period,
  distributor_code, distributor_name,
  sum(sales_qty)   as sales_qty,
  sum(sales_value) as sales_value,
  sum(stock_qty)   as stock_qty
from analytics.weekly_fact
group by week_start, year, month, iso_week, week_label, period, distributor_code, distributor_name;

grant select on analytics.weekly_by_distributor to analytics_readonly;

-- Weekly by product × week
create or replace view analytics.weekly_by_product as
select
  week_start, year, month, iso_week, week_label, period,
  product_code, product_name, family, family_code, line,
  sum(sales_qty)   as sales_qty,
  sum(sales_value) as sales_value,
  sum(stock_qty)   as stock_qty
from analytics.weekly_fact
group by week_start, year, month, iso_week, week_label, period, product_code, product_name, family, family_code, line;

grant select on analytics.weekly_by_product to analytics_readonly;

-- Weekly by region × week
create or replace view analytics.weekly_by_region as
select
  week_start, year, month, iso_week, week_label, period,
  region_code, region_name,
  sum(sales_qty)   as sales_qty,
  sum(sales_value) as sales_value,
  sum(stock_qty)   as stock_qty
from analytics.weekly_fact
group by week_start, year, month, iso_week, week_label, period, region_code, region_name;

grant select on analytics.weekly_by_region to analytics_readonly;

-- ═══════════════════════════════════════════════════════════════════════════════
-- CROSS-SOURCE COMPARISON VIEW
-- Aligns SoS and monthly closing on the same (period × line) grain for comparison.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace view analytics.cross_source_period_line as
with sos as (
  select period, line, sum(value) as sos_value, sum(units) as sos_units
  from analytics.sos_by_line
  group by period, line
),
closing as (
  select period, line, sum(sales_value) as closing_value, sum(sales_units) as closing_units,
         sum(target_value) as target_value, sum(target_units) as target_units
  from analytics.closing_by_line
  group by period, line
),
weekly as (
  select period, line,
         sum(sales_value) as weekly_value, sum(sales_qty) as weekly_units
  from analytics.weekly_fact
  group by period, line
)
select
  coalesce(s.period,  c.period,  w.period)  as period,
  coalesce(s.line,    c.line,    w.line)    as line,
  s.sos_value,
  s.sos_units,
  c.closing_value,
  c.closing_units,
  c.target_value,
  c.target_units,
  w.weekly_value,
  w.weekly_units,
  -- Growth / achievement helpers (null-safe)
  case when c.target_value > 0
       then round((c.closing_value / c.target_value * 100)::numeric, 2)
       else null end as closing_achievement_pct,
  case when s.sos_value > 0 and c.closing_value is not null
       then round(((c.closing_value - s.sos_value) / s.sos_value * 100)::numeric, 2)
       else null end as closing_vs_sos_gap_pct
from sos s
full outer join closing c using (period, line)
full outer join weekly  w using (period, line);

grant select on analytics.cross_source_period_line to analytics_readonly;

-- ── Grant execute on existing phx_* RPCs to analytics_readonly ────────────────
-- These RPCs are security definer and handle confidential filtering internally.
-- analytics_readonly can call them but never directly read the underlying tables.

grant execute on function public.phx_exec_brick(text)                  to analytics_readonly;
grant execute on function public.phx_exec_distributor_product(text)    to analytics_readonly;
grant execute on function public.phx_exec_customers(text)              to analytics_readonly;
grant execute on function public.phx_monthly_closing_matrix(text, text) to analytics_readonly;
grant execute on function public.phx_monthly_closing_direct(text, text) to analytics_readonly;

commit;
