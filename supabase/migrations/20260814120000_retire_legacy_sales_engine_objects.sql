-- ─────────────────────────────────────────────────────────────────────────────
-- Rule #1 migration, Phase 7 — retire the legacy sales engine's dead SQL.
--
-- Every sales surface now reads SoS Monthly Closing (au.f_monthly_achievement).
-- The objects dropped below are what the LEGACY engine left behind: they read
-- public.sales_records / sales_import_batches, and after Phases 2–6 they have
-- ZERO callers — no TypeScript, no SQL, no view, no function.
--
-- VERIFIED LIVE before writing this file (staging ref cifwmndunmlxjhyjugxa),
-- not taken from the migration ledger, which reports intent rather than reality:
--
--   * Callers in this repo: `git grep` over **/*.{ts,tsx,mjs,js} for all six
--     names returns nothing but one historical comment in
--     src/lib/analytics/service.ts:397 explaining the 2026-07-29 retirement.
--   * Callers in the database: pg_get_functiondef over every function, and
--     pg_get_viewdef over every view, matched none of these names — except
--     sales_employee_linkage_health_summary, which reads
--     sales_employee_linkage_health and is itself uncalled, so both go.
--   * pg_depend/pg_rewrite (real dependencies, not text matching) reports the
--     same single edge and nothing else.
--   * analytics.closing_fact does NOT read closing_fact_all_statuses — it was
--     repointed onto phx_monthly_achievement in Phase 4b
--     (20260814090000_closing_fact_reads_source_of_sales.sql). Re-checked here:
--     pg_get_viewdef(...) ~ 'closing_fact_all_statuses' = false.
--
-- WHAT IS DELIBERATELY **NOT** DROPPED
--
--   public.sales_records          — 11,267 rows of H1 2026 history and the only
--   public.sales_import_batches     record of what H1 incentives were actually
--   public.v_employee_portal_sales  paid on. H1 payouts are closed and are not
--                                   reopened (owner decision, 2026-08-13), so
--                                   this is the audit trail behind real money.
--
--   All three stay READABLE. Direct writes are revoked on sales_records and
--   v_employee_portal_sales only — sales_import_batches keeps its write grants
--   deliberately; section 3's closing note says why, and what that leaves open.
--
-- FREEZING THE WRITE PATH (the second half of this migration)
--
-- src/lib/sales/service.ts already refuses at both write entry points
-- (assertLegacySalesImportOpen → HTTP 410, LEGACY_SALES_IMPORT_FROZEN = true).
-- That is an application check, and the application is not the security
-- boundary — so the grant is withdrawn here too.
--
-- Writes are revoked FROM THE NAMED ROLES, never `FROM PUBLIC`: on a default
-- ACL, `REVOKE ... FROM PUBLIC` also strips service_role and takes the table
-- offline for every server-side reader.
--
-- This does NOT break public.phx_reassign_replacement_ownership, the one live
-- database writer to sales_records (called from
-- src/lib/employees/employee-directory.ts:2063 when an employee is replaced).
-- Verified: prosecdef = true and proowner = postgres, so it executes with
-- postgres's own grants, which this migration does not touch.
--
-- Reversal: every object below is recreated verbatim by
-- supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql,
-- and the grants by `grant insert, update, delete on ... to service_role;`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Legacy views ──────────────────────────────────────────────────────────

-- Portal filter options built off sales_records. The portal now derives its
-- filters from the canonical rows themselves (src/lib/employee-portal/portal-sales-canonical.ts).
drop view if exists public.v_employee_portal_sales_filters;

-- Import linkage health: how many legacy rows matched an employee. Meaningless
-- once nothing imports. /admin/data-health was repointed at SoS import health in
-- Phase 4c. The summary reads the detail view, so it is dropped first.
drop view if exists public.sales_employee_linkage_health_summary;
drop view if exists public.sales_employee_linkage_health;

-- The all-statuses twin of analytics.closing_fact, over the legacy Sales Queue.
-- Its only consumer was analytics_closing_by_employee, dropped just below.
drop view if exists analytics.closing_fact_all_statuses;

-- ── 2. Legacy functions ──────────────────────────────────────────────────────

-- Both overloads. Signatures spelled out in full so a future overload added
-- under the same name is never dropped by accident.
drop function if exists public.analytics_closing_by_employee(
  p_period text, p_period_from text, p_period_to text,
  p_lines text[], p_employee_hr_id text, p_territory text
);
drop function if exists public.analytics_closing_by_employee(
  p_periods text[], p_period_from text, p_period_to text,
  p_lines text[], p_products text[], p_families text[],
  p_employee_hr_id text, p_territory text, p_batch_status text[], p_batch_id uuid
);

-- The pre-Phoenix admin command centre. Replaced by the current /admin loaders;
-- no route, service, or view has referenced either since.
drop function if exists public.fn_get_admin_command_center_data(
  p_access_scope text, p_access_role text, p_access_hr_id text
);
drop function if exists public.fn_get_command_center_metrics();

-- ── 3. Freeze the legacy write path ──────────────────────────────────────────
-- SELECT is deliberately preserved on both: H1 history must stay readable.

revoke insert, update, delete, truncate on public.sales_records
  from anon, authenticated, service_role;

revoke insert, update, delete, truncate on public.v_employee_portal_sales
  from anon, authenticated, service_role;

-- ── What this does NOT freeze — stated plainly rather than implied ───────────
--
-- 1. public.sales_import_batches keeps its write grants ON PURPOSE. The
--    /sales/import console still approves, rejects, replaces and deletes
--    EXISTING batches (src/lib/sales/service.ts: updateSalesBatchStatus,
--    replaceSalesBatch, deleteSalesBatch). Only the CREATE path is frozen, so
--    no new batch can appear — but revoking here would break the console's
--    remaining operations with no replacement built. Freezing it is a separate
--    owner decision, not a side effect of this migration.
--
-- 2. Because of 1, sales_records rows can still be removed indirectly:
--    sales_records_batch_id_fkey is ON DELETE CASCADE, and PostgreSQL executes
--    referential-integrity actions with the table owner's privileges, bypassing
--    the caller's. So deleting a batch still cascades away its records even
--    with DELETE revoked above. The revoke stops DIRECT writes — it is not an
--    immutability guarantee, and must not be described as one.
--
-- 3. public.phx_reassign_replacement_ownership still updates sales_records, by
--    design (see the header). It is SECURITY DEFINER owned by postgres.

comment on table public.sales_records is
  'RETIRED 2026-08-14 (Rule #1 migration, Phase 7). H1 2026 history and the record of what H1 incentives were actually paid on. Every live sales surface reads SoS Monthly Closing (au.f_monthly_achievement) instead — do not repoint anything back here, and do not resume importing. DIRECT writes are revoked from anon/authenticated/service_role and the app refuses at src/lib/sales/service.ts (assertLegacySalesImportOpen, HTTP 410). This is NOT immutability: deleting a row from sales_import_batches still cascades rows away here, and phx_reassign_replacement_ownership (SECURITY DEFINER, owner postgres) still updates it by design.';
