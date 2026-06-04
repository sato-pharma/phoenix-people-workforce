// Recruitment / ATS — blank candidate bulk-import template (.xlsx).
// Header row matches candidateImportHeaders so importCandidatesWorkbook parses it.

import ExcelJS from "exceljs";

import { systemDocuments } from "@/config/system-settings";
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
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });

  sheet.autoFilter = {
    from: { column: 1, row: 1 },
    to: { column: candidateImportHeaders.length, row: 1 },
  };

  return workbook;
}
