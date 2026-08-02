-- Make the confidential-product exclusion argument fail CLOSED on the 10 remaining live RPCs.
--
-- WHY -------------------------------------------------------------------------------------------
-- `p_exclude_codes` currently means two OPPOSITE things depending on which function you call:
--
--   analytics_sos_by_period / _by_area / _by_line / _by_product   DEFAULT {LA003,LA004,SS001}
--   phx_sos_geo_aggregates_without_restricted                     DEFAULT {LA003,LA004,SS001}
--   phx_marketing_coverage_export_sales_detail                    DEFAULT {LA003,LA004,SS001}
--   phx_marketing_request_view_sales                              DEFAULT {LA003,LA004,SS001}
--     -> omitting the argument HIDES the confidential products (fail-closed)
--
--   the 10 functions below                                        DEFAULT '{}'
--     -> omitting the argument REVEALS them (fail-open)
--
-- tests/sales-head-office-lock.test.ts pins the first idiom explicitly ("Hiding must OMIT the key
-- rather than pass the codes: the RPC default is the fail-closed answer"). Carrying that learned
-- habit to any function below silently reveals LA003 / LA004 / SS001. This migration removes the
-- inconsistency so the safe behaviour is the default one everywhere.
--
-- BLAST RADIUS ----------------------------------------------------------------------------------
-- None expected. Verified 2026-08-02 that EVERY live caller already passes the argument explicitly,
-- so no current call path depends on the default:
--   phx_exec_*                         src/lib/sales/sos-dashboard.ts (detailArgsFor / geoArgsFor),
--                                      src/lib/sales/monthly-sales-run.ts
--   phx_customer_directory[_json],
--   phx_customer_sales                 src/lib/sales/customer-directory.ts
--   phx_marketing_roi_fast,
--   phx_marketing_roi_customer_dashboard   src/lib/sales-marketing-intelligence/service.ts
--   phx_marketing_request_roi_actuals_v2   src/lib/marketing-requests/roi-report-service.ts
-- `phx_customer_directory_json` calls `phx_customer_directory` from SQL and passes p_exclude_codes
-- straight through, so the inner default is not relied upon either.
-- All 10 are SECURITY DEFINER and service_role-only (anon/authenticated EXECUTE = false), so this
-- was never browser-reachable — it is a footgun for our own server code, not a live exposure.
--
-- HOW -------------------------------------------------------------------------------------------
-- Postgres cannot ALTER a parameter default; the whole function must be re-created. Two of these
-- bodies are ~40KB (phx_marketing_roi_customer_dashboard, phx_marketing_roi_fast), so rather than
-- transcribe ~107KB of SQL by hand — where a single typo silently changes a live ROI dashboard —
-- this reads each definition from the catalog with pg_get_functiondef() and re-emits it with ONLY
-- the default substring replaced. The body is therefore byte-identical by construction.
--
-- It is deliberately loud rather than best-effort: a target that is missing, or that matches
-- neither the old nor the new default, raises and aborts the migration. Re-running is a no-op.
--
-- CREATE OR REPLACE preserves the existing ACL, so grants are not reset (this repo has been bitten
-- by REVOKE stripping service_role before — the post-check below asserts grants survived).

DO $mig$
DECLARE
  v_targets  text[] := ARRAY[
    'phx_customer_directory',
    'phx_customer_directory_json',
    'phx_customer_sales',
    'phx_exec_brick',
    'phx_exec_customers',
    'phx_exec_distributor_product',
    'phx_exec_sos_trend',
    'phx_marketing_request_roi_actuals_v2',
    'phx_marketing_roi_customer_dashboard',
    'phx_marketing_roi_fast'
  ];
  v_closed   constant text := 'DEFAULT ARRAY[''LA003''::text, ''LA004''::text, ''SS001''::text]';
  r          record;
  v_name     text;
  v_def      text;
  v_new      text;
  v_changed  int := 0;
  v_skipped  int := 0;
BEGIN
  FOREACH v_name IN ARRAY v_targets LOOP
    FOR r IN
      SELECT p.oid, pg_get_function_identity_arguments(p.oid) AS ident
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = v_name
    LOOP
      v_def := pg_get_functiondef(r.oid);

      -- pg_get_functiondef already emits CREATE OR REPLACE on supported versions; normalise anyway
      -- so this cannot accidentally attempt a plain CREATE against an existing function.
      IF v_def LIKE 'CREATE FUNCTION%' THEN
        v_def := 'CREATE OR REPLACE FUNCTION' || substr(v_def, length('CREATE FUNCTION') + 1);
      END IF;

      v_new := replace(
        replace(v_def,
          'p_exclude_codes text[] DEFAULT ''{}''::text[]',
          'p_exclude_codes text[] ' || v_closed),
        'p_exclude_product_codes text[] DEFAULT ''{}''::text[]',
        'p_exclude_product_codes text[] ' || v_closed);

      IF v_new <> v_def THEN
        EXECUTE v_new;
        v_changed := v_changed + 1;
        RAISE NOTICE 'fail-closed default applied: %(%)', v_name, r.ident;
      ELSIF v_def LIKE '%' || v_closed || '%' THEN
        -- Already fail-closed (re-run, or fixed out of band). Nothing to do.
        v_skipped := v_skipped + 1;
      ELSE
        RAISE EXCEPTION
          'phx: % (%) matched neither the fail-open nor the fail-closed exclusion default; '
          'its signature changed since this migration was written — review before re-running',
          v_name, r.ident;
      END IF;
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = v_name
    ) THEN
      RAISE EXCEPTION 'phx: expected function public.% not found', v_name;
    END IF;
  END LOOP;

  RAISE NOTICE 'phx: % function(s) switched to a fail-closed exclusion default, % already correct',
    v_changed, v_skipped;
END
$mig$;

-- ── Post-conditions: fail the migration rather than leave a half-applied state ──────────────────
DO $verify$
DECLARE
  v_open_left int;
  v_ungranted text;
BEGIN
  -- 1. No targeted function may retain the fail-open default.
  SELECT count(*) INTO v_open_left
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('phx_customer_directory','phx_customer_directory_json','phx_customer_sales',
                      'phx_exec_brick','phx_exec_customers','phx_exec_distributor_product',
                      'phx_exec_sos_trend','phx_marketing_request_roi_actuals_v2',
                      'phx_marketing_roi_customer_dashboard','phx_marketing_roi_fast')
    AND pg_get_function_arguments(p.oid) LIKE '%exclude%DEFAULT ''{}''::text[]%';

  IF v_open_left > 0 THEN
    RAISE EXCEPTION 'phx: % function(s) still carry a fail-open exclusion default', v_open_left;
  END IF;

  -- 2. service_role must still hold EXECUTE. CREATE OR REPLACE preserves the ACL, but this repo has
  --    had service_role stripped by an ACL change before, so assert it rather than assume it.
  SELECT string_agg(p.proname, ', ') INTO v_ungranted
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('phx_customer_directory','phx_customer_directory_json','phx_customer_sales',
                      'phx_exec_brick','phx_exec_customers','phx_exec_distributor_product',
                      'phx_exec_sos_trend','phx_marketing_request_roi_actuals_v2',
                      'phx_marketing_roi_customer_dashboard','phx_marketing_roi_fast')
    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');

  IF v_ungranted IS NOT NULL THEN
    RAISE EXCEPTION 'phx: service_role lost EXECUTE on: %', v_ungranted;
  END IF;

  RAISE NOTICE 'phx: verified — no fail-open exclusion defaults remain, service_role EXECUTE intact';
END
$verify$;
