-- ============================================================================
-- GATED / DESTRUCTIVE MIGRATION — requires explicit owner approval before apply.
-- ============================================================================
-- Double Visit Analytics rebuild (2026-07-04): the module was rebuilt to read LIVE off
-- ireports360_visits (the Visits Report mirror) instead of maintaining its own
-- import/publish snapshot. double_visit_rows and double_visit_imports are no longer read or
-- written by any code path (see src/lib/double-visit-analytics/service.ts) and are dropped
-- here. Migration 20260705090000 already removed the outstation_expense_requests FK to
-- double_visit_imports (must run first — it does, by filename ordering).
--
-- Rollback: restore from the _backup_20260705 tables created below (kept indefinitely; drop
-- them separately once the team confirms the rebuild is stable in production).
--
-- DO NOT APPLY without the owner's explicit go-ahead, and only after the code rebuild has
-- been verified working on staging.

create table if not exists public.double_visit_rows_backup_20260705 as
  select * from public.double_visit_rows;

create table if not exists public.double_visit_imports_backup_20260705 as
  select * from public.double_visit_imports;

drop table if exists public.double_visit_rows;
drop table if exists public.double_visit_imports;

comment on table public.double_visit_rows_backup_20260705 is
  'Frozen backup of double_visit_rows taken at Double Visit Analytics live-rebuild (2026-07). Not read by any code path — rollback/audit reference only.';
comment on table public.double_visit_imports_backup_20260705 is
  'Frozen backup of double_visit_imports taken at Double Visit Analytics live-rebuild (2026-07). Not read by any code path — rollback/audit reference only.';
