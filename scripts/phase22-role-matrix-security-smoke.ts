import { readFileSync } from "node:fs";

import postgres from "postgres";

import {
  canAccess,
  canAccessAttendanceSetup,
  canSeeEmployee,
  createAccessContext,
  getExpensesScope,
  getPayrollScope,
  getSalesScope,
  resolveNavigationMode,
  type AccessContext,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

type Check = {
  details?: unknown;
  label: string;
  ok: boolean;
};

const checks: Check[] = [];
const warnings: string[] = [];

const phase22Roles: PhoenixRole[] = [
  "Super Admin",
  "Talent Acquisition",
  "Finance Manager",
  "Marketing Manager",
  "CEO",
  "Manager",
  "District Manager",
  "Medical Rep",
  "Employee",
];

function loadLocalEnv() {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // CI can inject env vars directly.
  }
}

function contextFor(role: PhoenixRole): AccessContext {
  const hrId = role === "Talent Acquisition"
    ? "A-16"
    : `PHASE22-${role.replace(/[^A-Z0-9]+/gi, "").toUpperCase()}`;
  return createAccessContext({
    hrId,
    loginId: `phase22.${role.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`,
    role,
    source: "session",
  });
}

function addCheck(label: string, ok: boolean, details?: unknown) {
  checks.push({ details, label, ok });
  if (!ok) throw new Error(`${label} failed${details ? `: ${JSON.stringify(details)}` : ""}`);
}

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

async function expectAccess(
  context: AccessContext,
  resource: PermissionResource,
  action: PermissionAction,
  expected: boolean,
) {
  const actual = await canAccess(context, resource, action);
  addCheck(`${context.role} ${expected ? "can" : "cannot"} ${action} ${resource}`, actual === expected, { actual, expected });
}

function expectScope(label: string, actual: unknown, expected: unknown) {
  addCheck(label, actual === expected, { actual, expected });
}

async function verifyRoleMatrix() {
  const superAdmin = contextFor("Super Admin");
  await expectAccess(superAdmin, "admin", "read", true);
  await expectAccess(superAdmin, "user_admin", "update", true);
  await expectAccess(superAdmin, "payroll", "import", true);
  await expectAccess(superAdmin, "sales", "approve", true);
  await expectAccess(superAdmin, "employees", "update", true);
  await expectAccess(superAdmin, "support_requests", "update", true);
  await expectAccess(superAdmin, "recruitment", "approve", true);
  await expectAccess(superAdmin, "offers", "update", true);

  const talentAcquisition = contextFor("Talent Acquisition");
  await expectAccess(talentAcquisition, "recruitment", "create", true);
  await expectAccess(talentAcquisition, "candidates", "read", true);
  await expectAccess(talentAcquisition, "offers", "create", true);
  await expectAccess(talentAcquisition, "employee_documents", "update", true);
  await expectAccess(talentAcquisition, "leave", "update", true);
  await expectAccess(talentAcquisition, "support_requests", "read", true);
  await expectAccess(talentAcquisition, "support_requests", "update", true);
  await expectAccess(talentAcquisition, "support_requests", "export", true);
  await expectAccess(talentAcquisition, "employee_profile", "update", true);
  await expectAccess(talentAcquisition, "employees", "read", false);
  await expectAccess(talentAcquisition, "overview", "read", false);
  await expectAccess(talentAcquisition, "communication", "update", false);
  await expectAccess(talentAcquisition, "payslips", "read", false);
  await expectAccess(talentAcquisition, "user_admin", "update", false);
  await expectAccess(talentAcquisition, "payroll", "import", false);
  await expectAccess(talentAcquisition, "expenses", "read", false);
  await expectAccess(talentAcquisition, "probation", "approve", false);
  addCheck("Talent Acquisition cannot access attendance setup", !await canAccessAttendanceSetup(talentAcquisition, "read"));
  addCheck("Talent Acquisition cannot update attendance setup", !await canAccessAttendanceSetup(talentAcquisition, "update"));

  const finance = contextFor("Finance Manager");
  await expectAccess(finance, "payroll", "approve", true);
  await expectAccess(finance, "expenses", "approve", true);
  await expectAccess(finance, "employees", "read", false);
  await expectAccess(finance, "support_requests", "create", true);
  await expectAccess(finance, "support_requests", "read", false);
  await expectAccess(finance, "recruitment", "read", false);
  await expectAccess(finance, "user_admin", "update", false);
  await expectAccess(finance, "sales", "import", false);

  const marketingManager = contextFor("Marketing Manager");
  await expectAccess(marketingManager, "weekly_plans", "approve", true);
  await expectAccess(marketingManager, "sales", "read", true);
  await expectAccess(marketingManager, "sales", "export", true);
  await expectAccess(marketingManager, "weekly_sales", "read", true);
  await expectAccess(marketingManager, "support_requests", "create", true);
  await expectAccess(marketingManager, "support_requests", "read", false);
  await expectAccess(marketingManager, "employees", "read", false);
  await expectAccess(marketingManager, "recruitment", "update", false);
  await expectAccess(marketingManager, "candidates", "read", false);
  await expectAccess(marketingManager, "offers", "read", false);
  await expectAccess(marketingManager, "payroll", "read", true);

  const ceo = contextFor("CEO");
  await expectAccess(ceo, "payroll", "read", true);
  await expectAccess(ceo, "employees", "read", false);
  await expectAccess(ceo, "expenses", "approve", false);
  await expectAccess(ceo, "contracts", "approve", false);
  await expectAccess(ceo, "contracts", "read", true);
  await expectAccess(ceo, "leave", "approve", true);
  await expectAccess(ceo, "support_requests", "create", true);
  await expectAccess(ceo, "support_requests", "read", false);
  await expectAccess(ceo, "recruitment", "read", false);
  await expectAccess(ceo, "candidates", "read", false);
  await expectAccess(ceo, "offers", "read", false);
  await expectAccess(ceo, "user_admin", "update", false);
  await expectAccess(ceo, "payroll", "import", false);

  for (const role of ["Manager", "District Manager"] as const) {
    const context = contextFor(role);
    await expectAccess(context, "team", "read", true);
    await expectAccess(context, "sales", "read", true);
    await expectAccess(context, "expenses", "approve", role === "District Manager");
    await expectAccess(context, "leave", "approve", true);
    await expectAccess(context, "payroll", "read", true);
    await expectAccess(context, "payroll", "import", false);
    await expectAccess(context, "support_requests", "create", true);
    await expectAccess(context, "support_requests", "read", false);
    await expectAccess(context, "recruitment", "read", false);
    await expectAccess(context, "candidates", "read", false);
    await expectAccess(context, "offers", "read", false);
    await expectAccess(context, "user_admin", "update", false);
    await expectAccess(context, "admin", "read", false);
  }

  for (const role of ["Medical Rep", "Employee"] as const) {
    const context = contextFor(role);
    await expectAccess(context, "employee_profile", "read", true);
    await expectAccess(context, "payroll", "read", true);
    await expectAccess(context, "expenses", "read", true);
    await expectAccess(context, "sales", "read", true);
    await expectAccess(context, "leave", "create", true);
    await expectAccess(context, "probation", "read", true);
    await expectAccess(context, "team", "read", false);
    await expectAccess(context, "admin", "read", false);
    await expectAccess(context, "sales", "import", false);
    await expectAccess(context, "payroll", "update", false);
    await expectAccess(context, "support_requests", "create", true);
    await expectAccess(context, "support_requests", "read", false);
    await expectAccess(context, "recruitment", "read", false);
    await expectAccess(context, "candidates", "read", false);
    await expectAccess(context, "offers", "read", false);
    await expectAccess(context, "expenses", "approve", false);
    await expectAccess(context, "contracts", "approve", false);
  }
}

function verifyScopeHelpers() {
  expectScope("Super Admin navigation mode is admin", resolveNavigationMode(contextFor("Super Admin")), "admin");
  expectScope("Talent Acquisition navigation mode is admin", resolveNavigationMode(contextFor("Talent Acquisition")), "admin");
  expectScope("Finance Manager navigation mode is admin", resolveNavigationMode(contextFor("Finance Manager")), "admin");
  expectScope("Marketing Manager navigation mode is employee portal", resolveNavigationMode(contextFor("Marketing Manager")), "employee-portal");
  expectScope("CEO navigation mode is admin", resolveNavigationMode(contextFor("CEO")), "admin");
  expectScope("District Manager navigation mode is employee portal", resolveNavigationMode(contextFor("District Manager")), "employee-portal");
  expectScope("Medical Rep navigation mode is employee portal", resolveNavigationMode(contextFor("Medical Rep")), "employee-portal");

  expectScope("Employee payroll scope is SELF", getPayrollScope(contextFor("Employee")), "SELF");
  expectScope("Medical Rep payroll scope is SELF", getPayrollScope(contextFor("Medical Rep")), "SELF");
  expectScope("District Manager payroll scope is SELF", getPayrollScope(contextFor("District Manager")), "SELF");
  expectScope("Finance Manager payroll scope is COMPANY", getPayrollScope(contextFor("Finance Manager")), "COMPANY");
  expectScope("Talent Acquisition payroll scope is SELF", getPayrollScope(contextFor("Talent Acquisition")), "SELF");
  expectScope("CEO payroll scope is COMPANY", getPayrollScope(contextFor("CEO")), "COMPANY");

  expectScope("Employee sales scope is SELF", getSalesScope(contextFor("Employee")), "SELF");
  expectScope("Medical Rep sales scope is SELF", getSalesScope(contextFor("Medical Rep")), "SELF");
  expectScope("District Manager sales scope is TEAM", getSalesScope(contextFor("District Manager")), "TEAM");
  expectScope("Manager sales scope is TEAM", getSalesScope(contextFor("Manager")), "TEAM");
  expectScope("CEO sales scope is COMPANY", getSalesScope(contextFor("CEO")), "COMPANY");

  expectScope("Employee expenses scope is SELF", getExpensesScope(contextFor("Employee")), "SELF");
  expectScope("Medical Rep expenses scope is SELF", getExpensesScope(contextFor("Medical Rep")), "SELF");
  expectScope("District Manager expenses scope is TEAM", getExpensesScope(contextFor("District Manager")), "TEAM");
  expectScope("Manager expenses scope is TEAM", getExpensesScope(contextFor("Manager")), "TEAM");
  // Was COMPANY until 2026-08-10, when the owner excluded the Finance Manager from outstation and
  // expenses entirely. He keeps a bare `expenses:read` only because that permission also gates the
  // /api/marketing-requests/** namespace he executes the finance_execution rung from — SELF is what
  // stops that residual grant handing back the company-wide expense read the removal closed.
  expectScope("Finance Manager expenses scope is SELF", getExpensesScope(contextFor("Finance Manager")), "SELF");
}

function verifyEmployeePortalSelfOnlyIsolation() {
  const employee = contextFor("Employee");
  const medRep = contextFor("Medical Rep");
  const districtManager = contextFor("District Manager");
  const employeeHrId = employee.hrId ?? "PHASE22-EMPLOYEE";
  const medRepHrId = medRep.hrId ?? "PHASE22-MEDREP";
  const districtManagerHrId = districtManager.hrId ?? "PHASE22-DM";
  const directReport = { hrId: "PHASE22-REPORT", managerHrId: employeeHrId };
  const medRepReport = { hrId: "PHASE22-MR-REPORT", managerHrId: medRepHrId };
  const managerReport = { hrId: "PHASE22-DM-REPORT", managerHrId: districtManagerHrId };

  addCheck("Employee can see self", canSeeEmployee(employee, { hrId: employeeHrId, managerHrId: "OTHER" }));
  addCheck("Employee cannot see accidental direct report", !canSeeEmployee(employee, directReport));
  addCheck("Medical Rep can see self", canSeeEmployee(medRep, { hrId: medRepHrId, managerHrId: "OTHER" }));
  addCheck("Medical Rep cannot see accidental direct report", !canSeeEmployee(medRep, medRepReport));
  addCheck("District Manager can see direct report", canSeeEmployee(districtManager, managerReport));
}

function verifyStaticEntryPoints() {
  const payrollPage = readFileSync("app/(admin)/payroll/page.tsx", "utf8");
  const salesPage = readFileSync("app/(admin)/sales/page.tsx", "utf8");
  const expensesPage = readFileSync("app/(admin)/admin/outstation/expenses/page.tsx", "utf8");
  const expensesDashboardPage = readFileSync("app/(admin)/admin/outstation/expenses/dashboard/page.tsx", "utf8");
  const expensesRoute = readFileSync("app/api/admin/outstation/expenses/route.ts", "utf8");
  const expensesAnalyzeRoute = readFileSync("app/api/admin/outstation/expenses/analyze/route.ts", "utf8");
  const expensesImportRoute = readFileSync("app/api/admin/outstation/expenses/import/route.ts", "utf8");
  const expensesReportsRoute = readFileSync("app/api/admin/outstation/expenses/reports/[id]/route.ts", "utf8");
  const attendanceExceptionsPage = readFileSync("app/(admin)/attendance/exceptions/page.tsx", "utf8");
  const attendanceExceptionRoute = readFileSync("app/api/attendance/exceptions/[id]/route.ts", "utf8");
  const vacationActionCenterPage = readFileSync("app/leave-management/vacation-action-center/page.tsx", "utf8");
  const marketingControlPage = readFileSync("app/(admin)/admin/marketing-requests/control/page.tsx", "utf8");
  const portalLayout = readFileSync("app/employee-portals/layout.tsx", "utf8");
  const portalService = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  const payrollRoute = readFileSync("app/api/payroll/upload/route.ts", "utf8");
  const payrollWorkflowRoute = readFileSync("app/api/payroll/[id]/workflow/route.ts", "utf8");
  const salesUploadRoute = readFileSync("app/api/sales/imports/upload/route.ts", "utf8");
  const salesActionRoute = readFileSync("app/api/sales/imports/[id]/[action]/route.ts", "utf8");
  const bulkUsersRoute = readFileSync("app/api/admin/users/bulk-action/route.ts", "utf8");
  const contactHrSupportPage = readFileSync("app/employee-portals/contact-hr-support/page.tsx", "utf8");
  const probationPortalPage = readFileSync("app/employee-portals/probation/page.tsx", "utf8");
  const vacationService = readFileSync("src/lib/vacation/service.ts", "utf8");
  const attendancePoliciesPage = readFileSync("app/(admin)/attendance/policies/page.tsx", "utf8");
  const attendanceDeviceMappingPage = readFileSync("app/(admin)/attendance/device-user-mapping/page.tsx", "utf8");
  const attendancePoliciesRoute = readFileSync("app/api/attendance/policies/route.ts", "utf8");
  const attendanceDeviceMappingRoute = readFileSync("app/api/attendance/device-user-mappings/route.ts", "utf8");
  const adminCommandCenterPage = readFileSync("app/(admin)/admin/page.tsx", "utf8");
  const adminDataHealthPage = readFileSync("app/(admin)/admin/data-health/page.tsx", "utf8");
  const adminMonitoringPage = readFileSync("app/(admin)/admin/monitoring/page.tsx", "utf8");
  const adminLogsPage = readFileSync("app/(admin)/admin/logs/page.tsx", "utf8");
  const adminCommandCenter = readFileSync("src/components/admin/admin-command-center.tsx", "utf8");
  const adminCommandCenterService = readFileSync("src/lib/admin/command-center.ts", "utf8");

  addCheck("Admin payroll page redirects non-company payroll scopes to payslips", /getPayrollScope\(access\)[\s\S]*redirect\("\/payslips"\)/.test(payrollPage));
  addCheck("Admin command center allows overview read without full admin", /canAccess\(access, "admin", "read"\)[\s\S]*canAccess\(access, "overview", "read"\)/.test(adminCommandCenterPage));
  addCheck("Admin data health remains full-admin gated", !/canAccess\(access, "overview", "read"\)/.test(adminDataHealthPage));
  addCheck("Admin monitoring remains full-admin gated", !/canAccess\(access, "overview", "read"\)/.test(adminMonitoringPage));
  addCheck("Admin audit logs remain full-admin gated", !/canAccess\(access, "overview", "read"\)/.test(adminLogsPage));
  addCheck("HR command center hides financial and admin modules behind access flags", /showFinancialModules[\s\S]*Payroll Operations/.test(adminCommandCenter) && /showAdminModules[\s\S]*Access Control/.test(adminCommandCenter));
  addCheck("HR command center hides sales modules and renders concise HR modules", /showSalesModules[\s\S]*Sales Performance/.test(adminCommandCenter) && /People Management/.test(adminCommandCenter) && /Hiring Pipeline/.test(adminCommandCenter) && /HR Communication/.test(adminCommandCenter));
  addCheck("HR command center skips sales data fetches", /showSalesModules \? fetchSalesSummary/.test(adminCommandCenterService) && /showSalesModules \? fetchSalesHealthCounts/.test(adminCommandCenterService));
  addCheck("Attendance setup pages use dedicated non-HR gate", /canAccessAttendanceSetup\(access, "read"\)/.test(attendancePoliciesPage) && /canAccessAttendanceSetup\(access, "read"\)/.test(attendanceDeviceMappingPage));
  addCheck("Attendance setup APIs use dedicated non-HR gate", /assertAttendanceSetupPermission\(access, "read"\)/.test(attendancePoliciesRoute) && /assertAttendanceSetupPermission\(access, "update"\)/.test(attendancePoliciesRoute) && /assertAttendanceSetupPermission\(access, "read"\)/.test(attendanceDeviceMappingRoute) && /assertAttendanceSetupPermission\(access, "update"\)/.test(attendanceDeviceMappingRoute));
  addCheck("Admin sales page redirects employee-portal roles to portal sales", /resolveNavigationMode\(accessContext\) === "employee-portal"[\s\S]*redirect\("\/employee-portals\/sales"\)/.test(salesPage));
  addCheck("Payroll expenses admin page is system-administrator-only", /canAccessSystemAdministratorWorkspace\(access\)[\s\S]*redirect\("\/admin\/access"\)/.test(expensesPage));
  addCheck("Admin expenses dashboard is system-administrator-only", /canAccessSystemAdministratorWorkspace\(access\)[\s\S]*redirect\("\/admin\/access"\)/.test(expensesDashboardPage));
  addCheck("Attendance exceptions admin page is system-administrator-only", /canAccessSystemAdministratorWorkspace\(access\)[\s\S]*redirect\("\/admin\/access"\)/.test(attendanceExceptionsPage));
  addCheck("Vacation Action Center page is system-administrator-only", /canAccessSystemAdministratorWorkspace\(access\)[\s\S]*redirect\("\/admin\/access"\)/.test(vacationActionCenterPage));
  addCheck("Admin Marketing Control page is system-administrator-only", /assertMarketingAdminPageAccess\(\{ systemAdministratorOnly: true \}\)/.test(marketingControlPage));
  addCheck("Payroll expenses API routes are system-administrator-only", [expensesRoute, expensesAnalyzeRoute, expensesImportRoute, expensesReportsRoute].every((source) => /assertSystemAdministratorWorkspaceAccess\(access,\s*"payroll expenses administration"\)/.test(source)));
  addCheck("Attendance exception review API is system-administrator-only", /assertSystemAdministratorWorkspaceAccess\(access,\s*"attendance exception administration"\)/.test(attendanceExceptionRoute));
  addCheck("Employee portal layout requires employee profile read permission", /assertPermission\(access, "employee_profile", "read"\)/.test(portalLayout));
  addCheck("Employee portal payroll fetch is current-HR-ID only", /getEmployeePortalPayrollDashboard\(currentHrId\)/.test(portalService));
  addCheck("Employee portal HR support submission uses sender permission", /assertPermission\(access, "support_requests", "create"\)/.test(contactHrSupportPage));
  addCheck("Vacation Control service is HR-authority gated", /assertVacationControlAuthority\(access\)[\s\S]*assertPermission\(access, "leave", "update"\)/.test(vacationService));
  addCheck("Employee portal sales fetch uses scoped HR IDs or scoped line", /getScopedEmployeePortalSalesDashboard\(\{[\s\S]*targetSalesHrIds/.test(portalService));
  addCheck("Employee portal workforce has self/team/line/company branches", /isCompanyWorkforceRole\(role\)[\s\S]*isLineWorkforceRole\(role\)[\s\S]*isTeamWorkforceRole\(role\)[\s\S]*return activeRows\.filter/.test(portalService));
  addCheck("Probation portal uses read permission and scoped service", /assertPermission\(access, "probation", "read"\)/.test(probationPortalPage) && /getProbationRows\(access\)/.test(probationPortalPage));
  addCheck("Payroll upload mutation requires payroll import", /assertPermission\(access, "payroll", "import"\)/.test(payrollRoute));
  addCheck("Payroll workflow mutation requires payroll update or approve", /assertPermission\(access, "payroll", action === "approve" \? "approve" : "update"\)/.test(payrollWorkflowRoute));
  addCheck("Sales upload mutation requires sales import", /assertPermission\(access, "sales", "import"\)/.test(salesUploadRoute));
  addCheck("Sales action mutation requires sales approve/delete", /assertPermission\(access, "sales", "delete"\)/.test(salesActionRoute) && /assertPermission\(access, "sales", "approve"\)/.test(salesActionRoute));
  addCheck("Users bulk mutation requires user admin update", /assertPermission\(access, "user_admin", "update"\)/.test(bulkUsersRoute));
}

async function verifyReadOnlyDatabaseAlignment() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    warnings.push("SUPABASE_DB_URL is missing; skipped live read-only role/RLS alignment check.");
    return;
  }

  const sql = postgres(dbUrl, { max: 1, prepare: false });
  try {
    const authRoleRows = await sql<{ role: string }[]>`
      select distinct role
      from public.app_auth_users
      where role is not null
      order by role
    `;
    const unknownRoles = authRoleRows
      .map((row) => String(row.role ?? "").trim())
      .filter((role) => role && !(phase22Roles as string[]).includes(role) && ![
        "Regional Manager",
        "National Sales Manager",
        "Product Manager",
        "Group Product Manager",
        "SFE Manager",
        "Training Manager",
        "Marketing Manager",
      ].includes(role));
    addCheck("live app_auth_users roles align with Phoenix role names", unknownRoles.length === 0, unknownRoles);

    const rlsRows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = any(${[
          "app_auth_users",
          "user_access_profiles",
          "employees",
          "salary_batches",
          "salary_records",
          "outstation_expenses",
          "sales_records",
          "employee_probation",
          "employee_contracts",
          "v2_vacation_requests",
        ]})
      order by c.relname
    `;
    addCheck(
      "role-sensitive business tables keep RLS enabled",
      rlsRows.length > 0 && rlsRows.every((row) => row.relrowsecurity),
      rlsRows,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  loadLocalEnv();
  await verifyRoleMatrix();
  verifyScopeHelpers();
  verifyEmployeePortalSelfOnlyIsolation();
  verifyStaticEntryPoints();
  await verifyReadOnlyDatabaseAlignment();

  console.log(JSON.stringify({
    checks,
    policy: {
      adminRoutes: "Unauthorized portal roles are redirected away from admin dashboard surfaces, and API mutations require resource/action permissions.",
      employeePortal: "Employee and Medical Rep visibility is self-only; managers get team scopes through manager roles only.",
      payroll: "Payroll admin surfaces require COMPANY payroll scope; portal payroll fetches current HR ID only.",
      readOnly: "PHASE22 smoke performs role-matrix and RLS checks without inserts, updates, deletes, or production mutations.",
    },
    warnings,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: message(error), warnings }, null, 2));
  process.exitCode = 1;
});
