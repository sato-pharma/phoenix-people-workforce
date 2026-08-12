import assert from "node:assert/strict";
import { evaluateSchemaShape, type SchemaShape } from "../scripts/check-schema-shape.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A missing schema USAGE grant makes every RLS test vacuous.
//
// On 2026-08-12 staging had pg_namespace.nspacl = NULL on `private` — no grants at all —
// while production had `authenticated=U | service_role=U`. EXECUTE on each individual
// helper was intact on staging: phx_current_hr_id, phx_visible_hr_ids, phx_resigned_hr_ids,
// phx_has_company_access, phx_can_manage_payroll and phx_can_manage_outstation all reported
// has_function_privilege(..., 'EXECUTE') = true. Every grant a reviewer thinks to check was
// present, and the call still raised 42501 before the function was entered.
//
// 67 policies across 19 tables were built on those helpers, so impersonating
// `authenticated` to exercise ANY of them failed on a permission error — the check could
// not be run at all, which reads exactly like a check that passed.
//
// The gate on `policies_using_private_schema` is the load-bearing part. It is what keeps
// this an invariant rather than a golden snapshot: a database with no policies reaching
// into `private` is not broken for lacking the grant, and demanding it there would create
// the kind of unfixable red check that turns a daily alarm into background noise.
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
    // Production, measured 2026-08-13: nspacl = postgres=UC | authenticated=U | service_role=U
    private_schema_usage: { anon: false, authenticated: true, service_role: true },
    policies_using_private_schema: 67,
  };
}

const codes = (shape: SchemaShape) => evaluateSchemaShape(shape).map((v) => v.code);
const find = (shape: SchemaShape, code: string) => evaluateSchemaShape(shape).find((v) => v.code === code);

export function runSchemaShapePrivateUsageTests() {
  // ── production's real state raises nothing ────────────────────────────────
  assert.deepEqual(
    codes(healthyShape()),
    [],
    "production's measured private-schema ACL must be the definition of clean, or the check is wrong about the target state",
  );

  // ── staging's real state on 2026-08-12: nspacl NULL, nothing granted ──────
  const stagingOnTheDay: SchemaShape = {
    ...healthyShape(),
    private_schema_usage: { anon: false, authenticated: false, service_role: false },
  };

  const missing = find(stagingOnTheDay, "private_schema_no_usage_for_authenticated");
  assert.ok(missing, "the fault that made 67 policies untestable must be reported");
  assert.equal(missing.severity, "error", "an untestable RLS model is not a warning — it must fail the check");
  assert.ok(
    missing.message.includes("67"),
    "the message must say how many policies are affected, so the blast radius is visible without a catalog query",
  );
  assert.ok(
    missing.message.includes("grant usage on schema private to authenticated"),
    "the message must carry the fix; a check that reports a permission gap without the grant statement gets triaged and forgotten",
  );
  assert.ok(
    /EXECUTE/i.test(missing.message),
    "the message must say per-function EXECUTE does not substitute — that is precisely what made this gap invisible for a month",
  );

  const svc = find(stagingOnTheDay, "private_schema_no_usage_for_service_role");
  assert.ok(svc, "the other half of the missing grant must not be silently dropped — only the authenticated half was noticed originally");
  assert.equal(
    svc.severity,
    "warning",
    "nothing in CI reaches private as service_role, so grading it an error would add a red nobody can act on",
  );

  // ── the invariant, not a snapshot: no dependents, no demand ───────────────
  const noDependents: SchemaShape = {
    ...healthyShape(),
    private_schema_usage: { anon: false, authenticated: false, service_role: true },
    policies_using_private_schema: 0,
  };
  assert.equal(
    find(noDependents, "private_schema_no_usage_for_authenticated"),
    undefined,
    "a database whose policies never reach into private is not broken for lacking the grant; demanding it there would need an allowlist, and allowlists rot",
  );

  // ── the opposite direction is a real widening ─────────────────────────────
  const anonReachesPrivate: SchemaShape = {
    ...healthyShape(),
    private_schema_usage: { anon: true, authenticated: true, service_role: true },
  };
  assert.equal(
    find(anonReachesPrivate, "private_schema_exposed_to_anon")?.severity,
    "error",
    "private holds the helpers that DECIDE access; the public anon key must not be able to reach them",
  );

  // ── targets that cannot answer must stay silent ───────────────────────────
  const olderRpc = healthyShape();
  delete olderRpc.private_schema_usage;
  assert.deepEqual(
    codes(olderRpc),
    [],
    "check:schema-shape runs against production and staging independently; an un-migrated RPC returns no key and must stay silent rather than fail",
  );

  const noPrivateSchema: SchemaShape = { ...healthyShape(), private_schema_usage: null };
  assert.deepEqual(
    codes(noPrivateSchema),
    [],
    "a database with no `private` schema reports null, which is 'not measurable here' — not a violation",
  );

  // ── the fix, verified against staging 2026-08-13 after the repair ─────────
  const stagingAfterRepair: SchemaShape = {
    ...healthyShape(),
    private_schema_usage: { anon: false, authenticated: true, service_role: true },
  };
  assert.deepEqual(
    codes(stagingAfterRepair),
    [],
    "once staging matches production the check must go green, or nobody will keep reading it",
  );
}
