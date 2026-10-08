import assert from "node:assert/strict";

import {
  evaluateSchemaShape,
  type RecoveryHealth,
  type SchemaShape,
} from "../scripts/check-schema-shape.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The recovery undo log's dead-man's switch had no test at all, and its one error message
// pointed at the wrong place.
//
// Production has no point-in-time recovery; the hourly snapshot store stands in for it. The
// gate in check-schema-shape.ts is what notices when that store has gone quiet — and on
// 2026-10-08 it fired on staging with: "They are registered and enabled, so something is
// failing silently inside recovery.take_snapshots() — read recovery.snapshot_runs.error."
//
// Measured on staging that day: all 7 tables registered and enabled, 0 snapshots each,
// `recovery.snapshot_runs` EMPTY (0 rows), and `cron.job` does not exist at all because pg_cron
// is not installed there. So there was no error to read, and the advice sent the reader inside a
// function that had never been called. take_snapshots() writes a snapshot_runs row on every
// invocation, so "nothing captured anywhere" and "these three tables failed" are different
// faults with different fixes, and only the second one is about the function.
//
// Production on the same day, for contrast, is the healthy shape below: `phoenix-recovery-snapshot`
// at `5 * * * *`, 206 cron runs, every one `succeeded`, all 7 tables captured.
//
// 🔴 The schedule itself is hand-made state. Nothing in supabase/migrations/ creates it — the
// retention job next to it IS created by a migration (20261004041000) — so a restored or
// recreated database comes back with the store deployed and never running. That is precisely
// the "looks like protection" state the gate exists for, which is why the message has to name
// pg_cron and cron.job rather than snapshot_runs.
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;

/** The 7 tables production really protects, all captured. `taken_at` is relative so this never rots. */
function productionRecovery(): RecoveryHealth[] {
  const recent = new Date(Date.now() - 2 * HOUR).toISOString();
  // au.line_area_map changes about monthly, so an old newest_snapshot_at is normal per table —
  // staleness is judged on the newest across ALL of them, never one.
  const old = new Date(Date.now() - 40 * HOUR).toISOString();
  return [
    { source_schema: "au", source_table: "line_area_map", enabled: true, snapshots_held: 13, newest_snapshot_at: old, ever_captured: true },
    { source_schema: "au", source_table: "monthly_targets", enabled: true, snapshots_held: 8, newest_snapshot_at: old, ever_captured: true },
    { source_schema: "public", source_table: "employees", enabled: true, snapshots_held: 29, newest_snapshot_at: recent, ever_captured: true },
    { source_schema: "public", source_table: "monthly_closing_locks", enabled: true, snapshots_held: 7, newest_snapshot_at: old, ever_captured: true },
    { source_schema: "public", source_table: "monthly_closing_publications", enabled: true, snapshots_held: 4, newest_snapshot_at: old, ever_captured: true },
    { source_schema: "public", source_table: "salary_batches", enabled: true, snapshots_held: 1, newest_snapshot_at: old, ever_captured: true },
    { source_schema: "public", source_table: "salary_records", enabled: true, snapshots_held: 1, newest_snapshot_at: old, ever_captured: true },
  ];
}

/** A schema in good health, so each test varies one thing and nothing else fires. */
function healthyShape(): SchemaShape {
  return {
    tables_total: 301,
    tables_rls_enabled: 301,
    tables_force_rls: 0,
    policies_total: 400,
    primary_keys_total: 301,
    unique_total: 100,
    foreign_keys_total: 200,
    check_total: 50,
    indexes_total: 500,
    triggers_total: 40,
    schema_usage: { anon: true, authenticated: true, service_role: true },
    tables_exposed_without_rls: [],
    tables_rls_disabled: [],
    tables_without_primary_key: [],
    tables_rls_enabled_without_policy: [],
    default_acl_leaks: [],
    private_schema_usage: { anon: false, authenticated: true, service_role: true },
    policies_using_private_schema: 67,
    recovery_health: productionRecovery(),
  };
}

const codes = (shape: SchemaShape) => evaluateSchemaShape(shape).map((v) => v.code);
const find = (shape: SchemaShape, code: string) =>
  evaluateSchemaShape(shape).find((v) => v.code === code);

export function runSchemaShapeRecoveryHealthTests() {
  // ── production's real state raises nothing ────────────────────────────────
  assert.deepEqual(
    codes(healthyShape()),
    [],
    "production's measured recovery health must be the definition of clean, or the gate is wrong about the target state",
  );

  // ── the migration not being on this target yet stays SILENT ───────────────
  // Same contract as every other optional gate here: absent is "not deployed", not a fault.
  const notDeployed: SchemaShape = { ...healthyShape(), recovery_health: undefined };
  assert.deepEqual(
    codes(notDeployed),
    [],
    "an undefined recovery_health means the migration is not on this target — it must not be reported as a fault",
  );

  // ── deployed with an EMPTY registry is a real fault, distinct from absent ──
  const emptyRegistry: SchemaShape = { ...healthyShape(), recovery_health: [] };
  const empty = find(emptyRegistry, "recovery_registry_empty");
  assert.ok(empty, "a deployed store protecting nothing must be reported, not treated like 'not deployed'");
  assert.equal(empty.severity, "error", "the payroll safety net being off is not a warning");

  // ── STAGING, 2026-10-08: everything registered, nothing ever captured ─────
  // This is the case that was misdiagnosed. It must NOT send the reader to snapshot_runs.
  const stagingOnTheDay: SchemaShape = {
    ...healthyShape(),
    recovery_health: productionRecovery().map((r) => ({
      ...r,
      snapshots_held: 0,
      newest_snapshot_at: null,
      ever_captured: false,
    })),
  };

  const neverRan = find(stagingOnTheDay, "recovery_never_ran");
  assert.ok(
    neverRan,
    "all 7 enabled tables uncaptured is 'it has never run', and must get its own code rather than the per-table one",
  );
  assert.equal(neverRan.severity, "error", "a store that has never captured anything must fail the check");
  assert.ok(
    !codes(stagingOnTheDay).includes("recovery_table_never_captured"),
    "the per-table code must NOT also fire — two codes for one fault is how a reader picks the wrong fix",
  );
  assert.ok(
    neverRan.message.includes("pg_cron") && neverRan.message.includes("cron.job"),
    "the message must name pg_cron and cron.job, because that is where the cause actually is",
  );
  assert.ok(
    neverRan.message.includes("phoenix-recovery-snapshot"),
    "the message must name production's job, so a restored database can be repaired without hunting for the schedule",
  );
  assert.ok(
    !neverRan.message.includes("snapshot_runs.error"),
    "it must NOT send the reader to snapshot_runs.error — on staging that table is EMPTY, which is what made the original message a dead end",
  );
  assert.ok(
    neverRan.message.includes("7"),
    "the count must be in the message, so the blast radius is visible without a catalog query",
  );

  // ── SOME uncaptured, while others are: that one really IS the function ────
  const partiallyCaptured: SchemaShape = {
    ...healthyShape(),
    recovery_health: productionRecovery().map((r, i) =>
      i < 2 ? { ...r, snapshots_held: 0, newest_snapshot_at: null, ever_captured: false } : r,
    ),
  };

  const perTable = find(partiallyCaptured, "recovery_table_never_captured");
  assert.ok(perTable, "2 of 7 uncaptured while the rest are captured must still be reported");
  assert.ok(
    !codes(partiallyCaptured).includes("recovery_never_ran"),
    "the never-ran code must not fire when the scheduler is demonstrably running for other tables",
  );
  assert.ok(
    perTable.message.includes("2 of 7"),
    "the per-table message must say 2 of 7, because the ratio is what distinguishes this fault from the one above",
  );
  assert.ok(
    perTable.message.includes("snapshot_runs.error"),
    "HERE the function really is the place to look, so this message keeps that pointer",
  );

  // ── one DISABLED table is not a fault ────────────────────────────────────
  // Disabling is how a table is taken out of the store deliberately; only `enabled` rows count.
  const oneDisabled: SchemaShape = {
    ...healthyShape(),
    recovery_health: productionRecovery().map((r, i) =>
      i === 0 ? { ...r, enabled: false, snapshots_held: 0, newest_snapshot_at: null, ever_captured: false } : r,
    ),
  };
  assert.deepEqual(
    codes(oneDisabled),
    [],
    "a deliberately disabled table with no snapshots must raise nothing, or the gate punishes the supported way to opt out",
  );

  // ── staleness is judged on the NEWEST across all tables, never per table ──
  // A snapshot is only written when contents CHANGE, so every table being individually old is
  // normal; every money table going a day and a half without one edit is not.
  const allStale: SchemaShape = {
    ...healthyShape(),
    recovery_health: productionRecovery().map((r) => ({
      ...r,
      newest_snapshot_at: new Date(Date.now() - 40 * HOUR).toISOString(),
    })),
  };
  const stale = find(allStale, "recovery_snapshot_stale");
  assert.ok(stale, "40 hours since the newest snapshot across every table must be reported");
  assert.ok(
    !codes(healthyShape()).includes("recovery_snapshot_stale"),
    "one recent capture must clear staleness even when six tables are 40 hours old, or the gate cries wolf on a normal week",
  );
}
