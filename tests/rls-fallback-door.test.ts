import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { normalizeHrId, normalizeHrIdForAccess } from "../src/lib/auth/permissions.ts";
import { keepExpenseRowsInScope } from "../src/lib/outstation/expenses.ts";

/**
 * Audit 2026-10-26, L10 — payroll and outstation reads fell back from the row-security client to
 * the service account in eleven hand-rolled `getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin()`
 * lines, silently, with only the query's own filter between a scoped viewer and every row.
 *
 * Now there is ONE door (`rowSecurityClientFor`), it logs the fall-back, and every scoped reader
 * behind it narrows its rows a second time in memory, so a regression in the query's filter fails
 * closed rather than open.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path.replace(/\\/g, "/"));
  }
  return out;
}

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing: ${signature}`);
  const next = source.slice(start + signature.length).search(/\n(export )?(async )?function /);
  return next < 0 ? source.slice(start) : source.slice(start, start + signature.length + next);
}

export function runRlsFallbackDoorTests() {
  // ---- One door, and no second hand-rolled one ---------------------------------------------------
  const door = readFileSync("src/lib/supabase/rls-server.ts", "utf8");
  const doorBody = bodyOf(door, "export async function rowSecurityClientFor(");
  assert.match(doorBody, /await getSupabaseRlsClientIfAvailable\(\)/, "the door prefers the person's row-security client");
  assert.match(doorBody, /logInfo\("rls_fallback_to_admin"/, "HEADLINE: the fall-back to the service account is logged, never silent");
  assert.match(doorBody, /reader/, "with the reader's name, so the log says which screen fell back");
  assert.match(doorBody, /FALLBACK_LOG_INTERVAL_MS/, "and throttled per reader, so it cannot flood the logs");

  const offenders = [...walk("src"), ...walk("app")].filter(
    (path) => path !== "src/lib/supabase/rls-server.ts" && /getSupabaseRlsClientIfAvailable/.test(readFileSync(path, "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    "HEADLINE: no file outside rls-server.ts hand-rolls the row-security fall-back — use rowSecurityClientFor",
  );

  // ---- Each of the eleven readers goes through the door under its own name ----------------------
  const readers: Array<[string, string, string]> = [
    ["src/lib/payroll/service.ts", "export async function listSalaryBatches(", "payroll.listSalaryBatches"],
    ["src/lib/payroll/service.ts", "export async function getLatestSalaryRecordsBefore(", "payroll.getLatestSalaryRecordsBefore"],
    ["src/lib/payroll/service.ts", "export async function getLatestSalaryExpenseTotalsBefore(", "payroll.getLatestSalaryExpenseTotalsBefore"],
    ["src/lib/payroll/service.ts", "export async function getPayrollDashboard(", "payroll.getPayrollDashboard"],
    ["src/lib/payroll/service.ts", "export async function getSalaryBatchExport(", "payroll.getSalaryBatchExport"],
    ["src/lib/outstation/expenses.ts", "export async function listPayrollExpenseReports(", "outstation.listPayrollExpenseReports"],
    ["src/lib/outstation/expenses.ts", "export async function withLiveExpenseReportCounts(", "outstation.withLiveExpenseReportCounts"],
    ["src/lib/outstation/expenses.ts", "export async function listPayrollExpenses(", "outstation.listPayrollExpenses"],
    ["src/lib/outstation/expenses.ts", "export async function listOutstationRequestExpenses(", "outstation.listOutstationRequestExpenses"],
    ["src/lib/outstation/expenses.ts", "export async function getApprovedExpenseTotalsForPayroll(", "outstation.getApprovedExpenseTotalsForPayroll"],
    ["src/lib/outstation/claims-read.ts", "export async function listExpenseClaims(", "outstation.listExpenseClaims"],
  ];
  for (const [path, signature, reader] of readers) {
    const body = bodyOf(readFileSync(path, "utf8"), signature);
    assert.match(body, new RegExp(`rowSecurityClientFor\\("${reader.replace(".", "\\.")}"\\)`), `${reader} goes through the door`);
  }

  // ---- Every scoped reader narrows its rows a second time ---------------------------------------
  const payroll = readFileSync("src/lib/payroll/service.ts", "utf8");
  for (const signature of [
    "export async function getLatestSalaryRecordsBefore(",
    "export async function getLatestSalaryExpenseTotalsBefore(",
  ]) {
    const body = bodyOf(payroll, signature);
    assert.match(body, /accessContext: AccessContext/, `${signature} takes the viewer's access`);
    assert.match(body, /filterPayrollRowsByAccess\(/, `HEADLINE: ${signature} narrows the rows it returns to that access`);
  }
  for (const signature of ["export async function getPayrollDashboard(", "export async function getSalaryBatchExport("]) {
    assert.match(bodyOf(payroll, signature), /filterPayrollRowsByAccess\(/, `${signature} still narrows its rows`);
  }
  assert.match(
    readFileSync("src/lib/payroll/copilot/service.ts", "utf8"),
    /getLatestSalaryRecordsBefore\(period\.month, period\.year, systemAccessContext\)/,
    "the copilot assembles the whole company's draft, so it reads the prior month as the system",
  );
  assert.match(
    readFileSync("app/api/payroll/template/route.ts", "utf8"),
    /getLatestSalaryExpenseTotalsBefore\(month, year, accessContext\)/,
    "the payroll template passes the person's own access",
  );

  const expenses = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  for (const [signature, column] of [
    ["async function getVisibleExpenseReportIds(", "hr_id"],
    ["export async function listPayrollExpenses(", "hr_id"],
    ["export async function listOutstationRequestExpenses(", "employee_hr_id"],
    ["export async function getApprovedExpenseTotalsForPayroll(", "hr_id"],
  ]) {
    assert.match(
      bodyOf(expenses, signature),
      new RegExp(`keepExpenseRowsInScope\\([\\s\\S]*?accessFilter, "${column}"\\)`),
      `HEADLINE: ${signature} narrows the rows it returns on ${column}`,
    );
  }
  assert.match(
    bodyOf(expenses, "async function getVisibleExpenseReportIds("),
    /\.select\("report_id,hr_id"\)/,
    "the report-id read carries the HR id it is narrowed on",
  );
  assert.match(
    bodyOf(readFileSync("src/lib/outstation/claims-read.ts", "utf8"), "export async function listExpenseClaims("),
    /keepExpenseRowsInScope\([\s\S]*?accessFilter, "employee_hr_id"\)/,
    "HEADLINE: listExpenseClaims narrows the rows it returns on employee_hr_id",
  );

  // ---- keepExpenseRowsInScope: fails closed, and never drops a row the query was meant to return --
  const scoped = { all: false, allowedHrIds: new Set(["B-10"]) };
  const rows = [
    { id: 1, hr_id: "B-10" },
    { id: 2, hr_id: "b-10" },
    { id: 3, hr_id: " B-10 " },
    { id: 4, hr_id: "B10" },
    { id: 5, hr_id: "A-12" },
    { id: 6, hr_id: null },
    { id: 7, hr_id: "" },
  ];
  const kept = keepExpenseRowsInScope(rows, scoped, "hr_id").map((row) => row.id);
  assert.ok(!kept.includes(5), "HEADLINE: a row of a person outside the viewer's scope is dropped");
  assert.ok(!kept.includes(6) && !kept.includes(7), "and a row with no HR id is dropped");
  assert.ok(kept.includes(1) && kept.includes(2) && kept.includes(3), "every spelling of the viewer's own id is kept");

  // Superset of the query: the query matches `ilike` (case-insensitive equality) on these forms.
  const queryForms = new Set(
    ["B-10"].flatMap((id) => [normalizeHrId(id), normalizeHrIdForAccess(id)]).filter(Boolean).map((id) => String(id).toLowerCase()),
  );
  for (const row of rows) {
    if (row.hr_id && queryForms.has(row.hr_id.toLowerCase())) {
      assert.ok(kept.includes(row.id), `a row the query returns (${row.hr_id}) is never dropped — this is money on the payroll path`);
    }
  }

  assert.deepEqual(keepExpenseRowsInScope(rows, { all: true, allowedHrIds: new Set() }, "hr_id"), rows, "a company-wide viewer keeps every row");
  assert.deepEqual(
    keepExpenseRowsInScope(rows, { all: false, allowedHrIds: new Set(["   "]) }, "hr_id"),
    [],
    "HEADLINE: an allowed id that normalises to nothing — where the query filter returned EVERY row — now keeps none",
  );
  assert.deepEqual(
    keepExpenseRowsInScope([{ employee_hr_id: "B-10" }, { employee_hr_id: "A-12" }], scoped, "employee_hr_id"),
    [{ employee_hr_id: "B-10" }],
    "the request and claim tables are narrowed on their own column",
  );
}
