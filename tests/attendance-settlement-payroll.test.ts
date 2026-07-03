import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract guards for the attendance-settlement -> payroll-governance bridge
 * (src/lib/attendance/settlement-payroll.ts + the new
 * recordSystemApprovedAttendanceDecision in deductions-governance/service.ts).
 * Entirely Supabase-backed, so — matching the rest of this module's tests —
 * these pin the safety contract via source inspection.
 */
export function runAttendanceSettlementPayrollTests() {
  const bridge = readFileSync("src/lib/attendance/settlement-payroll.ts", "utf8");
  const settlementService = readFileSync("src/lib/attendance/settlement-service.ts", "utf8");
  const governanceService = readFileSync("src/lib/deductions-governance/service.ts", "utf8");

  // 1. Only real settlement outcomes push to payroll — never dispute_upheld
  //    (which always carries deduction_days === 0 by construction).
  assert.match(
    settlementService,
    /if \(input\.action === "confirmed" \|\| input\.action === "auto_confirmed" \|\| input\.action === "dispute_rejected"\)/,
    "insertSettlement must gate the payroll push to the three real-deduction outcomes",
  );
  assert.doesNotMatch(
    settlementService,
    /dispute_upheld[\s\S]{0,80}pushAttendanceSettlementToPayroll/,
    "dispute_upheld must never reach the payroll bridge",
  );

  // 2. The bridge itself is a hard no-op on zero deduction days (belt-and-
  //    suspenders with #1) and respects the dry-run setting (the approved
  //    "dry-run first cycle" enhancement).
  assert.match(
    bridge,
    /if \(input\.deductionDays <= 0\) return \{ candidateId: null, skippedDryRun: false \};/,
    "the payroll bridge must no-op on zero deduction days",
  );
  assert.match(
    bridge,
    /if \(settings\.dryRun\)/,
    "the payroll bridge must check attendance_digest_settings.dry_run before creating a real candidate",
  );

  // 3. Candidate creation reuses the shared, VALIDATED insert path — this is
  //    the actual fix for audit finding #1 (the old direct generator bypassed
  //    validateCandidateDraft entirely; this bridge does not repeat that).
  assert.match(
    bridge,
    /insertDeductionCandidateDrafts\(/,
    "must create candidates through the shared validated insert path, not a raw direct write",
  );

  // 4. No collision with the older ATTENDANCE_DEVICE governance connector's key
  //    namespace (fingerprint:{date}:{hrId}:{status}) — and no overlap in WHO
  //    each path covers: the connector is field-titles-only (Medical Rep/DM/RM),
  //    this bridge is head-office + NSM/GPM/PM, which are explicitly excluded
  //    from the field-title set (src/lib/attendance/eligibility.ts). Both
  //    guards matter — key-distinctness alone wouldn't save an actual same-day
  //    double deduction for an overlapping employee, so the disjoint-population
  //    property is pinned too.
  assert.match(bridge, /`digest-line-\$\{input\.digestLineId\}`/, "sourceRecordId must use a distinct namespace from the legacy connector");
  const eligibility = readFileSync("src/lib/attendance/eligibility.ts", "utf8");
  assert.doesNotMatch(
    eligibility,
    /"national sales manager"|"group product manager"|"product manager"/i,
    "NSM/GPM/PM must stay OUT of the field-title set — otherwise the legacy connector and this settlement flow could double-deduct the same employee/day",
  );

  // 5. The system-decision path is real but structurally bounded: it bypasses
  //    the human-actor gate (by design — see its own doc comment) but is not
  //    reachable from any API route, and only accepts a closed reason enum
  //    (no free-text bypass of the audit trail).
  assert.match(
    governanceService,
    /export async function recordSystemApprovedAttendanceDecision/,
    "the system-decision function must exist and be exported for the attendance module to call",
  );
  assert.doesNotMatch(
    governanceService.slice(
      governanceService.indexOf("export async function recordSystemApprovedAttendanceDecision"),
      governanceService.indexOf("export async function recordSystemApprovedAttendanceDecision") + 2000,
    ),
    /assertDeductionsGovernanceDecisionActor/,
    "recordSystemApprovedAttendanceDecision must NOT call the human-actor gate (no user session exists for a cron/self-confirm)",
  );
  assert.match(
    governanceService,
    /systemDecisionReasons\.includes\(input\.decisionReason\)/,
    "the system decision reason must be validated against a closed enum, not accepted as free text",
  );
  assert.match(
    governanceService,
    /actor_role_at_decision: systemActor/,
    "every system decision must be unmistakably stamped as system-originated in the audit trail",
  );
}
