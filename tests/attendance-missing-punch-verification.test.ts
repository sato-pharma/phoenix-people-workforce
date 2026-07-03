import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pendingStepFor } from "../src/lib/attendance/missing-punch-verification.ts";

/**
 * Contract guards for the missing-punch verification chain
 * (src/lib/attendance/missing-punch-verification.ts): a sequential 3-step
 * sign-off (standing verifier -> HR -> CEO), entirely separate from the
 * confirm/dispute settlement flow since missing-punch lines carry zero EGP.
 */
export function runAttendanceMissingPunchVerificationTests() {
  // 1. Pure step-resolution logic: pendingStepFor must map status -> step
  //    exactly, with no step for terminal states.
  assert.equal(pendingStepFor("awaiting_verifier"), "verifier");
  assert.equal(pendingStepFor("awaiting_hr"), "hr");
  assert.equal(pendingStepFor("awaiting_ceo"), "ceo");
  assert.equal(pendingStepFor("awaiting_employee"), null, "no one acts until the employee has submitted a reason");
  assert.equal(pendingStepFor("fully_verified"), null, "a terminal state has no pending step");
  assert.equal(pendingStepFor("rejected"), null, "a terminal state has no pending step");

  const service = readFileSync("src/lib/attendance/missing-punch-verification.ts", "utf8");

  // 2. Self-scope: an employee can only submit a reason for their own line.
  assert.match(
    service,
    /if \(!actor \|\| actor !== normalizeAttendanceHrId\(employeeHrId\)\)/,
    "submitMissingPunchReason must verify the actor owns the digest the line belongs to",
  );

  // 3. Sequential, not parallel: each step transition guards on the exact
  //    prior status in the update WHERE clause — a HR confirm can never fire
  //    while status is still 'awaiting_verifier'.
  assert.match(
    service,
    /\.eq\("status", expectedStatus\)/,
    "decideMissingPunchStep must guard the update on the exact expected prior status",
  );
  assert.match(
    service,
    /if \(!data\) throw conflictError\("This step has already been acted on\."\);/,
    "a 0-row update (step already acted on, or out of sequence) must be a conflict, not a silent success",
  );

  // 4. Each step's authorized-actor list is genuinely distinct — pinning the
  //    resolver so a future edit can't accidentally let e.g. the HR list
  //    approve the verifier step.
  assert.match(
    service,
    /if \(step === "verifier"\) return settings\.missingPunchVerifierHrId \? \[settings\.missingPunchVerifierHrId\] : \[\];/,
    "the verifier step must be gated to exactly the configured standing verifier, not the approver list",
  );
  assert.match(
    service,
    /if \(step === "hr"\) return settings\.approverHrIds;/,
    "the hr step must be gated to the configured approver list",
  );
  assert.match(
    service,
    /return ceoHrIds\(\);/,
    "the ceo step must be gated to real CEO-role accounts",
  );

  // 5. Zero EGP impact: this module must never touch deduction_candidates,
  //    attendance_settlements, or the payroll bridge — it's informational only.
  assert.doesNotMatch(
    service,
    /pushAttendanceSettlementToPayroll|deduction_candidates|attendance_settlements/,
    "missing-punch verification must never touch payroll — it carries zero EGP by design",
  );

  // 6. Routes are registered and self-scoped.
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  for (const pattern of [
    "/api/attendance/digests/:id/missing-punch",
    "/api/attendance/missing-punch",
    "/api/attendance/missing-punch/:id/decide",
  ]) {
    assert.ok(registry.includes(`pattern: "${pattern}"`), `access registry must contain an entry for ${pattern}`);
  }
  const submitRoute = readFileSync("app/api/attendance/digests/[id]/missing-punch/route.ts", "utf8");
  assert.match(submitRoute, /actorHrId: access\.hrId,/, "submit route must use the session's own hrId as actor");
  const decideRoute = readFileSync("app/api/attendance/missing-punch/[id]/decide/route.ts", "utf8");
  assert.match(decideRoute, /actorHrId: access\.hrId,/, "decide route must use the session's own hrId as actor");
  assert.match(decideRoute, /isSuperAdmin: access\.role === "Super Admin",/, "decide route must pass the real session role, not trust a client-supplied flag");
}
