import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  buildExecutiveDashboardSnapshotFromSources,
  EXECUTIVE_SNAPSHOT_HARD_TIMEOUT_MS,
  type ExecutiveDashboardSource,
} from "../src/lib/executive/dashboard-snapshot.ts";

const source = (
  sourceName: string,
  overrides: Partial<ExecutiveDashboardSource> = {},
): ExecutiveDashboardSource => ({
  asOf: "2026-06-02T08:00:00.000Z",
  authorizationScope: "company",
  durationMs: 12,
  sourceName,
  status: "available",
  unavailableReason: null,
  ...overrides,
});

function loaded(key: string, sourceName: string, metrics: Record<string, unknown>) {
  return {
    definition: { key, sourceName, rpc: `phx_exec_${key}_snapshot` },
    payload: { metrics, source: source(sourceName) },
    source: source(sourceName),
  };
}

export function runExecutiveDashboardSnapshotTests() {
  const access = createAccessContext({ hrId: "CEO-1", loginId: "ceo", role: "CEO" });
  const snapshot = buildExecutiveDashboardSnapshotFromSources({
    access,
    generatedAt: "2026-06-02T08:00:00.000Z",
    loadedSources: [
      loaded("workforce", "Employees", {
        activeEmployees: 7,
        employeesWithoutManagers: 1,
        healthyEmployees: 6,
        missingJobTitle: 0,
        totalEmployees: 8,
        totalStructure: 10,
        uniqueAreas: 2,
        uniqueLines: 3,
      }),
      loaded("vacancies", "Vacancies", { openVacancies: 3 }),
      loaded("payroll", "Payroll", {
        batchLabel: "5/2026",
        employees: 7,
        flags: 2,
        gross: 70000,
        net: 61000,
        payrollEligibleCount: 7,
      }),
      loaded("sales", "Sales", {
        achievementRate: 0.8,
        activeProducts: 4,
        dataQualityRate: 0.9,
        salesValue: 120000,
        targetValue: 150000,
      }),
      loaded("expenses", "Expenses", {
        approvedAmount: 4500,
        reportCount: 2,
        totalAmount: 6000,
        totalRows: 5,
      }),
      loaded("contracts", "Contracts", { contractsDueSoon: 1, expiringContracts: 2 }),
      loaded("probation", "Probation", { criticalProbation: 1, probationEndings: 2 }),
      loaded("recruitment", "Recruitment", {
        acceptanceRate: 0.5,
        acceptedOffers: 2,
        pendingOffers: 1,
        rejectedOffers: 1,
        totalOffers: 4,
      }),
      loaded("leave", "Leave", {
        approvedRequests: 3,
        managerDecisionActions: 2,
        overdueSla: 1,
        paidDays: 5,
        pendingRequests: 1,
        rejectedRequests: 1,
        totalRequests: 5,
        unpaidDays: 2,
      }),
      loaded("attendance", "Attendance", {
        activeMappings: 6,
        activePolicies: 1,
        currentMonthWorkingDays: 22,
        mappingReadinessRate: 0.75,
        missingDeviceMappings: 2,
        policyCoverageRate: 1,
        totalDeviceMappings: 8,
        totalPolicies: 1,
      }),
      loaded("operations", "Operational Health", {
        failureCount24h: 1,
        lastEventAt: "2026-06-02T07:55:00.000Z",
        staleSources: ["sales"],
        totalEvents24h: 9,
      }),
    ] as never,
  });

  assert.equal(snapshot.metrics.workforce.activeEmployees, 7, "active employees must match Employees source");
  assert.equal(snapshot.metrics.workforce.vacantPositions, 3, "open vacancies must match Vacancies source");
  assert.equal(snapshot.metrics.payroll.gross, 70000, "payroll gross must match Payroll source");
  assert.equal(snapshot.metrics.payroll.net, 61000, "payroll net must match Payroll source");
  assert.equal(snapshot.metrics.payroll.employees, 7, "payroll employees must match Payroll source");
  assert.equal(snapshot.metrics.payroll.flags, 2, "payroll flags must match Payroll source");
  assert.equal(snapshot.metrics.sales.salesValue, 120000, "sales value must match Sales source");
  assert.equal(snapshot.metrics.sales.targetValue, 150000, "target value must match Sales source");
  assert.equal(snapshot.metrics.sales.achievementRate, 0.8, "achievement must match Sales source");
  assert.equal(snapshot.metrics.expenses.approvedAmount, 4500, "approved expenses must match Expenses source");
  assert.equal(snapshot.metrics.expenses.totalAmount, 6000, "total expenses must match Expenses source");
  assert.equal(snapshot.metrics.expenses.reportCount, 2, "expense report count must match Expenses source");
  assert.equal(snapshot.metrics.risk.expiringContracts, 2, "contract risks must match Contracts source");
  assert.equal(snapshot.metrics.risk.probationEndings, 2, "probation risks must match Probation source");
  assert.equal(snapshot.data.overview.payroll.net, snapshot.metrics.payroll.net, "CEO view model must derive from snapshot");
  assert.equal(snapshot.brief.impact.revenue, snapshot.metrics.sales.salesValue, "CEO brief must derive from snapshot");
  assert.equal(snapshot.health.available, true, "health score must derive from snapshot coverage");
  assert.ok(snapshot.risk.rows.length > 0, "risk register must derive from snapshot");

  const broken = buildExecutiveDashboardSnapshotFromSources({
    access,
    generatedAt: "2026-06-02T08:00:00.000Z",
    loadedSources: [
      {
        definition: { key: "sales", sourceName: "Sales", rpc: "phx_exec_sales_snapshot" },
        payload: null,
        source: source("Sales", {
          asOf: null,
          status: "unavailable",
          unavailableReason: "Sales source timed out.",
        }),
      },
    ] as never,
  });
  assert.equal(broken.sources.sales.status, "unavailable");
  assert.ok(broken.dataUnavailable.includes("Sales source timed out."));
  assert.equal(broken.data.overview.sales.salesValue, 0, "fallback zero is paired with unavailable metadata");

  const pageSource = readFileSync("app/(admin)/admin/ceo-command-center/page.tsx", "utf8");
  assert.match(pageSource, /getExecutiveDashboardSnapshot\(access\)/, "CEO page must load one executive snapshot");
  assert.doesNotMatch(pageSource, /getAdminCommandCenterData\(access\)/, "CEO page must not call legacy admin aggregation");
  assert.doesNotMatch(pageSource, /getCeoBrief\(access\)/, "CEO page must not call brief aggregation separately");

  const briefSource = readFileSync("src/lib/ceo/brief.ts", "utf8");
  assert.doesNotMatch(briefSource, /getOverviewDashboard\(accessContext\)/, "CEO brief must not fan out to overview aggregation");
  assert.match(briefSource, /getExecutiveDashboardSnapshot\(accessContext\)/, "CEO brief wrapper must use canonical snapshot");

  const migration = readFileSync("supabase/migrations/20260602082351_executive_dashboard_snapshot.sql", "utf8");
  for (const name of [
    "phx_exec_workforce_snapshot",
    "phx_exec_vacancies_snapshot",
    "phx_exec_payroll_snapshot",
    "phx_exec_sales_snapshot",
    "phx_exec_expenses_snapshot",
    "phx_exec_contracts_snapshot",
    "phx_exec_probation_snapshot",
    "phx_exec_recruitment_snapshot",
    "phx_exec_leave_snapshot",
    "phx_exec_attendance_snapshot",
    "phx_exec_operations_snapshot",
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${name}`), `${name} RPC must exist`);
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\(text, text, text, text, text\\) to service_role`), `${name} must be service-role callable`);
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}\\(text, text, text, text, text\\) from public, anon, authenticated`), `${name} must not be exposed to anon/authenticated`);
  }
  assert.match(migration, /private\.phx_assert_executive_dashboard_viewer/, "RPCs must enforce viewer validation");
  assert.match(migration, /raise exception 'Executive dashboard snapshot is restricted/, "unauthorized viewers must be rejected inside SQL");

  const invalidation = readFileSync("src/lib/dashboard/invalidation.ts", "utf8");
  assert.match(invalidation, /revalidatePath\("\/admin\/ceo-command-center"\)/);
  for (const path of [
    "src/lib/employees/employee-directory.ts",
    "src/lib/payroll/service.ts",
    "src/lib/payroll/expenses.ts",
    "src/lib/sales/service.ts",
    "src/lib/contracts/service.ts",
    "src/lib/probation/service.ts",
    "src/lib/offers/service.ts",
    "src/lib/resignations/service.ts",
    "src/lib/vacation/service.ts",
  ]) {
    assert.match(readFileSync(path, "utf8"), /invalidateExecutiveDashboardCache\(/, `${path} must invalidate CEO/Admin dashboard refresh`);
  }

  assert.ok(EXECUTIVE_SNAPSHOT_HARD_TIMEOUT_MS >= 8000 && EXECUTIVE_SNAPSHOT_HARD_TIMEOUT_MS <= 10000);
}
