import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAccess,
  canSeeEmployee,
  createAccessContext,
  designatedHrManagerHrId,
  designatedHrSpecialistHrId,
  getExpensesScope,
  getPayrollScope,
  getSalesScope,
} from "../src/lib/auth/permissions.ts";

export async function runPhase22RoleMatrixSecurityTests() {
  const phase22Smoke = readFileSync("scripts/phase22-role-matrix-security-smoke.ts", "utf8");
  const permissionsSource = readFileSync("src/lib/auth/permissions.ts", "utf8");

  assert.match(phase22Smoke, /Super Admin/);
  assert.match(phase22Smoke, /HR Specialist/);
  assert.match(phase22Smoke, /Finance Manager/);
  assert.match(phase22Smoke, /CEO/);
  assert.match(phase22Smoke, /District Manager/);
  assert.match(phase22Smoke, /Medical Rep/);
  assert.match(phase22Smoke, /Employee/);
  assert.match(phase22Smoke, /Employee cannot see accidental direct report/);
  assert.match(phase22Smoke, /Medical Rep cannot see accidental direct report/);
  assert.match(phase22Smoke, /Admin payroll page redirects non-company payroll scopes to payslips/);
  assert.match(phase22Smoke, /Employee portal payroll fetch is current-HR-ID only/);
  assert.match(phase22Smoke, /Payroll upload mutation requires payroll import/);
  assert.match(phase22Smoke, /Sales upload mutation requires sales import/);
  assert.match(phase22Smoke, /Users bulk mutation requires user admin update/);
  assert.match(phase22Smoke, /role-sensitive business tables keep RLS enabled/);
  assert.doesNotMatch(phase22Smoke, /\.insert\(/);
  assert.doesNotMatch(phase22Smoke, /\.update\(/);
  assert.doesNotMatch(phase22Smoke, /\.delete\(/);

  assert.match(permissionsSource, /function canSeeDirectReportsByRole/);
  assert.match(permissionsSource, /return canSeeDirectReportsByRole\(context\.role\) && isDirectReport/);

  const employee = createAccessContext({ hrId: "E-1", role: "Employee" });
  const medicalRep = createAccessContext({ hrId: "MR-1", role: "Medical Rep" });
  const districtManager = createAccessContext({ hrId: "DSM-1", role: "District Manager" });

  assert.equal(canSeeEmployee(employee, { hrId: "E-1", managerHrId: "DSM-1" }), true);
  assert.equal(canSeeEmployee(employee, { hrId: "E-2", managerHrId: "E-1" }), false);
  assert.equal(canSeeEmployee(medicalRep, { hrId: "MR-2", managerHrId: "MR-1" }), false);
  assert.equal(canSeeEmployee(districtManager, { hrId: "MR-2", managerHrId: "DSM-1" }), true);

  assert.equal(getPayrollScope(employee), "SELF");
  assert.equal(getPayrollScope(districtManager), "SELF");
  assert.equal(getPayrollScope(createAccessContext({ role: "Finance Manager" })), "COMPANY");
  assert.equal(getSalesScope(employee), "SELF");
  assert.equal(getSalesScope(districtManager), "TEAM");
  assert.equal(getExpensesScope(employee), "SELF");
  assert.equal(getExpensesScope(districtManager), "TEAM");

  // --- Designated HR Specialist and Manager tests (only when env vars are configured) ---
  if (designatedHrSpecialistHrId.length > 0) {
    const hrSpecialist = createAccessContext({ hrId: designatedHrSpecialistHrId, loginId: designatedHrSpecialistHrId, role: "HR Specialist" });
    assert.equal(hrSpecialist.role, "HR Specialist");
    assert.equal(hrSpecialist.scope, "company");
    assert.equal(await canAccess(hrSpecialist, "leave", "read"), true);
    assert.equal(await canAccess(hrSpecialist, "leave", "approve"), false);
  }

  if (designatedHrManagerHrId.length > 0) {
    const hrManager = createAccessContext({ hrId: designatedHrManagerHrId, loginId: designatedHrManagerHrId, role: "HR Specialist" });
    assert.equal(hrManager.role, "Super Admin");
    assert.equal(await canAccess(hrManager, "leave", "approve"), true);
    assert.equal(await canAccess(hrManager, "permission_admin", "update"), true);
  }
}
