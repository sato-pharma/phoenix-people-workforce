import assert from "node:assert/strict";
import { evaluateSchemaShape, type SchemaShape } from "../scripts/check-schema-shape.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The detector has to see the loaded gun, not just the shot.
//
// `exposed_without_rls` fires only once an exposed table EXISTS. It did fire for the six
// zz_backup_* tables — on 2026-08-06, 08-07 and 08-08 — but by then 412 customer names had
// already been readable with the public anon key for two days. The schema-wide default
// privilege that made them readable was there the whole time and nothing reported it.
//
// The severity split is the load-bearing part. A `postgres`-owned leak is fixable by a
// migration, so it is an error. A `supabase_admin`-owned leak is NOT: altering a
// pg_default_acl row requires membership in the owning role, and the migration runner has
// none. Grading it an error would make the daily check permanently red — which is exactly
// how the real alarm became background noise and went unread for three days.
// ─────────────────────────────────────────────────────────────────────────────

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
  };
}

const codes = (shape: SchemaShape) => evaluateSchemaShape(shape).map((v) => v.code);
const find = (shape: SchemaShape, code: string) => evaluateSchemaShape(shape).find((v) => v.code === code);

export function runSchemaShapeDefaultAclTests() {
  // ── a clean schema stays clean ────────────────────────────────────────────
  assert.deepEqual(codes(healthyShape()), [], "a healthy shape with no default-ACL leaks must raise nothing");

  // ── the exact production state measured 2026-08-09, AFTER the tables leg was
  //    revoked and BEFORE the sequences leg was: 2 fixable + 6 residual ──────
  const productionToday: SchemaShape = {
    ...healthyShape(),
    default_acl_leaks: [
      { granting_role: "postgres", obj_type: "SEQUENCES", grantee: "anon", privs: "SELECT,UPDATE,USAGE" },
      { granting_role: "postgres", obj_type: "SEQUENCES", grantee: "authenticated", privs: "SELECT,UPDATE,USAGE" },
      { granting_role: "supabase_admin", obj_type: "FUNCTIONS", grantee: "anon", privs: "EXECUTE" },
      { granting_role: "supabase_admin", obj_type: "FUNCTIONS", grantee: "authenticated", privs: "EXECUTE" },
      { granting_role: "supabase_admin", obj_type: "SEQUENCES", grantee: "anon", privs: "SELECT,UPDATE,USAGE" },
      { granting_role: "supabase_admin", obj_type: "SEQUENCES", grantee: "authenticated", privs: "SELECT,UPDATE,USAGE" },
      { granting_role: "supabase_admin", obj_type: "TABLES", grantee: "anon", privs: "DELETE,INSERT,SELECT,UPDATE" },
      { granting_role: "supabase_admin", obj_type: "TABLES", grantee: "authenticated", privs: "DELETE,INSERT,SELECT,UPDATE" },
    ],
  };

  const fixable = find(productionToday, "default_acl_grants_browser_roles");
  assert.ok(fixable, "a postgres-owned default-ACL leak must be reported");
  assert.equal(fixable.severity, "error", "postgres-owned leaks are fixable by migration, so they must fail the check");
  assert.ok(
    fixable.message.includes("SEQUENCES") && fixable.message.includes("postgres"),
    "the message must name the object type and granting role so the fix is obvious without a catalog query",
  );
  assert.ok(
    !fixable.message.includes("supabase_admin"),
    "the error must not fold in the unfixable rows — that is what makes a red check actionable",
  );

  const residual = find(productionToday, "default_acl_supabase_admin_residual");
  assert.ok(residual, "the supabase_admin residual must still be reported, not silently dropped");
  assert.equal(
    residual.severity,
    "warning",
    "supabase_admin's row cannot be altered without membership in that role; grading it an error would make the daily check permanently red",
  );

  // ── the state this work is driving toward: only the residual remains ──────
  const afterTheFix: SchemaShape = {
    ...healthyShape(),
    default_acl_leaks: productionToday.default_acl_leaks!.filter((l) => l.granting_role === "supabase_admin"),
  };
  assert.equal(
    find(afterTheFix, "default_acl_grants_browser_roles"),
    undefined,
    "once the postgres defaults are revoked the check must go green, or nobody will keep reading it",
  );
  assert.ok(find(afterTheFix, "default_acl_supabase_admin_residual"), "the residual stays visible as a warning");

  // ── PUBLIC counts: anon and authenticated are members of it ───────────────
  const publicGrant: SchemaShape = {
    ...healthyShape(),
    default_acl_leaks: [
      { granting_role: "postgres", obj_type: "TABLES", grantee: "PUBLIC", privs: "SELECT" },
    ],
  };
  assert.equal(
    find(publicGrant, "default_acl_grants_browser_roles")?.severity,
    "error",
    "a PUBLIC grantee reaches anon and authenticated through role membership, so it is the same leak",
  );

  // ── an RPC that predates this key must not invent a violation ─────────────
  const olderRpc = healthyShape();
  delete olderRpc.default_acl_leaks;
  assert.deepEqual(
    codes(olderRpc),
    [],
    "check:schema-shape runs against production and staging independently; an un-migrated RPC returns no key and must stay silent rather than fail",
  );
}
