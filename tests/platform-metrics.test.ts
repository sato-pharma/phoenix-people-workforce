import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canReadCompanyAttendanceAggregates,
  canReadCompanyRecruitmentAggregates,
  buildCompanyWorkforceAggregateMetrics,
  canReadCompanyWorkforceAggregates,
  emptyPlatformMetrics,
} from "../src/lib/platform/metrics.ts";

/**
 * A RATE THAT WAS NEVER MEASURED IS `null`, NEVER A NUMBER.
 *
 * `emptyPlatformMetrics()` is what every section returns when its read THREW or when the viewer
 * holds no grant for it, and every one of these used to default to a clean `1` — a fabricated
 * 100%, the single most dangerous substitute, because it is both the figure a manager acts on and
 * the one he wants to see. The permission path is worse still: it appends nothing to
 * `dataUnavailable`, so a section nobody was allowed to read reached the CEO's page as 100% with
 * no notice anywhere on it.
 *
 * This reads the object rather than the source, so a `1` reintroduced anywhere in the chain fails
 * here rather than passing a regex that happens to still match.
 */
function testUnmeasuredRatesAreNullNotAFabricatedHundredPercent() {
  const empty = emptyPlatformMetrics();
  const rates: Array<[string, unknown]> = [
    ["attendance.mappingReadinessRate", empty.attendance.mappingReadinessRate],
    ["attendance.policyCoverageRate", empty.attendance.policyCoverageRate],
    ["communication.templateReadinessRate", empty.communication.templateReadinessRate],
    ["payroll.readinessRate", empty.payroll.readinessRate],
    ["recruitment.hiringDocumentReadinessRate", empty.recruitment.hiringDocumentReadinessRate],
    ["sales.achievementRate", empty.sales.achievementRate],
    ["sales.dataQualityRate", empty.sales.dataQualityRate],
    ["workforce.employeeHealthRate", empty.workforce.employeeHealthRate],
  ];
  for (const [name, value] of rates) {
    assert.equal(
      value,
      null,
      `an unmeasured rate must be null, never a number — emptyPlatformMetrics().${name} is ${String(value)}, which every surface renders as a real percentage nobody computed`,
    );
  }

  // Counts are the opposite case and must STAY 0: a zero count invites a look, where a null would
  // have to be threaded through every tile that adds two of them together.
  assert.equal(empty.workforce.totalEmployees, 0, "unmeasured COUNTS stay 0 — only rates go null");
  assert.equal(empty.payroll.net, 0, "unmeasured COUNTS stay 0 — only rates go null");

  // The rendering half. `pct()` on the CEO command centre is the one formatter these reach, and it
  // has to take the null rather than a number, or the type system permits the old default again.
  const ceoComponentSource = readFileSync("src/components/admin/ceo-command-center.tsx", "utf8");
  assert.match(
    ceoComponentSource,
    /function pct\(value: UncomputedRate\)/,
    "pct() must accept an uncomputed rate so an unmeasured one can print — instead of being spelled as a number",
  );
  assert.match(
    ceoComponentSource,
    /if \(value === null \|\| !Number\.isFinite\(value\)\) return "—";/,
    'pct() must return "—" for a rate that was never computed',
  );

  // And the one place that AGGREGATES them: averaging an unmeasured section as 0 would mark the
  // CEO's headline score down for a permission he does not hold.
  const ceoSource = readFileSync("src/lib/ceo/command-center.ts", "utf8");
  assert.match(
    ceoSource,
    /\.filter\(\(value\): value is number => value !== null\)/,
    "the CEO health score must average only the rates that were actually measured",
  );
  assert.doesNotMatch(
    ceoSource,
    /safeRate\(platformMetrics\?\.[a-zA-Z.]+ \?\? 0\)/,
    "a missing platform metric must fall back to null, never to a real-looking 0",
  );
}

export function runPlatformMetricsTests() {
  testUnmeasuredRatesAreNullNotAFabricatedHundredPercent();

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
  // The vacancy list and the sales-ownership classification that read position_vacancies left with
  // the retired Data Health page (23 Oct 2026). Vacant seats come from the shared workforce metrics.
  assert.match(dataHealthSource, /vacantPositions: sharedWorkforce\.openVacancies/);
  assert.doesNotMatch(dataHealthSource, /from\("position_vacancies"\)/);
  assert.doesNotMatch(dataHealthSource, /openVacancies: vacancyRows\.length/);

  const overviewSource = readFileSync("src/lib/overview/service.ts", "utf8");
  assert.match(overviewSource, /getPlatformMetrics/);
  assert.match(overviewSource, /platformMetrics\.workforce\.activeEmployees/);
  assert.match(overviewSource, /platformMetrics\.sales\.salesValue/);
  assert.match(overviewSource, /platformMetrics\.payroll\.net/);
  assert.match(overviewSource, /platformMetrics\.expenses\.approvedAmount/);
  assert.match(overviewSource, /platformMetrics\.lifecycleRisk\.expiringContracts/);
}
