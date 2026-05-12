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

const payslipRouteSource = readFileSync(
  new URL("../app/api/payroll/[id]/payslips/route.ts", import.meta.url),
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
}
