import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import type { LeavePolicy, LeaveTransaction } from "@/lib/leave/types";

export type LeaveEmployeeForPolicy = Pick<EmployeeDirectoryRow, "birthDate" | "hireDate"> & {
  hasDisability?: boolean | null;
  isDisabled?: boolean | null;
  specialNeeds?: boolean | null;
  specialNeedsFlag?: boolean | null;
};

const dayMs = 24 * 60 * 60 * 1000;

function toUtcDate(value: Date | string) {
  const source = value instanceof Date ? value : new Date(`${value}T00:00:00.000Z`);
  return new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()));
}

function validDate(value: Date) {
  return Number.isFinite(value.getTime());
}

function roundDays(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateYearsOfService(hiringDate: Date | string | null | undefined, asOfDate: Date | string = new Date()) {
  if (!hiringDate) return 0;
  const start = toUtcDate(hiringDate);
  const end = toUtcDate(asOfDate);
  if (!validDate(start) || !validDate(end) || end < start) return 0;

  let years = end.getUTCFullYear() - start.getUTCFullYear();
  const anniversary = new Date(Date.UTC(end.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  if (end < anniversary) years -= 1;
  return Math.max(0, years);
}

export function calculateEmployeeAge(birthDate: Date | string | null | undefined, asOfDate: Date | string = new Date()) {
  if (!birthDate) return 0;
  const birth = toUtcDate(birthDate);
  const end = toUtcDate(asOfDate);
  if (!validDate(birth) || !validDate(end) || end < birth) return 0;

  let age = end.getUTCFullYear() - birth.getUTCFullYear();
  const birthday = new Date(Date.UTC(end.getUTCFullYear(), birth.getUTCMonth(), birth.getUTCDate()));
  if (end < birthday) age -= 1;
  return Math.max(0, age);
}

function employeeHasDisability(employee: LeaveEmployeeForPolicy) {
  return Boolean(
    employee.hasDisability ??
      employee.isDisabled ??
      employee.specialNeeds ??
      employee.specialNeedsFlag ??
      false,
  );
}

export function getAnnualEntitlement(
  employee: LeaveEmployeeForPolicy,
  policy: LeavePolicy,
  asOfDate: Date | string = new Date(),
) {
  if (employeeHasDisability(employee)) return policy.annualDaysDisability;

  const yearsOfService = calculateYearsOfService(employee.hireDate, asOfDate);
  const age = calculateEmployeeAge(employee.birthDate, asOfDate);
  if (yearsOfService >= policy.seniorAfterYears || age >= policy.seniorAfterAge) {
    return policy.annualDaysSenior;
  }

  if (yearsOfService < 1) return policy.annualDaysFirstYear;
  return policy.annualDaysAfterFirstYear;
}

export function calculateMonthlyAccrual(
  employee: LeaveEmployeeForPolicy,
  policy: LeavePolicy,
  asOfDate: Date | string = new Date(),
) {
  return roundDays(getAnnualEntitlement(employee, policy, asOfDate) / 12);
}

export function calculateCalendarLeaveDays(startDate: Date | string, endDate: Date | string) {
  const start = toUtcDate(startDate);
  const end = toUtcDate(endDate);
  if (!validDate(start) || !validDate(end) || end < start) {
    throw new Error("Invalid leave date range.");
  }
  return Math.floor((end.getTime() - start.getTime()) / dayMs) + 1;
}

export function calculateWorkingLeaveDays(
  startDate: Date | string,
  endDate: Date | string,
  publicHolidays: Array<Date | string> = [],
  weekendDays: number[] = [5, 6],
) {
  const start = toUtcDate(startDate);
  const end = toUtcDate(endDate);
  if (!validDate(start) || !validDate(end) || end < start) {
    throw new Error("Invalid leave date range.");
  }

  const weekends = new Set(weekendDays.map(Number));
  const holidays = new Set(publicHolidays.map((holiday) => toUtcDate(holiday).toISOString().slice(0, 10)));
  let days = 0;

  for (let cursor = new Date(start); cursor <= end; cursor = new Date(cursor.getTime() + dayMs)) {
    const dateKey = cursor.toISOString().slice(0, 10);
    if (weekends.has(cursor.getUTCDay()) || holidays.has(dateKey)) continue;
    days += 1;
  }

  return days;
}

export function calculateProratedEntitlement(
  employee: LeaveEmployeeForPolicy,
  policy: LeavePolicy,
  year: number,
) {
  const annualEntitlement = getAnnualEntitlement(employee, policy, `${year}-12-31`);
  if (!employee.hireDate) return annualEntitlement;

  const hireDate = toUtcDate(employee.hireDate);
  if (!validDate(hireDate) || hireDate.getUTCFullYear() < year) return annualEntitlement;
  if (hireDate.getUTCFullYear() > year) return 0;

  const monthCount = 12 - hireDate.getUTCMonth();
  return roundDays((annualEntitlement / 12) * monthCount);
}

export function calculateLeaveBalanceFromParts(parts: {
  openingBalance?: number;
  accrued?: number;
  consumed?: number;
  pending?: number;
  adjusted?: number;
  carryForward?: number;
}) {
  return roundDays(
    Number(parts.openingBalance ?? 0) +
      Number(parts.accrued ?? 0) +
      Number(parts.carryForward ?? 0) +
      Number(parts.adjusted ?? 0) -
      Number(parts.consumed ?? 0) -
      Number(parts.pending ?? 0),
  );
}

export function summarizeLeaveLedger(transactions: Pick<LeaveTransaction, "amount" | "transactionType">[]) {
  const summary = {
    accrued: 0,
    adjusted: 0,
    carryForward: 0,
    consumed: 0,
    openingBalance: 0,
    pending: 0,
  };

  for (const transaction of transactions) {
    const amount = Number(transaction.amount ?? 0);
    switch (transaction.transactionType) {
      case "opening_balance":
        summary.openingBalance += amount;
        break;
      case "accrual":
        summary.accrued += amount;
        break;
      case "carry_forward":
        summary.carryForward += amount;
        break;
      case "adjustment":
        summary.adjusted += amount;
        break;
      case "pending":
        summary.pending += amount;
        break;
      case "pending_reversal":
        summary.pending -= amount;
        break;
      case "consumed":
        summary.consumed += amount;
        break;
      case "consumed_reversal":
        summary.consumed -= amount;
        break;
    }
  }

  return {
    ...summary,
    availableBalance: calculateLeaveBalanceFromParts(summary),
  };
}
