import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(path, "utf8");
}

function functionBlock(fileSource: string, functionName: string) {
  const start = fileSource.indexOf(`export async function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} must exist`);

  const next = fileSource.indexOf("\nexport async function ", start + 1);
  return fileSource.slice(start, next === -1 ? undefined : next);
}

export function runTransactionWorkflowAuditTests() {
  const auditSource = source("src/lib/admin/audit.ts");
  assert.match(auditSource, /const \{ error \} = await supabase\.from\("audit_logs"\)\.insert/);
  assert.match(auditSource, /if \(error\) \{\s*throw error;\s*\}/);
  assert.match(auditSource, /"sales_import_batch"/);
  assert.match(auditSource, /"payroll_batch"/);
  assert.match(auditSource, /"vacation_request"/);

  const auditViewerSource = source("src/components/admin/audit-log-viewer.tsx");
  assert.match(auditViewerSource, /sales_import_batch/);
  assert.match(auditViewerSource, /payroll_batch/);
  assert.match(auditViewerSource, /vacation_request/);

  const salesService = source("src/lib/sales/service.ts");
  const salesApproveReject = functionBlock(salesService, "updateSalesBatchStatus");
  assert.match(salesApproveReject, /from\("sales_import_batches"\)[\s\S]*\.update\(updateData\)/);
  assert.match(salesApproveReject, /if \(error\) \{\s*throw error;\s*\}/);
  assert.match(salesApproveReject, /from\("sales_audit_logs"\)\.insert/);
  assert.match(salesApproveReject, /if \(auditResult\.error\) \{\s*throw auditResult\.error;\s*\}/);
  assert.match(salesApproveReject, /writeRequiredAuditLog\(\{[\s\S]*entityType: "sales_import_batch"/);

  const salesReplace = functionBlock(salesService, "replaceSalesBatch");
  assert.match(salesReplace, /originalUpdate\.error/);
  assert.match(salesReplace, /replacementUpdate\.error/);
  assert.match(salesReplace, /from\("sales_audit_logs"\)\.insert/);
  assert.match(salesReplace, /writeRequiredAuditLog\(\{[\s\S]*summary: "Sales import replaced\."/);

  const salesDelete = functionBlock(salesService, "deleteSalesBatch");
  assert.match(salesDelete, /from\("sales_import_batches"\)\.delete\(\)\.eq\("id", batchId\)/);
  assert.match(salesDelete, /deleteResult\.error/);
  assert.match(salesDelete, /from\("sales_audit_logs"\)\.insert/);
  assert.match(salesDelete, /writeRequiredAuditLog\(\{[\s\S]*summary: "Sales import deleted\."/);

  const salesActionRoute = source("app/api/sales/imports/[id]/[action]/route.ts");
  const salesUploadRoute = source("app/api/sales/imports/upload/route.ts");
  assert.match(salesActionRoute, /updateSalesBatchStatus/);
  assert.match(salesActionRoute, /deleteSalesBatch/);
  assert.match(salesUploadRoute, /replaceSalesBatch/);

  const payrollService = source("src/lib/payroll/service.ts");
  const payrollWorkflow = functionBlock(payrollService, "runPayrollWorkflow");
  assert.match(payrollWorkflow, /\.eq\("status", transition\.expectedStatus\)/);
  assert.match(payrollWorkflow, /writeRequiredAuditLog\(\{[\s\S]*entityType: "payroll_batch"/);
  assert.match(payrollWorkflow, /oldValues: \{ status: currentStatus \}/);
  assert.match(payrollService, /rpc\(\s*"phx_create_salary_batch"/);
  assert.match(payrollService, /rpc\(\s*"phx_replace_salary_batch"/);
  assert.match(payrollService, /rpc\(\s*"phx_delete_salary_batch"/);

  const payrollExpenses = source("src/lib/payroll/expenses.ts");
  assert.match(payrollExpenses, /rpc\(\s*"phx_import_approved_expenses_to_payroll"/);

  const vacationService = source("src/lib/vacation/service.ts");
  const vacationDecision = vacationService.slice(
    vacationService.indexOf("async function applyVacationDecision"),
    vacationService.indexOf("export async function decideVacationRequest"),
  );
  assert.match(vacationDecision, /\.eq\("status", input\.request\.status\)/);
  assert.match(vacationDecision, /eventType: `approval_\$\{step\.stepKey\}_\$\{decisionValue\}`/);
  assert.match(vacationDecision, /stepKey: step\.stepKey/);
  assert.match(vacationDecision, /writeRequiredAuditLog\(\{[\s\S]*entityType: "vacation_request"/);

  const offersService = source("src/lib/offers/service.ts");
  const offerApprovalRoute = source("app/api/offers/[offerRef]/approve/route.ts");
  assert.match(offersService, /phx_approve_accepted_offer/);
  assert.match(offerApprovalRoute, /provisionNewHireAccess/);

  const manualEmployeeRoute = source("app/api/employees/route.ts");
  const bulkEmployeeRoute = source("app/api/imports/employees/confirm/route.ts");
  assert.match(manualEmployeeRoute, /provisionNewHireAccess/);
  assert.match(bulkEmployeeRoute, /provisionNewHireAccess/);

  const resignationsService = source("src/lib/resignations/service.ts");
  const probationService = source("src/lib/probation/service.ts");
  assert.match(resignationsService, /phx_resign_employee_and_open_vacancy/);
  assert.match(probationService, /resignEmployeeAndOpenVacancy/);
  assert.match(probationService, /employeeStatus: "terminated"/);

  const outstationService = source("src/lib/outstation/service.ts");
  assert.match(outstationService, /outstation_location_audit_logs/);
}
