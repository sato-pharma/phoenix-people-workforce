-- Fix: analytics.sos_fact resolves region_name ONLY through its join to
-- source_of_sales_area_regions on area_code (`ar.area_code = f.area_code`). For every Direct-channel
-- row, area_code is blank (confirmed live: 143 rows / ~5.6M EGP on production alone), so that join
-- never matches, region_name falls back to COALESCE(ar.region_name, f.region_code) -> the raw
-- region_code ("D2", "AB", "D1", "GZ", "UE", "OT", "CA" instead of "Delta (2)", "Alex-BHR", "Delta
-- (1)", ...). Every dashboard that groups by region (SoS Region Summary/By Region, Executive
-- Comparison region ranking, Reconciliation) shows a raw code label for the entire Direct channel.
--
-- analytics.weekly_fact does NOT have this bug -- it joins source_of_sales_area_regions on
-- region_code directly (`ar.region_code = r.region_code`), which resolves independently of
-- area_code. This migration brings sos_fact's region_name resolution in line with that pattern via
-- an ADDITIONAL join keyed on region_code alone (source_of_sales_area_regions is one row per area,
-- so multiple rows share a region_code -- DISTINCT ON picks one deterministically), used only as a
-- fallback when the area-keyed join has no match. area_name resolution (still area_code-keyed) is
-- unchanged -- Direct rows have no area, so area_name correctly stays blank/area_code for now (a
-- separate, smaller UX question of whether to render a "Direct (National)" placeholder, not a
-- mislabeling bug the way region_name was).
--
-- Pure additive read-side fix: no rows change, only how two already-selected columns are computed.

CREATE OR REPLACE VIEW analytics.sos_fact AS
 SELECT f.period,
    ("left"(f.period, 4))::integer AS year,
    ("right"(f.period, 2))::integer AS month,
    f.distributor_code,
    COALESCE(d.distributor_name, f.distributor_code) AS distributor_name,
    f.official_line AS line,
    f.region_code,
    COALESCE(ar.region_name, rg.region_name, f.region_code) AS region_name,
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
   FROM (((((public.source_of_sales_fact_rollup f
     JOIN public.source_of_sales_import_batches b ON (((b.id = f.batch_id) AND (b.status = 'validated'::text))))
     LEFT JOIN public.source_of_sales_products p ON ((upper(btrim(p.product_code)) = upper(btrim(f.product_code)))))
     LEFT JOIN public.source_of_sales_distributors d ON ((d.distributor_code = f.distributor_code)))
     LEFT JOIN public.source_of_sales_area_regions ar ON ((ar.area_code = f.area_code)))
     LEFT JOIN (
       SELECT DISTINCT ON (sar.region_code) sar.region_code, sar.region_name
       FROM public.source_of_sales_area_regions sar
       WHERE nullif(btrim(sar.region_code), '') IS NOT NULL
       ORDER BY sar.region_code, sar.area_code
     ) rg ON (rg.region_code = f.region_code))
  WHERE (upper(btrim(COALESCE(f.product_code, ''::text))) <> ALL (ARRAY['LA003'::text, 'LA004'::text, 'SS001'::text]))
  GROUP BY f.period, f.distributor_code, d.distributor_name, f.official_line, f.region_code, ar.region_name, rg.region_name, f.area_code, ar.area_name, f.brick_id, f.client_code, f.product_code, f.product_name, p.product_name, p.family, p.family_code, f.is_direct;
