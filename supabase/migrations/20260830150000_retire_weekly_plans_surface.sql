-- C8 · Retire the legacy weekly_plans database surface (dead tables + their touch fns).
--
-- Background
--   There are TWO unrelated things called "weekly plans" in this system. The LIVE
--   weekly-planning feature (/admin/weekly-plans, src/lib/weekly-planning/*, the
--   notification keys weekly_plan_*) runs entirely on employee_plan_headers /
--   employee_plan_items / employee_plan_decisions. The SINGULAR weekly_plans table
--   family below is the SUPERSEDED plan-generation storage; it holds no live data
--   and no live code reads it. Verified against production 2026-08-30:
--     • weekly_plans, weekly_plan_days, weekly_plan_approval_tokens are ALL empty
--       (0 / 0 / 0 rows) on both production and staging;
--     • no runtime or test DB-access reference to any of the 3 tables — the only
--       code mentions are prose comments (home-snapshot.ts and one test) that
--       already state the tables are superseded;
--     • no view/matview depends on them, and there is NO external inbound FK — the
--       only foreign keys are the family's own internal child links;
--     • of the 13 phx_weekly_plan* functions, only the two touch-trigger functions
--       (phx_touch_weekly_plans, phx_touch_weekly_plan_days) belong to these dead
--       tables; the 11 others — the atomic RPCs, phx_weekly_plans_drift_check and
--       phx_weekly_plan_next_status — all operate on the LIVE employee_plan_*
--       tables and reference none of the dead tables. They stay in public.
--
-- What this does
--   RENAMES the dead objects into an archive schema instead of dropping them, so
--   the structure is preserved verbatim and the move is auditable. ALTER ... SET
--   SCHEMA moves each table WITH its indexes, constraints, RLS policies, triggers
--   and grants intact, and removes it from the public (PostgREST-exposed) surface.
--   Fully reversible — see the ROLLBACK block at the foot of this file. Direct
--   structural twin of C7 (20260830140000_retire_deductions_governance_surface.sql).

create schema if not exists weekly_plans_backup_20260830;

comment on schema weekly_plans_backup_20260830 is
  'Retired 2026-08-30 (C8): legacy weekly_plans table family (weekly_plans, '
  'weekly_plan_days, weekly_plan_approval_tokens) and its two touch-trigger '
  'functions, superseded by the live weekly-planning feature on '
  'employee_plan_headers/_items/_decisions. All three tables were empty. '
  'Reversible via ALTER ... SET SCHEMA public.';

-- Tables — order is immaterial; the two governance-internal FKs
-- (weekly_plan_days.plan_id, weekly_plan_approval_tokens.plan_id -> weekly_plans)
-- follow by OID and stay within the archive schema.
alter table public.weekly_plans                set schema weekly_plans_backup_20260830;
alter table public.weekly_plan_days            set schema weekly_plans_backup_20260830;
alter table public.weekly_plan_approval_tokens set schema weekly_plans_backup_20260830;

-- The two touch-trigger functions bound EXCLUSIVELY to the dead tables. The live
-- weekly-planning RPCs (phx_weekly_plan_*, phx_weekly_plans_drift_check,
-- phx_weekly_plan_next_status) are NOT touched — they run on employee_plan_*.
alter function public.phx_touch_weekly_plans()     set schema weekly_plans_backup_20260830;
alter function public.phx_touch_weekly_plan_days() set schema weekly_plans_backup_20260830;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (run by hand if ever needed — moves everything back to public):
--
--   alter table weekly_plans_backup_20260830.weekly_plans                set schema public;
--   alter table weekly_plans_backup_20260830.weekly_plan_days            set schema public;
--   alter table weekly_plans_backup_20260830.weekly_plan_approval_tokens set schema public;
--   alter function weekly_plans_backup_20260830.phx_touch_weekly_plans()     set schema public;
--   alter function weekly_plans_backup_20260830.phx_touch_weekly_plan_days() set schema public;
--   drop schema weekly_plans_backup_20260830;  -- only after the objects are moved back
-- ─────────────────────────────────────────────────────────────────────────────
