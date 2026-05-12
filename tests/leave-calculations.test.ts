import assert from "node:assert/strict";

import {
  calculateEmployeeAge,
  calculateMonthlyAccrual,
  calculateProratedEntitlement,
  calculateWorkingLeaveDays,
  calculateYearsOfService,
  getAnnualEntitlement,
  summarizeLeaveLedger,
} from "../src/lib/leave/calculations.ts";
import type { LeavePolicy } from "../src/lib/leave/types.ts";

const policy: LeavePolicy = {
  accrualFrequency: "monthly",
  accrualMethod: "prorated",
  allowNegativeBalance: false,
  annualDaysAfterFirstYear: 21,
  annualDaysDisability: 45,
  annualDaysFirstYear: 15,
  annualDaysSenior: 30,
  carryForwardEnabled: false,
  carryForwardExpiryMonths: 0,
  carryForwardLimit: 0,
  country: "EG",
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "policy",
  isActive: true,
  isDefault: true,
  name: "Egypt Annual Leave Policy",
  seniorAfterAge: 50,
  seniorAfterYears: 10,
  updatedAt: "2026-01-01T00:00:00.000Z",
  weekendDays: [5, 6],
};

export function runLeaveCalculationTests() {
  assert.equal(calculateYearsOfService("2025-06-01", "2026-05-31"), 0);
  assert.equal(calculateYearsOfService("2025-06-01", "2026-06-01"), 1);
  assert.equal(calculateEmployeeAge("1976-05-12", "2026-05-12"), 50);

  assert.equal(getAnnualEntitlement({ birthDate: "1996-01-01", hireDate: "2026-01-01" }, policy, "2026-05-12"), 15);
  assert.equal(getAnnualEntitlement({ birthDate: "1996-01-01", hireDate: "2024-01-01" }, policy, "2026-05-12"), 21);
  assert.equal(getAnnualEntitlement({ birthDate: "1996-01-01", hireDate: "2014-01-01" }, policy, "2026-05-12"), 30);
  assert.equal(getAnnualEntitlement({ birthDate: "1976-05-12", hireDate: "2024-01-01" }, policy, "2026-05-12"), 30);
  assert.equal(getAnnualEntitlement({ birthDate: "1996-01-01", hasDisability: true, hireDate: "2026-01-01" }, policy, "2026-05-12"), 45);
  assert.equal(calculateMonthlyAccrual({ birthDate: "1996-01-01", hireDate: "2026-01-01" }, policy, "2026-05-12"), 1.25);
  assert.equal(calculateProratedEntitlement({ birthDate: "1996-01-01", hireDate: "2026-07-15" }, policy, 2026), 7.5);

  assert.equal(
    calculateWorkingLeaveDays("2026-05-24", "2026-05-28", ["2026-05-27"], [5, 6]),
    4,
    "Friday/Saturday weekends and public holidays should be excluded.",
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
