// HR Daily & Weekly Reports — what leaves the server.
//
// AN ALLOW-LIST, NEVER A SPREAD. Every field a screen receives is named here, and the metrics object
// is rebuilt key by key from the two known shapes, so a column or a metric added later reaches no
// screen until somebody writes it into this file on purpose. That is the guarantee her payload
// carries no money: the tables hold none, and this cannot pass on what it does not name.
// `findMoneyKeys` is the tripwire tests/hr-ops-reports.test.ts runs over a built payload.

import { formatDayLong, parsePeriodKey, periodTitle } from "./periods";
import {
  decidedElsewhereText,
  decisionIsOpen,
  defaultDecisionDays,
  degradedSubmitRefusal,
  isCarried,
  isDecidable,
  lineFlags,
  needsReview,
  NOT_CARRIED_MESSAGE,
  reachesWeeklyReview,
  reportProgress,
  type ReportProgress,
} from "./rules";
import {
  HR_OPS_BRIDGE_STATUS_LABELS,
  HR_OPS_FLAG_LABELS,
  HR_OPS_REVIEW_ACTION_LABELS,
  HR_OPS_SECTION_LABELS,
  HR_OPS_STATUS_LABELS,
  toDays,
  type HrOpsBridgeStatus,
  type HrOpsDecision,
  type HrOpsFieldMetrics,
  type HrOpsFlag,
  type HrOpsLineMetrics,
  type HrOpsOfficeMetrics,
  type HrOpsReportKind,
  type HrOpsReportLineRow,
  type HrOpsReportRow,
  type HrOpsReportStatus,
  type HrOpsReviewAction,
  type HrOpsSection,
} from "./types";

export type HrOpsReportView = {
  id: string;
  kind: HrOpsReportKind;
  kindLabel: string;
  title: string;
  status: HrOpsReportStatus;
  statusLabel: string;
  officeFrom: string | null;
  officeTo: string | null;
  fieldFrom: string | null;
  fieldTo: string | null;
  lineCount: number;
  warnings: string[];
  /**
   * Why this report cannot be submitted yet, because a section's last build could not read a
   * source in full (rules.ts `degradedSubmitRefusal`). Null when it may be submitted.
   */
  submitBlockedReason: string | null;
  builtAt: string;
  rebuiltAt: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  progress: ReportProgress | null;
};

export type HrOpsLineView = {
  id: string;
  section: HrOpsSection;
  sectionLabel: string;
  workDate: string;
  workDateLabel: string;
  employeeName: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  managerName: string | null;
  metrics: HrOpsLineMetrics;
  flags: Array<{ code: HrOpsFlag; label: string }>;
  /** The policy's figure, in days. */
  suggestedDays: number | null;
  needsReview: boolean;
  decidable: boolean;
  carried: boolean;
  /** Where a carried row was decided: "Decided in its daily report", "Decided in the weekly report of …". */
  carriedLabel: string | null;
  /**
   * True on an office row the weekly attendance review can never hold (rules.ts `reachesWeeklyReview`):
   * it is decided here for the record, and nothing of it is carried. `notCarriedNote` says so in full.
   */
  notCarried: boolean;
  notCarriedNote: string | null;
  review: {
    action: HrOpsReviewAction;
    actionLabel: string;
    reason: string | null;
    comment: string | null;
    recommendedDays: number | null;
    reviewedAt: string | null;
  } | null;
  decision: {
    decision: HrOpsDecision;
    label: string;
    days: number | null;
    decidedAt: string | null;
  } | null;
  /** The days an Approve starts from: her recommendation when she made one, else the policy's. */
  defaultDecisionDays: number | null;
  /**
   * How the decision travelled into the weekly attendance review. `locked` is true once that review
   * holds the day (rules.ts `decisionIsOpen`): the decision is then changed there, not here.
   */
  bridge: { status: HrOpsBridgeStatus; label: string; message: string | null; locked: boolean };
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The stored metrics, rebuilt key by key — nothing the two shapes do not name survives. */
export function viewMetrics(section: HrOpsSection, raw: unknown): HrOpsLineMetrics {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (section === "office") {
    const office: HrOpsOfficeMetrics = {
      earlyLeaveMinutes: numberOrNull(source.earlyLeaveMinutes),
      firstPunch: textOrNull(source.firstPunch),
      kind: "office",
      lastPunch: textOrNull(source.lastPunch),
      lateMinutes: numberOrNull(source.lateMinutes),
      notes: stringList(source.notes),
      recommendedAction: textOrNull(source.recommendedAction),
      scheduledEnd: textOrNull(source.scheduledEnd),
      scheduledStart: textOrNull(source.scheduledStart),
      status: textOrNull(source.status) ?? "Recorded",
      workedTime: textOrNull(source.workedTime),
    };
    return office;
  }
  const field: HrOpsFieldMetrics = {
    am: count(source.am),
    firstVisit: textOrNull(source.firstVisit),
    kind: "field",
    lastVisit: textOrNull(source.lastVisit),
    monthToDate: count(source.monthToDate),
    monthToDateFrom: textOrNull(source.monthToDateFrom) ?? "",
    notes: stringList(source.notes),
    ownVisits: count(source.ownVisits),
    pharmacies: count(source.pharmacies),
    pm: count(source.pm),
    seenAs: textOrNull(source.seenAs),
    tierLabel: textOrNull(source.tierLabel),
    total: count(source.total),
  };
  return field;
}

function warningsOf(value: unknown): string[] {
  return stringList(value);
}

export function viewReport(report: HrOpsReportRow, lines?: readonly HrOpsReportLineRow[]): HrOpsReportView {
  const parsed = parsePeriodKey(report.period_key);
  const anchor = parsed?.anchor ?? report.field_from ?? report.office_from ?? "";
  return {
    builtAt: report.built_at,
    decidedAt: report.decided_at,
    fieldFrom: report.field_from,
    fieldTo: report.field_to,
    id: report.id,
    kind: report.kind,
    kindLabel: report.kind === "daily" ? "Daily" : "Weekly",
    lineCount: report.line_count,
    officeFrom: report.office_from,
    officeTo: report.office_to,
    progress: lines ? reportProgress(lines) : null,
    rebuiltAt: report.rebuilt_at,
    status: report.status,
    statusLabel: HR_OPS_STATUS_LABELS[report.status] ?? report.status,
    submitBlockedReason: degradedSubmitRefusal(report),
    submittedAt: report.submitted_at,
    title: anchor ? periodTitle({ anchor, fieldTo: report.field_to, kind: report.kind, officeTo: report.office_to }) : report.period_key,
    warnings: warningsOf(report.build_warnings),
  };
}

function carriedLabelOf(line: HrOpsReportLineRow): string | null {
  if (line.carried_from_line_id) return "Decided in its daily report";
  if (!line.decision && line.decided_elsewhere) {
    const text = decidedElsewhereText(line.decided_elsewhere);
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  }
  return null;
}

export function viewLine(line: HrOpsReportLineRow): HrOpsLineView {
  const flags = lineFlags(line);
  const decidable = isDecidable(line);
  const notCarried = decidable && !reachesWeeklyReview(line);
  const settledNotCarried = notCarried && line.bridge_status === "not_needed" && line.decision === "approved";
  return {
    areaName: line.area_name,
    bridge: {
      label: settledNotCarried ? "Not carried to payroll" : HR_OPS_BRIDGE_STATUS_LABELS[line.bridge_status] ?? line.bridge_status,
      locked: !decisionIsOpen(line),
      // The not-carried sentence is drawn once, from `notCarriedNote`.
      message: settledNotCarried && line.bridge_message === NOT_CARRIED_MESSAGE ? null : line.bridge_message,
      status: line.bridge_status,
    },
    carried: isCarried(line),
    carriedLabel: carriedLabelOf(line),
    decidable,
    notCarried,
    notCarriedNote: notCarried ? NOT_CARRIED_MESSAGE : null,
    decision: line.decision
      ? {
          days: toDays(line.decided_days),
          decidedAt: line.decided_at,
          decision: line.decision,
          label: line.decision === "approved" ? "Approved" : "Rejected",
        }
      : null,
    defaultDecisionDays: defaultDecisionDays(line),
    employeeName: line.employee_name,
    flags: flags.map((code) => ({ code, label: HR_OPS_FLAG_LABELS[code] })),
    id: line.id,
    jobTitle: line.job_title,
    lineName: line.line_name,
    managerName: line.manager_name,
    metrics: viewMetrics(line.section, line.metrics),
    needsReview: needsReview(line),
    review: line.review_action
      ? {
          action: line.review_action,
          actionLabel: HR_OPS_REVIEW_ACTION_LABELS[line.review_action],
          comment: line.review_comment,
          reason: line.review_reason,
          recommendedDays: toDays(line.recommended_days),
          reviewedAt: line.reviewed_at,
        }
      : null,
    section: line.section,
    sectionLabel: HR_OPS_SECTION_LABELS[line.section],
    suggestedDays: toDays(line.suggested_days),
    workDate: line.work_date,
    workDateLabel: formatDayLong(line.work_date),
  };
}

/** The full report, as either screen receives it. Days only. */
export function viewReportWithLines(report: HrOpsReportRow, lines: readonly HrOpsReportLineRow[]) {
  const sorted = [...lines].sort((left, right) =>
    left.section.localeCompare(right.section)
    || left.work_date.localeCompare(right.work_date)
    || Number(needsReview(right)) - Number(needsReview(left))
    || left.employee_name.localeCompare(right.employee_name));
  return { lines: sorted.map(viewLine), report: viewReport(report, lines) };
}

/**
 * Every key in a payload whose NAME says money. Days are allowed (`suggestedDays`, `days`); an
 * amount, a salary, a price, a value or a currency is not. Walks objects and arrays.
 */
export function findMoneyKeys(payload: unknown, path = ""): string[] {
  const hits: string[] = [];
  if (Array.isArray(payload)) {
    payload.forEach((entry, index) => hits.push(...findMoneyKeys(entry, `${path}[${index}]`)));
    return hits;
  }
  if (payload && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const at = path ? `${path}.${key}` : key;
      if (/amount|salary|price|value|egp|currency|pay(?!load)|wage|cost|money/i.test(key)) hits.push(at);
      hits.push(...findMoneyKeys(value, at));
    }
  }
  return hits;
}
