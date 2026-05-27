import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

function source(path: string) {
  return readFileSync(path, "utf8");
}

export function runExpenseRiskHardeningTests() {
  const adminAccess = source("src/lib/outstation/admin-access.ts");
  assert.match(adminAccess, /"Super Admin"/);
  assert.match(adminAccess, /"HR Specialist"/);
  assert.match(adminAccess, /"Finance Manager"/);
  assert.match(adminAccess, /"CEO"/);
  assert.match(adminAccess, /assertPermission\(access,\s*"outstation",\s*action\)/);

  const permissions = source("src/lib/auth/permissions.ts");
  assert.match(permissions, /"HR Specialist": \{[\s\S]*expenses: \["read", "approve", "update", "delete", "export"\]/);
  assert.match(permissions, /"HR Specialist": \{[\s\S]*outstation: \["read", "approve", "update", "delete", "export"\]/);

  const adminOutstationSources = [
    "app/api/admin/outstation/requests/route.ts",
    "app/api/admin/outstation/[id]/route.ts",
    "app/api/admin/outstation/manager-expenses/route.ts",
    "app/api/admin/outstation/manager-expenses/[id]/route.ts",
    "app/api/admin/outstation/heatmaps/route.ts",
    "app/api/admin/outstation/calculate-manager-distance/route.ts",
    "app/api/admin/outstation/places-autocomplete/route.ts",
    "app/api/admin/outstation/place-details/route.ts",
    "app/admin/outstation/requests/page.tsx",
    "app/admin/outstation/heatmaps/page.tsx",
  ].map(source).join("\n");
  assert.doesNotMatch(adminOutstationSources, /assertPermission\(access,\s*"outstation",\s*"read"\)/);
  assert.match(adminOutstationSources, /assertOutstationAdminAccess\(access,\s*"approve"\)/);
  assert.match(adminOutstationSources, /assertOutstationAdminAccess\(access,\s*"delete"\)/);

  const payrollExpenses = source("src/lib/payroll/expenses.ts");
  assert.match(payrollExpenses, /class PayrollExpenseReportLockedError/);
  assert.match(payrollExpenses, /assertPayrollExpenseReportCanMutate\(reportId,\s*"deleted"\)/);
  assert.match(payrollExpenses, /assertPayrollExpenseReportCanMutate\(reportId,\s*"replaced"\)/);
  assert.match(payrollExpenses, /select\("id,imported_payroll_batch_id,imported_to_payroll_at"\)/);
  assert.match(payrollExpenses, /row\.imported_payroll_batch_id != null \|\| row\.imported_to_payroll_at != null/);
  assert.match(payrollExpenses, /lockedExpenses: Number\(result\.locked_expenses \?\? 0\)/);
  assert.match(payrollExpenses, /manualPayrollExpenseApproverRoles/);
  assert.match(payrollExpenses, /"HR Specialist"/);
  assert.match(payrollExpenses, /assertManualPayrollExpenseApprovalAccess\(accessContext\)/);
  assert.match(payrollExpenses, /Save manual HR\/admin expense approvals before importing/);

  const importRoute = source("app/api/payroll/expenses/import/route.ts");
  assert.match(importRoute, /unsaved_approval_rows_not_allowed/);
  assert.match(importRoute, /Save manual HR\/admin expense approvals before importing to payroll/);
  assert.doesNotMatch(importRoute, /records: rawRecords/);

  const reportsRoute = source("app/api/payroll/expenses/reports/[id]/route.ts");
  assert.match(reportsRoute, /isPayrollExpenseReportLocked/);
  assert.match(reportsRoute, /"expense_report_locked"/);
  assert.match(reportsRoute, /status:\s*409/);
  assert.match(reportsRoute, /"payroll_expense_lock_schema_not_ready"/);

  const migration = source("supabase/migrations/20260527052440_outstation_expense_payroll_locks.sql");
  assert.match(migration, /add column if not exists imported_payroll_batch_id uuid/i);
  assert.match(migration, /add column if not exists imported_to_payroll_at timestamptz/i);
  assert.match(migration, /payroll_expenses_imported_payroll_batch_id_fkey/i);
  assert.match(migration, /create or replace function public\.phx_import_approved_expenses_to_payroll/i);
  assert.match(migration, /marked_expenses as \(/i);
  assert.match(migration, /'locked_expenses'/i);
  assert.match(migration, /migration_backfill/i);

  const manualApprovalMigrationName = readdirSync("supabase/migrations").find((name) =>
    name.includes("manual_expense_approval_gate"),
  );
  assert.ok(manualApprovalMigrationName, "Manual expense approval gate migration must exist.");
  const manualApprovalMigration = source(`supabase/migrations/${manualApprovalMigrationName}`);
  assert.match(manualApprovalMigration, /approved_at is not null/i);
  assert.match(manualApprovalMigration, /approved_by is not null/i);
  assert.match(manualApprovalMigration, /revoke all on function public\.phx_import_approved_expenses_to_payroll/i);

  const outstationService = source("src/lib/outstation/service.ts");
  assert.match(outstationService, /assertOutstationAdminAccess\(access,\s*"delete"\)/);
  assert.match(outstationService, /select\("id,imported_payroll_batch_id,imported_to_payroll_at,report_id,trip_id"\)/);
  assert.match(outstationService, /if \(!input\.linkedPayroll\) return 0/);
  assert.match(outstationService, /const addedToPayroll = linkedRows\.some/);
  assert.match(outstationService, /\.from\("payroll_expenses"\)[\s\S]*\.delete\(\{ count: "exact" \}\)[\s\S]*\.eq\("trip_id", expenseTripId\)/);
  assert.match(outstationService, /already been added to payroll and cannot be deleted/);

  const adminOutstationRequestRoute = source("app/api/admin/outstation/[id]/route.ts");
  assert.match(adminOutstationRequestRoute, /isOutstationPayrollLockError/);
  assert.match(adminOutstationRequestRoute, /isOutstationPayrollLockError\(error\) \? 409 : 500/);

  const employeePortalService = source("src/lib/employee-portal/service.ts");
  assert.match(employeePortalService, /mapOutstationRequestRowToPayrollApproval/);
  assert.match(employeePortalService, /return mapOutstationRequestRowToPayrollApproval\(row\)/);
  assert.doesNotMatch(employeePortalService, /statusLabelFromOutstation/);
  assert.doesNotMatch(employeePortalService, /Confirmed by HR/);
  assert.doesNotMatch(employeePortalService, /function expenseTypeLabel/);

  assert.match(payrollExpenses, /const requestTripIds = new Set/);
  assert.match(payrollExpenses, /dedupedHistoricalExpenses/);

  const commandCenter = source("src/lib/admin/command-center.ts");
  assert.match(commandCenter, /getPayrollExpenseMetrics/);
  assert.match(commandCenter, /fetchExpenseSummary\(accessContext\)/);
  assert.doesNotMatch(commandCenter, /\.from\("payroll_expenses"\)[\s\S]*select\("total,hr_approved"\)/);

  const adminService = source("src/lib/admin/service.ts");
  assert.match(adminService, /getPayrollExpenseMetrics\(systemAccessContext\)/);
  assert.match(adminService, /expensesCount: expenseMetrics\?\.totalRows \?\? expenses\.count \?\? 0/);

  const sidebar = source("src/components/layout/sidebar.tsx");
  const navigation = source("src/config/system-navigation.ts");
  assert.doesNotMatch(`${sidebar}\n${navigation}`, /\/employee\/outstation\/new/);
  assert.match(navigation, /label: "Expense Dashboard"/);
  assert.match(navigation, /label: "Submit Expense"/);
  assert.match(navigation, /label: "Team Expenses"/);

  const employeePortalRoutes = source("src/lib/employee-portal/routes.ts");
  assert.doesNotMatch(employeePortalRoutes, /\/employee\/outstation\/new/);

  const legacyEmployeeOutstation = source("app/employee/outstation/new/page.tsx");
  assert.match(legacyEmployeeOutstation, /redirect\("\/employee-portals\/expenses"\)/);
  assert.match(legacyEmployeeOutstation, /redirect\("\/employee-portals\/submit-expense"\)/);
  assert.doesNotMatch(legacyEmployeeOutstation, /MobileOutstationWizard/);

  const expenseDashboardPage = source("app/employee-portals/expense-dashboard/page.tsx");
  assert.match(expenseDashboardPage, /includePortalOverview: false/);
  assert.match(expenseDashboardPage, /includeTeamRank: false/);
  assert.match(expenseDashboardPage, /includeWorkforceSummary: false/);
  assert.doesNotMatch(expenseDashboardPage, /getAdminCommandCenterData/);
}
