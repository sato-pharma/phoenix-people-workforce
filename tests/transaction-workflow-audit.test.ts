import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AUDIT_ENTITY_TYPES } from "../src/lib/admin/audit-entity-types.ts";

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

  // THE INSERT MOVED, THE PROOF DID NOT. On 23 Oct 2026 the outbox mechanism was extracted to
  // `src/lib/platform/write-outbox.ts` so the notification writes could share it, and the
  // `audit_logs` insert went with the audit half of it. What this test exists to catch is
  // unchanged, so it is asserted in both halves: `audit.ts` must still REACH a real insert, and
  // that insert must still refuse to swallow its own error. Asserting only the wiring would pass
  // on a queue that writes nowhere; asserting only the insert would pass on an audit trail no
  // longer connected to it.
  assert.match(
    auditSource,
    /persistAuditLogThroughOutbox/,
    "audit.ts must persist through the outbox — the audit entity types below are worth nothing if " +
      "nothing writes a row.",
  );

  const auditOutboxSource = source("src/lib/admin/audit-outbox.ts");
  assert.match(auditOutboxSource, /const \{ error \} = await supabase\.from\("audit_logs"\)\.insert/);
  assert.match(
    auditOutboxSource,
    /if \(error\)\s*(\{\s*)?throw error;/,
    "a failed audit insert must throw: the caller retries it and then queues it, and an insert that " +
      "returned quietly would report a row that was never written.",
  );
  assert.match(auditSource, /"sales_import_batch"/);
  assert.match(auditSource, /"payroll_batch"/);
  assert.match(auditSource, /"vacation_request"/);

  // These three must be SELECTABLE on /admin/logs, which since 2026-09-30 means present in the
  // catalogue rather than typed into the viewer: the picker is `["all", ...AUDIT_ENTITY_TYPES]`
  // and the names no longer appear in that file at all. Asserting the catalogue is the same
  // guarantee against the screen the owner actually uses — tests/audit-entity-types.test.ts holds
  // the wiring itself.
  for (const entityType of ["sales_import_batch", "payroll_batch", "vacation_request"] as const) {
    assert.ok(
      AUDIT_ENTITY_TYPES.includes(entityType),
      `the audit log picker must offer "${entityType}".`,
    );
  }

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

  const payrollExpenses = source("src/lib/outstation/expenses.ts");
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
  // The GPS fraud/location audit-log table was removed with the fraud system; the
  // outstation workflow's transaction audit trail is the shared writeRequiredAuditLog.
  assert.match(outstationService, /writeRequiredAuditLog\(\{[\s\S]*entityType: "outstation_request"/);
}
