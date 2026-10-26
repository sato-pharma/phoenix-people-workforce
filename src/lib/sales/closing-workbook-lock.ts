import type ExcelJS from "exceljs";
import type JSZip from "jszip";

import { resolveSheetParts } from "./closing-executive-look";

// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSING DOWNLOADS ARE NOT PROTECTED (owner, 2026-10-26: "make the exported monthly closing
// xlsx all its types download non protected"). This reverses his 2026-10-13 lock, which put sheet
// protection on every tab of every closing workbook.
//
// Every worksheet of every closing workbook — the normal export, the employee-portal and
// details-only builds, the Performance Review pack, the rep ranking and rep-product workbooks, and
// the premium engine — leaves the server with NO sheet protection and NO workbook protection. Each
// builder still calls one of the two functions below as its last pass, so the rule lives in one
// module: the premium engine's template is the owner's own .xlsm, and anything protected inside it
// is stripped here rather than trusted to be absent.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clear sheet protection from every worksheet of an ExcelJS-built closing workbook, hidden sheets
 * included. Returns the number of sheets left open.
 */
export function unprotectExcelWorkbook(workbook: ExcelJS.Workbook): number {
  for (const sheet of workbook.worksheets) {
    (sheet as unknown as { sheetProtection: unknown }).sheetProtection = null;
  }
  return workbook.worksheets.length;
}

/**
 * Strip every `<sheetProtection>` from the premium engine's sheet parts and any
 * `<workbookProtection>` from its workbook part, in place in the zip. ExcelJS cannot be used here --
 * it drops pivot tables, slicers and VBA -- so the elements are removed straight from the XML.
 * Returns the names of the sheets visited.
 */
export async function unprotectEngineWorkbook(
  zip: JSZip,
  options: { sheetParts?: Map<string, string> } = {},
): Promise<string[]> {
  const parts = options.sheetParts ?? (await resolveSheetParts(zip));
  const open: string[] = [];
  for (const [sheetName, part] of parts) {
    const file = zip.file(part);
    if (!file) continue;
    const xml = await file.async("string");
    const stripped = xml.replace(/<sheetProtection\b[^>]*?\/>/g, "");
    if (stripped !== xml) zip.file(part, stripped);
    open.push(sheetName);
  }
  const workbookFile = zip.file("xl/workbook.xml");
  if (workbookFile) {
    const xml = await workbookFile.async("string");
    const stripped = xml.replace(/<workbookProtection\b[^>]*?\/>/g, "");
    if (stripped !== xml) zip.file("xl/workbook.xml", stripped);
  }
  return open;
}
