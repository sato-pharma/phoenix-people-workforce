// Recruitment workspace — the rows on screen, as an Excel workbook (owner's plan, 20 Oct 2026: an
// export of "the current filtered view").
//
// THE FILE IS THE SCREEN'S QUESTION, NOT A NEW ONE. The route hands this module exactly the rows the
// workspace returns for the same filters and the same viewer (`loadWorkspaceRowsForExport`), so the
// viewer's tabs and the Talent Acquisition fence have already been applied inside the database filter
// before a row reaches here. Nothing in this file widens or narrows that set.
//
// ONE COLUMN PER QUESTION. The answers are the chips the screen shows for the tab being viewed —
// FROM THE APPLICANT'S OWN REPLIES ONLY, never a CV guess — laid out as one column each, the Medical
// Rep six first in the owner's order. A question the person was asked and never answered reads
// "Not answered" (the screen's amber chip); an answer HR typed in their place says "(added by HR)"; a
// question that person was never asked is a BLANK cell, never "Not answered", because a question they
// were never going to be asked is not missing.
//
// Every name is a link to that CV in Phoenix when an origin is given. The link needs a Phoenix sign-in
// and the workspace's own access check, so a file forwarded to somebody else opens nothing.
//
// The house identity, SATO-DIS-2026-01 v1.0: ink, not fills, except the 6% zebra — the same idiom as
// the interview calendar's workbook. Times are Cairo, the zone in the column heading.
//
// Pure apart from ExcelJS: no database, no request. The row-value and filename functions are pinned
// by `tests/recruitment-workspace-export.test.ts`.

import ExcelJS from "exceljs";

import {
  HOUSE_XLSX_COLORS,
  houseBodyStyle,
  houseCairoDateTime,
  houseGeneratedAt,
  houseHeaderStyle,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import { candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { candidateStatusLabels, type CandidateStatus } from "@/lib/recruitment/candidate-status";
import { interviewOutcomeLabels, type InterviewOutcome } from "@/lib/recruitment/interview-calendar-types";
import { quickDatePickLabels, type WorkspaceFilters } from "@/lib/recruitment/workspace/filters";
import { workspaceCandidateHref } from "@/lib/recruitment/workspace/links";
import {
  FOLDERS_TAB,
  workspaceRoleTabLabels,
  workspaceTabLabels,
  type WorkspaceTabKey,
} from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspacePlacement, WorkspaceRow } from "@/lib/recruitment/workspace/types";
import {
  callResultLabels,
  candidateSourceLabels,
  districtReturnReasonLabels,
  rejectionReasonLabels,
  returnSourceLabels,
} from "@/lib/recruitment/workspace/vocabulary";

/**
 * The screen's own word for an unanswered question — `NOT_ANSWERED_LABEL` in answer-chips.ts, which
 * this pure module does not import because that file reads the database. The export test pins the two
 * equal, so they cannot drift.
 */
export const EXPORT_NOT_ANSWERED = "Not answered";
export const EXPORT_ADDED_BY_HR_SUFFIX = " (added by HR)";
/** The Filed-in cell for a person no reply has filed yet — the screen's own tab name. */
export const EXPORT_NEEDS_PLACING = workspaceTabLabels.needs_placing;

export type WorkspaceExportAnswerColumn = { key: string; label: string; lead: boolean };

/** The fixed columns before and after the answers, with their widths. Names, never codes. */
const LEADING_COLUMNS: ReadonlyArray<{ label: string; width: number }> = [
  { label: "Name", width: 26 },
  { label: "Phone", width: 16 },
  { label: "Email", width: 28 },
  { label: "Source", width: 16 },
  { label: "Received (Cairo)", width: 20 },
  { label: "Status", width: 26 },
  { label: "Filed in", width: 30 },
];
const TRAILING_COLUMNS: ReadonlyArray<{ label: string; width: number }> = [
  { label: "Latest call (Cairo)", width: 32 },
  { label: "Returned by a manager (Cairo)", width: 34 },
  { label: "Interview (Cairo)", width: 26 },
];
const ANSWER_COLUMN_WIDTH = 22;

/**
 * One column per question any exported row carries, in the order the screen shows them: the Medical
 * Rep six (`lead`) first, then every other question in the order it first appears. The label is the
 * chip's own label, so a column heading is the words the screen uses for that question.
 */
export function workspaceExportAnswerColumns(rows: ReadonlyArray<Pick<WorkspaceRow, "answers">>): WorkspaceExportAnswerColumn[] {
  const seen = new Map<string, WorkspaceExportAnswerColumn>();
  for (const row of rows) {
    for (const chip of row.answers) {
      const existing = seen.get(chip.key);
      if (!existing) seen.set(chip.key, { key: chip.key, label: chip.label, lead: chip.lead });
      else if (chip.lead && !existing.lead) existing.lead = true;
    }
  }
  const columns = [...seen.values()];
  // A stable partition: leads first, each half in first-appearance order.
  return [...columns.filter((column) => column.lead), ...columns.filter((column) => !column.lead)];
}

/** Every heading, in column order. */
export function workspaceExportHeaders(answerColumns: readonly WorkspaceExportAnswerColumn[]): string[] {
  return [
    ...LEADING_COLUMNS.map((column) => column.label),
    ...answerColumns.map((column) => column.label),
    ...TRAILING_COLUMNS.map((column) => column.label),
  ];
}

/** "Medical Rep · Alexandria · Smouha" — one filing, the screen's own wording. */
export function workspaceExportPlacementLabel(placement: Pick<WorkspacePlacement, "tab" | "regionName" | "areaName">): string {
  const parts: string[] = [workspaceRoleTabLabels[placement.tab] ?? "Other"];
  if (placement.regionName) parts.push(placement.regionName);
  if (placement.areaName) parts.push(placement.areaName);
  return parts.join(" · ");
}

/** "Rejected — Wrong degree", "Rejected — Other: moved abroad", "Rejected — Salary too high (archived)". */
export function workspaceExportStatus(row: Pick<WorkspaceRow, "status" | "rejection" | "archivedAt">): string {
  const label = candidateStatusLabels[row.status as CandidateStatus] ?? "Unknown";
  let text = label;
  if (row.status === "rejected" && row.rejection) {
    const reason = row.rejection.reason ? rejectionReasonLabels[row.rejection.reason] : null;
    const note = row.rejection.note?.trim() || null;
    const why = reason && note ? `${reason}: ${note}` : (reason ?? note);
    if (why) text = `${label} — ${why}`;
  }
  return row.archivedAt ? `${text} (archived)` : text;
}

/** One answer cell: the answer, "Not answered", or blank when this person was never asked it. */
export function workspaceExportAnswerCell(row: Pick<WorkspaceRow, "answers">, key: string): string {
  const chip = row.answers.find((candidate) => candidate.key === key);
  if (!chip) return "";
  if (chip.value === null) return EXPORT_NOT_ANSWERED;
  return chip.addedByHr ? `${chip.value}${EXPORT_ADDED_BY_HR_SUFFIX}` : chip.value;
}

function joinBits(bits: Array<string | null | undefined>): string {
  return bits.map((bit) => (bit ?? "").trim()).filter(Boolean).join(" · ");
}

function latestCallCell(row: Pick<WorkspaceRow, "latestCall">): string {
  const call = row.latestCall;
  if (!call) return "";
  return joinBits([callResultLabels[call.result], houseCairoDateTime(call.at), call.byName, call.note]);
}

function returnedCell(row: Pick<WorkspaceRow, "returned">): string {
  const back = row.returned;
  if (!back) return "";
  // An unknown source or reason code is left out rather than printed as a code.
  return joinBits([
    returnSourceLabels[back.source] ?? "Returned",
    back.byName,
    back.reasonCode ? (districtReturnReasonLabels[back.reasonCode] ?? null) : null,
    houseCairoDateTime(back.at),
    back.note,
  ]);
}

function interviewCell(row: Pick<WorkspaceRow, "interview">): string {
  const interview = row.interview;
  if (!interview) return "";
  const outcome = interview.outcome ? (interviewOutcomeLabels[interview.outcome as InterviewOutcome] ?? null) : null;
  return joinBits([houseCairoDateTime(interview.startsAt), outcome]);
}

export type WorkspaceExportRowValues = {
  /** Every cell as text, in `workspaceExportHeaders` order. The name is cells[0]. */
  cells: string[];
  /** Where the name links: this CV in Phoenix. Null when no origin was given. */
  nameHref: string | null;
};

/** One person's row. Blank, never a placeholder, wherever there is nothing to say. */
export function workspaceExportRowValues(
  row: WorkspaceRow,
  answerColumns: readonly WorkspaceExportAnswerColumn[],
  options: { origin?: string | null; tab?: WorkspaceTabKey | null } = {},
): WorkspaceExportRowValues {
  const origin = options.origin ? options.origin.replace(/\/+$/, "") : null;
  // The CV opens in the tab the export was taken from; the folders view is not a tab a CV opens in.
  const tab = options.tab && options.tab !== FOLDERS_TAB ? options.tab : null;
  return {
    cells: [
      row.name,
      row.phone ?? "",
      row.email ?? "",
      candidateSourceLabels[row.source] ?? candidateSourceLabels.other,
      houseCairoDateTime(row.receivedAt),
      workspaceExportStatus(row),
      row.placements.length > 0 ? row.placements.map(workspaceExportPlacementLabel).join("; ") : EXPORT_NEEDS_PLACING,
      ...answerColumns.map((column) => workspaceExportAnswerCell(row, column.key)),
      latestCallCell(row),
      returnedCell(row),
      interviewCell(row),
    ],
    nameHref: origin ? `${origin}${workspaceCandidateHref(row.id, tab)}` : null,
  };
}

function regionName(code: string, rows: readonly WorkspaceRow[]): string {
  if (code === "unspecified") return "Region not given";
  const fromRows = rows.flatMap((row) => row.placements).find((placement) => placement.regionCode === code)?.regionName;
  return fromRows ?? candidateRegionLabels[code as CandidateRegionCode] ?? "One region";
}

function areaName(code: string, rows: readonly WorkspaceRow[]): string {
  return rows.flatMap((row) => row.placements).find((placement) => placement.areaCode === code)?.areaName ?? "One area";
}

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" });

/** A filter's Cairo calendar day ("2026-10-01") as "1 Oct 2026" — a date-only value, so read in UTC. */
function dayLabel(dateIso: string): string {
  const at = new Date(`${dateIso}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? dateIso : DAY_LABEL.format(at);
}

/**
 * What the file is filtered to, in words — the masthead's subtitle. A filter left clean is not
 * mentioned; with every filter clean it says so, so a reader never wonders what was left out.
 */
export function workspaceExportFilterLine(
  filters: WorkspaceFilters,
  tab: WorkspaceTabKey | null,
  rows: readonly WorkspaceRow[] = [],
): string {
  const parts: string[] = [tab ? workspaceTabLabels[tab] : "Every tab"];
  if (filters.region) parts.push(regionName(filters.region, rows));
  if (filters.area) parts.push(areaName(filters.area, rows));
  if (filters.statuses.length > 0) {
    parts.push(filters.statuses.map((status) => candidateStatusLabels[status as CandidateStatus] ?? "Other status").join(" or "));
  }
  if (filters.sources.length > 0) {
    parts.push(`from ${filters.sources.map((source) => candidateSourceLabels[source]).join(" or ")}`);
  }
  if (filters.datePick) parts.push(`received ${quickDatePickLabels[filters.datePick].toLowerCase()}`);
  else if (filters.fromDate || filters.toDate) {
    const from = filters.fromDate ? `${dayLabel(filters.fromDate)}${filters.fromTime ? ` ${filters.fromTime}` : ""}` : null;
    const to = filters.toDate ? `${dayLabel(filters.toDate)}${filters.toTime ? ` ${filters.toTime}` : ""}` : null;
    parts.push(from && to ? `received ${from} to ${to} (Cairo)` : from ? `received from ${from} (Cairo)` : `received up to ${to} (Cairo)`);
  }
  const answerFilters = Object.values(filters.answers).filter((values) => values.length > 0).length;
  if (answerFilters > 0) parts.push(`${answerFilters} answer filter${answerFilters === 1 ? "" : "s"}`);
  if (filters.missing === true) parts.push("missing answers only");
  if (filters.missing === false) parts.push("every answer given");
  if (filters.callResults.length > 0) {
    parts.push(`latest call ${filters.callResults.map((result) => callResultLabels[result].toLowerCase()).join(" or ")}`);
  }
  if (filters.returned === true) parts.push("returned by a manager");
  if (filters.returned === false) parts.push("not returned");
  if (filters.overdue === true) parts.push("overdue only");
  if (filters.overdue === false) parts.push("not overdue");
  if (filters.folderIds.length > 0) parts.push(`in ${filters.folderIds.length} folder${filters.folderIds.length === 1 ? "" : "s"}`);
  if (filters.archived === "include") parts.push("archived included");
  if (filters.archived === "only") parts.push("archived only");
  if (filters.search) parts.push(`search “${filters.search}”`);
  return parts.length === 1 ? `${parts[0]} · no other filter` : parts.join(" · ");
}

const FILE_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Cairo", year: "numeric" });

/** "recruitment-cvs-medical-rep-20-oct-2026.xlsx" — the tab's name and the Cairo day. Names, never codes. */
export function workspaceExportFilename(tab: WorkspaceTabKey | null, generatedAtIso: string): string {
  const at = new Date(generatedAtIso);
  const day = Number.isNaN(at.getTime()) ? "" : FILE_DATE.format(at);
  const slug = [tab ? workspaceTabLabels[tab] : "every tab", day]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `recruitment-cvs-${slug}.xlsx`;
}

export type WorkspaceExportInput = {
  rows: readonly WorkspaceRow[];
  filters: WorkspaceFilters;
  /** The tab the rows were read in (`viewedTab`); null for a search across every tab. */
  tab: WorkspaceTabKey | null;
  generatedAtIso: string;
  /** e.g. "https://phoenix-hr.satopharma.com" — every name links to its CV when given. */
  origin?: string | null;
  /** Set when more rows matched than the file holds: the ceiling that was applied. */
  truncatedAt?: number | null;
  exportedBy?: string | null;
};

export async function buildWorkspaceWorkbook(input: WorkspaceExportInput): Promise<Buffer> {
  const answerColumns = workspaceExportAnswerColumns(input.rows);
  const headers = workspaceExportHeaders(answerColumns);
  const widths = [
    ...LEADING_COLUMNS.map((column) => column.width),
    ...answerColumns.map(() => ANSWER_COLUMN_WIDTH),
    ...TRAILING_COLUMNS.map((column) => column.width),
  ];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date(input.generatedAtIso);

  const sheet = workbook.addWorksheet("CVs", {
    pageSetup: { fitToHeight: 0, fitToPage: true, fitToWidth: 1, orientation: "landscape", paperSize: 9 },
    properties: { defaultRowHeight: 18 },
  });
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  const count = input.rows.length;
  const countLine = `${count.toLocaleString("en-US")} CV${count === 1 ? "" : "s"}${input.truncatedAt ? " (more match)" : ""}`;
  let row = writeHouseMasthead(workbook, sheet, {
    columns: headers.length,
    provenance: [
      `Generated ${houseGeneratedAt(input.generatedAtIso)}`,
      countLine,
      ...(input.exportedBy ? [`Exported by ${input.exportedBy}`] : []),
    ],
    subtitle: `${workspaceExportFilterLine(input.filters, input.tab, input.rows)}. Click a name to open the CV in Phoenix.`,
    title: input.tab ? `CVs — ${workspaceTabLabels[input.tab]}` : "CVs — every tab",
  });

  const headerRow = sheet.getRow(row);
  headerRow.height = 30;
  headers.forEach((label, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = label;
    houseHeaderStyle(cell);
    cell.alignment = { ...cell.alignment, vertical: "middle", wrapText: true };
  });
  sheet.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: row }];
  row += 1;

  input.rows.forEach((person, index) => {
    const values = workspaceExportRowValues(person, answerColumns, { origin: input.origin, tab: input.tab });
    const excelRow = sheet.getRow(row);
    const zebra = index % 2 === 1;
    values.cells.forEach((text, column) => {
      const cell = excelRow.getCell(column + 1);
      cell.value =
        column === 0 && values.nameHref
          ? { hyperlink: values.nameHref, text, tooltip: `Open ${text}'s CV in Phoenix` }
          : text;
      houseBodyStyle(cell, { zebra });
      cell.alignment = { vertical: "top", wrapText: true };
      if (column === 0 && values.nameHref) {
        cell.font = { color: { argb: HOUSE_XLSX_COLORS.blue }, name: cell.font?.name, size: 10, underline: true };
      } else if (text === EXPORT_NOT_ANSWERED) {
        cell.font = { ...cell.font, color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true };
      }
    });
    row += 1;
  });

  if (count === 0) {
    row += 1;
    sheet.mergeCells(row, 1, row, headers.length);
    sheet.getCell(row, 1).value = "No CVs match these filters.";
    sheet.getCell(row, 1).font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, size: 10 };
  } else if (input.truncatedAt) {
    row += 1;
    sheet.mergeCells(row, 1, row, headers.length);
    sheet.getCell(row, 1).value =
      `Only the first ${input.truncatedAt.toLocaleString("en-US")} CVs are in this file. Narrow the filters to export the rest.`;
    sheet.getCell(row, 1).font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, size: 10 };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
