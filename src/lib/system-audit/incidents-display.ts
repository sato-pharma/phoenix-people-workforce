/**
 * System Error & Data Integrity Audit — what each of the 11 columns SAYS, in one place.
 *
 * The screen table, the phone cards, the CSV and the XLSX all build their cells from these
 * functions, so a column can never read one way on screen and another way in the file the owner
 * downloads. Client-safe: no database, no server-only import (the incidents table is a client
 * component).
 *
 * The rules each function holds, from the owner's brief:
 *   · column 6 is the words the PERSON saw — never the stack, never an invented sentence. When the
 *     words were not recorded it says so (USER_MESSAGE_NOT_CAPTURED / SILENT_DATA_MESSAGE); the
 *     technical message lives in the drawer, labelled "System message".
 *   · a row with no person is a SYSTEM row: "System" in the name cell, never a blank, and its
 *     column 10 is "—" because there is no employee to count for.
 *   · every date and time is Africa/Cairo.
 */

import { cairoDate, cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import {
  ROOT_CAUSE_LEVEL_LABELS,
  SILENT_DATA_MESSAGE,
  SYSTEM_AUDIT_FAMILY_LABELS,
  SYSTEM_AUDIT_STATUS_LABELS,
  USER_MESSAGE_NOT_CAPTURED,
  sharedScopeLabel,
  type ModuleLabelSource,
  type SharedScope,
  type SystemAuditPageRow,
  type SystemAuditSort,
} from "@/lib/system-audit/types";

/** The 11 headings, in the owner's order. Pinned by tests/system-audit-export.test.ts. */
export const INCIDENT_COLUMN_HEADINGS = [
  "HR ID",
  "Employee Name",
  "Module Name",
  "Error Date (Cairo)",
  "Error Time (Cairo)",
  "Error Encountered",
  "Error Code / Incident Ref",
  "Why",
  "Fixed Status",
  "Occurrences (this employee)",
  "Unique vs Shared",
] as const;

export const SYSTEM_ROW_NAME = "System";
export const NAME_NOT_RECORDED = "Name not recorded";

export const MODULE_LABEL_SOURCE_LABELS: Record<ModuleLabelSource, string> = {
  nav_exact: "Sidebar page (exact)",
  nav_parent: "Sidebar page (parent)",
  page_trail: "Page the person was on",
  api_map: "Mapped from the server address",
  detector: "Named by the detector",
  none: "Not in sidebar",
};

export const SYSTEM_AUDIT_SORT_LABELS: Record<SystemAuditSort, string> = {
  occurred_desc: "Newest first",
  occurred_asc: "Oldest first",
  employee: "Employee name",
  module: "Module name",
  person_ops: "Most occurrences per employee",
  people: "Most employees affected",
};

export const SYSTEM_AUDIT_SCOPE_LABELS: Record<SharedScope, string> = {
  only: "Unique — only this employee",
  shared: "Shared — several employees",
  system: "System — no employee",
};

export function isSystemRow(row: Pick<SystemAuditPageRow, "hrKey">): boolean {
  return !row.hrKey;
}

/** Column 1. A system row has no HR ID. */
export function incidentHrId(row: Pick<SystemAuditPageRow, "hrKey" | "hrId">): string {
  if (!row.hrKey) return "—";
  return row.hrId?.trim() || row.hrKey.toUpperCase();
}

/** Column 2. The person's NAME; "System" for a system row, never a blank. */
export function incidentEmployeeName(row: Pick<SystemAuditPageRow, "hrKey" | "employeeName">): string {
  if (!row.hrKey) return SYSTEM_ROW_NAME;
  return row.employeeName?.trim() || NAME_NOT_RECORDED;
}

/** Column 4, for screens: `30 Aug 2026`, Cairo. */
export function incidentCairoDate(row: Pick<SystemAuditPageRow, "occurredAt">): string {
  return cairoDate(row.occurredAt);
}

/** Column 5, for screens and files: `14:05`, Cairo, 24-hour. */
export function incidentCairoTime(row: Pick<SystemAuditPageRow, "occurredAt">): string {
  const sortable = cairoDateTimeSortable(row.occurredAt);
  return sortable ? sortable.slice(11) : "—";
}

/** Column 4, for files: `2026-08-30`, Cairo — sorts and parses as a date in a spreadsheet. */
export function incidentCairoDateSortable(row: Pick<SystemAuditPageRow, "occurredAt">): string {
  return cairoDateTimeSortable(row.occurredAt).slice(0, 10);
}

/**
 * Column 6. The words the person saw, or the honest statement that none were recorded — never the
 * stack trace, never a sentence made up to fill the cell.
 */
export function incidentMessage(row: Pick<SystemAuditPageRow, "userMessage" | "family" | "isSilent">): string {
  const shown = row.userMessage?.trim();
  if (shown) return shown;
  if (row.family === "app_error") return USER_MESSAGE_NOT_CAPTURED;
  return row.isSilent ? SILENT_DATA_MESSAGE : USER_MESSAGE_NOT_CAPTURED;
}

/** The short occurrence reference: the first 8 characters of its id. */
export function incidentShortRef(id: string): string {
  return id.slice(0, 8);
}

/** Column 7: the error code and the short occurrence ref. */
export function incidentCodeAndRef(row: Pick<SystemAuditPageRow, "errorCode" | "id">): string {
  return `${row.errorCode} / ${incidentShortRef(row.id)}`;
}

/** Column 8, split: the level label and the root-cause sentence. */
export function incidentWhyParts(row: Pick<SystemAuditPageRow, "rootCauseLevel" | "rootCause">): {
  level: string;
  text: string;
} {
  return {
    level: ROOT_CAUSE_LEVEL_LABELS[row.rootCauseLevel] ?? row.rootCauseLevel,
    text: row.rootCause?.trim() || "No root cause recorded yet.",
  };
}

/** Column 8 as one cell. */
export function incidentWhy(row: Pick<SystemAuditPageRow, "rootCauseLevel" | "rootCause">): string {
  const { level, text } = incidentWhyParts(row);
  return `${level} — ${text}`;
}

/** Column 9: the owner's word-for-word status label. */
export function incidentStatus(row: Pick<SystemAuditPageRow, "status">): string {
  return SYSTEM_AUDIT_STATUS_LABELS[row.status] ?? row.status;
}

/** Column 10. A system row has no employee to count for. */
export function incidentPersonOps(row: Pick<SystemAuditPageRow, "hrKey" | "personOps">): string {
  return row.hrKey ? String(row.personOps) : "—";
}

/** Column 11. */
export function incidentScope(row: Pick<SystemAuditPageRow, "people" | "hrKey">): string {
  return sharedScopeLabel(row.people, row.hrKey);
}

export function familyLabel(family: SystemAuditPageRow["family"]): string {
  return SYSTEM_AUDIT_FAMILY_LABELS[family] ?? family;
}

export function moduleLabelSourceLabel(source: ModuleLabelSource): string {
  return MODULE_LABEL_SOURCE_LABELS[source] ?? source;
}

/**
 * The totals line: "N incidents · M people · K shared". People and shared are counted over the
 * rows on THIS page (the database returns the filtered total, not a people total), so the line
 * says which is which rather than implying the page is the whole period.
 */
export function incidentTotalsLine(total: number, rows: readonly Pick<SystemAuditPageRow, "hrKey" | "people">[]): string {
  const people = new Set(rows.filter((row) => row.hrKey).map((row) => row.hrKey as string)).size;
  const shared = rows.filter((row) => row.hrKey && row.people >= 2).length;
  const format = (value: number) => value.toLocaleString("en-US");
  return `${format(total)} ${total === 1 ? "incident" : "incidents"} · ${format(people)} ${people === 1 ? "person" : "people"} on this page · ${format(shared)} shared on this page`;
}
