import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Regression guard for the Employee Day-by-Day Report module (deep audit,
 * 2026-07-22). getEmployeeDayByDayReport/listFlexEligibleEmployees are entirely
 * Supabase-backed and cannot be unit-tested without DB infra — matching the
 * established pattern for this domain (see attendance-self-scope.test.ts),
 * these pin the exact source wiring for each fixed issue rather than mocking
 * the client.
 */
export function runAttendanceEmployeeDayReportTests() {
  const page = readFileSync("app/(admin)/attendance/employee-day-report/page.tsx", "utf8");
  const lib = readFileSync("src/lib/attendance/employee-day-report.ts", "utf8");

  // 1. Access control: this report exposes per-employee punch/deduction detail,
  //    so it must be gated to Super Admin only — not just the coarse
  //    attendance:read permission every basic attendance surface uses. A prior
  //    version only checked attendance:read, letting Finance Manager/Financial
  //    Advisor/SFE Manager/CEO browse any employee's detail despite those
  //    roles' own matrix comments disclaiming HR/payroll authority.
  assert.match(
    page,
    /if \(access\.role !== "Super Admin"\) \{\s*redirect\("\/employee-portals"\);/,
    "employee-day-report page must gate to Super Admin only and redirect otherwise, failing closed",
  );

  // 2. Correctness: policy must be resolved PER DAY, not once for the whole
  //    admin-chosen range — an arbitrary range can span a policy change (new
  //    scheduled_start/flex_minutes/required_minutes/brackets, or the employee
  //    only became flex-eligible partway through).
  assert.match(
    lib,
    /function resolvePolicyForDay\(dateIso: string\)/,
    "getEmployeeDayByDayReport must resolve the attendance policy per day",
  );
  assert.match(
    lib,
    /resolveActiveAttendancePolicy\(\s*\{ hr_id: employee!\.hr_id, job_title: employee!\.job_title \},\s*flexPolicies,\s*dateIso,\s*dateIso,\s*\)/,
    "the per-day policy resolver must query with dateIso/dateIso, not the full range",
  );
  assert.doesNotMatch(
    lib,
    /resolveActiveAttendancePolicy\(\s*\{ hr_id: employee\.hr_id, job_title: employee\.job_title \},\s*flexPolicies,\s*input\.dateFromIso,\s*input\.dateToIso,\s*\)/,
    "must not resolve a single policy across the whole requested range",
  );

  // 3. The employee dropdown must be scope-able to the admin's chosen historical
  //    range, not hardcoded to today — otherwise an employee who resigned, or
  //    moved off the flexible-hours model, since the period being reviewed is
  //    never selectable, defeating the report's own historical-review purpose.
  assert.match(
    lib,
    /export async function listFlexEligibleEmployees\(range\?: \{ dateFromIso: string; dateToIso: string \}\)/,
    "listFlexEligibleEmployees must accept an optional historical range",
  );
  assert.match(
    page,
    /listFlexEligibleEmployees\(\s*filters\?\.dateFrom && filters\?\.dateTo \? \{ dateFromIso: filters\.dateFrom, dateToIso: filters\.dateTo \} : undefined,\s*\)/,
    "the page must pass the admin's chosen range through to listFlexEligibleEmployees once picked",
  );

  // 4. Track C cutover (C5). The day report's deduction confirmations must read and
  //    write the UNIFIED deductions module (deductions_candidates/deductions_decisions,
  //    category "fingerprint") that live Automated Payroll reads — NOT the legacy
  //    deductions-governance tables, which only the now-retired Payroll Copilot ever
  //    read. Before this repoint a confirmation here reached no live payroll at all, so
  //    a regression back to the singular tables would silently disconnect it again.
  assert.doesNotMatch(
    lib,
    /from\("deduction_candidates"\)|from\("deduction_decisions"\)/,
    "the day report must not read or write the legacy singular deduction_candidates/deduction_decisions tables",
  );
  assert.doesNotMatch(
    lib,
    /deductions-governance\/(?:service|candidate-key|types)/,
    "the day report must not import from the legacy deductions-governance service/keys/types",
  );
  assert.match(
    lib,
    /from\("deductions_candidates"\)/,
    "the day report must write the unified deductions_candidates table",
  );
  assert.match(
    lib,
    /recordDecision\(\{[\s\S]*?actor: input\.actor,/,
    "confirmations must go through the unified recordDecision, passing the Super Admin actor",
  );

  // 5. Dedup contract. A candidate this report creates must be keyed BYTE-IDENTICALLY to
  //    the monthly fingerprint connector (connectors/fingerprint.ts) — same sourceSystem
  //    and the `${hrId}:${dateIso}` sourceRecordId — so the collector and an on-demand
  //    confirmation converge on ONE candidate rather than double-charging the same day.
  assert.match(
    lib,
    /sourceSystem: "fingerprint_report"/,
    "created candidates must use the connector's sourceSystem so candidate_keys match",
  );
  assert.match(
    lib,
    /sourceRecordId: `\$\{hrId\}:\$\{input\.dateIso\}`/,
    "created candidates must use the connector's `${hrId}:${dateIso}` sourceRecordId so candidate_keys match",
  );

  // 6. HR-id matching must use the ALIAS-AWARE compactDeductionsHrId — the same derivation
  //    the unified table stores in employee_hr_id_compact. Matching on the non-alias-aware
  //    compactHrKey silently drops an aliased HR_ID (e.g. AAA→AA) from every reader.
  assert.doesNotMatch(
    lib,
    /compactHrKey\(/,
    "the day report must not match deduction candidates on the non-alias-aware compactHrKey",
  );
  assert.match(
    lib,
    /compactDeductionsHrId\(/,
    "the day report must match deduction candidates on the alias-aware compactDeductionsHrId",
  );
}
