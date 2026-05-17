import assert from "node:assert/strict";

import {
  calculateFirstYearVacationEntitlement,
  calculateVacationDurationDays,
  calculateVacationPayment,
  getVacationBalancePeriod,
} from "../src/lib/vacation/calculations.ts";

export function runVacationCalculationTests() {
  assert.equal(
    calculateVacationDurationDays({
      dayPart: "full_day",
      endDate: "2026-05-17",
      startDate: "2026-05-14",
    }),
    2,
    "Vacation duration should exclude Friday and Saturday",
  );

  assert.equal(
    calculateVacationDurationDays({
      dayPart: "am_only",
      endDate: "2026-05-14",
      startDate: "2026-05-14",
    }),
    0.5,
    "AM only vacation should count as half a day",
  );

  assert.throws(
    () =>
      calculateVacationDurationDays({
        dayPart: "pm_only",
        endDate: "2026-05-17",
        startDate: "2026-05-14",
      }),
    /one date/,
    "Half-day vacations must be single-day requests",
  );

  assert.equal(
    calculateFirstYearVacationEntitlement("2026-04-01"),
    11.25,
    "April hires should receive 9 prorated months from a 15-day first-year balance",
  );

  assert.deepEqual(
    getVacationBalancePeriod({ hireDate: "2026-04-01", referenceDate: "2026-10-01" }),
    {
      entitlementDays: 11.25,
      periodEnd: "2027-04-01",
      periodStart: "2026-04-01",
    },
    "First-year balance period should end at first work anniversary",
  );

  assert.equal(
    calculateVacationPayment({
      approvedPaidDaysInPeriod: 0,
      durationDays: 1,
      hireDate: "2026-04-01",
      startDate: "2026-09-30",
    }).unpaidReason,
    "first_six_months",
    "Requests before six months should be unpaid",
  );

  const firstPaidWindow = calculateVacationPayment({
    approvedPaidDaysInPeriod: 2,
    durationDays: 3,
    hireDate: "2026-04-01",
    startDate: "2026-10-01",
  });
  assert.equal(firstPaidWindow.paymentStatus, "paid");
  assert.equal(firstPaidWindow.balanceBeforeDays, 9.25);
  assert.equal(firstPaidWindow.balanceAfterDays, 6.25);

  assert.equal(
    calculateVacationPayment({
      approvedPaidDaysInPeriod: 10,
      durationDays: 2,
      hireDate: "2026-04-01",
      startDate: "2026-10-01",
    }).unpaidReason,
    "insufficient_balance",
    "Insufficient paid balance should make the request unpaid",
  );

  const standardWindow = calculateVacationPayment({
    approvedPaidDaysInPeriod: 0,
    durationDays: 5,
    hireDate: "2026-04-01",
    startDate: "2027-04-01",
  });
  assert.equal(standardWindow.entitlementDays, 21);
  assert.equal(standardWindow.balanceAfterDays, 16);
}
