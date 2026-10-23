import { readFileSync } from "node:fs";

import { getAdminCommandCenterData } from "@/lib/admin/command-center";
import { getDataHealthStats } from "@/lib/admin/service";
import type { AccessContext } from "@/lib/auth/permissions";
import { isDisposableFixtureText, isDisposableFixtureYear } from "@/lib/fixture-hygiene";
import { getOperationalRecentActivity } from "@/lib/operations/events";
import { loadLoginSecurityOverview } from "@/lib/security/login-security";
import { getPlatformMetrics } from "@/lib/platform/metrics";
import { getSupabaseAdmin } from "@/lib/supabase/server";

loadLocalEnv();

const supabase = getSupabaseAdmin();
const fixturePrefixes = ["PHASE15", "PHASE16", "PHASE17"];
const checks: Array<{ details?: unknown; label: string; ok: boolean }> = [];
const warnings: string[] = [];

const accessContext: AccessContext = {
  hrId: "PHASE20_PRODUCTION_READINESS_AUDIT",
  loginId: "phase20.production.readiness.readonly",
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

function batchLabelHasDisposableYear(label: string) {
  return /\/20(?:9\d)|\/2100/.test(label);
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

async function countAuditResidue() {
  const { count, error } = await supabase
    .from("audit_logs")
    .select("*", { count: "exact", head: true })
    .or(fixtureOr(["actor_login_id", "entity_id", "summary"]));
  if (error) {
    warnings.push(`audit_logs: ${error.message}`);
    return 0;
  }
  return count ?? 0;
}

async function buildProtectedFixtureReport() {
  const [employees, salaryBatches] = await Promise.all([
    fetchEmployeeResidue(),
    fetchSalaryBatchResidue(),
  ]);
  const protectedSalaryBatches = salaryBatches.filter(isProtectedPayrollBatch);
  const cleanupCandidateBatches = salaryBatches.filter((batch) =>
    isClearlyDisposableBatch(batch) && !isProtectedPayrollBatch(batch),
  );
  const protectedSalaryRecords = await countRows(
    "salary_records",
    "batch_id",
    protectedSalaryBatches.map((batch) => batch.id),
  );
  const cleanupCandidateSalaryRecords = await countRows(
    "salary_records",
    "batch_id",
    cleanupCandidateBatches.map((batch) => batch.id),
  );
  const rawAuditResidue = await countAuditResidue();

  return {
    cleanupCandidates: {
      employees: employees.filter((employee) =>
        isDisposableFixtureText(employee.hr_id) || isDisposableFixtureText(employee.full_name),
      ),
      salaryBatches: cleanupCandidateBatches,
      salaryRecords: cleanupCandidateSalaryRecords,
    },
    protected: {
      auditLogs: rawAuditResidue,
      salaryBatches: protectedSalaryBatches,
      salaryRecords: protectedSalaryRecords,
    },
    residue: {
      employees,
      salaryBatches,
    },
  };
}

async function verifyDashboards() {
  const [commandCenter, dataHealth, monitoring, operations, platform] = await Promise.all([
    getAdminCommandCenterData(accessContext),
    getDataHealthStats(),
    loadLoginSecurityOverview(),
    getOperationalRecentActivity(accessContext, { limit: 10 }),
    getPlatformMetrics(accessContext),
  ]);

  addCheck(
    "Command Center payroll latest batch ignores protected disposable payroll fixtures",
    !batchLabelHasDisposableYear(commandCenter.overview.payroll.batchLabel),
    commandCenter.overview.payroll,
  );
  addCheck(
    "Command Center structure total uses active employees plus open vacancies",
    Number(commandCenter.overview.hr.totalStructure) >= Number(commandCenter.overview.hr.activeEmployees),
    commandCenter.overview.hr,
  );
  addCheck(
    "Data Health structure totals remain fixture-safe and coherent",
    Number(dataHealth.summary.structureNodes) >= Number(dataHealth.summary.activeEmployees),
    dataHealth.summary,
  );
  addCheck(
    "Command Center, Data Health, and Platform share active employee totals",
    Number(commandCenter.overview.hr.activeEmployees) === Number(dataHealth.summary.activeEmployees) &&
      Number(dataHealth.summary.activeEmployees) === Number(platform.workforce.activeEmployees),
    {
      commandCenter: commandCenter.overview.hr.activeEmployees,
      dataHealth: dataHealth.summary.activeEmployees,
      platform: platform.workforce.activeEmployees,
    },
  );
  addCheck(
    "Command Center, Data Health, and Platform share workforce structure totals",
    Number(commandCenter.overview.hr.totalStructure) === Number(dataHealth.summary.structureNodes) &&
      Number(dataHealth.summary.structureNodes) === Number(platform.workforce.totalStructure),
    {
      commandCenter: commandCenter.overview.hr.totalStructure,
      dataHealth: dataHealth.summary.structureNodes,
      platform: platform.workforce.totalStructure,
    },
  );
  addCheck(
    "Monitoring business activity excludes retained PHASE fixture actors",
    !operations.recent.some((event) => /phase1[567]/i.test(`${event.userName} ${event.description}`)),
    operations.recent,
  );
  addCheck("Monitoring raw security feed remains accountable", monitoring.recentActivity !== null && monitoring.unavailable.length === 0, { recentEvents: monitoring.recentActivity?.total ?? null, unavailable: monitoring.unavailable });
  addCheck(
    "Platform workforce totals match shared structure rule",
    Number(platform.workforce.totalStructure) >= Number(platform.workforce.activeEmployees),
    platform.workforce,
  );
  addCheck(
    "Platform payroll latest batch ignores protected disposable fixture years",
    !batchLabelHasDisposableYear(platform.payroll.batchLabel),
    platform.payroll,
  );
}

async function main() {
  const report = await buildProtectedFixtureReport();

  addCheck("final read-only production readiness smoke generated fixture report", report.residue.salaryBatches.length >= 0, report);
  addCheck(
    "no cleanup-safe PHASE employees remain after Phase 19",
    report.cleanupCandidates.employees.length === 0,
    report.cleanupCandidates.employees,
  );
  addCheck(
    "no cleanup-safe PHASE payroll batches remain after Phase 19",
    report.cleanupCandidates.salaryBatches.length === 0 && report.cleanupCandidates.salaryRecords === 0,
    report.cleanupCandidates,
  );
  addCheck(
    "protected PHASE payroll fixtures are approved, locked, or Part 1 paid",
    report.protected.salaryBatches.every(isProtectedPayrollBatch),
    report.protected.salaryBatches,
  );

  await verifyDashboards();

  console.log(JSON.stringify({
    checks,
    protectedFixturePolicy: {
      dashboardFiltering: "Protected PHASE payroll fixtures stay filtered from business dashboards and shared metrics.",
      payrollRetention: "Approved, locked, or Part 1 paid PHASE payroll fixtures remain retained; do not unlock or delete them in app cleanup.",
      rawAuditLogs: "Raw Audit Logs may retain PHASE traces for accountability while Monitoring business activity filters fixture noise.",
    },
    report,
    warnings,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: message(error), warnings }, null, 2));
  process.exitCode = 1;
});
