// Payroll cycle window math for Payroll Copilot.
//
// Owner-confirmed (2026-07-03): the payroll/fingerprint month runs
// day-24 -> day-24 (anchor day fixed, see PAYROLL_CYCLE_ANCHOR_DAY below).
//
// Pure calendar arithmetic (UTC, no timezone) so it is deterministic and testable.

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
