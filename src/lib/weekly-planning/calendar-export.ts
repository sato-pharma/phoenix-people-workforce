import ExcelJS from "exceljs";

import { addPhoenixTableSheet, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import {
  planKindLabel,
  planStatusLabel,
  type PlanningCalendarPlanItem,
} from "@/lib/weekly-planning/calendar";

// XLSX export for the shared Planning Calendar — a two-sheet workbook built from the
// same plan items the on-screen calendar shows for a given month:
//   • "Summary"        — one row per user (plan-entry count, weekly/monthly split, conflict count).
//   • "Detailed Plans" — one row per plan activity, grouped by user (sorted by employee then date).
// The row builders are pure and side-effect-free so they can be unit-tested without ExcelJS;
// buildPlanningCalendarWorkbook is the only part that touches the workbook.

function displayName(item: PlanningCalendarPlanItem): string {
  return (item.employeeDisplayName || item.employeeName || "Unknown employee").trim();
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function weekdayLabel(dateIso: string): string {
  if (!dateIso) return "";
  return new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(new Date(`${dateIso}T00:00:00Z`));
}

// Detail sheet: HR ID and Date are identifiers, not quantities — forced to Excel text so a
// value like "B-155" or a leading-zero date is never reinterpreted as a number/date on open.
export const PLANNING_DETAIL_COLUMNS: ExportColumn[] = [
  { key: "employee", label: "Employee" },
  { key: "hrId", label: "HR ID", text: true },
  { key: "jobTitle", label: "Job Title" },
  { key: "line", label: "Line" },
  { key: "date", label: "Date", text: true },
  { key: "day", label: "Day" },
  { key: "activity", label: "Activity" },
  { key: "location", label: "Region / Location" },
  { key: "area", label: "Area" },
  { key: "medicalRep", label: "Medical Rep" },
  { key: "time", label: "Time" },
  { key: "status", label: "Plan Status" },
  { key: "planKind", label: "Plan Kind" },
  { key: "conflict", label: "Chain Visit" },
  { key: "notes", label: "Notes" },
];

// Summary sheet: the four counts are numeric so addPhoenixTableSheet right-aligns them and
// writes a SUM() TOTAL row (total plan entries / conflicts across the company for the month).
export const PLANNING_SUMMARY_COLUMNS: ExportColumn[] = [
  { key: "employee", label: "Employee" },
  { key: "hrId", label: "HR ID", text: true },
  { key: "jobTitle", label: "Job Title" },
  { key: "line", label: "Line" },
  { key: "planEntries", label: "Plan Entries", numeric: true },
  { key: "weekly", label: "Weekly", numeric: true },
  { key: "monthly", label: "Monthly", numeric: true },
  { key: "conflicts", label: "Chain Visits", numeric: true },
];

export function buildPlanningCalendarDetailRows(items: PlanningCalendarPlanItem[]): ExportRow[] {
  return [...items]
    .sort(
      (a, b) =>
        displayName(a).localeCompare(displayName(b)) ||
        a.startDate.localeCompare(b.startDate) ||
        (a.time ?? "").localeCompare(b.time ?? "") ||
        a.activityTitle.localeCompare(b.activityTitle),
    )
    .map((item) => ({
      employee: displayName(item),
      hrId: item.employeeHrId || "-",
      jobTitle: item.employeeJobTitle || "-",
      line: item.lineName || "-",
      date: item.startDate,
      day: weekdayLabel(item.startDate),
      activity: item.activityTitle,
      location: item.region || "-",
      area: item.area || "-",
      // A rep who is booked but has left the directory (a Phoenix CRM half-day keeps the id and
      // loses the name) is shown as "Unnamed", never as the HR id: an id is a code, not a name.
      medicalRep: item.medicalRepDisplayName || item.medicalRepName || (item.medicalRepHrId ? "Unnamed" : "-"),
      time: item.time || "Full day",
      status: planStatusLabel(item.status),
      planKind: planKindLabel(item.planKind),
      conflict: item.conflictWarning || "-",
      notes: item.notes || "-",
    }));
}

type SummaryAccumulator = {
  employee: string;
  hrId: string;
  jobTitle: string;
  line: string;
  planEntries: number;
  weekly: number;
  monthly: number;
  conflicts: number;
};

export function buildPlanningCalendarSummaryRows(items: PlanningCalendarPlanItem[]): ExportRow[] {
  const byOwner = new Map<string, SummaryAccumulator>();
  for (const item of items) {
    // Group by HR ID (case-insensitive, matching how HR IDs are normalized elsewhere); fall back
    // to the name so a plan with a blank HR ID still aggregates rather than vanishing.
    const key = (item.employeeHrId || item.employeeName || "").trim().toUpperCase() || "UNKNOWN";
    const existing =
      byOwner.get(key) ??
      ({
        employee: displayName(item),
        hrId: item.employeeHrId || "-",
        jobTitle: item.employeeJobTitle || "-",
        line: item.lineName || "-",
        planEntries: 0,
        weekly: 0,
        monthly: 0,
        conflicts: 0,
      } satisfies SummaryAccumulator);
    existing.planEntries += 1;
    const kind = String(item.planKind).toLowerCase();
    if (kind === "weekly") existing.weekly += 1;
    else if (kind === "monthly") existing.monthly += 1;
    if (item.conflictWarning) existing.conflicts += 1;
    // Backfill labels a later plan carries but the first one for this owner lacked.
    if (existing.jobTitle === "-" && item.employeeJobTitle) existing.jobTitle = item.employeeJobTitle;
    if (existing.line === "-" && item.lineName) existing.line = item.lineName;
    byOwner.set(key, existing);
  }
  return [...byOwner.values()]
    .sort((a, b) => a.employee.localeCompare(b.employee) || a.hrId.localeCompare(b.hrId))
    .map((row) => ({ ...row }));
}

export function planningCalendarExportFileName(year: number, month: number): string {
  return `Phoenix Planning Calendar ${year}-${String(month).padStart(2, "0")}.xlsx`;
}

export async function buildPlanningCalendarWorkbook(input: {
  items: PlanningCalendarPlanItem[];
  year: number;
  month: number;
  generatedAt?: Date;
}) {
  const { items, year, month } = input;
  const generatedAt = input.generatedAt ?? new Date();
  const label = monthLabel(year, month);
  const subtitle = `Phoenix Workforce · ${label} · ${items.length} plan ${
    items.length === 1 ? "entry" : "entries"
  } · exported ${formatPhoenixDateTime(generatedAt)} (Cairo)`;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = generatedAt;

  addPhoenixTableSheet(workbook, {
    title: `Planning Calendar · Per-User Summary · ${label}`,
    subtitle,
    sheetName: "Summary",
    columns: PLANNING_SUMMARY_COLUMNS,
    rows: buildPlanningCalendarSummaryRows(items),
  });
  addPhoenixTableSheet(workbook, {
    title: `Detailed Plans Per User · ${label}`,
    subtitle,
    sheetName: "Detailed Plans",
    columns: PLANNING_DETAIL_COLUMNS,
    rows: buildPlanningCalendarDetailRows(items),
  });

  return await workbook.xlsx.writeBuffer();
}
