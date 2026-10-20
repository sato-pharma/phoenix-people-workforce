// HR Daily & Weekly Reports — the rules of a review and a decision. Pure: no database, no clock.
//
// Owner, 2026-10-20: every row "confirm or rejct or recommend edit with reason"; deductions
// "recommend in days only; she will never take desicion". So:
//   - HER review is one of three actions. A reject or a recommended edit always says WHY; only a
//     recommended edit carries days, and only days.
//   - HIS decision approves (with the days that stand) or rejects. Nothing she does decides a row.
//   - A row for a day already decided in another report (its daily one, or the weekly one) is
//     CARRIED: shown, never reviewed or decided a second time. The database refuses a second approval
//     of one person's day anyway (hr_ops_report_lines_one_approved_day); this says it before a click
//     gets that far.
//   - At most MAX_DAYS (3) for one day's row — the weekly attendance review's own cap.
//   - An office row the weekly review can never hold is decided for the record and "Not carried".
// The migration's CHECK constraints say the same things; these run first so a person reads a
// sentence instead of a constraint name.

import { formatDayLong, parsePeriodKey } from "./periods";
import {
  HR_OPS_DECISIONS,
  HR_OPS_REVIEW_ACTIONS,
  HR_OPS_SECTION_LABELS,
  HR_OPS_SECTIONS,
  HrOpsReportsError,
  isHrOpsFlag,
  toDays,
  type HrOpsBridgeStatus,
  type HrOpsDecidedElsewhere,
  type HrOpsDecision,
  type HrOpsFlag,
  type HrOpsReportKind,
  type HrOpsReportLineRow,
  type HrOpsReviewAction,
  type HrOpsSection,
} from "./types";

/**
 * The most days one day's row can carry — the weekly attendance review's own cap. Its tick
 * (phx_attendance_mark_digest_line) and the bridge (phx_hr_ops_bridge_digest_day) refuse more than 3
 * for one day, so an approval above that could never reach the review; it is refused here, in words,
 * before it is saved.
 */
export const MAX_DAYS = 3;
export const REASON_MAX = 500;
export const COMMENT_MAX = 1000;

type LineFacts = Pick<HrOpsReportLineRow, "flags" | "carried_from_line_id" | "review_action" | "decision" | "decided_elsewhere">;

export function lineFlags(line: Pick<HrOpsReportLineRow, "flags">): HrOpsFlag[] {
  return (line.flags ?? []).filter(isHrOpsFlag);
}

/**
 * Shown, never reviewed or decided here: a weekly row the build CARRIED from its daily report, or a
 * row whose person-day was decided in ANOTHER report since (`decided_elsewhere`, set when the report
 * is read). Without the second half, a day still open in its daily report when the weekly one was
 * built sat in both; whichever was decided second was refused, so that report never reached "nothing
 * left to decide" and stayed Submitted for ever.
 */
export function isCarried(line: Pick<HrOpsReportLineRow, "carried_from_line_id"> & Partial<Pick<HrOpsReportLineRow, "decision" | "decided_elsewhere">>): boolean {
  if (line.carried_from_line_id) return true;
  return !line.decision && Boolean(line.decided_elsewhere);
}

/** "decided in the daily report of Monday 19 October 2026". */
export function decidedElsewhereText(elsewhere: HrOpsDecidedElsewhere): string {
  return `decided in the ${elsewhere.kind} report of ${formatDayLong(elsewhere.anchor)}`;
}

/**
 * Pure: mark every row of `lines` that is still undecided and not carried, whose person-day (section,
 * person, day) was decided in ANOTHER report. `decided` is the decided rows of the window (any report);
 * `reports` names each one's kind and period. A report that cannot be named is not used — the row then
 * stays as it was rather than pointing at nothing.
 */
export function markDecidedElsewhere<T extends Pick<HrOpsReportLineRow, "report_id" | "section" | "hr_key" | "work_date" | "decision" | "carried_from_line_id">>(
  lines: readonly T[],
  decided: ReadonlyArray<Pick<HrOpsReportLineRow, "id" | "report_id" | "section" | "hr_key" | "work_date" | "decision">>,
  reports: ReadonlyMap<string, { kind: HrOpsReportKind; period_key: string }>,
): Array<T & { decided_elsewhere: HrOpsDecidedElsewhere | null }> {
  const byDay = new Map<string, Array<Pick<HrOpsReportLineRow, "id" | "report_id">>>();
  for (const row of decided) {
    if (!row.decision) continue;
    const key = `${row.section}|${row.hr_key}|${row.work_date}`;
    const list = byDay.get(key) ?? [];
    list.push(row);
    byDay.set(key, list);
  }
  return lines.map((line) => {
    if (line.decision || line.carried_from_line_id) return { ...line, decided_elsewhere: null };
    const other = (byDay.get(`${line.section}|${line.hr_key}|${line.work_date}`) ?? [])
      .filter((row) => row.report_id !== line.report_id)
      .map((row) => ({ row, report: reports.get(row.report_id), period: parsePeriodKey(reports.get(row.report_id)?.period_key ?? "") }))
      .find((entry) => entry.report && entry.period);
    if (!other || !other.report || !other.period) return { ...line, decided_elsewhere: null };
    return {
      ...line,
      decided_elsewhere: { anchor: other.period.anchor, kind: other.report.kind, lineId: other.row.id, reportId: other.row.report_id },
    };
  });
}

/**
 * The sections a report's last build could not read in full, as `incomplete_sections` stores them.
 * Anything unrecognised is dropped: an absent column, a null, or a value written by an older build
 * reads as a COMPLETE report, which is exactly how every report built before the column behaves.
 */
export function incompleteSectionsOf(value: unknown): HrOpsSection[] {
  const raw = Array.isArray(value) ? value : [];
  return HR_OPS_SECTIONS.filter((section) => raw.includes(section));
}

/**
 * 🔴 WHY A DEGRADED REPORT CANNOT BE SUBMITTED. A section whose source fails does not throw — it
 * builds as `lines: []` with the reason named — so its rows are simply absent. The stale sweep is
 * stood down for such a section (build.ts), but a degraded FIRST build has no rows to sweep at all:
 * nothing is flagged, so `submitReport` finds nothing waiting and auto-decides the report on the
 * spot, after which `buildHrOpsReport` answers `skipped: "frozen"` for ever. Those days then never
 * reach the weekly attendance review and no screen says so — `build_warnings` was stored and only
 * ever displayed. This is the gate: while a section is incomplete the report waits for a clean
 * rebuild, which clears the field and sweeps that section properly.
 *
 * Returns the sentence to show her, or null when the report may be submitted. Pure — a predicate
 * over one report row, so the rule is pinned by the suite rather than by a build that needs a
 * database.
 */
export function degradedSubmitRefusal(report: { incomplete_sections?: unknown }): string | null {
  const sections = incompleteSectionsOf(report.incomplete_sections);
  if (sections.length === 0) return null;
  const named = sections.map((section) => HR_OPS_SECTION_LABELS[section]).join(" and ");
  return `${named} could not be read in full when this report was last built, so rows may be missing — it cannot be submitted until it has been rebuilt cleanly. The next scheduled run rebuilds it, and the HR Manager can rebuild it now.`;
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

/** The refusal for days past the cap — one sentence, shared by the server and the editors. */
export function maxDaysMessage(what: string): string {
  return `${what} cannot be more than ${MAX_DAYS} days for one day's row — the weekly attendance review takes at most ${MAX_DAYS} days for a single day.`;
}

function parseDays(value: unknown, what: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new HrOpsReportsError(`${what} must be a number of days, zero or more.`);
  if (parsed > MAX_DAYS) throw new HrOpsReportsError(maxDaysMessage(what));
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

/** What a decided office row the weekly attendance review can never hold says, in full. */
export const NOT_CARRIED_MESSAGE =
  "Not carried to payroll — the weekly attendance review never lists this day, so it is handled outside this report, as before.";

/**
 * Whether the weekly attendance review can ever hold this row's day — read off what the row RECORDS,
 * never guessed.
 *
 * FIELD: always — the bridge adds a reviewed field day itself (`field_review`).
 * OFFICE: the review lists an office day only from a fingerprint report row that charges days
 * (digest-generator.ts `isDigestibleRow`: `deductionDays > 0`), and the bridge never adds one. A row's
 * `suggested_days` IS that row's policy figure (office-section.ts copies `deductionDays` onto every
 * flagged punched day), so the office day reaches the review exactly when it had a punch and the
 * policy charged it. That leaves out, for good:
 *   · a day with NO fingerprint row at all (`no_punch` — absent, or never judged);
 *   · a single punch the policy charges nothing (the flexible-hours engine never deducts one);
 *   · a late or early-leave day the policy charges 0 days;
 *   · a clean or un-flagged row, which records no policy figure.
 * Such a row is still decided here, for the record, but nothing of it travels: it is "Not carried".
 */
export function reachesWeeklyReview(line: Pick<HrOpsReportLineRow, "section" | "flags" | "suggested_days">): boolean {
  if (line.section !== "office") return true;
  if (lineFlags(line).includes("no_punch")) return false;
  const policyDays = toDays(line.suggested_days);
  return policyDays !== null && policyDays > 0;
}

/** Where a decided row starts on its way into the weekly attendance review. */
export function bridgeStatusForDecision(decision: HrOpsDecision, days: number | null): HrOpsBridgeStatus {
  return decision === "approved" && (days ?? 0) > 0 ? "waiting" : "not_needed";
}

/**
 * The bridge status and message a decision is saved with. An approval of days on an office row the
 * weekly review can never hold is final at once — `not_needed`, saying so — instead of `waiting` for a
 * day that will never come.
 */
export function bridgeStartForDecision(
  line: Pick<HrOpsReportLineRow, "section" | "flags" | "suggested_days">,
  decision: HrOpsDecision,
  days: number | null,
): { status: HrOpsBridgeStatus; message: string | null } {
  const status = bridgeStatusForDecision(decision, days);
  if (status === "waiting" && !reachesWeeklyReview(line)) return { message: NOT_CARRIED_MESSAGE, status: "not_needed" };
  return { message: null, status };
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
