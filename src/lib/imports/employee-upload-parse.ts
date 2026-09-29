/**
 * Reading an uploaded Employee Master file into rows.
 *
 * WHY THIS IS ITS OWN MODULE. The dry-run route and the confirm route each carried their own
 * byte-identical copy of this function. That is not merely duplication: the dry run is what the
 * person APPROVES and the confirm is what actually WRITES, so if the two copies ever drifted the
 * preview would describe one set of rows while a different set went into the database — and nothing
 * would report a problem, because each half would be internally consistent.
 *
 * THE HEADER TOKENS ARE THE CONTRACT WITH THE TEMPLATE. `employee-master-workbook.ts` builds the
 * file this parser reads, and the only thing connecting them is that the template's header row says
 * "Employee ID" and "Full Name" somewhere in the first ten rows. That used to be a comment in one
 * file and a literal array in another. They are now the same constants, imported by both, so a
 * rename cannot silently make the template unreadable by its own importer.
 */

import {
  excelCellText,
  excelWorksheetToJsonRows,
  firstExcelWorksheet,
  loadExcelWorkbook,
} from "@/lib/uploads/exceljs-rows";

/**
 * Any one of these, in a cell, marks the header row's id column.
 *
 * Lower-case and compared exactly — these are matched against `excelCellText(...).toLowerCase()`,
 * not normalized, so "Employee ID" matches and "Employee-ID" does not.
 */
export const EMPLOYEE_UPLOAD_ID_HEADERS = ["employee id", "hr_id", "hr id", "employee code"] as const;

/**
 * The header row must also carry ONE of these, so a stray "HR ID" note above the table cannot
 * claim it.
 *
 * WHY THERE ARE TWO. This was a single string, "full name", and the template's own header said
 * exactly that — so the pair test worked and nobody had to think about it. Then HR rebuilt the
 * sheet in September 2026 and renamed the column "Full English Name", which is a better name and
 * broke the file completely: the id header still matched, the name header did not, no row in the
 * first ten satisfied BOTH, and the parser fell back to row 1 — the masthead. Every column then
 * mapped to nothing and a file full of correct data read as empty, with no error naming the cause.
 *
 * So the accepted set is a LIST, and renaming this column in `employee-master-columns.ts` means
 * adding the new spelling here in the same change. `tests/employee-master-workbook.test.ts` pins
 * the template's own header against this list for exactly that reason.
 */
export const EMPLOYEE_UPLOAD_NAME_HEADERS = ["full english name", "full name"] as const;

/** @deprecated Kept for callers that only ever needed the template's own spelling. */
export const EMPLOYEE_UPLOAD_NAME_HEADER = EMPLOYEE_UPLOAD_NAME_HEADERS[0];

/**
 * How far down the sheet the header may sit.
 *
 * The template spends three rows on the masthead and one on the section band, so its header lands
 * on row 5. Four rows of headroom is the entire budget for anything added above it.
 */
export const EMPLOYEE_UPLOAD_HEADER_SCAN_ROWS = 10;

export type EmployeeUploadParseFailure = { error: "empty_worksheet" | "invalid_excel_file" };

export type EmployeeUploadParseSuccess<TRow> = {
  /** Row number of the header itself. */
  headerRowNumber: number;
  /** Row number of the first data row — what issue row numbers are reported against. */
  firstDataRowNumber: number;
  rows: TRow[];
};

export function isEmployeeUploadParseFailure(
  parsed: EmployeeUploadParseFailure | EmployeeUploadParseSuccess<unknown>,
): parsed is EmployeeUploadParseFailure {
  return "error" in parsed;
}

/**
 * Finds the header row and reads everything under it.
 *
 * ONLY THE FIRST WORKSHEET IS READ, by position. The template therefore has to keep its data sheet
 * first no matter how much cover material it grows.
 */
export async function parseEmployeeUploadRows<TRow>(
  file: File,
): Promise<EmployeeUploadParseFailure | EmployeeUploadParseSuccess<TRow>> {
  try {
    const workbook = await loadExcelWorkbook(await file.arrayBuffer());
    const sheet = firstExcelWorksheet(workbook);

    if (!sheet) {
      return { error: "empty_worksheet" };
    }

    let headerRowNumber = 1;
    const scanTo = Math.min(sheet.rowCount, EMPLOYEE_UPLOAD_HEADER_SCAN_ROWS);
    for (let rowNumber = 1; rowNumber <= scanTo; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const values = Array.from({ length: sheet.columnCount }, (_, index) =>
        excelCellText(row.getCell(index + 1).value).toLowerCase(),
      );

      if (
        values.some((value) => (EMPLOYEE_UPLOAD_ID_HEADERS as readonly string[]).includes(value)) &&
        values.some((value) => (EMPLOYEE_UPLOAD_NAME_HEADERS as readonly string[]).includes(value))
      ) {
        headerRowNumber = rowNumber;
        break;
      }
    }

    const rows = excelWorksheetToJsonRows(sheet, headerRowNumber, { defaultValue: null }) as TRow[];

    if (rows.length === 0) {
      return { error: "empty_worksheet" };
    }

    return { firstDataRowNumber: headerRowNumber + 1, headerRowNumber, rows };
  } catch {
    return { error: "invalid_excel_file" };
  }
}
