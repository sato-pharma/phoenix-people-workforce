/**
 * Probe a Weekly Sales distributor workbook: print every sheet, and for each sheet dump the first
 * few rows cell-by-cell with their 1-based column index. Use this to discover the REAL column
 * layout of a distributor export before aligning the parser adapter in
 * src/lib/sales/weekly/parser.ts.
 *
 * Usage (this repo strips types with Node, no tsx):
 *   node --experimental-strip-types --experimental-specifier-resolution=node \
 *     scripts/probe-weekly-xlsx.ts "C:\path\to\IbnSinaSato.xlsx"
 *   node --experimental-strip-types --experimental-specifier-resolution=node \
 *     scripts/probe-weekly-xlsx.ts "C:\path\to\file.xlsx" "SheetName" 8
 *
 * Args: <path> [sheetNameFilter] [maxRows=6]
 */
import ExcelJS from "exceljs";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "probe-weekly-xlsx",
  entry: import.meta.url,
  known: [],
});

function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  const value = cell.value as unknown;
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  // UTC on purpose, and NOT a "now" — this is a DATE-ONLY cell out of the workbook. The probe
  // exists to show what src/lib/sales/weekly/parser.ts will see, and the parser renders such a
  // cell with this exact expression (parser.ts:51/89/93); rendering it in Cairo here would make
  // the probe disagree with the parser it is used to align. Change both together or neither.
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const obj = value as { result?: unknown; text?: unknown; richText?: { text?: string }[] };
    if (obj.richText) return obj.richText.map((part) => part.text).join("").trim();
    if (obj.result != null) return String(obj.result).trim();
    if (obj.text != null) return String(obj.text).trim();
  }
  return String(value).trim();
}

async function main() {
  const [path, sheetFilter, maxRowsArg] = process.argv.slice(2);
  if (!path) {
    console.error('Usage: pnpm dlx tsx scripts/probe-weekly-xlsx.ts "<path.xlsx>" [sheetNameFilter] [maxRows]');
    process.exit(1);
  }
  const maxRows = Number(maxRowsArg) || 6;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);

  console.log(`\nFILE: ${path}`);
  console.log(`SHEETS (${wb.worksheets.length}): ${wb.worksheets.map((s) => `"${s.name}" [${s.rowCount}r x ${s.columnCount}c]`).join(", ")}\n`);

  for (const sheet of wb.worksheets) {
    if (sheetFilter && !sheet.name.toLowerCase().includes(sheetFilter.toLowerCase())) continue;
    console.log("═".repeat(100));
    console.log(`SHEET: "${sheet.name}"  (${sheet.rowCount} rows x ${sheet.columnCount} cols)`);
    console.log("═".repeat(100));
    const limit = Math.min(maxRows, sheet.rowCount);
    for (let r = 1; r <= limit; r += 1) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= sheet.columnCount; c += 1) {
        const text = cellText(row.getCell(c));
        if (text) cells.push(`c${c}=${JSON.stringify(text)}`);
      }
      console.log(`row ${r}: ${cells.join("  ") || "(empty)"}`);
    }
    console.log("");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
