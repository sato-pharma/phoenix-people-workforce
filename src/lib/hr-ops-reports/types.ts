// HR Daily & Weekly Reports — the shapes every part of the module agrees on.
//
// Owner, 2026-10-20, building the HR Operations Specialist seat: "daily and weekly fingerprint and
// field-force reports (AM/PM, start/end times, visits to date)"; every row "confirm or rejct or
// recommend edit with reason"; deductions "recommend in days only; she will never take desicion".
//
// DAYS ONLY. Nothing in this file names an amount, and nothing that reaches the reviewer's screen
// may carry one. The Super Admin's screen prices a decided day at read time, on the server
// (pricing.ts, `priceReportLines`, behind a route only the Super Admin passes), and that figure never enters a type the reviewer is sent.
//
// The tables are supabase/migrations/20261020065354_hr_ops_reports.sql. Every literal below mirrors
// one of that file's CHECK constraints; tests/hr-ops-reports.test.ts reads the migration and fails
// if the two drift.

export const HR_OPS_REPORT_KINDS = ["daily", "weekly"] as const;
export type HrOpsReportKind = (typeof HR_OPS_REPORT_KINDS)[number];

export const HR_OPS_REPORT_STATUSES = ["in_review", "submitted", "decided"] as const;
export type HrOpsReportStatus = (typeof HR_OPS_REPORT_STATUSES)[number];

export const HR_OPS_SECTIONS = ["office", "field"] as const;
export type HrOpsSection = (typeof HR_OPS_SECTIONS)[number];

export const HR_OPS_REVIEW_ACTIONS = ["confirm", "reject", "recommend_edit"] as const;
export type HrOpsReviewAction = (typeof HR_OPS_REVIEW_ACTIONS)[number];

export const HR_OPS_DECISIONS = ["approved", "rejected"] as const;
export type HrOpsDecision = (typeof HR_OPS_DECISIONS)[number];

export const HR_OPS_BRIDGE_STATUSES = [
  "not_decided",
  "not_needed",
  "waiting",
  "bridged",
  "week_released",
  "failed",
] as const;
export type HrOpsBridgeStatus = (typeof HR_OPS_BRIDGE_STATUSES)[number];

/**
 * What the build found wrong with a person's day. Office flags come from the fingerprint record,
 * the field flag from the field-absence engine. A line with no flag is a clean day: it is shown,
 * carries no suggested days and needs no review.
 */
export const HR_OPS_FLAGS = ["no_punch", "single_punch", "late", "early_leave", "no_field_activity"] as const;
export type HrOpsFlag = (typeof HR_OPS_FLAGS)[number];

export const HR_OPS_FLAG_LABELS: Record<HrOpsFlag, string> = {
  early_leave: "Left early",
  late: "Late",
  no_field_activity: "No field activity",
  no_punch: "No punch",
  single_punch: "Single punch",
};

export const HR_OPS_REVIEW_ACTION_LABELS: Record<HrOpsReviewAction, string> = {
  confirm: "Confirm",
  recommend_edit: "Recommend an edit",
  reject: "Reject",
};

export const HR_OPS_SECTION_LABELS: Record<HrOpsSection, string> = {
  field: "Field force (visits)",
  office: "Head office (fingerprint)",
};

export const HR_OPS_STATUS_LABELS: Record<HrOpsReportStatus, string> = {
  decided: "Decided",
  in_review: "In review",
  submitted: "Submitted for decision",
};

export const HR_OPS_BRIDGE_STATUS_LABELS: Record<HrOpsBridgeStatus, string> = {
  bridged: "In the weekly attendance review",
  failed: "Could not reach the weekly review — will retry",
  not_decided: "Not decided yet",
  not_needed: "Nothing to carry",
  waiting: "Waiting for its week to open in the weekly review",
  week_released: "Its week was already released — decided here only",
};

/** The facts of one head-office day, from the fingerprint record. Times are Cairo wall-clock. */
export type HrOpsOfficeMetrics = {
  kind: "office";
  scheduledStart: string | null;
  scheduledEnd: string | null;
  firstPunch: string | null;
  lastPunch: string | null;
  lateMinutes: number | null;
  earlyLeaveMinutes: number | null;
  /** How long the day ran between the first and last punch, as the fingerprint report prints it. */
  workedTime: string | null;
  /** The fingerprint report's own status ("Complete", "Late", "Single punch"…), or "No punch". */
  status: string;
  recommendedAction: string | null;
  /** Plain sentences: what covered the day, why it was not judged, what is pending. */
  notes: string[];
};

/** The facts of one field day, from the CRM visits. Times are Cairo wall-clock. */
export type HrOpsFieldMetrics = {
  kind: "field";
  /** Rep, DM, RSM, NSM, Acting DM or Product manager — the seat held that day. */
  tierLabel: string | null;
  am: number;
  pm: number;
  pharmacies: number;
  total: number;
  /**
   * Of the counts above, how many are the manager's OWN single visits (owner, 2026-10-20: "Show the
   * 6 visits"). Zero for everyone who is not a manager — they are never credited to anyone else.
   */
  ownVisits: number;
  firstVisit: string | null;
  lastVisit: string | null;
  /** Counted visits from the first of the month through this day. */
  monthToDate: number;
  monthToDateFrom: string;
  /** What the system recorded for the person that day when it was not a visit ("Annual Vacation"). */
  seenAs: string | null;
  notes: string[];
};

export type HrOpsLineMetrics = HrOpsOfficeMetrics | HrOpsFieldMetrics;

/** One line as the build produces it, before it is written. */
export type HrOpsLineDraft = {
  section: HrOpsSection;
  workDate: string;
  /** As the directory shows it (upper case). */
  hrId: string;
  /** canonicalHrIdKey — lower case, aliases folded. The one spelling every join uses. */
  hrKey: string;
  employeeName: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  managerName: string | null;
  metrics: HrOpsLineMetrics;
  flags: HrOpsFlag[];
  /** The policy's figure for the day, in DAYS. Null on a clean line, or when the policy has none. */
  suggestedDays: number | null;
};

/** The two windows a report covers. A section with no working day in the report is null. */
export type HrOpsPeriod = {
  kind: HrOpsReportKind;
  periodKey: string;
  /** The date the period is named after: the day of a daily report, the Saturday of a weekly. */
  anchor: string;
  officeFrom: string | null;
  officeTo: string | null;
  fieldFrom: string | null;
  fieldTo: string | null;
};

/** `hr_ops_reports`, as read. */
export type HrOpsReportRow = {
  id: string;
  kind: HrOpsReportKind;
  period_key: string;
  office_from: string | null;
  office_to: string | null;
  field_from: string | null;
  field_to: string | null;
  status: HrOpsReportStatus;
  line_count: number;
  build_warnings: unknown;
  built_at: string;
  rebuilt_at: string | null;
  submitted_at: string | null;
  submitted_by_hr_id: string | null;
  decided_at: string | null;
  decided_by_hr_id: string | null;
  created_at: string;
  updated_at: string;
};

/** `hr_ops_report_lines`, as read. Days only — there is no amount column to read. */
export type HrOpsReportLineRow = {
  id: string;
  report_id: string;
  section: HrOpsSection;
  work_date: string;
  hr_id: string;
  hr_key: string;
  employee_name: string;
  job_title: string | null;
  line_name: string | null;
  area_name: string | null;
  manager_name: string | null;
  metrics: unknown;
  flags: string[] | null;
  suggested_days: number | string | null;
  review_action: HrOpsReviewAction | null;
  review_reason: string | null;
  review_comment: string | null;
  recommended_days: number | string | null;
  reviewed_by_hr_id: string | null;
  reviewed_at: string | null;
  decision: HrOpsDecision | null;
  decided_days: number | string | null;
  decided_by_hr_id: string | null;
  decided_at: string | null;
  bridge_status: HrOpsBridgeStatus;
  bridge_ref: string | null;
  bridge_message: string | null;
  bridged_at: string | null;
  carried_from_line_id: string | null;
  created_at: string;
  updated_at: string;
  /**
   * NOT A COLUMN. Set when a report is read (store.ts `withDecidedElsewhere`): the other report in
   * which this row's person-day was decided, while this row itself is undecided. Such a row is shown
   * as carried, never decided a second time (rules.ts `isCarried`).
   */
  decided_elsewhere?: HrOpsDecidedElsewhere | null;
};

/** Where a row's person-day was decided, when that was another report. */
export type HrOpsDecidedElsewhere = {
  lineId: string;
  reportId: string;
  kind: HrOpsReportKind;
  /** The day the other report is named after: the day of a daily, the Saturday of a weekly. */
  anchor: string;
};

export const HR_OPS_REPORT_COLUMNS =
  "id,kind,period_key,office_from,office_to,field_from,field_to,status,line_count,build_warnings,built_at,rebuilt_at,submitted_at,submitted_by_hr_id,decided_at,decided_by_hr_id,created_at,updated_at";

export const HR_OPS_LINE_COLUMNS =
  "id,report_id,section,work_date,hr_id,hr_key,employee_name,job_title,line_name,area_name,manager_name,metrics,flags,suggested_days,review_action,review_reason,review_comment,recommended_days,reviewed_by_hr_id,reviewed_at,decision,decided_days,decided_by_hr_id,decided_at,bridge_status,bridge_ref,bridge_message,bridged_at,carried_from_line_id,created_at,updated_at";

/** What a section's build hands back: its lines, and what it could not read, said plainly. */
export type HrOpsSectionBuild = {
  lines: HrOpsLineDraft[];
  warnings: string[];
};

/** A refusal a person should read, with the HTTP status a route answers it with. */
export class HrOpsReportsError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "HrOpsReportsError";
    this.status = status;
  }
}

export function isHrOpsReportsError(error: unknown): error is HrOpsReportsError {
  return error instanceof HrOpsReportsError;
}

/** A numeric column as a number, or null. Postgres numerics arrive as strings through PostgREST. */
export function toDays(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isHrOpsFlag(value: unknown): value is HrOpsFlag {
  return typeof value === "string" && (HR_OPS_FLAGS as readonly string[]).includes(value);
}
