import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { probationEndDate } from "../src/lib/probation/date.ts";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

export function runProbationProvisioningTests() {
  // Provisioning now derives the end date via the canonical hire+90 helper (the prior
  // `addMonths(..., 3)` calendar-month path was removed to unify the date formula).
  assert.equal(probationEndDate("2026-01-15"), "2026-04-15");
  const provisioningSrc = source("src/lib/probation/provisioning.ts");
  assert.match(provisioningSrc, /probationEndDate\(/, "provisioning must use the canonical hire+90 helper");
  assert.doesNotMatch(provisioningSrc, /addMonths/, "the legacy +3-month addMonths path must be gone");

  // Hire conversion auto-creates probation, non-blocking, without touching the RPC.
  const applications = source("src/lib/recruitment/applications.ts");
  assert.match(applications, /createInitialProbationRecord\(/, "markApplicationHired must auto-create probation");
  assert.match(applications, /catch \(probationError\)/, "probation create must be non-blocking (try/catch)");

  // Provisioning module: idempotent insert into employee_probation + mirror to employees.
  const provisioning = source("src/lib/probation/provisioning.ts");
  assert.match(provisioning, /from\("employee_probation"\)/, "must write employee_probation");
  assert.match(provisioning, /status: "active"/, "probation starts active");
  assert.match(provisioning, /\.eq\("employee_hr_id"[\s\S]*?\.limit\(1\)/, "idempotent existence check");
  assert.match(provisioning, /from\("employees"\)[\s\S]*?probation_end_date/, "mirror employees.probation_end_date");

  // App-layer wiring of the new central Probation Case (defense-in-depth alongside the DB
  // hire trigger): the shared hire hook provisions the Case too, non-blocking + monitored.
  assert.match(provisioning, /ensureProbationCase/, "hire hook must provision the central Probation Case");
  assert.match(provisioning, /probation_provisioning_failures/, "case failures recorded, not swallowed");
  assert.match(
    provisioning,
    /never throws|NEVER throws|must not block a hire/i,
    "app-layer case provisioning must be documented non-blocking",
  );

  // The tested hire RPC must NOT be modified to create probation (app-layer only).
  const rpc = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260531235753_offer_lifecycle_10_10_hardening.sql");
  assert.doesNotMatch(rpc, /employee_probation/i, "hire RPC must not create probation");
}
