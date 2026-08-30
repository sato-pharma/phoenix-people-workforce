-- C9 · Retire the abandoned sales_ops_* rollup subsystem (dead tables + RPCs).
--
-- Background
--   sales_ops_* is a parallel sales-ops rollup engine that was built and
--   security-hardened (pre-baseline 2026-06-19 anon-revoke migration) but never
--   populated. The LIVE sales rollup is source_of_sales_* / *_fact_rollup /
--   phx_monthly_achievement, which is entirely separate and untouched. Verified
--   against production 2026-08-30:
--     * 12 of 13 tables are empty; sales_ops_dashboard_snapshot holds 2 cached
--       rows (preserved verbatim by this archive);
--     * no live reader — src/lib/crm/brick-coverage.ts reads
--       source_of_sales_fact_rollup and comments that sales_ops_rollup_by_brick
--       "is EMPTY in production — do not switch to it";
--     * no writer/ingest, no app route, and the 3 RPCs have NO callers anywhere;
--     * no external inbound FK, no dependent view/matview, no triggers.
--   All repo references are source-string / migration-file pins (the M3 RLS-revoke
--   test, the backup-placement checker fixtures) that read fixed files and do NOT
--   query the live DB, so nothing breaks when these objects leave public.
--
-- What this does
--   RENAMES the dead objects into an archive schema via ALTER ... SET SCHEMA
--   (each moves WITH its indexes, constraints, RLS policies and grants intact, and
--   off the PostgREST-exposed public surface). The serial sequence
--   sales_ops_fact_rows_id_seq is owned by sales_ops_fact_rows and moves with it
--   automatically. Fully reversible — see the ROLLBACK block at the foot.
--   Direct twin of C7 (20260830140000) and C8 (20260830150000).

create schema if not exists sales_ops_backup_20260830;

comment on schema sales_ops_backup_20260830 is
  'Retired 2026-08-30 (C9): the abandoned sales_ops_* rollup subsystem (13 tables '
  '+ 3 RPCs + 1 owned sequence), superseded by the live source_of_sales_* / '
  '*_fact_rollup system and never populated (2 cached dashboard rows only). '
  'Reversible via ALTER ... SET SCHEMA public.';

-- Tables (order immaterial; internal FKs follow by OID and stay within the schema;
-- the owned sequence sales_ops_fact_rows_id_seq moves with sales_ops_fact_rows).
alter table public.sales_ops_dashboard_snapshot   set schema sales_ops_backup_20260830;
alter table public.sales_ops_distributor_profile  set schema sales_ops_backup_20260830;
alter table public.sales_ops_fact_rows            set schema sales_ops_backup_20260830;
alter table public.sales_ops_import_batches        set schema sales_ops_backup_20260830;
alter table public.sales_ops_rollup_area_product   set schema sales_ops_backup_20260830;
alter table public.sales_ops_rollup_by_area        set schema sales_ops_backup_20260830;
alter table public.sales_ops_rollup_by_brick       set schema sales_ops_backup_20260830;
alter table public.sales_ops_rollup_by_distributor set schema sales_ops_backup_20260830;
alter table public.sales_ops_rollup_by_line        set schema sales_ops_backup_20260830;
alter table public.sales_ops_rollup_by_product     set schema sales_ops_backup_20260830;
alter table public.sales_ops_rollup_by_region      set schema sales_ops_backup_20260830;
alter table public.sales_ops_rollup_leaf           set schema sales_ops_backup_20260830;
alter table public.sales_ops_rollup_period         set schema sales_ops_backup_20260830;

-- Dead RPCs — no callers anywhere in the app.
alter function public.sales_ops_commit_batch(uuid)    set schema sales_ops_backup_20260830;
alter function public.sales_ops_dashboard(text)       set schema sales_ops_backup_20260830;
alter function public.sales_ops_rebuild_period(text)  set schema sales_ops_backup_20260830;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (run by hand if ever needed — moves everything back to public):
--
--   alter table sales_ops_backup_20260830.sales_ops_dashboard_snapshot   set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_distributor_profile  set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_fact_rows            set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_import_batches        set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_rollup_area_product   set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_rollup_by_area        set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_rollup_by_brick       set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_rollup_by_distributor set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_rollup_by_line        set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_rollup_by_product     set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_rollup_by_region      set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_rollup_leaf           set schema public;
--   alter table sales_ops_backup_20260830.sales_ops_rollup_period         set schema public;
--   alter function sales_ops_backup_20260830.sales_ops_commit_batch(uuid)   set schema public;
--   alter function sales_ops_backup_20260830.sales_ops_dashboard(text)      set schema public;
--   alter function sales_ops_backup_20260830.sales_ops_rebuild_period(text) set schema public;
--   drop schema sales_ops_backup_20260830;  -- only after the objects are moved back
-- ─────────────────────────────────────────────────────────────────────────────
