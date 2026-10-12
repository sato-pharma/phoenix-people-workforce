-- REVIEW ONLY. NOT applied, NOT in supabase/migrations/. Runs in the PHOENIX (source) database, which the
-- approved non-production rehearsal must prove first; production needs its own separate approval.
--
-- Why it exists: Phoenix does not maintain updated_at on UPDATE (no trigger exists on any watched table),
-- and the closing engine reads through RPCs, views and rollups that PostgREST cannot stamp. A change
-- watermark has to be computed where the data lives. Per watched source this returns an exact row count,
-- the newest app-written change stamp (informational only) and a CONTENT FINGERPRINT: md5 over every
-- (primary key, xmin) pair. Any insert, delete or update changes the row set or an xmin, whether or not
-- the application touched updated_at. One STABLE plpgsql function runs under one snapshot, so all
-- sources are mutually consistent.
--
-- Read-only, SECURITY INVOKER, executable by service_role only. Cost is O(rows of the watched sources
-- for the requested period); the rehearsal must measure it against the real statement timeout.
CREATE OR REPLACE FUNCTION public.phoenix_mcp_source_watermark(p_sources text[], p_period text DEFAULT NULL)
RETURNS TABLE(source text, rows bigint, stamp timestamptz, digest text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE r record; stamp_sql text; where_sql text;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('employees','public.employees','hr_id','updated_at',NULL),
  ('departments','public.departments','id','updated_at',NULL),
  ('lines','public.lines','id','updated_at',NULL),
  ('areas','public.areas','id','updated_at',NULL),
  ('positions','public.positions','id','updated_at',NULL),
  ('teams','public.teams','id','updated_at',NULL),
  ('position_vacancies','public.position_vacancies','id','updated_at',NULL),
  ('offers','public.offers','id','updated_at',NULL),
  ('app_auth_users','public.app_auth_users','login_id','updated_at',NULL),
  ('au_seats','au.seats','seat_id',NULL,NULL),
  ('au_occupancy','au.occupancy_history','occupancy_id','created_at',NULL),
  ('au_canonical_areas','au.canonical_areas','area_code',NULL,NULL),
  ('au_regions','au.regions','region_code',NULL,NULL),
  ('au_lines','au.lines','line_code',NULL,NULL),
  ('au_line_area_map','au.line_area_map','(line_code||''/''||area_code||''/''||effective_from::text)',NULL,NULL),
  ('monthly_closing_publications','public.monthly_closing_publications','id','published_at',NULL),
  ('monthly_closing_locks','public.monthly_closing_locks','id','locked_at',NULL),
  ('source_of_sales_import_batches','public.source_of_sales_import_batches','id','updated_at',NULL),
  ('source_of_sales_import_rows','public.source_of_sales_import_rows','id','created_at','invoice_period'),
  ('source_of_sales_fact_rollup','public.source_of_sales_fact_rollup','id','created_at','period'),
  ('source_of_sales_channel_customer_rollup','public.source_of_sales_channel_customer_rollup','id',NULL,'period'),
  ('source_of_sales_distributor_product_rollup','public.source_of_sales_distributor_product_rollup','id',NULL,'period'),
  ('source_of_sales_customer_map','public.source_of_sales_customer_map','id','updated_at',NULL),
  ('source_of_sales_bricks','public.source_of_sales_bricks','brick_id','updated_at',NULL),
  ('source_of_sales_regions','public.source_of_sales_regions','region_code','updated_at',NULL),
  ('source_of_sales_areas','public.source_of_sales_areas','area_code','updated_at',NULL),
  ('source_of_sales_distributors','public.source_of_sales_distributors','distributor_code','updated_at',NULL),
  ('source_of_sales_products','public.source_of_sales_products','product_code','updated_at',NULL),
  ('source_of_sales_product_price_history','public.source_of_sales_product_price_history','(product_code||''/''||effective_period)','created_at',NULL),
  ('au_monthly_targets','au.monthly_targets','id','updated_at','period'),
  ('au_monthly_store_split_net','au.monthly_store_split_net','(period||''/''||line_code||''/''||area_code||''/''||product_code)','computed_at','period'),
  ('au_direct_region_allocation','au.direct_region_allocation','(line_code||''/''||sos_region_code||''/''||target_region_code)','updated_at',NULL)
 ) AS v(source, rel, pk, stamp_col, period_col) WHERE v.source = ANY(p_sources)
 LOOP
  stamp_sql := CASE WHEN r.stamp_col IS NULL THEN 'NULL::timestamptz' ELSE format('max(%I)::timestamptz', r.stamp_col) END;
  where_sql := CASE WHEN r.period_col IS NULL THEN '' ELSE format('WHERE %I = %L', r.period_col, p_period) END;
  IF r.period_col IS NOT NULL AND p_period IS NULL THEN RAISE EXCEPTION 'period required for %', r.source; END IF;
  RETURN QUERY EXECUTE format(
   'SELECT %L::text, count(*)::bigint, %s, md5(coalesce(string_agg((%s)::text || '':'' || xmin::text, '','' ORDER BY (%s)::text), '''')) FROM %s %s',
   r.source, stamp_sql, r.pk, r.pk, r.rel, where_sql);
 END LOOP;
END
$fn$;
REVOKE ALL ON FUNCTION public.phoenix_mcp_source_watermark(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_mcp_source_watermark(text[], text) TO service_role;
