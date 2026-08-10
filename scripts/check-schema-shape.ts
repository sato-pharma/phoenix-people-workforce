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

import { createClient } from "@supabase/supabase-js";

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
  schema_usage: { anon: boolean; authenticated: boolean; service_role: boolean };
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
};

/** A dated snapshot schema that is older than the retention window. */
export type StaleSnapshotSchema = {
  schema_name: string;
  taken_on: string;
  age_days: number;
  tables_count: number;
  size_bytes: number;
};

/** One (granting role, object type, grantee) triple from pg_default_acl in schema public. */
export type DefaultAclLeak = {
  granting_role: string;
  obj_type: string;
  grantee: string;
  privs: string;
};

export type Violation = { severity: "error" | "warning"; code: string; message: string };

/**
 * Pure assertion logic, separated from I/O so it can be tested against the real
 * numbers from both 2026-07-31 faults without touching a database.
 */
export function evaluateSchemaShape(shape: SchemaShape): Violation[] {
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

  // --- Fault 2: wholesale loss of the post-data section -----------------------
  // Floors, not exact counts: any healthy Phoenix database has these in quantity, and
  // zero can only mean the objects were never created or were dropped en masse.
  if (shape.tables_total > 0 && shape.policies_total === 0) {
    v.push({
      severity: "error",
      code: "no_rls_policies",
      message:
        `The schema has ${shape.tables_total} tables and ZERO RLS policies. Row-level security ` +
        "is the entire access-control model here; zero policies means it is not being enforced.",
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
