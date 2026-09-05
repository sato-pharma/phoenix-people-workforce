// Recruitment / ATS — blank candidate bulk-import template (.xlsx).
// Header row matches candidateImportHeaders so importCandidatesWorkbook parses it.

import ExcelJS from "exceljs";

import { systemDocuments } from "@/config/system-settings";
import { HOUSE_XLSX_COLORS, HOUSE_XLSX_FONT } from "@/lib/export/house-xlsx-palette";
import { candidateImportHeaders } from "@/lib/recruitment/candidates";

export async function generateCandidateImportTemplateWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Candidates", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = candidateImportHeaders.map((header) => ({
    header,
    key: header,
    width: header === "Full Name" || header === "Email" || header === "Current Employer" ? 28 : 20,
  }));

  const headerRow = sheet.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    // Deep type under a Brand Blue rule — SATO-DIS-2026-01 v1.0. This was a filled slate band; the
    // ink rule carries a header on the rule beneath it instead.
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: HOUSE_XLSX_FONT, size: 10 };
    cell.border = {
      bottom: { color: { argb: HOUSE_XLSX_COLORS.blue }, style: "medium" },
      top: { color: { argb: HOUSE_XLSX_COLORS.hair }, style: "thin" },
    };
    cell.alignment = { horizontal: "left", indent: 1, vertical: "bottom", wrapText: true };
  });

  sheet.autoFilter = {
    from: { column: 1, row: 1 },
    to: { column: candidateImportHeaders.length, row: 1 },
  };

  return workbook;
}
