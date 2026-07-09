import { addDaysToDateOnly, addYearsToDateOnly, parseDateOnly, toDateOnlyString } from "../date-only.ts";
import { countHrWorkingDays, isHrWorkingDayPart } from "@/lib/hr-calendar/calendar-logic";
import type { HrWeeklyOffPolicy } from "@/lib/hr-calendar/types";
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
const emergencyAnnualEntitlementDays = 6;
const monthsInYear = 12;

/**
 * Employees whose annual/emergency leave balance resets on the calendar year
 * (Jan 1) instead of their hire anniversary. This is a per-employee exception,
 * not a policy change — added for A-7 per explicit owner instruction on
 * 2026-07-09. Every other employee keeps the hire-anniversary reset below.
 */
const calendarYearVacationResetHrIds = new Set(["a-7"]);

function usesCalendarYearVacationReset(employeeHrId: string | null | undefined) {
  return calendarYearVacationResetHrIds.has(String(employeeHrId ?? "").trim().toLowerCase());
}
const emergencyCutoffHour = 10;
const vacationPolicyTimeZone = "Africa/Cairo";

function roundDays(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function splitVacationPayment(input: {
  balanceBeforeDays: number;
  durationDays: number;
  entitlementDays: number;
  periodEnd: string | null;
  periodStart: string | null;
  usedPaidDays: number;
}): VacationBalanceSnapshot {
  const paidDurationDays = roundDays(Math.min(input.durationDays, Math.max(0, input.balanceBeforeDays)));
  const unpaidDurationDays = roundDays(Math.max(0, input.durationDays - paidDurationDays));
  return {
    balanceAfterDays: roundDays(Math.max(0, input.balanceBeforeDays - paidDurationDays)),
    balanceBeforeDays: roundDays(input.balanceBeforeDays),
    entitlementDays: roundDays(input.entitlementDays),
    paidDurationDays,
    paymentStatus: unpaidDurationDays > 0 && paidDurationDays > 0 ? "partial" : unpaidDurationDays > 0 ? "unpaid" : "paid",
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    unpaidDurationDays,
    unpaidReason: unpaidDurationDays > 0 ? "insufficient_balance" : null,
    usedPaidDays: roundDays(input.usedPaidDays),
  };
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

export function compareDateOnly(left: string, right: string) {
  const leftDate = dateOnlyOrNull(left);
  const rightDate = dateOnlyOrNull(right);
  if (!leftDate || !rightDate) return 0;
  return leftDate.getTime() - rightDate.getTime();
}

export function normalizeVacationType(value: unknown): VacationType | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "personal") return "other";
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

export function vacationRequestDisplayId(value: string | null | undefined) {
  const hex = String(value ?? "").replace(/[^a-fA-F0-9]/g, "");
  const seed = Number.parseInt(hex.slice(-6) || hex.slice(0, 6) || "0", 16);
  const numericCode = Number.isFinite(seed) ? (seed % 900) + 100 : 100;
  return `VR-${String(numericCode).padStart(3, "0")}`;
}

export function calculateVacationDurationDays(input: {
  dayPart: VacationDayPart;
  endDate: string;
  holidays?: string[];
  startDate: string;
  weeklyOffPolicy?: Partial<HrWeeklyOffPolicy> | null;
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
    if (!isHrWorkingDayPart(startDate, input.dayPart, input.holidays, input.weeklyOffPolicy)) {
      throw new Error("Vacation date must be a working day and the selected day part must be working time.");
    }
    return 0.5;
  }

  const workingDays = countHrWorkingDays(input.startDate, input.endDate, input.holidays, input.weeklyOffPolicy);

  if (workingDays <= 0) {
    throw new Error("Vacation range must include at least one working day.");
  }

  return workingDays;
}

export function calculateFirstYearVacationEntitlement(hireDate: string | null | undefined) {
  const parsed = dateOnlyOrNull(hireDate);
  if (!parsed) return 0;
  return firstYearAnnualEntitlementDays;
}

function calendarMonthDiff(start: string, end: string) {
  const startDate = dateOnlyOrNull(start);
  const endDate = dateOnlyOrNull(end);
  if (!startDate || !endDate || endDate < startDate) return 0;
  return Math.max(0, (endDate.getFullYear() - startDate.getFullYear()) * 12 + endDate.getMonth() - startDate.getMonth());
}

function calculateMonthlyAccruedEntitlement(input: {
  annualEntitlementDays: number;
  periodStart: string;
  referenceDate: string;
}) {
  const accruedMonths = Math.min(monthsInYear, calendarMonthDiff(input.periodStart, input.referenceDate));
  return roundDays((input.annualEntitlementDays / monthsInYear) * accruedMonths);
}

export function getVacationBalancePeriod(input: {
  employeeHrId?: string | null;
  hireDate: string | null | undefined;
  referenceDate: string;
}) {
  const hireDate = toDateOnlyString(input.hireDate);
  const referenceDate = toDateOnlyString(input.referenceDate);
  if (!hireDate || !referenceDate) return null;

  if (usesCalendarYearVacationReset(input.employeeHrId)) {
    const year = Number(referenceDate.slice(0, 4));
    return {
      entitlementDays: standardAnnualEntitlementDays,
      periodEnd: `${year + 1}-01-01`,
      periodStart: `${year}-01-01`,
    };
  }

  const firstAnniversary = addYearsToDateOnly(hireDate, 1);
  if (!firstAnniversary) return null;

  if (compareDateOnly(referenceDate, firstAnniversary) < 0) {
    return {
      entitlementDays: calculateMonthlyAccruedEntitlement({
        annualEntitlementDays: firstYearAnnualEntitlementDays,
        periodStart: hireDate,
        referenceDate,
      }),
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

export function getEmergencyVacationBalancePeriod(referenceDate: string) {
  const date = dateOnlyOrNull(referenceDate);
  if (!date) return null;
  const year = date.getFullYear();
  return {
    entitlementDays: emergencyAnnualEntitlementDays,
    periodEnd: `${year + 1}-01-01`,
    periodStart: `${year}-01-01`,
  };
}

function dateOnlyFromParts(parts: Record<string, string | undefined>) {
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  return year && month && day ? `${year}-${month}-${day}` : toDateOnlyString(new Date()) ?? "";
}

function vacationPolicyClock(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: vacationPolicyTimeZone,
    year: "numeric",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return {
    dateOnly: dateOnlyFromParts(parts),
    hour: Number(parts.hour ?? 0),
    minute: Number(parts.minute ?? 0),
  };
}

export function getVacationPolicyToday(now = new Date()) {
  return vacationPolicyClock(now).dateOnly;
}

export function getAnnualVacationMinimumStartDate(now = new Date()) {
  return addDaysToDateOnly(getVacationPolicyToday(now), 1) ?? getVacationPolicyToday(now);
}

export function validateVacationRequestPolicy(input: {
  dayPart: VacationDayPart;
  endDate: string;
  now?: Date;
  startDate: string;
  vacationType: VacationType;
}) {
  const warnings = getVacationPolicyWarnings(input);
  if (warnings.length > 0) {
    throw new Error(warnings[0]);
  }
}

export function getVacationPolicyWarnings(input: {
  dayPart: VacationDayPart;
  endDate: string;
  now?: Date;
  startDate: string;
  vacationType: VacationType;
}) {
  const warnings: string[] = [];
  const clock = vacationPolicyClock(input.now);

  if (input.vacationType === "emergency") {
    if (input.startDate !== clock.dateOnly || input.endDate !== clock.dateOnly) {
      warnings.push("Emergency vacation policy: emergency requests should be submitted for the current day only.");
    }

    if (input.dayPart !== "pm_only" && clock.hour >= emergencyCutoffHour) {
      warnings.push("Emergency vacation policy: full-day and AM-only emergency requests should be submitted before 10:00 AM Cairo time.");
    }
  }

  if (input.vacationType === "annual") {
    if (input.startDate < getVacationPolicyToday(input.now)) {
      warnings.push("Annual vacation policy: annual requests must start today or later.");
    }
  }

  return warnings;
}

export function calculateVacationPayment(input: {
  approvedPaidDaysInPeriod: number;
  durationDays: number;
  employeeHrId?: string | null;
  hireDate: string | null | undefined;
  startDate: string;
  vacationType?: VacationType;
}): VacationBalanceSnapshot {
  const hireDate = toDateOnlyString(input.hireDate);
  const durationDays = roundDays(input.durationDays);
  const vacationType = input.vacationType ?? "annual";
  if (vacationType === "compensatory") {
    return {
      balanceAfterDays: 0,
      balanceBeforeDays: 0,
      entitlementDays: 0,
      paidDurationDays: durationDays,
      paymentStatus: "paid",
      periodEnd: null,
      periodStart: null,
      unpaidDurationDays: 0,
      unpaidReason: null,
      usedPaidDays: 0,
    };
  }
  const defaultUnpaid = (
    reason: VacationUnpaidReason,
    period: ReturnType<typeof getVacationBalancePeriod> = null,
  ): VacationBalanceSnapshot => ({
    balanceAfterDays: 0,
    balanceBeforeDays: 0,
    entitlementDays: roundDays(period?.entitlementDays ?? 0),
    paidDurationDays: 0,
    paymentStatus: "unpaid",
    periodEnd: period?.periodEnd ?? null,
    periodStart: period?.periodStart ?? null,
    unpaidDurationDays: durationDays,
    unpaidReason: reason,
    usedPaidDays: roundDays(input.approvedPaidDaysInPeriod),
  });

  if (!hireDate) {
    return defaultUnpaid("missing_hire_date");
  }

  const sixMonthAnniversary = addMonthsToDateOnly(hireDate, 6);
  if (sixMonthAnniversary && compareDateOnly(input.startDate, sixMonthAnniversary) < 0) {
    const period = getVacationBalancePeriod({ employeeHrId: input.employeeHrId, hireDate, referenceDate: input.startDate });
    return defaultUnpaid("first_six_months", period);
  }

  if (vacationType === "emergency") {
    const period = getVacationBalancePeriod({ employeeHrId: input.employeeHrId, hireDate, referenceDate: input.startDate });
    if (!period) {
      return defaultUnpaid("missing_hire_date");
    }

    const usedPaidDays = roundDays(input.approvedPaidDaysInPeriod);
    const balanceBeforeDays = roundDays(Math.max(0, period.entitlementDays - usedPaidDays));
    return splitVacationPayment({
      balanceBeforeDays,
      durationDays,
      entitlementDays: period.entitlementDays,
      periodEnd: period.periodEnd,
      periodStart: period.periodStart,
      usedPaidDays,
    });
  }

  const period = getVacationBalancePeriod({ employeeHrId: input.employeeHrId, hireDate, referenceDate: input.startDate });
  if (!period) {
    return defaultUnpaid("missing_hire_date");
  }

  const usedPaidDays = roundDays(input.approvedPaidDaysInPeriod);
  const balanceBeforeDays = roundDays(Math.max(0, period.entitlementDays - usedPaidDays));
  return splitVacationPayment({
    balanceBeforeDays,
    durationDays,
    entitlementDays: period.entitlementDays,
    periodEnd: period.periodEnd,
    periodStart: period.periodStart,
    usedPaidDays,
  });
}

export function vacationUnpaidReasonLabel(reason: VacationUnpaidReason | null | undefined) {
  if (reason === "first_six_months") return "First 6 months";
  if (reason === "insufficient_balance") return "Unpaid - insufficient balance";
  if (reason === "missing_hire_date") return "Missing hire date";
  return "";
}
