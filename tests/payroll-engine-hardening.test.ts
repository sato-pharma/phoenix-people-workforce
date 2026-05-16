import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const baselineSource = readFileSync(
  new URL("../supabase/migrations/20260517000000_remote_app_baseline.sql", import.meta.url),
  "utf8",
);
const terminalVisibilityRollbackSource = readFileSync(
  new URL("../supabase/migrations/20260517020000_revert_terminal_employee_visibility_flags.sql", import.meta.url),
  "utf8",
);
const normalizedBaselineSource = baselineSource.replaceAll('"', "");

const migrationSource = normalizedBaselineSource;
const payrollTenMigrationSource = normalizedBaselineSource;
const payrollAdminDeleteMigrationSource = normalizedBaselineSource;
const payrollResignationCandidatesMigrationSource = normalizedBaselineSource;
const payrollMissingHrIdMigrationSource = normalizedBaselineSource;
const payslipUploadedSheetMigrationSource = normalizedBaselineSource;

const adminPayslipCenterSource = readFileSync(
  new URL("../app/admin/payslips-center/page.tsx", import.meta.url),
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

const resignationsReportSource = readFileSync(
  new URL("../src/components/reports/resignations-report.tsx", import.meta.url),
  "utf8",
);

const resignationsServiceSource = readFileSync(
  new URL("../src/lib/resignations/service.ts", import.meta.url),
  "utf8",
);

const payslipCenterSource = readFileSync(
  new URL("../src/lib/payroll/payslip-center.ts", import.meta.url),
  "utf8",
);

const payrollServiceSource = readFileSync(
  new URL("../src/lib/payroll/service.ts", import.meta.url),
  "utf8",
);

const templateRouteSource = readFileSync(
  new URL("../app/api/payroll/template/route.ts", import.meta.url),
  "utf8",
);

const uploadRouteSource = readFileSync(
  new URL("../app/api/payroll/upload/route.ts", import.meta.url),
  "utf8",
);

const replaceRouteSource = readFileSync(
  new URL("../app/api/payroll/[id]/replace/route.ts", import.meta.url),
  "utf8",
);

const validateRouteSource = readFileSync(
  new URL("../app/api/payroll/validate/route.ts", import.meta.url),
  "utf8",
);

const salaryImportSource = readFileSync(
  new URL("../src/lib/payroll/salary-import.ts", import.meta.url),
  "utf8",
);

const salarySheetFieldsSource = readFileSync(
  new URL("../src/lib/payroll/salary-sheet-fields.ts", import.meta.url),
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
    /status not in \('uploaded', 'part1_ready', 'rejected'\)/i,
    "Payroll replacement RPC must block statuses after Part 1 starts.",
  );
  assert.match(
    migrationSource,
    /part1_paid_at is not null/i,
    "Payroll replacement and destructive actions must block after Part 1 is paid.",
  );
  assert.match(
    migrationSource,
    /v_batch\.month is distinct from p_expected_month/i,
    "Payroll replacement RPC must guard the payroll period.",
  );
  assert.match(
    migrationSource,
    /revoke all on function public\.phx_replace_salary_batch\(p_batch_id uuid, p_expected_month integer, p_expected_year integer, p_file_name text, p_uploaded_by text, p_records jsonb, p_flags jsonb, p_updated_at timestamp with time zone\) from public/i,
    "Payroll replacement RPC must not be callable by public, anon, or authenticated.",
  );
  assert.match(
    migrationSource,
    /grant all on function public\.phx_replace_salary_batch\(p_batch_id uuid, p_expected_month integer, p_expected_year integer, p_file_name text, p_uploaded_by text, p_records jsonb, p_flags jsonb, p_updated_at timestamp with time zone\) to service_role/i,
    "Payroll replacement RPC must be callable only by service_role.",
  );
  assert.match(
    payrollTenMigrationSource,
    /create or replace function public\.phx_create_salary_batch/i,
    "Payroll upload create RPC must exist.",
  );
  assert.match(
    payrollTenMigrationSource,
    /jsonb_array_length\(v_records\)\s*=\s*0/i,
    "Payroll create RPC must reject empty uploads before inserting a batch.",
  );
  assert.match(
    payrollTenMigrationSource,
    /create unique index salary_batches_year_month_unique_idx/i,
    "Payroll migration must add a unique period index covering all statuses.",
  );
  assert.match(
    payrollTenMigrationSource,
    /existing\.id is distinct from new\.id/i,
    "Payroll duplicate trigger must block every duplicate period.",
  );
  assert.doesNotMatch(
    payrollTenMigrationSource,
    /status <> 'rejected'/i,
    "Payroll duplicate guard must not allow rejected duplicate periods.",
  );
  assert.match(
    payrollTenMigrationSource,
    /revoke all on function public\.phx_create_salary_batch\(p_month integer, p_year integer, p_file_name text, p_uploaded_by text, p_records jsonb, p_flags jsonb, p_created_at timestamp with time zone\) from public/i,
    "Payroll create RPC must not be callable by public, anon, or authenticated.",
  );
  assert.match(
    payrollTenMigrationSource,
    /grant all on function public\.phx_create_salary_batch\(p_month integer, p_year integer, p_file_name text, p_uploaded_by text, p_records jsonb, p_flags jsonb, p_created_at timestamp with time zone\) to service_role/i,
    "Payroll create RPC must be callable only by service_role.",
  );
  assert.match(
    migrationSource,
    /jsonb_array_length\(v_records\)\s*=\s*0/i,
    "Payroll replacement RPC must reject empty replacement payloads before deleting old records.",
  );
  assert.match(
    payrollTenMigrationSource,
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
    "Payroll migration must include a direct table delete guard for closed batches.",
  );
  assert.match(
    payrollAdminDeleteMigrationSource,
    /create or replace function public\.phx_delete_salary_batch/i,
    "Payroll migration must add an explicit admin delete RPC for uploaded payroll sheets.",
  );
  assert.match(
    payrollAdminDeleteMigrationSource,
    /request\.phx_allow_salary_batch_delete/i,
    "Payroll admin delete RPC must use an explicit trigger bypass setting.",
  );
  assert.match(
    payrollAdminDeleteMigrationSource,
    /revoke all on function public\.phx_delete_salary_batch\(p_batch_id uuid\) from public/i,
    "Payroll admin delete RPC must not be callable by public, anon, or authenticated.",
  );
  assert.match(
    payrollAdminDeleteMigrationSource,
    /grant all on function public\.phx_delete_salary_batch\(p_batch_id uuid\) to service_role/i,
    "Payroll admin delete RPC must be callable only by service_role.",
  );
  assert.match(
    payrollResignationCandidatesMigrationSource,
    /create table if not exists public\.payroll_resignation_candidates/i,
    "Payroll missing employee candidates must have a persisted resignation-report table.",
  );
  assert.match(
    payrollResignationCandidatesMigrationSource,
    /employee_name text not null[\s\S]*area_name text[\s\S]*hire_date date[\s\S]*last_payout_month integer not null[\s\S]*last_payout_year integer not null/i,
    "Payroll resignation candidate table must preserve name, area, hire date, and last payout period.",
  );
  assert.match(
    payrollResignationCandidatesMigrationSource,
    /alter table public\.payroll_resignation_candidates enable row level security/i,
    "Payroll resignation candidate table must enable RLS.",
  );
  assert.match(
    payrollResignationCandidatesMigrationSource,
    /to service_role[\s\S]*using \(true\)[\s\S]*with check \(true\)/i,
    "Payroll resignation candidate table must only expose writes through service-role workflows.",
  );
  assert.match(
    payrollMissingHrIdMigrationSource,
    /create table if not exists public\.salary_records/i,
    "Payroll salary records must allow uploaded historical HR IDs that are no longer in employees.",
  );
  assert.match(
    payrollMissingHrIdMigrationSource,
    /create table if not exists public\.salary_flags/i,
    "Payroll warning flags must allow missing-directory HR IDs.",
  );
  assert.doesNotMatch(
    payrollMissingHrIdMigrationSource,
    /salary_records_hr_id_fkey|salary_flags_hr_id_fkey/i,
    "Payroll historical HR ID handling must not restore employee-directory foreign keys on salary tables.",
  );
  assert.match(
    migrationSource,
    /Payroll batch cannot import expenses before Part 1 is paid or while status is %/i,
    "Payroll expense import RPC must block imports before the Part 2 window.",
  );
  assert.match(
    migrationSource,
    /second_part = coalesce\(sr\.second_part, 0\) - coalesce\(sr\.expenses, 0\) \+ coalesce\(at\.approved_expense, 0\)/i,
    "Expense import must move expense changes into Second Part.",
  );
  assert.match(
    payslipUploadedSheetMigrationSource,
    /create table if not exists public\.salary_records[\s\S]*base_salary numeric[\s\S]*governmental_deductions numeric[\s\S]*month_salary numeric[\s\S]*payment_mode text/i,
    "Payroll payslips must persist every new uploaded-sheet field needed for the canonical template.",
  );
  assert.match(
    payslipUploadedSheetMigrationSource,
    /create or replace function public\.phx_create_salary_batch[\s\S]*base_salary[\s\S]*governmental_deductions[\s\S]*month_salary[\s\S]*payment_mode/i,
    "Payroll create RPC must insert the persisted uploaded-sheet fields.",
  );
  assert.match(
    payslipUploadedSheetMigrationSource,
    /create or replace function public\.phx_replace_salary_batch[\s\S]*base_salary[\s\S]*governmental_deductions[\s\S]*month_salary[\s\S]*payment_mode/i,
    "Payroll replace RPC must insert the persisted uploaded-sheet fields.",
  );
  assert.match(
    payslipUploadedSheetMigrationSource,
    /month_salary = coalesce\(sr\.month_salary/i,
    "Expense import must keep Month Salary aligned when expenses update Second Part.",
  );
  assert.match(
    payslipUploadedSheetMigrationSource,
    /grant all on function public\.phx_create_salary_batch\(p_month integer, p_year integer, p_file_name text, p_uploaded_by text, p_records jsonb, p_flags jsonb, p_created_at timestamp with time zone\) to service_role/i,
    "Updated payroll create RPC must stay service-role only.",
  );
  assert.match(
    payslipUploadedSheetMigrationSource,
    /grant all on function public\.phx_replace_salary_batch\(p_batch_id uuid, p_expected_month integer, p_expected_year integer, p_file_name text, p_uploaded_by text, p_records jsonb, p_flags jsonb, p_updated_at timestamp with time zone\) to service_role/i,
    "Updated payroll replace RPC must stay service-role only.",
  );
  assert.match(
    downloadRouteSource,
    /payrollSheetHeaders/,
    "Payroll XLSX export must use the same canonical headers as the upload template.",
  );
  assert.match(
    downloadRouteSource,
    /payrollSheetValue/,
    "Payroll XLSX export rows must be generated from canonical uploaded-sheet fields.",
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
  assert.doesNotMatch(
    payslipRouteSource,
    /Monthly Uploaded Payroll Sheet/,
    "Payslip route must not render the raw monthly uploaded payroll sheet heading.",
  );
  assert.doesNotMatch(
    payslipRouteSource,
    /Every field below matches/,
    "Payslip route must not render the raw upload-sheet explanatory sentence.",
  );
  assert.doesNotMatch(
    payslipRouteSource,
    /payrollSheetHeaders\.length\} headers|36 headers/,
    "Payslip route must not render the upload template header count.",
  );
  assert.doesNotMatch(
    payslipRouteSource,
    /Print \/ Save PDF/,
    "Payslip route must not render the print/save toolbar button.",
  );
  assert.match(
    payslipRouteSource,
    /payslipHiddenHeaders[\s\S]*"Policy Comment"/,
    "Payslip route must hide Policy Comment from the displayed detail table.",
  );
  assert.match(
    payslipRouteSource,
    /payslipDisplayHeaders = payrollSheetHeaders\.filter\(\(header\) => !payslipHiddenHeaders\.has\(header\)\)/,
    "Payslip route must derive display headers from the canonical payroll sheet headers.",
  );
  assert.match(
    payslipRouteSource,
    /payrollSheetHeaders/,
    "Payslip route must keep the canonical uploaded payroll sheet order for displayed payroll values.",
  );
  assert.match(
    payslipRouteSource,
    /payrollSheetValue/,
    "Payslip route values must come from the same canonical uploaded-sheet mapping.",
  );
  assert.match(
    payslipRouteSource,
    /<thead><tr><th>Component<\/th><th>Amount \/ Value<\/th><\/tr><\/thead>/,
    "Payslip route must render only Component and Amount / Value columns.",
  );
  assert.match(
    payslipRouteSource,
    /total-additions-row/,
    "Payslip route must give Total Additions a dedicated styling hook.",
  );
  assert.match(
    payslipRouteSource,
    /governmental-deductions-row/,
    "Payslip route must give Governmental Deductions a dedicated styling hook.",
  );
  assert.match(
    payslipRouteSource,
    /total-deductions-row/,
    "Payslip route must give Total Deductions a dedicated styling hook.",
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
    salaryImportSource,
    /payrollResignationCandidates/,
    "Payroll validation must surface missing-directory rows as resignation report candidates.",
  );
  assert.match(
    validateRouteSource,
    /upsertPayrollResignationCandidates/,
    "Payroll validation route must send missing employee rows to the resignation report candidate table.",
  );
  assert.match(
    uploadRouteSource,
    /upsertPayrollResignationCandidates/,
    "Payroll upload route must send missing employee rows to the resignation report candidate table before returning validation errors.",
  );
  assert.match(
    uploadRouteSource,
    /warning\)\s*=>\s*warning\.code !== "employee_not_found"/,
    "Payroll upload route must not persist missing-directory HR IDs as governance warning flags.",
  );
  assert.match(
    replaceRouteSource,
    /upsertPayrollResignationCandidates/,
    "Payroll replace route must send missing employee rows to the resignation report candidate table before returning validation errors.",
  );
  assert.match(
    replaceRouteSource,
    /warning\)\s*=>\s*warning\.code !== "employee_not_found"/,
    "Payroll replace route must not persist missing-directory HR IDs as governance warning flags.",
  );
  assert.match(
    payrollDashboardSource,
    /Resignation alarm:/,
    "Payroll validation UI must render missing-directory HR IDs as a resignation alarm.",
  );
  assert.match(
    payrollDashboardSource,
    /issue\.code !== "employee_not_found"/,
    "Payroll validation UI must exclude resignation alarms from normal warnings.",
  );
  assert.match(
    payrollDashboardSource,
    /readPayrollApiPayload/,
    "Payroll UI must use defensive API response parsing so non-JSON failures do not become generic upload errors.",
  );
  assert.doesNotMatch(
    payrollDashboardSource,
    /response\.json\(\)/,
    "Payroll UI must not parse API responses directly with response.json().",
  );
  assert.doesNotMatch(
    payrollDashboardSource,
    /setSalaryUploadError\("Unable to confirm payroll upload\."\)/,
    "Payroll upload confirm must preserve the underlying request or API error message.",
  );
  assert.match(
    resignationsServiceSource,
    /payroll_resignation_candidates/,
    "Resignation dashboard service must load payroll missing employee candidates.",
  );
  assert.match(
    resignationsReportSource,
    /Payroll Missing Employee Candidates/,
    "Resignation report UI must render payroll missing employee candidates.",
  );
  assert.match(
    payrollDashboardSource,
    /Replace existing upload/,
    "Payroll UI must present a replace action for duplicate editable periods.",
  );
  assert.match(
    payrollDashboardSource,
    /template\?upload=1&month=\$\{payrollMonth\}&year=\$\{payrollYear\}/,
    "Payroll upload template download must use the selected payroll period.",
  );
  assert.match(
    payrollDashboardSource,
    /Choose Replace existing upload or Cancel before continuing/,
    "Payroll UI must block normal confirmation while a duplicate-period decision is pending.",
  );
  assert.match(
    payrollDashboardSource,
    /Confirm Part 1 Paid/,
    "Payroll UI must expose the Part 1 paid stage.",
  );
  assert.match(
    payrollDashboardSource,
    /Mark Part 2 Ready/,
    "Payroll UI must expose the Part 2 ready stage.",
  );
  assert.match(
    payrollServiceSource,
    /part1PaidSalaryBatchStatuses/,
    "Payroll service must know which statuses mean Part 1 is locked.",
  );
  assert.match(
    payrollServiceSource,
    /"phx_delete_salary_batch"/,
    "Payroll service must use the explicit admin delete RPC for uploaded payroll sheets.",
  );
  assert.match(
    payrollServiceSource,
    /"phx_create_salary_batch"/,
    "Payroll service must use the atomic create RPC for first-time uploads.",
  );
  assert.match(
    terminalVisibilityRollbackSource,
    /update public\.employees\s+set[\s\S]*payroll_eligible = true,[\s\S]*organogram_visible = true/i,
    "Terminal employee visibility rollback must restore payroll and organogram flags.",
  );
  assert.match(
    terminalVisibilityRollbackSource,
    /create or replace function public\.phx_restore_terminal_employee_visibility\(\)/i,
    "Terminal employee visibility rollback must guard future writes from forcing those flags off again.",
  );
  assert.doesNotMatch(
    terminalVisibilityRollbackSource,
    /Terminal employees cannot be restored to organogram\/payroll visibility outside a governed workflow/i,
    "Terminal employee rollback must not keep the later trigger guard that blocks visibility restoration.",
  );
  assert.doesNotMatch(
    payrollServiceSource,
    /\.from\("salary_batches"\)\s*\.insert/,
    "Payroll service must not create first-time uploads with non-atomic batch inserts.",
  );
  assert.match(
    templateRouteSource,
    /resolveStandardSalaryAllowances/,
    "Ready payroll template must use the global standard allowance policy.",
  );
  assert.match(
    templateRouteSource,
    /Phoenix Salary Upload Policy/,
    "Payroll template must include the current salary policy reference sheet.",
  );
  assert.match(
    templateRouteSource,
    /"Base Salary"/,
    "Payroll upload template must include a Base Salary header.",
  );
  assert.match(
    templateRouteSource,
    /const headers = \[\.\.\.payrollSheetHeaders\]/,
    "Payroll upload template must put Month and Year at the start of each row.",
  );
  assert.match(
    salarySheetFieldsSource,
    /payrollSheetHeaders = \[\s*"#",\s*"Month",\s*"Year",\s*"HR_ID"[\s\S]*"Policy Comment"/,
    "Canonical payroll sheet headers must include every upload template column in order.",
  );
  assert.match(
    templateRouteSource,
    /"Gross Salary"/,
    "Payroll upload template must include a Gross Salary header.",
  );
  assert.match(
    templateRouteSource,
    /"Governmental Deductions"/,
    "Payroll upload template must separate governmental deductions from internal deductions.",
  );
  assert.match(
    templateRouteSource,
    /governmentalDeductions/,
    "Payroll upload template rows must populate governmental deductions.",
  );
  assert.match(
    templateRouteSource,
    /buildUploadRows/,
    "Payroll upload template must be populated from fixed employee salary data.",
  );
  assert.match(
    templateRouteSource,
    /createFallbackWorkbook\(await buildUploadRows\(month, year\), month, year\)/,
    "Payroll upload template download must include populated employee rows for the selected period.",
  );
  assert.match(
    templateRouteSource,
    /resolveStandardSalaryAllowances\(\{[\s\S]*month,[\s\S]*year,/,
    "Payroll upload template fixed allowances must be resolved for the selected period.",
  );
  assert.match(
    templateRouteSource,
    /Net Salary", "Base Salary \+ Extra Cost of Living \+ Fuel Allowance\./,
    "Payroll template must explain the fixed net salary formula.",
  );
  assert.match(
    templateRouteSource,
    /uploadTemplateSections/,
    "Payroll upload template must define colored section partitions.",
  );
  assert.match(
    templateRouteSource,
    /label: "Employee Data"/,
    "Payroll upload template must group employee data in its own section.",
  );
  assert.match(
    templateRouteSource,
    /label: "Additions"/,
    "Payroll upload template must group monthly additions in its own section.",
  );
  assert.match(
    templateRouteSource,
    /label: "Total Additions"/,
    "Payroll upload template must make total additions a separate darker section.",
  );
  assert.match(
    templateRouteSource,
    /label: "Governmental Deductions"/,
    "Payroll upload template must group governmental deductions separately.",
  );
  assert.match(
    templateRouteSource,
    /label: "Internal Deductions"/,
    "Payroll upload template must group internal deductions separately.",
  );
  assert.match(
    templateRouteSource,
    /label: "Total Deductions"/,
    "Payroll upload template must make total deductions a separate darker section.",
  );
  assert.match(
    templateRouteSource,
    /label: "Payment Split"/,
    "Payroll upload template must group month salary and part payments separately.",
  );
  assert.match(
    templateRouteSource,
    /writeUploadSectionRow/,
    "Payroll upload template must render a visible section row above the headers.",
  );
  assert.match(
    templateRouteSource,
    /stylePayrollDataCell/,
    "Payroll upload template must color body cells by section.",
  );
  assert.doesNotMatch(
    templateRouteSource,
    /employee\.extraCostOfLiving|employee\.fuelAllowance/,
    "Ready payroll template must not use raw employee allowance values.",
  );
  assert.match(
    payslipCenterSource,
    /\.in\("salary_batches\.status", publishedPayslipStatuses\)/,
    "Admin payslip center queries must filter to published payroll batches.",
  );
  assert.doesNotMatch(
    adminPayslipCenterSource,
    /status === "posted"/,
    "Admin payslip center must not depend on the obsolete posted status.",
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
