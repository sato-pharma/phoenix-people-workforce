import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  for (const path of [
    "src/lib/automated-payroll/recommend.ts",
    "src/lib/automated-payroll/assemble.ts",
    "src/lib/automated-payroll/split.ts",
    "src/lib/automated-payroll/leaver-basis.ts",
  ]) {
    assert.ok(
      !readFileSync(path, "utf8").includes("continuous-service"),
      `HEADLINE: ${path} must not read continuous service — payroll puts a person in a month by employees.hire_date, and 17 Aug on PD-0039 paid her October twice`,
    );
  }

  // ---- Her portal reads through the link ----------------------------------------------------------
  const portal = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  assert.match(portal, /async function fetchPortalPayslips\(hrId: string\)[\s\S]*?ownAndEarlierRecordHrIds\(hrId\)/, "the payslip list reads her earlier record too");
  assert.match(portal, /hireDate: continuousServiceStartDate\(employee\.hrId, employee\.hireDate\)/, "the portal's Hire date is her service start");
  const payroll = readFileSync("src/lib/payroll/service.ts", "utf8");
  assert.match(payroll, /payrollScope === "SELF"[\s\S]{0,400}ownAndEarlierRecordHrIds\(currentHrId\)/, "she may open a payslip paid under her earlier record");
  const vacation = readFileSync("src/lib/vacation/service.ts", "utf8");
  assert.match(vacation, /if \(accessOwnsVacationHrId\(access, request\.employeeHrId\)\) return true;/, "her earlier record's leave is her own");
}
