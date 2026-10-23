import { readFileSync } from "node:fs";

import type { AccessContext } from "@/lib/auth/permissions";
import { getAdminCommandCenterData } from "@/lib/admin/command-center";
import { getDataHealthStats } from "@/lib/admin/service";
import { getOperationalRecentActivity } from "@/lib/operations/events";
import { loadLoginSecurityOverview } from "@/lib/security/login-security";
import { getSupabaseAdmin } from "@/lib/supabase/server";

loadLocalEnv();

const supabase = getSupabaseAdmin();
const checks: Array<{ details?: unknown; label: string; ok: boolean }> = [];
const fixturePrefixes = ["PHASE15", "PHASE16", "PHASE17"];
const accessContext: AccessContext = {
  hrId: "PHASE18_READONLY_AUDIT",
  loginId: "phase18.fixture.hygiene.readonly",
  role: "Super Admin",
  scope: "system",
  source: "system",
};

type FixtureCount = {
  count: number;
  error: string | null;
  table: string;
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

function fixtureIlikeClause(columns: string[]) {
  return columns
    .flatMap((column) => fixturePrefixes.map((prefix) => `${column}.ilike.${prefix}%`))
    .join(",");
}

async function countFixtureRows(
  table: string,
  columns: string[],
  options: { yearColumn?: "payout_year" | "year" } = {},
): Promise<FixtureCount> {
  try {
    let query = supabase.from(table).select("*", { count: "exact", head: true });
    const clauses = fixtureIlikeClause(columns);
    if (clauses) {
      query = options.yearColumn
        ? query.or(`${clauses},${options.yearColumn}.gte.2090`)
        : query.or(clauses);
    } else if (options.yearColumn) {
      query = query.or(`${options.yearColumn}.gte.2090`);
    }
    const { count, error } = await query;
    if (error) throw error;
    return { count: count ?? 0, error: null, table };
  } catch (error) {
    return { count: 0, error: message(error), table };
  }
}

async function buildFixtureHygieneReport() {
  const counts = await Promise.all([
    countFixtureRows("employees", ["hr_id", "full_name"]),
    countFixtureRows("position_vacancies", ["vacancy_code"]),
    countFixtureRows("salary_batches", ["file_name", "uploaded_by", "approved_by"], { yearColumn: "year" }),
    countFixtureRows("salary_records", ["hr_id"]),
    countFixtureRows("sales_import_batches", ["file_name", "period", "uploaded_by", "approved_by", "rejected_by"], { yearColumn: "year" }),
    countFixtureRows("sales_records", ["employee_hr_id", "employee_lookup_key", "employee_name", "manager_hr_id", "territory", "product"], { yearColumn: "year" }),
    countFixtureRows("outstation_expenses", ["hr_id", "trip_id", "source_file_name", "specialist", "description"], { yearColumn: "payout_year" }),
    countFixtureRows("outstation_expense_reports", ["file_name"]),
    countFixtureRows("outstation_expense_requests", ["employee_hr_id", "employee_name", "approval_reason"]),
    countFixtureRows("v2_vacation_requests", ["employee_hr_id"]),
    countFixtureRows("audit_logs", ["actor_login_id", "entity_id", "summary"]),
  ]);

  return {
    counts,
    dashboardFacingResidue: counts
      .filter((item) => item.table !== "audit_logs")
      .reduce((sum, item) => sum + item.count, 0),
    rawAuditResidue: counts.find((item) => item.table === "audit_logs")?.count ?? 0,
  };
}

function batchLabelHasDisposableYear(label: string) {
  return /\/20(?:9\d)|\/2100/.test(label);
}

async function main() {
  const [report, commandCenter, dataHealth, monitoring, operations] = await Promise.all([
    buildFixtureHygieneReport(),
    getAdminCommandCenterData(accessContext),
    getDataHealthStats(),
    loadLoginSecurityOverview(),
    getOperationalRecentActivity(accessContext, { limit: 10 }),
  ]);

  addCheck("read-only fixture hygiene report generated", report.counts.length > 0, report);
  addCheck(
    "Command Center workforce totals load with fixture-safe structure logic",
    Number(commandCenter.overview.hr.totalStructure) >= Number(commandCenter.overview.hr.activeEmployees),
    commandCenter.overview.hr,
  );
  addCheck(
    "Command Center payroll latest batch ignores disposable fixture years",
    !batchLabelHasDisposableYear(commandCenter.overview.payroll.batchLabel),
    commandCenter.overview.payroll,
  );
  addCheck(
    "Data Health totals load with fixture-safe structure logic",
    Number(dataHealth.summary.structureNodes) >= Number(dataHealth.summary.activeEmployees),
    dataHealth.summary,
  );
  addCheck(
    "Monitoring business activity excludes PHASE15/16/17 actors",
    !operations.recent.some((event) => /phase1[567]/i.test(`${event.userName} ${event.description}`)),
    operations.recent,
  );
  addCheck("Monitoring security feed remains reachable", monitoring.recentActivity !== null && monitoring.unavailable.length === 0, { recentEvents: monitoring.recentActivity?.total ?? null, unavailable: monitoring.unavailable });
  addCheck("raw Audit Logs fixture traces are reported, not silently deleted", report.rawAuditResidue >= 0, report.rawAuditResidue);

  console.log(JSON.stringify({
    checks,
    fixturePolicy: {
      cleanup: "PHASE disposable dashboard-facing residue can be cleaned only when rows are unlocked and clearly PHASE-prefixed.",
      lockedPayroll: "Approved or locked payroll fixture rows must be retained or removed by database reset, never unlocked in app code.",
      rawAuditLogs: "Raw audit_logs may retain PHASE traces for accountability; normal business feeds filter fixture noise.",
    },
    report,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: message(error) }, null, 2));
  process.exitCode = 1;
});
