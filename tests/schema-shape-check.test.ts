import assert from "node:assert/strict";

import { evaluateSchemaShape, type SchemaShape } from "../scripts/check-schema-shape.ts";

// Regression guard for the schema-drift monitor added 2026-07-31.
//
// The monitor exists because two real staging faults were invisible to every check in
// the repo. So the bar for this test is not "the function runs" -- it is that the
// function, fed the ACTUAL numbers observed during each fault, reports an error. Every
// fixture below is measured, not invented.
//
// Fault 1 (2026-07-30): every grant in staging's public schema removed out of band.
// Fault 2 (2026-07-11): staging restored with only the PRE-data section of a dump --
//   perfect migration history, but 0 RLS policies, RLS off on all 284 tables, 0 foreign
//   keys, 105/282 primary keys, 138/1096 indexes.

const HEALTHY: SchemaShape = {
  // Production, measured 2026-08-05 via phx_ci_schema_shape() — after
  // 20260805195425 dropped four spent snapshots and 20260805204502 moved the last four
  // out of `public` into dated backup schemas (284 -> 294 tables across the week; the
  // net is up because real tables were added meanwhile). Real numbers, not invented
  // ones: if this fixture drifts from production the test stops meaning anything.
  tables_total: 294,
  tables_rls_enabled: 294,
  tables_force_rls: 26,
  policies_total: 378,
  primary_keys_total: 294,
  unique_total: 103,
  foreign_keys_total: 292,
  check_total: 535,
  indexes_total: 1148,
  triggers_total: 39,
  schema_usage: { anon: true, authenticated: true, service_role: true },
  tables_exposed_without_rls: [],
  tables_rls_disabled: [],
  // Empty, and now genuinely so: every one of the 294 tables in `public` has a primary
  // key. The two geo brick-centroid snapshots that used to sit here were the last
  // holdouts, and they were not given primary keys — they were moved out of `public`
  // altogether by 20260805204502, which is why NO_PRIMARY_KEY_ALLOWED in
  // check-schema-shape.ts is now empty too. A name reappearing in either place means a
  // snapshot was created in `public` again.
  tables_without_primary_key: [],
  // Production actually has 61 of these; deliberately empty here so the "healthy schema
  // raises nothing" assertion below stays meaningful. The deny-all warning has its own
  // dedicated case at the bottom of this file.
  tables_rls_enabled_without_policy: [],
};

function codes(shape: SchemaShape, severity: "error" | "warning") {
  return evaluateSchemaShape(shape)
    .filter((v) => v.severity === severity)
    .map((v) => v.code)
    .sort();
}

export function runSchemaShapeCheckTests() {
  // ---------------------------------------------------------------------------
  // A healthy database must be silent, or the check gets muted and stops working.
  // ---------------------------------------------------------------------------
  assert.deepEqual(codes(HEALTHY, "error"), [], "a healthy production-shaped schema must raise no errors");

  // Nothing is allowlisted any more and nothing needs to be: the ad-hoc snapshots that
  // used to require an exemption now live outside `public`, where this check does not
  // look. A healthy schema is silent on its own merits rather than by exemption.
  assert.deepEqual(codes(HEALTHY, "warning"), [], "a healthy production-shaped schema must raise no warnings either");

  // ---------------------------------------------------------------------------
  // Fault 2, as it actually stood 2026-07-11 .. 2026-07-30: grants present, RLS off.
  // This is the dangerous window -- the public anon key could read everything.
  // ---------------------------------------------------------------------------
  const faultTwoExposed: SchemaShape = {
    ...HEALTHY,
    tables_total: 284,
    tables_rls_enabled: 0,
    tables_force_rls: 0,
    policies_total: 0,
    primary_keys_total: 105,
    unique_total: 33,
    foreign_keys_total: 0,
    indexes_total: 138,
    triggers_total: 0,
    schema_usage: { anon: true, authenticated: true, service_role: true },
    tables_exposed_without_rls: ["employees", "salary_records", "app_auth_users"],
    tables_rls_disabled: ["employees", "salary_records", "app_auth_users"],
    tables_without_primary_key: ["employees", "salary_records"],
    tables_rls_enabled_without_policy: [],
  };
  const exposedErrors = codes(faultTwoExposed, "error");
  assert.ok(
    exposedErrors.includes("exposed_without_rls"),
    "a table reachable by anon/authenticated with RLS disabled must be an ERROR — this is the whole point",
  );
  assert.ok(exposedErrors.includes("no_rls_policies"), "zero RLS policies must be an error");
  assert.ok(exposedErrors.includes("no_foreign_keys"), "zero foreign keys must be an error");
  assert.ok(
    exposedErrors.includes("missing_primary_key"),
    "non-allowlisted tables without a primary key must be an error",
  );

  // ---------------------------------------------------------------------------
  // Fault 2 as it stood 2026-07-30 .. 07-31, AFTER the grants were wiped: nothing is
  // reachable any more, so the exposure check goes quiet. The structural floors are
  // what must still catch it -- otherwise the monitor would have called this healthy.
  // ---------------------------------------------------------------------------
  const faultTwoAfterWipe: SchemaShape = {
    ...faultTwoExposed,
    schema_usage: { anon: false, authenticated: false, service_role: false },
    tables_exposed_without_rls: [],
  };
  const afterWipeErrors = codes(faultTwoAfterWipe, "error");
  assert.ok(
    !afterWipeErrors.includes("exposed_without_rls"),
    "with no grants there is no exposure — the exposure check correctly goes quiet here",
  );
  assert.ok(
    afterWipeErrors.includes("no_rls_policies") && afterWipeErrors.includes("no_foreign_keys"),
    "the structural floors must still catch a skeleton schema once the exposure signal is gone",
  );

  // ---------------------------------------------------------------------------
  // Fault 1: service_role loses USAGE on public. Everything server-side stops working.
  // ---------------------------------------------------------------------------
  const faultOne: SchemaShape = {
    ...HEALTHY,
    schema_usage: { anon: false, authenticated: false, service_role: false },
  };
  assert.ok(
    codes(faultOne, "error").includes("service_role_no_schema_usage"),
    "service_role losing schema USAGE must be an error — that was the 2026-07-30 outage",
  );

  // ---------------------------------------------------------------------------
  // A real domain table without a primary key is an error; an allowlisted backup is not.
  // ---------------------------------------------------------------------------
  const missingPk: SchemaShape = { ...HEALTHY, tables_without_primary_key: [...HEALTHY.tables_without_primary_key, "employees"] };
  assert.ok(
    codes(missingPk, "error").includes("missing_primary_key"),
    "a non-allowlisted table without a primary key must be an error",
  );

  // ---------------------------------------------------------------------------
  // RLS enabled with no policy is fail-closed (deny-all) — safe, so warn, never fail.
  // Both projects legitimately have 61 of these; making it an error would mute the check.
  // ---------------------------------------------------------------------------
  const denyAll: SchemaShape = { ...HEALTHY, tables_rls_enabled_without_policy: ["audit_logs", "system_audit_logs"] };
  assert.deepEqual(codes(denyAll, "error"), [], "deny-all tables must not fail the check");
  assert.ok(
    codes(denyAll, "warning").includes("rls_enabled_without_policy"),
    "deny-all tables should still be surfaced as a warning",
  );
}
