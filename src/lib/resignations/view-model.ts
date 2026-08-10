// Pure, UI-agnostic logic for the Resignations workspace: how the records split across the three
// tabs, how a "days left" cell should read, and the XLSX export shape.
//
// Nothing here touches React or the database. Every "today"-dependent function takes an injectable
// referenceDate so tests can pin the clock.
//
// Sorting and free-text search are NOT here — they come from the shared useSortableTable hook, the
// same one every other admin table uses. What lives here are the pure accessors it sorts by.

import { formatDateOnly } from "@/lib/date-only";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import { daysUntilLifecycleDate } from "@/lib/lifecycle-risk/metrics";

import type {
  PayrollResignationCandidateRecord,
  ResignationRecord,
  ResignationStatus,
} from "./types";

export const ALL_RESIGNATION_FILTER = "__all__";

/** Statuses where the workflow is finished — archive, not work. */
const closedResignationStatuses = new Set<string>(["completed", "cancelled", "rejected"]);

export function isClosedResignation(record: Pick<ResignationRecord, "status">) {
  return closedResignationStatuses.has(record.status);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
// Production carries 41 records + 32 payroll candidates, of which about a dozen need a human.
// One flat list gave all 73 equal weight, which buried the work. These three partitions are the
// page: open workflows, non-actionable payroll rows, and finished history.

export type ResignationTabId = "action" | "candidates" | "history";

export function selectOpenResignations(records: readonly ResignationRecord[]) {
  return records.filter((record) => !isClosedResignation(record));
}

export function selectClosedResignations(records: readonly ResignationRecord[]) {
  return records.filter(isClosedResignation);
}

/** Open records whose effective date has already passed — the person left, nobody ran Complete. */
export function selectOverdueResignations(
  records: readonly ResignationRecord[],
  referenceDate = new Date(),
) {
  return selectOpenResignations(records).filter(
    (record) => (daysUntilEffectiveDate(record.effectiveDate, referenceDate) ?? 0) < 0,
  );
}

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

/** EGP with thousands separators and no decimals — payroll figures are read, not audited, here. */
export function formatEgp(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

/** Payroll candidates are keyed by a raw UUID; the UI shows a short deterministic handle instead. */
export function formatPayrollCandidateSystemId(id: string) {
  const normalized = id.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return normalized ? `PRC-${normalized.slice(0, 8)}` : "PRC-PENDING";
}

/**
 * Days between today (Africa/Cairo) and an effective date; negative once it has passed.
 * Delegates to the shared lifecycle helper, which pins the timezone via Intl — so the server
 * (UTC) and the browser compute the same calendar day. Inline `new Date()` math here is what
 * produced React hydration error #418 on this page in production.
 */
export function daysUntilEffectiveDate(
  value: string | null | undefined,
  referenceDate = new Date(),
) {
  return daysUntilLifecycleDate(value, referenceDate);
}

export type ResignationDaysState = {
  /** Longer explanation — tooltip in the dense table, visible text on mobile cards. */
  label: string;
  text: string;
  tone: "danger" | "neutral" | "warning";
};

/**
 * How the "days left" cell reads. The previous page ran a bare `days <= 7` test, so every past-due
 * row — including ones completed months ago — rendered a red "-23 days / Escalation window". On
 * production that was 11 of 12 visible rows.
 */
export function resignationDaysState(
  record: Pick<ResignationRecord, "effectiveDate" | "status">,
  referenceDate = new Date(),
): ResignationDaysState {
  if (isClosedResignation(record)) {
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
 * Terminated employees are not a separate system — they are resignation records whose employee
 * reached a terminated lifecycle status (probation exit and similar).
 */
export function isTerminatedResignation(record: Pick<ResignationRecord, "employeeStatus">) {
  return String(record.employeeStatus ?? "").toLowerCase() === "terminated";
}

/**
 * Who created the record, as a person. Owner rule: surfaces show human names, never raw codes.
 * Falls back to the stored id only when the directory cannot name the actor.
 */
export function resignationActorLabel(record: ResignationRecord) {
  return record.createdByName ?? record.createdBy ?? "-";
}

// ── Line filter ──────────────────────────────────────────────────────────────

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

export function filterByLine<T extends { lineName: string | null }>(
  rows: readonly T[],
  lineName: string,
) {
  if (lineName === ALL_RESIGNATION_FILTER) return [...rows];
  return rows.filter((row) => row.lineName === lineName);
}

// ── Sort accessors (fed to useSortableTable) ─────────────────────────────────

export function recordSearchText(record: ResignationRecord) {
  return [record.employeeHrId, record.employeeName, record.jobTitle, record.lineName, record.reason]
    .filter(Boolean)
    .join(" ");
}

export function candidateSearchText(candidate: PayrollResignationCandidateRecord) {
  return [
    candidate.hrId,
    candidate.employeeName,
    candidate.nameAr,
    candidate.jobTitle,
    candidate.lineName,
    candidate.areaName,
    candidate.sourceFileName,
  ]
    .filter(Boolean)
    .join(" ");
}

// ── XLSX export ──────────────────────────────────────────────────────────────

// Human-readable headers, never raw column codes — a person reads this sheet, not a parser.
export const resignationExportColumns: ExportColumn[] = [
  { key: "employee", label: "Employee", width: 34 },
  { key: "hrId", label: "HR ID", width: 12 },
  { key: "jobTitle", label: "Job Title", width: 26 },
  { key: "line", label: "Line", width: 18 },
  { key: "hired", label: "Hired", width: 14 },
  { key: "submitted", label: "Submitted", width: 14 },
  { key: "effective", label: "Effective", width: 14 },
  { key: "status", label: "Status", width: 16 },
  { key: "createdBy", label: "Created By", width: 26 },
];

const statusExportLabels: Record<string, string> = {
  approved: "Approved",
  cancelled: "Cancelled",
  completed: "Completed",
  rejected: "Rejected",
  submitted: "Submitted",
  under_review: "Under Review",
};

export function resignationStatusLabel(status: ResignationStatus) {
  return statusExportLabels[status] ?? status;
}

export function buildResignationExportRows(records: readonly ResignationRecord[]): ExportRow[] {
  return records.map((record) => ({
    createdBy: resignationActorLabel(record),
    hired: formatResignationDate(record.hireDate),
    effective: formatResignationDate(record.effectiveDate),
    employee: record.employeeName,
    hrId: record.employeeHrId,
    jobTitle: record.jobTitle ?? "-",
    line: record.lineName ?? "-",
    status: resignationStatusLabel(record.status),
    submitted: formatResignationDate(record.submittedDate),
  }));
}

export const payrollCandidateExportColumns: ExportColumn[] = [
  { key: "employee", label: "Employee", width: 34 },
  { key: "hrId", label: "HR ID", width: 12 },
  { key: "jobTitle", label: "Job Title", width: 26 },
  { key: "line", label: "Line", width: 18 },
  { key: "area", label: "Area", width: 22 },
  { key: "lastPayout", label: "Last Payout", width: 14 },
  { key: "lastSeen", label: "Last Seen", width: 14 },
  { key: "systemId", label: "System ID", width: 16 },
  { key: "source", label: "Source File", width: 34 },
];

export function buildPayrollCandidateExportRows(
  candidates: readonly PayrollResignationCandidateRecord[],
): ExportRow[] {
  return candidates.map((candidate) => ({
    area: candidate.areaName ?? "-",
    employee: candidate.employeeName,
    hrId: candidate.hrId || "-",
    jobTitle: candidate.jobTitle ?? "-",
    lastPayout: formatPayoutMonth(candidate.lastPayoutMonth, candidate.lastPayoutYear),
    lastSeen: formatResignationDate(candidate.lastSeenAt.slice(0, 10)),
    line: candidate.lineName ?? "-",
    source: candidate.sourceFileName ?? "-",
    systemId: formatPayrollCandidateSystemId(candidate.id),
  }));
}
