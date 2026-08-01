// Payroll cycle window math for Payroll Copilot.
//
// Owner-confirmed (2026-07-03): the payroll/fingerprint month runs
// day-24 -> day-24 (anchor day fixed, see PAYROLL_CYCLE_ANCHOR_DAY below).
//
// Owner-confirmed (2026-08-01): that is the HEAD OFFICE month. The FIELD FORCE
// — Medical Reps and District Managers — run on the plain CALENDAR month, 1st to
// 30th/31st. Two populations, two windows; see resolveCycleWindowForTitle.
// Before this, a single flat anchor day was applied to everyone.
//
// Pure calendar arithmetic (UTC, no timezone) so it is deterministic and testable.
// MUST STAY CLIENT-SAFE — automated-payroll/step-definitions.ts imports this into
// the recommendation grid. weekend-policy.ts below qualifies: it has no imports
// of its own, only title regexes and date maths.

import { isFieldWorkforceFridayOnlyTitle } from "@/lib/field-workforce-compliance/weekend-policy";

export type CycleWindow = {
  /** 'YYYY-MM' of the month the cycle ends in (the "July cycle" ends 23 Jul). */
  cycleKey: string;
  /** Inclusive ISO start date (the anchor day of the previous month). */
  startIso: string;
  /** Inclusive ISO end date (the day before the next anchor). */
  endIso: string;
  anchorDay: number;
};

export const PAYROLL_CYCLE_ANCHOR_DAY = 24;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toUtcDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const date = toUtcDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

/** Whole days from `startIso` to `endIso` inclusive (>= 1 for start <= end). */
export function inclusiveDayCount(startIso: string, endIso: string): number {
  const ms = toUtcDate(endIso).getTime() - toUtcDate(startIso).getTime();
  return Math.floor(ms / 86_400_000) + 1;
}

/**
 * The day-24 -> day-24 cycle that contains `dateIso`.
 * A date on/after the anchor day belongs to the cycle starting that month;
 * a date before it belongs to the cycle that started the previous month.
 */
export function resolveCycleWindow(dateIso: string, anchorDay = PAYROLL_CYCLE_ANCHOR_DAY): CycleWindow {
  const [year, month, day] = dateIso.split("-").map(Number);

  let startYear = year;
  let startMonth = month;
  if (day < anchorDay) {
    startMonth = month - 1;
    if (startMonth < 1) {
      startMonth = 12;
      startYear = year - 1;
    }
  }

  const startIso = `${startYear}-${pad2(startMonth)}-${pad2(anchorDay)}`;

  let endMonthYear = startYear;
  let endMonth = startMonth + 1;
  if (endMonth > 12) {
    endMonth = 1;
    endMonthYear += 1;
  }
  const nextAnchorIso = `${endMonthYear}-${pad2(endMonth)}-${pad2(anchorDay)}`;
  const endIso = addDays(nextAnchorIso, -1);

  return {
    cycleKey: `${endMonthYear}-${pad2(endMonth)}`,
    startIso,
    endIso,
    anchorDay,
  };
}

/** Which payroll month an employee is on. Decided by job title, not department. */
export type PayrollCycleMode = "field_force" | "head_office";

/**
 * Field force = Medical Rep / District (Sales) Manager — the same population
 * that gets a Friday-only weekend, so the title test is shared rather than
 * duplicated. If the two ever need to diverge, split them then; today an
 * employee on the calendar payroll month is exactly an employee who works
 * Saturdays, and keeping one predicate means they cannot drift apart silently.
 */
export function resolvePayrollCycleMode(jobTitle: string | null | undefined): PayrollCycleMode {
  return isFieldWorkforceFridayOnlyTitle(jobTitle) ? "field_force" : "head_office";
}

/** Inclusive last day of the calendar month containing `dateIso`. */
function lastDayOfCalendarMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The payroll window for ONE employee, per the owner rule (2026-08-01):
 *
 *   Head Office   → day-24 of the previous month to day-23 of this one
 *   Field force   → the plain calendar month, 1st to 30th/31st
 *
 * Deliberately NOT implemented as `resolveCycleWindow(dateIso, 1)`. That would
 * produce the right date range but the WRONG cycleKey: resolveCycleWindow keys a
 * window by the month it ENDS in, so an anchor of 1 would label calendar July as
 * the August cycle. A calendar month is its own key.
 */
export function resolveCycleWindowForTitle(
  dateIso: string,
  jobTitle: string | null | undefined,
): CycleWindow {
  if (resolvePayrollCycleMode(jobTitle) === "head_office") {
    return resolveCycleWindow(dateIso, PAYROLL_CYCLE_ANCHOR_DAY);
  }

  const [year, month] = dateIso.split("-").map(Number);
  return {
    cycleKey: `${year}-${pad2(month)}`,
    startIso: `${year}-${pad2(month)}-01`,
    endIso: `${year}-${pad2(month)}-${pad2(lastDayOfCalendarMonth(year, month))}`,
    anchorDay: 1,
  };
}
