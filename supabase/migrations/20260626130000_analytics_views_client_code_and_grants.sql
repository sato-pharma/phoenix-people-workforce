-- Delta: analytics schema view updates and access hardening.
--
-- Changes vs 20260625155000:
--   1. Grant usage on analytics schema to service_role (app code queries views directly).
--   2. Add explicit service_role grants to all dimension views (analytics_readonly already had them).
--   3. Revoke analytics_readonly from dim_products_all and sos_fact_all — these include
--      confidential products (LA003/LA004/SS001) and must not be exposed to Metabase.
--      service_role only.
--   4. Recreate analytics.sos_fact and analytics.sos_fact_all with client_code in the
--      grain (SELECT + GROUP BY) now that the rollup table has the column.
--   5. Recreate analytics.closing_fact with product_code resolved via lateral join on
--      source_of_sales_products by product_name — so product_code is available for
--      RPC filtering without a re-import.
--
-- All CREATE OR REPLACE VIEW — idempotent.

begin;

-- ── 1. Schema and dimension grants ────────────────────────────────────────────

grant usage on schema analytics to service_role;

grant select on analytics.dim_periods       to service_role;
grant select on analytics.dim_weeks         to service_role;
grant select on analytics.dim_products      to service_role;
grant select on analytics.dim_distributors  to service_role;
grant select on analytics.dim_areas         to service_role;

-- dim_products_all includes confidential products — remove from shared BI role
revoke all on analytics.dim_products_all from analytics_readonly;
grant select on analytics.dim_products_all to service_role;

-- ── 2. analytics.sos_fact — add client_code ───────────────────────────────────

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
  f.client_code,
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
where coalesce(f.product_code, '') not in ('LA003', 'LA004', 'SS001')
group by
  f.period, f.distributor_code, d.distributor_name,
  f.official_line, f.region_code, ar.region_name,
  f.area_code, ar.area_name, f.brick_id, f.client_code,
  f.product_code, f.product_name, p.product_name, p.family, p.family_code,
  f.is_direct;

grant select on analytics.sos_fact to analytics_readonly;
grant select on analytics.sos_fact to service_role;

-- ── 3. analytics.sos_fact_all — add client_code, restrict to service_role ──────

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
  f.client_code,
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
  f.area_code, ar.area_name, f.brick_id, f.client_code,
  f.product_code, f.product_name, p.product_name, p.family, p.family_code,
  f.is_direct;

revoke all on analytics.sos_fact_all from analytics_readonly;
grant select on analytics.sos_fact_all to service_role;

-- ── 4. analytics.closing_fact — add product_code via lateral join ─────────────

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
  p.product_code,
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
left join lateral (
  select sp.product_code
  from public.source_of_sales_products sp
  where lower(btrim(sp.product_name)) = lower(btrim(r.product))
  order by sp.active desc, sp.product_code
  limit 1
) p on true
where b.status = 'approved'
  and lower(btrim(r.product)) not in ('lacto basic 1', 'lacto basic 2', 'satoslim');

grant select on analytics.closing_fact to analytics_readonly;
grant select on analytics.closing_fact to service_role;

commit;
