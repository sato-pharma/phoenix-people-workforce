import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { addMonths } from "../src/lib/probation/provisioning.ts";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

export function runProbationProvisioningTests() {
  // addMonths: basic add, month-end clamp, leap year, year rollover, passthrough.
  assert.equal(addMonths("2026-01-15", 3), "2026-04-15");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28", "clamp to non-leap February");
  assert.equal(addMonths("2024-01-31", 1), "2024-02-29", "leap February");
  assert.equal(addMonths("2026-11-30", 3), "2027-02-28", "year rollover + clamp");
  assert.equal(addMonths("2026-06-05", 0), "2026-06-05");
  assert.equal(addMonths("not-a-date", 3), "not-a-date", "passthrough on bad input");

  // Hire conversion auto-creates probation, non-blocking, without touching the RPC.
  const applications = source("src/lib/recruitment/applications.ts");
  assert.match(applications, /createInitialProbationRecord\(/, "approveAndConvert must auto-create probation");
  assert.match(applications, /catch \(probationError\)/, "probation create must be non-blocking (try/catch)");

  // Provisioning module: idempotent insert into employee_probation + mirror to employees.
  const provisioning = source("src/lib/probation/provisioning.ts");
  assert.match(provisioning, /from\("employee_probation"\)/, "must write employee_probation");
  assert.match(provisioning, /status: "active"/, "probation starts active");
  assert.match(provisioning, /\.eq\("employee_hr_id"[\s\S]*?\.limit\(1\)/, "idempotent existence check");
  assert.match(provisioning, /from\("employees"\)[\s\S]*?probation_end_date/, "mirror employees.probation_end_date");

  // The tested hire RPC must NOT be modified to create probation (app-layer only).
  const rpc = source("supabase/migrations/20260531235753_offer_lifecycle_10_10_hardening.sql");
  assert.doesNotMatch(rpc, /employee_probation/i, "hire RPC must not create probation");
}
