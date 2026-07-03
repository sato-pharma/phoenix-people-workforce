// Flexible-hours attendance engine — the calculation behind the weekly digest.
//
// Owner-confirmed model (2026-07-03, see memory attendance-weekly-digest-selfsettlement-spec):
//   • Standard day 9:00 → 17:00; the real requirement is a MINIMUM presence
//     (7h50m = 470 minutes).
//   • Arrival is free up to a flex ceiling (9:30). Lateness is counted from the
//     flex ceiling, not the standard start — a 10:00 arrival is 30 minutes late.
//   • Expected leave = arrival + requiredMinutes; leaving before that is a
//     short-hours shortfall.
//   • Completing the required hours HALVES a late penalty (exact ÷2): 30 min late
//     is normally a half-day, but if the hours were still completed it is a quarter-day.
//   • If a day is BOTH late and short, apply the WORSE of the two (larger deduction),
//     never both.
//   • Deduction size is the exact bracket value — no rounding, no escalation.
//   • A missing punch (only one punch) is never auto-deducted here; it is flagged
//     for the A-13 → HR → COO verification chain handled by the settlement layer.
//
// This module is pure and side-effect free so it can be unit-tested directly and
// reused by the digest generator, the reports, and the dry-run tooling.

export type FlexibleHoursConfig = {
  /** Standard start, minutes from midnight (09:00 = 540). Kept for reference/UI. */
  scheduledStartMinutes: number;
  /** Flex ceiling, minutes from midnight (09:30 = 570). Lateness is counted from here. */
  flexCeilingMinutes: number;
  /** Minimum required presence in minutes (7h50m = 470). */
  requiredMinutes: number;
};

export type DeductionBracket = {
  /** Inclusive lower bound in minutes. */
  fromMinutes: number;
  /** Inclusive upper bound in minutes; null means open-ended. */
  toMinutes: number | null;
  /** Exact deduction in days (e.g. 0.25, 0.5, 1). No rounding is applied. */
  deductionDays: number;
};

export type FlexibleHoursInput = {
  /** First punch of the day, minutes from midnight. null when unknown. */
  firstPunchMinutes: number | null;
  /** Last punch of the day, minutes from midnight. null when unknown. */
  lastPunchMinutes: number | null;
  /** Number of usable punches seen for the day. <= 1 means a missing punch. */
  visiblePunchCount: number;
  config: FlexibleHoursConfig;
  /** Brackets mapping lateness-minutes → deduction days. */
  lateBrackets: DeductionBracket[];
  /** Brackets mapping short-minutes → deduction days. */
  shortBrackets: DeductionBracket[];
};

export type FlexibleHoursStatus = "Complete" | "Late" | "Short hours" | "Missing punch";

export type FlexibleHoursResult = {
  status: FlexibleHoursStatus;
  /** Minutes late past the flex ceiling (0 when on time). */
  lateMinutes: number;
  /** Minutes short of the required presence (0 when hours completed). */
  shortMinutes: number;
  /** Actual minutes present (last − first). */
  workedMinutes: number;
  /** Exact deduction in days — the number that flows to the digest. */
  deductionDays: number;
  /** True when the required hours were completed. */
  hoursCompleted: boolean;
  /** True when a late penalty was halved because the hours were completed. */
  halved: boolean;
  /** Plain-language explanation for the digest line. */
  reason: string;
};

/**
 * Returns the deduction (in days) for a minute value against a bracket set.
 * Brackets are inclusive on both bounds; `toMinutes: null` is open-ended.
 * Minutes at or below zero, or falling outside every bracket (e.g. a
 * below-first-bracket "dead zone"), yield 0.
 */
export function bracketDeductionDays(brackets: DeductionBracket[], minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  const match = brackets.find(
    (bracket) =>
      minutes >= bracket.fromMinutes && (bracket.toMinutes == null || minutes <= bracket.toMinutes),
  );
  return match ? match.deductionDays : 0;
}

/**
 * Evaluate a single employee-day under the flexible-hours model.
 * The result carries both the classified status and the exact deduction days.
 */
export function evaluateFlexibleHoursDay(input: FlexibleHoursInput): FlexibleHoursResult {
  const { config } = input;

  // Missing punch: only one (or no) usable punch. Never auto-deducted here —
  // routed to the A-13 → HR → COO verification chain by the settlement layer.
  if (input.visiblePunchCount <= 1 || input.firstPunchMinutes == null || input.lastPunchMinutes == null) {
    return {
      status: "Missing punch",
      lateMinutes: 0,
      shortMinutes: 0,
      workedMinutes: 0,
      deductionDays: 0,
      hoursCompleted: false,
      halved: false,
      reason: "Only one punch recorded — needs verification before any deduction.",
    };
  }

  const workedMinutes = Math.max(0, input.lastPunchMinutes - input.firstPunchMinutes);
  const lateMinutes = Math.max(0, input.firstPunchMinutes - config.flexCeilingMinutes);
  const shortMinutes = Math.max(0, config.requiredMinutes - workedMinutes);
  const hoursCompleted = shortMinutes === 0;

  if (lateMinutes === 0 && shortMinutes === 0) {
    return {
      status: "Complete",
      lateMinutes,
      shortMinutes,
      workedMinutes,
      deductionDays: 0,
      hoursCompleted: true,
      halved: false,
      reason: "On time and full hours.",
    };
  }

  const lateDeduction = bracketDeductionDays(input.lateBrackets, lateMinutes);
  const shortDeduction = bracketDeductionDays(input.shortBrackets, shortMinutes);

  // Late but hours completed → the late penalty is halved (exact ÷2).
  if (lateMinutes > 0 && shortMinutes === 0) {
    return {
      status: "Late",
      lateMinutes,
      shortMinutes,
      workedMinutes,
      deductionDays: lateDeduction / 2,
      hoursCompleted: true,
      halved: true,
      reason: `Late ${lateMinutes} min but completed the required hours — penalty halved.`,
    };
  }

  // Both late and short → take the worse (larger) of the two, no halving.
  if (lateMinutes > 0 && shortMinutes > 0) {
    if (shortDeduction >= lateDeduction) {
      return {
        status: "Short hours",
        lateMinutes,
        shortMinutes,
        workedMinutes,
        deductionDays: shortDeduction,
        hoursCompleted: false,
        halved: false,
        reason: `Late ${lateMinutes} min and short ${shortMinutes} min — short-hours penalty applies (the worse of the two).`,
      };
    }
    return {
      status: "Late",
      lateMinutes,
      shortMinutes,
      workedMinutes,
      deductionDays: lateDeduction,
      hoursCompleted: false,
      halved: false,
      reason: `Late ${lateMinutes} min and short ${shortMinutes} min — lateness penalty applies (the worse of the two).`,
    };
  }

  // Only short on hours.
  return {
    status: "Short hours",
    lateMinutes,
    shortMinutes,
    workedMinutes,
    deductionDays: shortDeduction,
    hoursCompleted: false,
    halved: false,
    reason: `Short ${shortMinutes} min of the required presence.`,
  };
}
