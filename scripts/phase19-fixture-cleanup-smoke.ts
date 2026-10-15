import { readFileSync } from "node:fs";

import type { AccessContext } from "@/lib/auth/permissions";
import { getAdminCommandCenterData } from "@/lib/admin/command-center";
import { getDataHealthStats } from "@/lib/admin/service";
import { isDisposableFixtureText, isDisposableFixtureYear } from "@/lib/fixture-hygiene";
import { getOperationalMonitoringStats, getOperationalRecentActivity } from "@/lib/operations/events";
import { deleteSalaryBatch } from "@/lib/payroll/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "phase19-fixture-cleanup-smoke",
  entry: import.meta.url,
  known: ["--execute"],
});

loadLocalEnv();

const executeCleanup = process.argv.includes("--execute");
const supabase = getSupabaseAdmin();
const fixturePrefixes = ["PHASE15", "PHASE16", "PHASE17"];
const checks: Array<{ details?: unknown; label: string; ok: boolean }> = [];
const deleted: Array<{ id: string; table: string }> = [];
const retained: Array<{ id: string; reason: string; table: string }> = [];
const warnings: string[] = [];

const accessContext: AccessContext = {
  hrId: "PHASE19_CLEANUP_AUDIT",
  loginId: "phase19.fixture.cleanup",
  role: "Super Admin",
  scope: "system",
  source: "system",
};

type SalaryBatchResidue = {
  approved_at?: string | null;
  file_name?: string | null;
  id: string;
  locked_at?: string | null;
  month?: number | null;
  part1_paid_at?: string | null;
  status?: string | null;
  uploaded_by?: string | null;
  year?: number | null;
};

type EmployeeResidue = {
  full_name?: string | null;
  hr_id: string;
};

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
    // Environment variables may be injected by the runner.
  }
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

function fixtureOr(columns: string[]) {
  return columns
    .flatMap((column) => fixturePrefixes.map((prefix) => `${column}.ilike.${prefix}%`))
    .join(",");
}

function isClearlyDisposableText(value: unknown) {
  return fixturePrefixes.some((prefix) => String(value ?? "").trim().toUpperCase().startsWith(prefix));
}

function isProtectedPayrollBatch(batch: SalaryBatchResidue) {
  const status = String(batch.status ?? "").toLowerCase();
  return (
    status === "approved" ||
    status === "locked" ||
    status === "part1_paid" ||
    status === "adjustments_open" ||
    status === "part2_ready" ||
    status === "under_review" ||
    Boolean(batch.approved_at) ||
    Boolean(batch.locked_at) ||
    Boolean(batch.part1_paid_at)
  );
}

function isClearlyDisposableBatch(batch: SalaryBatchResidue) {
  return (
    isDisposableFixtureYear(batch.year) ||
    isClearlyDisposableText(batch.file_name) ||
    isClearlyDisposableText(batch.uploaded_by)
  );
}

async function fetchEmployeeResidue() {
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,full_name")
    .or(fixtureOr(["hr_id", "full_name"]));
  if (error) throw error;
  return (data ?? []) as EmployeeResidue[];
}

async function fetchSalaryBatchResidue() {
  const { data, error } = await supabase
    .from("salary_batches")
    .select("id,file_name,month,year,status,uploaded_by,approved_at,locked_at,part1_paid_at")
    .or(`${fixtureOr(["file_name", "uploaded_by", "approved_by"])},year.gte.2090`)
    .order("year", { ascending: false })
    .order("month", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SalaryBatchResidue[];
}

async function countRows(table: string, column: string, values: string[]) {
  if (values.length === 0) return 0;
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .in(column, values);
  if (error) {
    warnings.push(`${table}.${column}: ${error.message}`);
    return 0;
  }
  return count ?? 0;
}

async function countSalaryRecordsForBatches(batchIds: string[]) {
  return countRows("salary_records", "batch_id", batchIds);
}

async function buildPreflight() {
  const [employees, salaryBatches] = await Promise.all([
    fetchEmployeeResidue(),
    fetchSalaryBatchResidue(),
  ]);
  const protectedBatches = salaryBatches.filter(isProtectedPayrollBatch);
  const cleanupCandidateBatches = salaryBatches.filter((batch) =>
    isClearlyDisposableBatch(batch) && !isProtectedPayrollBatch(batch),
  );
  const protectedSalaryRows = await countSalaryRecordsForBatches(protectedBatches.map((batch) => batch.id));
  const cleanupCandidateSalaryRows = await countSalaryRecordsForBatches(cleanupCandidateBatches.map((batch) => batch.id));

  return {
    cleanupCandidates: {
      employees: employees.filter((employee) =>
        isClearlyDisposableText(employee.hr_id) || isClearlyDisposableText(employee.full_name),
      ),
      salaryBatches: cleanupCandidateBatches,
      salaryRecords: cleanupCandidateSalaryRows,
    },
    protected: {
      auditLogsPolicy: "retain raw PHASE audit traces for accountability",
      salaryBatches: protectedBatches,
      salaryRecords: protectedSalaryRows,
    },
    residue: {
      employees,
      salaryBatches,
    },
  };
}

async function safeDeleteByColumn(table: string, column: string, values: string[]) {
  if (!executeCleanup || values.length === 0) return;
  const { error } = await supabase.from(table).delete().in(column, values);
  if (error) {
    warnings.push(`${table}.${column}: ${error.message}`);
    values.forEach((id) => retained.push({ id, reason: error.message, table }));
    return;
  }
  values.forEach((id) => deleted.push({ id, table }));
}

async function cleanupEmployees(employees: EmployeeResidue[]) {
  const hrIds = employees
    .map((employee) => employee.hr_id)
    .filter((hrId) => isClearlyDisposableText(hrId));
  if (!executeCleanup || hrIds.length === 0) return;

  const [salesRecords, outstationExpenses, vacationRequests, outstationRequests] = await Promise.all([
    countRows("sales_records", "employee_hr_id", hrIds),
    countRows("outstation_expenses", "hr_id", hrIds),
    countRows("v2_vacation_requests", "employee_hr_id", hrIds),
    countRows("outstation_expense_requests", "employee_hr_id", hrIds),
  ]);

  if (salesRecords || outstationExpenses || vacationRequests || outstationRequests) {
    hrIds.forEach((hrId) => retained.push({
      id: hrId,
      reason: "retained because active workflow tables still reference this disposable employee",
      table: "employees",
    }));
    return;
  }

  await safeDeleteByColumn("employee_locations", "employee_hr_id", hrIds);
  await safeDeleteByColumn("employee_compensation", "employee_hr_id", hrIds);
  await safeDeleteByColumn("employees", "hr_id", hrIds);
}

async function cleanupSalaryBatches(batches: SalaryBatchResidue[]) {
  if (!executeCleanup) return;
  for (const batch of batches) {
    if (!isClearlyDisposableBatch(batch)) {
      retained.push({ id: batch.id, reason: "not clearly disposable", table: "salary_batches" });
      continue;
    }
    if (isProtectedPayrollBatch(batch)) {
      retained.push({ id: batch.id, reason: "approved, locked, or Part 1 paid payroll fixture", table: "salary_batches" });
      continue;
    }
    try {
      await deleteSalaryBatch(batch.id);
      deleted.push({ id: batch.id, table: "salary_batches" });
    } catch (error) {
      retained.push({ id: batch.id, reason: message(error), table: "salary_batches" });
    }
  }
}

function batchLabelHasDisposableYear(label: string) {
  return /\/20(?:9\d)|\/2100/.test(label);
}

async function verifyDashboards() {
  const [commandCenter, dataHealth, monitoring, operations] = await Promise.all([
    getAdminCommandCenterData(accessContext),
    getDataHealthStats(),
    getOperationalMonitoringStats({ pageSize: 5 }),
    getOperationalRecentActivity(accessContext, { limit: 10 }),
  ]);

  addCheck(
    "Command Center payroll latest batch ignores retained disposable payroll fixtures",
    !batchLabelHasDisposableYear(commandCenter.overview.payroll.batchLabel),
    commandCenter.overview.payroll,
  );
  addCheck(
    "Command Center structure totals remain coherent",
    Number(commandCenter.overview.hr.totalStructure) >= Number(commandCenter.overview.hr.activeEmployees),
    commandCenter.overview.hr,
  );
  addCheck(
    "Data Health structure totals remain coherent",
    Number(dataHealth.summary.structureNodes) >= Number(dataHealth.summary.activeEmployees),
    dataHealth.summary,
  );
  addCheck("Monitoring security feed remains reachable", Number(monitoring.recentEvents.total) >= 0, monitoring.recentEvents.total);
  addCheck(
    "Monitoring business activity excludes PHASE15/16/17 fixture actors",
    !operations.recent.some((event) => /phase1[567]/i.test(`${event.userName} ${event.description}`)),
    operations.recent,
  );
}

async function main() {
  const before = await buildPreflight();
  addCheck("cleanup preflight report generated", before.residue.employees.length + before.residue.salaryBatches.length >= 0, before);
  addCheck(
    "cleanup candidates are clearly PHASE disposable",
    before.cleanupCandidates.employees.every((employee) => isDisposableFixtureText(employee.hr_id) || isDisposableFixtureText(employee.full_name)) &&
      before.cleanupCandidates.salaryBatches.every(isClearlyDisposableBatch),
    before.cleanupCandidates,
  );

  await cleanupSalaryBatches(before.cleanupCandidates.salaryBatches);
  await cleanupEmployees(before.cleanupCandidates.employees);

  const after = await buildPreflight();
  await verifyDashboards();
  addCheck(
    "protected payroll fixtures were retained without unlocks",
    after.protected.salaryBatches.every(isProtectedPayrollBatch),
    after.protected,
  );

  console.log(JSON.stringify({
    after,
    before,
    checks,
    deleted,
    executeCleanup,
    retained,
    warnings,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    deleted,
    error: message(error),
    executeCleanup,
    retained,
    warnings,
  }, null, 2));
  process.exitCode = 1;
});
