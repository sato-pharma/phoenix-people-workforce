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
//   • If a day is BOTH late and short, apply only the LARGER deduction, never both.
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
  /**
   * Plain-language explanation for the digest line; null when it would only restate the status or the
   * Late and Short minutes the row already shows.
   */
  reason: string | null;
};

/**
 * An approved half-day vacation (Am Only / Pm Only) covers exactly one half of
 * the shift — the other half still expects a punch, but only against HALF the
 * normal required presence, not the full day. Rounds to the nearest minute so a
 * requiredMinutes that isn't evenly divisible (e.g. 470 -> 235) never silently
 * truncates.
 */
export function requiredMinutesForHalfDayVacation(
  fullRequiredMinutes: number,
  halfDayVacationPart: "am_only" | "pm_only" | null,
): number {
  return halfDayVacationPart ? Math.round(fullRequiredMinutes / 2) : fullRequiredMinutes;
}

/**
 * Where the WORKED half of a half-day vacation begins, in minutes from midnight.
 *
 * Halving the required presence (above) only ever fixed the SHORT-HOURS half of
 * the judgment. Lateness is measured from the scheduled start, and on an Am-Only
 * vacation that start is a time the employee was formally excused from — so an
 * afternoon arrival was scored as hours of lateness against a morning they had
 * approved off, even after completing the halved hours in full.
 *
 * `halfRequiredMinutes` is the already-halved figure from
 * requiredMinutesForHalfDayVacation, so the afternoon half opens exactly that far
 * after the scheduled start. Pm-Only is unchanged: the employee still owes the
 * morning, so the normal start already applies.
 *
 * Owner decision 2026-09-08, asked and answered: judge the worked half.
 */
export function halfDayEffectiveStartMinutes(
  scheduledStartMinutes: number,
  halfRequiredMinutes: number,
  halfDayVacationPart: "am_only" | "pm_only" | null,
): number {
  return halfDayVacationPart === "am_only" ? scheduledStartMinutes + halfRequiredMinutes : scheduledStartMinutes;
}

/**
 * BOTH ends of the worked half — for the legacy grace-period engine, which the two
 * policy groups with no `required_minutes` still route through.
 *
 * The flexible-hours engine needed only the start moved, because it judges presence
 * as worked-minutes against a requirement and has no concept of leaving early. The
 * legacy engine measures early leave against `scheduled_end`, so a Pm-Only vacation
 * breaks there in the mirror-image way: the employee works the morning, leaves at
 * the midpoint exactly as agreed, and is scored as hours of early leave against an
 * evening they had approved off. Moving only the start would have fixed Am-Only on
 * that path and left Pm-Only just as wrong.
 *
 * So: Am-Only moves the START forward to where the afternoon begins; Pm-Only pulls
 * the END back to where the morning ends. Neither moves both, because exactly one
 * half is owed. The start is delegated rather than recomputed so there is one
 * definition of where the worked half begins.
 *
 * `scheduledEndMinutes` must already be normalized past midnight by the caller
 * (end + 1440 for an overnight shift); this function does no wrapping of its own.
 */
export function halfDayEffectiveWindowMinutes(input: {
  scheduledStartMinutes: number;
  scheduledEndMinutes: number;
  halfRequiredMinutes: number;
  halfDayVacationPart: "am_only" | "pm_only" | null;
}): { startMinutes: number; endMinutes: number } {
  return {
    startMinutes: halfDayEffectiveStartMinutes(
      input.scheduledStartMinutes,
      input.halfRequiredMinutes,
      input.halfDayVacationPart,
    ),
    endMinutes:
      input.halfDayVacationPart === "pm_only"
        ? input.scheduledStartMinutes + input.halfRequiredMinutes
        : input.scheduledEndMinutes,
  };
}

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

export type AttendancePolicyRuleRow = {
  policy_id: number;
  event_type: string | null;
  from_minutes: number | null;
  to_minutes: number | null;
  deduction_days: number | string | null;
  is_active: boolean | null;
};

/**
 * Builds one policy's bracket set for one event type ("late" / "short_hours") from raw
 * attendance_policy_rules rows. Shared by every consumer of this engine (the weekly-digest
 * generator and the fingerprint report) so there is exactly one place that turns DB rows into
 * brackets — two independent copies of this mapping is how a rule-table gap (e.g. a policy
 * missing its short_hours rows) would silently diverge between the two, i.e. exactly the
 * fingerprint-report-vs-digest inconsistency this engine already had to be reconciled with once.
 */
export function bracketsForEventType(
  rules: AttendancePolicyRuleRow[],
  policyId: number,
  eventType: string,
): DeductionBracket[] {
  return rules
    .filter((rule) => rule.policy_id === policyId && rule.event_type === eventType && rule.is_active !== false)
    .map((rule) => ({
      fromMinutes: rule.from_minutes ?? 1,
      toMinutes: rule.to_minutes,
      deductionDays: Number(rule.deduction_days) || 0,
    }))
    .sort((left, right) => left.fromMinutes - right.fromMinutes);
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
      hoursCompleted,
      halved: false,
      reason: null,
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
      hoursCompleted,
      halved: true,
      reason: "Hours completed — late penalty halved.",
    };
  }

  // Both late and short → only the larger deduction applies, no halving. The reason text names
  // only the penalty that applies; the owner ruled the old comparative wording is never shown (2026-09-17).
  if (lateMinutes > 0 && shortMinutes > 0) {
    if (shortDeduction >= lateDeduction) {
      return {
        status: "Short hours",
        lateMinutes,
        shortMinutes,
        workedMinutes,
        deductionDays: shortDeduction,
        hoursCompleted,
        halved: false,
        reason: "Late and short — short-hours penalty applies.",
      };
    }
    return {
      status: "Late",
      lateMinutes,
      shortMinutes,
      workedMinutes,
      deductionDays: lateDeduction,
      hoursCompleted,
      halved: false,
      reason: "Late and short — lateness penalty applies.",
    };
  }

  // Only short on hours.
  return {
    status: "Short hours",
    lateMinutes,
    shortMinutes,
    workedMinutes,
    deductionDays: shortDeduction,
    hoursCompleted,
    halved: false,
    reason: "Short of the required presence.",
  };
}
