import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase18FixtureHygieneTests() {
  const fixtureHygieneSource = readFileSync("src/lib/fixture-hygiene.ts", "utf8");
  const payrollServiceSource = readFileSync("src/lib/payroll/service.ts", "utf8");
  const payrollExpensesSource = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  const salesServiceSource = readFileSync("src/lib/sales/service.ts", "utf8");
  const adminServiceSource = readFileSync("src/lib/admin/service.ts", "utf8");
  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  const operationsSource = readFileSync("src/lib/operations/events.ts", "utf8");
  const phase18SmokeSource = readFileSync("scripts/phase18-fixture-hygiene-smoke.ts", "utf8");

  assert.match(fixtureHygieneSource, /DISPOSABLE_FIXTURE_YEAR_MIN = 2090/);
  assert.match(fixtureHygieneSource, /isDisposableFixtureText/);
  assert.match(fixtureHygieneSource, /isDisposablePayrollBatchRow/);
  assert.match(fixtureHygieneSource, /isDisposableSalesBatchRow/);
  assert.match(fixtureHygieneSource, /isDisposableSalesRecordRow/);
  assert.match(fixtureHygieneSource, /isDisposableExpenseRow/);
  assert.match(fixtureHygieneSource, /isDisposableExpenseReportRow/);

  assert.match(payrollServiceSource, /isDisposablePayrollBatchRow/);
  assert.match(payrollServiceSource, /\.filter\(\(row\) => !isDisposablePayrollBatchRow/);
  assert.match(payrollExpensesSource, /isDisposableExpenseRow/);
  assert.match(payrollExpensesSource, /isDisposableExpenseReportRow/);
  assert.match(salesServiceSource, /isDisposableSalesBatchRow/);
  assert.match(salesServiceSource, /isDisposableSalesRecordRow/);
  // businessSalesRows left with the sales-ownership classification of the retired Data Health page.
  assert.match(adminServiceSource, /businessVacationRows/);
  assert.match(commandCenterSource, /\.lt\("year", 2090\)/);
  assert.match(operationsSource, /@\/lib\/fixture-hygiene/);

  assert.match(phase18SmokeSource, /phase18\.fixture\.hygiene\.readonly/);
  assert.match(phase18SmokeSource, /buildFixtureHygieneReport/);
  assert.match(phase18SmokeSource, /raw Audit Logs fixture traces are reported, not silently deleted/);
  assert.match(phase18SmokeSource, /Approved or locked payroll fixture rows must be retained or removed by database reset/);
  assert.match(phase18SmokeSource, /getAdminCommandCenterData/);
  assert.match(phase18SmokeSource, /getDataHealthStats/);
  // The Monitoring aggregate retired on 23 Oct 2026; the security feed is read through the System
  // Audit's login-security loader now.
  assert.match(phase18SmokeSource, /loadLoginSecurityOverview/);
  assert.doesNotMatch(phase18SmokeSource, /getOperationalMonitoringStats/);
  assert.doesNotMatch(phase18SmokeSource, /\.delete\(/);
  assert.doesNotMatch(phase18SmokeSource, /\.update\(/);
  assert.doesNotMatch(phase18SmokeSource, /\.insert\(/);
  assert.doesNotMatch(phase18SmokeSource, /locked_at:\s*null|status:\s*"uploaded"/);
}
