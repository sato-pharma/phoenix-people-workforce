import { addYearsToDateOnly, parseDateOnly, toDateOnlyString } from "../date-only.ts";
import { countHrWorkingDays, isHrWorkingDay } from "@/lib/hr-calendar/calendar-logic";
import type {
  VacationBalanceSnapshot,
  VacationDayPart,
  VacationPaymentStatus,
  VacationType,
  VacationUnpaidReason,
} from "./types.ts";
import {
  VACATION_DAY_PARTS,
  VACATION_PAYMENT_STATUSES,
  VACATION_TYPES,
} from "./types.ts";

const firstYearAnnualEntitlementDays = 15;
const standardAnnualEntitlementDays = 21;
const monthsInYear = 12;

function roundDays(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function dateOnlyOrNull(value: string | null | undefined) {
  const parsed = parseDateOnly(value);
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function addMonthsToDateOnly(value: string | null | undefined, months: number) {
  const date = dateOnlyOrNull(value);
  if (!date) return null;
  date.setMonth(date.getMonth() + months);
  return toDateOnlyString(date);
}

function compareDateOnly(left: string, right: string) {
  const leftDate = dateOnlyOrNull(left);
  const rightDate = dateOnlyOrNull(right);
  if (!leftDate || !rightDate) return 0;
  return leftDate.getTime() - rightDate.getTime();
}

export function normalizeVacationType(value: unknown): VacationType | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return VACATION_TYPES.some((option) => option.value === normalized)
    ? (normalized as VacationType)
    : null;
}

export function normalizeVacationDayPart(value: unknown): VacationDayPart | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return VACATION_DAY_PARTS.some((option) => option.value === normalized)
    ? (normalized as VacationDayPart)
    : null;
}

export function normalizeVacationPaymentStatus(value: unknown): VacationPaymentStatus | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return VACATION_PAYMENT_STATUSES.some((option) => option.value === normalized)
    ? (normalized as VacationPaymentStatus)
    : null;
}

export function vacationTypeLabel(value: string | null | undefined) {
  return VACATION_TYPES.find((option) => option.value === value)?.label ?? "Vacation";
}

export function vacationDayPartLabel(value: string | null | undefined) {
  return VACATION_DAY_PARTS.find((option) => option.value === value)?.label ?? "Full day";
}

export function calculateVacationDurationDays(input: {
  dayPart: VacationDayPart;
  endDate: string;
  holidays?: string[];
  startDate: string;
}) {
  const startDate = dateOnlyOrNull(input.startDate);
  const endDate = dateOnlyOrNull(input.endDate);
  if (!startDate || !endDate) {
    throw new Error("Vacation start and end dates are required.");
  }
  if (startDate.getTime() > endDate.getTime()) {
    throw new Error("Vacation end date cannot be before the start date.");
  }

  if (input.dayPart !== "full_day") {
    if (startDate.getTime() !== endDate.getTime()) {
      throw new Error("AM only and PM only requests must be for one date.");
    }
    if (!isHrWorkingDay(startDate, input.holidays)) {
      throw new Error("Vacation date must be a working day.");
    }
    return 0.5;
  }

  const workingDays = countHrWorkingDays(input.startDate, input.endDate, input.holidays);

  if (workingDays <= 0) {
    throw new Error("Vacation range must include at least one working day.");
  }

  return workingDays;
}

export function calculateFirstYearVacationEntitlement(hireDate: string | null | undefined) {
  const parsed = dateOnlyOrNull(hireDate);
  if (!parsed) return 0;
  const inclusiveRemainingMonths = monthsInYear - parsed.getMonth();
  return roundDays((firstYearAnnualEntitlementDays / monthsInYear) * inclusiveRemainingMonths);
}

export function getVacationBalancePeriod(input: {
  hireDate: string | null | undefined;
  referenceDate: string;
}) {
  const hireDate = toDateOnlyString(input.hireDate);
  const referenceDate = toDateOnlyString(input.referenceDate);
  if (!hireDate || !referenceDate) return null;

  const firstAnniversary = addYearsToDateOnly(hireDate, 1);
  if (!firstAnniversary) return null;

  if (compareDateOnly(referenceDate, firstAnniversary) < 0) {
    return {
      entitlementDays: calculateFirstYearVacationEntitlement(hireDate),
      periodEnd: firstAnniversary,
      periodStart: hireDate,
    };
  }

  let periodStart = firstAnniversary;
  let periodEnd = addYearsToDateOnly(periodStart, 1) ?? firstAnniversary;
  while (compareDateOnly(referenceDate, periodEnd) >= 0) {
    periodStart = periodEnd;
    periodEnd = addYearsToDateOnly(periodStart, 1) ?? periodEnd;
  }

  return {
    entitlementDays: standardAnnualEntitlementDays,
    periodEnd,
    periodStart,
  };
}

export function calculateVacationPayment(input: {
  approvedPaidDaysInPeriod: number;
  durationDays: number;
  hireDate: string | null | undefined;
  startDate: string;
}): VacationBalanceSnapshot {
  const hireDate = toDateOnlyString(input.hireDate);
  const durationDays = roundDays(input.durationDays);
  const defaultUnpaid = (
    reason: VacationUnpaidReason,
    period: ReturnType<typeof getVacationBalancePeriod> = null,
  ): VacationBalanceSnapshot => ({
    balanceAfterDays: 0,
    balanceBeforeDays: 0,
    entitlementDays: roundDays(period?.entitlementDays ?? 0),
    paymentStatus: "unpaid",
    periodEnd: period?.periodEnd ?? null,
    periodStart: period?.periodStart ?? null,
    unpaidReason: reason,
    usedPaidDays: roundDays(input.approvedPaidDaysInPeriod),
  });

  if (!hireDate) {
    return defaultUnpaid("missing_hire_date");
  }

  const period = getVacationBalancePeriod({ hireDate, referenceDate: input.startDate });
  const sixMonthAnniversary = addMonthsToDateOnly(hireDate, 6);
  if (sixMonthAnniversary && compareDateOnly(input.startDate, sixMonthAnniversary) < 0) {
    return defaultUnpaid("first_six_months", period);
  }

  if (!period) {
    return defaultUnpaid("missing_hire_date");
  }

  const usedPaidDays = roundDays(input.approvedPaidDaysInPeriod);
  const balanceBeforeDays = roundDays(Math.max(0, period.entitlementDays - usedPaidDays));
  if (durationDays > balanceBeforeDays) {
    return {
      balanceAfterDays: balanceBeforeDays,
      balanceBeforeDays,
      entitlementDays: roundDays(period.entitlementDays),
      paymentStatus: "unpaid",
      periodEnd: period.periodEnd,
      periodStart: period.periodStart,
      unpaidReason: "insufficient_balance",
      usedPaidDays,
    };
  }

  return {
    balanceAfterDays: roundDays(balanceBeforeDays - durationDays),
    balanceBeforeDays,
    entitlementDays: roundDays(period.entitlementDays),
    paymentStatus: "paid",
    periodEnd: period.periodEnd,
    periodStart: period.periodStart,
    unpaidReason: null,
    usedPaidDays,
  };
}

export function vacationUnpaidReasonLabel(reason: VacationUnpaidReason | null | undefined) {
  if (reason === "first_six_months") return "First 6 months";
  if (reason === "insufficient_balance") return "Insufficient balance";
  if (reason === "missing_hire_date") return "Missing hire date";
  return "";
}
