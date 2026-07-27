import ExcelJS from "exceljs";

import {
  MASTER_DEFINITIONS,
  type DisplayLookup,
  type MasterColumnType,
  type MasterDefinition,
  type MasterKey,
  type MasterRowRecord,
} from "./definitions";

// Phoenix visual language (mirrors src/lib/export/table-workbook.ts): black
// header band with orange title, thin orange grid, zebra rows. Adds Excel cell
// + sheet protection so locked (key/name) columns cannot be edited, and renders
// parent-name columns as live VLOOKUP formulas backed by hidden reference
// sheets (typing a code auto-fills the name on the next recalc).
const BLACK = "FF000000";
const ORANGE = "FFF97316";
const ORANGE_SOFT = "FFFFF7ED";
const ORANGE_LINE = "FFF8B56B";
const WHITE = "FFFFFFFF";
const SLATE = "FF334155";
const LOCKED_FILL = "FFF1F5F9";
const COMPUTED_FILL = "FFEFF6FF";

// Blank unlocked rows appended below the data so new entities can be added
// while existing identity cells stay protected. Row insertion is also enabled.
const SPARE_ROWS = 200;

type RenderColumn = {
  key: string;
  label: string;
  locked: boolean;
  lookup?: DisplayLookup;
  type: MasterColumnType;
};

type ReferenceData = Partial<Record<MasterKey, MasterRowRecord[]>>;

function gridBorder(): ExcelJS.Borders {
  const side = { style: "thin" as const, color: { argb: ORANGE_LINE } };
  return { top: side, left: side, bottom: side, right: side } as ExcelJS.Borders;
}

function sanitizeSheetName(name: string) {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || "Master").slice(0, 31);
}

function columnLetter(index: number) {
  let value = index;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function cellText(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) return "";
  return value;
}

/**
 * Builds the hidden lookup sheets (one per referenced parent master) and
 * returns, per master, the sheet name and ordered columns so VLOOKUP indexes
 * can be computed.
 */
function buildReferenceSheets(
  workbook: ExcelJS.Workbook,
  lookups: DisplayLookup[],
  referenceData: ReferenceData,
) {
  const neededByMaster = new Map<MasterKey, Set<string>>();
  for (const lookup of lookups) {
    if (!neededByMaster.has(lookup.lookupMaster)) neededByMaster.set(lookup.lookupMaster, new Set());
    neededByMaster.get(lookup.lookupMaster)?.add(lookup.lookupColumn);
  }

  const info = new Map<MasterKey, { columns: string[]; sheetName: string }>();
  for (const [master, needed] of neededByMaster) {
    const rows = referenceData[master];
    if (!rows) continue;
    const keyColumn = MASTER_DEFINITIONS[master].keyColumn;
    const columns = [keyColumn, ...[...needed].filter((column) => column !== keyColumn)];
    const sheetName = `_ref_${master}`.slice(0, 31);
    const sheet = workbook.addWorksheet(sheetName, { state: "veryHidden" });

    const header = sheet.getRow(1);
    columns.forEach((column, index) => {
      header.getCell(index + 1).value = column;
    });
    rows.forEach((row, rowIndex) => {
      const excelRow = sheet.getRow(rowIndex + 2);
      columns.forEach((column, index) => {
        excelRow.getCell(index + 1).value = cellText(row[column]);
      });
    });

    info.set(master, { columns, sheetName });
  }
  return info;
}

/** Builds a protected, Phoenix-styled workbook pre-populated with the rows. */
export async function buildMasterWorkbook(
  def: MasterDefinition,
  rows: MasterRowRecord[],
  referenceData: ReferenceData = {},
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const renderColumns: RenderColumn[] = [
    ...def.columns.map((column) => ({ key: column.key, label: column.label, locked: column.locked, type: column.type })),
    ...def.displayLookups.map((lookup) => ({ key: lookup.key, label: lookup.label, locked: true, lookup, type: lookup.type })),
  ];
  const columnIndexByKey = new Map(renderColumns.map((column, index) => [column.key, index + 1]));

  const sheet = workbook.addWorksheet(sanitizeSheetName(def.sheetName), {
    views: [{ state: "frozen", ySplit: 3 }],
  });
  const referenceInfo = buildReferenceSheets(workbook, def.displayLookups, referenceData);

  const colCount = Math.max(1, renderColumns.length);
  const editableLabels = def.columns.filter((column) => !column.locked).map((column) => column.label);

  // Row 1 — title band (black, white title, orange bottom-border accent)
  sheet.mergeCells(1, 1, 1, colCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = def.title;
  titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: WHITE } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  titleCell.border = { bottom: { style: "medium", color: { argb: ORANGE } } };
  titleCell.protection = { locked: true };
  sheet.getRow(1).height = 36;

  // Row 2 — subtitle band
  sheet.mergeCells(2, 1, 2, colCount);
  const subCell = sheet.getCell(2, 1);
  subCell.value = editableLabels.length > 0
    ? `Editable: ${editableLabels.join(", ")}. Name columns auto-fill from codes; all other columns are locked. Exported ${new Date().toLocaleString("en-GB")}.`
    : `All columns are locked (add new rows only). Exported ${new Date().toLocaleString("en-GB")}.`;
  subCell.font = { name: "Calibri", size: 10, italic: true, color: { argb: WHITE } };
  subCell.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: true };
  subCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  subCell.protection = { locked: true };
  sheet.getRow(2).height = 18;

  // Row 3 — header
  const headerRow = sheet.getRow(3);
  renderColumns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.lookup ? `${column.label} (auto)` : column.label;
    cell.font = { name: "Calibri", size: 11.5, bold: true, color: { argb: WHITE } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
    cell.border = gridBorder();
    cell.protection = { locked: true };
  });
  headerRow.height = 22;

  // Data rows
  const firstDataRow = 4;
  rows.forEach((row, rowIndex) => {
    const rowNumber = firstDataRow + rowIndex;
    const excelRow = sheet.getRow(rowNumber);
    renderColumns.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1);
      const lookup = column.lookup;
      const reference = lookup ? referenceInfo.get(lookup.lookupMaster) : undefined;

      if (lookup && reference) {
        const lookupIndex = reference.columns.indexOf(lookup.lookupColumn) + 1;
        const codeIndex = columnIndexByKey.get(lookup.viaCodeColumn);
        const lastLetter = columnLetter(reference.columns.length);
        const codeLetter = codeIndex ? columnLetter(codeIndex) : "A";
        cell.value = {
          formula: `IFERROR(VLOOKUP(${codeLetter}${rowNumber},'${reference.sheetName}'!$A:$${lastLetter},${lookupIndex},FALSE),"")`,
          result: cellText(row[column.key]),
        };
      } else {
        cell.value = cellText(row[column.key]);
      }

      cell.font = { name: "Calibri", size: 10.5, color: { argb: SLATE } };
      cell.alignment = {
        vertical: "middle",
        horizontal: column.type === "number" || column.type === "percent" ? "right" : "left",
        wrapText: false,
      };
      cell.border = gridBorder();
      if (column.type === "number") cell.numFmt = "#,##0.00";
      // A real Excel percent format over the stored fraction: 0.0341 shows as "3.41%", and anything
      // the owner types back into the cell ("3.41" or "3.41%") is stored by Excel as 0.0341 — so the
      // round-trip preserves the fraction convention without asking them to think in fractions.
      if (column.type === "percent") cell.numFmt = "0.00%";
      cell.protection = { locked: column.locked };
      if (column.lookup) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COMPUTED_FILL } };
      } else if (column.locked) {
        if (rowIndex % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LOCKED_FILL } };
      } else {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE_SOFT } };
      }
    });
  });

  // Spare append rows — fully UNLOCKED so new entities (e.g. a new brick / block
  // / area) can be added even while existing key/name cells stay protected. The
  // auto (name) columns keep their VLOOKUP formula so typing a code still
  // auto-fills the name on a new row.
  const firstSpareRow = firstDataRow + rows.length;
  for (let spareIndex = 0; spareIndex < SPARE_ROWS; spareIndex += 1) {
    const rowNumber = firstSpareRow + spareIndex;
    const excelRow = sheet.getRow(rowNumber);
    renderColumns.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1);
      const lookup = column.lookup;
      const reference = lookup ? referenceInfo.get(lookup.lookupMaster) : undefined;

      if (lookup && reference) {
        const lookupIndex = reference.columns.indexOf(lookup.lookupColumn) + 1;
        const codeIndex = columnIndexByKey.get(lookup.viaCodeColumn);
        const lastLetter = columnLetter(reference.columns.length);
        const codeLetter = codeIndex ? columnLetter(codeIndex) : "A";
        cell.value = {
          formula: `IFERROR(VLOOKUP(${codeLetter}${rowNumber},'${reference.sheetName}'!$A:$${lastLetter},${lookupIndex},FALSE),"")`,
          result: "",
        };
        cell.protection = { locked: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COMPUTED_FILL } };
      } else {
        // Every editable AND identity (code/name) cell on a NEW row is writable.
        cell.protection = { locked: false };
      }
      cell.font = { name: "Calibri", size: 10.5, color: { argb: SLATE } };
      cell.alignment = { vertical: "middle", horizontal: column.type === "number" || column.type === "percent" ? "right" : "left" };
      cell.border = gridBorder();
      if (column.type === "number") cell.numFmt = "#,##0.00";
      // A real Excel percent format over the stored fraction: 0.0341 shows as "3.41%", and anything
      // the owner types back into the cell ("3.41" or "3.41%") is stored by Excel as 0.0341 — so the
      // round-trip preserves the fraction convention without asking them to think in fractions.
      if (column.type === "percent") cell.numFmt = "0.00%";
    });
  }

  // Column widths
  renderColumns.forEach((column, index) => {
    const longest = rows.reduce((max, row) => {
      const value = row[column.key];
      return Math.max(max, value === null || value === undefined ? 0 : String(value).length);
    }, column.label.length + (column.lookup ? 7 : 0));
    sheet.getColumn(index + 1).width = Math.max(14, Math.min(46, longest + 4));
  });

  // Protect ONLY the locked cells (existing key/name + auto formulas). Editable
  // cells and the blank spare rows stay writable, and row insertion is allowed
  // so new bricks/blocks/areas can be added.
  await sheet.protect("", {
    autoFilter: true,
    formatCells: false,
    formatColumns: true,
    formatRows: true,
    insertRows: true,
    selectLockedCells: true,
    selectUnlockedCells: true,
    sort: true,
  });

  return workbook.xlsx.writeBuffer();
}
