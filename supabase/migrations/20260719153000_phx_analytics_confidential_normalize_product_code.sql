-- Confidential-product exclusion hardening for the new `analytics` schema views that back the
-- Sales Analytics dashboards (SoS / Weekly / dimension products), which went live in the employee
-- portal at /employee-portals/sales-analytics on 2026-07-18 (dual-mode routing).
--
-- Root cause: analytics.sos_fact, analytics.weekly_fact, and analytics.dim_products exclude the
-- confidential products (LA003 / LA004 "Lacto Basic 1 & 2", SS001 "Satoslim") with a RAW,
-- case-sensitive, non-trimmed literal comparison:
--
--     WHERE product_code <> ALL (ARRAY['LA003','LA004','SS001'])
--
-- Every other confidential-product guard in this codebase -- the phx_exec_* / phx_si_* RPCs
-- (e.g. phx_exec_distributor_product, phx_exec_brick, phx_exec_customers), the
-- present_nonexcluded flag in phx_refresh_sos_fact_rollup, and every TypeScript check in
-- src/lib/sales/access-scope.ts -- normalizes with upper(btrim(...)) before comparing, precisely
-- because product_code has no DB-level CHECK/trigger guaranteeing canonical casing; it depends
-- entirely on the writing code path (normalizeCode / normalizeCodeKey) always running first.
-- These three views are the only exceptions, so a differently-cased or whitespace-padded
-- product_code on any row that reaches source_of_sales_fact_rollup, weekly_sales_rows, or
-- source_of_sales_products (e.g. a legacy backfill, a future import path, or a manual
-- Database Mapping row) would silently defeat the exclusion here even though it is correctly
-- excluded everywhere else -- exactly the "value visible without the product ever being named"
-- pattern this migration closes. Every dashboard built on these views (SoS, Weekly, Executive
-- Comparison, Reconciliation, and every product/line filter dropdown) inherits the fix, since
-- sos_by_line / sos_by_period / sos_by_product / sos_by_distributor / sos_by_family /
-- cross_source_period_line all read through analytics.sos_fact / analytics.weekly_fact.
--
-- Pure hardening: normalizing the comparison can only ever EXCLUDE more rows that were
-- previously slipping through on a casing/whitespace technicality, never include fewer.
-- analytics.closing_fact and analytics.sos_by_customer already normalize correctly (name-based
-- lower(btrim(...)) and the pre-normalized present_nonexcluded flag, respectively) and are
-- untouched here.

CREATE OR REPLACE VIEW analytics.sos_fact AS
 SELECT f.period,
    ("left"(f.period, 4))::integer AS year,
    ("right"(f.period, 2))::integer AS month,
    f.distributor_code,
    COALESCE(d.distributor_name, f.distributor_code) AS distributor_name,
    f.official_line AS line,
    f.region_code,
    COALESCE(ar.region_name, f.region_code) AS region_name,
    f.area_code,
    COALESCE(ar.area_name, f.area_code) AS area_name,
    f.brick_id,
    f.product_code,
    COALESCE(p.product_name, f.product_name) AS product_name,
    COALESCE(p.family, ''::text) AS family,
    COALESCE(p.family_code, ''::text) AS family_code,
    f.is_direct,
        CASE
            WHEN f.is_direct THEN 'Direct'::text
            ELSE 'Distributor'::text
        END AS channel,
    sum(f.total_qty) AS units,
    sum(f.total_bonus_qty) AS bonus_units,
    sum(
        CASE
            WHEN f.is_direct THEN f.direct_value
            ELSE (f.effective_units * COALESCE(p.factory_price, (0)::numeric))
        END) AS value,
    f.client_code
   FROM ((((public.source_of_sales_fact_rollup f
     JOIN public.source_of_sales_import_batches b ON (((b.id = f.batch_id) AND (b.status = 'validated'::text))))
     LEFT JOIN public.source_of_sales_products p ON ((upper(btrim(p.product_code)) = upper(btrim(f.product_code)))))
     LEFT JOIN public.source_of_sales_distributors d ON ((d.distributor_code = f.distributor_code)))
     LEFT JOIN public.source_of_sales_area_regions ar ON ((ar.area_code = f.area_code)))
  WHERE (upper(btrim(COALESCE(f.product_code, ''::text))) <> ALL (ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text]))
  GROUP BY f.period, f.distributor_code, d.distributor_name, f.official_line, f.region_code, ar.region_name, f.area_code, ar.area_name, f.brick_id, f.client_code, f.product_code, f.product_name, p.product_name, p.family, p.family_code, f.is_direct;

CREATE OR REPLACE VIEW analytics.weekly_fact AS
 SELECT b.week_start,
    (EXTRACT(year FROM b.week_start))::integer AS year,
    (EXTRACT(month FROM b.week_start))::integer AS month,
    (EXTRACT(week FROM b.week_start))::integer AS iso_week,
    to_char((b.week_start)::timestamp with time zone, 'YYYY-"W"IW'::text) AS week_label,
    "left"(to_char((b.week_start)::timestamp with time zone, 'YYYY-MM'::text), 7) AS period,
    r.distributor_code,
    COALESCE(d.distributor_name, r.distributor_name) AS distributor_name,
    r.region_code,
    COALESCE(ar.region_name, r.region_name) AS region_name,
    r.branch_code,
    r.branch_name,
    r.product_code,
    COALESCE(p.product_name, r.product_name) AS product_name,
    COALESCE(p.family, ''::text) AS family,
    COALESCE(p.family_code, ''::text) AS family_code,
    r.official_line AS line,
    sum(r.sales_qty) AS sales_qty,
    sum(r.bonus_qty) AS bonus_qty,
    sum(r.sales_value) AS sales_value,
    sum(r.stock_qty) AS stock_qty
   FROM ((((public.weekly_sales_rows r
     JOIN public.weekly_sales_batches b ON (((b.id = r.batch_id) AND (b.status = 'validated'::text))))
     LEFT JOIN public.source_of_sales_products p ON ((upper(btrim(p.product_code)) = upper(btrim(r.product_code)))))
     LEFT JOIN public.source_of_sales_distributors d ON ((d.distributor_code = r.distributor_code)))
     LEFT JOIN public.source_of_sales_area_regions ar ON ((ar.region_code = r.region_code)))
  WHERE ((upper(btrim(COALESCE(r.product_code, ''::text))) <> ALL (ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])) AND (r.validation_state = ANY (ARRAY['valid'::text, 'warning'::text])))
  GROUP BY b.week_start, r.distributor_code, d.distributor_name, r.distributor_name, r.region_code, ar.region_name, r.region_name, r.branch_code, r.branch_name, r.product_code, p.product_name, r.product_name, p.family, p.family_code, r.official_line;

CREATE OR REPLACE VIEW analytics.dim_products AS
 SELECT product_code,
    product_name,
    family,
    family_code,
    line,
    factory_price,
    active
   FROM public.source_of_sales_products
  WHERE ((upper(btrim(COALESCE(product_code, ''::text))) <> ALL (ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text])) AND (active = true));
