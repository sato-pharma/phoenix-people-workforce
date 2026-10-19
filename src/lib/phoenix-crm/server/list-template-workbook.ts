/**
 * Phoenix CRM — the SFE's list template, as a workbook (owner's ask, 2026-10-02).
 *
 * It lives under `server/` because it imports ExcelJS, and `phoenix-crm-boundary` forbids a rule
 * module outside `server/` from touching it — those modules are bundled for the phone.
 *
 * ## House identity, not the Phoenix kit
 *
 * This is a company document that leaves the building and comes back filled in by a rep, so it wears
 * `SATO-DIS-2026-01` like every other one: `buildHouseCoverSheet` for the cover, `writeHouseTable` for
 * each table. The two exemptions from the house identity are the automated payroll exports and the
 * offer letter, and this is neither — do not bring it into line with the black-and-orange the screen
 * uses.
 *
 * ## What is on it
 *
 *   Cover               — what it is, whose territory, and the one rule about the clinic location.
 *   Customers           — the fillable table, with dropdowns, and the territory's own code.
 *   Already on the list — what the seat holds today, so nobody is asked for a customer twice.
 *   Lists               — the dropdown sources. Hidden: it is machinery, not a page to read.
 *
 * The column tokens are `list-template-rules.ts`'s, imported rather than retyped, so the sheet this
 * writes is readable by the parser that reads it back.
 */

import ExcelJS from "exceljs";

import { buildHouseCoverSheet, writeHouseTable, type CellValue, type TableColumn } from "@/lib/export/house-table-workbook";
import { houseBodyStyle, houseCalloutStyle, houseGeneratedRow } from "@/lib/export/house-xlsx-identity";
import { POTENTIAL_GRADES } from "@/lib/phoenix-crm/entry-rules";
import {
  TEMPLATE_BLANK_ROWS,
  TEMPLATE_COLUMNS,
  TEMPLATE_EXISTING_COLUMNS,
  TEMPLATE_EXISTING_NOTE,
  TEMPLATE_EXISTING_SHEET,
  TEMPLATE_LIST_TYPES,
  TEMPLATE_LISTS_SHEET,
  TEMPLATE_SEAT_LABEL,
  TEMPLATE_SHEET,
  TEMPLATE_TABLE_NOTE,
} from "@/lib/phoenix-crm/list-template-rules";

/** The grades a doctor can carry. A pharmacy carries none — see the rules module. */
const GRADES = ["A", "B", "C"] as const;

export type ListTemplateCustomer = {
  listType: string;
  name: string;
  speciality: string | null;
  grade: string | null;
  status: string;
  /**
   * The days and hours already known for this customer — his validated place's, or the draft a sheet
   * loaded earlier — printed back so nobody writes out hours Phoenix already holds.
   */
  daysAndHours: string | null;
  /** True while his hours can still be written on this sheet: waiting to be validated, no place yet. */
  acceptsHours: boolean;
};

export type ListTemplateInput = {
  seatId: string;
  /** `territoryName(seat)` — the area AND the line ("Suez · Anti Infective"), so nothing here appends the line again. */
  territoryName: string;
  lineName: string;
  /** Null when the seat is vacant, which is one of the cases this route exists for. */
  repName: string | null;
  preparedFor: string;
  generatedAtIso: string;
  /** What the seat already holds — shown, never asked for again. */
  existing: readonly ListTemplateCustomer[];
};

function column(label: string, width: number): TableColumn {
  return { label, width };
}

/**
 * The reference sheet the dropdowns point at, and the ranges that name its columns.
 *
 * A single-word sheet name means a validation formula needs no quoting, which is the one thing that
 * silently breaks a dropdown. It is hidden rather than absent: Excel refuses a validation whose source
 * sheet is gone, and a VERY hidden sheet cannot be unhidden from the ribbon by accident.
 */
function writeListsSheet(workbook: ExcelJS.Workbook): { lists: string; grades: string; potentials: string } {
  const sheet = workbook.addWorksheet(TEMPLATE_LISTS_SHEET);
  sheet.state = "veryHidden";
  sheet.getColumn(1).width = 14;
  sheet.getColumn(2).width = 10;
  sheet.getColumn(3).width = 12;
  sheet.getCell("A1").value = "List";
  sheet.getCell("B1").value = "Grade";
  sheet.getCell("C1").value = "Potential";
  TEMPLATE_LIST_TYPES.forEach((value, index) => {
    sheet.getCell(index + 2, 1).value = value;
  });
  GRADES.forEach((value, index) => {
    sheet.getCell(index + 2, 2).value = value;
  });
  POTENTIAL_GRADES.forEach((value, index) => {
    sheet.getCell(index + 2, 3).value = value;
  });
  return {
    grades: `${TEMPLATE_LISTS_SHEET}!$B$2:$B$${GRADES.length + 1}`,
    lists: `${TEMPLATE_LISTS_SHEET}!$A$2:$A$${TEMPLATE_LIST_TYPES.length + 1}`,
    potentials: `${TEMPLATE_LISTS_SHEET}!$C$2:$C$${POTENTIAL_GRADES.length + 1}`,
  };
}

export async function buildPhoenixCrmListTemplate(input: ListTemplateInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  buildHouseCoverSheet(workbook, {
    confidentialNote:
      "This sheet names a territory's customers and the grades set for them. It is filled in by the "
      + "territory's medical representative and returned to the SFE Manager, and goes to nobody else.",
    rows: [
      ["Territory", input.territoryName],
      ["Line", input.lineName],
      ["Medical representative", input.repName ?? "The seat is vacant"],
      ["Territory code", input.seatId],
      ["Customers already on the list", String(input.existing.length)],
      ["Prepared for", input.preparedFor],
      houseGeneratedRow(input.generatedAtIso),
    ],
    subtitle:
      "Fill in one row per customer on the Customers sheet, then return it to the SFE Manager, who "
      + "uploads it in Phoenix.",
    title: "Phoenix CRM · Customer list",
  });

  const sources = writeListsSheet(workbook);
  writeCustomersSheet(workbook, input, sources);
  writeExistingSheet(workbook, input);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function writeCustomersSheet(
  workbook: ExcelJS.Workbook,
  input: ListTemplateInput,
  sources: { lists: string; grades: string; potentials: string },
): void {
  const sheet = workbook.addWorksheet(TEMPLATE_SHEET);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 6 }];

  // The territory, written where the parser reads it back. A sheet that does not name its own seat is
  // one slip from loading the wrong rep's doctors onto the wrong list.
  sheet.getCell("A1").value = TEMPLATE_SEAT_LABEL;
  sheet.getCell("B1").value = input.seatId;
  sheet.getCell("A2").value = "Territory";
  // The territory name already ends in the line, so the line is not written again: every sheet read
  // "Suez · Anti Infective · Anti Infective · seat vacant" until 2026-10-19.
  sheet.getCell("B2").value = `${input.territoryName} · ${input.repName ?? "seat vacant"}`;
  for (const ref of ["A1", "B1", "A2", "B2"]) houseBodyStyle(sheet.getCell(ref), { size: 9.5 });

  // 🔴 Said on the sheet itself, because the one thing a filled sheet cannot carry is the place, and
  // somebody will otherwise add a column for it. The span is DERIVED from the column count: it read
  // "A3:H3" while there were eight columns, and the ninth left the callout short of the table.
  const lastColumn = sheet.getColumn(TEMPLATE_COLUMNS.length).letter;
  sheet.mergeCells(`A3:${lastColumn}3`);
  const rule = sheet.getCell("A3");
  rule.value =
    "The clinic's photo and its location are NOT on this sheet: the rep captures them at the door, once, "
    + "and Phoenix resolves the address, brick, area and region from that. Every customer loaded from here "
    + "appears under To validate for them to validate on the spot. Days and hours ARE on this sheet — write "
    + "them once here and the rep only confirms them at the door. Write a 24-hour time or add AM/PM; a bare "
    + "hour from 1 to 7 is read as the afternoon, so \"Sat 2-4\" is 2:00 PM to 4:00 PM.";
  houseCalloutStyle(rule, { emphasis: true });
  sheet.getRow(3).height = 44;

  const columns = TEMPLATE_COLUMNS.map((entry) => column(entry.label, entry.width));
  const hints: CellValue[] = TEMPLATE_COLUMNS.map((entry) => entry.hint);
  const blanks: CellValue[][] = Array.from({ length: TEMPLATE_BLANK_ROWS }, () => TEMPLATE_COLUMNS.map(() => null));

  // The hint row rides as the table's FIRST data row, so `writeHouseTable` styles it like any other.
  // 🔴 The parser does NOT skip it for being unreadable — it would REFUSE it, and every upload of an
  // untouched template reported that bogus refusal. `isTemplateHintRow` recognises it by matching these
  // very hints, which is why the hints live in TEMPLATE_COLUMNS and are written from there, never typed
  // twice: the sheet and the parser read one list, so they cannot drift apart.
  writeHouseTable(sheet, 5, {
    columns,
    rows: [hints, ...blanks],
    title: `Customers for ${input.territoryName}`,
    // From the rules module, because the importer has to recognise this line too — it is printed INSIDE
    // the span the upload reads and was being refused as a customer.
    note: TEMPLATE_TABLE_NOTE,
  });

  const headerRow = 6;
  const firstDataRow = headerRow + 1;
  const lastDataRow = headerRow + 1 + TEMPLATE_BLANK_ROWS;
  const indexOf = (key: string) => TEMPLATE_COLUMNS.findIndex((entry) => entry.key === key) + 1;

  // A dropdown on every fillable row, as a WARNING rather than a hard block: a rep pasting a column
  // from his own sheet must not be stopped, and the upload judges every cell again regardless.
  for (let row = firstDataRow; row <= lastDataRow; row += 1) {
    sheet.getCell(row, indexOf("listType")).dataValidation = {
      allowBlank: true,
      error: "Write AM, PM or Pharmacy. Anything else is refused when the sheet is uploaded.",
      errorStyle: "warning",
      errorTitle: "Not one of the three lists",
      formulae: [sources.lists],
      showErrorMessage: true,
      type: "list",
    };
    sheet.getCell(row, indexOf("grade")).dataValidation = {
      allowBlank: true,
      error: "A, B or C — optional, and empty for a pharmacy.",
      errorStyle: "warning",
      errorTitle: "Not a grade",
      formulae: [sources.grades],
      showErrorMessage: true,
      type: "list",
    };
    sheet.getCell(row, indexOf("potentialGrade")).dataValidation = {
      allowBlank: true,
      error: "AA, AB, AC, BA, BB or BC — optional, and empty for a pharmacy.",
      errorStyle: "warning",
      errorTitle: "Not a potential",
      formulae: [sources.potentials],
      showErrorMessage: true,
      type: "list",
    };
    // The phone as TEXT, or Excel eats the leading zero of an Egyptian mobile.
    sheet.getCell(row, indexOf("phone")).numFmt = "@";
    // The hours as TEXT too, or Excel reads "5:00 PM - 8:00 PM" as a date and hands the upload a serial
    // number where a clinic's evening should be.
    sheet.getCell(row, indexOf("daysAndHours")).numFmt = "@";
  }
}

/**
 * What the seat already holds — and the ONE column that is written here rather than read.
 *
 * 🔴 THIS SHEET IS NO LONGER READ-ONLY, AND THAT IS THE WHOLE POINT (owner, 2026-10-05). The customers
 * waiting to be validated were minted from iReports360, so the Customers sheet cannot carry them — the
 * loader's same-name guard refuses a second row for a customer already on the list. Their hours are
 * therefore written beside the line that is already printed, and the upload reads this sheet's last
 * column too. Nothing else here is read back.
 *
 * A customer who already has his hours gets them PRINTED, so nobody types out what Phoenix holds; one
 * who is past validating is marked as closed, because writing hours beside him would do nothing and the
 * sheet must not invite work it will silently drop.
 */
function writeExistingSheet(workbook: ExcelJS.Workbook, input: ListTemplateInput): void {
  const sheet = workbook.addWorksheet(TEMPLATE_EXISTING_SHEET);
  sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  const headerRow = 2;
  writeHouseTable(sheet, 1, {
    columns: TEMPLATE_EXISTING_COLUMNS.map((entry) => column(entry.label, entry.width)),
    note:
      input.existing.length === 0
        ? "This territory holds no customers yet, which is why the whole list is being loaded."
        : TEMPLATE_EXISTING_NOTE,
    rows: input.existing.map((customer) => [
      customer.listType,
      customer.name,
      customer.speciality,
      customer.grade,
      customer.status,
      customer.daysAndHours ?? (customer.acceptsHours ? null : "Already validated — hours are the rep's now"),
    ]),
    title: `Already on the list · ${input.territoryName}`,
  });

  // The hours cell as TEXT on every printed row, or Excel turns "5:00 PM - 8:00 PM" into a date and the
  // upload reads back a serial number instead of a clinic's evening.
  const hoursColumn = TEMPLATE_EXISTING_COLUMNS.findIndex((entry) => entry.key === "daysAndHours") + 1;
  for (let row = headerRow + 1; row <= headerRow + input.existing.length; row += 1) {
    sheet.getCell(row, hoursColumn).numFmt = "@";
  }
}
