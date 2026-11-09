/**
 * Bulk import for the company device register — the only realistic way to enter the fleet.
 *
 * WHY THIS EXISTS. The register shipped empty, and it stays useless until the ~85 laptops and
 * tablets already out with people are in it. Nobody is going to type 85 devices, each with a serial
 * or an IMEI and a holder, into a form one at a time — so the register would have stayed empty, and
 * an asset register nobody filled is indistinguishable from not having one.
 *
 * ONE COLUMN DEFINITION DRIVES BOTH HALVES. `COLUMNS` below is read by the template writer AND by
 * the parser. They cannot drift apart, which is the failure mode that makes an import silently read
 * the wrong column — a serial landing in the IMEI box is not a validation error, it is a device the
 * police cannot find. `tests/device-bulk-import.test.ts` pins that they share it.
 *
 * THERE IS NO SAMPLE DATA ROW, deliberately. The obvious way to show somebody the shape is a filled
 * example row under the headers, and every such template eventually imports its own example as a
 * real device — a fictional laptop, with a fictional serial, in a register whose entire value is
 * that its contents are evidence. The examples live in the note row instead, where nothing can read
 * them back.
 *
 * A LEAVER MAY BE NAMED AS A HOLDER, and that is the point rather than an oversight. The single
 * most valuable import is the fleet that is already out, and some of those people have left — they
 * are the actual exposure. The row imports and the register flags it immediately; refusing it would
 * hide exactly what the owner asked to see. It warns, loudly, so nobody enters one by accident.
 *
 * NOTHING HERE RE-IMPLEMENTS A CUSTODY RULE. Execution delegates to `createDevice` and
 * `issueDevice`, so every imported row goes through the same guards and writes its own audit row.
 * A bulk path that wrote rows directly would be a second door into the register with none of the
 * locks on it — and would replace 85 per-person audit entries with one opaque "imported 85".
 */

import ExcelJS from "exceljs";

import {
  HOUSE_MASTHEAD_ROWS,
  houseBodyStyle,
  houseCalloutStyle,
  houseHeaderStyle,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { imeiDuplicateKey, serialDuplicateKey } from "./device-identity";
import { createDevice, deviceErrorMessage, issueDevice, isDeviceCategory, readAllRegisterRows } from "./service";
import type { DeviceCategory } from "./types";

/**
 * Where the header row sits.
 *
 * The masthead takes rows 1-3 and the note row is 4, so the headers land on 5 — the same row the
 * Employee Master uses, and for the same reason: a re-uploadable template can carry a masthead only
 * if the writer and the parser agree on the row by a SHARED CONSTANT rather than by counting.
 */
export const DEVICE_IMPORT_HEADER_ROW = HOUSE_MASTHEAD_ROWS + 2;
export const DEVICE_IMPORT_NOTE_ROW = HOUSE_MASTHEAD_ROWS + 1;
export const DEVICE_IMPORT_FIRST_DATA_ROW = DEVICE_IMPORT_HEADER_ROW + 1;

/** Refused above this. A fleet is a few hundred devices; more is a wrong file, not a request. */
export const DEVICE_IMPORT_MAX_ROWS = 500;

/** The employment statuses that make somebody a leaver, shared by the picker and the directory. */
const LEAVER_STATUSES = new Set(["resigned", "terminated"]);

const SHEET_NAME = "Devices";
const LOOKUP_SHEET_NAME = "People";

export const DEVICE_CATEGORY_OPTIONS: readonly DeviceCategory[] = ["laptop", "tablet", "phone", "other"];

/** Every field a row can carry. The key is the parsed property; the header is what Excel shows. */
type ColumnKey =
  | "assetTag"
  | "category"
  | "manufacturer"
  | "model"
  | "serialNumber"
  | "imei"
  | "simNumber"
  | "lineNumber"
  | "estimatedValueEgp"
  | "purchasedOn"
  | "heldBy"
  | "issuedOn"
  | "declarationNo"
  | "handoverPlace"
  | "deviceName"
  | "processor"
  | "installedRam"
  | "systemType"
  | "windowsDeviceId"
  | "windowsProductId"
  | "note";

type ColumnDef = {
  key: ColumnKey;
  header: string;
  note: string;
  width: number;
  numFmt?: string;
  /** A dropdown backed by a literal list. Long lists use the hidden lookup sheet instead. */
  options?: readonly string[];
};

/**
 * THE SHARED CONTRACT. The template writer emits these headers in this order; the parser reads them
 * back by matching the header text, not by position — so inserting a column in the middle of a
 * previously-downloaded file still parses, and a renamed header fails loudly instead of silently
 * reading the neighbour.
 */
export const COLUMNS: readonly ColumnDef[] = [
  { key: "assetTag", header: "Asset tag *", note: "Your own sticker number, e.g. PHX-LAP-0001. Must be unique.", width: 18 },
  {
    key: "category",
    header: "Category *",
    note: "laptop / tablet / phone / other",
    width: 12,
    options: DEVICE_CATEGORY_OPTIONS,
  },
  { key: "manufacturer", header: "Manufacturer", note: "e.g. Dell, Samsung", width: 16 },
  { key: "model", header: "Model", note: "e.g. Latitude 5440", width: 20 },
  {
    key: "serialNumber",
    header: "Serial number",
    note: "Laptops: off the case, or Windows. REQUIRED unless you give an IMEI.",
    width: 22,
  },
  {
    key: "imei",
    header: "IMEI",
    note: "Tablets and phones: dial *#06#. REQUIRED unless you give a serial.",
    width: 22,
  },
  { key: "simNumber", header: "SIM number", note: "The number printed on the SIM, if it travels with the device.", width: 22 },
  { key: "lineNumber", header: "Line number", note: "e.g. 01001234567", width: 16 },
  {
    key: "estimatedValueEgp",
    header: "Estimated value (EGP)",
    note: "What the receipt agrees it is worth. This is the CEILING on any recovery — leave it blank and nothing can be recovered.",
    width: 20,
    numFmt: "#,##0",
  },
  { key: "purchasedOn", header: "Purchased on", note: "YYYY-MM-DD (optional)", width: 14 },
  {
    key: "heldBy",
    header: "Held by",
    note: "Pick a person, or type their HR ID. Leave blank if the device is in the store.",
    width: 34,
  },
  { key: "issuedOn", header: "Issued on", note: "YYYY-MM-DD. Only with a holder. Blank means today.", width: 14 },
  { key: "declarationNo", header: "Declaration no.", note: "رقم الإقرار from the signed receipt, if you have it.", width: 16 },
  { key: "handoverPlace", header: "Place of handover", note: "مكان التسليم, if you have it.", width: 18 },
  { key: "deviceName", header: "Device name", note: "Laptops only — Windows Settings > System > About.", width: 18 },
  { key: "processor", header: "Processor", note: "Laptops only.", width: 22 },
  { key: "installedRam", header: "Installed RAM", note: "Laptops only, e.g. 16.0 GB", width: 14 },
  { key: "systemType", header: "System type", note: "Laptops only, e.g. 64-bit operating system", width: 20 },
  { key: "windowsDeviceId", header: "Device ID", note: "Laptops only.", width: 34 },
  { key: "windowsProductId", header: "Product ID", note: "Laptops only.", width: 26 },
  { key: "note", header: "Note", note: "Anything worth recording about this device.", width: 28 },
];

// ---------------------------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------------------------

export type DeviceImportRow = {
  /** The row number in the USER'S OWN FILE, so a finding can be acted on without counting. */
  rowNumber: number;
  assetTag: string | null;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  imei: string | null;
  simNumber: string | null;
  lineNumber: string | null;
  estimatedValueEgp: number | null;
  purchasedOn: string | null;
  heldBy: string | null;
  issuedOn: string | null;
  declarationNo: string | null;
  handoverPlace: string | null;
  deviceName: string | null;
  processor: string | null;
  installedRam: string | null;
  systemType: string | null;
  windowsDeviceId: string | null;
  windowsProductId: string | null;
  note: string | null;
};

export type DeviceImportPreviewRow = DeviceImportRow & {
  /** Resolved from `heldBy`, in the directory's own casing. Null when the row names nobody. */
  resolvedHolderHrId: string | null;
  resolvedHolderName: string | null;
  /** True when that holder has already left — allowed, and warned about. */
  holderHasLeft: boolean;
  errors: string[];
  warnings: string[];
  /** False when anything in `errors` would stop this row being written. */
  canImport: boolean;
};

export type DeviceImportPreview = {
  rows: DeviceImportPreviewRow[];
  summary: {
    total: number;
    canImport: number;
    withErrors: number;
    withWarnings: number;
    willBeIssued: number;
    heldByLeavers: number;
    withoutValue: number;
    totalValueEgp: number;
  };
};

export type DeviceImportOutcome = {
  rowNumber: number;
  assetTag: string;
  result: "imported" | "skipped" | "failed";
  /** Whether a custody record was opened too, not merely the device registered. */
  issuedTo: string | null;
  /**
   * The register row this import wrote, or null when it wrote none.
   *
   * Carried so the result can offer a hand-over against exactly the machines it just put in stock
   * (`handover-queue.ts`), rather than finding them again by asset tag.
   */
  deviceId: string | null;
  error: string | null;
};

export type DeviceImportResult = {
  imported: number;
  issued: number;
  skipped: number;
  failed: number;
  outcomes: DeviceImportOutcome[];
};

// ---------------------------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------------------------

/**
 * ExcelJS IMPLEMENTS `worksheet.dataValidations` but does not DECLARE it.
 *
 * The runtime API is real and is what every dropdown in this codebase uses; only the published
 * typings are missing it. Narrowed here at the single point of contact rather than casting each
 * call through `any` — an `any` would also silence a genuinely wrong `add()` argument, which is the
 * one thing worth keeping typed, since a malformed validation rule is a fragment Excel silently
 * "repairs" by dropping the whole dropdown.
 */
type DataValidationHost = {
  dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
};

function validationsOf(sheet: ExcelJS.Worksheet): DataValidationHost["dataValidations"] {
  return (sheet as unknown as DataValidationHost).dataValidations;
}

type AssignablePerson = { hrId: string; name: string; jobTitle: string | null; hasLeft: boolean };

/** `Name (HR-ID)` — human-readable per the owner's rule, and still unambiguous to parse back. */
export function personPickerLabel(person: AssignablePerson): string {
  return `${person.name} (${person.hrId})`;
}

async function loadPeopleForPicker(): Promise<AssignablePerson[]> {
  const supabase = getSupabaseAdmin();
  const data = await readAllRegisterRows<{
    hr_id: string;
    full_name: string | null;
    nickname: string | null;
    job_title: string | null;
    employment_status: string | null;
  }>(
    () =>
      supabase
        .from("employees")
        .select("hr_id,full_name,nickname,job_title,employment_status")
        .order("full_name", { ascending: true }),
    "hr_id",
  );

  return data
    .map((row) => ({
      hrId: String(row.hr_id),
      name: String(row.nickname || row.full_name || row.hr_id).trim(),
      jobTitle: row.job_title,
      hasLeft: LEAVER_STATUSES.has(String(row.employment_status ?? "").trim().toLowerCase()),
    }))
    .filter((person) => person.hrId.length > 0);
}

/**
 * The order the roster pre-fill walks people in.
 *
 * Field force first, because that is the half of the fleet nobody can see: a rep's tablet lives in
 * a car in another governorate, while an office laptop is in the building and can be looked at. The
 * ranking is by JOB TITLE TEXT rather than by a seat lookup on purpose — this is a stationery
 * ordering for a spreadsheet, not an org-structure claim, and reading the organogram for it would
 * couple a template to the seat model for no gain.
 */
function rosterRank(jobTitle: string | null): number {
  const title = String(jobTitle ?? "").toLowerCase();
  if (title.includes("medical rep")) return 0;
  if (title.includes("district")) return 1;
  if (title.includes("regional")) return 2;
  if (title.includes("national")) return 3;
  if (title.includes("manager") || title.includes("head")) return 4;
  return 5;
}

/**
 * The workbook the owner fills in.
 *
 * THE PEOPLE DROPDOWN IS BACKED BY A HIDDEN SHEET, not by an inline list. Excel caps a literal
 * validation formula at 255 characters — about eight names — so an inline list would silently
 * truncate to the first few employees and quietly make everybody else un-pickable. The lookup sheet
 * holds all of them and the validation points at its range.
 */
export type DeviceImportTemplateOptions = {
  /**
   * Put one row per CURRENT employee in, with the holder already filled.
   *
   * The blank template is the right thing when devices are being added a few at a time. This is the
   * right thing exactly once: when the fleet that is already out has to be entered, and the work is
   * "walk the building and the cars, and write down what each person is holding". Typing 180 names
   * to do that is the reason it would not get done.
   *
   * Leavers are NOT given rows — there are more of them than there are current staff, and a leaver
   * holding a device is a discovery rather than a starting assumption. They stay in the dropdown, so
   * one can be picked by hand the moment a device turns out to be with somebody who has gone.
   */
  prefillRoster?: boolean;
};

export async function generateDeviceImportTemplate(
  options: DeviceImportTemplateOptions = {},
): Promise<ArrayBuffer> {
  const people = await loadPeopleForPicker();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";

  const sheet = workbook.addWorksheet(SHEET_NAME, {
    views: [{ state: "frozen", ySplit: DEVICE_IMPORT_HEADER_ROW }],
  });
  sheet.columns = COLUMNS.map((column) => ({ width: column.width }));

  writeHouseMasthead(workbook, sheet, {
    columns: COLUMNS.length,
    provenance: [`Prepared ${currentCairoDateOnlyIso()}`, `${people.length} people to choose from`],
    subtitle: options.prefillRoster
      ? "One row per person, holder already filled. Add the asset tag and the serial or IMEI for whatever each one is holding, and leave the rest of the row alone — a row with nobody's device on it is ignored."
      : "One row per device. A serial number OR an IMEI is required on every row — it is what a police report, an operator and an insurer all ask for.",
    title: options.prefillRoster ? "Device Custody — Walk The Fleet" : "Device Custody — Bulk Import",
  });

  // The note row. This is where the examples live, INSTEAD of a filled sample row — see the header
  // of this file for why a sample row is a hazard in a register whose contents are evidence.
  const noteRow = sheet.getRow(DEVICE_IMPORT_NOTE_ROW);
  noteRow.height = 42;
  COLUMNS.forEach((column, index) => {
    const cell = noteRow.getCell(index + 1);
    cell.value = column.note;
    houseCalloutStyle(cell);
    cell.alignment = { vertical: "top", wrapText: true };
  });

  const headerRow = sheet.getRow(DEVICE_IMPORT_HEADER_ROW);
  headerRow.height = 28;
  COLUMNS.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    houseHeaderStyle(cell);
  });

  // The hidden sheet behind the people dropdown.
  const lookup = workbook.addWorksheet(LOOKUP_SHEET_NAME);
  lookup.getColumn(1).width = 40;
  people.forEach((person, index) => {
    lookup.getCell(index + 1, 1).value = personPickerLabel(person);
  });
  // `veryHidden` cannot be un-hidden from Excel's own sheet menu, which is deliberate: somebody
  // editing this list by hand would produce a dropdown that no longer matches the directory.
  lookup.state = "veryHidden";

  // Validation is applied over a generous row band so the dropdowns survive the owner pasting more
  // rows in than he first expected.
  const lastValidatedRow = DEVICE_IMPORT_FIRST_DATA_ROW + DEVICE_IMPORT_MAX_ROWS;
  COLUMNS.forEach((column, index) => {
    const letter = sheet.getColumn(index + 1).letter;
    const range = `${letter}${DEVICE_IMPORT_FIRST_DATA_ROW}:${letter}${lastValidatedRow}`;

    if (column.numFmt) {
      sheet.getColumn(index + 1).numFmt = column.numFmt;
    }

    if (column.options) {
      validationsOf(sheet).add(range, {
        type: "list",
        allowBlank: true,
        formulae: [`"${column.options.join(",")}"`],
        showErrorMessage: true,
        errorTitle: "Not one of the options",
        error: `Must be one of: ${column.options.join(", ")}`,
      });
      return;
    }

    if (column.key === "heldBy" && people.length > 0) {
      validationsOf(sheet).add(range, {
        type: "list",
        allowBlank: true,
        // Not `showErrorMessage`: an HR ID typed by hand is a legitimate answer this parser
        // accepts, and refusing it in Excel would make the sheet harder to fill than the form.
        formulae: [`'${LOOKUP_SHEET_NAME}'!$A$1:$A$${people.length}`],
        showErrorMessage: false,
      });
      return;
    }

    if (column.key === "estimatedValueEgp") {
      validationsOf(sheet).add(range, {
        type: "decimal",
        operator: "greaterThanOrEqual",
        formulae: [0],
        allowBlank: true,
        showErrorMessage: true,
        errorTitle: "Not a value",
        error: "An estimated value cannot be negative.",
      });
    }
  });

  /**
   * The rows.
   *
   * WITHOUT `prefillRoster` these are a dozen empty styled rows, so the sheet does not look broken
   * when it opens. Nothing carries a VALUE — an example row under the headers is a fictional device
   * waiting to be imported into a register whose worth is that its contents are evidence.
   *
   * WITH it, one row per current employee, and the ONLY cell written is the holder. The category is
   * deliberately left blank even though it could be guessed from a job title: the guess would be
   * wrong for anyone holding both a laptop and a tablet, and a wrong pre-filled category is harder
   * to notice than an empty one. The dropdown is right there.
   */
  const holderColumn = COLUMNS.findIndex((column) => column.key === "heldBy") + 1;
  const rosterRows = options.prefillRoster
    ? people
        .filter((person) => !person.hasLeft)
        .slice()
        .sort((left, right) => {
          const byRole = rosterRank(left.jobTitle) - rosterRank(right.jobTitle);
          return byRole !== 0 ? byRole : left.name.localeCompare(right.name);
        })
    : [];

  const rowCount = options.prefillRoster ? rosterRows.length : 12;
  for (let offset = 0; offset < rowCount; offset += 1) {
    const row = sheet.getRow(DEVICE_IMPORT_FIRST_DATA_ROW + offset);
    COLUMNS.forEach((_column, index) => {
      houseBodyStyle(row.getCell(index + 1), { size: 10, zebra: offset % 2 === 1 });
    });
    const person = rosterRows[offset];
    if (person) row.getCell(holderColumn).value = personPickerLabel(person);
  }

  return workbook.xlsx.writeBuffer() as unknown as Promise<ArrayBuffer>;
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const rich = value as { richText?: Array<{ text: string }>; text?: string; result?: unknown };
    if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text).join("").trim() || null;
    if (typeof rich.text === "string") return rich.text.trim() || null;
    if (rich.result !== undefined && rich.result !== null) return String(rich.result).trim() || null;
  }
  return null;
}

function cellNumber(value: ExcelJS.CellValue): number | null {
  const text = cellText(value);
  if (text === null) return null;
  // Strips thousands separators and stray currency, which is what a pasted column looks like.
  const parsed = Number(text.replace(/[,\s]/g, "").replace(/EGP/gi, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A date column, normalised to YYYY-MM-DD. Returns the raw text when it cannot be read as a date, so
 * the preview refuses the row by name.
 *
 * ONLY A REAL DATE CELL OR TYPED `YYYY-MM-DD` IS READ. Text such as "03/10/2026" used to go through
 * `new Date(text)`, which reads it month-first — 10 March, where an Egyptian sheet means 3 October —
 * and at the server's local midnight, which can land on the day before. A custody receipt's handover
 * date guessed wrong is worse than a row sent back with "Use YYYY-MM-DD".
 */
export function cellDate(value: ExcelJS.CellValue): string | null {
  if (value instanceof Date) {
    // DATE-ONLY on purpose. An Excel date cell is midnight in the reader's own zone; taking the UTC
    // parts is what stops "2026-09-01" becoming "2026-08-31" for anyone east of Greenwich.
    return value.toISOString().slice(0, 10);
  }
  const text = cellText(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return text;
}

/** `YYYY-MM-DD` that names a day on the calendar — "2026-02-30" is not one. */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Reads the uploaded workbook back into rows.
 *
 * MATCHED BY HEADER TEXT, NOT BY POSITION. A file that has been round-tripped through Excel, had a
 * column widened, or had one dragged elsewhere still parses; a file whose headers were renamed
 * fails loudly rather than reading the neighbouring column, which is the silent version of the
 * same problem and the one that puts a serial in the IMEI box.
 */
export async function parseDeviceImportFile(buffer: ArrayBuffer): Promise<DeviceImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = workbook.getWorksheet(SHEET_NAME) ?? workbook.worksheets[0];
  if (!sheet) throw new Error("That file has no sheets in it.");

  const headerRow = sheet.getRow(DEVICE_IMPORT_HEADER_ROW);
  const columnByKey = new Map<ColumnKey, number>();
  const seenHeaders: string[] = [];

  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const text = (cellText(cell.value) ?? "").toLowerCase();
    if (!text) return;
    seenHeaders.push(text);
    const match = COLUMNS.find((column) => column.header.toLowerCase() === text);
    if (match) columnByKey.set(match.key, columnNumber);
  });

  if (!columnByKey.has("assetTag") || !columnByKey.has("category")) {
    throw new Error(
      `That file does not look like the device import template — its row ${DEVICE_IMPORT_HEADER_ROW} ` +
        `has no "Asset tag *" and "Category *" headers. Download the template and fill that in.`,
    );
  }

  const read = (row: ExcelJS.Row, key: ColumnKey): ExcelJS.CellValue => {
    const columnNumber = columnByKey.get(key);
    return columnNumber ? row.getCell(columnNumber).value : null;
  };

  const rows: DeviceImportRow[] = [];
  for (let rowNumber = DEVICE_IMPORT_FIRST_DATA_ROW; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);

    const parsed: DeviceImportRow = {
      rowNumber,
      assetTag: cellText(read(row, "assetTag")),
      category: (cellText(read(row, "category")) ?? "").toLowerCase() || null,
      manufacturer: cellText(read(row, "manufacturer")),
      model: cellText(read(row, "model")),
      serialNumber: cellText(read(row, "serialNumber")),
      imei: cellText(read(row, "imei")),
      simNumber: cellText(read(row, "simNumber")),
      lineNumber: cellText(read(row, "lineNumber")),
      estimatedValueEgp: cellNumber(read(row, "estimatedValueEgp")),
      purchasedOn: cellDate(read(row, "purchasedOn")),
      heldBy: cellText(read(row, "heldBy")),
      issuedOn: cellDate(read(row, "issuedOn")),
      declarationNo: cellText(read(row, "declarationNo")),
      handoverPlace: cellText(read(row, "handoverPlace")),
      deviceName: cellText(read(row, "deviceName")),
      processor: cellText(read(row, "processor")),
      installedRam: cellText(read(row, "installedRam")),
      systemType: cellText(read(row, "systemType")),
      windowsDeviceId: cellText(read(row, "windowsDeviceId")),
      windowsProductId: cellText(read(row, "windowsProductId")),
      note: cellText(read(row, "note")),
    };

    /**
     * A row counts only when it carries at least one DEVICE field.
     *
     * THE HOLDER AND THE CATEGORY ARE NOT DEVICE FIELDS, and that distinction is what makes the
     * pre-filled roster template usable. That sheet puts a person on every row so the fleet can be
     * walked without typing 180 names; on the rows where the person turns out to hold nothing, the
     * holder is all that is left behind. Counting those would report a hundred "an asset tag is
     * required" errors against a file that was filled in correctly — which is worse than useless,
     * because it buries the handful of findings that are real.
     *
     * IT DOES NOT WEAKEN THE HALF-FILLED GUARD. A row carrying an asset tag but no serial and no
     * IMEI still counts, and is still refused by the identity rule; so is one carrying a serial but
     * no tag. What is skipped is only a row with no device on it at all.
     */
    const hasDeviceField = Boolean(
      parsed.assetTag ||
        parsed.serialNumber ||
        parsed.imei ||
        parsed.manufacturer ||
        parsed.model ||
        parsed.deviceName ||
        parsed.simNumber ||
        parsed.lineNumber ||
        parsed.estimatedValueEgp !== null ||
        parsed.purchasedOn ||
        parsed.note,
    );
    if (!hasDeviceField) continue;

    rows.push(parsed);
  }

  return rows;
}

// ---------------------------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------------------------

/** `Name (HR-ID)` or a bare HR ID. Returns the id part, untouched for casing. */
export function extractHrId(heldBy: string | null): string | null {
  const text = String(heldBy ?? "").trim();
  if (!text) return null;
  const bracketed = text.match(/\(([^()]+)\)\s*$/);
  return (bracketed ? bracketed[1] : text).trim() || null;
}

export type DirectoryEntry = { hrId: string; name: string; hasLeft: boolean };

async function loadDirectory(): Promise<Map<string, DirectoryEntry>> {
  const supabase = getSupabaseAdmin();
  const data = await readAllRegisterRows<{
    hr_id: string;
    full_name: string | null;
    nickname: string | null;
    employment_status: string | null;
  }>(() => supabase.from("employees").select("hr_id,full_name,nickname,employment_status"), "hr_id");

  const byKey = new Map<string, DirectoryEntry>();
  for (const row of data) {
    const status = String(row.employment_status ?? "").trim().toLowerCase();
    // Keyed LOWERED. hr_id is mixed case in this database, and an import matching it exactly would
    // reject "b-155" for a directory holding "B-155" — a rejection the person filling in the sheet
    // could never explain.
    byKey.set(String(row.hr_id).toLowerCase(), {
      hrId: String(row.hr_id),
      name: String(row.nickname || row.full_name || row.hr_id).trim(),
      hasLeft: LEAVER_STATUSES.has(status),
    });
  }
  return byKey;
}

/** What the register already holds, so the preview can name a collision before it happens. */
async function loadExistingKeys(): Promise<{ tags: Set<string>; serials: Set<string>; imeis: Set<string> }> {
  const supabase = getSupabaseAdmin();
  const data = await readAllRegisterRows<{
    asset_tag: string | null;
    serial_number: string | null;
    imei: string | null;
  }>(() => supabase.from("company_devices").select("asset_tag,serial_number,imei"), "id");

  const tags = new Set<string>();
  const serials = new Set<string>();
  const imeis = new Set<string>();
  for (const row of data) {
    if (row.asset_tag) tags.add(row.asset_tag.trim().toLowerCase());
    if (row.serial_number) serials.add(row.serial_number.trim().toLowerCase());
    if (row.imei) imeis.add(row.imei.trim().toLowerCase());
  }
  return { tags, serials, imeis };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function buildDeviceImportPreview(rows: DeviceImportRow[]): Promise<DeviceImportPreview> {
  const [directory, existing] = await Promise.all([loadDirectory(), loadExistingKeys()]);
  return buildDeviceImportPreviewFrom(rows, directory, existing);
}

export type ExistingRegisterKeys = { tags: Set<string>; serials: Set<string>; imeis: Set<string> };

/**
 * Every validation rule, as a PURE function.
 *
 * Split from `buildDeviceImportPreview` so the rules can be tested without a database — and that is
 * not merely convenient here, it is required: this suite runs with PRODUCTION credentials
 * (AGENTS.md 2.1), so a test that reached the real directory to check a duplicate-detection rule
 * would be reading live employee records to assert something about arithmetic.
 *
 * Same reasoning as `computeDeviceHolderFlags` in the service: the rules that decide what gets
 * written are the ones worth pinning, and they only stay pinnable if nothing else has to be alive.
 */
export function buildDeviceImportPreviewFrom(
  rows: DeviceImportRow[],
  directory: Map<string, DirectoryEntry>,
  existing: ExistingRegisterKeys,
): DeviceImportPreview {
  // Collisions WITHIN the file, which the database cannot see until the second row hits it. Counted
  // rather than flagged on sight, so both halves of a duplicate pair are reported — telling
  // somebody row 40 is a duplicate without telling them of what is half an answer.
  //
  // SERIALS AND IMEIS ARE COMPARED ON THEIR LETTERS AND DIGITS (`serialDuplicateKey`,
  // `imeiDuplicateKey`), not as typed. Compared as text, "HA255LN1" and "ha255-ln1", or an IMEI typed
  // with dashes and the same IMEI without, passed both this check and the database's unique indexes
  // (which see `lower(text)`), and one machine entered the register twice.
  const tagKey = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase() || null;
  const tagCounts = new Map<string, number>();
  const serialCounts = new Map<string, number>();
  const imeiCounts = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string | null) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const row of rows) {
    bump(tagCounts, tagKey(row.assetTag));
    bump(serialCounts, serialDuplicateKey(row.serialNumber));
    bump(imeiCounts, imeiDuplicateKey(row.imei));
  }
  const existingSerials = new Set(
    [...existing.serials].map((value) => serialDuplicateKey(value)).filter((key): key is string => Boolean(key)),
  );
  const existingImeis = new Set(
    [...existing.imeis].map((value) => imeiDuplicateKey(value)).filter((key): key is string => Boolean(key)),
  );

  const previewRows: DeviceImportPreviewRow[] = rows.map((row) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    const tag = String(row.assetTag ?? "").trim();
    const serial = String(row.serialNumber ?? "").trim();
    const imei = String(row.imei ?? "").trim();

    if (!tag) errors.push("An asset tag is required — it is how a person refers to this device out loud.");
    if (!row.category) {
      errors.push("A category is required.");
    } else if (!isDeviceCategory(row.category)) {
      errors.push(`"${row.category}" is not a category. Use one of: ${DEVICE_CATEGORY_OPTIONS.join(", ")}.`);
    }

    // The identity rule. The database CHECK is the real guard; this is the readable version of it.
    if (!serial && !imei) {
      errors.push(
        "A serial number or an IMEI is required. Without one this device cannot be identified to " +
          "the police, to an operator or to an insurer — which is what the register is for.",
      );
    }

    const serialKey = serialDuplicateKey(serial);
    const imeiKey = imeiDuplicateKey(imei);
    if (tag && (tagCounts.get(tag.toLowerCase()) ?? 0) > 1) {
      errors.push(`The asset tag "${tag}" is used on more than one row of this file.`);
    }
    if (tag && existing.tags.has(tag.toLowerCase())) {
      errors.push(`The asset tag "${tag}" is already in the register.`);
    }
    if (serialKey && (serialCounts.get(serialKey) ?? 0) > 1) {
      errors.push(`The serial "${serial}" is used on more than one row of this file.`);
    }
    if (serialKey && existingSerials.has(serialKey)) {
      errors.push(`The serial "${serial}" is already in the register.`);
    }
    if (imeiKey && (imeiCounts.get(imeiKey) ?? 0) > 1) {
      errors.push(`The IMEI "${imei}" is used on more than one row of this file.`);
    }
    if (imeiKey && existingImeis.has(imeiKey)) {
      errors.push(`The IMEI "${imei}" is already in the register.`);
    }

    if (row.estimatedValueEgp !== null && row.estimatedValueEgp < 0) {
      errors.push("An estimated value cannot be negative.");
    }
    if (row.estimatedValueEgp === null) {
      warnings.push(
        "No estimated value. البند (10) caps any recovery at the figure on the receipt, so nothing " +
          "can be recovered against this device if it is not returned.",
      );
    }

    for (const [label, value] of [
      ["Purchased on", row.purchasedOn],
      ["Issued on", row.issuedOn],
    ] as const) {
      if (value && !isCalendarDate(value)) {
        errors.push(`${label} "${value}" is not a date. Use YYYY-MM-DD.`);
      }
    }

    let resolvedHolderHrId: string | null = null;
    let resolvedHolderName: string | null = null;
    let holderHasLeft = false;

    const requestedHolder = extractHrId(row.heldBy);
    if (requestedHolder) {
      const entry = directory.get(requestedHolder.toLowerCase());
      if (!entry) {
        errors.push(`"${row.heldBy}" does not match anybody in the directory.`);
      } else {
        resolvedHolderHrId = entry.hrId;
        resolvedHolderName = entry.name;
        holderHasLeft = entry.hasLeft;
        if (entry.hasLeft) {
          // ALLOWED. This is the most valuable row in the file — a device out with somebody who has
          // already left is the exposure the register exists to surface.
          warnings.push(
            `${entry.name} has already left. The device will import and be flagged immediately as ` +
              `held by a leaver, which is almost certainly why you are entering it.`,
          );
        }
        if (!row.issuedOn) {
          warnings.push("No issue date, so today's date will be recorded as the handover date.");
        }
      }
    } else if (row.issuedOn || row.declarationNo || row.handoverPlace) {
      warnings.push(
        "This row has handover details but names nobody, so the device will be registered as in " +
          "stock and those details will not be recorded.",
      );
    }

    return {
      ...row,
      resolvedHolderHrId,
      resolvedHolderName,
      holderHasLeft,
      errors,
      warnings,
      canImport: errors.length === 0,
    };
  });

  const importable = previewRows.filter((row) => row.canImport);
  return {
    rows: previewRows,
    summary: {
      total: previewRows.length,
      canImport: importable.length,
      withErrors: previewRows.filter((row) => row.errors.length > 0).length,
      withWarnings: previewRows.filter((row) => row.warnings.length > 0).length,
      willBeIssued: importable.filter((row) => row.resolvedHolderHrId).length,
      heldByLeavers: importable.filter((row) => row.holderHasLeft).length,
      withoutValue: importable.filter((row) => row.estimatedValueEgp === null).length,
      totalValueEgp: importable.reduce((sum, row) => sum + (row.estimatedValueEgp ?? 0), 0),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

/**
 * Writes the importable rows, one at a time, and reports what happened to each.
 *
 * FOUR DECISIONS, each the difference between an import that is safe and one that loses work:
 *
 * 1. **It never throws for a single row.** A failure becomes a `failed` outcome carrying its
 *    message and the loop continues. One bad row aborting the batch leaves the caller unable to
 *    tell which of the other 84 were written.
 * 2. **It re-runs the preview first and imports only what that says it can.** The preview is not
 *    advice: a file can be uploaded twice, and the second pass must skip what the first wrote
 *    rather than collide with it. `skipped` is a first-class outcome, never a silent nothing.
 * 3. **It delegates to `createDevice` and `issueDevice`.** Every row therefore passes the same
 *    guards and writes its OWN audit row — the per-device trail is the point of the register, and
 *    one opaque "imported 85" would destroy it.
 * 4. **A device is registered before it is issued, in that order.** `phx_device_issue` copies the
 *    device's estimated value onto the custody record and freezes it there (البند 9), so the value
 *    must already be on the device when the handover is recorded. Reversing this would freeze null.
 */
export async function executeDeviceImport(
  rows: DeviceImportRow[],
  actor: string,
): Promise<DeviceImportResult> {
  const preview = await buildDeviceImportPreview(rows);
  const outcomes: DeviceImportOutcome[] = [];

  for (const row of preview.rows) {
    const assetTag = String(row.assetTag ?? "").trim() || `(row ${row.rowNumber})`;

    if (!row.canImport) {
      outcomes.push({
        rowNumber: row.rowNumber,
        assetTag,
        result: "skipped",
        issuedTo: null,
        deviceId: null,
        error: row.errors[0] ?? "This row was not importable.",
      });
      continue;
    }

    try {
      const deviceId = await createDevice(
        {
          assetTag,
          category: row.category as DeviceCategory,
          manufacturer: row.manufacturer,
          model: row.model,
          serialNumber: row.serialNumber,
          imei: row.imei,
          deviceName: row.deviceName,
          processor: row.processor,
          installedRam: row.installedRam,
          systemType: row.systemType,
          windowsDeviceId: row.windowsDeviceId,
          windowsProductId: row.windowsProductId,
          simNumber: row.simNumber,
          lineNumber: row.lineNumber,
          estimatedValueEgp: row.estimatedValueEgp,
          purchasedOn: row.purchasedOn,
          note: row.note,
        },
        actor,
      );

      let issuedTo: string | null = null;
      if (row.resolvedHolderHrId) {
        try {
          await issueDevice(
            {
              deviceId,
              employeeHrId: row.resolvedHolderHrId,
              declarationNo: row.declarationNo,
              handoverPlace: row.handoverPlace,
              issuedOn: row.issuedOn,
            },
            actor,
            // The one door that may name a leaver: this records custody that ALREADY exists, and a
            // device still out with somebody who has gone is what the register exists to surface.
            { allowLeaver: true },
          );
          issuedTo = row.resolvedHolderName ?? row.resolvedHolderHrId;
        } catch (issueError) {
          // The DEVICE landed; only the handover did not. Reported as a partial rather than a
          // failure, because saying "failed" would send somebody to re-enter a device that is
          // already in the register — and the second attempt would then collide on the asset tag.
          outcomes.push({
            rowNumber: row.rowNumber,
            assetTag,
            result: "imported",
            issuedTo: null,
            deviceId,
            error: `Registered, but the handover was not recorded: ${deviceErrorMessage(issueError)}`,
          });
          continue;
        }
      }

      outcomes.push({ rowNumber: row.rowNumber, assetTag, result: "imported", issuedTo, deviceId, error: null });
    } catch (error) {
      outcomes.push({
        rowNumber: row.rowNumber,
        assetTag,
        result: "failed",
        issuedTo: null,
        deviceId: null,
        error: deviceErrorMessage(error),
      });
    }
  }

  return {
    imported: outcomes.filter((outcome) => outcome.result === "imported").length,
    issued: outcomes.filter((outcome) => outcome.issuedTo !== null).length,
    skipped: outcomes.filter((outcome) => outcome.result === "skipped").length,
    failed: outcomes.filter((outcome) => outcome.result === "failed").length,
    outcomes,
  };
}
