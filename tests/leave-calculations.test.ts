import assert from "node:assert/strict";

import {
  calculateLeaveDuration,
  calculateMonthlyAccrual,
  calculateWorkingLeaveDays,
  calculateYearsOfService,
  getAnnualEntitlement,
  getWeekendDaysForEmployee,
  isWithinFirstSixMonths,
  summarizeLeaveLedger,
} from "../src/lib/leave/calculations.ts";
import type { LeavePolicy } from "../src/lib/leave/types.ts";

const policy: LeavePolicy = {
  accrualFrequency: "monthly",
  accrualMethod: "monthly",
  allowNegativeBalance: false,
  annualDaysAfterFirstYear: 21,
  annualDaysFirstYear: 15,
  carryForwardEnabled: false,
  carryForwardExpiryMonths: 0,
  carryForwardLimit: 0,
  country: "EG",
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "policy",
  isActive: true,
  isDefault: true,
  name: "Egypt Annual Leave Policy",
  updatedAt: "2026-01-01T00:00:00.000Z",
  weekendDays: [5, 6],
};

export function runLeaveCalculationTests() {
  assert.equal(calculateYearsOfService("2025-06-01", "2026-05-31"), 0);
  assert.equal(calculateYearsOfService("2025-06-01", "2026-06-01"), 1);

  assert.equal(getAnnualEntitlement({ hireDate: "2026-01-01" }, policy, "2026-05-12"), 15);
  assert.equal(getAnnualEntitlement({ hireDate: "2024-01-01" }, policy, "2026-05-12"), 21);
  assert.equal(getAnnualEntitlement({ hireDate: "2014-01-01" }, policy, "2026-05-12"), 21);
  assert.equal(getAnnualEntitlement({ hireDate: "2024-01-01" }, policy, "2026-05-12"), 21);
  assert.equal(calculateMonthlyAccrual({ hireDate: "2026-01-01" }, policy, "2026-05-12"), 1.25);
  assert.equal(calculateMonthlyAccrual({ hireDate: "2024-01-01" }, policy, "2026-05-12"), 1.75);
  assert.equal(isWithinFirstSixMonths("2026-01-01", "2026-06-30"), true);
  assert.equal(isWithinFirstSixMonths("2026-01-01", "2026-07-01"), false);

  assert.equal(
    calculateWorkingLeaveDays("2026-05-24", "2026-05-28", ["2026-05-27"], [5, 6]),
    4,
    "Friday/Saturday weekends and public holidays should be excluded.",
  );
  assert.equal(calculateWorkingLeaveDays("2026-05-24", "2026-05-24", [], [5, 6]), 1, "Same-day weekday leave should count as one day.");
  assert.equal(calculateWorkingLeaveDays("2026-05-22", "2026-05-22", [], [5, 6]), 0, "Same-day weekend leave should count as zero working days.");
  assert.deepEqual(getWeekendDaysForEmployee({ jobTitle: "Medical Representative" }), [5], "Medical/sales field titles should only have Friday off.");
  assert.deepEqual(getWeekendDaysForEmployee({ jobTitle: "Office Coordinator" }), [5, 6], "Non-field titles should use Friday/Saturday weekends.");
  assert.equal(calculateWorkingLeaveDays("2026-05-23", "2026-05-23", [], getWeekendDaysForEmployee({ jobTitle: "Medical Representative" })), 1, "Field roles should count Saturday as working.");
  assert.equal(calculateLeaveDuration("2026-05-24", "2026-05-24", [], [5, 6], "am"), 0.5);
  assert.equal(calculateLeaveDuration("2026-05-24", "2026-05-24", [], [5, 6], "pm"), 0.5);
  assert.throws(
    () => calculateLeaveDuration("2026-05-24", "2026-05-25", [], [5, 6], "am"),
    /single-day/,
    "AM/PM leave should only be valid for single-day leave.",
  );
  assert.throws(
    () => calculateWorkingLeaveDays("2026-05-28", "2026-05-24", [], [5, 6]),
    /Invalid leave date range/,
    "Invalid date ranges should be rejected.",
  );

  const ledger = summarizeLeaveLedger([
    { amount: 5, transactionType: "opening_balance" },
    { amount: 10, transactionType: "accrual" },
    { amount: 2, transactionType: "carry_forward" },
    { amount: 1, transactionType: "adjustment" },
    { amount: 3, transactionType: "pending" },
    { amount: 4, transactionType: "consumed" },
  ]);
  assert.equal(ledger.availableBalance, 11);
}
