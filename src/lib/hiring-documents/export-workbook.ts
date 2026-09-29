// ─────────────────────────────────────────────────────────────────────────────
// Hiring Documents — the XLSX export, in the SATO house identity with a status signal.
//
// FOUR SHEETS, and the split is the point. A readiness MATRIX answers "where do we stand", and it
// is the sheet that has to be scannable rather than readable: one row per employee, one column per
// checklist document, every cell coloured. A NEEDS ATTENTION list answers "what do I do this
// morning" — one row per outstanding document, most urgent first, so it can be worked top to
// bottom without reading the matrix at all. BY DOCUMENT answers "which paper is the bottleneck".
// The COVER says who took it, when, in Cairo, and with which filters — a saved workbook outlives
// the screen it came from, and a reader six weeks later has no other way to know whether they are
// holding the company or one district.
//
// THE COLOUR IS AN OWNER INSTRUCTION (2026-09-29): green and red, so what needs identifying can be
// identified. `HOUSE_XLSX_SIGNAL` in the palette carries the three pairs and the reasoning. Every
// coloured cell still says its state IN WORDS, so the sheet survives being printed in mono.
// ─────────────────────────────────────────────────────────────────────────────

import ExcelJS from "exceljs";

import { buildHouseCoverSheet } from "@/lib/export/house-table-workbook";
import {
  HOUSE_XLSX_COLORS,
  HOUSE_XLSX_FONT,
  HOUSE_XLSX_SIGNAL,
  type HouseXlsxSignalTone,
} from "@/lib/export/house-xlsx-palette";
import { houseCairoDateTime, houseGeneratedRow, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import { employmentStatusLabel } from "@/lib/employees/employment-status-label";
import {
  describeHiringDocumentFilters,
  hiringDocumentCompletionPercent,
  type HiringDocumentFilterState,
} from "@/lib/hiring-documents/filters";
import {
  HIRING_DOCUMENT_SIGNAL_LABEL,
  HIRING_DOCUMENT_SIGNAL_RANK,
  hiringDocumentDaysOverdue,
  hiringDocumentSignal,
  hiringDocumentSignalNeedsAttention,
  startOfToday,
  type HiringDocumentSignal,
} from "@/lib/hiring-documents/readiness-signal";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringDocumentEntry,
} from "@/lib/hiring-documents/types";

/**
 * Which of the three signal pairs a state takes.
 *
 * 🔴 `unevidenced` IS GREEN, and that is a decision taken against real data rather than an
 * oversight — see `hiringDocumentSignalNeedsAttention`. The paper has arrived, which is the
 * question the matrix answers; with 3 files in the whole database against 380 ticks, colouring the
 * missing SCAN would have painted the sheet amber and hidden the 101 documents that have genuinely
 * not turned up. The cell still says "Submitted · no file" in words, and the gap is counted in its
 * own column on both the matrix and the By Document sheet.
 */
const SIGNAL_TONE: Record<HiringDocumentSignal, HouseXlsxSignalTone> = {
  complete: "good",
  missing: "bad",
  overdue: "bad",
  pending: "warn",
  unevidenced: "good",
};

const HAIR = { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "hair" as const };
const CELL_BORDER = { bottom: HAIR, left: HAIR, right: HAIR, top: HAIR };

export type HiringDocumentsWorkbookInput = {
  documents: HiringDocumentDefinition[];
  /** Already filtered and already narrowed to what this viewer may read. */
  employees: HiringDocumentEmployeeRow[];
  exportedByHrId: string | null;
  exportedByName: string;
  filters: HiringDocumentFilterState;
  generatedAtIso: string;
  role: string;
  /** Injectable so the test can pin the overdue arithmetic against a fixed day. */
  today?: Date;
};

function entryOf(employee: HiringDocumentEmployeeRow, documentId: string): HiringDocumentEntry {
  return (
    employee.documents[documentId] ?? {
      documentId,
      dueDate: null,
      fileCount: 0,
      notes: null,
      status: "pending",
      updatedAt: null,
    }
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  // DATE-ONLY, so it is rendered in UTC on purpose: a hire date or a deadline is a calendar day,
  // and converting it to Cairo shifts it. Only an instant we stamped belongs in Cairo — see
  // `houseCairoDateTime`, which is what the "Last update" column uses.
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

function headerCell(cell: ExcelJS.Cell, label: string, options: { center?: boolean } = {}) {
  cell.value = label;
  cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.white }, name: HOUSE_XLSX_FONT, size: 9.5 };
  cell.alignment = {
    horizontal: options.center ? "center" : "left",
    vertical: "middle",
    wrapText: true,
  };
  cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.blue }, pattern: "solid", type: "pattern" };
  cell.border = {
    bottom: { color: { argb: HOUSE_XLSX_COLORS.deep }, style: "medium" },
    left: { color: { argb: HOUSE_XLSX_COLORS.deep }, style: "thin" },
    right: { color: { argb: HOUSE_XLSX_COLORS.deep }, style: "thin" },
    top: { color: { argb: HOUSE_XLSX_COLORS.deep }, style: "medium" },
  };
}

function bodyCell(
  cell: ExcelJS.Cell,
  value: string | number | null,
  options: { bold?: boolean; center?: boolean; numFmt?: string; right?: boolean; zebra?: boolean } = {},
) {
  cell.value = value === "" ? null : value;
  cell.font = {
    bold: Boolean(options.bold),
    color: { argb: HOUSE_XLSX_COLORS.body },
    name: HOUSE_XLSX_FONT,
    size: 9.5,
  };
  cell.alignment = {
    horizontal: options.center ? "center" : options.right ? "right" : "left",
    indent: options.center || options.right ? 0 : 1,
    vertical: "middle",
  };
  cell.border = CELL_BORDER;
  if (options.numFmt) cell.numFmt = options.numFmt;
  if (options.zebra) {
    cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
  }
}

/**
 * A cell that carries a verdict: bold ink on its own soft ground.
 *
 * The ground REPLACES the zebra rather than sitting over it — a tint under a tint would make the
 * odd rows a different green from the even ones, which reads as two states where there is one.
 */
function signalCell(
  cell: ExcelJS.Cell,
  value: string | number | null,
  tone: HouseXlsxSignalTone,
  options: { center?: boolean; numFmt?: string } = {},
) {
  const signal = HOUSE_XLSX_SIGNAL[tone];
  cell.value = value === "" ? null : value;
  cell.font = { bold: true, color: { argb: signal.ink }, name: HOUSE_XLSX_FONT, size: 9.5 };
  cell.alignment = {
    horizontal: options.center ? "center" : "left",
    indent: options.center ? 0 : 1,
    vertical: "middle",
  };
  cell.border = CELL_BORDER;
  cell.fill = { fgColor: { argb: signal.tint }, pattern: "solid", type: "pattern" };
  if (options.numFmt) cell.numFmt = options.numFmt;
}

/** Green at nothing outstanding, red once anything is, so a count reads without being read. */
function countTone(count: number): HouseXlsxSignalTone {
  return count === 0 ? "good" : "bad";
}

function completionTone(percent: number): HouseXlsxSignalTone {
  if (percent >= 100) return "good";
  return percent >= 50 ? "warn" : "bad";
}

function sheetTitle(sheet: ExcelJS.Worksheet, row: number, columns: number, title: string): number {
  sheet.mergeCells(row, 1, row, Math.max(1, columns));
  const cell = sheet.getCell(row, 1);
  cell.value = title;
  cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 11 };
  cell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  cell.border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" } };
  sheet.getRow(row).height = 22;
  return row + 1;
}

/** The legend, written under the cover's provenance block so the colours are never a guess. */
function writeLegend(sheet: ExcelJS.Worksheet, startRow: number) {
  let row = startRow;
  const heading = sheet.getCell(row, 2);
  heading.value = "What the colours mean";
  heading.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 11 };
  heading.border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "thin" } };
  sheet.getCell(row, 3).border = { bottom: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "thin" } };
  row += 1;

  const entries: Array<[HiringDocumentSignal, string]> = [
    ["complete", "Submitted, with at least one scan or upload filed against it. Nothing to chase."],
    [
      "unevidenced",
      "Submitted, but nothing is scanned into the file yet. The paper has arrived, so it is green — "
      + "the missing scan is counted in the \"No file\" column instead of being chased as a missing document.",
    ],
    ["pending", "Nobody has said anything about it yet."],
    ["missing", "Marked missing by HR. The deadline has not passed, or none was set."],
    ["overdue", "Not submitted, and the deadline was today or earlier."],
  ];

  for (const [signal, description] of entries) {
    signalCell(sheet.getCell(row, 2), HIRING_DOCUMENT_SIGNAL_LABEL[signal], SIGNAL_TONE[signal]);
    bodyCell(sheet.getCell(row, 3), description);
    sheet.getRow(row).height = 18;
    row += 1;
  }
  return row;
}

function buildCover(workbook: ExcelJS.Workbook, input: HiringDocumentsWorkbookInput, stats: MatrixStats) {
  // ARRIVED, not evidenced: the cover's headline has to be the same question the matrix colours, or
  // a reader comparing the two finds the cover quietly stricter than every green cell on the sheet.
  const arrived = stats.complete + stats.unevidenced;
  const percent = stats.slots === 0 ? 0 : Math.round((arrived / stats.slots) * 100);
  const sheet = buildHouseCoverSheet(workbook, {
    confidentialNote:
      "CONFIDENTIAL — personnel records. Names, hire dates and document readiness for identified employees. "
      + "Do not forward outside People Operations.",
    rows: [
      houseGeneratedRow(input.generatedAtIso),
      ["Exported by", input.exportedByHrId ? `${input.exportedByName} (${input.exportedByHrId})` : input.exportedByName],
      ["Role", input.role],
      ["Applied filters", describeHiringDocumentFilters(input.filters)],
      ["Employees in this file", String(input.employees.length)],
      ["Checklist documents", String(input.documents.length)],
      ["Document slots", String(stats.slots)],
      ["Submitted", `${arrived} (${percent}%)`],
      ["Needs attention", String(stats.needsAttention)],
      ["Overdue", String(stats.overdue)],
      ["Submitted with no file scanned", `${stats.unevidenced} of ${arrived}`],
      ["Employees with nothing outstanding", `${stats.completeEmployees} of ${input.employees.length}`],
    ],
    subtitle: "Onboarding document readiness by employee — what is filed, what is outstanding, what is late.",
    title: "Hiring Documents",
  });

  // The cover's own rows are written by the shared builder, so the legend is placed after whatever
  // it produced rather than at an arithmetic guess that would silently overwrite a row the day
  // somebody adds one there.
  writeLegend(sheet, sheet.rowCount + 2);
  return sheet;
}

type MatrixStats = {
  complete: number;
  completeEmployees: number;
  missing: number;
  needsAttention: number;
  overdue: number;
  pending: number;
  slots: number;
  unevidenced: number;
};

function countSignals(input: HiringDocumentsWorkbookInput, today: Date): MatrixStats {
  const stats: MatrixStats = {
    complete: 0,
    completeEmployees: 0,
    missing: 0,
    needsAttention: 0,
    overdue: 0,
    pending: 0,
    slots: 0,
    unevidenced: 0,
  };

  for (const employee of input.employees) {
    let outstanding = 0;
    for (const document of input.documents) {
      const signal = hiringDocumentSignal(entryOf(employee, document.id), today);
      stats.slots += 1;
      if (signal === "complete") stats.complete += 1;
      if (signal === "unevidenced") stats.unevidenced += 1;
      if (signal === "pending") stats.pending += 1;
      if (signal === "missing") stats.missing += 1;
      if (signal === "overdue") stats.overdue += 1;
      if (hiringDocumentSignalNeedsAttention(signal)) {
        stats.needsAttention += 1;
        outstanding += 1;
      }
    }
    if (outstanding === 0 && input.documents.length > 0) stats.completeEmployees += 1;
  }

  return stats;
}

const FIXED_MATRIX_COLUMNS = [
  { label: "HR ID", width: 10 },
  { label: "Employee", width: 30 },
  { label: "Job title", width: 24 },
  { label: "Line", width: 16 },
  { label: "Manager", width: 24 },
  { label: "Hire date", width: 13 },
  { label: "Employment status", width: 18 },
  { label: "Complete %", width: 12 },
  { label: "Needs attention", width: 14 },
  { label: "Overdue", width: 10 },
  { label: "No file", width: 9 },
] as const;

function buildMatrixSheet(workbook: ExcelJS.Workbook, input: HiringDocumentsWorkbookInput, today: Date) {
  const sheet = workbook.addWorksheet("Readiness Matrix", { properties: { defaultRowHeight: 17 } });
  sheet.views = [{ showGridLines: false }];

  const columnCount = FIXED_MATRIX_COLUMNS.length + input.documents.length;
  let row = writeHouseMasthead(workbook, sheet, {
    columns: columnCount,
    provenance: [`${input.employees.length} employees`, `${input.documents.length} documents`],
    subtitle: "One row per employee, one column per checklist document. Colour is the state of that document.",
    title: "Hiring Documents — Readiness",
  });

  row = sheetTitle(sheet, row, columnCount, "Readiness by employee");

  const headerRowNumber = row;
  const headerRow = sheet.getRow(headerRowNumber);
  FIXED_MATRIX_COLUMNS.forEach((column, index) => {
    headerCell(headerRow.getCell(index + 1), column.label, { center: index >= 7 });
    sheet.getColumn(index + 1).width = column.width;
  });
  input.documents.forEach((document, index) => {
    const columnIndex = FIXED_MATRIX_COLUMNS.length + index + 1;
    headerCell(headerRow.getCell(columnIndex), document.name, { center: true });
    sheet.getColumn(columnIndex).width = 18;
  });
  headerRow.height = 34;
  row += 1;

  const firstDataRow = row;
  input.employees.forEach((employee, employeeIndex) => {
    const excelRow = sheet.getRow(row);
    const zebra = employeeIndex % 2 === 1;
    const completion = hiringDocumentCompletionPercent(employee, input.documents);

    const signals = input.documents.map((document) => hiringDocumentSignal(entryOf(employee, document.id), today));
    const outstanding = signals.filter(hiringDocumentSignalNeedsAttention).length;
    const overdue = signals.filter((signal) => signal === "overdue").length;
    const unevidenced = signals.filter((signal) => signal === "unevidenced").length;

    bodyCell(excelRow.getCell(1), employee.hrId, { zebra });
    bodyCell(excelRow.getCell(2), employee.fullName, { bold: true, zebra });
    bodyCell(excelRow.getCell(3), employee.jobTitle ?? "", { zebra });
    bodyCell(excelRow.getCell(4), employee.lineName ?? "", { zebra });
    bodyCell(excelRow.getCell(5), employee.managerName ?? "", { zebra });
    bodyCell(excelRow.getCell(6), formatDate(employee.hireDate), { center: true, zebra });
    bodyCell(excelRow.getCell(7), employmentStatusLabel(String(employee.employmentStatus ?? "active").toLowerCase()) || "Unknown", { zebra });
    // Stored as a fraction with a percent format, so Excel's own sort and filter treat it as a
    // number: "100%" as text sorts before "9%".
    signalCell(excelRow.getCell(8), completion / 100, completionTone(completion), { center: true, numFmt: "0%" });
    signalCell(excelRow.getCell(9), outstanding, countTone(outstanding), { center: true });
    signalCell(excelRow.getCell(10), overdue, countTone(overdue), { center: true });
    // The evidence gap: arrived, ticked, but nothing scanned into the file. Amber rather than red —
    // it is a housekeeping job, not a document nobody has handed in.
    signalCell(excelRow.getCell(11), unevidenced, unevidenced === 0 ? "good" : "warn", { center: true });

    input.documents.forEach((document, index) => {
      const cell = excelRow.getCell(FIXED_MATRIX_COLUMNS.length + index + 1);
      const signal = signals[index];
      const entry = entryOf(employee, document.id);
      signalCell(cell, HIRING_DOCUMENT_SIGNAL_LABEL[signal], SIGNAL_TONE[signal], { center: true });
      const days = hiringDocumentDaysOverdue(entry, today);
      const note = [
        entry.dueDate ? `Deadline ${formatDate(entry.dueDate)}` : null,
        days ? `${days} day${days === 1 ? "" : "s"} past the deadline` : null,
        entry.fileCount > 0 ? `${entry.fileCount} file${entry.fileCount === 1 ? "" : "s"} on record` : "No file on record",
        entry.notes ? `Note: ${entry.notes}` : null,
        entry.updatedAt ? `Last update ${houseCairoDateTime(entry.updatedAt)}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      // The detail rides as a cell comment rather than as five more columns per document: the
      // matrix is already as wide as the checklist, and a reader who wants the deadline wants it
      // for one cell, not for all of them.
      if (note) cell.note = note;
    });

    row += 1;
  });

  const lastDataRow = row - 1;
  if (input.employees.length > 0) {
    sheet.autoFilter = {
      from: { column: 1, row: headerRowNumber },
      to: { column: columnCount, row: lastDataRow },
    };
  }
  // The name column and the header stay put while a fifty-column checklist scrolls under them.
  sheet.views = [
    {
      showGridLines: false,
      state: "frozen",
      xSplit: 2,
      ySplit: headerRowNumber,
    },
  ];
  sheet.getColumn(2).alignment = { vertical: "middle" };
  return { firstDataRow, lastDataRow, sheet };
}

type ActionRow = {
  document: string;
  employee: HiringDocumentEmployeeRow;
  entry: HiringDocumentEntry;
  signal: HiringDocumentSignal;
};

function buildActionSheet(workbook: ExcelJS.Workbook, input: HiringDocumentsWorkbookInput, today: Date) {
  const rows: ActionRow[] = [];
  for (const employee of input.employees) {
    for (const document of input.documents) {
      const entry = entryOf(employee, document.id);
      const signal = hiringDocumentSignal(entry, today);
      if (!hiringDocumentSignalNeedsAttention(signal)) continue;
      rows.push({ document: document.name, employee, entry, signal });
    }
  }

  // Most urgent first: overdue, then missing, then a tick with nothing behind it, then untouched.
  // Within a rank, the oldest deadline leads, and then the employee, so two runs of the same data
  // produce the same file.
  rows.sort((left, right) => {
    const rank = HIRING_DOCUMENT_SIGNAL_RANK[left.signal] - HIRING_DOCUMENT_SIGNAL_RANK[right.signal];
    if (rank !== 0) return rank;
    const leftDue = left.entry.dueDate ?? "9999-12-31";
    const rightDue = right.entry.dueDate ?? "9999-12-31";
    if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
    const name = left.employee.fullName.localeCompare(right.employee.fullName);
    return name !== 0 ? name : left.document.localeCompare(right.document);
  });

  const columns = [
    { label: "Status", width: 16 },
    { label: "Employee", width: 30 },
    { label: "HR ID", width: 10 },
    { label: "Document", width: 30 },
    { label: "Deadline", width: 13 },
    { label: "Days late", width: 10 },
    { label: "Files on record", width: 13 },
    { label: "Line", width: 16 },
    { label: "Manager", width: 24 },
    { label: "Job title", width: 24 },
    { label: "Hire date", width: 13 },
    { label: "Note", width: 40 },
    { label: "Last update", width: 22 },
  ];

  const sheet = workbook.addWorksheet("Needs Attention", { properties: { defaultRowHeight: 17 } });
  sheet.views = [{ showGridLines: false }];

  let row = writeHouseMasthead(workbook, sheet, {
    columns: columns.length,
    provenance: [`${rows.length} outstanding documents`],
    subtitle: "Every outstanding document, most urgent first. Work it top to bottom.",
    title: "Hiring Documents — Needs Attention",
  });
  row = sheetTitle(sheet, row, columns.length, "Outstanding documents");

  const headerRowNumber = row;
  const headerRow = sheet.getRow(headerRowNumber);
  columns.forEach((column, index) => {
    headerCell(headerRow.getCell(index + 1), column.label, { center: index === 5 || index === 6 });
    sheet.getColumn(index + 1).width = column.width;
  });
  headerRow.height = 24;
  row += 1;

  if (rows.length === 0) {
    // A sheet with a header and nothing under it reads as a failed export. Say the good news.
    sheet.mergeCells(row, 1, row, columns.length);
    signalCell(sheet.getCell(row, 1), "Nothing outstanding — every document in this view has arrived.", "good");
    sheet.getRow(row).height = 22;
    return sheet;
  }

  rows.forEach((action, index) => {
    const excelRow = sheet.getRow(row);
    const zebra = index % 2 === 1;
    const days = hiringDocumentDaysOverdue(action.entry, today);
    signalCell(excelRow.getCell(1), HIRING_DOCUMENT_SIGNAL_LABEL[action.signal], SIGNAL_TONE[action.signal]);
    bodyCell(excelRow.getCell(2), action.employee.fullName, { bold: true, zebra });
    bodyCell(excelRow.getCell(3), action.employee.hrId, { zebra });
    bodyCell(excelRow.getCell(4), action.document, { zebra });
    bodyCell(excelRow.getCell(5), formatDate(action.entry.dueDate), { center: true, zebra });
    if (days) {
      signalCell(excelRow.getCell(6), days, "bad", { center: true });
    } else {
      bodyCell(excelRow.getCell(6), null, { center: true, zebra });
    }
    // Plain, deliberately: every row on this sheet is a document that has NOT arrived, so a zero
    // here is the expected reading and colouring it would put amber down the whole column.
    bodyCell(excelRow.getCell(7), action.entry.fileCount, { center: true, zebra });
    bodyCell(excelRow.getCell(8), action.employee.lineName ?? "", { zebra });
    bodyCell(excelRow.getCell(9), action.employee.managerName ?? "", { zebra });
    bodyCell(excelRow.getCell(10), action.employee.jobTitle ?? "", { zebra });
    bodyCell(excelRow.getCell(11), formatDate(action.employee.hireDate), { center: true, zebra });
    bodyCell(excelRow.getCell(12), action.entry.notes ?? "", { zebra });
    bodyCell(excelRow.getCell(13), houseCairoDateTime(action.entry.updatedAt), { zebra });
    row += 1;
  });

  sheet.autoFilter = {
    from: { column: 1, row: headerRowNumber },
    to: { column: columns.length, row: row - 1 },
  };
  sheet.views = [{ showGridLines: false, state: "frozen", xSplit: 2, ySplit: headerRowNumber }];
  return sheet;
}

function buildDocumentSheet(workbook: ExcelJS.Workbook, input: HiringDocumentsWorkbookInput, today: Date) {
  const columns = [
    { label: "Document", width: 34 },
    { label: "Submitted", width: 11 },
    { label: "No file", width: 10 },
    { label: "Pending", width: 11 },
    { label: "Missing", width: 11 },
    { label: "Overdue", width: 11 },
    { label: "Submitted %", width: 12 },
  ];

  const sheet = workbook.addWorksheet("By Document", { properties: { defaultRowHeight: 17 } });
  sheet.views = [{ showGridLines: false }];

  let row = writeHouseMasthead(workbook, sheet, {
    columns: columns.length,
    provenance: [`${input.documents.length} documents`, `${input.employees.length} employees`],
    subtitle: "Which paper is the bottleneck, across the employees in this view.",
    title: "Hiring Documents — By Document",
  });
  row = sheetTitle(sheet, row, columns.length, "Readiness per checklist document");

  const headerRowNumber = row;
  const headerRow = sheet.getRow(headerRowNumber);
  columns.forEach((column, index) => {
    headerCell(headerRow.getCell(index + 1), column.label, { center: index > 0 });
    sheet.getColumn(index + 1).width = column.width;
  });
  headerRow.height = 24;
  row += 1;

  const totals = { complete: 0, missing: 0, overdue: 0, pending: 0, unevidenced: 0 };

  input.documents.forEach((document, index) => {
    const counts = { complete: 0, missing: 0, overdue: 0, pending: 0, unevidenced: 0 };
    for (const employee of input.employees) {
      counts[hiringDocumentSignal(entryOf(employee, document.id), today)] += 1;
    }
    totals.complete += counts.complete;
    totals.unevidenced += counts.unevidenced;
    totals.pending += counts.pending;
    totals.missing += counts.missing;
    totals.overdue += counts.overdue;

    const arrived = counts.complete + counts.unevidenced;
    const percent = input.employees.length === 0 ? 0 : Math.round((arrived / input.employees.length) * 100);
    const excelRow = sheet.getRow(row);
    const zebra = index % 2 === 1;
    bodyCell(excelRow.getCell(1), document.name, { bold: true, zebra });
    signalCell(excelRow.getCell(2), arrived, arrived > 0 ? "good" : "warn", { center: true });
    signalCell(excelRow.getCell(3), counts.unevidenced, counts.unevidenced === 0 ? "good" : "warn", { center: true });
    signalCell(excelRow.getCell(4), counts.pending, counts.pending === 0 ? "good" : "warn", { center: true });
    signalCell(excelRow.getCell(5), counts.missing, countTone(counts.missing), { center: true });
    signalCell(excelRow.getCell(6), counts.overdue, countTone(counts.overdue), { center: true });
    signalCell(excelRow.getCell(7), percent / 100, completionTone(percent), { center: true, numFmt: "0%" });
    row += 1;
  });

  if (input.documents.length > 0) {
    const slots = input.documents.length * input.employees.length;
    const arrived = totals.complete + totals.unevidenced;
    const percent = slots === 0 ? 0 : Math.round((arrived / slots) * 100);
    const totalRow = sheet.getRow(row);
    const values: Array<[number, number, HouseXlsxSignalTone]> = [
      [2, arrived, arrived > 0 ? "good" : "warn"],
      [3, totals.unevidenced, totals.unevidenced === 0 ? "good" : "warn"],
      [4, totals.pending, totals.pending === 0 ? "good" : "warn"],
      [5, totals.missing, countTone(totals.missing)],
      [6, totals.overdue, countTone(totals.overdue)],
    ];
    bodyCell(totalRow.getCell(1), "All documents", { bold: true });
    for (const [column, value, tone] of values) signalCell(totalRow.getCell(column), value, tone, { center: true });
    signalCell(totalRow.getCell(7), percent / 100, completionTone(percent), { center: true, numFmt: "0%" });
    for (let column = 1; column <= columns.length; column += 1) {
      totalRow.getCell(column).border = {
        ...CELL_BORDER,
        bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "double" },
        top: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "thin" },
      };
    }
  }

  sheet.views = [{ showGridLines: false, state: "frozen", xSplit: 1, ySplit: headerRowNumber }];
  return sheet;
}

/** The whole workbook, ready to stream. */
export async function buildHiringDocumentsWorkbook(
  input: HiringDocumentsWorkbookInput,
): Promise<ArrayBuffer> {
  const today = startOfToday(input.today ?? new Date());
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(input.generatedAtIso);
  workbook.creator = "Phoenix Workforce";

  buildCover(workbook, input, countSignals(input, today));
  buildMatrixSheet(workbook, input, today);
  buildActionSheet(workbook, input, today);
  buildDocumentSheet(workbook, input, today);

  return workbook.xlsx.writeBuffer() as unknown as Promise<ArrayBuffer>;
}

/** `hiring-documents-2026-09-29.xlsx`, in Cairo — the day the reader took it. */
export function hiringDocumentsExportFilename(generatedAtIso: string): string {
  const at = new Date(generatedAtIso);
  const day = Number.isNaN(at.getTime())
    ? "export"
    : new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(at);
  return `hiring-documents-${day}.xlsx`;
}
