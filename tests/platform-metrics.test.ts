import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canReadCompanyAttendanceAggregates,
  canReadCompanyRecruitmentAggregates,
  buildCompanyWorkforceAggregateMetrics,
  canReadCompanyWorkforceAggregates,
} from "../src/lib/platform/metrics.ts";

export function runPlatformMetricsTests() {
  assert.equal(
    canReadCompanyWorkforceAggregates({ role: "CEO", scope: "company", source: "session" }),
    true,
    "CEO must be allowed to read company-level workforce aggregates without employee-master access",
  );
  assert.equal(
    canReadCompanyWorkforceAggregates({ role: "Employee", scope: "self", source: "session" }),
    false,
    "self-scoped employees must not read company-level workforce aggregates",
  );
  assert.equal(
    canReadCompanyAttendanceAggregates({ role: "CEO", scope: "company", source: "session" }),
    true,
    "CEO must be allowed to read company-level attendance aggregates without employee-master access",
  );
  assert.equal(
    canReadCompanyRecruitmentAggregates({ role: "CEO", scope: "company", source: "session" }),
    true,
    "CEO must have the safe recruitment aggregate pattern while HR workflow routes remain blocked",
  );
  const ceoWorkforce = buildCompanyWorkforceAggregateMetrics({
    employees: [
      { areaName: "Cairo", employmentStatus: "active", fullName: "Alpha", hrId: "A-1", lineName: "Line 1", managerHrId: "AA" },
      { areaName: "Giza", employmentStatus: "on_leave", fullName: "Beta", hrId: "A-2", lineName: "Line 1", managerHrId: "AA" },
      { areaName: "Cairo", employmentStatus: "inactive", fullName: "Gamma", hrId: "A-3", lineName: "Line 2", managerHrId: "AA" },
    ],
    lookups: {
      workforceVacancies: [{ vacancyCode: "VAC-1" }],
    },
  });
  assert.equal(ceoWorkforce.activeEmployees, 2, "CEO aggregate workforce metrics must count active/on-leave employees");
  assert.equal(ceoWorkforce.totalEmployees, 3, "CEO aggregate workforce metrics must count company employees");
  assert.equal(ceoWorkforce.totalStructure, 3, "CEO aggregate workforce metrics must expose non-zero structure when employees exist");

  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(platformSource, /export async function getPlatformMetrics/);
  assert.match(platformSource, /export function canReadCompanyWorkforceAggregates/);
  assert.match(platformSource, /export function canReadCompanyAttendanceAggregates/);
  assert.match(platformSource, /export function canReadCompanyRecruitmentAggregates/);
  assert.match(platformSource, /const canReadEmployeeMaster = await canAccess\(accessContext, "employees", "read"\)/);
  assert.match(platformSource, /const canReadCompanyAggregates = canReadCompanyWorkforceAggregates\(accessContext\)/);
  assert.match(platformSource, /const canReadCompanyAggregates = canReadCompanyAttendanceAggregates\(accessContext\)/);
  assert.match(platformSource, /const canReadCompanyAggregates = canReadCompanyRecruitmentAggregates\(accessContext\)/);
  assert.match(platformSource, /buildCompanyWorkforceAggregateMetrics\(metricDirectory\)/);
  assert.match(platformSource, /getEmployeeDirectory/);
  assert.match(platformSource, /getPayrollDashboard/);
  assert.match(platformSource, /getSalesPlatformMetrics/);
  assert.match(platformSource, /getPayrollExpenseMetrics/);
  assert.match(platformSource, /getOfferDashboard/);
  assert.match(platformSource, /getHiringDocumentsDashboard/);
  assert.match(platformSource, /buildRecruitmentOnboardingMetrics/);
  assert.match(platformSource, /getContractRenewalDashboardData/);
  assert.match(platformSource, /calculateWorkforceStructureSummary/);

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  assert.match(commandCenterSource, /getPlatformMetrics/);
  assert.match(commandCenterSource, /platformMetrics\.workforce\.totalStructure/);
  assert.match(commandCenterSource, /platformMetrics\.sales\.salesValue/);
  assert.match(commandCenterSource, /platformMetrics\.payroll\.net/);
  assert.match(commandCenterSource, /platformMetrics\.expenses\.approvedAmount/);

  const dataHealthSource = readFileSync("src/lib/admin/service.ts", "utf8");
  assert.match(dataHealthSource, /const businessVacancyRows = vacancyRows\.filter/);
  assert.match(dataHealthSource, /const openVacancyRows = businessVacancyRows\.filter/);
  assert.match(dataHealthSource, /vacancies: openVacancyRows\.map\(vacancySignalFromRow\)/);
  assert.match(dataHealthSource, /const vacancyAudit = openVacancyRows\.map/);
  assert.doesNotMatch(dataHealthSource, /openVacancies: vacancyRows\.length/);

  const overviewSource = readFileSync("src/lib/overview/service.ts", "utf8");
  assert.match(overviewSource, /getPlatformMetrics/);
  assert.match(overviewSource, /platformMetrics\.workforce\.activeEmployees/);
  assert.match(overviewSource, /platformMetrics\.sales\.salesValue/);
  assert.match(overviewSource, /platformMetrics\.payroll\.net/);
  assert.match(overviewSource, /platformMetrics\.expenses\.approvedAmount/);
  assert.match(overviewSource, /platformMetrics\.recruitment\.acceptedOffers/);
  assert.match(overviewSource, /platformMetrics\.lifecycleRisk\.expiringContracts/);
  assert.doesNotMatch(overviewSource, /import \{ getOfferDashboard \}/);
}
