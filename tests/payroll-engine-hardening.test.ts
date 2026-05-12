import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migrationSource = readFileSync(
  new URL("../supabase/20260512_payroll_engine_hardening.sql", import.meta.url),
  "utf8",
);

const downloadRouteSource = readFileSync(
  new URL("../app/api/payroll/[id]/download/route.ts", import.meta.url),
  "utf8",
);

const employeePortalServiceSource = readFileSync(
  new URL("../src/lib/employee-portal/service.ts", import.meta.url),
  "utf8",
);

const expensesImportRouteSource = readFileSync(
  new URL("../app/api/payroll/expenses/import/route.ts", import.meta.url),
  "utf8",
);

const expensesSource = readFileSync(
  new URL("../src/lib/payroll/expenses.ts", import.meta.url),
  "utf8",
);

const payslipRouteSource = readFileSync(
  new URL("../app/api/payroll/[id]/payslips/route.ts", import.meta.url),
  "utf8",
);

const payrollDashboardSource = readFileSync(
  new URL("../src/components/payroll/payroll-dashboard.tsx", import.meta.url),
  "utf8",
);

const payrollServiceSource = readFileSync(
  new URL("../src/lib/payroll/service.ts", import.meta.url),
  "utf8",
);

const transactionalWorkflowSource = readFileSync(
  new URL("../supabase/phoenix-transactional-workflows-phase-2.sql", import.meta.url),
  "utf8",
);

const uploadRouteSource = readFileSync(
  new URL("../app/api/payroll/upload/route.ts", import.meta.url),
  "utf8",
);

const validateRouteSource = readFileSync(
  new URL("../app/api/payroll/validate/route.ts", import.meta.url),
  "utf8",
);

export function runPayrollEngineHardeningTests() {
  assert.match(
    migrationSource,
    /create or replace function public\.phx_replace_salary_batch/i,
    "Payroll replacement RPC must exist.",
  );
  assert.match(
    migrationSource,
    /for update/i,
    "Payroll replacement RPC must lock the target batch row.",
  );
  assert.match(
    migrationSource,
    /status not in \('uploaded', 'under_review', 'rejected'\)/i,
    "Payroll replacement RPC must block non-replaceable statuses.",
  );
  assert.match(
    migrationSource,
    /v_batch\.month is distinct from p_expected_month/i,
    "Payroll replacement RPC must guard the payroll period.",
  );
  assert.match(
    migrationSource,
    /revoke all on function public\.phx_replace_salary_batch\(uuid, integer, integer, text, text, jsonb, jsonb, timestamptz\) from public, anon, authenticated/i,
    "Payroll replacement RPC must not be callable by public, anon, or authenticated.",
  );
  assert.match(
    migrationSource,
    /grant execute on function public\.phx_replace_salary_batch\(uuid, integer, integer, text, text, jsonb, jsonb, timestamptz\) to service_role/i,
    "Payroll replacement RPC must be callable only by service_role.",
  );
  assert.match(
    migrationSource,
    /jsonb_array_length\(v_records\)\s*=\s*0/i,
    "Payroll replacement RPC must reject empty replacement payloads before deleting old records.",
  );
  assert.match(
    migrationSource,
    /phx_prevent_duplicate_salary_period/i,
    "Payroll migration must prevent duplicate active payroll periods.",
  );
  assert.match(
    migrationSource,
    /phx_prevent_closed_salary_records_mutation/i,
    "Payroll migration must block salary record mutations for closed batches.",
  );
  assert.match(
    migrationSource,
    /phx_prevent_closed_salary_flags_mutation/i,
    "Payroll migration must block salary flag mutations for closed batches.",
  );
  assert.match(
    migrationSource,
    /phx_prevent_closed_salary_batch_delete/i,
    "Payroll migration must block deleting approved or locked batches.",
  );
  assert.match(
    migrationSource,
    /Payroll batch cannot import expenses while status is %/i,
    "Payroll expense import RPC must block closed payroll batches.",
  );
  assert.match(
    transactionalWorkflowSource,
    /Payroll batch cannot import expenses while status is %/i,
    "Base payroll expense import SQL must also include the closed-batch guard.",
  );
  assert.match(
    downloadRouteSource,
    /"Gross Salary"/,
    "Payroll XLSX export must label the gross salary column correctly.",
  );
  assert.doesNotMatch(
    downloadRouteSource,
    /"Net Salary",\s*"Expenses \(Prev Month\)"/,
    "Payroll XLSX export must not label grossSalary as Net Salary.",
  );
  assert.match(
    downloadRouteSource,
    /assertPermission\(access, "payroll", "export"\)/,
    "Payroll XLSX download must assert export permission.",
  );
  assert.match(
    payslipRouteSource,
    /assertPermission\(access, "payslips", "read"\)/,
    "Payslip route must assert payslips read permission.",
  );
  assert.match(
    payslipRouteSource,
    /payslips_not_published/,
    "Payslip route must block draft payroll batches.",
  );
  assert.doesNotMatch(
    payslipRouteSource,
    /Status:\s*<strong>Posted<\/strong>/,
    "Payslip route must not hardcode the status as Posted.",
  );
  assert.match(
    employeePortalServiceSource,
    /\.in\("salary_batches\.status",\s*\["approved",\s*"locked"\]\)/,
    "Employee portal payslip query must only expose approved or locked batches.",
  );
  assert.match(
    uploadRouteSource,
    /findSalaryBatchForPeriod\(month, year\)/,
    "Payroll upload route must check for an existing batch in the selected period.",
  );
  assert.match(
    uploadRouteSource,
    /payroll_period_conflict/,
    "Payroll upload route must return a duplicate-period conflict.",
  );
  assert.match(
    uploadRouteSource,
    /empty_salary_upload/,
    "Payroll upload route must reject empty salary files.",
  );
  assert.match(
    validateRouteSource,
    /periodConflict/,
    "Payroll validation route must return duplicate-period metadata for the UI warning.",
  );
  assert.match(
    payrollDashboardSource,
    /Replace existing upload/,
    "Payroll UI must present a replace action for duplicate editable periods.",
  );
  assert.match(
    payrollDashboardSource,
    /Choose Replace existing upload or Cancel before continuing/,
    "Payroll UI must block normal confirmation while a duplicate-period decision is pending.",
  );
  assert.match(
    payrollServiceSource,
    /assertSalaryBatchDeletable/,
    "Payroll service must guard destructive delete actions by batch status.",
  );
  assert.match(
    expensesImportRouteSource,
    /isPayrollConflictError/,
    "Expense import route must map closed-payroll conflicts to HTTP 409.",
  );
  assert.match(
    expensesSource,
    /new PayrollConflictError\(message\)/,
    "Expense import service must surface closed-payroll RPC errors as payroll conflicts.",
  );
}
