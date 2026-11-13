// Asserts the SHAPE of the public schema. Companion to check-migrations-applied.ts:
// that one proves migrations were RECORDED, this one proves the database actually has
// the structure and protection those migrations describe.
//
// WHY BOTH ARE NEEDED. On 2026-07-31 staging was found to have a perfect migration
// history and: 0 RLS policies, RLS switched off on all 284 tables, 0 foreign keys,
// 105 of 282 primary keys and 138 of 1096 indexes. It had been restored with only the
// PRE-data section of a dump on 2026-07-11 and nobody noticed for three weeks, because
// `schema_migrations` was fully populated the entire time. The drift check reported
// green throughout, correctly — it was answering a different question.
//
// Everything here is an INVARIANT, not a golden snapshot. Snapshots of "expected
// counts" rot on the first migration and get muted; these hold for any healthy Phoenix
// database and need no maintenance when the schema grows.
//
// Read-only: the single call is the phx_ci_schema_shape() RPC (see
// 20260731210000_ci_schema_shape_rpc.sql).

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "check-schema-shape",
  entry: import.meta.url,
  known: ["--json"],
});

// Tables legitimately without a primary key. Add here ONLY after confirming the table
// is a transient backup/scratch artifact -- a real domain table without a primary key
// is a defect, not an exception.
//
// EMPTY as of 2026-08-05, and it should stay that way. The four entries that lived here
// (two geo brick-centroid snapshots, two CRM re-stamp rollback tables) were retired by
// 20260805204502_move_adhoc_snapshots_out_of_public, which moved them into
// `geo_backup_20260728` and `crm_backup_20260801`. All four still exist and still have
// no primary key -- they are simply no longer in `public`, and phx_ci_schema_shape()
// only reports on `public`, so naming them here would now silence nothing. This list's
// own rule was to retire an entry WITH its table rather than later, because an allowlist
// naming tables the check can no longer see quietly stops being a guard; that applies
// just as much to tables it can no longer see because they moved.
//
// The note left here on 2026-08-01 said the standing fix was "to stop creating ad-hoc
// backups in `public` with default grants, not to keep extending this list". Both halves
// of that are now in place: scripts/check-sql-backup-placement.ts fails a snapshot table
// created in `public` at review time, and the four that already existed have been
// relocated out of it.
//
// So a new name appearing here means a snapshot was created in `public` again. The fix
// is to move it into a dated schema, not to add it to this list.
const NO_PRIMARY_KEY_ALLOWED = new Set<string>([]);

// Tables allowed to be reachable by anon/authenticated while RLS is DISABLED.
//
// Deliberately EMPTY, and it should stay that way. This is the one condition that is
// never merely untidy: a browser-facing role holding privileges on a table with no
// row-level security means the anon key -- which is public by design and hardcoded in
// ci.yml on the explicit justification that it is "RLS-protected" -- can read every
// row. That justification is only true while this set is empty.
//
// If a genuine exception ever arises, the right fix is almost always to REVOKE the
// grant, not to add a name here.
const EXPOSED_WITHOUT_RLS_ALLOWED = new Set<string>([]);

// Relations a browser role may read through a policy that filters NOTHING — a permissive
// `true` SELECT policy. Keyed "<relation>:<role>", and every entry carries its reason.
//
// This is a different question from the set above. There, RLS is off and the table is bare.
// Here RLS is ON and a policy EXISTS, so every count in this script reads green while the role
// named can select every row. An entry is justified only when the contents are genuinely public
// to that audience — a static lookup, never a person, an amount or a date.
//
// 🔴 EMPTY since 2026-10-26. Its one entry, `deductions_categories:authenticated`, was removed with
// the policy itself (20261026120500_deductions_categories_is_server_only.sql): no app code read the
// table, and the same grant handed every signed-in browser INSERT, UPDATE, DELETE and TRUNCATE on it.
// A `true` policy anywhere now fails this check again. The fix for a new one is to narrow the policy
// or revoke the grant, not to add a name here.
const TRUE_POLICY_ALLOWED: ReadonlyMap<string, string> = new Map<string, string>([]);

// Views/matviews a browser role may hold SELECT on WITHOUT `security_invoker`.
//
// 🔴 Deliberately EMPTY, and much harder to justify than the set above. A non-invoker view runs
// as its owner (`postgres` here), so it does not merely expose its own rows — it reads past the
// RLS of every table beneath it, for a role that has no grant on any of them. Nine of the
// eleven browser-granted views in `public` sit over payroll and org data, and are harmless
// today for exactly one reason: they are all `security_invoker = true`.
//
// The fix for a new name here is to add `security_invoker = true` to the view, or to revoke the
// grant. It is not to add the name.
const GRANTED_VIEW_NOT_INVOKER_ALLOWED = new Set<string>([]);

export type SchemaShape = {
  tables_total: number;
  tables_rls_enabled: number;
  tables_force_rls: number;
  policies_total: number;
  primary_keys_total: number;
  unique_total: number;
  foreign_keys_total: number;
  check_total: number;
  indexes_total: number;
  triggers_total: number;
  schema_usage: SchemaUsage;
  tables_exposed_without_rls: string[];
  tables_rls_disabled: string[];
  tables_without_primary_key: string[];
  tables_rls_enabled_without_policy: string[];
  /**
   * Schema-wide DEFAULT privileges that hand anon/authenticated access to objects not yet
   * created. `tables_exposed_without_rls` can only see a table that already exists and is
   * already exposed; this sees the loaded gun.
   *
   * Optional on purpose: the RPC only returns it once
   * 20260809181000_ci_schema_shape_default_acl.sql is applied, and this script runs against
   * production and staging independently. Treat `undefined` as "the RPC predates this check"
   * and stay silent rather than inventing a violation.
   */
  default_acl_leaks?: DefaultAclLeak[];
  /**
   * USAGE on schema `private`, where every RLS helper lives.
   *
   * `schema_usage` above only ever looked at `public`. On 2026-08-12 staging was found with
   * nspacl = NULL on `private` — no grants at all — while EXECUTE on each individual helper
   * was intact, so every grant anyone thought to check looked right. Without USAGE on the
   * containing schema the call raises 42501 before the function is entered, and every RLS
   * policy built on a helper becomes untestable there.
   *
   * `null`/`undefined` means "not measurable on this target" — either the RPC predates
   * 20260813120000_ci_schema_shape_private_usage.sql, or the database has no `private`
   * schema at all. Both must stay silent rather than invent a violation.
   */
  private_schema_usage?: SchemaUsage | null;
  /**
   * How many policies in `public` reference a `private.` object. This is what makes the
   * check above an invariant rather than a golden snapshot: USAGE is only demanded while
   * something actually depends on it, so a database with no such policies needs no
   * allowlist and raises nothing.
   */
  policies_using_private_schema?: number;
  /**
   * Dated snapshot schemas past the retention window.
   *
   * `check:sql-backups` stops a snapshot being created in `public`; nothing used to check
   * that one ever LEAVES. On 2026-08-10 there were 15 dated schemas plus 11 dated tables
   * inside `au` — 101 tables, 1,122,814 rows, 183 MB, oldest 13 days, none ever dropped.
   *
   * Optional for the same reason as `default_acl_leaks`: the RPC only exists once
   * 20260811000600_pg_health_snapshot_expiry_gate.sql is applied, and this script runs
   * against production and staging independently. `undefined` means "target predates the
   * check" and must stay silent rather than invent a violation.
   */
  stale_snapshot_schemas?: StaleSnapshotSchema[];
  /**
   * Point-in-time snapshot tables sitting in `public`, named by the shared rule in
   * scripts/lib/snapshot-name.ts.
   *
   * `check:sql-backups` applies that same rule to `.sql` FILES, so it catches a snapshot that
   * arrives as a migration. It cannot see the case that actually keeps happening: all five
   * pre-images relocated on 2026-08-30 were created by hand through MCP `execute_sql` during
   * live fixes, so no file existed and that check stayed green for days.
   *
   * `missing_primary_key` did eventually catch them, but late and for the wrong reason — a
   * `create table ... as select` happens to have no primary key. That makes it silenceable by
   * the wrong fix: two migrations on 2026-08-27 added primary keys to the snapshots of the day,
   * clearing the error while leaving every table in the one schema PostgREST serves, reported
   * by nothing.
   *
   * Optional for the same reason as `stale_snapshot_schemas`: the RPC only exists once
   * 20260830151500_ci_snapshot_tables_in_public.sql is applied, and this script runs against
   * production and staging independently. `undefined` means "target predates the check" and
   * must stay silent rather than invent a violation.
   */
  snapshot_tables_in_public?: SnapshotTableInPublic[];
  /** Optional for the same reason: only present once 20260929200500 is applied to this target. */
  recovery_health?: RecoveryHealth[];
  /**
   * The snapshotter's own run log (20261023043213_ci_recovery_runs.sql). Optional for the same
   * reason; when present, staleness is judged on it instead of on snapshot content.
   */
  recovery_runs?: RecoveryRuns;
  /** Optional for the same reason: only present once 20260929203200 is applied to this target. */
  browser_reachable?: BrowserReachable[];
  /**
   * Every foreign key to public.employees(hr_id) (20261113171643_ci_employee_keys.sql). Optional for
   * the same reason; when present it is compared with scripts/employee-key-baseline.json.
   */
  employee_keys?: EmployeeKey[];
};

/**
 * One foreign key from a column to public.employees(hr_id), as the live catalogue reports it.
 *
 * 🔴 REC-037 (enterprise audit 2026-11-13): "the orphan count is zero and stays zero". A VALIDATED key
 * makes an orphan row impossible, so "stays zero" is "every key stays, and stays validated". The
 * baseline is the list of keys that must exist; it may only grow.
 */
export type EmployeeKey = {
  table_schema: string;
  table_name: string;
  column_name: string;
  constraint_name: string;
  validated: boolean;
};

const EMPLOYEE_KEY_BASELINE_FILE = new URL("./employee-key-baseline.json", import.meta.url);

/** The committed list of keys that must exist, as `schema.table.column`. */
export function readEmployeeKeyBaseline(): string[] {
  const raw = JSON.parse(readFileSync(EMPLOYEE_KEY_BASELINE_FILE, "utf8")) as { keys?: unknown };
  if (!Array.isArray(raw.keys) || raw.keys.some((k) => typeof k !== "string")) {
    throw new Error("scripts/employee-key-baseline.json must hold { keys: string[] }");
  }
  return raw.keys as string[];
}

export const employeeKeyName = (k: Pick<EmployeeKey, "table_schema" | "table_name" | "column_name">) =>
  `${k.table_schema}.${k.table_name}.${k.column_name}`;

/** Whether each browser-facing/server role holds USAGE on a given schema. */
export type SchemaUsage = { anon: boolean; authenticated: boolean; service_role: boolean };

/** A dated snapshot schema that is older than the retention window. */
export type StaleSnapshotSchema = {
  schema_name: string;
  taken_on: string;
  age_days: number;
  tables_count: number;
  size_bytes: number;
};

/** A snapshot table found in `public`, with whether a browser-facing role can reach it. */
export type SnapshotTableInPublic = {
  table_name: string;
  anon_select: boolean;
  authenticated_select: boolean;
  rls_enabled: boolean;
};

/**
 * One protected table's standing in the hourly recovery undo log
 * (20260929200500_recovery_snapshot_store.sql).
 *
 * 🔴 THIS IS THE DEAD-MAN'S SWITCH, and it is the whole reason that RPC exists. Production has no
 * point-in-time recovery; the owner declined the ~$100/month add-on on 2026-09-29 and this undo
 * log stands in its place. A snapshotter that has quietly stopped is WORSE than none, because it
 * still looks like protection — pg_cron failures raise no alarm of their own, and the store keeps
 * its old rows, so nothing else in the system would ever say so.
 */
export type RecoveryHealth = {
  source_schema: string;
  source_table: string;
  enabled: boolean;
  snapshots_held: number;
  newest_snapshot_at: string | null;
  ever_captured: boolean;
};

/**
 * The hourly snapshotter's run log, summarised (20261023043213_ci_recovery_runs.sql).
 *
 * recovery.take_snapshots() writes one recovery.snapshot_runs row on EVERY invocation, whether or
 * not any table changed, so the newest error-free run answers "has the scheduler stopped?"
 * directly. Snapshot content cannot: a snapshot is written only on change, and staging's money
 * tables never change, so content age read 178 hours there on 2026-10-23 while the scheduler had
 * run 48 times in 48 hours without one error.
 */
export type RecoveryRuns = {
  newest_ok_run_at: string | null;
  runs_48h: number;
  failed_runs_48h: number;
};

/** The scheduler runs at five past every hour; three missed runs in a row is a stopped scheduler. */
const RECOVERY_RUN_STALE_HOURS = 3;

/** One (granting role, object type, grantee) triple from pg_default_acl in schema public. */
export type DefaultAclLeak = {
  granting_role: string;
  obj_type: string;
  grantee: string;
  privs: string;
};

/**
 * One relation in `public` that a browser role is granted SELECT on
 * (20260929203517_ci_browser_reachability.sql).
 *
 * 🔴 THE GAP THIS CLOSES: `exposed_without_rls` above fires only when RLS is DISABLED. Two ways
 * past RLS leave it ENABLED, a policy in place, and every existing count green.
 *
 *  1. A PERMISSIVE `true` read policy for a browser role — the policy filters nothing, so the
 *     table is wide open to that role while reading as fully protected.
 *  2. A granted VIEW that is not `security_invoker` — it runs as its OWNER and reads straight
 *     past the RLS of every table underneath it. A MATERIALIZED view cannot be
 *     `security_invoker` at all and has no RLS of its own, so a granted one is always a bypass.
 *
 * `security_invoker` IS checked elsewhere in this repo — but only as TEXT INSIDE MIGRATION FILES
 * (security-rls-static.ts, lib/migration-inventory.ts). Nothing had ever asked the live
 * database, so a view created by hand through execute_sql — which is how most of this schema has
 * actually arrived — or one later altered with `reset (security_invoker)`, passed all of them.
 *
 * Measured on production 2026-09-29: 80 granted relations, 0 non-invoker views, 1 `true` policy.
 * The nine views granted to `anon` include `v_employee_portal_payslips`; probing each with the
 * live anon key returned 401/42501, because `security_invoker` sends the read back through
 * anon's own (absent) grants on the underlying tables. **The grant is the loaded gun and
 * `security_invoker` is the safety catch** — which is exactly why losing it must be an error.
 */
export type BrowserReachable = {
  relname: string;
  relkind: string;
  anon_select: boolean;
  auth_select: boolean;
  rls_enabled: boolean;
  policy_count: number;
  /** null for a table, which has no such option; `false` on a view is a real finding. */
  security_invoker: boolean | null;
  /** Comma-separated roles holding a permissive `true` read policy, or null for none. */
  open_policy: string | null;
};

export type Violation = { severity: "error" | "warning"; code: string; message: string };

/**
 * Pure assertion logic, separated from I/O so it can be tested against the real
 * numbers from both 2026-07-31 faults without touching a database.
 */
export function evaluateSchemaShape(
  shape: SchemaShape,
  options: { truePolicyAllowed?: ReadonlyMap<string, string>; employeeKeyBaseline?: readonly string[] } = {},
): Violation[] {
  const truePolicyAllowed = options.truePolicyAllowed ?? TRUE_POLICY_ALLOWED;
  const v: Violation[] = [];

  // --- The security invariant -------------------------------------------------
  const exposed = shape.tables_exposed_without_rls.filter((t) => !EXPOSED_WITHOUT_RLS_ALLOWED.has(t));
  if (exposed.length > 0) {
    v.push({
      severity: "error",
      code: "exposed_without_rls",
      message:
        `${exposed.length} table(s) are reachable by anon/authenticated with RLS DISABLED, so the ` +
        `public anon key can read them in full: ${exposed.join(", ")}. ` +
        `Fix by enabling RLS and adding policies, or by revoking the grant.`,
    });
  }

  // --- The security invariant, one step earlier -------------------------------
  // `exposed_without_rls` above fires only once an exposed table EXISTS. On 2026-08-06 six
  // ad-hoc backup tables were born readable because schema-wide default privileges granted
  // anon everything on every new table in `public`; nobody granted anything. This catches
  // that state before the next table inherits it.
  //
  // supabase_admin is a WARNING, not an error, and that distinction is load-bearing: a
  // pg_default_acl row can only be altered by a member of the role that owns it, and the
  // migration runner (postgres) is not a member of supabase_admin. Making it an error would
  // mean a permanently red check nobody can fix — which is precisely how the daily drift
  // check became background noise and this leak sat unseen for three days.
  if (shape.default_acl_leaks && shape.default_acl_leaks.length > 0) {
    const describe = (l: DefaultAclLeak) => `${l.granting_role}/${l.obj_type} -> ${l.grantee} (${l.privs})`;
    const fixable = shape.default_acl_leaks.filter((l) => l.granting_role !== "supabase_admin");
    const residual = shape.default_acl_leaks.filter((l) => l.granting_role === "supabase_admin");

    if (fixable.length > 0) {
      v.push({
        severity: "error",
        code: "default_acl_grants_browser_roles",
        message:
          `${fixable.length} schema-wide DEFAULT privilege(s) in public still grant anon/authenticated, ` +
          `so every object created from now on is born reachable with the public anon key: ` +
          `${fixable.map(describe).join("; ")}. ` +
          `Fix with: alter default privileges in schema public revoke all on <tables|sequences> ` +
          `from anon, authenticated;`,
      });
    }

    if (residual.length > 0) {
      v.push({
        severity: "warning",
        code: "default_acl_supabase_admin_residual",
        message:
          `${residual.length} default privilege(s) owned by supabase_admin still grant ` +
          `anon/authenticated: ${residual.map(describe).join("; ")}. ` +
          `Not alterable from the migration runner (that needs membership in supabase_admin). ` +
          `It only fires for objects created BY supabase_admin in public — in practice ` +
          `\`create extension ... with schema public\`, so install extensions into \`extensions\`.`,
      });
    }
  }

  // --- Fault 1: the grant wipe ------------------------------------------------
  if (!shape.schema_usage.service_role) {
    v.push({
      severity: "error",
      code: "service_role_no_schema_usage",
      message:
        "service_role has no USAGE on schema public — server-side code, CI and the migration " +
        "drift check cannot reach any table. This is what happened on 2026-07-30.",
    });
  }

  // --- Fault 1b: the same wipe, one schema over -------------------------------
  // The check above only ever looked at `public`. On 2026-08-12 staging was found with
  // nspacl = NULL on schema `private` — where every RLS helper lives — while production had
  // `authenticated=U | service_role=U`. EXECUTE on each individual helper was intact on
  // staging, so the grants anyone thought to check all looked right; the call still raised
  // 42501 "permission denied for schema private" before the function was entered.
  //
  // That made all 67 policies built on those helpers untestable on staging: impersonating
  // `authenticated` to exercise one failed on the permission error, so every RLS test run
  // there was vacuous. It is the same class of fault as the 2026-07-30 wipe above and the
  // pre-data-only restore this whole file exists for — a database that looks protected,
  // reports a clean migration history, and is not.
  //
  // Gated on `policies_using_private_schema` so this is an invariant, not a snapshot: USAGE
  // is only demanded while policies actually depend on reaching `private`.
  if (shape.private_schema_usage) {
    const usage = shape.private_schema_usage;
    const dependents = shape.policies_using_private_schema ?? 0;

    if (dependents > 0 && !usage.authenticated) {
      v.push({
        severity: "error",
        code: "private_schema_no_usage_for_authenticated",
        message:
          `${dependents} RLS policies in public call into schema private, but \`authenticated\` has ` +
          "no USAGE on it — every one of those calls raises 42501 before the helper runs, so no " +
          "policy that uses one can be enforced OR tested against this database. Per-function " +
          "EXECUTE grants do not substitute for schema USAGE and may all look correct. " +
          "Fix with: grant usage on schema private to authenticated;",
      });
    }

    // The opposite direction, and a genuine widening: `private` is where the helpers that
    // DECIDE access live, and production does not grant anon USAGE on it.
    if (usage.anon) {
      v.push({
        severity: "error",
        code: "private_schema_exposed_to_anon",
        message:
          "`anon` has USAGE on schema private, which holds the helpers that decide row-level " +
          "access. Production grants it to authenticated and service_role only. " +
          "Fix with: revoke all on schema private from anon;",
      });
    }

    // Not an error: nothing in CI reaches `private` as service_role (PostgREST does not
    // expose the schema), so this breaks no check today. It is still drift from production,
    // and the 2026-08-12 finding was that BOTH grants were missing on staging while only the
    // `authenticated` half was noticed.
    if (!usage.service_role) {
      v.push({
        severity: "warning",
        code: "private_schema_no_usage_for_service_role",
        message:
          "`service_role` has no USAGE on schema private, where production grants it. Nothing in " +
          "CI depends on it today, so this is convergence drift rather than a breakage — but it " +
          "is the other half of the grant that went missing on staging on 2026-08-12. " +
          "Fix with: grant usage on schema private to service_role;",
      });
    }
  }

  // --- Fault 2: wholesale loss of the post-data section -----------------------
  // Floors, not exact counts: any healthy Phoenix database has these in quantity, and
  // zero can only mean the objects were never created or were dropped en masse.
  if (shape.tables_total > 0 && shape.policies_total === 0) {
    v.push({
      severity: "error",
      code: "no_rls_policies",
      message:
        `The schema has ${shape.tables_total} tables and ZERO RLS policies. That is not a policy ` +
        "gap, it is the signature of a restore where only the pre-data section ran — this " +
        "database carries 433 of them. (RLS is NOT the whole access-control model here: " +
        "`assertPermission` on the server is, and most code paths use the service-role client. " +
        "RLS is the backstop for the public anon key. Both are true, and an alarm that " +
        "overstates the first teaches the reader to discount it.)",
    });
  }
  if (shape.tables_total > 0 && shape.foreign_keys_total === 0) {
    v.push({
      severity: "error",
      code: "no_foreign_keys",
      message:
        `The schema has ${shape.tables_total} tables and ZERO foreign keys. Referential integrity ` +
        "is unenforced — the signature of a restore where only the pre-data section ran.",
    });
  }

  const rlsDisabledUnexpected = shape.tables_rls_disabled.filter(
    (t) => !EXPOSED_WITHOUT_RLS_ALLOWED.has(t) && !NO_PRIMARY_KEY_ALLOWED.has(t),
  );
  if (rlsDisabledUnexpected.length > 0) {
    v.push({
      severity: "warning",
      code: "rls_disabled",
      message:
        `${rlsDisabledUnexpected.length} table(s) have RLS disabled. Not itself a breach while no ` +
        `browser-facing role can reach them, but it removes the safety net if a grant is ever ` +
        `added: ${rlsDisabledUnexpected.slice(0, 10).join(", ")}` +
        (rlsDisabledUnexpected.length > 10 ? ", …" : ""),
    });
  }

  const missingPk = shape.tables_without_primary_key.filter((t) => !NO_PRIMARY_KEY_ALLOWED.has(t));
  if (missingPk.length > 0) {
    v.push({
      severity: "error",
      code: "missing_primary_key",
      message:
        `${missingPk.length} table(s) have no primary key: ${missingPk.slice(0, 10).join(", ")}` +
        (missingPk.length > 10 ? ", …" : "") +
        ". Besides the integrity risk, a missing primary key silently blocks any migration that " +
        "adds a foreign key referencing the table — which is how the 2026-07-11 fault surfaced.",
    });
  }

  // Informational only, and deliberately NOT an error: a table with RLS on and no
  // policies is fail-closed (deny-all), which is the safe direction. Production and
  // staging both legitimately have a number of these.
  if (shape.tables_rls_enabled_without_policy.length > 0) {
    v.push({
      severity: "warning",
      code: "rls_enabled_without_policy",
      message:
        `${shape.tables_rls_enabled_without_policy.length} table(s) have RLS enabled but no policy ` +
        "(deny-all). Safe, but confirm each is deliberate rather than an unfinished migration.",
    });
  }

  // A snapshot schema that outlived its purpose. Warning, not error: dropping one is a
  // judgement call about data nobody else holds, so this asks rather than blocks. It only
  // has to be loud enough that 15 of them cannot pile up unnoticed again.
  if (shape.stale_snapshot_schemas && shape.stale_snapshot_schemas.length > 0) {
    const stale = shape.stale_snapshot_schemas;
    const mb = Math.round(stale.reduce((sum, s) => sum + Number(s.size_bytes ?? 0), 0) / 1048576);
    const oldest = stale.reduce((a, b) => (a.age_days >= b.age_days ? a : b));
    v.push({
      severity: "warning",
      code: "stale_snapshot_schema",
      message:
        `${stale.length} dated snapshot schema(s) are past the retention window, holding ~${mb} MB ` +
        `(oldest: ${oldest.schema_name}, ${oldest.age_days} days). ` +
        `Export then \`drop schema … cascade\` per docs/security/backup-table-placement.md, ` +
        `or rename it without a trailing date if it is meant to be permanent: ` +
        stale.slice(0, 10).map((s) => `${s.schema_name} (${s.age_days}d)`).join(", ") +
        (stale.length > 10 ? ", …" : ""),
    });
  }

  // A point-in-time snapshot in `public`, named the day it appears rather than a week later
  // as a side effect of having no primary key.
  //
  // ERROR, not warning, and that is a measured decision rather than a preference. The same
  // rule already FAILS review in check:sql-backups, so grading it lower here would mean the
  // repository refusing a snapshot in a file while tolerating the identical table in the
  // database. Before shipping it was run against both live databases: zero of the 319
  // production and 318 staging tables in `public` on 2026-08-30 match, so this can only go red when someone
  // actually puts a snapshot there — which is the whole intent, and why it needs no allowlist.
  //
  // The reachability split is what makes the message actionable. A snapshot nothing can read
  // is untidy; one `anon` or `authenticated` can read is the 2026-08-01 incident happening
  // again, and the two must not print the same way at 4am.
  if (shape.snapshot_tables_in_public && shape.snapshot_tables_in_public.length > 0) {
    const snaps = shape.snapshot_tables_in_public;
    const reachable = snaps.filter((s) => s.anon_select || s.authenticated_select);
    const describe = (s: SnapshotTableInPublic) =>
      s.anon_select || s.authenticated_select
        ? `${s.table_name} (READABLE by ${[s.anon_select ? "anon" : null, s.authenticated_select ? "authenticated" : null]
            .filter(Boolean)
            .join(" and ")})`
        : s.table_name;
    v.push({
      severity: "error",
      code: "snapshot_table_in_public",
      message:
        `${snaps.length} point-in-time snapshot table(s) are in \`public\`, the only schema PostgREST ` +
        `serves: ${snaps.slice(0, 10).map(describe).join(", ")}${snaps.length > 10 ? ", …" : ""}. ` +
        (reachable.length > 0
          ? `${reachable.length} of them can be read by a browser-facing role RIGHT NOW — that is the ` +
            "2026-08-01 exposure shape, not untidiness. "
          : "None is reachable today, so this is placement rather than exposure — but that protection " +
            "rests on grants staying exactly as they are. ") +
        "Move it, do not give it a primary key: `create schema if not exists <domain>_backup_YYYYMMDD; " +
        "revoke all on schema <domain>_backup_YYYYMMDD from anon, authenticated; " +
        "alter table public.<name> set schema <domain>_backup_YYYYMMDD;` — see " +
        "docs/security/backup-table-placement.md.",
    });
  }

  // 🔴 THE RECOVERY UNDO LOG'S DEAD-MAN'S SWITCH.
  //
  // Production has no point-in-time recovery. The hourly snapshot store
  // (docs/security/recovery-snapshots.md) is what stands in its place, and a store that has
  // silently stopped is worse than none because it still looks like protection. pg_cron raises
  // no alarm of its own and the old rows stay put, so without this nothing would ever say so.
  //
  // `undefined` means the migration is not on this target yet — stay silent, same as the gates
  // above. An empty array means it IS deployed and the registry is empty, which is a real fault.
  if (shape.recovery_health !== undefined) {
    const enabled = shape.recovery_health.filter((r) => r.enabled);
    const never = enabled.filter((r) => !r.ever_captured);
    // A snapshot is written only when the contents CHANGE, so an old newest_snapshot_at is
    // normal and healthy — au.line_area_map changes about monthly. Staleness therefore cannot be
    // judged per table; it is judged on the newest capture across ALL of them, because it would
    // be extraordinary for every money table to go a full day without a single edit.
    const newest = enabled
      .map((r) => r.newest_snapshot_at)
      .filter((t): t is string => typeof t === "string")
      .sort()
      .at(-1);
    const hoursSince = newest ? (Date.now() - Date.parse(newest)) / 3_600_000 : Infinity;

    if (enabled.length === 0) {
      v.push({
        severity: "error",
        code: "recovery_registry_empty",
        message:
          "The recovery undo log is deployed but protects nothing: recovery.protected_tables has " +
          "no enabled rows. Production has no PITR, so this is the payroll safety net being off.",
      });
    } else if (never.length === enabled.length) {
      // 🔴 EVERY enabled table uncaptured is a DIFFERENT fault from SOME of them, and saying
      // "something is failing inside take_snapshots()" here sends the reader to an empty table.
      // take_snapshots() writes a recovery.snapshot_runs row on every invocation, success or
      // failure, so if it had ever run, at least one table would have been captured — a store
      // with nothing in it at all has never been CALLED. Measured on staging on the morning of
      // 2026-10-08, which is the reading this code was written from: all 7 registered and enabled,
      // 0 snapshots, `recovery.snapshot_runs` EMPTY, and `cron.job` absent because pg_cron was not
      // installed there. A session told to "read recovery.snapshot_runs.error" read zero rows and
      // learned nothing. (Staging got pg_cron and this schedule later the same day, so it is no
      // longer an example of the state — the shape it taught is what matters.)
      //
      // The schedule used to be hand-made state, which is how a restored database came back with
      // the store deployed and never running. Since 20261008140000_schedule_recovery_snapshot_cron
      // a migration creates it, so the first thing to check is whether that migration ran here —
      // it SKIPS with a warning where pg_cron is absent, which is a real and reachable way to be
      // in this state rather than a reason to go hunting inside take_snapshots().
      v.push({
        severity: "error",
        code: "recovery_never_ran",
        message:
          `The recovery undo log has captured NOTHING: all ${enabled.length} enabled table(s) ` +
          `are uncaptured (${never.map((r) => `${r.source_schema}.${r.source_table}`).join(", ")}). ` +
          "take_snapshots() writes a recovery.snapshot_runs row on every invocation, so this is " +
          "not a failure inside it — it has never been CALLED. Check that pg_cron is installed " +
          "(`select * from pg_extension where extname = 'pg_cron'`) and that the job exists " +
          "(`select jobname, schedule, active from cron.job`). Production's is " +
          "`phoenix-recovery-snapshot` at `5 * * * *`, created by migration " +
          "20261008140000_schedule_recovery_snapshot_cron — which skips with a warning where " +
          "pg_cron is not installed, so install pg_cron and re-apply it rather than scheduling " +
          "by hand.",
      });
    } else if (never.length > 0) {
      v.push({
        severity: "error",
        code: "recovery_table_never_captured",
        message:
          `${never.length} of ${enabled.length} protected table(s) have never been captured by ` +
          "the recovery undo log: " +
          `${never.map((r) => `${r.source_schema}.${r.source_table}`).join(", ")}. ` +
          "The others HAVE been, so the scheduler is running and these specific tables are " +
          "failing inside recovery.take_snapshots() — read recovery.snapshot_runs.error, and " +
          "check each one's pk_columns and max_rows in recovery.protected_tables.",
      });
    } else if (shape.recovery_runs !== undefined) {
      // The run log is the direct signal, so it replaces the content-age proxy below.
      const runs = shape.recovery_runs;
      const runHours = runs.newest_ok_run_at
        ? (Date.now() - Date.parse(runs.newest_ok_run_at)) / 3_600_000
        : Infinity;
      if (runHours > RECOVERY_RUN_STALE_HOURS) {
        v.push({
          severity: "error",
          code: "recovery_snapshot_stale",
          message:
            (runs.newest_ok_run_at
              ? `The recovery snapshotter's last error-free run was ${Math.round(runHours)} hours ago `
              : "The recovery snapshotter has never finished a run without an error ") +
            `(${runs.runs_48h} run(s) in the last 48 hours, ${runs.failed_runs_48h} failed). It runs at ` +
            "five past every hour, so it has stopped or is failing. Check `select * from cron.job` " +
            "and `recovery.snapshot_runs.error`.",
        });
      }
    } else if (hoursSince > 36) {
      v.push({
        severity: "error",
        code: "recovery_snapshot_stale",
        message:
          `The newest recovery snapshot across all ${enabled.length} protected tables is ` +
          `${Math.round(hoursSince)} hours old. Snapshots are written only on change, so gaps are ` +
          "normal per table — but every money table going this long without one edit is not. " +
          "Check `select * from cron.job` and `recovery.snapshot_runs` for a stopped scheduler.",
      });
    }
  }

  // 🔴 BROWSER REACHABILITY — the two ways past RLS that leave it switched ON.
  //
  // `exposed_without_rls` at the top of this function fires only when RLS is DISABLED, and on
  // production that set is empty. These two are not covered by it, or by anything else here:
  // in both, RLS reads as enabled and the role can still select every row.
  //
  // `undefined` means 20260929203200 is not on this target yet — stay silent, as above.
  if (shape.browser_reachable !== undefined) {
    // 1. A permissive `true` read policy filters nothing. Flagged per (relation, role) so that
    //    allowing it for `authenticated` never silently also allows it for `anon`.
    const openToRole: string[] = [];
    for (const r of shape.browser_reachable) {
      if (!r.open_policy) continue;
      for (const role of r.open_policy.split(",")) {
        const key = `${r.relname}:${role}`;
        // A PUBLIC policy reaches anon too, so it is never covered by an `authenticated` entry.
        if (!truePolicyAllowed.has(key)) openToRole.push(key);
      }
    }
    if (openToRole.length > 0) {
      const anonReachable = openToRole.filter((k) => k.endsWith(":anon") || k.endsWith(":PUBLIC"));
      v.push({
        severity: "error",
        code: "browser_readable_via_true_policy",
        message:
          `${openToRole.length} relation/role pair(s) have a permissive read policy of \`true\`, ` +
          `so the policy filters nothing and the role reads every row: ${openToRole.join(", ")}. ` +
          (anonReachable.length > 0
            ? `${anonReachable.length} of them reach ANON, which is the public key — treat as a live breach. `
            : "") +
          "RLS being enabled does not make this safe; it is why no other check here sees it. " +
          "Fix by narrowing the policy or revoking the grant, not by adding to TRUE_POLICY_ALLOWED.",
      });
    }

    // 2. A granted view that is not security_invoker runs as its OWNER, reading past the RLS of
    //    every table beneath it. A matview cannot be security_invoker at all.
    const bypassing = shape.browser_reachable.filter(
      (r) =>
        (r.relkind === "view" || r.relkind === "matview") &&
        r.security_invoker !== true &&
        !GRANTED_VIEW_NOT_INVOKER_ALLOWED.has(r.relname),
    );
    if (bypassing.length > 0) {
      v.push({
        severity: "error",
        code: "granted_view_bypasses_rls",
        message:
          `${bypassing.length} view(s)/matview(s) are granted to a browser role WITHOUT ` +
          `security_invoker, so they run as their owner and read past the RLS of every table ` +
          `underneath: ${bypassing
            .map((r) => `${r.relname} (${r.relkind}${r.anon_select ? ", ANON" : ""})`)
            .join(", ")}. ` +
          "Add `security_invoker = true` to the view, or revoke the grant. A matview cannot " +
          "carry that option at all, so a granted one must have its grant revoked.",
      });
    }
  }

  // 🔴 REC-037 — EVERY EMPLOYEE KEY IN THE BASELINE STAYS, AND STAYS VALIDATED. The repository test
  // pins the migrations that added the keys; it cannot see one dropped or re-added NOT VALID by hand,
  // and by hand is how most of this schema has changed. A key gone means a money, leave or attendance
  // row can name nobody again, silently, in every report that joins on the id.
  if (shape.employee_keys !== undefined) {
    const baseline = options.employeeKeyBaseline ?? readEmployeeKeyBaseline();
    const live = new Map(shape.employee_keys.map((k) => [employeeKeyName(k), k]));
    const dropped = baseline.filter((name) => !live.has(name));
    if (dropped.length > 0) {
      v.push({
        severity: "error",
        code: "employee_key_dropped",
        message:
          `${dropped.length} of the ${baseline.length} foreign keys to public.employees(hr_id) in ` +
          `scripts/employee-key-baseline.json are gone from this database: ${dropped.join(", ")}. ` +
          "Each one is what stops a row naming nobody. Put it back with a migration (orphan count first, " +
          "then NOT VALID, then VALIDATE); removing one is a decision the owner is told about first.",
      });
    }
    const unvalidated = shape.employee_keys.filter((k) => !k.validated).map(employeeKeyName);
    if (unvalidated.length > 0) {
      v.push({
        severity: "error",
        code: "employee_key_not_validated",
        message:
          `${unvalidated.length} foreign key(s) to public.employees(hr_id) are NOT VALID: ` +
          `${unvalidated.join(", ")}. A key that was never validated does not vouch for the rows already ` +
          "there. Count the orphans, repair them, then `alter table ... validate constraint ...`.",
      });
    }
    const listed = new Set(baseline);
    const unlisted = [...live.keys()].filter((name) => !listed.has(name));
    if (unlisted.length > 0) {
      v.push({
        severity: "warning",
        code: "employee_key_baseline_behind",
        message:
          `${unlisted.length} foreign key(s) to public.employees(hr_id) exist here but are not in ` +
          `scripts/employee-key-baseline.json: ${unlisted.join(", ")}. Add them, so the count can never ` +
          "fall back below them unnoticed.",
      });
    }
  }

  return v;
}

async function loadShape(): Promise<SchemaShape> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cannot reach the target Supabase project.",
    );
  }
  const supabase = createClient(url, key);
  const { data, error } = await supabase.rpc("phx_ci_schema_shape");
  if (error) throw new Error(`phx_ci_schema_shape RPC failed: ${error.message}`);
  if (!data) throw new Error("phx_ci_schema_shape returned no data.");
  const shape = data as SchemaShape;

  // Separate RPC so this gate could be added without touching phx_ci_schema_shape. A target
  // that predates the migration returns an error here; that is "check not deployed yet",
  // not a violation, so it stays undefined and evaluateSchemaShape stays quiet.
  const stale = await supabase.rpc("phx_ci_stale_snapshot_schemas", { p_max_age_days: 30 });
  if (stale.error) {
    console.log(
      `[schema-shape] snapshot-expiry gate not available on this target (${stale.error.message}) — skipping.`,
    );
  } else {
    shape.stale_snapshot_schemas = (stale.data ?? []) as StaleSnapshotSchema[];
  }

  // Same pattern, same reason (20260830151500_ci_snapshot_tables_in_public.sql). Asks the
  // database directly which snapshot tables are in `public`, so a snapshot created by hand
  // through execute_sql — which is how every one of them has actually arrived — is named the
  // day it appears, instead of a week later as a side effect of having no primary key.
  const snapshots = await supabase.rpc("phx_ci_snapshot_tables_in_public");
  if (snapshots.error) {
    console.log(
      `[schema-shape] snapshot-in-public gate not available on this target (${snapshots.error.message}) — skipping.`,
    );
  } else {
    shape.snapshot_tables_in_public = (snapshots.data ?? []) as SnapshotTableInPublic[];
  }

  // Same pattern again (20260929200500_recovery_snapshot_store.sql). This one is the dead-man's
  // switch for the hourly recovery undo log: with no PITR behind it, a snapshotter that stopped
  // is the failure nobody would otherwise see.
  const recovery = await supabase.rpc("phx_ci_recovery_health");
  if (recovery.error) {
    console.log(
      `[schema-shape] recovery-undo-log gate not available on this target (${recovery.error.message}) — skipping.`,
    );
  } else {
    shape.recovery_health = (recovery.data ?? []) as RecoveryHealth[];
  }

  // The run log behind the same switch (20261023043213_ci_recovery_runs.sql); absent on a target
  // that predates it, and then staleness falls back to snapshot content age.
  const recoveryRuns = await supabase.rpc("phx_ci_recovery_runs");
  if (recoveryRuns.error) {
    console.log(
      `[schema-shape] recovery run log not available on this target (${recoveryRuns.error.message}) — judging staleness on snapshot content.`,
    );
  } else {
    const row = ((recoveryRuns.data ?? []) as RecoveryRuns[])[0];
    if (row) shape.recovery_runs = row;
  }

  // Same pattern again (20260929203517_ci_browser_reachability.sql). Asks the LIVE catalogue
  // what a browser role can actually reach — the one question `security_invoker` greps over
  // migration text cannot answer, because most of this schema arrived through execute_sql.
  const reachable = await supabase.rpc("phx_ci_browser_reachability");
  if (reachable.error) {
    console.log(
      `[schema-shape] browser-reachability gate not available on this target (${reachable.error.message}) — skipping.`,
    );
  } else {
    shape.browser_reachable = (reachable.data ?? []) as BrowserReachable[];
  }

  // Same pattern again (20261113171643_ci_employee_keys.sql, REC-037): every key that ties a row to a
  // real employee, judged against scripts/employee-key-baseline.json.
  const employeeKeys = await supabase.rpc("phx_ci_employee_keys");
  if (employeeKeys.error) {
    console.log(
      `[schema-shape] employee-key gate not available on this target (${employeeKeys.error.message}) — skipping.`,
    );
  } else {
    shape.employee_keys = (employeeKeys.data ?? []) as EmployeeKey[];
  }

  return shape;
}

function projectRef(url: string | undefined): string {
  const m = /https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url ?? "");
  return m ? m[1] : "unknown";
}

async function main() {
  const ref = projectRef(process.env.NEXT_PUBLIC_SUPABASE_URL);
  console.log(`[schema-shape] target project ref: ${ref}`);

  const shape = await loadShape();

  console.log(
    `[schema-shape] ${shape.tables_total} tables · ${shape.tables_rls_enabled} with RLS · ` +
      `${shape.policies_total} policies · ${shape.primary_keys_total} PKs · ` +
      `${shape.foreign_keys_total} FKs · ${shape.indexes_total} indexes · ${shape.triggers_total} triggers`,
  );

  // Printed even when green: the 2026-08-12 gap survived because nothing ever stated this
  // out loud, so there was no baseline to notice a change against.
  if (shape.private_schema_usage) {
    const u = shape.private_schema_usage;
    console.log(
      `[schema-shape] schema private USAGE — authenticated: ${u.authenticated} · ` +
        `service_role: ${u.service_role} · anon: ${u.anon} ` +
        `(${shape.policies_using_private_schema ?? 0} policies depend on it)`,
    );
  }

  if (shape.employee_keys) {
    const validated = shape.employee_keys.filter((k) => k.validated).length;
    console.log(
      `[schema-shape] employee keys — ${shape.employee_keys.length} live, ${validated} validated · ` +
        `baseline ${readEmployeeKeyBaseline().length} (may only rise)`,
    );
  }

  if (process.argv.includes("--json")) console.log(JSON.stringify(shape, null, 2));

  const violations = evaluateSchemaShape(shape);
  const errors = violations.filter((x) => x.severity === "error");
  const warnings = violations.filter((x) => x.severity === "warning");

  for (const w of warnings) console.warn(`[schema-shape] WARN  ${w.code}: ${w.message}`);

  if (errors.length === 0) {
    console.log(
      `[schema-shape] OK — schema shape is sound on ${ref}` +
        (warnings.length ? ` (${warnings.length} warning(s))` : ""),
    );
    return;
  }

  for (const e of errors) console.error(`[schema-shape] ERROR ${e.code}: ${e.message}`);
  console.error(
    `[schema-shape] ${errors.length} error(s) on ${ref}. A green migration history does NOT imply ` +
      "a sound schema — that is precisely the gap this check exists to close.",
  );
  // process.exitCode, not process.exit(): exiting while the Supabase client's handles
  // are still being torn down aborts the process on Windows (libuv
  // "!(handle->flags & UV_HANDLE_CLOSING)"), replacing the real exit code with garbage
  // AFTER the check has already printed its verdict. Setting the code and letting Node
  // drain is both the cleaner idiom and locally usable.
  process.exitCode = 1;
}

// Only run when invoked directly, so the test can import evaluateSchemaShape().
if (process.argv[1] && /check-schema-shape\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error("[schema-shape] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
