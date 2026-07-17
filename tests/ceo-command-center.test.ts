import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import {
  buildCompanyWorkforceAggregateMetrics,
  canReadCompanyWorkforceAggregates,
} from "../src/lib/platform/metrics.ts";

export function runCeoCommandCenterTests() {
  // The CEO now lands on their dedicated, branded command center (was /sales).
  assert.equal(
    resolveLandingPathForRole("CEO"),
    "/admin/ceo-command-center",
    "CEO must land on the CEO Command Center",
  );
  // Landing normalizes case/whitespace, so variants resolve the same.
  assert.equal(resolveLandingPathForRole(" ceo "), "/admin/ceo-command-center");

  // Other roles' landings must be unchanged by this feature.
  assert.equal(resolveLandingPathForRole("Super Admin"), "/admin");
  assert.equal(
    resolveLandingPathForRole("Finance Manager"),
    "/admin/outstation/expense-command",
  );
  assert.equal(resolveLandingPathForRole("Employee"), "/employee-portals");
  assert.equal(resolveLandingPathForRole("Medical Rep"), "/employee-portals");

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  const ceoCommandCenterSource = readFileSync("src/lib/ceo/command-center.ts", "utf8");
  const ceoComponentSource = readFileSync("src/components/admin/ceo-command-center.tsx", "utf8");
  const ceoPhaseBSource = readFileSync("src/components/admin/ceo-phase-b.tsx", "utf8");
  const attendanceAnalyticsPageSource = readFileSync("app/(admin)/attendance/analytics/page.tsx", "utf8");
  const probationPageSource = readFileSync("app/(admin)/probation/page.tsx", "utf8");
  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(
    commandCenterSource,
    /activeEmployees: platformMetrics\.workforce\.activeEmployees/,
    "CEO Command Center HR cards must render shared platform workforce metrics",
  );
  assert.match(
    platformSource,
    /canReadCompanyWorkforceAggregates\(accessContext\)/,
    "CEO Command Center workforce metrics must use the CEO-safe aggregate path",
  );
  assert.match(
    ceoCommandCenterSource,
    /getPlatformMetrics\(access\)/,
    "Dedicated CEO Command Center must use shared platform metrics",
  );
  assert.match(
    ceoCommandCenterSource,
    /getContractRenewalDashboardData\(access\)/,
    "CEO contract risk must use the contract renewal dashboard service",
  );
  assert.match(
    ceoCommandCenterSource,
    /getCeoProbationCounts\(access\)/,
    "CEO probation risk must use the dedicated open-evaluation aggregate",
  );
  assert.match(ceoCommandCenterSource, /from\("probation_evaluations"\)/);
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /\.not\("decision"/,
    "CEO probation risk must not exclude null decisions with a PostgREST not-in filter",
  );
  assert.match(
    ceoCommandCenterSource,
    /getSalaryFlags\(\)/,
    "CEO salary flag signal must use the salary flag helper",
  );
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /from\("employee_contracts"\)/,
    "CEO contract risk must not query the empty employee_contracts table",
  );
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /from\("salary_batches"\)/,
    "CEO payroll signal must not raw-order salary_batches and pick fixture future years",
  );
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /health:\s*\{\s*salesLinkageRate:\s*0/,
    "CEO health metrics must not be hardcoded zero placeholders",
  );
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /trends:\s*\{\s*sales:\s*\[\],\s*financial:\s*\[\],\s*hireExit:\s*\[\]\s*\}/,
    "CEO trend metrics must not be hardcoded empty placeholders",
  );
  assert.match(ceoComponentSource, /const \{ attention, approvals, dataUnavailable, headcount, health, payroll, sos \} = data/);
  assert.match(ceoComponentSource, /Active employees/);
  assert.match(ceoComponentSource, /Total structure/);
  assert.match(ceoComponentSource, /Lookup-backed count/);
  assert.match(
    ceoCommandCenterSource,
    /const plansPending = pendingPlansR\.status === "fulfilled" \? pendingPlansR\.value : null/,
    "CEO weekly-plan failures must render unavailable instead of zero",
  );
  assert.match(
    ceoCommandCenterSource,
    /dataUnavailable\.push\("Pending weekly-plan approvals"\)/,
    "CEO fast path must surface pending-plan source failures",
  );
  assert.match(
    ceoCommandCenterSource,
    /dataUnavailable: Array\.from\(new Set\(dataUnavailable\)\)/,
    "CEO unavailable source metadata must be de-duplicated and returned",
  );
  assert.match(
    ceoCommandCenterSource,
    /href: "\/admin\/m-payroll"/,
    "CEO salary flag links must land on the CEO payroll console",
  );
  assert.match(
    ceoComponentSource,
    /<DataUnavailableNotice sources=\{visibleDataUnavailable\} \/>/,
    "CEO fast path must render unavailable-source warnings",
  );
  assert.match(
    ceoComponentSource,
    /const allClear = dataAvailable && visibleAttention\.length === 0 && totalApprovals === 0/,
    "CEO all-clear must be blocked while any source is unavailable",
  );
  assert.match(
    ceoComponentSource,
    /totalApprovals > 0 \|\| hasUnavailableApprovals/,
    "CEO approval counts must render unavailable values instead of hiding as zero",
  );
  assert.match(
    ceoPhaseBSource,
    /payroll\.net > 0 \|\| payroll\.gross > 0 \|\| payroll\.unresolvedSalaryFlags > 0/,
    "CEO Phase B must show payroll risk cards when only salary flags are present",
  );
  assert.match(
    ceoPhaseBSource,
    /RiskSourceWarning/,
    "CEO Phase B must render unavailable-source warnings",
  );
  assert.match(
    ceoPhaseBSource,
    /No risk cards can be declared clear while critical CEO sources are unavailable/,
    "CEO Phase B must not show no-risk language when critical sources fail",
  );
  assert.doesNotMatch(
    ceoPhaseBSource,
    /href: "\/payroll"/,
    "CEO Phase B smart navigation must not link to operational payroll",
  );
  assert.doesNotMatch(
    ceoPhaseBSource,
    /href: "\/sales\/weekly"/,
    "CEO Phase B smart navigation must not link to the redirecting weekly sales route",
  );
  assert.doesNotMatch(
    ceoPhaseBSource,
    /href: "\/sales\/monthly-dashboard"/,
    "CEO Phase B smart navigation must not link to the redirecting monthly sales route",
  );
  assert.match(ceoPhaseBSource, /SmartNavGrid access=\{access\} variant=\{variant\}/);
  assert.match(ceoPhaseBSource, /item\.href !== "\/employees" && item\.href !== "\/admin\/data-health"/);
  assert.match(attendanceAnalyticsPageSource, /canAccess\(access, "attendance", "read"\)/);
  assert.doesNotMatch(attendanceAnalyticsPageSource, /canAccess\(access, "employees", "read"\)/);
  assert.match(probationPageSource, /canReadAllProbation\(access\)/);
  assert.equal(
    canReadCompanyWorkforceAggregates({ role: "CEO", scope: "company", source: "session" }),
    true,
    "CEO must be allowed to read company workforce aggregates",
  );
  const workforce = buildCompanyWorkforceAggregateMetrics({
    employees: [
      { areaName: "Cairo", employmentStatus: "active", fullName: "Alpha", hrId: "A-1", lineName: "Line 1", managerHrId: "AA" },
      { areaName: "Giza", employmentStatus: "on_leave", fullName: "Beta", hrId: "A-2", lineName: "Line 1", managerHrId: "AA" },
    ],
    lookups: {
      workforceVacancies: [],
    },
  });
  assert.ok(
    workforce.activeEmployees > 0,
    "CEO Command Center must show non-zero workforce metrics when employees exist",
  );
}
