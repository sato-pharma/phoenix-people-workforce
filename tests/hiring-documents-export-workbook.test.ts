import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";
import { HOUSE_XLSX_SIGNAL } from "../src/lib/export/house-xlsx-palette.ts";
import {
  buildHiringDocumentsWorkbook,
  hiringDocumentsExportFilename,
} from "../src/lib/hiring-documents/export-workbook.ts";
import {
  EMPTY_HIRING_DOCUMENT_FILTERS,
  HIRING_DOCUMENT_SCANNING_UNSCANNED,
  filterHiringDocumentEmployees,
  hiringDocumentCompletionPercent,
  hiringDocumentFilterSearchParams,
  readHiringDocumentFilters,
  type HiringDocumentFilterState,
} from "../src/lib/hiring-documents/filters.ts";
import { hiringDocumentApplies, hiringDocumentSignal } from "../src/lib/hiring-documents/readiness-signal.ts";
import type {
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringDocumentEntry,
} from "../src/lib/hiring-documents/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Hiring Documents — the XLSX export.
//
// Three things are pinned here, and each of them has already been got wrong somewhere in this repo.
//
// 1. THE COLOUR IS THE POINT, and it is a property of the EMITTED FILE, not of the source. The owner
//    asked for green and red so that what needs identifying can be identified (2026-09-29), so the
//    test reads the workbook back through ExcelJS and asserts the actual fill argb on actual cells.
//    Reading the builder's source would prove only that somebody typed a colour.
//
// 2. A TICK WITH NO FILE IS GREEN, AND COUNTED SEPARATELY. Measured on production 2026-09-29: the
//    whole database holds 3 files against 380 submitted ticks, because scanning is newer than the
//    checklist. Treating the missing scan as outstanding put 378 amber cells on the CNS sheet and
//    479 rows on a chase list whose real content was 101 — which identifies nothing. So the matrix
//    colours the question HR manages (has the paper arrived) and the evidence gap rides in its own
//    "No file" column, per employee and per document. It is pinned in BOTH directions here: green
//    in the cell, never on the chase list, and never zero in the column.
//
// 3. THE EXPORT MUST MATCH THE SCREEN. Screen and server both filter through
//    `filterHiringDocumentEmployees`, and the state makes the trip as query parameters, so the
//    round trip is pinned too: a parameter renamed on one side and not the other would silently
//    widen the file to the whole company.
// ─────────────────────────────────────────────────────────────────────────────

const TODAY = new Date("2026-09-29T00:00:00");

const DOCUMENTS: HiringDocumentDefinition[] = [
  { createdAt: "2026-01-01T00:00:00Z", description: null, displayOrder: 1, id: "doc-id", isExitDocument: false, name: "National ID" },
  { createdAt: "2026-01-01T00:00:00Z", description: null, displayOrder: 2, id: "doc-contract", isExitDocument: false, name: "Signed contract" },
  { createdAt: "2026-01-01T00:00:00Z", description: null, displayOrder: 3, id: "doc-degree", isExitDocument: false, name: "Degree certificate" },
  { createdAt: "2026-01-01T00:00:00Z", description: null, displayOrder: 4, id: "doc-insurance", isExitDocument: false, name: "Insurance form 1" },
  // Owner ruling, 2026-09-29: an exit paper only counts for somebody who has actually left.
  { createdAt: "2026-01-01T00:00:00Z", description: null, displayOrder: 5, id: "doc-clearance", isExitDocument: true, name: "Signed company clearance" },
];

function entry(overrides: Partial<HiringDocumentEntry> & { documentId: string }): HiringDocumentEntry {
  return {
    dueDate: null,
    fileCount: 0,
    notes: null,
    status: "pending",
    updatedAt: null,
    ...overrides,
  };
}

function employee(
  overrides: Partial<HiringDocumentEmployeeRow> & { fullName: string; hrId: string },
  entries: HiringDocumentEntry[],
): HiringDocumentEmployeeRow {
  return {
    documents: Object.fromEntries(entries.map((item) => [item.documentId, item])),
    employmentStatus: "active",
    hireDate: "2026-06-01",
    jobTitle: "Medical Rep",
    lineName: "CNS",
    managerHrId: "B-20",
    managerName: "Mona Fathy",
    notes: null,
    ...overrides,
  };
}

const EVIDENCED = employee({ fullName: "Ahmed Samir", hrId: "A-11" }, [
  entry({ documentId: "doc-id", fileCount: 2, status: "submitted", updatedAt: "2026-09-01T09:00:00Z" }),
  entry({ documentId: "doc-contract", fileCount: 1, status: "submitted" }),
  entry({ documentId: "doc-degree", fileCount: 1, status: "submitted" }),
  entry({ documentId: "doc-insurance", fileCount: 3, status: "submitted" }),
]);

const TICKED_NO_FILE = employee({ fullName: "Basma Nabil", hrId: "A-12", lineName: "Pedia" }, [
  // Ticked submitted with nothing filed — the case the whole "Ticked · no file" signal exists for.
  entry({ documentId: "doc-id", fileCount: 0, status: "submitted" }),
  entry({ documentId: "doc-contract", fileCount: 1, status: "submitted" }),
  entry({ documentId: "doc-degree", status: "pending" }),
  entry({ documentId: "doc-insurance", dueDate: "2026-10-15", status: "missing" }),
]);

const OVERDUE = employee({ fullName: "Karim Adel", hrId: "A-13", lineName: "CNS", managerName: "Hany Saad" }, [
  entry({ documentId: "doc-id", dueDate: "2026-09-01", status: "missing" }),
  entry({ documentId: "doc-contract", dueDate: "2026-09-20", status: "pending" }),
  entry({ documentId: "doc-degree", status: "missing" }),
  // Submitted AFTER its deadline: finished, not late. It must not be chased.
  entry({ documentId: "doc-insurance", dueDate: "2026-08-01", fileCount: 1, status: "submitted" }),
]);

// Resigned, so the clearance DOES apply to her — and it is the only person in the fixture it
// applies to. Everything else about her is complete, so if the clearance ever stopped counting for
// a leaver she would silently read 100% with an unsigned clearance.
const LEAVER = employee(
  { employmentStatus: "resigned", fullName: "Rania Fouad", hrId: "A-14", lineName: "Pedia" },
  [
    entry({ documentId: "doc-id", fileCount: 1, status: "submitted" }),
    entry({ documentId: "doc-contract", fileCount: 1, status: "submitted" }),
    entry({ documentId: "doc-degree", fileCount: 1, status: "submitted" }),
    entry({ documentId: "doc-insurance", fileCount: 1, status: "submitted" }),
    entry({ documentId: "doc-clearance", status: "pending" }),
  ],
);

const EMPLOYEES = [EVIDENCED, TICKED_NO_FILE, OVERDUE, LEAVER];

async function readBack(buffer: ArrayBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  return workbook;
}

function fillOf(cell: ExcelJS.Cell): string | null {
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  const argb = fill?.fgColor?.argb;
  return typeof argb === "string" ? argb.toUpperCase() : null;
}

function rowValues(sheet: ExcelJS.Worksheet, row: number): string[] {
  const values: string[] = [];
  sheet.getRow(row).eachCell({ includeEmpty: true }, (cell) => {
    values.push(String(cell.value ?? ""));
  });
  return values;
}

/** The header row of a sheet, found by a label rather than by a hard-coded row number. */
function headerRowOf(sheet: ExcelJS.Worksheet, label: string): number {
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    if (rowValues(sheet, row).includes(label)) return row;
  }
  throw new Error(`no header row holding "${label}" in ${sheet.name}`);
}

function columnOf(sheet: ExcelJS.Worksheet, headerRow: number, label: string): number {
  const values = rowValues(sheet, headerRow);
  const index = values.indexOf(label);
  assert.ok(index >= 0, `${sheet.name} must have a "${label}" column`);
  return index + 1;
}

function findRow(sheet: ExcelJS.Worksheet, headerRow: number, column: number, value: string): number {
  for (let row = headerRow + 1; row <= sheet.rowCount; row += 1) {
    if (String(sheet.getCell(row, column).value ?? "") === value) return row;
  }
  throw new Error(`no row in ${sheet.name} whose column ${column} is "${value}"`);
}

export async function runHiringDocumentsExportWorkbookTests() {
  // ── 1. the five signals, including the two that are not in the stored status at all
  assert.equal(hiringDocumentSignal({ dueDate: null, fileCount: 1, status: "submitted" }, TODAY), "complete");
  assert.equal(hiringDocumentSignal({ dueDate: null, fileCount: 0, status: "submitted" }, TODAY), "unevidenced");
  assert.equal(hiringDocumentSignal({ dueDate: null, fileCount: 0, status: "pending" }, TODAY), "pending");
  assert.equal(hiringDocumentSignal({ dueDate: "2026-10-30", fileCount: 0, status: "missing" }, TODAY), "missing");
  assert.equal(hiringDocumentSignal({ dueDate: "2026-09-29", fileCount: 0, status: "missing" }, TODAY), "overdue");
  assert.equal(
    hiringDocumentSignal({ dueDate: "2026-09-01", fileCount: 0, status: "pending" }, TODAY),
    "overdue",
    "a pending document past its deadline is late, whatever word the status holds",
  );
  assert.equal(
    hiringDocumentSignal({ dueDate: "2026-01-01", fileCount: 2, status: "submitted" }, TODAY),
    "complete",
    "a document that arrived after its deadline is finished, not late — chasing it wastes HR's morning",
  );

  // ── 1b. an exit document only counts for somebody who has actually left (owner, 2026-09-29)
  const clearance = { isExitDocument: true };
  const onboarding = { isExitDocument: false };
  assert.equal(hiringDocumentApplies(clearance, { employmentStatus: "active" }), false);
  assert.equal(hiringDocumentApplies(clearance, { employmentStatus: "on_leave" }), false);
  assert.equal(hiringDocumentApplies(clearance, { employmentStatus: "resigned" }), true);
  assert.equal(hiringDocumentApplies(clearance, { employmentStatus: "terminated" }), true);
  assert.equal(hiringDocumentApplies(clearance, { employmentStatus: "not_renewed" }), true);
  assert.equal(
    hiringDocumentApplies(clearance, { employmentStatus: "system_placeholder" }),
    false,
    "a payroll placeholder is not a person who left — session-lifecycle.ts keeps the departed set "
    + "separate precisely because a Form 6 filed for one is a form the insurance office rejects",
  );
  assert.equal(hiringDocumentApplies(onboarding, { employmentStatus: "active" }), true);
  assert.equal(
    hiringDocumentCompletionPercent(EVIDENCED, DOCUMENTS),
    100,
    "an active employee who has handed in everything asked of them reads 100% — the clearance "
    + "leaves the DENOMINATOR, not just the numerator, or nobody who has not resigned can ever get there",
  );

  // ── 2. the filter state survives the trip to the server, and the predicate is the screen's
  const filters: HiringDocumentFilterState = {
    ...EMPTY_HIRING_DOCUMENT_FILTERS,
    completionMin: "50",
    hireDateFrom: "2026-01-01",
    line: "CNS",
    query: "karim",
  };
  const roundTripped = readHiringDocumentFilters(hiringDocumentFilterSearchParams(filters));
  assert.deepEqual(roundTripped, filters, "every filter must survive the URL, or the export widens silently");
  assert.deepEqual(
    readHiringDocumentFilters(new URLSearchParams()),
    EMPTY_HIRING_DOCUMENT_FILTERS,
    "an absent parameter is the default, never an empty string that matches nobody",
  );
  assert.deepEqual(
    filterHiringDocumentEmployees(EMPLOYEES, DOCUMENTS, { ...EMPTY_HIRING_DOCUMENT_FILTERS, line: "CNS" }).map(
      (row) => row.hrId,
    ),
    ["A-11", "A-13"],
    "the line filter must narrow the export exactly as it narrows the screen",
  );

  // ── 2b. the scan-only filter (owner, 2026-09-29)
  const scanOnly = filterHiringDocumentEmployees(EMPLOYEES, DOCUMENTS, {
    ...EMPTY_HIRING_DOCUMENT_FILTERS,
    scanning: HIRING_DOCUMENT_SCANNING_UNSCANNED,
  });
  assert.deepEqual(
    scanOnly.map((row) => row.hrId),
    ["A-12"],
    "only Basma has a document ticked with no file behind it",
  );
  assert.ok(
    !scanOnly.some((row) => row.hrId === "A-13"),
    "Karim has three documents outstanding and nothing unscanned — chasing work is not scanning work",
  );
  // 🔴 THE CASE THAT PROVES IT IS NOT A COMPLETION FILTER IN DISGUISE. An employee can read 100%
  // complete with every one of those documents unscanned — which is exactly where production is,
  // 3 files behind 380 ticks — so no completion range can ever find this work.
  const allTickedNoneScanned = employee({ fullName: "Sara Adel", hrId: "A-15" }, [
    entry({ documentId: "doc-id", fileCount: 0, status: "submitted" }),
    entry({ documentId: "doc-contract", fileCount: 0, status: "submitted" }),
    entry({ documentId: "doc-degree", fileCount: 0, status: "submitted" }),
    entry({ documentId: "doc-insurance", fileCount: 0, status: "submitted" }),
  ]);
  assert.equal(hiringDocumentCompletionPercent(allTickedNoneScanned, DOCUMENTS), 100);
  assert.deepEqual(
    filterHiringDocumentEmployees([allTickedNoneScanned], DOCUMENTS, {
      ...EMPTY_HIRING_DOCUMENT_FILTERS,
      scanning: HIRING_DOCUMENT_SCANNING_UNSCANNED,
    }).map((row) => row.hrId),
    ["A-15"],
    "100% complete and four documents to scan — the filter finds her, a completion range never could",
  );

  // ── 3. the workbook itself
  const buffer = await buildHiringDocumentsWorkbook({
    documents: DOCUMENTS,
    employees: EMPLOYEES,
    exportedByHrId: "B-10",
    exportedByName: "Omar Gawish",
    filters: { ...EMPTY_HIRING_DOCUMENT_FILTERS, line: "CNS" },
    generatedAtIso: "2026-09-29T09:00:00.000Z",
    role: "Super Admin",
    today: TODAY,
  });

  const problems = await checkWorkbook(Buffer.from(buffer), { quiet: true });
  assert.deepEqual(problems, [], `the workbook must open clean: ${problems.join("; ")}`);

  const workbook = await readBack(buffer);
  for (const name of ["Cover", "Readiness Matrix", "Needs Attention", "By Document"]) {
    assert.ok(workbook.getWorksheet(name), `the pack must carry a "${name}" sheet`);
  }

  // ── 4. the matrix, cell by cell — the colours the owner asked for, read off the emitted file
  const matrix = workbook.getWorksheet("Readiness Matrix")!;
  const matrixHeader = headerRowOf(matrix, "Employee");
  const employeeColumn = columnOf(matrix, matrixHeader, "Employee");
  const idColumn = columnOf(matrix, matrixHeader, "National ID");
  const insuranceColumn = columnOf(matrix, matrixHeader, "Insurance form 1");
  const attentionColumn = columnOf(matrix, matrixHeader, "Needs attention");
  const overdueColumn = columnOf(matrix, matrixHeader, "Overdue");

  const evidencedRow = findRow(matrix, matrixHeader, employeeColumn, "Ahmed Samir");
  const tickedRow = findRow(matrix, matrixHeader, employeeColumn, "Basma Nabil");
  const overdueRow = findRow(matrix, matrixHeader, employeeColumn, "Karim Adel");

  assert.equal(matrix.getCell(evidencedRow, idColumn).value, "Complete");
  assert.equal(fillOf(matrix.getCell(evidencedRow, idColumn)), HOUSE_XLSX_SIGNAL.good.tint, "a filed document is green");
  assert.equal(
    matrix.getCell(tickedRow, idColumn).value,
    "Submitted · no file",
    "a tick with no scan behind it must say so in words, whatever colour the cell wears",
  );
  assert.equal(
    fillOf(matrix.getCell(tickedRow, idColumn)),
    HOUSE_XLSX_SIGNAL.good.tint,
    "the paper HAS arrived, so it is green — colouring the missing scan buried the real work under "
    + "378 amber cells on production",
  );
  const noFileColumn = columnOf(matrix, matrixHeader, "No file");
  assert.equal(matrix.getCell(tickedRow, noFileColumn).value, 1, "the evidence gap is counted, never lost");
  assert.equal(fillOf(matrix.getCell(tickedRow, noFileColumn)), HOUSE_XLSX_SIGNAL.warn.tint);
  assert.equal(matrix.getCell(evidencedRow, noFileColumn).value, 0);
  assert.equal(fillOf(matrix.getCell(evidencedRow, noFileColumn)), HOUSE_XLSX_SIGNAL.good.tint);
  assert.equal(matrix.getCell(overdueRow, idColumn).value, "Overdue");
  assert.equal(fillOf(matrix.getCell(overdueRow, idColumn)), HOUSE_XLSX_SIGNAL.bad.tint, "a late document is red");
  assert.equal(
    matrix.getCell(overdueRow, insuranceColumn).value,
    "Complete",
    "submitted after the deadline is still submitted",
  );

  assert.equal(matrix.getCell(evidencedRow, attentionColumn).value, 0);
  assert.equal(fillOf(matrix.getCell(evidencedRow, attentionColumn)), HOUSE_XLSX_SIGNAL.good.tint);
  assert.equal(matrix.getCell(overdueRow, attentionColumn).value, 3);
  assert.equal(fillOf(matrix.getCell(overdueRow, attentionColumn)), HOUSE_XLSX_SIGNAL.bad.tint);
  assert.equal(matrix.getCell(overdueRow, overdueColumn).value, 2, "two of Karim's three outstanding papers are late");
  assert.equal(
    matrix.getCell(evidencedRow, columnOf(matrix, matrixHeader, "Complete %")).value,
    1,
    "completion is stored as a number with a percent format, so Excel's own sort does not put 100% before 9%",
  );

  // The exit paper: a dash for the three who are still here, a real state for the one who left.
  const clearanceColumn = columnOf(matrix, matrixHeader, "Signed company clearance");
  const leaverRow = findRow(matrix, matrixHeader, employeeColumn, "Rania Fouad");
  assert.equal(
    matrix.getCell(evidencedRow, clearanceColumn).value,
    "—",
    "a clearance against somebody still working here is not pending and not complete — it is not a slot",
  );
  assert.equal(
    matrix.getCell(leaverRow, clearanceColumn).value,
    "Pending",
    "for the person who resigned it is real work, and it is the ONLY thing outstanding for her",
  );
  assert.equal(matrix.getCell(leaverRow, attentionColumn).value, 1);
  assert.equal(
    matrix.getCell(evidencedRow, columnOf(matrix, matrixHeader, "Complete %")).value,
    1,
    "and the man with every applicable document filed still reads 100% with the clearance in the checklist",
  );

  // The header and the name column stay put while a wide checklist scrolls under them.
  const view = matrix.views[0] as { state?: string; xSplit?: number; ySplit?: number };
  assert.equal(view.state, "frozen");
  assert.equal(view.ySplit, matrixHeader);
  assert.equal(view.xSplit, 2);

  // ── 5. the action list: outstanding only, most urgent first, and never a finished document
  const actions = workbook.getWorksheet("Needs Attention")!;
  const actionHeader = headerRowOf(actions, "Status");
  const statusColumn = columnOf(actions, actionHeader, "Status");
  const documentColumn = columnOf(actions, actionHeader, "Document");
  const daysColumn = columnOf(actions, actionHeader, "Days late");

  const listed: Array<[string, string, string]> = [];
  for (let row = actionHeader + 1; row <= actions.rowCount; row += 1) {
    const status = String(actions.getCell(row, statusColumn).value ?? "");
    if (!status) continue;
    listed.push([
      status,
      String(actions.getCell(row, columnOf(actions, actionHeader, "Employee")).value ?? ""),
      String(actions.getCell(row, documentColumn).value ?? ""),
    ]);
  }

  assert.equal(
    listed.length,
    7,
    "seven rows: six documents that have not arrived — five onboarding papers plus the leaver's "
    + "clearance — and Basma's ticked-but-unscanned National ID, which is scanning work rather than "
    + "chasing work. The three clearances belonging to people who have not left are still absent",
  );
  assert.equal(
    listed.at(-1)?.[0],
    "Submitted · no file",
    "the scanning work sits BELOW everything that has not arrived — it is on the sheet, never above "
    + "the paper nobody has handed in",
  );
  assert.deepEqual(
    listed.slice(0, 2).map(([status]) => status),
    ["Overdue", "Overdue"],
    "the late ones lead the list — it is worked top to bottom",
  );
  assert.deepEqual(
    listed[0],
    ["Overdue", "Karim Adel", "National ID"],
    "within a rank the oldest deadline leads",
  );
  assert.ok(
    !listed.some(([, name, document]) => name === "Karim Adel" && document === "Insurance form 1"),
    "a document submitted after its deadline is finished and must not be on anybody's chase list",
  );
  assert.ok(
    !listed.some(([, name]) => name === "Ahmed Samir"),
    "an employee with every document filed and evidenced must not appear at all",
  );
  // The Scanned column — the point of putting both kinds of work on one sheet.
  const scannedColumn = columnOf(actions, actionHeader, "Scanned");
  const filesColumn = columnOf(actions, actionHeader, "Files");
  const unscannedRow = findRow(actions, actionHeader, statusColumn, "Submitted · no file");
  assert.equal(actions.getCell(unscannedRow, scannedColumn).value, "No");
  assert.equal(
    fillOf(actions.getCell(unscannedRow, scannedColumn)),
    HOUSE_XLSX_SIGNAL.warn.tint,
    "No is amber, never red: on a row that has not arrived, no scan is the expected reading and "
    + "the Status cell beside it already carries the severity",
  );
  assert.equal(actions.getCell(unscannedRow, filesColumn).value, 0, "and the count sits beside the word");

  const firstActionRow = actionHeader + 1;
  assert.equal(
    fillOf(actions.getCell(firstActionRow, statusColumn)),
    HOUSE_XLSX_SIGNAL.bad.tint,
    "the status cell carries the signal on the action list too",
  );
  assert.equal(
    actions.getCell(firstActionRow, daysColumn).value,
    28,
    "01 Sep to 29 Sep is 28 days past the deadline",
  );

  // ── 6. by document: the per-document bottleneck, and its totals
  const byDocument = workbook.getWorksheet("By Document")!;
  const documentHeader = headerRowOf(byDocument, "Document");
  const nameColumn = columnOf(byDocument, documentHeader, "Document");
  const submittedColumn = columnOf(byDocument, documentHeader, "Submitted");
  const unevidencedColumn = columnOf(byDocument, documentHeader, "No file");
  const idDocumentRow = findRow(byDocument, documentHeader, nameColumn, "National ID");
  assert.equal(
    byDocument.getCell(idDocumentRow, submittedColumn).value,
    3,
    "Ahmed's, Basma's and the leaver's National IDs have all arrived — the scan is a separate question",
  );
  assert.equal(byDocument.getCell(idDocumentRow, unevidencedColumn).value, 1, "and one of the two has no scan");
  assert.equal(
    fillOf(byDocument.getCell(idDocumentRow, unevidencedColumn)),
    HOUSE_XLSX_SIGNAL.warn.tint,
    "an unscanned document is amber housekeeping, never the red of a document nobody has handed in",
  );
  const totalsRow = findRow(byDocument, documentHeader, nameColumn, "All documents");
  assert.equal(
    byDocument.getCell(totalsRow, submittedColumn).value,
    11,
    "eleven of the seventeen APPLICABLE slots have arrived — 16 onboarding plus the one clearance "
    + "that applies, never 4 employees x 5 documents",
  );

  // ── 7. the cover names who took it, when, in Cairo, and with which filters
  const coverText = (() => {
    const cover = workbook.getWorksheet("Cover")!;
    const lines: string[] = [];
    for (let row = 1; row <= cover.rowCount; row += 1) lines.push(rowValues(cover, row).join(" | "));
    return lines.join("\n");
  })();
  assert.ok(coverText.includes("Omar Gawish (B-10)"), "the cover names the exporter, never only an HR code");
  assert.ok(coverText.includes("Line: CNS"), "the cover says which filters produced these rows");
  assert.ok(
    coverText.includes("12:00 PM") && !coverText.includes("09:00:00.000Z"),
    "the generated stamp is Cairo local, never a raw UTC ISO string",
  );
  assert.ok(coverText.includes("Submitted · no file"), "the legend explains every state on the sheets");
  assert.ok(
    coverText.includes("Submitted with no file scanned | 1 of 11"),
    "the cover's headline counts what ARRIVED, and states the evidence gap beside it rather than "
    + "quietly holding a stricter number than every green cell on the matrix",
  );

  // ── 8. the filename is the Cairo day the reader took it, not the UTC one
  assert.equal(hiringDocumentsExportFilename("2026-09-29T09:00:00.000Z"), "hiring-documents-2026-09-29.xlsx");
  assert.equal(
    hiringDocumentsExportFilename("2026-09-29T21:30:00.000Z"),
    "hiring-documents-2026-09-30.xlsx",
    "half past midnight in Cairo is the next day's file — the owner reads every stamp in Cairo, never UTC",
  );
}
