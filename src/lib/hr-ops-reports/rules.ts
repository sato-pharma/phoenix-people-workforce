// HR Daily & Weekly Reports — the rules of a review and a decision. Pure: no database, no clock.
//
// Owner, 2026-10-20: every row "confirm or rejct or recommend edit with reason"; deductions
// "recommend in days only; she will never take desicion". So:
//   - HER review is one of three actions. A reject or a recommended edit always says WHY; only a
//     recommended edit carries days, and only days.
//   - HIS decision approves (with the days that stand) or rejects. Nothing she does decides a row.
//   - A weekly row for a day already decided in its daily report is CARRIED: shown, never reviewed
//     or decided a second time. The database refuses a second approval of one person's day anyway
//     (hr_ops_report_lines_one_approved_day); this says it before a click gets that far.
// The migration's CHECK constraints say the same things; these run first so a person reads a
// sentence instead of a constraint name.

import {
  HR_OPS_DECISIONS,
  HR_OPS_REVIEW_ACTIONS,
  HrOpsReportsError,
  isHrOpsFlag,
  toDays,
  type HrOpsBridgeStatus,
  type HrOpsDecision,
  type HrOpsFlag,
  type HrOpsReportLineRow,
  type HrOpsReviewAction,
} from "./types";

/** No single day can carry more than a month of days, and a figure finer than a quarter-hour is noise. */
export const MAX_DAYS = 31;
export const REASON_MAX = 500;
export const COMMENT_MAX = 1000;

type LineFacts = Pick<HrOpsReportLineRow, "flags" | "carried_from_line_id" | "review_action" | "decision">;

export function lineFlags(line: Pick<HrOpsReportLineRow, "flags">): HrOpsFlag[] {
  return (line.flags ?? []).filter(isHrOpsFlag);
}

export function isCarried(line: Pick<HrOpsReportLineRow, "carried_from_line_id">): boolean {
  return Boolean(line.carried_from_line_id);
}

/** A row she must answer before she can submit: it has an issue and was not decided elsewhere. */
export function needsReview(line: LineFacts): boolean {
  return lineFlags(line).length > 0 && !isCarried(line);
}

/** A row he decides: one with an issue, or one she raised by reviewing it, not decided elsewhere. */
export function isDecidable(line: LineFacts): boolean {
  return !isCarried(line) && (lineFlags(line).length > 0 || line.review_action !== null);
}

export type ReportProgress = {
  total: number;
  flagged: number;
  carried: number;
  /** Flagged rows with no review yet. */
  toReview: number;
  reviewed: number;
  /** Decidable rows with no decision yet. */
  toDecide: number;
  decided: number;
};

export function reportProgress(lines: readonly LineFacts[]): ReportProgress {
  const progress: ReportProgress = { carried: 0, decided: 0, flagged: 0, reviewed: 0, toDecide: 0, toReview: 0, total: lines.length };
  for (const line of lines) {
    if (isCarried(line)) progress.carried += 1;
    if (lineFlags(line).length > 0) progress.flagged += 1;
    if (line.review_action) progress.reviewed += 1;
    if (needsReview(line) && !line.review_action) progress.toReview += 1;
    if (isDecidable(line)) {
      if (line.decision) progress.decided += 1;
      else progress.toDecide += 1;
    }
  }
  return progress;
}

function parseDays(value: unknown, what: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new HrOpsReportsError(`${what} must be a number of days, zero or more.`);
  if (parsed > MAX_DAYS) throw new HrOpsReportsError(`${what} cannot be more than ${MAX_DAYS} days for one day's row.`);
  return Math.round(parsed * 10_000) / 10_000;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type ReviewInput = {
  lineId: string;
  /** Null withdraws her review, while the report is still with her. */
  action: HrOpsReviewAction | null;
  reason: string | null;
  comment: string | null;
  recommendedDays: number | null;
};

/** Her review of one row, checked and normalised. Throws a refusal she can read. */
export function validateReview(raw: unknown): ReviewInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const lineId = text(body.lineId);
  if (!/^[0-9a-f-]{36}$/i.test(lineId)) throw new HrOpsReportsError("Choose a row to review.");
  if (body.action === null || body.action === "" || body.action === undefined) {
    return { action: null, comment: null, lineId, reason: null, recommendedDays: null };
  }
  const action = text(body.action) as HrOpsReviewAction;
  if (!(HR_OPS_REVIEW_ACTIONS as readonly string[]).includes(action)) throw new HrOpsReportsError("Choose Confirm, Reject or Recommend an edit.");
  const reason = text(body.reason);
  const comment = text(body.comment);
  if (reason.length > REASON_MAX) throw new HrOpsReportsError(`Keep the reason under ${REASON_MAX} characters.`);
  if (comment.length > COMMENT_MAX) throw new HrOpsReportsError(`Keep the comment under ${COMMENT_MAX} characters.`);
  if (action !== "confirm" && !reason) {
    throw new HrOpsReportsError(action === "reject" ? "Say why you are rejecting this row." : "Say why you recommend this edit.");
  }
  let recommendedDays: number | null = null;
  if (action === "recommend_edit") {
    if (body.recommendedDays === null || body.recommendedDays === undefined || body.recommendedDays === "") {
      throw new HrOpsReportsError("Recommend the number of days.");
    }
    recommendedDays = parseDays(body.recommendedDays, "The recommended days");
  }
  return { action, comment: comment || null, lineId, reason: reason || null, recommendedDays };
}

export type DecisionInput = {
  lineId: string;
  decision: HrOpsDecision;
  /** Approved: the days that stand. Rejected: null. */
  days: number | null;
};

/** His decision on one row, checked and normalised. */
export function validateDecision(raw: unknown): DecisionInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const lineId = text(body.lineId);
  if (!/^[0-9a-f-]{36}$/i.test(lineId)) throw new HrOpsReportsError("Choose a row to decide.");
  const decision = text(body.decision) as HrOpsDecision;
  if (!(HR_OPS_DECISIONS as readonly string[]).includes(decision)) throw new HrOpsReportsError("Choose Approve or Reject.");
  if (decision === "rejected") return { days: null, decision, lineId };
  if (body.days === null || body.days === undefined || body.days === "") throw new HrOpsReportsError("Say how many days stand.");
  return { days: parseDays(body.days, "The approved days"), decision, lineId };
}

/** The days his Approve starts from: her recommendation when she made one, else the policy's. */
export function defaultDecisionDays(line: Pick<HrOpsReportLineRow, "review_action" | "recommended_days" | "suggested_days">): number | null {
  if (line.review_action === "reject") return 0;
  if (line.review_action === "recommend_edit") return toDays(line.recommended_days);
  return toDays(line.suggested_days);
}

/** Where a decided row starts on its way into the weekly attendance review. */
export function bridgeStatusForDecision(decision: HrOpsDecision, days: number | null): HrOpsBridgeStatus {
  return decision === "approved" && (days ?? 0) > 0 ? "waiting" : "not_needed";
}

/**
 * A decided row may change only while nothing downstream has acted on it.
 *
 * `bridge_ref` is the weekly attendance review's own row for the day. Once it is set, the day
 * EXISTS in that review — even on a line whose last carry `failed` (a conflict found the day already
 * there), or one waiting on a released week — so a later rejection here would leave that day
 * ticked there with nothing pointing back at it. Such a row is changed in the weekly review.
 */
export function decisionIsOpen(line: Pick<HrOpsReportLineRow, "decision" | "bridge_status" | "bridge_ref">): boolean {
  if (!line.decision) return true;
  if (line.bridge_status === "bridged" || line.bridge_status === "week_released") return false;
  return !line.bridge_ref;
}
