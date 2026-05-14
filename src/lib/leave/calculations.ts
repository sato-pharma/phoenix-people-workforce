import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import type { LeaveDurationUnit, LeavePolicy, LeaveTransaction } from "@/lib/leave/types";

export type LeaveEmployeeForPolicy = Pick<EmployeeDirectoryRow, "hireDate"> & {
  jobTitle?: string | null;
  positionTitle?: string | null;
};

const dayMs = 24 * 60 * 60 * 1000;
const defaultWeekendDays = [5, 6];
const fieldWorkingTitlePatterns = [
  /\bmedical\s*rep\b/i,
  /\bmedical\s*representative\b/i,
  /\bmr\b/i,
  /\bdsm\b/i,
  /\bdistrict\s*sales\s*manager\b/i,
  /\bnsm\b/i,
  /\bnational\s*sales\s*manager\b/i,
];

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

export function getWeekendDaysForEmployee(
  employee: Partial<Pick<LeaveEmployeeForPolicy, "jobTitle" | "positionTitle">> | null | undefined,
  fallbackWeekendDays: number[] = defaultWeekendDays,
) {
  const title = `${employee?.jobTitle ?? ""} ${employee?.positionTitle ?? ""}`.toLowerCase();
  if (fieldWorkingTitlePatterns.some((pattern) => pattern.test(title))) {
    return [5];
  }
  return fallbackWeekendDays?.length ? fallbackWeekendDays.map(Number) : defaultWeekendDays;
}

export function isWithinFirstSixMonths(hiringDate: Date | string | null | undefined, asOfDate: Date | string = new Date()) {
  if (!hiringDate) return false;
  const start = toUtcDate(hiringDate);
  const end = toUtcDate(asOfDate);
  if (!validDate(start) || !validDate(end) || end < start) return false;
  const sixMonthMark = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 6, start.getUTCDate()));
  return end < sixMonthMark;
}

export function getAnnualEntitlement(
  employee: LeaveEmployeeForPolicy,
  policy: LeavePolicy,
  asOfDate: Date | string = new Date(),
) {
  const yearsOfService = calculateYearsOfService(employee.hireDate, asOfDate);
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

export function calculateLeaveDuration(
  startDate: Date | string,
  endDate: Date | string,
  publicHolidays: Array<Date | string> = [],
  weekendDays: number[] = defaultWeekendDays,
  durationUnit: LeaveDurationUnit = "full_day",
) {
  if (durationUnit === "full_day") {
    return calculateWorkingLeaveDays(startDate, endDate, publicHolidays, weekendDays);
  }
  const calendarDays = calculateCalendarLeaveDays(startDate, endDate);
  if (calendarDays !== 1) {
    throw new Error("AM/PM leave is only allowed for single-day requests.");
  }
  return calculateWorkingLeaveDays(startDate, endDate, publicHolidays, weekendDays) > 0 ? 0.5 : 0;
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
