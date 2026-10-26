import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildLifecycleRiskMetrics,
  calculateProbationProgress,
  classifyContractRenewalRisk,
  classifyProbationTrafficStatus,
  daysUntilLifecycleDate,
  isDateWithinLifecycleRiskWindow,
  probationEndDateFromHire,
  summarizeContractRenewalRows,
  summarizeProbationRiskRows,
} from "../src/lib/lifecycle-risk/metrics.ts";

export function runLifecycleRiskSourceTests() {
  const referenceDate = new Date("2026-05-18T12:00:00Z");

  assert.equal(daysUntilLifecycleDate("2026-05-18", referenceDate), 0);
  assert.equal(daysUntilLifecycleDate("2026-05-25", referenceDate), 7);
  assert.equal(isDateWithinLifecycleRiskWindow("2026-06-17", 30, referenceDate), true);
  assert.equal(isDateWithinLifecycleRiskWindow("2026-06-18", 30, referenceDate), false);
  assert.equal(probationEndDateFromHire("2026-01-01"), "2026-04-01");

  // Cairo/UTC day-boundary regression: startOfToday() must resolve "today" via Africa/Cairo,
  // not the server's own UTC clock. Cairo is ahead of UTC (EEST=+3 late Apr-late Oct,
  // EET=+2 otherwise), so for a few hours after Cairo's local midnight, the UTC clock is
  // still on the previous calendar day — the exact window the old `setHours(0,0,0,0)`
  // (server-local midnight) implementation got wrong.
  const eestBeforeCairoMidnight = new Date("2026-07-24T20:59:00Z"); // Cairo 23:59 Jul 24 (EEST)
  const eestAfterCairoMidnight = new Date("2026-07-24T21:00:00Z"); // Cairo 00:00 Jul 25 (EEST)
  assert.equal(
    daysUntilLifecycleDate("2026-07-25", eestBeforeCairoMidnight),
    1,
    "20:59 UTC (EEST): Cairo is still Jul 24, so Jul 25 is 1 day away",
  );
  assert.equal(
    daysUntilLifecycleDate("2026-07-25", eestAfterCairoMidnight),
    0,
    "21:00 UTC (EEST): Cairo has already rolled to Jul 25, so it's due today",
  );

  const eetBeforeCairoMidnight = new Date("2026-01-15T21:59:00Z"); // Cairo 23:59 Jan 15 (EET)
  const eetAfterCairoMidnight = new Date("2026-01-15T22:00:00Z"); // Cairo 00:00 Jan 16 (EET)
  assert.equal(
    daysUntilLifecycleDate("2026-01-16", eetBeforeCairoMidnight),
    1,
    "21:59 UTC (EET): Cairo is still Jan 15, so Jan 16 is 1 day away",
  );
  assert.equal(
    daysUntilLifecycleDate("2026-01-16", eetAfterCairoMidnight),
    0,
    "22:00 UTC (EET): Cairo has already rolled to Jan 16, so it's due today",
  );

  assert.equal(classifyContractRenewalRisk(null), "missing");
  assert.equal(classifyContractRenewalRisk(5), "critical");
  assert.equal(classifyContractRenewalRisk(20), "warning");
  assert.equal(classifyContractRenewalRisk(45), "upcoming");
  assert.equal(classifyContractRenewalRisk(90), "healthy");

  assert.equal(classifyProbationTrafficStatus(70), "safe");
  assert.equal(classifyProbationTrafficStatus(45), "warning");
  assert.equal(classifyProbationTrafficStatus(15), "critical");
  assert.equal(calculateProbationProgress(45), 50);

  assert.deepEqual(
    summarizeContractRenewalRows([
      { contractRenewalDate: "2026-05-22", workflowStatus: "requested" },
      { contractRenewalDate: "2026-06-10", workflowStatus: "manager_review" },
      { contractRenewalDate: "2026-07-01", workflowStatus: "renewed" },
    ], referenceDate),
    {
      activeRequests: 2,
      dueIn7Days: 1,
      dueIn30Days: 2,
      hrReview: 0,
      managerReview: 1,
      notRenewed: 0,
      renewed: 1,
      totalRenewals: 3,
      totalRequests: 3,
    },
  );

  assert.deepEqual(
    summarizeProbationRiskRows([
      { daysRemaining: 10, workflowDecision: null },
      { daysRemaining: 45, workflowDecision: null },
      { daysRemaining: 75, workflowDecision: "pass" },
    ]),
    {
      critical: 1,
      openWorkflows: 2,
      overdue: 0,
      safe: 0,
      total: 2,
      warning: 1,
    },
  );

  const metrics = buildLifecycleRiskMetrics({
    contracts: [
      {
        contractRenewalDate: "2026-05-28",
        employeeHrId: "E001",
        employeeName: "Contract Risk",
        workflowStatus: "hr_review",
      },
      {
        contractRenewalDate: "2026-07-01",
        employeeHrId: "E002",
        employeeName: "Future Contract",
        workflowStatus: null,
      },
    ],
    probations: [
      {
        daysRemaining: 10,
        employeeHrId: "E003",
        employeeName: "Probation Risk",
        probationEndDate: "2026-05-28",
        workflowDecision: null,
      },
      {
        daysRemaining: 5,
        employeeHrId: "E004",
        employeeName: "Completed Probation",
        probationEndDate: "2026-05-23",
        workflowDecision: "pass",
      },
    ],
    referenceDate,
  });
  assert.equal(metrics.expiringContracts, 1);
  assert.equal(metrics.probationEndings, 1);
  assert.equal(metrics.activeContractRenewalRequests, 1);
  assert.equal(metrics.probationWorkflowActions, 1);
  assert.deepEqual(metrics.alerts.map((alert) => alert.type), ["contract", "probation"]);

  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(platformSource, /buildLifecycleRiskMetrics/);
  assert.match(platformSource, /getProbationRows/);
  assert.doesNotMatch(platformSource, /function isFutureDateWithinDays/);

  const overviewSource = readFileSync("src/lib/overview/service.ts", "utf8");
  assert.match(overviewSource, /platformMetrics\.lifecycleRisk\.alerts/);
  assert.doesNotMatch(overviewSource, /riskAlerts\.push/);

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  assert.match(commandCenterSource, /buildLifecycleRiskMetrics/);
  assert.match(commandCenterSource, /platformMetrics\.lifecycleRisk\.expiringContracts/);

  const contractComponentSource = readFileSync("src/components/contracts/contract-renewal.tsx", "utf8");
  assert.match(contractComponentSource, /summarizeContractRenewalRows/);
  assert.match(contractComponentSource, /daysUntilLifecycleDate/);

  const probationComponentSource = readFileSync("src/components/probation/probation-tracker.tsx", "utf8");
  assert.match(probationComponentSource, /summarizeProbationRiskRows/);
  assert.match(probationComponentSource, /classifyProbationTrafficStatus/);
  assert.match(probationComponentSource, /calculateProbationProgress/);

  const employeePortalSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  assert.match(employeePortalSource, /resolveEmployeeLifecycleJourney/);
  assert.match(employeePortalSource, /probationEndDateFromHire/);
  assert.match(employeePortalSource, /lifecycleRiskWindows\.probationRiskDays/);
  assert.doesNotMatch(employeePortalSource, /nextContractAnniversary/);
}
