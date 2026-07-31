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
// is a defect, not an exception. Every entry below is a dated ad-hoc backup and is a
// candidate for dropping outright.
const NO_PRIMARY_KEY_ALLOWED = new Set<string>([
  // email_backfill_backup_20260730 was removed 2026-08-01 when the table itself was
  // dropped (20260801100000). An allowlist that names tables which no longer exist
  // quietly stops being a guard — retire entries with the table, not later.
  "geo_locations_brick_centroid_backup2_20260728",
  "geo_locations_brick_centroid_backup_20260728",
]);

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
  return data as SchemaShape;
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
