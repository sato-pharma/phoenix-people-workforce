-- Move the 2026-08-28/29 ad-hoc rollback pre-images out of `public` into dated schemas.
--
-- WHY THIS FILE EXISTS. The `Migration Drift Check` workflow has been RED on every scheduled run
-- since 2026-08-24, and its schema-shape leg is one of the two reasons. That leg raises
-- `missing_primary_key` at severity "error" on five tables in `public` on production and two on
-- staging -- all of them point-in-time pre-images created by hand during live fixes, none of them
-- a domain table. A `create table ... as select` never carries a primary key, so every such
-- snapshot trips this check for as long as it sits in `public`.
--
-- That matters beyond tidiness: the workflow Telegrams the owner on EVERY failure, deliberately,
-- because a detector nobody reads is not a detector (see the incident recorded in
-- .github/workflows/migration-drift-check.yml, where this check found six anon-readable backup
-- tables on 2026-08-06 and went unread for three days). A check that has cried wolf daily for a
-- week is the exact failure mode that comment exists to prevent, so the fix has to make the run
-- GREEN when the database is genuinely sound -- not silence the rule.
--
-- WHAT IS MOVED, with exact counts taken immediately before the move. Counts are real `count(*)`
-- via query_to_xml, never reltuples or n_live_tup -- both read 0 for a table that has never been
-- analysed, and the precedent migration below was misled by exactly that once.
--
--   production (ozucdzovmcqvepbozvqf)
--     public.zz_backup_crm_customer_brick_resolutions_20260828      1 row   -> crm_backup_20260828
--     public.zz_backup_crm_region_brick_resolutions_20260828        0 rows  -> crm_backup_20260828
--     public.hire_date_fix_20260829_pre                             2 rows  -> hr_backup_20260829
--     public.probation_fix_20260829_pre                             1 row   -> hr_backup_20260829
--     public.probation_reanchor_20260829_pre                        6 rows  -> hr_backup_20260829
--
--   staging (cifwmndunmlxjhyjugxa)
--     public.zz_backup_crm_customer_brick_resolutions_20260828      1 row   -> crm_backup_20260828
--     public.zz_backup_crm_region_brick_resolutions_20260828        0 rows  -> crm_backup_20260828
--     the three HR pre-images do not exist there; `hr_backup_20260829` is created empty, which is
--     the same documented rebuild behaviour 20260805204502 recorded for `crm_backup_20260801`.
--
-- A survey of `public` on both databases for every snapshot-shaped name (zz_*, *_pre, *backup*,
-- *_YYYYMMDD) returned these five and nothing else, so this is the whole set, not the flagged
-- subset.
--
-- WHY MOVE RATHER THAN DROP. The owner is deliberately keeping all five until September payroll
-- and probation prove out the 2026-08-29 HR fixes they are the undo for. Dropping them throws away
-- the only record of what those fixes changed. SET SCHEMA keeps every row and every column.
--
-- WHY MOVE RATHER THAN ALLOWLIST. scripts/check-schema-shape.ts holds a NO_PRIMARY_KEY_ALLOWED set
-- for exactly this shape, and its own comment forbids using it here: "a new name appearing here
-- means a snapshot was created in `public` again. The fix is to move it into a dated schema, not to
-- add it to this list." That set was emptied on 2026-08-05 when its last four entries were
-- relocated, and an allowlist naming tables the check can no longer see quietly stops being a
-- guard. Adding names would also have silenced the separate `rls_disabled` warning as a side
-- effect, since that filter reads both sets.
--
-- WHY NOT JUST ADD PRIMARY KEYS. That was tried. The two migrations recorded on 2026-08-27 as
-- zz_backup_tables_primary_keys_20260827 and zz_backup_tables_enable_rls_20260827 hardened the
-- snapshots that existed that day; two more appeared on 08-28 and three on 08-29, and the check
-- went red again the next morning. Hardening the current set treats the instance; placement treats
-- the class, because `public` is the only schema PostgREST serves.
--
-- EXPOSURE. Measured on both databases before writing this, and it is NOT a repeat of the
-- 2026-08-01 anon-exposure incident: all five hold relacl {postgres, service_role} only, with
-- has_table_privilege(anon, SELECT) and has_table_privilege(authenticated, SELECT) both false.
-- So this change removes no live exposure -- it removes the standing possibility of one, which is
-- the structural argument in docs/security/backup-table-placement.md: a schema `anon` has no
-- USAGE on is unreachable through PostgREST regardless of table grants or RLS.
--
-- Nothing in the repository references any of the five names (`git grep` over the whole tree
-- returns zero hits), so no code path can break on the move.
--
-- Table privileges travel WITH a table through SET SCHEMA, so the grants are revoked afterwards
-- from the two NAMED roles and never from PUBLIC -- a `revoke ... from public` against a default
-- ACL also strips service_role, which is the role the application connects as.
--
-- Reversible in one statement per table: `alter table <schema>.<name> set schema public;`.
--
-- Re-running is safe: every move is guarded by to_regclass, so a second run is a no-op, and on a
-- database rebuilt from supabase/migrations the two schemas are created empty and nothing moves,
-- because no migration in this repo creates these tables -- they were made by hand during live
-- fixes.
--
-- Precedent followed, statement for statement:
--   20260805204502_move_adhoc_snapshots_out_of_public.sql

-- Destination schemas, named by domain and vintage to match the existing convention.
create schema if not exists crm_backup_20260828;
revoke all on schema crm_backup_20260828 from anon, authenticated;
comment on schema crm_backup_20260828 is
  'Rollback state for the 2026-08-28 CRM customer/region brick resolution fix. Created by hand in public during the fix; moved out of public 2026-08-30 to take it off PostgREST. Not created by any migration.';

create schema if not exists hr_backup_20260829;
revoke all on schema hr_backup_20260829 from anon, authenticated;
comment on schema hr_backup_20260829 is
  'Pre-images for the 2026-08-29 hire-date and probation fixes. Created by hand in public during the fix; moved out of public 2026-08-30 to take it off PostgREST. Kept until September payroll and probation prove those fixes out, then dropped. Not created by any migration.';

-- The moves themselves, each a no-op when the table is not in public.
do $$
begin
  if to_regclass('public.zz_backup_crm_customer_brick_resolutions_20260828') is not null then
    execute 'alter table public.zz_backup_crm_customer_brick_resolutions_20260828 set schema crm_backup_20260828';
  end if;

  if to_regclass('public.zz_backup_crm_region_brick_resolutions_20260828') is not null then
    execute 'alter table public.zz_backup_crm_region_brick_resolutions_20260828 set schema crm_backup_20260828';
  end if;

  if to_regclass('public.hire_date_fix_20260829_pre') is not null then
    execute 'alter table public.hire_date_fix_20260829_pre set schema hr_backup_20260829';
  end if;

  if to_regclass('public.probation_fix_20260829_pre') is not null then
    execute 'alter table public.probation_fix_20260829_pre set schema hr_backup_20260829';
  end if;

  if to_regclass('public.probation_reanchor_20260829_pre') is not null then
    execute 'alter table public.probation_reanchor_20260829_pre set schema hr_backup_20260829';
  end if;
end $$;

-- Strip the grants that rode along with the tables.
revoke all on all tables in schema crm_backup_20260828 from anon, authenticated;
revoke all on all tables in schema hr_backup_20260829 from anon, authenticated;
