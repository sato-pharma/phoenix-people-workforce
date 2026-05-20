import assert from "node:assert/strict";

import {
  calculateFirstYearVacationEntitlement,
  calculateVacationDurationDays,
  calculateVacationPayment,
  getEmergencyVacationBalancePeriod,
  getVacationBalancePeriod,
  validateVacationRequestPolicy,
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

  assert.deepEqual(
    getEmergencyVacationBalancePeriod("2026-05-19"),
    {
      entitlementDays: 6,
      periodEnd: "2027-01-01",
      periodStart: "2026-01-01",
    },
    "Emergency vacation should use a fixed 6-day calendar-year balance",
  );

  const emergencyWindow = calculateVacationPayment({
    approvedPaidDaysInPeriod: 2,
    durationDays: 1,
    hireDate: null,
    startDate: "2026-05-19",
    vacationType: "emergency",
  });
  assert.equal(emergencyWindow.entitlementDays, 6);
  assert.equal(emergencyWindow.balanceBeforeDays, 4);
  assert.equal(emergencyWindow.balanceAfterDays, 3);

  assert.throws(
    () =>
      validateVacationRequestPolicy({
        dayPart: "full_day",
        endDate: "2026-05-20",
        now: new Date("2026-05-19T07:30:00Z"),
        startDate: "2026-05-20",
        vacationType: "emergency",
      }),
    /today only/i,
    "Emergency vacation must be locked to the request day",
  );

  assert.throws(
    () =>
      validateVacationRequestPolicy({
        dayPart: "am_only",
        endDate: "2026-05-19",
        now: new Date("2026-05-19T08:00:00Z"),
        startDate: "2026-05-19",
        vacationType: "emergency",
      }),
    /before 10:00 AM/i,
    "Emergency AM-only requests must be submitted before 10 AM Cairo time",
  );

  validateVacationRequestPolicy({
    dayPart: "pm_only",
    endDate: "2026-05-19",
    now: new Date("2026-05-19T14:00:00Z"),
    startDate: "2026-05-19",
    vacationType: "emergency",
  });

  assert.throws(
    () =>
      validateVacationRequestPolicy({
        dayPart: "full_day",
        endDate: "2026-05-19",
        now: new Date("2026-05-19T06:00:00Z"),
        startDate: "2026-05-19",
        vacationType: "annual",
      }),
    /tomorrow or later/i,
    "Annual vacation must start from the next day or later",
  );
}
