import assert from "node:assert/strict";

import { canViewEmployeeAttendanceReport } from "../src/lib/attendance/employee-attendance.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

/**
 * Security boundary for the Fingerprint Analytics manager view:
 *   - self always;
 *   - whole-company viewers (CEO / Super Admin / company|system scope) see anyone;
 *   - any other manager sees their DIRECT reports only.
 * Matching is exact + normalized — never substring (B-1 must not leak B-10/B-100).
 */
function ctx(overrides: Partial<AccessContext>): AccessContext {
  return {
    hrId: "A-8",
    role: "Group Product Manager",
    scope: "line",
    source: "session",
    ...overrides,
  };
}

export function runAttendanceManagerViewAccessTests() {
  const gpm = ctx({ hrId: "A-8", role: "Group Product Manager", scope: "line" });

  // Self — always.
  assert.equal(canViewEmployeeAttendanceReport(gpm, { hrId: "A-8", managerHrId: "A-9" }), true);

  // Direct report (B-155 reports to A-8) — allowed.
  assert.equal(canViewEmployeeAttendanceReport(gpm, { hrId: "B-155", managerHrId: "A-8" }), true);

  // Casing-insensitive: caller "a-8" still sees their direct report.
  assert.equal(
    canViewEmployeeAttendanceReport(ctx({ hrId: "a-8", scope: "line" }), { hrId: "B-155", managerHrId: "A-8" }),
    true,
  );

  // Not a direct report (reports to someone else) — denied.
  assert.equal(canViewEmployeeAttendanceReport(gpm, { hrId: "B-122", managerHrId: "A-12" }), false);

  // Substring trap: caller "B-1" must NOT see "B-10", nor anyone whose manager is "B-10"/"B-100".
  const b1 = ctx({ hrId: "B-1", scope: "line" });
  assert.equal(canViewEmployeeAttendanceReport(b1, { hrId: "B-10", managerHrId: "B-100" }), false);
  assert.equal(canViewEmployeeAttendanceReport(b1, { hrId: "X-1", managerHrId: "B-10" }), false);
  // But a genuine direct report of B-1 is allowed.
  assert.equal(canViewEmployeeAttendanceReport(b1, { hrId: "B-200", managerHrId: "B-1" }), true);

  // CEO — whole company (different person, no manager match needed).
  assert.equal(
    canViewEmployeeAttendanceReport(ctx({ hrId: "C-1", role: "CEO", scope: "company" }), { hrId: "B-155", managerHrId: "A-8" }),
    true,
  );

  // Super Admin / system scope — whole company.
  assert.equal(
    canViewEmployeeAttendanceReport(ctx({ hrId: "S-1", role: "Super Admin", scope: "system" }), { hrId: "B-155", managerHrId: "A-8" }),
    true,
  );

  // Finance Manager has company scope — whole company.
  assert.equal(
    canViewEmployeeAttendanceReport(ctx({ hrId: "F-1", role: "Finance Manager", scope: "company" }), { hrId: "B-155", managerHrId: "A-8" }),
    true,
  );

  // Guest / no-scope — denied even for self.
  assert.equal(canViewEmployeeAttendanceReport(ctx({ source: "guest" }), { hrId: "A-8", managerHrId: null }), false);
  assert.equal(canViewEmployeeAttendanceReport(ctx({ scope: "none" }), { hrId: "A-8", managerHrId: null }), false);

  // Missing identity — denied.
  assert.equal(canViewEmployeeAttendanceReport(ctx({ hrId: null }), { hrId: "B-155", managerHrId: "A-8" }), false);
}
