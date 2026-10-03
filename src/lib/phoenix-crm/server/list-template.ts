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
 * 🔴 AND THE TERRITORY IS NAMED TWICE — once by the screen and once by the sheet — because they must
 * agree. `templateSeatMismatch` is what stops a sheet filled for one rep being loaded onto another, which
 * nothing downstream would ever notice.
 */

import ExcelJS from "exceljs";

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  foldHeader,
  locateTemplateColumns,
  readTemplateRows,
  TEMPLATE_COLUMNS,
  TEMPLATE_HEADER_SCAN_ROWS,
  TEMPLATE_REQUIRED_KEYS,
  TEMPLATE_ROWS_MAX,
  TEMPLATE_SEAT_LABEL,
  TEMPLATE_SHEET,
  type TemplateColumnKey,
  type TemplateCustomerRow,
  type TemplateRowRefusal,
} from "@/lib/phoenix-crm/list-template-rules";
import { readTestFlag, territoryForRead, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, throwIfError } from "@/lib/phoenix-crm/server/db";
import { canReadIntegrityBoard } from "@/lib/phoenix-crm/server/integrity-board";
import { loadTerritoryCustomers } from "@/lib/phoenix-crm/server/list";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { buildPhoenixCrmListTemplate, type ListTemplateCustomer } from "@/lib/phoenix-crm/server/list-template-workbook";
import { getSupabaseAdmin } from "@/lib/supabase/server";
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
  const { customers } = await loadTerritoryCustomers(seat.seatId, isTest);
  const names = await loadPeopleNames([seat.occupantHrId, viewer.hrId]);
  const existing: ListTemplateCustomer[] = customers
    .map((row) => ({
      grade: typeof row.grade === "string" ? row.grade : null,
      listType: String(row.list_type ?? ""),
      name: String(row.name ?? ""),
      speciality: typeof row.speciality === "string" ? row.speciality : null,
      status: standing(row.status),
    }))
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
  const names = await loadPeopleNames(seats.map((seat) => seat.occupantHrId));
  const counts = await countCustomersPerSeat(seats.map((seat) => seat.seatId));
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
  // One read for every seat, counted here: a per-seat count would be one round trip each and every
  // round trip from Railway to Supabase crosses the Atlantic.
  //
  // 🔴 PAGED, because `.limit(20000)` DOES NOT RAISE PostgREST's own 1,000-row ceiling — it stops there
  // with no error and no marker (the module rule). The whole company's list is far past 1,000, so the
  // unpaged read counted the first page only: the territories that happened to sort late read 0 and the
  // SFE would download a template whose "Already on the list" sheet claimed an empty list for a seat
  // that has one, and enter its customers a second time. Found in review, 2026-10-03.
  //
  // `id` is the total order the walk needs, and `refuse` rather than `stop`: a count the picker PRINTS
  // is a number somebody acts on, so a truncated one must fail loudly instead of reading low.
  const { rows, error } = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_customers")
        .select("id, seat_id")
        .in("seat_id", [...seatIds])
        .eq("is_test", false)
        .in("status", ["active", "pending", "outside"])
        .order("id", { ascending: true }),
    {
      maxRows: 200_000,
      uniqueBy: (row) => String(row.id ?? ""),
      what: "the customers on these territories' lists",
      whenFull: "refuse",
    },
  );
  throwIfError(error);
  for (const row of rows) {
    const seatId = String(row.seat_id ?? "");
    counts.set(seatId, (counts.get(seatId) ?? 0) + 1);
  }
  return counts;
}

export type ListTemplateImportResult = {
  seatId: string;
  territoryName: string;
  /** Rows the sheet offered, blank ones excluded. */
  read: number;
  loaded: number;
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
  if (customers.length === 0) {
    return { loaded: 0, read: refused.length, refused, seatId: seat.seatId, territoryName: territoryName(seat) };
  }
  if (customers.length > TEMPLATE_ROWS_MAX) {
    throw validationError(`That sheet holds ${customers.length} customers. One upload takes ${TEMPLATE_ROWS_MAX}.`);
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_load_list_customers", {
    p: {
      actor_hr_id: viewer.hrId,
      customers: customers.map(toPayload),
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

  return { loaded, read: customers.length + refused.length, refused: all, seatId: seat.seatId, territoryName: territoryName(seat) };
}

function toPayload(customer: TemplateCustomerRow): Row {
  return {
    grade: customer.grade,
    intake_note: customer.note,
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
