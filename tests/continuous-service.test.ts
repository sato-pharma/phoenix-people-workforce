import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import {
  continuousServiceStartDate,
  earlierRecordHrIds,
  ownAndEarlierRecordHrIds,
} from "../src/lib/employees/continuous-service.ts";
import {
  calculateVacationPayment,
  getVacationBalancePeriod,
  isWithinFirstSixMonths,
} from "../src/lib/vacation/calculations.ts";
import { resolveEmployeeLifecycleJourney } from "../src/lib/lifecycle-risk/metrics.ts";

/**
 * One person, two HR records (owner, 2026-11-05): Omayma Wael El Habashy resigned as AI-0009 on
 * 31 Oct 2026 and was re-hired as PD-0039 from 7 Nov. Her new account shows her earlier payslips and
 * vacations, and her leave counts from 17 Aug 2026 — while payroll keeps employees.hire_date.
 */
export function runContinuousServiceTests() {
  // ---- The link -----------------------------------------------------------------------------------
  assert.deepEqual(earlierRecordHrIds("PD-0039"), ["AI-0009"], "PD-0039's earlier record is AI-0009");
  assert.deepEqual(earlierRecordHrIds(" pd0039 "), ["AI-0009"], "matched on any casing and spacing of the id");
  assert.deepEqual(ownAndEarlierRecordHrIds("PD-0039"), ["PD-0039", "AI-0009"]);
  assert.deepEqual(earlierRecordHrIds("AI-0009"), [], "the link runs one way: the old record does not see the new one");
  assert.deepEqual(ownAndEarlierRecordHrIds("B-7"), ["B-7"], "everyone else is only themselves");
  assert.deepEqual(ownAndEarlierRecordHrIds(""), []);

  assert.equal(continuousServiceStartDate("PD-0039", "2026-11-07"), "2026-08-17", "HEADLINE: her service counts from 17 Aug");
  assert.equal(continuousServiceStartDate("B-7", "2025-03-01"), "2025-03-01", "an unlinked hire date is untouched");
  assert.equal(continuousServiceStartDate("B-7", null), null);
  assert.equal(continuousServiceStartDate("PD-0039", "2026-01-01"), "2026-01-01", "never moves a start LATER");

  // Ahmed Helal (owner, 2026-11-12): B-3 from 4 Mar 2023, resigned 9 Aug 2026, re-hired as CN-0013 on 1 Nov.
  assert.deepEqual(ownAndEarlierRecordHrIds("CN-0013"), ["CN-0013", "B-3"], "CN-0013's earlier record is B-3");
  assert.deepEqual(earlierRecordHrIds("B-3"), [], "B-3 does not see CN-0013");
  assert.equal(continuousServiceStartDate("CN-0013", "2026-11-01"), "2023-03-04", "HEADLINE: his leave counts from 4 Mar 2023");
  assert.deepEqual(
    getVacationBalancePeriod({ employeeHrId: "CN-0013", hireDate: "2026-11-01", referenceDate: "2026-11-12" }),
    { entitlementDays: 21, periodEnd: "2027-03-04", periodStart: "2026-03-04" },
    "HEADLINE: his leave year runs from his first record's anniversary with the full 21 days, not from 1 Nov with nothing",
  );
  assert.equal(
    isWithinFirstSixMonths({ employeeHrId: "CN-0013", hireDate: "2026-11-01", referenceDate: "2026-11-12" }),
    false,
    "he is not a first-six-months joiner",
  );

  // ---- Her balance, as the vacation module computes it (hire date read off the record: 7 Nov) ------
  const period = getVacationBalancePeriod({ employeeHrId: "PD-0039", hireDate: "2026-11-07", referenceDate: "2026-11-05" });
  assert.deepEqual(
    period,
    { entitlementDays: 2.5, periodEnd: "2027-08-17", periodStart: "2026-08-17" },
    "HEADLINE: two completed months from 17 Aug earn 2.5 days, in the year 17 Aug 2026 -> 17 Aug 2027",
  );
  assert.equal(
    getVacationBalancePeriod({ employeeHrId: "PD-0039", hireDate: "2026-11-07", referenceDate: "2026-11-17" })?.entitlementDays,
    3.75,
    "the third month completes on 17 Nov",
  );
  assert.deepEqual(
    getVacationBalancePeriod({ employeeHrId: "X-1", hireDate: "2026-11-07", referenceDate: "2026-11-05" }),
    { entitlementDays: 0, periodEnd: "2027-11-07", periodStart: "2026-11-07" },
    "control: the same hire date with no link counts from 7 Nov and has earned nothing",
  );

  assert.equal(isWithinFirstSixMonths({ employeeHrId: "PD-0039", hireDate: "2026-11-07", referenceDate: "2027-02-16" }), true);
  assert.equal(
    isWithinFirstSixMonths({ employeeHrId: "PD-0039", hireDate: "2026-11-07", referenceDate: "2027-02-17" }),
    false,
    "HEADLINE: her first six months end 17 Feb 2027, not 7 May 2027",
  );

  const priced = calculateVacationPayment({
    approvedPaidDaysInPeriod: 0,
    durationDays: 1,
    employeeHrId: "PD-0039",
    hireDate: "2026-11-07",
    startDate: "2027-03-01",
    vacationType: "annual",
  });
  assert.equal(priced.paymentStatus, "paid", "a March 2027 day is paid: she is past six months of service");
  assert.equal(priced.periodStart, "2026-08-17");

  // ---- Payroll never reads it ---------------------------------------------------------------------
  // Every file that pays, charges or puts a person in a payroll month, not four named ones: the list
  // of four missed payroll/service.ts the day it began importing the link. That one file may use it,
  // for the two id helpers only, and only to let her OPEN her earlier payslips — never to count her.
  const PAYROLL_DIRS = ["src/lib/automated-payroll", "src/lib/payroll", "src/lib/deductions"];
  const PAYROLL_SERVICE = "src/lib/payroll/service.ts";
  const payrollFiles = PAYROLL_DIRS.flatMap((dir) =>
    readdirSync(dir, { recursive: true })
      .map((entry) => `${dir}/${String(entry).replace(/\\/g, "/")}`)
      .filter((path) => /\.tsx?$/.test(path)),
  );
  assert.ok(payrollFiles.includes("src/lib/automated-payroll/recommend.ts"), "the walk reaches the population code");
  assert.ok(payrollFiles.includes(PAYROLL_SERVICE), "the walk reaches the payroll service");
  for (const path of payrollFiles) {
    if (path === PAYROLL_SERVICE) continue;
    assert.ok(
      !readFileSync(path, "utf8").includes("continuous-service"),
      `HEADLINE: ${path} must not read continuous service — payroll puts a person in a month by employees.hire_date, and 17 Aug on PD-0039 paid her October twice`,
    );
  }
  const payrollService = readFileSync(PAYROLL_SERVICE, "utf8");
  const linkImport = payrollService.match(/import \{([^}]*)\} from "@\/lib\/employees\/continuous-service(?:\.ts)?";/);
  assert.ok(linkImport, "the payroll service imports the link by name");
  assert.deepEqual(
    linkImport[1].split(",").map((name) => name.trim()).filter(Boolean).sort(),
    ["earlierRecordHrIds", "ownAndEarlierRecordHrIds"],
    "HEADLINE: the payroll service takes the two id helpers only — never continuousServiceStartDate",
  );
  const PAYROLL_ACCESS_FUNCTIONS = new Set(["resolvePayrollAccessFilter", "getSalaryBatchExport"]);
  const linkCalls = [...payrollService.matchAll(/\b(?:earlierRecordHrIds|ownAndEarlierRecordHrIds)\(/g)];
  assert.ok(linkCalls.length >= 2, "both access uses are found");
  for (const call of linkCalls) {
    const before = payrollService.slice(0, call.index);
    const enclosing = [...before.matchAll(/\bfunction\s+(\w+)\s*\(/g)].at(-1)?.[1] ?? "(top level)";
    assert.ok(
      PAYROLL_ACCESS_FUNCTIONS.has(enclosing),
      `HEADLINE: ${PAYROLL_SERVICE} uses the re-hire link inside ${enclosing} — only who may open a payslip may read it, never who is paid`,
    );
  }

  // ---- Her portal reads through the link ----------------------------------------------------------
  const portal = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  assert.match(portal, /async function fetchPortalPayslips\(hrId: string\)[\s\S]*?ownAndEarlierRecordHrIds\(hrId\)/, "the payslip list reads her earlier record too");
  assert.match(portal, /hireDate: continuousServiceStartDate\(employee\.hrId, employee\.hireDate\)/, "the portal's Hire date is her service start");
  // Her overview read "Employment duration 0 months" beside a Hire date of 17 Aug (6 Nov 2026): the
  // duration was counted from the new record's 7 Nov. It counts from her service start now; probation
  // and renewal stay on the new contract.
  assert.match(
    portal,
    /function computeEmploymentJourney\(employee: EmployeeDirectoryRow\)[\s\S]{0,700}continuousServiceStartDate\(employee\.hrId, employee\.hireDate\)[\s\S]{0,200}serviceDurationDays: resolveEmployeeLifecycleJourney\(\{ hireDate: serviceStart \}\)\.serviceDurationDays/,
    "HEADLINE: the portal's Employment duration counts from her service start, not the new record's hire date",
  );
  const onSixNov = new Date("2026-11-06T10:00:00Z");
  assert.equal(
    resolveEmployeeLifecycleJourney({ hireDate: continuousServiceStartDate("PD-0039", "2026-11-07") }, onSixNov).serviceDurationDays,
    81,
    "on 6 Nov she has served 81 days since 17 Aug",
  );
  assert.equal(
    resolveEmployeeLifecycleJourney({ hireDate: "2026-11-07" }, onSixNov).serviceDurationDays,
    0,
    "control: counted from the new record she reads 0, the defect he saw",
  );
  const payroll = readFileSync("src/lib/payroll/service.ts", "utf8");
  assert.match(payroll, /payrollScope === "SELF"[\s\S]{0,400}ownAndEarlierRecordHrIds\(currentHrId\)/, "she may open a payslip paid under her earlier record");
  const vacation = readFileSync("src/lib/vacation/service.ts", "utf8");
  assert.match(vacation, /if \(accessOwnsVacationHrId\(access, request\.employeeHrId\)\) return true;/, "her earlier record's leave is her own");
  assert.match(
    vacation,
    /async function getEmployeeAnnualLeaveBalanceDays[\s\S]{0,700}ownAndEarlierRecordHrIds\(employee\.hrId\)[\s\S]{0,700}ownAndEarlier\.some/,
    "the overview's leave left spends the leave she took under her earlier record",
  );

  // ---- Her Employee 360 and overview read her earlier record's field work (owner, 2026-11-05) ------
  const e360 = readFileSync("src/lib/employee-360/service.ts", "utf8");
  assert.match(
    e360,
    /async function fetchVisitRows[\s\S]{0,400}earlierRecordHrIds\(hrId\)[\s\S]{0,400}queryOwnVisitsOfDepartedAgents/,
    "HEADLINE: Employee 360's visits include the ones she logged as AI-0009 — the CRM door hides a departed record",
  );
  assert.match(
    e360,
    /async function fetchCheckinRows[\s\S]{0,700}earlierRecordHrIds\(hrId\)[\s\S]{0,400}queryOwnCheckinsOfDepartedAgents/,
    "Employee 360's check-ins include her earlier record's",
  );
  const reads = readFileSync("src/lib/crm/reads.ts", "utf8");
  assert.match(
    reads,
    /export async function queryOwnCheckinsOfDepartedAgents[\s\S]{0,1200}includeResignedAgents: true[\s\S]{0,400}selectOwnVisitsThroughLastWorkingDate/,
    "a departed record's check-ins stop at its last working day, like its visits",
  );
  const deep = readFileSync("src/lib/employee-360/deep-service.ts", "utf8");
  assert.match(
    deep,
    /async function getEmployeeCoaching[\s\S]{0,900}\.in\("medical_rep_hr_id", ownAndEarlierRecordHrIds\(hrId\)\.flatMap\(hrIdLookupKeys\)\)/,
    "her coaching reports under her earlier record are hers",
  );
  const salesStart = deep.indexOf("export async function getEmployeeSales(");
  const salesRead = deep.slice(salesStart, deep.indexOf("export function teamSalesUnreadable"));
  assert.ok(salesStart >= 0 && salesRead.length > 0, "getEmployeeSales is where this test expects it");
  assert.ok(
    !/ownAndEarlierRecordHrIds|earlierRecordHrIds\(/.test(salesRead),
    "HEADLINE (owner, 2026-11-05): her earlier record's SALES never show — they are another line's products",
  );
  const home = readFileSync("src/lib/employee-portal/home-snapshot.ts", "utf8");
  const homeSalesStart = home.indexOf("async function loadMrCanonicalSales(");
  assert.ok(homeSalesStart >= 0, "loadMrCanonicalSales is where this test expects it");
  assert.ok(
    !/earlierRecordHrIds|ownAndEarlierRecordHrIds/.test(home.slice(homeSalesStart, homeSalesStart + 6000)),
    "the overview's sales tile stays on her current record only",
  );
  assert.match(home, /withEarlierRecordDoubleVisits\(hrId,/, "the overview's double-visit pulse includes her earlier record's");
  assert.match(
    home,
    /async function loadMrFieldKpis[\s\S]{0,2000}for \(const earlierHrId of row \? \[\] : earlierRecordHrIds\(hrId\)\)[\s\S]{0,300}getKpisBoard\(\{ access: \{ \.\.\.access, hrId: earlierHrId \}, includeReports: false,/,
    "HEADLINE: a month with no row of her own scores her coverage on her earlier record — October read blank on PD-0039",
  );
  for (const page of [
    "app/employee-portals/employee-360/page.tsx",
    "app/employee-portals/employee-360/[hrId]/page.tsx",
    "app/(admin)/employee-360/[hrId]/page.tsx",
  ]) {
    assert.match(
      readFileSync(page, "utf8"),
      /hireDate: continuousServiceStartDate\(target\.hrId, target\.hireDate\) \?\? target\.hireDate/,
      `${page}: Employee 360 counts her tenure from 17 Aug`,
    );
  }
}
