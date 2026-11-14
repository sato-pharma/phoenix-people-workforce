import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase25StagingRlsMutationSmokeTests() {
  const smoke = readFileSync("scripts/phase25-staging-rls-mutation-smoke.ts", "utf8");
  const vacationDecisionRoute = readFileSync("app/api/vacations/requests/[id]/decision/route.ts", "utf8");
  const vacationService = readFileSync("src/lib/vacation/service.ts", "utf8");
  const expenseImportRoute = readFileSync("app/api/admin/outstation/expenses/import/route.ts", "utf8");
  const employeesRoute = readFileSync("app/api/employees/route.ts", "utf8");
  const probationDecisionRoute = readFileSync("app/api/probation/cases/[caseId]/decision/route.ts", "utf8");

  assert.match(smoke, /PHOENIX_CONFIRM_STAGING_RLS_RUN/);
  // The approved staging target must come from the environment and fail closed when absent.
  // Pinning a literal ref here is what let the retired sandbox rot in place unnoticed.
  assert.match(smoke, /PHOENIX_APPROVED_STAGING_REF is required/);
  assert.doesNotMatch(smoke, /= "oaifhavixhdtwmseshff"/);
  assert.match(smoke, /blockedProductionRef = "ozucdzovmcqvepbozvqf"/);
  assert.match(smoke, /PHOENIX_STAGING_DATABASE_URL/);
  assert.match(smoke, /PHASE25-/);

  assert.match(smoke, /create table if not exists public\.employee_probation/);
  assert.match(smoke, /create table if not exists public\.v2_vacation_requests/);
  assert.match(smoke, /alter table public\.employee_probation enable row level security/);
  assert.match(smoke, /alter table public\.v2_vacation_requests enable row level security/);
  assert.match(smoke, /revoke all on table public\.employee_probation from public, anon/);
  assert.match(smoke, /revoke all on table public\.v2_vacation_requests from public, anon/);
  assert.match(smoke, /grant select, insert, update, delete on table public\.employee_probation to authenticated, service_role/);
  assert.match(smoke, /grant select, insert, update, delete on table public\.v2_vacation_requests to authenticated, service_role/);

  assert.match(smoke, /current_access_can_manage_employees/);
  assert.match(smoke, /current_access_can_manage_payroll/);
  assert.match(smoke, /current_access_can_see_employee/);
  assert.match(smoke, /current_access_scope\(\) in \('TEAM', 'HIERARCHY'\)/);
  assert.doesNotMatch(smoke, /auth\.jwt\(\)->'user_metadata'/);
  assert.doesNotMatch(smoke, /raw_user_meta_data/);

  assert.match(smoke, /signInWithPassword/);
  assert.match(smoke, /Employee cannot create employee master rows/);
  assert.match(smoke, /HR can create disposable employee governance fixture/);
  assert.match(smoke, /Super Admin can create disposable employee governance fixture/);
  assert.match(smoke, /Finance can create disposable payroll expense fixture/);
  assert.match(smoke, /Employee cannot mutate payroll expense fixtures/);
  assert.match(smoke, /HR can create disposable probation fixture/);
  assert.match(smoke, /Employee cannot self-mutate probation decisions/);
  assert.match(smoke, /Employee can create own disposable vacation request/);
  assert.match(smoke, /Employee cannot create vacation request for another employee/);
  assert.match(smoke, /Manager cannot mutate vacation requests outside team/);

  assert.match(smoke, /cleanupPhase25Fixtures/);
  assert.match(smoke, /delete from public\.v2_vacation_requests/);
  assert.match(smoke, /delete from public\.employee_probation/);
  assert.match(smoke, /delete from public\.outstation_expenses/);
  assert.match(smoke, /delete from public\.employees/);
  assert.match(smoke, /finally/);

  assert.match(vacationDecisionRoute, /resolveAccessContext\(request\)/);
  assert.match(vacationDecisionRoute, /decideVacationRequest\(access/);
  assert.match(vacationService, /assertPermission\(access, "leave", "approve"\)/);
  assert.match(expenseImportRoute, /resolveAccessContext\(request\)/);
  assert.match(expenseImportRoute, /assertSystemAdministratorWorkspaceAccess\(access,\s*"payroll expenses administration"\)/);
  assert.match(employeesRoute, /resolveAccessContext\(request\)/);
  assert.match(employeesRoute, /assertPermission\(access, "employees", "update"\)/);
  assert.match(probationDecisionRoute, /resolveAccessContext\(request\)/);
  assert.match(probationDecisionRoute, /assertPermission\(access, "probation"/);
}
