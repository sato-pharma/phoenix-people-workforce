import assert from "node:assert/strict";

import {
  calculateFirstYearVacationEntitlement,
  calculateVacationDurationDays,
  calculateVacationPayment,
  getEmergencyVacationBalancePeriod,
  getVacationBalancePeriod,
  getVacationPolicyToday,
  vacationRequestDisplayId,
  validateVacationRequestPolicy,
} from "../src/lib/vacation/calculations.ts";

export function runVacationCalculationTests() {
  assert.match(
    vacationRequestDisplayId("e9c4c1ce-8568-4a30-b14c-4365b876754e"),
    /^VR-\d{3}$/,
    "Vacation report should expose a compact spreadsheet-friendly request ID.",
  );

  assert.equal(
    calculateVacationDurationDays({
      dayPart: "full_day",
      endDate: "2026-05-17",
      startDate: "2026-05-14",
    }),
    3,
    "Vacation duration should exclude Friday only and count Saturday as working from home",
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

  assert.equal(
    calculateVacationDurationDays({
      dayPart: "full_day",
      endDate: "2026-05-14",
      startDate: "2026-05-14",
      weeklyOffPolicy: { friday: "full_day", saturday: "working", thursday: "am_only" },
    }),
    0.5,
    "A title-specific AM weekly off should leave only PM as vacation duration",
  );

  assert.throws(
    () =>
      calculateVacationDurationDays({
        dayPart: "am_only",
        endDate: "2026-05-14",
        startDate: "2026-05-14",
        weeklyOffPolicy: { friday: "full_day", saturday: "working", thursday: "am_only" },
      }),
    /working time/,
    "Vacation should not be accepted for a day part already marked as weekly off",
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
    15,
    "First employment year annual vacation should be capped at 15 annual days",
  );

  assert.deepEqual(
    getVacationBalancePeriod({ hireDate: "2026-04-01", referenceDate: "2026-10-01" }),
    {
      entitlementDays: 7.5,
      periodEnd: "2027-04-01",
      periodStart: "2026-04-01",
    },
    "First-year annual balance should accrue monthly at 1.25 days per month",
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
    durationDays: 2,
    hireDate: "2026-04-01",
    startDate: "2026-10-01",
  });
  assert.equal(firstPaidWindow.paymentStatus, "paid");
  assert.equal(firstPaidWindow.balanceBeforeDays, 5.5);
  assert.equal(firstPaidWindow.balanceAfterDays, 3.5);

  const partialWindow = calculateVacationPayment({
    approvedPaidDaysInPeriod: 6,
    durationDays: 3,
    hireDate: "2026-04-01",
    startDate: "2026-10-01",
  });
  assert.equal(partialWindow.paymentStatus, "partial");
  assert.equal(partialWindow.paidDurationDays, 1.5);
  assert.equal(partialWindow.unpaidDurationDays, 1.5);
  assert.equal(partialWindow.balanceAfterDays, 0);
  assert.equal(
    partialWindow.unpaidReason,
    "insufficient_balance",
    "Insufficient paid balance should split available paid days and remaining unpaid days",
  );

  const standardWindow = calculateVacationPayment({
    approvedPaidDaysInPeriod: 0,
    durationDays: 1,
    hireDate: "2026-04-01",
    startDate: "2027-05-01",
  });
  assert.equal(standardWindow.entitlementDays, 1.75);
  assert.equal(standardWindow.balanceAfterDays, 0.75);

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
    hireDate: "2025-01-01",
    startDate: "2026-05-19",
    vacationType: "emergency",
  });
  assert.equal(emergencyWindow.entitlementDays, 7);
  assert.equal(emergencyWindow.balanceBeforeDays, 5);
  assert.equal(emergencyWindow.balanceAfterDays, 4);

  assert.equal(
    calculateVacationPayment({
      approvedPaidDaysInPeriod: 0,
      durationDays: 1,
      hireDate: "2026-01-01",
      startDate: "2026-05-19",
      vacationType: "emergency",
    }).unpaidReason,
    "first_six_months",
    "Emergency vacation should still be unpaid before completing six months",
  );

  const compensatoryWindow = calculateVacationPayment({
    approvedPaidDaysInPeriod: 99,
    durationDays: 1,
    hireDate: "2026-01-01",
    startDate: "2026-05-19",
    vacationType: "compensatory",
  });
  assert.equal(compensatoryWindow.paymentStatus, "paid");
  assert.equal(compensatoryWindow.entitlementDays, 0);
  assert.equal(compensatoryWindow.paidDurationDays, 1);
  assert.equal(compensatoryWindow.unpaidDurationDays, 0);
  assert.equal(compensatoryWindow.usedPaidDays, 0);
  assert.equal(compensatoryWindow.balanceAfterDays, 0);

  assert.throws(
    () =>
      validateVacationRequestPolicy({
        dayPart: "full_day",
        endDate: "2026-05-20",
        now: new Date("2026-05-19T07:30:00Z"),
        startDate: "2026-05-20",
        vacationType: "emergency",
      }),
    /current day only/i,
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

  const annualClock = new Date("2026-05-19T06:00:00Z");
  const annualToday = getVacationPolicyToday(annualClock);

  // Annual vacation may now start TODAY. (A single-day same-day annual request is reclassified
  // to "emergency" by the backend, but the date policy itself must allow today.)
  validateVacationRequestPolicy({
    dayPart: "full_day",
    endDate: annualToday,
    now: annualClock,
    startDate: annualToday,
    vacationType: "annual",
  });

  // Annual vacation starting a future date remains allowed.
  validateVacationRequestPolicy({
    dayPart: "full_day",
    endDate: "2026-05-25",
    now: annualClock,
    startDate: "2026-05-24",
    vacationType: "annual",
  });

  // Annual vacation in the PAST is still rejected — we only opened today, not retroactive dates.
  assert.throws(
    () =>
      validateVacationRequestPolicy({
        dayPart: "full_day",
        endDate: "2026-05-18",
        now: annualClock,
        startDate: "2026-05-18",
        vacationType: "annual",
      }),
    /today or later/i,
    "Annual vacation must not start before today",
  );

  // Duration math is unchanged for a single-day annual-today request.
  assert.equal(
    calculateVacationDurationDays({
      dayPart: "full_day",
      endDate: annualToday,
      startDate: annualToday,
    }),
    1,
    "A single-day annual request starting today should still count as one vacation day",
  );
}
