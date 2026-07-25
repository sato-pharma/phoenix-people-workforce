import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeAttendanceHrId } from "../src/lib/attendance/metrics.ts";
import { canViewEmployeeAttendanceReport, resolveAttendanceScopeHrIds } from "../src/lib/attendance/employee-attendance.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

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
export async function runAttendanceSelfScopeTests() {
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
  const exceptionReviewRoute = readFileSync("app/api/attendance/exceptions/[id]/route.ts", "utf8");
  assert.match(
    exceptionReviewRoute,
    /assertSystemAdministratorWorkspaceAccess\(access,\s*"attendance exception administration"\)/,
    "exception review/delete must be system-administrator-only",
  );

  // 6. Finding #15 regression guard: approvals-hub/employee-context must not let a
  //    caller-supplied hrId bypass ownership — it must scope via
  //    assertCanViewEmployeeAttendance and surface denial as 403, not a raw 500.
  const employeeContextRoute = readFileSync("app/api/approvals-hub/employee-context/route.ts", "utf8");
  assert.match(
    employeeContextRoute,
    /assertCanViewEmployeeAttendance\(access,\s*hrId\)/,
    "employee-context route must scope hrId via assertCanViewEmployeeAttendance",
  );
  assert.match(
    employeeContextRoute,
    /isForbiddenError\(error\)/,
    "employee-context route must map Forbidden errors to 403",
  );

  // 7. Findings #19/#20 regression guard: both attendance export routes must resolve
  //    the caller's viewable hrId scope and pass it into the report/summary builders,
  //    so a non-privileged caller can no longer get an unscoped, full-company export.
  const fingerprintExportRoute = readFileSync("app/api/attendance/fingerprint-report/export/route.ts", "utf8");
  assert.match(
    fingerprintExportRoute,
    /resolveAttendanceScopeHrIds\(access\)/,
    "fingerprint report export route must resolve the caller's attendance scope",
  );
  assert.match(
    fingerprintExportRoute,
    /getFingerprintAttendanceReport\(\{[^}]*employeeHrIds:\s*scopeHrIds/,
    "fingerprint report export route must pass employeeHrIds scope into getFingerprintAttendanceReport",
  );

  const monthlySummaryExportRoute = readFileSync("app/api/attendance/monthly-summary/export/route.ts", "utf8");
  assert.match(
    monthlySummaryExportRoute,
    /resolveAttendanceScopeHrIds\(access\)/,
    "monthly summary export route must resolve the caller's attendance scope",
  );
  assert.match(
    monthlySummaryExportRoute,
    /getMonthlyAttendanceSummary\(\{[^}]*employeeHrIds:\s*scopeHrIds/,
    "monthly summary export route must pass employeeHrIds scope into getMonthlyAttendanceSummary",
  );

  // 8. Head Office audit regression guard (2026-07-25): SFE Manager and Training Manager
  //    hold real attendance permissions (SFE Manager: full CRUD; Training Manager: read)
  //    but have no traditional direct-report chain, unlike a District/Regional Manager —
  //    scopeForRole never special-cases them, so without this carve-out they'd collapse
  //    to "direct reports only" and see almost no one. Both early-return before any DB
  //    read, so this is safe to call directly without mocking Supabase.
  const sfeManagerContext: AccessContext = { hrId: "A-1", loginId: "A-1", role: "SFE Manager", scope: "self", source: "session" };
  const trainingManagerContext: AccessContext = { hrId: "A-2", loginId: "A-2", role: "Training Manager", scope: "self", source: "session" };
  const districtManagerContext: AccessContext = { hrId: "DM-1", loginId: "DM-1", role: "District Manager", scope: "self", source: "session" };
  const unrelatedTarget = { hrId: "MR-999", managerHrId: "OTHER-MANAGER" };

  assert.equal(
    canViewEmployeeAttendanceReport(sfeManagerContext, unrelatedTarget),
    true,
    "SFE Manager sees the attendance report of an employee who is not her direct report",
  );
  assert.equal(
    canViewEmployeeAttendanceReport(trainingManagerContext, unrelatedTarget),
    true,
    "Training Manager sees the attendance report of an employee who is not her direct report",
  );
  assert.equal(
    canViewEmployeeAttendanceReport(districtManagerContext, unrelatedTarget),
    false,
    "regression guard: an ordinary District Manager still cannot see a non-report's attendance",
  );
  assert.equal(
    await resolveAttendanceScopeHrIds(sfeManagerContext),
    null,
    "SFE Manager's bulk attendance scope is company-wide (null = no restriction)",
  );
  assert.equal(
    await resolveAttendanceScopeHrIds(trainingManagerContext),
    null,
    "Training Manager's bulk attendance scope is company-wide (null = no restriction)",
  );
}
