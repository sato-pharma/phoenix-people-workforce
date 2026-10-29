import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const migrationSource = readFileSync(
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260513100643_payroll_two_part_workflow.sql", import.meta.url),
  "utf8",
);

const payrollTenMigrationSource = readFileSync(
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260513091853_payroll_engine_10_10_hardening.sql", import.meta.url),
  "utf8",
);

const payrollAdminDeleteMigrationSource = readFileSync(
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260513154219_payroll_admin_delete_uploads.sql", import.meta.url),
  "utf8",
);

const payrollResignationCandidatesMigrationSource = readFileSync(
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260513180426_payroll_resignation_candidates.sql", import.meta.url),
  "utf8",
);

const payrollMissingHrIdMigrationSource = readFileSync(
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260513182207_payroll_salary_records_allow_missing_employee_hr_ids.sql", import.meta.url),
  "utf8",
);

const payslipUploadedSheetMigrationSource = readFileSync(
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260513184233_payroll_payslip_uploaded_sheet_fields.sql", import.meta.url),
  "utf8",
);

const adminPayslipCenterSource = readFileSync(
  new URL("../app/(admin)/admin/payslips-center/page.tsx", import.meta.url),
  "utf8",
);

const downloadRouteSource = readFileSync(
  new URL("../app/api/payroll/[id]/download/route.ts", import.meta.url),
  "utf8",
);

/**
 * The batch download's workbook moved out of the route into a domain module, so the two canonical
 * -header guarantees below are pinned HERE now. The guarantee is unchanged — the export must be
 * built from the same headers and the same value resolver as the upload template — only its
 * address is. The permission assertion stays on the route, which is where the gate still lives.
 */
const salaryBatchWorkbookSource = readFileSync(
  new URL("../src/lib/payroll/salary-batch-workbook.ts", import.meta.url),
  "utf8",
);

const employeePortalServiceSource = readFileSync(
  new URL("../src/lib/employee-portal/service.ts", import.meta.url),
  "utf8",
);

const expensesImportRouteSource = readFileSync(
  new URL("../app/api/admin/outstation/expenses/import/route.ts", import.meta.url),
  "utf8",
);

const expensesSource = readFileSync(
  new URL("../src/lib/outstation/expenses.ts", import.meta.url),
  "utf8",
);

const payslipRouteSource = readFileSync(
  new URL("../app/api/payroll/[id]/payslips/route.ts", import.meta.url),
  "utf8",
);

// The payslip DOCUMENT moved out of the route on 2026-09-05, when it was redrawn on the house
// identity and the PDF export stopped carrying a second, hand-drawn copy of it. The route now does
// permissions and record selection; everything about what the paper SAYS is in this module, so the
// assertions below that are about the document read it here.
const payslipDocumentSource = readFileSync(
  new URL("../src/lib/payroll/payslip-document.ts", import.meta.url),
  "utf8",
);

const payrollDashboardSource = readFileSync(
  new URL("../src/components/payroll/payroll-dashboard.tsx", import.meta.url),
  "utf8",
);

// The Resignations UI is a self-contained module directory since the 2026-08-10 rebuild (it was
// one 1,337-line src/components/reports/resignations-report.tsx). Concatenate it so these guards
// keep holding wherever inside the module a given string lives.
const resignationsUiDir = new URL("../src/components/resignations/", import.meta.url);
const resignationsReportSource = readdirSync(resignationsUiDir)
  .map((file) => readFileSync(new URL(file, resignationsUiDir), "utf8"))
  .join("\n");

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
    /revoke all on function public\.phx_replace_salary_batch\(uuid, integer, integer, text, text, jsonb, jsonb, timestamptz\) from public, anon, authenticated/i,
    "Payroll replacement RPC must not be callable by public, anon, or authenticated.",
  );
  assert.match(
    migrationSource,
    /grant execute on function public\.phx_replace_salary_batch\(uuid, integer, integer, text, text, jsonb, jsonb, timestamptz\) to service_role/i,
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
    /create unique index if not exists salary_batches_year_month_unique_idx/i,
    "Payroll migration must add a unique period index covering all statuses.",
  );
  assert.match(
    payrollTenMigrationSource,
    /Cannot enforce unique payroll periods while duplicate salary_batches rows exist/i,
    "Payroll migration must fail safely if historical duplicate periods exist.",
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
    /revoke all on function public\.phx_create_salary_batch\(integer, integer, text, text, jsonb, jsonb, timestamptz\) from public, anon, authenticated/i,
    "Payroll create RPC must not be callable by public, anon, or authenticated.",
  );
  assert.match(
    payrollTenMigrationSource,
    /grant execute on function public\.phx_create_salary_batch\(integer, integer, text, text, jsonb, jsonb, timestamptz\) to service_role/i,
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
    /revoke all on function public\.phx_delete_salary_batch\(uuid\) from public, anon, authenticated/i,
    "Payroll admin delete RPC must not be callable by public, anon, or authenticated.",
  );
  assert.match(
    payrollAdminDeleteMigrationSource,
    /grant execute on function public\.phx_delete_salary_batch\(uuid\) to service_role/i,
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
    /drop constraint if exists salary_records_hr_id_fkey/i,
    "Payroll salary records must allow uploaded historical HR IDs that are no longer in employees.",
  );
  assert.match(
    payrollMissingHrIdMigrationSource,
    /drop constraint if exists salary_flags_hr_id_fkey/i,
    "Payroll warning flags must allow missing-directory HR IDs.",
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
    /add column if not exists base_salary numeric[\s\S]*governmental_deductions numeric[\s\S]*month_salary numeric[\s\S]*payment_mode text/i,
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
    /grant execute on function public\.phx_create_salary_batch\(integer, integer, text, text, jsonb, jsonb, timestamptz\) to service_role/i,
    "Updated payroll create RPC must stay service-role only.",
  );
  assert.match(
    payslipUploadedSheetMigrationSource,
    /grant execute on function public\.phx_replace_salary_batch\(uuid, integer, integer, text, text, jsonb, jsonb, timestamptz\) to service_role/i,
    "Updated payroll replace RPC must stay service-role only.",
  );
  assert.match(
    salaryBatchWorkbookSource,
    /payrollSheetHeaders/,
    "Payroll XLSX export must use the same canonical headers as the upload template.",
  );
  assert.match(
    salaryBatchWorkbookSource,
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
  // ── what the paper says now lives in the document module ─────────────────────────────────────
  // Same intent as before the 2026-09-05 redesign, read from where the document actually is. The
  // three per-total CSS hooks became ONE `.sum` class, because the totals are no longer
  // colour-coded fills — they are a brand-blue rule above and below, set bold in Brand Deep, and a
  // separate hook per total existed only to give each its own colour.
  assert.match(
    payslipDocumentSource,
    /IDENTITY_HEADERS[\s\S]*"Policy Comment"/,
    "The payslip must keep Policy Comment out of the displayed detail tables.",
  );
  assert.match(
    payslipDocumentSource,
    /payrollSheetHeaders\s*\n?\s*\.slice\(section\.start - 1, section\.end\)\s*\n?\s*\.filter\(\(header\) => !IDENTITY_HEADERS\.has\(header\)\)/,
    "Displayed components must be derived from the canonical payroll sheet headers, minus the identity block.",
  );
  assert.match(
    payslipDocumentSource,
    /payrollSheetHeaders/,
    "The payslip must keep the canonical uploaded payroll sheet order for displayed payroll values.",
  );
  assert.match(
    payslipDocumentSource,
    /payrollSheetValue/,
    "Payslip values must come from the same canonical uploaded-sheet mapping.",
  );
  assert.match(
    payslipDocumentSource,
    /<th scope="col" class="num">Amount<\/th>/,
    "A component table carries only its heading and one Amount column.",
  );
  assert.match(
    payslipDocumentSource,
    /class="sum"/,
    "Total rows must keep a dedicated styling hook, so a total never reads as an ordinary line.",
  );
  assert.match(
    payslipDocumentSource,
    /\.cmp \.sum td \{[\s\S]*?border-top: \.5pt solid var\(--phx-doc-blue\)/,
    "…and that hook must be a RULE, not a fill — the ink rule allows one filled element and it is the zebra row.",
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
    /Payroll candidate/,
    "Resignation report UI must render payroll missing employee candidates inside the workflow queue.",
  );
  // Names, never codes: a payroll candidate has no HR id yet, and the system candidate id that used to
  // stand in for it is a code nobody reads. The row shows the name, job title and the payroll file it came from.
  assert.doesNotMatch(
    resignationsReportSource,
    /System resignation candidate ID|formatPayrollCandidateSystemId/,
    "Payroll missing employee candidates must not print the system candidate code.",
  );
  assert.match(
    resignationsReportSource,
    /candidate\.sourceFileName/,
    "Payroll missing employee candidates must say which payroll file they came from.",
  );
  assert.doesNotMatch(
    resignationsReportSource,
    /Payroll Missing Employee Candidates/,
    "Resignation report UI must not split payroll missing employee candidates into a separate table.",
  );
  assert.doesNotMatch(
    resignationsReportSource,
    /Match or create the employee HR ID/,
    "Payroll missing employee candidates must not ask HR to manually generate or match an HR ID before tracking.",
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
    /Salary Upload Policy/,
    "Payroll template must include the current salary policy reference sheet. The title lost its " +
      "\"Phoenix\" prefix when the pack moved onto the house document identity: that identity is the " +
      "COMPANY's (Sato Pharma), never the app's, so a company document does not carry the product " +
      "name. The sheet itself is unchanged — this pin is about it existing, not about the prefix.",
  );
  assert.match(
    templateRouteSource,
    /"Base Salary"/,
    "Payroll upload template must include a Base Salary header.",
  );
  assert.match(
    templateRouteSource,
    // The optional type annotation arrived 2026-09-04 with the col(header)
    // lookup that replaced ~40 hard-coded cell indices. What this pins is the
    // ORDER — canonical payroll headers first, the two bank columns appended —
    // never how the binding is declared. The annotation is allowed; the order
    // is not.
    /const headers(?::\s*PayrollTemplateHeader\[\])? = \[\.\.\.payrollSheetHeaders,\s*"Bank",\s*"Bank Account"\]/,
    "Payroll upload template must keep canonical payroll headers first, then append bank reference columns.",
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
