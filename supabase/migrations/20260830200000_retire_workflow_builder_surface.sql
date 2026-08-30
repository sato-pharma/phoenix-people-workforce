-- C12 · Retire the never-finished workflow-BUILDER tables.
--
-- Background
--   Five public.workflow_* tables are the schema for a visual workflow-BUILDER
--   subsystem that was drafted but never finished — the draft that created them
--   is literally marked "DRAFT — DO NOT APPLY" in
--   supabase/_migrations_archive/pre-baseline-2026-07-11/. All five are EMPTY in
--   production and staging (0 rows). Verified against production 2026-08-30:
--     * empty (0 rows each), owned by postgres;
--     * a closed FK island — 8 FKs, ALL internal to these five; none references
--       the LIVE public.workflow_registry_modules (13 rows, drives the offer /
--       direct-order / vacation approval chains) — the shared "workflow_" prefix
--       is name-only, not referential;
--     * one immutability trigger (workflow_versions_block_mutation_trg) whose
--       function only inspects NEW/OLD columns — self-contained, no table
--       reference — so it rides along on SET SCHEMA; 0 dependent views/matviews;
--     * no reader/writer anywhere in src/ or app/. The one registered test
--       (workflow-control-migration-readiness) asserts the FROZEN text of the
--       archived draft file, never the live DB, so this migration cannot break it.
--
--   Note on grants: unlike the C11 snapshots, these five carry full anon +
--   authenticated CRUD grants, neutralised today only by RLS having a
--   service_role-only policy (no permissive anon/authenticated policy). Moving
--   them off the PostgREST-exposed public schema removes them from the API
--   surface entirely and ends that reliance on the RLS policy staying correct.
--
-- What this does
--   RENAMES the five tables (and the immutability trigger's function) into an
--   archive schema via ALTER ... SET SCHEMA — each moves WITH its indexes,
--   constraints, policies, grants and trigger intact, and off the public surface.
--   Nothing is dropped; the tables are empty and this is fully reversible.
--   Applied atomically so the circular definitions<->versions FKs are never
--   momentarily invalid. Direct twin of C7..C11 (...140000 / 150000 / 160000 /
--   181500 / 190000). Deliberately NOT included: public.workflow_registry_modules.

create schema if not exists workflow_backup_20260830;

comment on schema workflow_backup_20260830 is
  'Retired 2026-08-30 (C12): the never-finished workflow-BUILDER tables (5) — '
  'empty, a closed FK island, referenced by no application code, and unrelated '
  'to the live public.workflow_registry_modules. Reversible via ALTER ... SET SCHEMA public.';

alter table public.workflow_audit_logs       set schema workflow_backup_20260830;
alter table public.workflow_drafts           set schema workflow_backup_20260830;
alter table public.workflow_publish_history  set schema workflow_backup_20260830;
alter table public.workflow_versions         set schema workflow_backup_20260830;
alter table public.workflow_definitions      set schema workflow_backup_20260830;

alter function public.workflow_versions_block_mutation() set schema workflow_backup_20260830;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (run by hand if ever needed — moves everything back to public):
--
--   alter function workflow_backup_20260830.workflow_versions_block_mutation() set schema public;
--   alter table workflow_backup_20260830.workflow_definitions      set schema public;
--   alter table workflow_backup_20260830.workflow_versions         set schema public;
--   alter table workflow_backup_20260830.workflow_publish_history  set schema public;
--   alter table workflow_backup_20260830.workflow_drafts           set schema public;
--   alter table workflow_backup_20260830.workflow_audit_logs       set schema public;
--   drop schema workflow_backup_20260830;  -- only after the objects are moved back
-- ─────────────────────────────────────────────────────────────────────────────
