// Unified Deductions module: the two collection CYCLES. Pure. No DB, no I/O, no clock — every
// rule here takes `todayIso` as input so it is unit-testable.
//
// THE OWNER'S RULE (2026-10-26). Part 1 of the salary is paid BEFORE the month ends, so a deduction
// module that only runs on a finished calendar month can never feed it. Two cycles, by who is paid
// how:
//   - "office"   — the Head Office cycle, the 22nd of the previous month → the 21st of the payroll
//                  month. EVERY employee paid in ONE part (`payment_mode` one_part) is on it.
//   - "calendar" — the 1st → the last day of the month. Everyone paid in TWO parts stays on it.
// His words: "make anyone part one to be from 22 to 20" (read as 22→21 — a cycle has to be
// contiguous, or the 21st of every month would never be judged).
//
// THE CUTOVER. The office cycle starts with the October 2026 payroll month. September 2026 was
// collected on the calendar month for everyone, so October's office window opens on 1 October
// (not 22 September) — opening it earlier would charge 22–30 September a second time. From
// November on the window is the plain 22nd → 21st.
//
// A cycle row is keyed to its PAYROLL month (month_key = the month it is paid in), and may carry
// days from the previous calendar month. That is the one shape `validateCandidateDraft` lets
// outside the month, and only inside the office window, marked on the draft's evidence.

import { scaleDeductionAmountToKeptDates } from "./calculations.ts";
import { compactDeductionsHrId } from "./candidate-key.ts";
import type { DeductionsCandidateDraft } from "./types.ts";

export type DeductionCycle = "calendar" | "office";

export const DEDUCTION_CYCLES: readonly DeductionCycle[] = ["office", "calendar"];

/** The first payroll month the office cycle covers. Before it, the calendar run covers everyone. */
export const OFFICE_CYCLE_FIRST_MONTH_KEY = "2026-10";

/** The office window closes on this day of the payroll month, and the next one opens the day after. */
export const OFFICE_CYCLE_CLOSE_DAY = 21;

export function isDeductionCycle(value: unknown): value is DeductionCycle {
  return value === "calendar" || value === "office";
}

export type PayrollMonth = { month: number; year: number };

export type CycleWindow = {
  cycle: DeductionCycle;
  /** The payroll month every row of this window is keyed to. */
  monthKey: string;
  /** First day judged, inclusive. */
  start: string;
  /** Last day judged, inclusive. */
  end: string;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function monthKeyOf(period: PayrollMonth): string {
  return `${String(period.year).padStart(4, "0")}-${pad2(period.month)}`;
}

export function shiftMonth(period: PayrollMonth, delta: number): PayrollMonth {
  const index = period.year * 12 + (period.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function lastDayOfMonth(period: PayrollMonth): number {
  return new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
}

/** The next calendar month's key — the ledger reads below cover a month AND the one after it. */
export function nextMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map((part) => Number.parseInt(part, 10));
  return monthKeyOf(shiftMonth({ year, month }, 1));
}

/**
 * The month keys a connector's "is this day already charged?" read must cover for calendar month
 * `monthKey`: the month itself AND the month after it. An office-cycle row for payroll month P
 * carries the 22nd–31st of the month before P, so a day of calendar month C may live on a row keyed
 * C OR C+1. The claims are matched by DATE, so reading the extra month never claims a wrong day.
 */
export function ledgerClaimMonthKeys(monthKey: string): string[] {
  return [monthKey, nextMonthKey(monthKey)];
}

/** True from the cutover payroll month on — the population is split only then. */
export function isSplitCycleMonth(period: PayrollMonth): boolean {
  return monthKeyOf(period) >= OFFICE_CYCLE_FIRST_MONTH_KEY;
}

/**
 * The days one cycle judges for one payroll month. Throws for an office window before the cutover,
 * because there is none: September 2026 and earlier were collected on the calendar month.
 */
export function cycleWindow(cycle: DeductionCycle, period: PayrollMonth): CycleWindow {
  const monthKey = monthKeyOf(period);
  if (cycle === "calendar") {
    return { cycle, monthKey, start: `${monthKey}-01`, end: `${monthKey}-${pad2(lastDayOfMonth(period))}` };
  }
  if (monthKey < OFFICE_CYCLE_FIRST_MONTH_KEY) {
    throw new Error(
      `Validation: the Head Office cycle (22nd → 21st) starts with the October 2026 payroll month; ` +
        `${monthKey} was collected on the calendar month for everyone.`,
    );
  }
  const end = `${monthKey}-${pad2(OFFICE_CYCLE_CLOSE_DAY)}`;
  if (monthKey === OFFICE_CYCLE_FIRST_MONTH_KEY) {
    return { cycle, monthKey, start: `${monthKey}-01`, end };
  }
  const previous = shiftMonth(period, -1);
  return { cycle, monthKey, start: `${monthKeyOf(previous)}-${pad2(OFFICE_CYCLE_CLOSE_DAY + 1)}`, end };
}

/**
 * A window is collectable only once its LAST day has ended in Cairo — the same rule as the calendar
 * month guard (the 39,225.73 EGP incident), drawn at the window's own end. `todayIso` is Cairo.
 */
export function isCycleWindowCollectable(window: CycleWindow, todayIso: string): boolean {
  return window.end < todayIso;
}

/** The calendar months a window touches, oldest first — the office window touches two. */
export function calendarMonthsInWindow(window: CycleWindow): PayrollMonth[] {
  const months: PayrollMonth[] = [];
  const [startYear, startMonth] = window.start.split("-").map((part) => Number.parseInt(part, 10));
  let cursor: PayrollMonth = { year: startYear, month: startMonth };
  while (`${monthKeyOf(cursor)}-01` <= window.end) {
    months.push(cursor);
    cursor = shiftMonth(cursor, 1);
  }
  return months;
}

/**
 * Who a cycle covers in a payroll month. `isOnePart` answers from the employee directory's
 * `salaryPaymentMode` (the same field payroll reads, unknown → two parts).
 *   - Before the cutover: the calendar run covers EVERYONE; the office run covers no one.
 *   - From the cutover: office = one part, calendar = everyone else. Every employee is on exactly one.
 */
export function cycleCoversEmployee(
  cycle: DeductionCycle,
  period: PayrollMonth,
  isOnePart: boolean,
): boolean {
  if (!isSplitCycleMonth(period)) return cycle === "calendar";
  return cycle === "office" ? isOnePart : !isOnePart;
}

/**
 * The payroll month ONE day is charged to, for a path that writes a single day outside a collection
 * run (the Employee Day Report). It must land on the SAME month the collection run keys it to, or the
 * same day sits on two rows of two months and is charged twice:
 *   - two parts, or any day before the cutover month → its own calendar month;
 *   - one part, from the cutover → the 1st–21st stay in their month, the 22nd on moves to the NEXT
 *     payroll month, carrying the office marker that lets its date sit outside that month.
 */
export function dayChargeTarget(
  dateIso: string,
  isOnePart: boolean,
): { monthKey: string; month: number; year: number; cycleEvidence: DeductionCycleEvidence | null } {
  const calendarKey = dateIso.slice(0, 7);
  const [calendarYear, calendarMonth] = calendarKey.split("-").map((part) => Number.parseInt(part, 10));
  if (!isOnePart || calendarKey < OFFICE_CYCLE_FIRST_MONTH_KEY) {
    return { monthKey: calendarKey, month: calendarMonth, year: calendarYear, cycleEvidence: null };
  }
  const day = Number.parseInt(dateIso.slice(8, 10), 10);
  const period = day > OFFICE_CYCLE_CLOSE_DAY
    ? shiftMonth({ year: calendarYear, month: calendarMonth }, 1)
    : { year: calendarYear, month: calendarMonth };
  const window = cycleWindow("office", period);
  return {
    monthKey: window.monthKey,
    month: period.month,
    year: period.year,
    cycleEvidence: { cycle: "office", windowStart: window.start, windowEnd: window.end, calendarMonths: [calendarKey] },
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The marker `validateCandidateDraft` reads before it lets a date outside the month through. */
export type DeductionCycleEvidence = {
  cycle: "office";
  windowStart: string;
  windowEnd: string;
  /** The calendar months whose connector runs this row was built from, oldest first. */
  calendarMonths: string[];
};

export function readDeductionCycleEvidence(evidence: unknown): DeductionCycleEvidence | null {
  if (!evidence || typeof evidence !== "object") return null;
  const value = (evidence as Record<string, unknown>).deductionCycle;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.cycle !== "office") return null;
  if (typeof record.windowStart !== "string" || typeof record.windowEnd !== "string") return null;
  return {
    cycle: "office",
    windowStart: record.windowStart,
    windowEnd: record.windowEnd,
    calendarMonths: Array.isArray(record.calendarMonths) ? record.calendarMonths.map(String) : [],
  };
}

/**
 * The window a draft's dates may span: its own calendar month, or — for a draft marked as an office
 * cycle row — EXACTLY the office window of its payroll month. The marker cannot widen the window:
 * it must name the window this module computes for that month, or the draft is held to its month.
 */
export function allowedDraftDateWindow(draft: Pick<DeductionsCandidateDraft, "month" | "year" | "evidence">): {
  start: string;
  end: string;
} {
  const period = { month: draft.month, year: draft.year };
  const calendar = cycleWindow("calendar", period);
  const marker = readDeductionCycleEvidence(draft.evidence);
  if (!marker || !isSplitCycleMonth(period)) return { start: calendar.start, end: calendar.end };
  const office = cycleWindow("office", period);
  if (marker.windowStart !== office.start || marker.windowEnd !== office.end) {
    return { start: calendar.start, end: calendar.end };
  }
  return { start: office.start, end: office.end };
}

/**
 * Clips one connector draft (built for a CALENDAR month) to an office window and re-keys it to the
 * window's payroll month. Null when none of its days fall inside the window.
 *
 * The day count and amount scale by the kept fraction through `scaleDeductionAmountToDays`, the same
 * arithmetic the daily module and a narrowed decision use. When every day is kept the figures pass
 * through untouched, so a finding wholly inside the window is the connector's own number to the
 * piaster.
 */
export function clipDraftToCycleWindow(
  draft: DeductionsCandidateDraft,
  window: CycleWindow,
  sourceCalendarMonthKey: string,
): DeductionsCandidateDraft | null {
  const dates = Array.isArray(draft.dates) ? draft.dates : [];
  const kept = [...new Set(dates.filter((date) => date >= window.start && date <= window.end))].sort();
  if (kept.length === 0) return null;
  const [year, month] = window.monthKey.split("-").map((part) => Number.parseInt(part, 10));

  const allKept = kept.length === new Set(dates).size;
  let rawValue = Number(draft.rawValue);
  let estimatedAmount = draft.estimatedAmount ?? null;
  let calculationStatus = draft.calculationStatus;
  if (!allKept) {
    const fraction = kept.length / new Set(dates).size;
    // A CRM row is priced on what its kept days WEIGH (a Thursday is half), not on their count.
    const scaled = scaleDeductionAmountToKeptDates({
      appliedDays: rawValue * fraction,
      category: draft.category,
      detectedDates: dates,
      estimatedAmount,
      keptDates: kept,
      rawValue,
    });
    rawValue = round2(rawValue * fraction);
    if (estimatedAmount != null && scaled == null) calculationStatus = "requires_review";
    estimatedAmount = scaled;
  }

  return {
    ...draft,
    monthKey: window.monthKey,
    month,
    year,
    dates: kept,
    rawValue,
    estimatedAmount,
    calculationStatus,
    evidence: {
      ...(draft.evidence ?? {}),
      deductionCycle: {
        cycle: "office",
        windowStart: window.start,
        windowEnd: window.end,
        calendarMonths: [sourceCalendarMonthKey],
      } satisfies DeductionCycleEvidence,
    },
  };
}

function draftIdentity(draft: DeductionsCandidateDraft): string {
  return [
    draft.sourceSystem.trim(),
    draft.sourceRecordId.trim(),
    compactDeductionsHrId(draft.employeeHrId) ?? draft.employeeHrId.trim(),
    draft.category,
  ].join("\u0000");
}

/**
 * Merges the clipped drafts of an office window that share an IDENTITY (source, record, employee,
 * category). A leave request that runs from 28 October to 3 November is ONE record the vacation
 * connector reports once per calendar month; in the November office window both halves land on the
 * same payroll month and must become one row — two rows with one identity would collide on the
 * ledger's unique key.
 *
 * Days are unioned, the day counts and amounts summed. If ANY part's amount is unknown the merged
 * amount is unknown and the row goes to review. Parts that claim the SAME day (a connector reporting a
 * day outside its own month) are never summed blind: the merge keeps the union, nulls the amount,
 * sends the row to review and says so in `notes`.
 */
export function mergeCycleDrafts(drafts: readonly DeductionsCandidateDraft[]): {
  drafts: DeductionsCandidateDraft[];
  notes: string[];
} {
  const byIdentity = new Map<string, DeductionsCandidateDraft>();
  const order: string[] = [];
  const notes: string[] = [];
  for (const draft of drafts) {
    const identity = draftIdentity(draft);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, draft);
      order.push(identity);
      continue;
    }
    const existingDates = new Set(existing.dates);
    const overlap = draft.dates.filter((date) => existingDates.has(date));
    const dates = [...new Set([...existing.dates, ...draft.dates])].sort();
    const amountKnown = existing.estimatedAmount != null && draft.estimatedAmount != null && overlap.length === 0;
    const existingMarker = readDeductionCycleEvidence(existing.evidence);
    const draftMarker = readDeductionCycleEvidence(draft.evidence);
    const calendarMonths = [
      ...new Set([...(existingMarker?.calendarMonths ?? []), ...(draftMarker?.calendarMonths ?? [])]),
    ].sort();
    if (overlap.length > 0) {
      notes.push(
        `${existing.employeeName ?? existing.employeeHrId}: two calendar months reported the same ` +
          `${existing.category} day(s) ${overlap.join(", ")} — the row is held for review with no amount, never charged twice.`,
      );
    }
    byIdentity.set(identity, {
      ...existing,
      dates,
      rawValue: overlap.length > 0 ? dates.length : round2(Number(existing.rawValue) + Number(draft.rawValue)),
      estimatedAmount: amountKnown
        ? round2(Number(existing.estimatedAmount) + Number(draft.estimatedAmount))
        : null,
      calculationStatus:
        amountKnown && existing.calculationStatus !== "requires_review" && draft.calculationStatus !== "requires_review"
          ? existing.calculationStatus
          : "requires_review",
      evidence: {
        ...(existing.evidence ?? {}),
        mergedCalendarParts: [
          ...((existing.evidence?.mergedCalendarParts as unknown[] | undefined) ?? [existing.evidence ?? {}]),
          draft.evidence ?? {},
        ],
        deductionCycle: existingMarker
          ? { ...existingMarker, calendarMonths }
          : existing.evidence?.deductionCycle,
      },
    });
  }
  return { drafts: order.map((identity) => byIdentity.get(identity)!), notes };
}

/** "October 2026" — the label a calendar-month note is prefixed with in an office run. */
export function calendarMonthLabel(period: PayrollMonth): string {
  return new Date(Date.UTC(period.year, period.month - 1, 1)).toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "22 October → 21 November 2026" — how a window is named on screen and in notes. */
export function cycleWindowLabel(window: CycleWindow): string {
  const format = (iso: string, withYear: boolean) =>
    new Date(`${iso}T00:00:00Z`).toLocaleString("en-GB", {
      day: "numeric",
      month: "long",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  const sameYear = window.start.slice(0, 4) === window.end.slice(0, 4);
  return `${format(window.start, !sameYear)} → ${format(window.end, true)}`;
}
