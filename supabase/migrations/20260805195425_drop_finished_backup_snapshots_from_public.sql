-- RECONSTRUCTED FROM THE PRODUCTION CATALOG, 2026-08-05.
--
-- This change was applied straight to production and never written back as a migration file. It is
-- recovered here verbatim -- not paraphrased -- from
-- `supabase_migrations.schema_migrations.statements` for version 20260805195425
-- (name `drop_finished_backup_snapshots_from_public`, created_by o-gaweesh@outlook.com). The
-- executable statements below are exactly the SQL that ran, and the original commentary is kept
-- intact. The only additions are this preamble and the `-- SAFE:` annotations that
-- `scripts/check-migrations.mjs` requires next to a DROP TABLE; both are comments and neither
-- changes what executes.
--
-- The filename timestamp is deliberately the ledger version, so the file and the applied migration
-- carry the same identity.
--
-- Verified against production before writing this file:
--   * all four tables are absent from pg_class     -> the drop really happened
--   * `git grep` over src/ app/ tests/ scripts/     -> 0 references to any of the four
--   * the ledger recorded no rollback statements    -> the tables cannot be restored from it;
--     they were finished snapshots the owner confirmed had served their purpose
--
-- Re-running is safe: every statement is `drop table if exists`, so on production (already dropped)
-- it is a no-op, and on a rebuilt database the tables never existed in the first place.
--
-- Data impact on a rebuild: none. These snapshot tables are not created by any migration in this
-- repo -- they were made by hand during live fixes -- so a database built from `supabase/migrations`
-- never has them to drop.
--
-- NOTE, still open after this migration: seven other backup/snapshot tables remain in `public`
-- (crm_restamp_backup_20260801, crm_restamp_checkins_backup_20260801,
-- field_workforce_compliance_live_snapshots, geo_locations_brick_centroid_backup_20260728,
-- geo_locations_brick_centroid_backup2_20260728, sales_ops_dashboard_snapshot,
-- sos_import_coverage_snapshots). This migration deliberately does not touch them.

-- ---------------------------------------------------------------------------
-- Original migration body, verbatim as applied:
-- ---------------------------------------------------------------------------

-- Drop four finished backup snapshots that were sitting in the anon-reachable `public` schema.
-- Owner confirmed 2026-08-05 that all four have served their purpose.
--
-- WHY THIS MATTERS BEYOND TIDINESS. check:schema-shape flagged all four for having no primary key,
-- and three of them ALSO appeared in that morning's exposed_without_rls finding: snapshots created
-- in `public` inherit the schema-wide anon/authenticated grant, so a backup of employee CRM
-- identities was readable by anyone on the internet until RLS was enabled on it. Adding primary
-- keys would have silenced the check while leaving snapshot tables living in the browser-reachable
-- schema — the actual defect. Future snapshots belong in `au`, not `public`.
--
-- RESTRICT, never CASCADE: verified 0 inbound foreign keys, 0 dependent views and 0 application
-- references for each, so RESTRICT should succeed. If any of that is wrong, this fails loudly
-- instead of quietly deleting whatever depended on it.

-- SAFE: finished hand-made backup snapshots, owner-confirmed spent on 2026-08-05. Each was verified
-- to have 0 inbound foreign keys, 0 dependent views and 0 application references before the drop,
-- and re-verified absent from pg_class and from src/app/tests/scripts when this file was written.
-- RESTRICT (not CASCADE) means any missed dependency aborts the statement rather than deleting
-- silently. No migration in this repo creates these tables, so on a rebuilt database each statement
-- is a no-op.
drop table if exists public.backup_employee_crm_identity_20260805 restrict;
drop table if exists public.email_templates_backup_20260801 restrict;
drop table if exists public.pv_bak_ai0005_20260801 restrict;
drop table if exists public.pv_bak_reopen_misfills_20260801 restrict;
