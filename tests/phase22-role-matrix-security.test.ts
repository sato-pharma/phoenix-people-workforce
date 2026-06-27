import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAccess,
  canSeeEmployee,
  createAccessContext,
  getExpensesScope,
  getPayrollScope,
  getSalesScope,
  isRolePermissionWithinHardBoundary,
  permissionMatrix,
  phoenixRoles,
  resolveNavigationMode,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

export async function runPhase22RoleMatrixSecurityTests() {
  const phase22Smoke = readFileSync("scripts/phase22-role-matrix-security-smoke.ts", "utf8");
  const permissionsSource = readFileSync("src/lib/auth/permissions.ts", "utf8");

  assert.match(phase22Smoke, /Super Admin/);
  assert.match(phase22Smoke, /Talent Acquisition/);
  assert.match(phase22Smoke, /Finance Manager/);
  assert.match(phase22Smoke, /Marketing Manager/);
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
  const financeManager = createAccessContext({ hrId: "FIN-1", role: "Finance Manager" });
  const marketingManager = createAccessContext({ hrId: "A-9", role: "Marketing Manager" });
  const superAdmin = createAccessContext({ hrId: "SA-1", role: "Super Admin" });

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
  assert.equal(await canAccess(talentAcquisition, "employee_documents", "update"), true);
  assert.equal(await canAccess(talentAcquisition, "leave", "update"), true);
  assert.equal(await canAccess(talentAcquisition, "support_requests", "read"), true);
  assert.equal(await canAccess(talentAcquisition, "support_requests", "update"), true);
  assert.equal(await canAccess(talentAcquisition, "support_requests", "export"), true);
  assert.equal(await canAccess(talentAcquisition, "employees", "read"), false);
  assert.equal(await canAccess(talentAcquisition, "admin", "read"), false);
  assert.equal(await canAccess(talentAcquisition, "user_admin", "read"), false);

  assert.equal(await canAccess(superAdmin, "employees", "read"), true);
  assert.equal(await canAccess(superAdmin, "employees", "update"), true);
  assert.equal(await canAccess(superAdmin, "support_requests", "read"), true);
  assert.equal(await canAccess(superAdmin, "support_requests", "update"), true);
  assert.equal(await canAccess(superAdmin, "recruitment", "approve"), true);
  assert.equal(await canAccess(superAdmin, "offers", "update"), true);

  assert.equal(await canAccess(financeManager, "payroll", "read"), true);
  assert.equal(await canAccess(financeManager, "support_requests", "create"), true);
  assert.equal(await canAccess(financeManager, "support_requests", "read"), false);
  assert.equal(await canAccess(financeManager, "recruitment", "read"), false);

  assert.equal(await canAccess(marketingManager, "weekly_plans", "approve"), true);
  // Company-wide commercial oversight: monthly + weekly sales are granted (scope COMPANY).
  assert.equal(await canAccess(marketingManager, "sales", "read"), true);
  assert.equal(await canAccess(marketingManager, "sales", "export"), true);
  assert.equal(await canAccess(marketingManager, "weekly_sales", "read"), true);
  assert.equal(getSalesScope(marketingManager), "COMPANY");
  assert.equal(await canAccess(marketingManager, "support_requests", "create"), true);
  assert.equal(await canAccess(marketingManager, "support_requests", "read"), false);
  assert.equal(await canAccess(marketingManager, "employees", "read"), false);
  assert.equal(await canAccess(marketingManager, "recruitment", "update"), false);
  assert.equal(await canAccess(marketingManager, "candidates", "read"), false);
  assert.equal(await canAccess(marketingManager, "offers", "read"), false);

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
  assert.equal(await canAccess(ceo, "employees", "read"), false, "CEO must not see the employee master");
  assert.equal(await canAccess(ceo, "employees", "update"), false, "CEO still cannot edit other employees");
  assert.equal(await canAccess(ceo, "support_requests", "create"), true, "CEO can submit HR support requests");
  assert.equal(await canAccess(ceo, "support_requests", "read"), false, "CEO must not read the HR support inbox");
  assert.equal(await canAccess(ceo, "recruitment", "read"), false, "CEO must not see HR recruitment");
  assert.equal(await canAccess(ceo, "candidates", "read"), false, "CEO must not see candidate PII");
  assert.equal(await canAccess(ceo, "offers", "read"), false, "CEO must not see HR offer lifecycle");
  assert.equal(await canAccess(ceo, "probation", "read"), true, "CEO can read probation risk aggregates and read-only page");
  assert.equal(await canAccess(ceo, "probation", "create"), false, "CEO must not create probation reviews");
  assert.equal(await canAccess(ceo, "probation", "update"), false, "CEO must not update probation workflow");
  assert.equal(await canAccess(ceo, "probation", "approve"), false, "CEO must not approve probation decisions");

  const hrAuthorityRoles = new Set<PhoenixRole>(["Super Admin", "Talent Acquisition"]);
  for (const role of phoenixRoles) {
    const context = createAccessContext({ hrId: `ROLE-${role}`, role });
    assert.equal(await canAccess(context, "support_requests", "create"), true, `${role} can submit HR support requests`);
    assert.equal(
      await canAccess(context, "support_requests", "read"),
      hrAuthorityRoles.has(role),
      `${role} HR support inbox read scope`,
    );
    assert.equal(
      await canAccess(context, "support_requests", "update"),
      hrAuthorityRoles.has(role),
      `${role} HR support inbox update scope`,
    );
    assert.equal(
      await canAccess(context, "support_requests", "export"),
      hrAuthorityRoles.has(role),
      `${role} HR support inbox export scope`,
    );
  }

  const blockedResources: PermissionResource[] = ["employee_documents", "recruitment", "candidates", "offers"];
  const blockedActions: PermissionAction[] = ["read", "create", "update", "delete", "approve", "export", "import"];
  for (const role of phoenixRoles.filter((candidate) => !hrAuthorityRoles.has(candidate))) {
    for (const resource of blockedResources) {
      for (const action of blockedActions) {
        assert.equal(
          isRolePermissionWithinHardBoundary(role, resource, action),
          false,
          `${role} cannot be hard-granted ${action} ${resource}`,
        );
      }
    }
    assert.equal(permissionMatrix[role].employees, undefined, `${role} has no employee master permissions`);
  }

  // Segregation of duties: the CEO account is observational on irreversible HR/finance
  // workflows. It must NOT approve contracts/resignations/expenses/outstation/deductions or
  // mutate attendance, but RETAINS leave + weekly-plan approval (owner decision) and read/export.
  for (const resource of ["contracts", "resignations", "expenses", "outstation", "deductions"] as const) {
    assert.equal(await canAccess(ceo, resource, "approve"), false, `CEO must not approve ${resource}`);
    assert.equal(await canAccess(ceo, resource, "read"), true, `CEO can still read ${resource}`);
  }
  for (const action of ["create", "update", "delete"] as const) {
    assert.equal(await canAccess(ceo, "attendance", action), false, `CEO must not ${action} attendance`);
  }
  assert.equal(await canAccess(ceo, "attendance", "read"), true, "CEO can still read attendance");
  assert.equal(await canAccess(ceo, "leave", "approve"), true, "CEO retains leave approval for direct reports");
  assert.equal(await canAccess(ceo, "weekly_plans", "approve"), true, "CEO retains weekly-plan approval");

  assert.equal(getPayrollScope(employee), "SELF");
  assert.equal(getPayrollScope(districtManager), "SELF");
  assert.equal(getPayrollScope(createAccessContext({ role: "Finance Manager" })), "COMPANY");
  assert.equal(getSalesScope(employee), "SELF");
  assert.equal(getSalesScope(districtManager), "TEAM");
  assert.equal(getExpensesScope(employee), "SELF");
  assert.equal(getExpensesScope(districtManager), "TEAM");
}
