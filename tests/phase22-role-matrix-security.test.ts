import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAccess,
  canSeeEmployee,
  createAccessContext,
  getExpensesScope,
  getPayrollScope,
  getSalesScope,
  phoenixRoles,
  resolveNavigationMode,
} from "../src/lib/auth/permissions.ts";

export async function runPhase22RoleMatrixSecurityTests() {
  const phase22Smoke = readFileSync("scripts/phase22-role-matrix-security-smoke.ts", "utf8");
  const permissionsSource = readFileSync("src/lib/auth/permissions.ts", "utf8");

  assert.match(phase22Smoke, /Super Admin/);
  assert.match(phase22Smoke, /Talent Acquisition/);
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
  const talentAcquisition = createAccessContext({ hrId: "A-16", role: "Talent Acquisition" });

  assert.equal(canSeeEmployee(employee, { hrId: "E-1", managerHrId: "DSM-1" }), true);
  assert.equal(canSeeEmployee(employee, { hrId: "E-2", managerHrId: "E-1" }), false);
  assert.equal(canSeeEmployee(medicalRep, { hrId: "MR-2", managerHrId: "MR-1" }), false);
  assert.equal(canSeeEmployee(districtManager, { hrId: "MR-2", managerHrId: "DSM-1" }), true);
  assert.equal(talentAcquisition.scope, "self");
  assert.equal(resolveNavigationMode(talentAcquisition), "admin");
  assert.equal(await canAccess(talentAcquisition, "employee_profile", "read"), true);
  assert.equal(await canAccess(talentAcquisition, "employee_profile", "update"), true);
  assert.equal(await canAccess(talentAcquisition, "recruitment", "create"), true);
  assert.equal(await canAccess(talentAcquisition, "candidates", "read"), true);
  assert.equal(await canAccess(talentAcquisition, "employees", "read"), false);
  assert.equal(await canAccess(talentAcquisition, "admin", "read"), false);
  assert.equal(await canAccess(talentAcquisition, "user_admin", "read"), false);

  // EVERY role must be able to manage its OWN notification/Telegram settings. Both
  // profile pages (admin shell and employee portal) render the notification panel for
  // any signed-in user, and the self-service endpoints (PATCH /api/notifications/settings,
  // /api/integrations/telegram/*) gate on employee_profile:update. CEO was missing it,
  // so "Connect Telegram" returned 403 surfaced as the misleading "Unable to create
  // Telegram link." This is self-scoped only — employee_profile:update never edits OTHER
  // employees (that is the `employees` resource) — so granting it must not widen
  // cross-employee access.
  for (const role of phoenixRoles) {
    const context = createAccessContext({ hrId: `SELF-${role}`, role });
    assert.equal(
      await canAccess(context, "employee_profile", "update"),
      true,
      `${role} must be able to manage own profile/notification settings (employee_profile:update)`,
    );
  }
  const ceo = createAccessContext({ hrId: "CEO-1", role: "CEO" });
  assert.equal(await canAccess(ceo, "employees", "update"), false, "CEO still cannot edit other employees");

  assert.equal(getPayrollScope(employee), "SELF");
  assert.equal(getPayrollScope(districtManager), "SELF");
  assert.equal(getPayrollScope(createAccessContext({ role: "Finance Manager" })), "COMPANY");
  assert.equal(getSalesScope(employee), "SELF");
  assert.equal(getSalesScope(districtManager), "TEAM");
  assert.equal(getExpensesScope(employee), "SELF");
  assert.equal(getExpensesScope(districtManager), "TEAM");
}

