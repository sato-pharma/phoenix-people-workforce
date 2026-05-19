import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import postgres from "postgres";

import {
  canAccess,
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
  "HR Specialist",
  "Finance Manager",
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
  return createAccessContext({
    hrId: `PHASE22-${role.replace(/[^A-Z0-9]+/gi, "").toUpperCase()}`,
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

  const hr = contextFor("HR Specialist");
  await expectAccess(hr, "employees", "update", true);
  await expectAccess(hr, "user_admin", "update", true);
  await expectAccess(hr, "payroll", "import", true);
  await expectAccess(hr, "probation", "approve", true);

  const finance = contextFor("Finance Manager");
  await expectAccess(finance, "payroll", "approve", true);
  await expectAccess(finance, "expenses", "approve", true);
  await expectAccess(finance, "employees", "read", false);
  await expectAccess(finance, "user_admin", "update", false);
  await expectAccess(finance, "sales", "import", false);

  const ceo = contextFor("CEO");
  await expectAccess(ceo, "payroll", "read", true);
  await expectAccess(ceo, "expenses", "approve", true);
  await expectAccess(ceo, "contracts", "approve", true);
  await expectAccess(ceo, "leave", "approve", true);
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
    await expectAccess(context, "expenses", "approve", false);
    await expectAccess(context, "contracts", "approve", false);
  }
}

function verifyScopeHelpers() {
  expectScope("Super Admin navigation mode is admin", resolveNavigationMode(contextFor("Super Admin")), "admin");
  expectScope("HR Specialist navigation mode is admin", resolveNavigationMode(contextFor("HR Specialist")), "admin");
  expectScope("Finance Manager navigation mode is employee portal", resolveNavigationMode(contextFor("Finance Manager")), "employee-portal");
  expectScope("CEO navigation mode is employee portal", resolveNavigationMode(contextFor("CEO")), "employee-portal");
  expectScope("District Manager navigation mode is employee portal", resolveNavigationMode(contextFor("District Manager")), "employee-portal");
  expectScope("Medical Rep navigation mode is employee portal", resolveNavigationMode(contextFor("Medical Rep")), "employee-portal");

  expectScope("Employee payroll scope is SELF", getPayrollScope(contextFor("Employee")), "SELF");
  expectScope("Medical Rep payroll scope is SELF", getPayrollScope(contextFor("Medical Rep")), "SELF");
  expectScope("District Manager payroll scope is SELF", getPayrollScope(contextFor("District Manager")), "SELF");
  expectScope("Finance Manager payroll scope is COMPANY", getPayrollScope(contextFor("Finance Manager")), "COMPANY");
  expectScope("HR Specialist payroll scope is COMPANY", getPayrollScope(contextFor("HR Specialist")), "COMPANY");
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
  expectScope("Finance Manager expenses scope is COMPANY", getExpensesScope(contextFor("Finance Manager")), "COMPANY");
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
  const payrollPage = readFileSync("app/payroll/page.tsx", "utf8");
  const salesPage = readFileSync("app/sales/page.tsx", "utf8");
  const expensesDashboardPage = readFileSync("app/payroll/expenses/dashboard/page.tsx", "utf8");
  const portalLayout = readFileSync("app/employee-portals/layout.tsx", "utf8");
  const portalService = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  const payrollRoute = readFileSync("app/api/payroll/upload/route.ts", "utf8");
  const payrollWorkflowRoute = readFileSync("app/api/payroll/[id]/workflow/route.ts", "utf8");
  const salesUploadRoute = readFileSync("app/api/sales/imports/upload/route.ts", "utf8");
  const salesActionRoute = readFileSync("app/api/sales/imports/[id]/[action]/route.ts", "utf8");
  const bulkUsersRoute = readFileSync("app/api/admin/users/bulk-action/route.ts", "utf8");
  const probationPortalPage = readFileSync("app/employee-portals/probation/page.tsx", "utf8");

  addCheck("Admin payroll page redirects non-company payroll scopes to payslips", /getPayrollScope\(access\)[\s\S]*redirect\("\/payslips"\)/.test(payrollPage));
  addCheck("Admin sales page redirects employee-portal roles to portal sales", /resolveNavigationMode\(accessContext\) === "employee-portal"[\s\S]*redirect\("\/employee-portals\/sales"\)/.test(salesPage));
  addCheck("Admin expenses dashboard redirects employee-portal roles", /resolveNavigationMode\(access\) === "employee-portal"[\s\S]*redirect\("\/employee-portals\/expenses"\)/.test(expensesDashboardPage));
  addCheck("Employee portal layout requires employee profile read permission", /assertPermission\(access, "employee_profile", "read"\)/.test(portalLayout));
  addCheck("Employee portal payroll fetch is current-HR-ID only", /getEmployeePortalPayrollDashboard\(currentHrId\)/.test(portalService));
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
          "payroll_expenses",
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
