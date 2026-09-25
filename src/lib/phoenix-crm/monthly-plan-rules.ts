/**
 * Phoenix CRM — the monthly plan's rules, with no I/O.
 *
 * Owner, 2026-09-25: a rep makes ONE monthly plan — a real calendar of dated placements — and his
 * weekly plans are that plan's weeks. The system helps him build it in step with frequency, coverage
 * and the call rate. He approves the month once; a later edit to one week needs that week approved
 * again. Planning a doctor MORE than his grade needs is allowed and shown as a deviation, never blocked.
 *
 * The month owns the field-weeks whose Saturday (`week_start`) falls in the calendar month
 * (calendar.ts `fieldWeeksOfMonth`) — one month per week, so a week straddling a month edge sits wholly
 * in the month its Saturday is in. Storage stays per-week (the weekly plan tables): the month is an
 * umbrella that cascades submit / approve / return down to its weeks.
 *
 * The meters here read the PLAN — the dated placements the rep has made this month — not the visits
 * already done: this is what the rep is building and controls. AM and PM are ALWAYS reported apart and
 * NEVER averaged (the call-rate golden rule).
 */

import { monthEndOf, monthStartOf, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { addDaysIso } from "@/lib/crm/dates";
import { gradeTarget, sharePercent } from "@/lib/phoenix-crm/coverage";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmPlanStatus, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";

/**
 * The days a call rate is scored over: Saturday to Wednesday (src/lib/crm/call-rate.ts
 * CALL_RATE_WEEKDAYS, owner). Thursday is a half day and Friday is off, so neither counts. Copied, not
 * imported, so the phone bundle never pulls the report module in; tests/phoenix-crm-monthly-plan.test.ts
 * keeps the two equal.
 */
const CALL_RATE_WEEKDAYS: ReadonlySet<number> = new Set([6, 0, 1, 2, 3]);

export function monthlyPlanStatusLabel(status: PhoenixCrmPlanStatus | null): string {
  if (status === "submitted") return "Waiting for review";
  if (status === "approved") return "Approved";
  if (status === "returned") return "Returned for changes";
  if (status === "draft") return "Draft";
  return "Not started";
}

/** A rep edits a draft or a returned month. A submitted or approved month is reopened first. */
export function isMonthlyPlanEditable(status: PhoenixCrmPlanStatus | null): boolean {
  return status === null || status === "draft" || status === "returned";
}

// ── One doctor across the month ───────────────────────────────────────────────────────────────────

export type DoctorMonthInput = {
  customerId: string;
  listType: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  /** Dated placements of this customer across the month's field-weeks. */
  placed: number;
};

export type DoctorMonthTally = DoctorMonthInput & {
  /** His grade's monthly frequency norm; null when the grade has no number (so no norm to meet). */
  required: number | null;
  /** placed − required; null when there is no norm. Positive is over the norm — a deviation, allowed. */
  deviation: number | null;
  /** Placed on or over the norm. A customer with no norm is done once placed at least once. */
  done: boolean;
};

export function tallyDoctorMonth(input: DoctorMonthInput, settings: Pick<PhoenixCrmSettings, "gradeTargets">): DoctorMonthTally {
  const required = gradeTarget(settings, input.listType, input.grade);
  const deviation = required === null ? null : input.placed - required;
  const done = required === null ? input.placed > 0 : input.placed >= required;
  return { ...input, required, deviation, done };
}

// ── The month's meters, per list ──────────────────────────────────────────────────────────────────

export type MonthlyListMeter = {
  listType: PhoenixCrmListType;
  /** Customers of this list on the panel (a customer not validated yet is left out — he has no norm). */
  panel: number;
  /** Placed on at least one day this month. */
  covered: number;
  coveragePct: number | null;
  /** Customers with a grade norm to meet. */
  withNorm: number;
  /** Placed on or over their norm. */
  metNorm: number;
  /** Placed over their norm — the deviations (allowed, shown, never blocked). */
  overNorm: number;
  /** Placed under their norm (behind), including not placed at all. */
  underNorm: number;
  frequencyPct: number | null;
  /** Total dated placements of this list across the month. */
  placements: number;
};

/** One list at a time — AM and PM are never added together (the call-rate golden rule: never averaged). */
export function summarizeMonthlyList(tallies: ReadonlyArray<DoctorMonthTally>, listType: PhoenixCrmListType): MonthlyListMeter {
  let panel = 0;
  let covered = 0;
  let withNorm = 0;
  let metNorm = 0;
  let overNorm = 0;
  let underNorm = 0;
  let placements = 0;
  for (const tally of tallies) {
    if (tally.listType !== listType) continue;
    panel += 1;
    placements += tally.placed;
    if (tally.placed > 0) covered += 1;
    if (tally.required === null) continue;
    withNorm += 1;
    if (tally.placed > tally.required) overNorm += 1;
    if (tally.placed >= tally.required) metNorm += 1;
    else underNorm += 1;
  }
  return {
    listType,
    panel,
    covered,
    coveragePct: sharePercent(covered, panel),
    withNorm,
    metNorm,
    overNorm,
    underNorm,
    frequencyPct: sharePercent(metNorm, withNorm),
    placements,
  };
}

// ── The month's call rate ─────────────────────────────────────────────────────────────────────────

/** The Saturday-to-Wednesday working days that fall in the calendar month of `monthStart`. */
export function callRateWorkingDaysOfMonth(monthStart: string): number {
  const end = monthEndOf(monthStart);
  let count = 0;
  for (let day = monthStartOf(monthStart); day <= end; day = addDaysIso(day, 1)) {
    if (CALL_RATE_WEEKDAYS.has(weekdayOfIsoDay(day))) count += 1;
  }
  return count;
}

export type MonthlyCallRate = {
  /** Saturday-to-Wednesday days in the month — the call rate's denominator. */
  workingDays: number;
  amPlacements: number;
  pmPlacements: number;
  /** Per working day, one decimal; null when the month has no working days. */
  amPerDay: number | null;
  pmPerDay: number | null;
  amTarget: number;
  pmTarget: number;
  /** The whole month's expected placements at the target rate — target × working days. */
  amExpected: number;
  pmExpected: number;
};

export function monthlyCallRate(
  input: { monthStart: string; amPlacements: number; pmPlacements: number },
  settings: Pick<PhoenixCrmSettings, "callRateAmTarget" | "callRatePmTarget">,
): MonthlyCallRate {
  const workingDays = callRateWorkingDaysOfMonth(input.monthStart);
  const perDay = (placements: number) => (workingDays <= 0 ? null : Math.round((placements / workingDays) * 10) / 10);
  return {
    workingDays,
    amPlacements: input.amPlacements,
    pmPlacements: input.pmPlacements,
    amPerDay: perDay(input.amPlacements),
    pmPerDay: perDay(input.pmPlacements),
    amTarget: settings.callRateAmTarget,
    pmTarget: settings.callRatePmTarget,
    amExpected: settings.callRateAmTarget * workingDays,
    pmExpected: settings.callRatePmTarget * workingDays,
  };
}
