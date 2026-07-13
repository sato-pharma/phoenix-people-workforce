// Probation feedback SLA (Phase 4, P4-T06/T07). Pure, config-driven.
//
// The SLA clock for a DV-Day feedback starts at the field day (dv_date): feedback is due
// dueHours after, escalates at escalateHours, and is overdue at overdueHours. Values come from
// probation_config.sla (never hard-coded at call sites). The computed STATE drives deduplicated,
// state-based reminders/escalations — a reminder fires on a state transition, not on a daily timer.

import type { ProbationSlaPolicy } from "./config";

export type FeedbackSlaState = "pending" | "due" | "escalated" | "overdue";

export type FeedbackSlaStatus = {
  state: FeedbackSlaState;
  anchorAt: string; // ISO — when the clock started (the field day)
  dueAt: string;
  escalateAt: string;
  overdueAt: string;
  /** Hours until due (negative once past due). */
  hoursUntilDue: number;
  /** Hours past the overdue threshold (0 until overdue). */
  hoursOverdue: number;
};

const HOUR_MS = 3_600_000;

function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * HOUR_MS).toISOString();
}

/** Anchor the SLA clock at the start (midnight) of the DV field day. */
export function slaAnchorFromDvDate(dvDate: string): string {
  // dvDate is a YYYY-MM-DD date-only; anchor at UTC midnight of that day.
  return new Date(`${dvDate}T00:00:00.000Z`).toISOString();
}

/**
 * Compute the SLA status for a still-open feedback task as of `nowIso`.
 * `sla` hours must be non-decreasing (due ≤ escalate ≤ overdue); callers pass config.sla.
 *
 * `anchorFloorIso` (the DV-Day's created/synced timestamp) guarantees the evaluator always gets the
 * full dueHours window measured from when the task actually became actionable — not from the field
 * day. Without it, a DV-Day synced/backfilled days after its field date is born past `overdueAt` and
 * instantly fires a critical escalation the evaluator never had a chance to answer.
 */
export function computeFeedbackSla(
  dvDate: string,
  nowIso: string,
  sla: ProbationSlaPolicy,
  anchorFloorIso?: string | null,
): FeedbackSlaStatus {
  const dvAnchor = slaAnchorFromDvDate(dvDate);
  const anchorAt = anchorFloorIso && new Date(anchorFloorIso).getTime() > new Date(dvAnchor).getTime()
    ? new Date(anchorFloorIso).toISOString()
    : dvAnchor;
  const dueAt = addHours(anchorAt, sla.dueHours);
  const escalateAt = addHours(anchorAt, sla.escalateHours);
  const overdueAt = addHours(anchorAt, sla.overdueHours);

  const now = new Date(nowIso).getTime();
  const hoursUntilDue = (new Date(dueAt).getTime() - now) / HOUR_MS;
  const hoursOverdue = now > new Date(overdueAt).getTime()
    ? (now - new Date(overdueAt).getTime()) / HOUR_MS
    : 0;

  let state: FeedbackSlaState = "pending";
  if (now >= new Date(overdueAt).getTime()) state = "overdue";
  else if (now >= new Date(escalateAt).getTime()) state = "escalated";
  else if (now >= new Date(dueAt).getTime()) state = "due";

  return {
    state,
    anchorAt,
    dueAt,
    escalateAt,
    overdueAt,
    hoursUntilDue: Math.round(hoursUntilDue * 10) / 10,
    hoursOverdue: Math.round(hoursOverdue * 10) / 10,
  };
}

/**
 * The dedup key for a state-based reminder: one notification per (dvDay, state). Re-running the
 * reminder sweep never re-sends the same state's reminder — only a NEW state transition does.
 */
export function slaReminderKey(dvDayId: string, state: FeedbackSlaState): string {
  return `probation:feedback-sla:${dvDayId}:${state}`;
}
