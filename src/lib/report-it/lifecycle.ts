import { REPORT_IT_STATUSES, type ReportItStatus } from "./types";

/**
 * THE SAFETY-REPORT LIFECYCLE (audit REC-033, owner 13 Nov 2026) — the pure rules, no database.
 *
 * received → under assessment → closed. One step at a time, forward only: there is no reopen,
 * because nothing in the module needs one (a closed report that needs more work is a follow-up
 * report). `phx_report_it_set_status` in the migration enforces the same two moves.
 *
 * The due date: NOTHING IN THE REPOSITORY STATED ONE, so this is the owner's brief default, which
 * follows common pharmacovigilance practice (ICH E2D / EU GVP Module VI) — a serious case within 15
 * calendar days of receipt, any other within 90. The migration backfilled existing rows with the
 * same two numbers, and `tests/report-it-lifecycle.test.ts` pins that they match.
 */

export const REPORT_IT_DUE_DAYS = { serious: 15, nonSerious: 90 } as const;

/** The only moves a report can make: from → to. */
export const REPORT_IT_TRANSITIONS: Readonly<Record<ReportItStatus, ReportItStatus | null>> = {
  received: "under_assessment",
  under_assessment: "closed",
  closed: null,
};

/** The statuses a report is still open in — the desk's due-date view. */
export const REPORT_IT_OPEN_STATUSES: readonly ReportItStatus[] = ["received", "under_assessment"];

export function isReportItStatus(value: unknown): value is ReportItStatus {
  return typeof value === "string" && (REPORT_IT_STATUSES as readonly string[]).includes(value);
}

/** A status stored before the lifecycle existed (`submitted`) reads as `received`. */
export function normalizeReportItStatus(value: unknown): ReportItStatus | null {
  const key = String(value ?? "").trim().toLowerCase();
  if (key === "submitted") return "received";
  return isReportItStatus(key) ? key : null;
}

/** The next status a report can move to, or null when it is closed (or unknown). */
export function nextReportItStatus(from: unknown): ReportItStatus | null {
  const status = normalizeReportItStatus(from);
  return status ? REPORT_IT_TRANSITIONS[status] : null;
}

/** Why a move is refused, in words for the person who pressed the button — or null when allowed. */
export function reportItTransitionRefusal(from: unknown, to: unknown): string | null {
  if (!isReportItStatus(to)) return "That is not a report status.";
  const current = normalizeReportItStatus(from);
  if (!current) return "This report's current status is not recognised.";
  if (current === to) return "The report already has that status.";
  if (REPORT_IT_TRANSITIONS[current] !== to) {
    return current === "closed"
      ? "A closed report cannot be changed."
      : "A report moves one step at a time: received, then under assessment, then closed.";
  }
  return null;
}

/** The due date of a report submitted at `submittedAt`: 15 calendar days if serious, else 90. */
export function reportItDueAt(submittedAt: string | Date, isSerious: boolean): string {
  const start = submittedAt instanceof Date ? submittedAt : new Date(submittedAt);
  const days = isSerious ? REPORT_IT_DUE_DAYS.serious : REPORT_IT_DUE_DAYS.nonSerious;
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** True when an open report's due date has passed. */
export function isReportItOverdue(dueAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!dueAt) return false;
  const due = Date.parse(dueAt);
  return Number.isFinite(due) && due < now.getTime();
}
