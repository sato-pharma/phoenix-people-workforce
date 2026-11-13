import assert from "node:assert/strict";

import { findMisplacedBackupTables, stripSqlComments } from "../scripts/check-sql-backup-placement.ts";

// Regression guard for the backup-table placement check added 2026-08-01.
//
// Three ad-hoc snapshot tables shipped into `public` in three days, each readable with the
// public anon key until RLS was enabled by hand. The schema-shape monitor caught all three,
// but only once they were already live in production. This check is meant to catch the same
// mistake in review instead — so the bar for this test is that the ACTUAL statements that
// caused the exposures are flagged, and that the shapes which are genuinely fine are not.

const F = "supabase/example.sql";
const tables = (sql: string) => findMisplacedBackupTables(sql, F).map((v) => v.table);

/** The real statement from supabase/scripts/crm_restamp_reused_agent_slots.sql, 2026-08-01. */
const REAL_OFFENDER = `
begin;
create table if not exists public.crm_restamp_backup_20260801 as
select id, agent_name, agent_hr_id from public.ireports360_visits where agent_crm_id in (1391, 1536);

create table if not exists public.crm_restamp_checkins_backup_20260801 as
select id, agent_hr_id from public.ireports360_checkins where agent_crm_id in (1391, 1536);
commit;
`;

/** The sealed form that replaced it — a dated schema anon has no USAGE on. */
const SEALED = `
create schema if not exists crm_restamp_backup_20260801;
revoke all on schema crm_restamp_backup_20260801 from anon, authenticated;
create table if not exists crm_restamp_backup_20260801.visits as select id from public.ireports360_visits;
create table if not exists crm_restamp_backup_20260801.checkins as select id from public.ireports360_checkins;
`;

export function runSqlBackupPlacementTests() {
  // --- the exposures this check exists to prevent -------------------------------------------
  assert.deepEqual(
    tables(REAL_OFFENDER),
    ["public.crm_restamp_backup_20260801", "public.crm_restamp_checkins_backup_20260801"],
    "both statements from the 2026-08-01 CRM re-stamp must be flagged",
  );

  assert.deepEqual(
    tables("create table public.email_backfill_backup_20260730 as select login_id, hr_id from public.app_auth_users;"),
    ["public.email_backfill_backup_20260730"],
    "the 2026-07-30 email backfill backup must be flagged",
  );

  // An unqualified name lands in `public` too — search_path is `public` here.
  assert.deepEqual(
    tables("create table payroll_backup_20260801 as select * from public.payroll_runs;"),
    ["public.payroll_backup_20260801"],
    "an unqualified create must be treated as `public`",
  );

  assert.deepEqual(
    tables(`create table if not exists "public"."visits_backup_20260801" as select 1;`),
    ["public.visits_backup_20260801"],
    "quoted identifiers must be unwrapped before matching",
  );

  // --- the fix, and shapes that are genuinely fine ------------------------------------------
  assert.deepEqual(tables(SEALED), [], "a snapshot in its own dated schema is the fix, not a violation");

  assert.deepEqual(
    tables("create table backup.leave_domain_backup_manifest (id uuid primary key);"),
    [],
    "the pre-existing `backup` schema is fine — only `public` is exposed",
  );

  // `public.sales_ops_dashboard_snapshot` is a real live table with a policy. A weak word on
  // its own must not fail the build, or the check gets ignored.
  assert.deepEqual(
    tables("CREATE TABLE public.sales_ops_dashboard_snapshot (id uuid primary key);"),
    [],
    "a live table whose name merely contains a weak word must not be flagged",
  );

  // ...but the same word plus a date is a point-in-time copy.
  assert.deepEqual(
    tables("create table public.sales_ops_dashboard_snapshot_20260801 as select 1;"),
    ["public.sales_ops_dashboard_snapshot_20260801"],
    "a weak word plus a date is a snapshot and must be flagged",
  );

  // `pre` joined the weak tier on 2026-08-30. It is the house convention for a rollback
  // pre-image and the rule was blind to it: of the five snapshots found in production `public`
  // that day, the two named `zz_backup_…` matched on the strong tier and the three named
  // `…_20260829_pre` matched nothing at all. The rule now lives in scripts/lib/snapshot-name.ts
  // and is shared with the live-database check in check-schema-shape.ts.
  assert.deepEqual(
    tables("create table public.probation_reanchor_20260829_pre as select * from public.probation_cases;"),
    ["public.probation_reanchor_20260829_pre"],
    "a dated `_pre` pre-image must be flagged — three real ones sat in production public unnamed by this rule",
  );

  assert.deepEqual(
    tables("create table public.employees_pre (id uuid primary key);"),
    [],
    "an undated `_pre` is dated-gated like every other weak word and must not be flagged",
  );

  // --- comments must never trip it ----------------------------------------------------------
  assert.deepEqual(
    tables("-- create table public.foo_backup_20260801 as select 1;\nselect 1;"),
    [],
    "a commented-out statement is not a create",
  );

  assert.deepEqual(
    tables("/* create table public.foo_backup_20260801 as select 1; */\nselect 1;"),
    [],
    "a block-commented statement is not a create",
  );

  // Blanking rather than deleting comments is what keeps the reported line honest.
  assert.equal(
    stripSqlComments("select 1; -- note\nselect 2;").split("\n").length,
    2,
    "stripping comments must preserve line structure",
  );

  const lineCheck = findMisplacedBackupTables(
    "-- header comment\n-- another\ncreate table public.x_backup_20260801 as select 1;",
    F,
  );
  assert.equal(lineCheck[0]?.line, 3, "the reported line must match the file the author is looking at");
}
