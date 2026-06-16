import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeAttendanceHrId } from "../src/lib/attendance/metrics.ts";

/**
 * Regression guard for the attendance self-service data-leak (audit C1) and the
 * exception self-scope / self-approve gaps.
 *
 * C1: the employee portal report filtered HR_ID with a SUBSTRING match, so an
 * employee whose ID prefixes another's (e.g. "B-1" → "B-10", "B-100") received
 * the colleagues' punch rows in their own "My Attendance" view and Excel export.
 * The fix routes the self-service consumers through `exactEmployeeHrId` (exact,
 * normalized equality) instead of the substring `employeeHrId` filter.
 *
 * These are deliberately source-contract guards: the report functions hit
 * Supabase and cannot be unit-tested without DB infra, so we pin the exact
 * call wiring that enforces the security boundary.
 */
export function runAttendanceSelfScopeTests() {
  // 1. The substring collision the bug exploited — exact normalized equality must
  //    treat "B-1" and "B-10" as different identities.
  assert.notEqual(
    normalizeAttendanceHrId("B-1"),
    normalizeAttendanceHrId("B-10"),
    "exact HR_ID comparison must not collapse B-1 and B-10",
  );
  assert.equal(normalizeAttendanceHrId("b-1"), normalizeAttendanceHrId("B-1"), "normalization is case-insensitive");

  // 2. Self-service consumers must request the report by exact HR_ID, never the
  //    substring filter.
  const employeeAttendance = readFileSync("src/lib/attendance/employee-attendance.ts", "utf8");
  assert.match(
    employeeAttendance,
    /getFingerprintAttendanceReport\(\{[^}]*exactEmployeeHrId:/,
    "getEmployeeAttendanceData must scope the report with exactEmployeeHrId",
  );
  assert.doesNotMatch(
    employeeAttendance,
    /getFingerprintAttendanceReport\(\{[^}]*\bemployeeHrId:/,
    "getEmployeeAttendanceData must NOT use the substring employeeHrId filter",
  );

  const exportRoute = readFileSync("app/api/attendance/employee-fingerprint-export/route.ts", "utf8");
  assert.match(
    exportRoute,
    /getFingerprintAttendanceReport\(\{[^}]*exactEmployeeHrId:/,
    "the employee fingerprint export must scope the report with exactEmployeeHrId",
  );
  assert.doesNotMatch(
    exportRoute,
    /getFingerprintAttendanceReport\(\{[^}]*\bemployeeHrId:/,
    "the employee fingerprint export must NOT use the substring employeeHrId filter",
  );

  // 3. The report engine's row + policy-detail filters must apply exact-match
  //    scoping (so the export's Policy Details sheet can't leak either).
  const report = readFileSync("src/lib/attendance/fingerprint-report.ts", "utf8");
  assert.match(report, /exactEmployeeHrId/, "report engine must support exactEmployeeHrId");
  assert.match(
    report,
    /filters\.exactEmployeeHrId && normalizeHrId\(row\.employeeHrId\) !== filters\.exactEmployeeHrId/,
    "report engine must reject rows whose normalized HR_ID is not an exact match",
  );

  // 4. Creating an exception always starts pending (no self-approve), and the
  //    route enforces self-scope for non-privileged callers.
  const exceptionsRoute = readFileSync("app/api/attendance/exceptions/route.ts", "utf8");
  assert.match(exceptionsRoute, /status:\s*"pending"/, "exception create must force status pending");
  assert.match(exceptionsRoute, /isPrivilegedScope/, "exception route must gate cross-employee access by scope");
  assert.doesNotMatch(
    exceptionsRoute,
    /status:\s*\(status ===/,
    "exception create must NOT accept a client-supplied status",
  );

  // 5. Deduction generation must enforce company/system scope and record the actor.
  const generateRoute = readFileSync("app/api/attendance/generate-deduction-candidates/route.ts", "utf8");
  assert.match(
    generateRoute,
    /access\.scope !== "company" && access\.scope !== "system"/,
    "deduction generation must require company/system scope",
  );
  assert.match(generateRoute, /actor:\s*access\.hrId/, "deduction generation must record the real actor");
}
