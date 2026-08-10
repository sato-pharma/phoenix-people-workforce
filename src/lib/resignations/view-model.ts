// Pure, UI-agnostic list logic for the Resignations workspace: date/label formatting, the
// status+line filter predicates, queue assembly, and the XLSX export shape. Extracted out of the
// former 1,337-line src/components/reports/resignations-report.tsx so this logic is testable
// without a DOM — the same split contracts already use via @/lib/lifecycle-risk/metrics.
//
// Deliberately does NOT implement sorting or free-text search: those come from the shared
// useSortableTable hook (@/components/ui/sortable-table), which every other admin table uses.
// What lives here are the pure accessors that hook sorts by.
//
// Nothing here reaches the database or React. Every "today"-dependent function takes an
// injectable referenceDate so tests can pin the clock.

import { formatDateOnly } from "@/lib/date-only";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import { daysUntilLifecycleDate } from "@/lib/lifecycle-risk/metrics";

import type {
  PayrollResignationCandidateRecord,
  ResignationRecord,
  ResignationStatus,
} from "./types";

export const ALL_RESIGNATION_FILTER = "__all__";

export const resignationStatusOptions: readonly ResignationStatus[] = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "completed",
  "cancelled",
];

/** Statuses that still expect a human decision. Mirrors the service's own summary buckets. */
export const pendingResignationStatuses: readonly ResignationStatus[] = ["submitted", "under_review"];
export const activeResignationStatuses: readonly ResignationStatus[] = [
  "submitted",
  "under_review",
  "approved",
];

export type ResignationFilters = {
  lineName: string;
  status: string;
};

export const defaultResignationFilters: ResignationFilters = {
  lineName: ALL_RESIGNATION_FILTER,
  status: ALL_RESIGNATION_FILTER,
};

export type ResignationQueueRow =
  | { key: string; kind: "resignation"; record: ResignationRecord }
  | { candidate: PayrollResignationCandidateRecord; key: string; kind: "payrollCandidate" };

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatResignationDate(value: string | null | undefined) {
  return formatDateOnly(value, "en", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatPayoutMonth(month: number | null | undefined, year: number | null | undefined) {
  if (!month || !year) return "-";
  const date = new Date(year, month - 1, 1);
  if (Number.isNaN(date.getTime())) return `${month}/${year}`;
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(date);
}

/**
 * Payroll candidates are keyed by a raw UUID that means nothing to a reader, so the queue shows
 * a short derived handle instead. Deterministic: the same row always yields the same handle.
 */
export function formatPayrollCandidateSystemId(id: string) {
  const normalized = id.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return normalized ? `PRC-${normalized.slice(0, 8)}` : "PRC-PENDING";
}

/**
 * Days between today (Africa/Cairo) and an effective date. Negative once the date has passed.
 * Delegates to the shared lifecycle helper so resignations, contracts and probation all agree on
 * which calendar day "today" is — the server runs UTC while every reader is in Cairo, and the old
 * inline `new Date()` math disagreed between the server render and the browser render (that
 * mismatch is what produced React hydration error #418 on this page in production).
 */
export function daysUntilEffectiveDate(
  value: string | null | undefined,
  referenceDate = new Date(),
) {
  return daysUntilLifecycleDate(value, referenceDate);
}

// ── Days-left state ──────────────────────────────────────────────────────────

/** Statuses where the workflow is over, so a countdown to the effective date is meaningless. */
const closedResignationStatuses = new Set<string>(["completed", "cancelled", "rejected"]);

export type ResignationDaysState = {
  /** Short explanation under the badge. */
  label: string;
  /** Badge text. */
  text: string;
  tone: "danger" | "neutral" | "warning";
};

/**
 * How the Days Left column should read for one record.
 *
 * The old page ran a bare `days <= 7` test, so EVERY past-due record — including ones already
 * completed months ago — rendered a red "-23 days / Escalation window". On production that was 11
 * of 12 rows, which trained the eye to ignore the column entirely. Three honest cases instead:
 * a closed record shows no countdown, a past-due OPEN record is genuinely overdue (nobody
 * completed it), and a future record counts down.
 */
export function resignationDaysState(
  record: Pick<ResignationRecord, "effectiveDate" | "status">,
  referenceDate = new Date(),
): ResignationDaysState {
  if (closedResignationStatuses.has(record.status)) {
    return { label: "Workflow closed", text: "—", tone: "neutral" };
  }

  const days = daysUntilEffectiveDate(record.effectiveDate, referenceDate);
  if (days === null) return { label: "No effective date", text: "-", tone: "neutral" };
  if (days < 0) {
    const overdue = Math.abs(days);
    return {
      label: "Left, never completed",
      text: `${overdue} ${overdue === 1 ? "day" : "days"} overdue`,
      tone: "danger",
    };
  }
  if (days === 0) return { label: "Last working day", text: "Today", tone: "danger" };
  if (days <= 7) return { label: "Escalation window", text: `${days} days`, tone: "danger" };
  if (days <= 30) return { label: "In progress", text: `${days} days`, tone: "warning" };
  return { label: "In progress", text: `${days} days`, tone: "neutral" };
}

/**
 * Open resignations whose effective date has already passed — the person has left but nobody ran
 * "Complete", so the seat, access and vacancy reconciliation never fired from this workflow.
 */
export function countOverdueResignations(
  records: readonly ResignationRecord[],
  referenceDate = new Date(),
) {
  return selectOverdueResignations(records, referenceDate).length;
}

// ── Filtering (status + line only; free text belongs to useSortableTable) ─────

export function resignationLineOptions(
  records: readonly ResignationRecord[],
  candidates: readonly PayrollResignationCandidateRecord[],
) {
  const values = [
    ...records.map((record) => record.lineName),
    ...candidates.map((candidate) => candidate.lineName),
  ].filter(Boolean) as string[];
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

export function filterResignationRecords(
  records: readonly ResignationRecord[],
  filters: ResignationFilters,
) {
  return records.filter(
    (record) =>
      (filters.status === ALL_RESIGNATION_FILTER || record.status === filters.status) &&
      (filters.lineName === ALL_RESIGNATION_FILTER || record.lineName === filters.lineName),
  );
}

export function filterPayrollCandidates(
  candidates: readonly PayrollResignationCandidateRecord[],
  filters: ResignationFilters,
) {
  return candidates.filter(
    (candidate) =>
      filters.lineName === ALL_RESIGNATION_FILTER || candidate.lineName === filters.lineName,
  );
}

/**
 * Payroll candidates carry no workflow status, so a status filter can only ever exclude them.
 * They are dropped whenever one is applied rather than being silently matched against nothing.
 */
export function payrollCandidatesVisible(filters: ResignationFilters) {
  return filters.status === ALL_RESIGNATION_FILTER;
}

export function activeResignationFilterCount(filters: ResignationFilters) {
  return [
    filters.status !== defaultResignationFilters.status ? filters.status : "",
    filters.lineName !== defaultResignationFilters.lineName ? filters.lineName : "",
  ].filter(Boolean).length;
}

// ── Queue assembly + the pure accessors useSortableTable sorts/searches by ────

export function buildResignationQueueRows(
  records: readonly ResignationRecord[],
  candidates: readonly PayrollResignationCandidateRecord[],
  filters: ResignationFilters,
): ResignationQueueRow[] {
  const rows: ResignationQueueRow[] = records.map((record) => ({
    key: `resignation:${record.id}`,
    kind: "resignation",
    record,
  }));

  if (payrollCandidatesVisible(filters)) {
    rows.push(
      ...candidates.map<ResignationQueueRow>((candidate) => ({
        candidate,
        key: `payroll-candidate:${candidate.id}`,
        kind: "payrollCandidate",
      })),
    );
  }

  return rows;
}

export function queueRowEmployeeName(row: ResignationQueueRow) {
  return row.kind === "resignation" ? row.record.employeeName : row.candidate.employeeName;
}

export function queueRowHrId(row: ResignationQueueRow) {
  return row.kind === "resignation" ? row.record.employeeHrId : row.candidate.hrId;
}

export function queueRowLineName(row: ResignationQueueRow) {
  return (row.kind === "resignation" ? row.record.lineName : row.candidate.lineName) ?? "";
}

export function queueRowStatus(row: ResignationQueueRow) {
  return row.kind === "resignation" ? row.record.status : "payroll_candidate";
}

/**
 * A candidate has no effective date — its last payout month is the closest equivalent, so the two
 * row kinds stay interleaved in one chronological queue instead of clumping at either end.
 */
export function queueRowEffectiveDate(row: ResignationQueueRow) {
  if (row.kind === "resignation") return row.record.effectiveDate;
  const { lastPayoutMonth, lastPayoutYear } = row.candidate;
  return `${lastPayoutYear}-${String(lastPayoutMonth).padStart(2, "0")}-01`;
}

export function queueRowSubmittedDate(row: ResignationQueueRow) {
  return row.kind === "resignation"
    ? row.record.submittedDate
    : row.candidate.lastSeenAt.slice(0, 10);
}

export function queueRowSearchText(row: ResignationQueueRow) {
  const parts =
    row.kind === "resignation"
      ? [
          row.record.employeeHrId,
          row.record.employeeName,
          row.record.jobTitle,
          row.record.lineName,
          row.record.reason,
        ]
      : [
          row.candidate.hrId,
          row.candidate.employeeName,
          row.candidate.nameAr,
          row.candidate.jobTitle,
          row.candidate.lineName,
          row.candidate.areaName,
          row.candidate.sourceFileName,
        ];
  return parts.filter(Boolean).join(" ");
}

/**
 * Who created the record, as a person. Owner rule: surfaces show human names, never raw codes —
 * the queue used to print the bare login id ("phx-1", "a-16"). Falls back to the id only when the
 * directory cannot name the actor, which beats showing nothing at all.
 */
export function resignationActorLabel(record: ResignationRecord) {
  return record.createdByName ?? record.createdBy ?? "-";
}

/**
 * Terminated employees are NOT a separate system — they are resignation records whose employee
 * reached a terminated lifecycle status (probation exit and similar). They live in the same
 * queue as every other record, highlighted rather than split into their own table.
 */
export function isTerminatedResignation(record: Pick<ResignationRecord, "employeeStatus">) {
  return String(record.employeeStatus ?? "").toLowerCase() === "terminated";
}

export function selectTerminatedRecords(records: readonly ResignationRecord[]) {
  return records.filter(isTerminatedResignation);
}

/** Open records whose effective date has already passed — the bulk-close candidates. */
export function selectOverdueResignations(
  records: readonly ResignationRecord[],
  referenceDate = new Date(),
) {
  return records.filter(
    (record) =>
      !closedResignationStatuses.has(record.status) &&
      (daysUntilEffectiveDate(record.effectiveDate, referenceDate) ?? 0) < 0,
  );
}

// ── XLSX export (rendered by the shared ExportXlsxButton) ────────────────────

// Human-readable headers, never raw column codes — the sheet is read by people, not by a parser.
export const resignationExportColumns: ExportColumn[] = [
  { key: "recordType", label: "Record Type", width: 22 },
  { key: "hrId", label: "HR ID", width: 12 },
  { key: "employeeName", label: "Employee", width: 34 },
  { key: "line", label: "Line", width: 18 },
  { key: "area", label: "Area", width: 22 },
  { key: "jobTitle", label: "Job Title", width: 26 },
  { key: "hireDate", label: "Hire Date", width: 14 },
  { key: "lastPayout", label: "Last Payout", width: 14 },
  { key: "submittedDate", label: "Submitted", width: 14 },
  { key: "effectiveDate", label: "Effective", width: 14 },
  { key: "daysLeft", label: "Days Left", numeric: true, width: 11 },
  { key: "status", label: "Status", width: 16 },
  { key: "reason", label: "Reason", width: 40 },
  { key: "rejectedReason", label: "Rejection Reason", width: 30 },
  { key: "createdBy", label: "Created By", width: 16 },
  { key: "updatedAt", label: "Updated", width: 14 },
];

const statusExportLabels: Record<string, string> = {
  approved: "Approved",
  cancelled: "Cancelled",
  completed: "Completed",
  rejected: "Rejected",
  submitted: "Submitted",
  under_review: "Under Review",
};

export function buildResignationExportRows(
  records: readonly ResignationRecord[],
  candidates: readonly PayrollResignationCandidateRecord[],
  referenceDate = new Date(),
): ExportRow[] {
  const candidateRows: ExportRow[] = candidates.map((candidate) => ({
    area: candidate.areaName ?? "-",
    createdBy: candidate.createdBy ?? "-",
    daysLeft: null,
    effectiveDate: "-",
    employeeName: candidate.employeeName,
    hireDate: formatResignationDate(candidate.hireDate),
    hrId: candidate.hrId || "-",
    jobTitle: candidate.jobTitle ?? "-",
    lastPayout: formatPayoutMonth(candidate.lastPayoutMonth, candidate.lastPayoutYear),
    line: candidate.lineName ?? "-",
    recordType: "Payroll Candidate",
    reason: `Missing from employee directory. Source row ${candidate.sourceRow ?? "-"}`,
    rejectedReason: "",
    status: "Payroll Candidate",
    submittedDate: "-",
    updatedAt: formatResignationDate(candidate.updatedAt.slice(0, 10)),
  }));

  const resignationRows: ExportRow[] = records.map((record) => ({
    area: "-",
    createdBy: resignationActorLabel(record),
    daysLeft: daysUntilEffectiveDate(record.effectiveDate, referenceDate),
    effectiveDate: formatResignationDate(record.effectiveDate),
    employeeName: record.employeeName,
    hireDate: "-",
    hrId: record.employeeHrId,
    jobTitle: record.jobTitle ?? "-",
    lastPayout: "-",
    line: record.lineName ?? "-",
    recordType: "Resignation",
    reason: record.reason ?? "",
    rejectedReason: record.rejectedReason ?? "",
    status: statusExportLabels[record.status] ?? record.status,
    submittedDate: formatResignationDate(record.submittedDate),
    updatedAt: formatResignationDate(record.updatedAt.slice(0, 10)),
  }));

  return [...candidateRows, ...resignationRows];
}
