import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

export function runPlatformMetricsTests() {
  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(platformSource, /export async function getPlatformMetrics/);
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
