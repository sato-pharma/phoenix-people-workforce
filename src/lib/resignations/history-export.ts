// The Resignations "Export full history" workbook: EVERY exit record the viewer can see — open,
// closed, and the historical leavers who never had a workflow row — with every field the system
// holds for it, plus the payroll-only leavers on a second sheet.
//
// WHY A SECOND EXPORT RATHER THAN A WIDER "Export". The on-screen Export follows the active tab, the
// line filter and the search box, and carries nine columns — it answers "give me what I am looking
// at". This one ignores all three on purpose, because "the whole history, full data" is a different
// question, and quietly widening the first would change what an existing button hands people.
//
// SCOPE STILL COMES FROM THE SESSION. The rows are built from getResignationsDashboardData(access) on
// the server (see history-export-data.ts), never from rows posted by the browser, so this file can
// never hold a record the Resignations page would not show the same viewer.
//
// Pure apart from ExcelJS: every database answer arrives through `ResignationHistoryLookups`, so the
// row shape is testable without Supabase.

import ExcelJS from "exceljs";

import { HOUSE_DOCUMENT_STANDARD } from "@/lib/export/house-xlsx-palette";
import { houseCairoDateTime, houseGeneratedAt } from "@/lib/export/house-xlsx-identity";
import { addPhoenixTableSheet, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";

import type { PayrollResignationCandidateRecord, ResignationRecord } from "./types";
import { formatPayoutMonth, formatResignationDate, resignationStatusLabel } from "./view-model";

export type ResignationHistoryPerson = {
  areaName: string | null;
  departmentName: string | null;
  employmentStatus: string | null;
  exitCategory: string | null;
  exitReason: string | null;
  managerName: string | null;
  nameAr: string | null;
  regionName: string | null;
};

export type ResignationHistoryLookups = {
  /** A person's name for an actor id (created/reviewed/approved/…), or null when it names nobody. */
  actorName: (id: string | null | undefined) => string | null;
  /** The subject's organisational and exit details, or null when no employee row exists. */
  person: (hrId: string | null | undefined) => ResignationHistoryPerson | null;
  /** The linked replacement vacancy's status (open / filled / cancelled), or null when none is linked. */
  vacancyStatus: (recordId: string) => string | null;
};

const DASH = "-";

/** Rows the compatibility path synthesises for leavers with no employee_resignations row. */
const LEGACY_RECORD_PREFIX = "legacy:";

function text(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed || DASH;
}

function dateCell(value: string | null | undefined) {
  return value ? formatResignationDate(value) : DASH;
}

/** A workflow timestamp, in Cairo local time — never raw UTC. */
function dateTimeCell(value: string | null | undefined) {
  return houseCairoDateTime(value) || DASH;
}

/** Money stays a real number so Excel can sum and sort it; a missing figure is a blank, never 0. */
function moneyCell(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function humanize(value: string) {
  const words = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : DASH;
}

function parseDateOnly(value: string | null | undefined) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  return { day: Number(match[3]), month: Number(match[2]), year: Number(match[1]) };
}

/**
 * Whole calendar months from hire to last working day, read as "2 years 3 months".
 * A missing date, or a hire date AFTER the last working day, has no honest answer and reads "-".
 */
export function formatLengthOfService(hireDate: string | null | undefined, lastWorkingDate: string | null | undefined) {
  const start = parseDateOnly(hireDate);
  const end = parseDateOnly(lastWorkingDate);
  if (!start || !end) return DASH;
  let months = (end.year - start.year) * 12 + (end.month - start.month);
  if (end.day < start.day) months -= 1;
  if (months < 0) return DASH;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0 && rest === 0) return "Under 1 month";
  return [
    years > 0 ? `${years} ${years === 1 ? "year" : "years"}` : null,
    rest > 0 ? `${rest} ${rest === 1 ? "month" : "months"}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** "declined_offer" is an exit CATEGORY that can sit on a terminated status — it wins the label. */
export function resignationEmploymentStatusLabel(
  employmentStatus: string | null | undefined,
  exitCategory: string | null | undefined,
) {
  if (String(exitCategory ?? "").toLowerCase() === "declined_offer") return "Declined offer";
  const status = String(employmentStatus ?? "").trim();
  return status ? humanize(status) : DASH;
}

const settlementRuleLabels: Record<string, string> = {
  after_25: "Left after the 25th (full month)",
  non_resignation: "Company-ended exit (prorated, no allowances)",
  on_or_before_25: "Left on or before the 25th (day rate)",
};

const paymentModeLabels: Record<string, string> = {
  one_part: "One part",
  two_parts: "Two parts",
};

function vacancyStatusLabel(status: string | null) {
  return status ? humanize(status) : "None linked";
}

// Human-readable headers, never raw column codes — a person reads this sheet, not a parser.
// No column is flagged `numeric`: that flag adds a SUM() total row, and every money figure here
// belongs to that one leaver's own exit month, so a total across years of leavers means nothing.
export const resignationHistoryColumns: ExportColumn[] = [
  { key: "employee", label: "Employee", width: 30 },
  { key: "nameAr", label: "Arabic Name", width: 28 },
  { key: "hrId", label: "HR ID", text: true, width: 11 },
  { key: "jobTitle", label: "Job Title", width: 26 },
  { key: "line", label: "Line", width: 16 },
  { key: "area", label: "Area", width: 20 },
  { key: "region", label: "Region", width: 16 },
  { key: "department", label: "Department", width: 20 },
  { key: "manager", label: "Direct Manager", width: 26 },
  { key: "hired", label: "Hire Date", width: 13 },
  { key: "submitted", label: "Submitted", width: 13 },
  { key: "lastWorkingDay", label: "Last Working Day", width: 13 },
  { key: "service", label: "Length of Service", width: 18 },
  { key: "workflowStatus", label: "Workflow Status", width: 15 },
  { key: "employmentStatus", label: "Employment Status", width: 17 },
  { key: "reason", label: "Reason", width: 40 },
  { key: "source", label: "Record Source", width: 22 },
  { key: "createdBy", label: "Created By", width: 24 },
  { key: "createdAt", label: "Created On", width: 20 },
  { key: "reviewedBy", label: "Reviewed By", width: 24 },
  { key: "reviewedAt", label: "Reviewed On", width: 20 },
  { key: "approvedBy", label: "Approved By", width: 24 },
  { key: "approvedAt", label: "Approved On", width: 20 },
  { key: "rejectedBy", label: "Rejected By", width: 24 },
  { key: "rejectedAt", label: "Rejected On", width: 20 },
  { key: "rejectedReason", label: "Rejection Reason", width: 30 },
  { key: "completedBy", label: "Completed By", width: 24 },
  { key: "completedAt", label: "Completed On", width: 20 },
  { key: "cancelledBy", label: "Cancelled By", width: 24 },
  { key: "cancelledAt", label: "Cancelled On", width: 20 },
  { key: "vacancy", label: "Replacement Vacancy", width: 18 },
  { key: "settlementRule", label: "Settlement Rule", width: 34 },
  { key: "daysPaid", label: "Days Paid", width: 10 },
  { key: "baseSalary", label: "Base Salary (EGP)", width: 15 },
  { key: "due", label: "Due in Exit Month, Before Deductions (EGP)", width: 20 },
  { key: "firstPart", label: "Part 1 (EGP)", width: 13 },
  { key: "secondPart", label: "Part 2 (EGP)", width: 13 },
  { key: "paymentMode", label: "Payment Mode", width: 13 },
  { key: "devicesCount", label: "Devices Not Returned", width: 12 },
  { key: "devices", label: "Devices Not Returned (Detail)", width: 40 },
  { key: "devicesValue", label: "Devices Agreed Value (EGP)", width: 15 },
  { key: "workflowNotes", label: "Workflow Notes", width: 60 },
];

export function buildResignationHistoryRows(
  records: readonly ResignationRecord[],
  lookups: ResignationHistoryLookups,
): ExportRow[] {
  const actor = (id: string | null | undefined) => (id ? lookups.actorName(id) ?? id : DASH);

  return records.map((record) => {
    const person = lookups.person(record.employeeHrId);
    const settlement = record.settlement;
    const devices = record.outstandingDevices ?? [];
    const pricedDevices = devices.filter((device) => device.agreedValueEgp !== null);

    return {
      approvedAt: dateTimeCell(record.approvedAt),
      approvedBy: actor(record.approvedBy),
      area: text(person?.areaName),
      baseSalary: moneyCell(settlement?.baseSalary),
      cancelledAt: dateTimeCell(record.cancelledAt),
      cancelledBy: actor(record.cancelledBy),
      completedAt: dateTimeCell(record.completedAt),
      completedBy: actor(record.completedBy),
      createdAt: dateTimeCell(record.createdAt),
      createdBy: record.createdByName ?? actor(record.createdBy),
      daysPaid: settlement ? settlement.daysWorked : null,
      department: text(person?.departmentName),
      devices: devices.length
        ? devices.map((device) => `${device.category} ${device.assetTag} (${device.identifier})`).join("; ")
        : DASH,
      devicesCount: devices.length,
      devicesValue: pricedDevices.length
        ? moneyCell(pricedDevices.reduce((sum, device) => sum + Number(device.agreedValueEgp), 0))
        : null,
      due: moneyCell(settlement?.total),
      employee: record.employeeName,
      employmentStatus: resignationEmploymentStatusLabel(
        person?.employmentStatus ?? record.employeeStatus,
        person?.exitCategory ?? record.exitCategory,
      ),
      firstPart: moneyCell(settlement?.firstPart),
      hired: dateCell(record.hireDate),
      hrId: record.employeeHrId,
      jobTitle: text(record.jobTitle),
      lastWorkingDay: dateCell(record.effectiveDate),
      line: text(record.lineName),
      manager: text(person?.managerName),
      nameAr: text(person?.nameAr),
      paymentMode: settlement ? paymentModeLabels[settlement.paymentMode] ?? humanize(settlement.paymentMode) : DASH,
      reason: text(record.reason ?? person?.exitReason),
      region: text(person?.regionName),
      rejectedAt: dateTimeCell(record.rejectedAt),
      rejectedBy: actor(record.rejectedBy),
      rejectedReason: text(record.rejectedReason),
      reviewedAt: dateTimeCell(record.reviewedAt),
      reviewedBy: actor(record.reviewedBy),
      secondPart: moneyCell(settlement?.secondPart),
      service: formatLengthOfService(record.hireDate, record.effectiveDate),
      settlementRule: settlement ? settlementRuleLabels[settlement.branch] ?? humanize(settlement.branch) : DASH,
      source: record.id.startsWith(LEGACY_RECORD_PREFIX) ? "Historical (no workflow record)" : "Resignation workflow",
      submitted: dateCell(record.submittedDate),
      vacancy: record.id.startsWith(LEGACY_RECORD_PREFIX) ? DASH : vacancyStatusLabel(lookups.vacancyStatus(record.id)),
      workflowNotes: text(record.workflowNotes),
      workflowStatus: resignationStatusLabel(record.status),
    };
  });
}

export const payrollCandidateHistoryColumns: ExportColumn[] = [
  { key: "employee", label: "Employee", width: 30 },
  { key: "nameAr", label: "Arabic Name", width: 28 },
  { key: "hrId", label: "HR ID", text: true, width: 11 },
  { key: "jobTitle", label: "Job Title", width: 26 },
  { key: "line", label: "Line", width: 16 },
  { key: "area", label: "Area", width: 20 },
  { key: "hired", label: "Hire Date", width: 13 },
  { key: "lastPayout", label: "Last Payout", width: 13 },
  { key: "firstSeen", label: "First Seen", width: 20 },
  { key: "lastSeen", label: "Last Seen", width: 20 },
  { key: "sourceFile", label: "Source File", width: 34 },
  { key: "sourceRow", label: "Source Row", width: 10 },
  { key: "addedBy", label: "Added By", width: 24 },
];

export function buildPayrollCandidateHistoryRows(
  candidates: readonly PayrollResignationCandidateRecord[],
  lookups: Pick<ResignationHistoryLookups, "actorName">,
): ExportRow[] {
  return candidates.map((candidate) => ({
    addedBy: candidate.createdBy ? lookups.actorName(candidate.createdBy) ?? candidate.createdBy : DASH,
    area: text(candidate.areaName),
    employee: candidate.employeeName,
    firstSeen: dateTimeCell(candidate.firstSeenAt),
    hired: dateCell(candidate.hireDate),
    hrId: text(candidate.hrId),
    jobTitle: text(candidate.jobTitle),
    lastPayout: formatPayoutMonth(candidate.lastPayoutMonth, candidate.lastPayoutYear),
    lastSeen: dateTimeCell(candidate.lastSeenAt),
    line: text(candidate.lineName),
    nameAr: text(candidate.nameAr),
    sourceFile: text(candidate.sourceFileName),
    sourceRow: candidate.sourceRow,
  }));
}

export async function buildResignationHistoryWorkbook(input: {
  generatedAt: string;
  lookups: ResignationHistoryLookups;
  payrollCandidates: readonly PayrollResignationCandidateRecord[];
  records: readonly ResignationRecord[];
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date(input.generatedAt);

  const provenance = `${HOUSE_DOCUMENT_STANDARD} · Generated ${houseGeneratedAt(input.generatedAt)}`;

  addPhoenixTableSheet(workbook, {
    columns: resignationHistoryColumns,
    rows: buildResignationHistoryRows(input.records, input.lookups),
    sheetName: "Resignations",
    subtitle: `${input.records.length} exit records — open, closed and historical · ${provenance}`,
    theme: "house",
    title: "Resignations — Full History",
  });

  addPhoenixTableSheet(workbook, {
    columns: payrollCandidateHistoryColumns,
    rows: buildPayrollCandidateHistoryRows(input.payrollCandidates, input.lookups),
    sheetName: "Payroll Candidates",
    subtitle: `${input.payrollCandidates.length} leavers seen in payroll files but missing from the directory · ${provenance}`,
    theme: "house",
    title: "Resignations — Payroll Candidates",
  });

  return await workbook.xlsx.writeBuffer();
}
