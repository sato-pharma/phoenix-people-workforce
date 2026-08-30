import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  evaluateSchemaShape,
  type SchemaShape,
  type SnapshotTableInPublic,
} from "../scripts/check-schema-shape.ts";
import { looksLikeSnapshot, SNAPSHOT_NAME_SQL } from "../scripts/lib/snapshot-name.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A point-in-time snapshot in `public` must be named the day it appears.
//
// `check:sql-backups` has applied this rule to `.sql` FILES since 2026-08-01, and it cannot
// see the case that actually keeps happening. All five pre-images relocated out of production
// `public` on 2026-08-30 were created by hand through MCP `execute_sql` during live fixes — no
// file was ever written, so that check had nothing to read and stayed green for days.
//
// `missing_primary_key` did eventually catch them, but late and for the wrong reason: a
// `create table ... as select` happens to carry no primary key. That makes it silenceable by
// the wrong fix — two migrations on 2026-08-27 added primary keys to the snapshots of that day,
// clearing the error while leaving every table in the one schema PostgREST serves, reported by
// nothing at all.
//
// So this asks the live database directly. The bar for this test is the same as the placement
// check's: the ACTUAL names that caused the incidents are flagged, and the shapes that are
// genuinely fine are not.
// ─────────────────────────────────────────────────────────────────────────────

/** The five relocated from production `public` on 2026-08-30, verbatim. */
const REAL_SNAPSHOTS = [
  "zz_backup_crm_customer_brick_resolutions_20260828",
  "zz_backup_crm_region_brick_resolutions_20260828",
  "hire_date_fix_20260829_pre",
  "probation_fix_20260829_pre",
  "probation_reanchor_20260829_pre",
];

/** The two that were readable with the public anon key before 2026-08-05. */
const HISTORICAL_EXPOSURES = ["crm_restamp_backup_20260801", "email_backfill_backup_20260730"];

/**
 * Live application tables that must NEVER be flagged. The four `*_snapshots` names are real
 * tables in production `public` today whose CONTENT happens to be snapshots, and
 * sales_ops_dashboard_snapshot was a real table with a policy — the case the weak tier's date
 * gate exists for.
 */
const LIVE_TABLES = [
  "sales_ops_dashboard_snapshot",
  "early_birds_period_snapshots",
  "field_workforce_compliance_live_snapshots",
  "sos_import_coverage_snapshots",
  "pg_stat_statements_snapshots",
  "employees",
  "salary_records",
  "ats_candidate_manager_sends",
  "direct_order_requests",
  "source_of_sales_fact_rollup",
];

function healthyShape(): SchemaShape {
  return {
    tables_total: 319,
    tables_rls_enabled: 319,
    tables_force_rls: 0,
    policies_total: 369,
    primary_keys_total: 319,
    unique_total: 100,
    foreign_keys_total: 314,
    check_total: 50,
    indexes_total: 1273,
    triggers_total: 74,
    schema_usage: { anon: true, authenticated: true, service_role: true },
    tables_exposed_without_rls: [],
    tables_rls_disabled: [],
    tables_without_primary_key: [],
    tables_rls_enabled_without_policy: [],
    default_acl_leaks: [],
    private_schema_usage: { anon: false, authenticated: true, service_role: true },
    policies_using_private_schema: 67,
    stale_snapshot_schemas: [],
    snapshot_tables_in_public: [],
  };
}

const sealed = (name: string): SnapshotTableInPublic => ({
  table_name: name,
  anon_select: false,
  authenticated_select: false,
  rls_enabled: false,
});

const codes = (shape: SchemaShape) => evaluateSchemaShape(shape).map((v) => v.code);
const find = (shape: SchemaShape, code: string) => evaluateSchemaShape(shape).find((v) => v.code === code);

export function runSchemaShapeSnapshotInPublicTests() {
  // ── the name rule ────────────────────────────────────────────────────────
  for (const name of REAL_SNAPSHOTS) {
    assert.ok(
      looksLikeSnapshot(name),
      `${name} was a real snapshot sitting in production public — the rule must catch it. Three of ` +
        "these five matched nothing before `pre` joined the weak tier, which is how a rule that " +
        "caught two fifths of the real cases looked like a rule that worked",
    );
  }

  for (const name of HISTORICAL_EXPOSURES) {
    assert.ok(looksLikeSnapshot(name), `${name} was readable with the public anon key — it must be caught`);
  }

  for (const name of LIVE_TABLES) {
    assert.equal(
      looksLikeSnapshot(name),
      false,
      `${name} is a live application table. Flagging one turns the daily run red for something ` +
        "nobody can act on, which is exactly how an alarm becomes furniture",
    );
  }

  // The date gate is what separates the two lists above — prove it decides, rather than the
  // weak word never mattering.
  assert.equal(looksLikeSnapshot("payroll_snapshot"), false, "an undated weak word is a description of content");
  assert.equal(looksLikeSnapshot("payroll_snapshot_20260830"), true, "the same word plus a date is a point in time");
  assert.equal(looksLikeSnapshot("employees_pre"), false, "an undated `_pre` is not a snapshot either");
  assert.equal(looksLikeSnapshot("employees_20260830_pre"), true, "a dated `_pre` is the house pre-image convention");
  // A strong word needs no date at all.
  assert.equal(looksLikeSnapshot("payroll_backup"), true, "a strong word stands alone");

  // ── the SQL and the TypeScript must not drift ────────────────────────────
  // Two enforcement points read one rule (scripts/lib/snapshot-name.ts), but the database copy
  // is text inside a migration and nothing else can compare them. A divergence is invisible in
  // every other way: each side would keep passing its own tests while disagreeing about what a
  // snapshot is.
  const asJs = (sql: string, flags: string) => new RegExp(sql.replace(/\[0-9\]/g, "\\d"), flags);
  const sqlRule = (name: string) =>
    asJs(SNAPSHOT_NAME_SQL.strong, "i").test(name) ||
    (asJs(SNAPSHOT_NAME_SQL.weak, "i").test(name) && asJs(SNAPSHOT_NAME_SQL.dated, "").test(name));

  for (const name of [...REAL_SNAPSHOTS, ...HISTORICAL_EXPOSURES, ...LIVE_TABLES, "payroll_snapshot", "employees_pre"]) {
    assert.equal(
      sqlRule(name),
      looksLikeSnapshot(name),
      `the SQL and TypeScript forms of the rule disagree about ${name} — the database and the ` +
        "file checker would then enforce two different definitions of `snapshot`",
    );
  }

  // ...and the migration must actually contain those patterns, or the function in the database
  // is not the rule this file just verified.
  const migration = fs.readFileSync(
    fileURLToPath(new URL("../supabase/migrations/20260830150000_ci_snapshot_tables_in_public.sql", import.meta.url)),
    "utf8",
  );
  for (const [tier, pattern] of Object.entries(SNAPSHOT_NAME_SQL)) {
    assert.ok(
      migration.includes(pattern),
      `phx_ci_snapshot_tables_in_public must use the shared ${tier} pattern verbatim; the migration ` +
        `does not contain ${pattern}`,
    );
  }
  assert.ok(
    /revoke execute on function public\.phx_ci_snapshot_tables_in_public\(\) from public, anon, authenticated/.test(
      migration,
    ),
    "a freshly created function grants EXECUTE to PUBLIC by default — this one reports table " +
      "reachability and must be revoked to service_role, like every other phx_ci_* gate",
  );

  // ── the violation ────────────────────────────────────────────────────────
  assert.deepEqual(
    codes(healthyShape()),
    [],
    "both databases were measured clean on 2026-08-30 — a clean public must raise nothing, or the " +
      "check is wrong about the target state",
  );

  const theFiveOnTheDay: SchemaShape = {
    ...healthyShape(),
    snapshot_tables_in_public: REAL_SNAPSHOTS.map(sealed),
  };
  const found = find(theFiveOnTheDay, "snapshot_table_in_public");
  assert.ok(found, "the five snapshots found in production public must be reported");
  assert.equal(
    found.severity,
    "error",
    "the identical rule already FAILS review in check:sql-backups — grading it lower here would " +
      "refuse a snapshot in a file while tolerating the same table in the database",
  );
  assert.ok(found.message.includes("5 point-in-time snapshot table(s)"), "the count must be visible without a query");
  for (const name of REAL_SNAPSHOTS) {
    assert.ok(found.message.includes(name), `${name} must be named — a count alone cannot be acted on`);
  }
  assert.ok(
    found.message.includes("set schema"),
    "the message must carry the remedy. `missing_primary_key` said 'no primary key', which invites " +
      "adding one — and that is precisely the wrong fix that silenced this on 2026-08-27",
  );
  // The message DOES mention a primary key — once, to refuse it. That refusal is load-bearing
  // rather than decorative: the two migrations on 2026-08-27 added primary keys to the snapshots
  // of the day, which cleared `missing_primary_key` and left every table sitting in `public`,
  // reported by nothing at all. Naming the wrong fix out loud is what stops a tired reader
  // repeating it at 4am. So the bar is not silence about primary keys — it is that every mention
  // is the refusal, never a prescription.
  assert.ok(
    /do not give it a primary key/i.test(found.message),
    "the message must name the wrong fix and refuse it, not merely omit it",
  );
  for (const mention of found.message.match(/.{0,32}primary key/gi) ?? []) {
    assert.ok(
      /do not give it a primary key$/i.test(mention),
      `every mention of a primary key must be that refusal, never a prescription — found "${mention.trim()}"`,
    );
  }

  // ── reachable and sealed must not read the same at 4am ───────────────────
  assert.ok(
    found.message.includes("None is reachable today"),
    "a sealed snapshot is placement, not exposure, and saying otherwise trains the reader to discount it",
  );

  const exposed: SchemaShape = {
    ...healthyShape(),
    snapshot_tables_in_public: [
      { table_name: "crm_restamp_backup_20260801", anon_select: true, authenticated_select: true, rls_enabled: false },
      sealed("hire_date_fix_20260829_pre"),
    ],
  };
  const live = find(exposed, "snapshot_table_in_public");
  assert.ok(live, "an anon-readable snapshot must still be reported");
  assert.ok(
    live.message.includes("READABLE by anon and authenticated"),
    "the message must say WHICH role can read it — that is the difference between tidying up and an incident",
  );
  assert.ok(
    live.message.includes("2026-08-01 exposure shape"),
    "the reachable case must name the incident it is repeating, so its severity is obvious at a glance",
  );
  assert.ok(
    !live.message.includes("None is reachable today"),
    "the sealed wording must not survive alongside a live exposure",
  );

  // ── targets that cannot answer must stay silent ──────────────────────────
  const olderRpc = healthyShape();
  delete olderRpc.snapshot_tables_in_public;
  assert.deepEqual(
    codes(olderRpc),
    [],
    "this check runs against production and staging independently; a target that predates the " +
      "migration returns no key and must stay silent rather than invent a violation",
  );
}
