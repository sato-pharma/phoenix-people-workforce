-- analytics.sos_fact and analytics.sos_fact_all value each month at THAT month's factory price.
--
-- Saginko (SA001) is 111.15 through 2026-09 and 170.52 from 2026-10 (owner, 2026-09-28), while
-- source_of_sales_products.factory_price stays 111.15 on purpose; the dated override lives in
-- source_of_sales_product_price_history (20260928184100_period_scoped_factory_prices.sql). Every
-- closing and attribution function was repointed then, but these two VIEWS were not: both still
-- valued a distributor row as `effective_units * coalesce(p.factory_price, 0)`, the flat master
-- price, in every month. analytics.sos_fact_all feeds the CEO command center's IMS contribution
-- panel (src/lib/sales/sfe-performance.ts), so from October Saginko would enter its area shares at
-- 111.15 beside a closing at 170.52.
--
-- The lookup is INLINED here — the override covering the row's period, else the master price, the
-- exact rule of public.phx_factory_price(code, period) — rather than a call to that function. A view
-- runs the functions it calls with the READER's rights, and phx_factory_price is executable by
-- service_role and postgres only, so calling it would refuse analytics_readonly and
-- analytics_privileged, who read these views. Tables, by contrast, are read with the view OWNER's
-- rights (postgres, which owns source_of_sales_product_price_history), so the inlined read needs no
-- new grant. au.f_monthly_attribution and public.phx_closing_customers inline the same lookup.
--
-- Read-side only: no row changes, the column list is identical, the grants are kept. Every product
-- with no override row is valued exactly as before, and no override covers any month before
-- 2026-10, so January through September read the same to the cent.
--
-- Each view is otherwise reproduced exactly as production holds it (pg_get_viewdef, 2026-10-01):
-- sos_fact keeps its confidential-product exclusion and its region-name fallback join
-- (20260719153000, 20260719161000); sos_fact_all keeps neither, as before.

create or replace view analytics.sos_fact as
 select f.period,
    ("left"(f.period, 4))::integer as year,
    ("right"(f.period, 2))::integer as month,
    f.distributor_code,
    coalesce(d.distributor_name, f.distributor_code) as distributor_name,
    f.official_line as line,
    f.region_code,
    coalesce(ar.region_name, rg.region_name, f.region_code) as region_name,
    f.area_code,
    coalesce(ar.area_name, f.area_code) as area_name,
    f.brick_id,
    f.product_code,
    coalesce(p.product_name, f.product_name) as product_name,
    coalesce(p.family, ''::text) as family,
    coalesce(p.family_code, ''::text) as family_code,
    f.is_direct,
        case
            when f.is_direct then 'Direct'::text
            else 'Distributor'::text
        end as channel,
    sum(f.total_qty) as units,
    sum(f.total_bonus_qty) as bonus_units,
    sum(
        case
            when f.is_direct then f.direct_value
            else (f.effective_units * coalesce(dated.factory_price, p.factory_price, (0)::numeric))
        end) as value,
    f.client_code
   from public.source_of_sales_fact_rollup f
     join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'::text
     left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
     left join lateral (
       select h.factory_price
         from public.source_of_sales_product_price_history h
        where upper(btrim(h.product_code)) = upper(btrim(f.product_code))
          and h.effective_period <= f.period
        order by h.effective_period desc
        limit 1
     ) dated on true
     left join public.source_of_sales_distributors d on d.distributor_code = f.distributor_code
     left join public.source_of_sales_area_regions ar on ar.area_code = f.area_code
     left join (
       select distinct on (sar.region_code) sar.region_code, sar.region_name
       from public.source_of_sales_area_regions sar
       where nullif(btrim(sar.region_code), '') is not null
       order by sar.region_code, sar.area_code
     ) rg on rg.region_code = f.region_code
  where upper(btrim(coalesce(f.product_code, ''::text))) <> all (array['LA003'::text, 'LA004'::text, 'SS001'::text])
  group by f.period, f.distributor_code, d.distributor_name, f.official_line, f.region_code, ar.region_name, rg.region_name, f.area_code, ar.area_name, f.brick_id, f.client_code, f.product_code, f.product_name, p.product_name, p.family, p.family_code, f.is_direct;

create or replace view analytics.sos_fact_all as
 select f.period,
    ("left"(f.period, 4))::integer as year,
    ("right"(f.period, 2))::integer as month,
    f.distributor_code,
    coalesce(d.distributor_name, f.distributor_code) as distributor_name,
    f.official_line as line,
    f.region_code,
    coalesce(ar.region_name, f.region_code) as region_name,
    f.area_code,
    coalesce(ar.area_name, f.area_code) as area_name,
    f.brick_id,
    f.product_code,
    coalesce(p.product_name, f.product_name) as product_name,
    coalesce(p.family, ''::text) as family,
    coalesce(p.family_code, ''::text) as family_code,
    f.is_direct,
        case
            when f.is_direct then 'Direct'::text
            else 'Distributor'::text
        end as channel,
    sum(f.total_qty) as units,
    sum(f.total_bonus_qty) as bonus_units,
    sum(
        case
            when f.is_direct then f.direct_value
            else (f.effective_units * coalesce(dated.factory_price, p.factory_price, (0)::numeric))
        end) as value,
    f.client_code
   from public.source_of_sales_fact_rollup f
     join public.source_of_sales_import_batches b on b.id = f.batch_id and b.status = 'validated'::text
     left join public.source_of_sales_products p on upper(btrim(p.product_code)) = upper(btrim(f.product_code))
     left join lateral (
       select h.factory_price
         from public.source_of_sales_product_price_history h
        where upper(btrim(h.product_code)) = upper(btrim(f.product_code))
          and h.effective_period <= f.period
        order by h.effective_period desc
        limit 1
     ) dated on true
     left join public.source_of_sales_distributors d on d.distributor_code = f.distributor_code
     left join public.source_of_sales_area_regions ar on ar.area_code = f.area_code
  group by f.period, f.distributor_code, d.distributor_name, f.official_line, f.region_code, ar.region_name, f.area_code, ar.area_name, f.brick_id, f.client_code, f.product_code, f.product_name, p.product_name, p.family, p.family_code, f.is_direct;
