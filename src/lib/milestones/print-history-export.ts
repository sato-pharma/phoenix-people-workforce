// The milestone print history as an .xlsx — who was congratulated, with which card, when, by whom.
//
// A plain internal operations report, the same kind as the attendance summaries: a clean data sheet,
// not a company-facing document, so it does not carry the SATO-DIS house identity (which is for
// documents that go OUT). Names, never codes (AGENTS.md §4); the print time is Cairo local.

import ExcelJS from "exceljs";

import { systemDocuments } from "@/config/system-settings";

import type { MilestonePrintHistoryEntry } from "./service";

const COLUMNS: Array<{ header: string; width: number; value: (entry: MilestonePrintHistoryEntry) => string }> = [
  { header: "Printed (Cairo)", width: 20, value: (entry) => entry.printedAt },
  { header: "Employee", width: 30, value: (entry) => entry.subjectName },
  { header: "Occasion", width: 22, value: (entry) => entry.occasion },
  { header: "Milestone date", width: 22, value: (entry) => entry.milestoneOn },
  { header: "Format", width: 10, value: (entry) => entry.format },
  { header: "Photo", width: 12, value: (entry) => entry.photoSource },
  { header: "Printed by", width: 26, value: (entry) => entry.actorName },
];

/**
 * Build the print-history workbook. Pure — hand it the shaped entries and it returns the bytes, so
 * the route stays a thin read-then-serve and this is checkable without a database.
 */
export async function buildMilestonePrintHistoryWorkbook(
  entries: readonly MilestonePrintHistoryEntry[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = systemDocuments.workbookCreator;
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet("Milestone prints", {
    views: [{ showGridLines: false, state: "frozen", ySplit: 1 }],
  });
  sheet.columns = COLUMNS.map((column) => ({ header: column.header, width: column.width }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };

  for (const entry of entries) {
    sheet.addRow(COLUMNS.map((column) => column.value(entry)));
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** The download name — names, never codes; ISO dates so it sorts on disk. */
export function milestonePrintHistoryFileName(fromIso: string, toIso: string): string {
  return `milestone-prints-${fromIso}-to-${toIso}.xlsx`;
}
