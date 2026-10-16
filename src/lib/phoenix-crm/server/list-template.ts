/**
 * Phoenix CRM — the SFE's list template: what the download carries, and what the upload does.
 *
 * Owner's ask, 2026-10-02: SFE (or the Super Admin) downloads a sheet for one territory, the rep fills
 * in his list, SFE uploads it and the list appears. Why a loaded customer lands as `pending` rather than
 * on the list proper, and why the grade on the sheet is the SFE's, is in `list-template-rules.ts` and in
 * the migration `20261003000753_phoenix_crm_list_template_bulk_add.sql`.
 *
 * 🔴 BOTH ENDS ARE THE SFE MANAGER'S AND THE SUPER ADMIN'S, AND THE GATE IS THE INTEGRITY BOARD'S OWN
 * PREDICATE — `canReadIntegrityBoard`, imported rather than a second copy of the role list, because a
 * second copy is how one of them drifts open. A district manager cannot reach this and neither can a rep:
 * it writes a whole list at once, with the grades, which is the decision the owner gave to these two
 * seats.
 *
 * 🔴 THE DAYS AND HOURS COLUMN IS A DRAFT, NOT THE PLACE (owner, 2026-10-05: "put the clinic days and
 * hours in the SFE's list-template sheet"). The SFE knows the clinic's hours once; the rep was typing
 * them again at every door. So the sheet carries them, `parseListSheetHours` reads the cell, and they
 * land on the CUSTOMER as `intake_timings` — a draft the validate screen offers pre-ticked. The PLACE
 * still stores only what the rep confirmed standing in front of the signboard, which is the frozen-place
 * rule untouched. An unreadable cell is dropped in silence and never refuses the row: the list is the
 * point, the hours are a convenience.
 *
 * 🔴 AND THE SECOND SHEET IS AN INPUT NOW, NOT JUST A REMINDER. "Already on the list" used to be
 * read-only. It carries a Days and hours column the SFE may fill for a customer already waiting to be
 * validated — 8,712 of them on the day this shipped — because those were loaded before the column
 * existed and would otherwise never get their hours. Only a customer still `pending` with no place
 * takes one; one the rep has already validated keeps the hours he confirmed.
 *
 * 🔴 AND THE TERRITORY IS NAMED TWICE — once by the screen and once by the sheet — because they must
 * agree. `templateSeatMismatch` is what stops a sheet filled for one rep being loaded onto another, which
 * nothing downstream would ever notice.
 */

import ExcelJS from "exceljs";

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  foldHeader,
  locateExistingColumns,
  locateTemplateColumns,
  readTemplateHoursRows,
  readTemplateRows,
  TEMPLATE_COLUMNS,
  TEMPLATE_EXISTING_COLUMNS,
  TEMPLATE_EXISTING_REQUIRED_KEYS,
  TEMPLATE_EXISTING_SHEET,
  TEMPLATE_HEADER_SCAN_ROWS,
  TEMPLATE_REQUIRED_KEYS,
  TEMPLATE_ROWS_MAX,
  TEMPLATE_SEAT_LABEL,
  TEMPLATE_SHEET,
  type TemplateColumnKey,
  type TemplateCustomerRow,
  type TemplateExistingColumnKey,
  type TemplateHoursRow,
  type TemplateRowRefusal,
} from "@/lib/phoenix-crm/list-template-rules";
import { readTestFlag, territoryForRead, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { weekTimingsText } from "@/lib/phoenix-crm/timings";
import { callPhoenixCrm } from "@/lib/phoenix-crm/server/db";
import { canReadIntegrityBoard } from "@/lib/phoenix-crm/server/integrity-board";
import { loadTerritoryCustomers, mapTimings } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { buildPhoenixCrmListTemplate, type ListTemplateCustomer } from "@/lib/phoenix-crm/server/list-template-workbook";
import { excelCellText, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

type Row = Record<string, unknown>;

/** The two readers, through the board's own predicate. */
function assertListLoader(viewer: PhoenixCrmViewer): void {
  if (!canReadIntegrityBoard(viewer)) {
    throw forbiddenError("Loading a territory's list from a sheet is the SFE Manager's and the Super Admin's.");
  }
  // `canApprove`, not `canUpdate`: the SFE Manager holds `phoenix_crm: ["read", "approve"]`, so asking
  // for update here would refuse the very person the owner's ask names.
  if (!viewer.canApprove) throw forbiddenError("Your role cannot load a territory's list.");
}

/** Where the customer stands, in the words the sheet uses. */
function standing(status: unknown): string {
  if (status === "active") return "On the list";
  if (status === "pending") return "Waiting to be validated";
  if (status === "outside") return "Waiting to be added";
  return "In the Archive";
}

function seatOf(viewer: PhoenixCrmViewer, seatId: unknown, test: unknown): { seat: OrgSeat; isTest: boolean } {
  const { seat, isTest } = territoryForRead(viewer, seatId, readTestFlag(test));
  if (!seat.lineCode) throw validationError("This territory has no line in the organogram, so its list cannot be loaded.");
  return { seat, isTest };
}

/** The .xlsx itself, for one territory. */
export async function buildListTemplateFor(viewer: PhoenixCrmViewer, seatId: unknown, test: unknown): Promise<{ buffer: Buffer; fileName: string; seat: OrgSeat }> {
  assertListLoader(viewer);
  const { seat, isTest } = seatOf(viewer, seatId, test);
  const { customers, placesByCustomer } = await loadTerritoryCustomers(seat.seatId, isTest);
  const names = await loadPeopleNames([seat.occupantHrId, viewer.hrId]);
  const existing: ListTemplateCustomer[] = customers
    .map((row) => {
      // What the sheet shows in the hours column, and whether it will be read back on upload.
      //
      // 🔴 CONFIRMED HOURS WIN OVER THE DRAFT, AND A VALIDATED CUSTOMER IS NOT ASKED AGAIN. Once the rep
      // has stood at the door and ticked the days, those hours are the place's and the SFE's cell cannot
      // overwrite them — the sheet prints them so she can see they are already there. The draft is only
      // offered where there is nothing: still pending, no place captured.
      const places = placesByCustomer.get(String(row.id)) ?? [];
      const confirmed = places.flatMap((place) => place.timings);
      const draft = mapTimings(row.intake_timings);
      const hours = confirmed.length > 0 ? confirmed : draft;
      return {
        // 🔴 THE RAW STATUS, NEVER `standing()` — that returns the LABEL the sheet prints
        // ("Waiting to be validated"), so comparing it to "pending" is always false and every row
        // would have read as closed to hours. Caught before the first upload, 2026-10-05.
        acceptsHours: row.status === "pending" && places.length === 0,
        daysAndHours: hours.length > 0 ? weekTimingsText(hours, false) : null,
        grade: typeof row.grade === "string" ? row.grade : null,
        listType: String(row.list_type ?? ""),
        name: String(row.name ?? ""),
        speciality: typeof row.speciality === "string" ? row.speciality : null,
        status: standing(row.status),
      };
    })
    .sort((left, right) => left.listType.localeCompare(right.listType) || left.name.localeCompare(right.name));

  const buffer = await buildPhoenixCrmListTemplate({
    existing,
    generatedAtIso: new Date().toISOString(),
    lineName: seat.lineName ?? "No line",
    preparedFor: nameOf(names, viewer.hrId),
    repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
    seatId: seat.seatId,
    territoryName: territoryName(seat),
  });
  const day = new Date().toISOString().slice(0, 10);
  return { buffer, fileName: `phoenix-crm-customer-list-${seat.seatId}-${day}.xlsx`, seat };
}

/** What the screen needs to offer a territory: the ones this viewer may load, by name. */
export async function listTemplateTerritories(viewer: PhoenixCrmViewer): Promise<Array<{ seatId: string; territoryName: string; repName: string | null; customers: number }>> {
  assertListLoader(viewer);
  const seats = viewer.scopeTerritories.filter((seat) => Boolean(seat.lineCode));
  if (seats.length === 0) return [];
  // The names and the counts need nothing from each other, so they are asked together rather than one
  // after the other (Phoenix CRM performance audit, 2026-10-16).
  const [names, counts] = await Promise.all([
    loadPeopleNames(seats.map((seat) => seat.occupantHrId)),
    countCustomersPerSeat(seats.map((seat) => seat.seatId)),
  ]);
  return seats
    .map((seat) => ({
      customers: counts.get(seat.seatId) ?? 0,
      repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
      seatId: seat.seatId,
      territoryName: territoryName(seat),
    }))
    .sort((left, right) => left.territoryName.localeCompare(right.territoryName));
}

async function countCustomersPerSeat(seatIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (seatIds.length === 0) return counts;
  // One read for every seat: a per-seat count would be one round trip each and every round trip from
  // Railway to Supabase crosses the Atlantic.
  //
  // 🔴 COUNTED IN THE DATABASE SINCE 2026-10-16, NOT BY FETCHING EVERY ROW. The picker prints one number
  // per territory, and it used to read every customer on every list to get it — about 11,500 rows on
  // production, a thousand at a time, a dozen round trips one after another — only to count them here
  // and throw them away (Phoenix CRM performance audit). `phoenix_crm_customer_counts_by_seat` applies
  // the very same filter (these seats, `is_test = false`, status active, pending or outside) and answers
  // ONE jsonb object, which PostgREST's silent 1,000-row cap cannot cut short — the trap that once made
  // the unpaged row read print 0 for the territories that sorted late, inviting the SFE to load a list
  // that already existed (found in review, 2026-10-03). The seat ids travel in the request body, so a
  // company-wide picker can never push the URL past its header limit either.
  //
  // A failed count throws, as the paged read refused: a count the picker PRINTS is a number somebody
  // acts on, so it must fail loudly rather than read low.
  const bySeat = await callPhoenixCrm<Record<string, unknown> | null>("phoenix_crm_customer_counts_by_seat", {
    p_seat_ids: [...seatIds],
  });
  for (const [seatId, customers] of Object.entries(bySeat ?? {})) {
    const count = Number(customers);
    if (Number.isFinite(count)) counts.set(seatId, count);
  }
  return counts;
}

export type ListTemplateImportResult = {
  seatId: string;
  territoryName: string;
  /** Rows the sheet offered, blank ones excluded. */
  read: number;
  loaded: number;
  /** Customers already waiting to be validated whose days and hours the second sheet filled in. */
  hoursSet: number;
  /** A line per row the sheet offered and the list would not take, in sheet order. */
  refused: TemplateRowRefusal[];
};

/** The reason the database gave, in the SFE's words. */
function skipReason(reason: unknown, name: unknown): string {
  const who = typeof name === "string" && name ? `"${name}"` : "This customer";
  if (reason === "already_on_the_list") return `${who} is already on this territory's list.`;
  if (reason === "pharmacy_has_no_grade") return `${who} is a pharmacy, so it takes no grade and no potential.`;
  if (reason === "grade_required") return `${who} needs a grade (A, B or C) and a potential (AA to BC).`;
  return `${who} could not be added — check the row and try again.`;
}

/**
 * The upload: read the sheet, judge every row, load the ones that stand.
 *
 * Nothing is loaded when the sheet is not this template or names another territory — those are faults in
 * the FILE, and a partial load from a file nobody meant to send is worse than no load at all. A bad ROW
 * is different: it is refused by itself and named by its row number, because an SFE with 300 rows and
 * one typo should not have to send the sheet round again.
 */
export async function importListTemplate(viewer: PhoenixCrmViewer, form: FormData): Promise<ListTemplateImportResult> {
  assertListLoader(viewer);
  const { seat, isTest } = seatOf(viewer, form.get("seatId"), form.get("test"));

  const file = form.get("file");
  if (!(file instanceof File)) throw validationError("Choose the filled template to upload.");
  const check = validateSpreadsheetFile(file, {
    ...xlsxSpreadsheetValidation,
    emptyError: "phoenix_crm_template_empty",
    emptyMessage: "That file is empty.",
    tooLargeError: "phoenix_crm_template_too_large",
    tooLargeMessage: "That file is too large for an upload.",
    unsupportedError: "phoenix_crm_template_unsupported",
    unsupportedMessage: "Upload the filled template as .xlsx — the file the download gives you.",
  });
  if (!check.ok) throw validationError(check.message);

  const workbook = await loadExcelWorkbook(await file.arrayBuffer());
  const sheet = workbook.getWorksheet(TEMPLATE_SHEET) ?? workbook.worksheets[0];
  if (!sheet) throw validationError("That file has no sheet to read.");

  // 🔴 A MISSING MARKER IS REFUSED TOO, not just a mismatched one. Every template Phoenix builds writes
  // it, so a sheet without one was rebuilt, re-saved from another tool, or had the row deleted — and the
  // marker is the ONLY thing standing between a whole list, with its grades, and the wrong territory.
  // Accepting a null marker for "whichever territory is picked in the UI" threw that check away in
  // exactly the case it exists for: a sheet nobody can prove the origin of. Found in review, 2026-10-03.
  const marked = seatMarkerOf(sheet);
  if (!marked) {
    throw validationError(
      "That sheet does not say which territory it was prepared for, so it cannot be loaded onto one. Download the template for this territory and fill that file in — do not rebuild or re-save it from another sheet.",
    );
  }
  if (marked !== seat.seatId) {
    throw validationError(
      `This sheet was prepared for territory ${marked}, and you are loading ${seat.seatId}. Pick that territory, or download a new sheet for this one.`,
    );
  }

  const header = findHeaderRow(sheet);
  if (!header) {
    throw validationError(
      'That sheet is not the customer list template — it has no "List" and "Customer name" header row. Download the template and fill that one in.',
    );
  }

  const rows: Array<{ row: number; cells: Partial<Record<TemplateColumnKey, unknown>> }> = [];
  for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cells: Partial<Record<TemplateColumnKey, unknown>> = {};
    for (const [key, index] of header.columns) cells[key] = excelCellText(row.getCell(index + 1).value);
    rows.push({ row: rowNumber, cells });
  }

  const { customers, refused } = readTemplateRows(rows);
  // The second sheet's hours, for customers already waiting to be validated. Read whether or not the
  // first sheet offered a single new row — an SFE may upload purely to fill the hours in — and never
  // allowed to refuse anything: a sheet without that sheet, or with it and no header row, yields none.
  const hours = readExistingHours(workbook);
  if (customers.length === 0 && hours.length === 0) {
    return { hoursSet: 0, loaded: 0, read: refused.length, refused, seatId: seat.seatId, territoryName: territoryName(seat) };
  }
  if (customers.length > TEMPLATE_ROWS_MAX) {
    throw validationError(`That sheet holds ${customers.length} customers. One upload takes ${TEMPLATE_ROWS_MAX}.`);
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_load_list_customers", {
    p: {
      actor_hr_id: viewer.hrId,
      customers: customers.map(toPayload),
      hours: hours.map(hoursPayload),
      is_test: isTest,
      line_code: seat.lineCode,
      seat_id: seat.seatId,
      source: "sheet",
    },
  });

  const loaded = Array.isArray(result.loaded) ? result.loaded.length : 0;
  const skipped = Array.isArray(result.skipped) ? (result.skipped as Row[]) : [];
  const all = [
    ...refused,
    ...skipped.map((entry) => ({ reason: skipReason(entry.reason, entry.name), row: Number(entry.row ?? 0) })),
  ].sort((left, right) => left.row - right.row);

  return {
    hoursSet: Array.isArray(result.hours_set) ? result.hours_set.length : 0,
    loaded,
    read: customers.length + refused.length,
    refused: all,
    seatId: seat.seatId,
    territoryName: territoryName(seat),
  };
}

/**
 * The "Already on the list" sheet's hours, or none at all.
 *
 * 🔴 IT NEVER THROWS AND IT NEVER REFUSES A ROW. A sheet downloaded before this column existed has no
 * such sheet, or has it without the column; an SFE who filled only the first sheet leaves every cell
 * blank. All three are ordinary, and the upload they belong to must still load its customers.
 */
function readExistingHours(workbook: ExcelJS.Workbook): TemplateHoursRow[] {
  const sheet = workbook.getWorksheet(TEMPLATE_EXISTING_SHEET);
  if (!sheet) return [];
  const header = findExistingHeaderRow(sheet);
  if (!header) return [];
  const rows: Array<{ row: number; cells: Partial<Record<TemplateExistingColumnKey, unknown>> }> = [];
  for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cells: Partial<Record<TemplateExistingColumnKey, unknown>> = {};
    for (const [key, index] of header.columns) cells[key] = excelCellText(row.getCell(index + 1).value);
    rows.push({ row: rowNumber, cells });
  }
  return readTemplateHoursRows(rows);
}

function hoursPayload(row: TemplateHoursRow): Row {
  return { list_type: row.listType, name: row.name, row: row.row, timings: row.timings };
}

function toPayload(customer: TemplateCustomerRow): Row {
  return {
    grade: customer.grade,
    intake_note: customer.note,
    intake_timings: customer.timings,
    intake_where: customer.whereToFind,
    list_type: customer.listType,
    name: customer.name,
    phone: customer.phone,
    potential_grade: customer.potentialGrade,
    row: customer.row,
    speciality: customer.speciality,
  };
}

/** The territory the sheet was built for, read from beside its own label. */
function seatMarkerOf(sheet: ExcelJS.Worksheet): string | null {
  const wanted = foldHeader(TEMPLATE_SEAT_LABEL);
  for (let rowNumber = 1; rowNumber <= Math.min(TEMPLATE_HEADER_SCAN_ROWS, sheet.rowCount); rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    for (let column = 1; column <= Math.max(2, sheet.columnCount); column += 1) {
      if (foldHeader(excelCellText(row.getCell(column).value)) !== wanted) continue;
      const value = excelCellText(row.getCell(column + 1).value).trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Which row is the header, and which column each token sits in.
 *
 * Scanned rather than fixed, because the template writes a masthead, the territory and a rule above its
 * table: a fixed row number would break the moment that preamble grows by a line, and it is exactly the
 * kind of break that reads as "the file is wrong".
 */
/**
 * The same scan over the "Already on the list" sheet, which has its own callout rows above the header.
 *
 * It asks for the NAME and the HOURS column only (`TEMPLATE_EXISTING_REQUIRED_KEYS`). A sheet built
 * before the hours column existed has the header row but not that column, and must read as "no hours to
 * load" rather than as a sheet nobody can parse.
 */
function findExistingHeaderRow(
  sheet: ExcelJS.Worksheet,
): { rowNumber: number; columns: Map<TemplateExistingColumnKey, number> } | null {
  const limit = Math.min(TEMPLATE_HEADER_SCAN_ROWS, sheet.rowCount);
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const headers: unknown[] = [];
    for (let column = 1; column <= Math.max(TEMPLATE_EXISTING_COLUMNS.length, sheet.columnCount); column += 1) {
      headers.push(excelCellText(row.getCell(column).value));
    }
    const columns = locateExistingColumns(headers);
    if (TEMPLATE_EXISTING_REQUIRED_KEYS.every((key) => columns.has(key))) return { columns, rowNumber };
  }
  return null;
}

function findHeaderRow(sheet: ExcelJS.Worksheet): { rowNumber: number; columns: Map<TemplateColumnKey, number> } | null {
  const limit = Math.min(TEMPLATE_HEADER_SCAN_ROWS, sheet.rowCount);
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const headers: unknown[] = [];
    for (let column = 1; column <= Math.max(TEMPLATE_COLUMNS.length, sheet.columnCount); column += 1) {
      headers.push(excelCellText(row.getCell(column).value));
    }
    const columns = locateTemplateColumns(headers);
    if (TEMPLATE_REQUIRED_KEYS.every((key) => columns.has(key))) return { columns, rowNumber };
  }
  return null;
}
