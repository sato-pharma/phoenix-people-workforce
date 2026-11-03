import ExcelJS from "exceljs";

import { cairoDateTime, cairoDateTimeSortable, utcDate } from "@/lib/format/cairo-datetime";
import type { ListCheckBoard } from "@/lib/marketing-requests/crm-list-check-board";

/** His audit sheet's colours (owner, 2026-10-27): dark blue is customer validation, light blue doctor validation. */
const MARKETING_FILL = "FF0A527D";
const REP_LIST_FILL = "FF1482C2";

/**
 * The board as a sheet, built from the same object the page renders so the two can never disagree. His
 * layout (2026-10-27, "make it way easier"): the marketing name beside the rep-list name, then the two
 * areas, then what follows. Money and counts stay numeric so the columns still sum.
 */
export async function buildListCheckWorkbook(board: ListCheckBoard): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const info = workbook.addWorksheet("Report Info");
  info.columns = [
    { header: "Field", key: "field", width: 34 },
    { header: "Value", key: "value", width: 60 },
  ];
  info.addRows([
    { field: "Report", value: "Marketing doctor-list check" },
    { field: "Generated", value: `${cairoDateTime(board.generatedAtIso)} Cairo` },
    { field: "Customers", value: board.totals.customers },
    { field: "On a rep's list", value: board.totals.onListCustomers },
    { field: "Waiting on a person", value: board.totals.openChecks },
    { field: "Approved cost (EGP)", value: board.totals.approvedCost },
    { field: "Approved cost not confirmed on a list (EGP)", value: board.totals.approvedCostOffList },
    { field: "Money means", value: "Estimated cost on approved requests, never sales" },
  ]);

  const sheet = workbook.addWorksheet("List Check");
  const columns: Array<{ header: string; key: string; tint?: string; width: number }> = [
    { header: "Marketing Name", key: "customerName", tint: MARKETING_FILL, width: 32 },
    { header: "Rep List Name", key: "matchedName", tint: REP_LIST_FILL, width: 32 },
    { header: "Marketing Area", key: "marketingAreaName", tint: MARKETING_FILL, width: 22 },
    { header: "Rep List Area", key: "listAreaName", tint: REP_LIST_FILL, width: 22 },
    { header: "Metres Apart", key: "metresApart", width: 13 },
    { header: "Line", key: "lineName", width: 16 },
    { header: "List", key: "listType", width: 8 },
    { header: "Rep", key: "repNames", width: 30 },
    { header: "State", key: "stateLabel", width: 22 },
    { header: "Why", key: "reason", width: 60 },
    { header: "Looks Like a Nursery", key: "nursery", width: 13 },
    { header: "Approved Requests", key: "approvedRequests", width: 12 },
    { header: "Approved Cost (EGP)", key: "approvedCost", width: 14 },
    { header: "Requester", key: "requesterNames", width: 30 },
    { header: "First Pay Date", key: "firstPayDate", width: 14 },
    { header: "Visits Since Pay Date", key: "visitsSincePay", width: 12 },
    { header: "Last Visit", key: "lastVisitDate", width: 14 },
    ...(board.showObjections ? [{ header: "Latest Objection", key: "latestObjection", width: 34 }] : []),
    { header: "Decided By", key: "decidedByName", width: 26 },
    { header: "Decided (Cairo)", key: "decidedAt", width: 22 },
  ];
  sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  sheet.addRows(
    board.rows.map((row) => ({
      approvedCost: Math.round(row.approvedCost),
      approvedRequests: row.approvedRequests,
      customerName: row.customerName,
      decidedAt: row.decidedAt ? cairoDateTime(row.decidedAt) : "",
      decidedByName: row.decidedByName ?? "",
      firstPayDate: row.firstPayDate ? utcDate(row.firstPayDate) : "",
      lastVisitDate: row.lastVisitDate ? utcDate(row.lastVisitDate) : "",
      latestObjection: row.latestObjection ? `${row.latestObjection.label}${row.latestObjection.note ? `: ${row.latestObjection.note}` : ""}` : "",
      lineName: row.lineName ?? "",
      listAreaName: row.listAreaName ?? "",
      listType: row.listType ?? "",
      marketingAreaName: row.marketingAreaName ?? "",
      matchedName: row.matchedName ?? "",
      metresApart: row.metresApart,
      nursery: row.looksLikeNursery ? "Yes" : "",
      reason: row.reason,
      repNames: row.repNames.join(", "),
      requesterNames: row.requesterNames.join(", "),
      stateLabel: row.stateLabel,
      visitsSincePay: row.visitsSincePay,
    })),
  );
  sheet.getColumn("approvedCost").numFmt = "#,##0";
  const header = sheet.getRow(1);
  header.font = { bold: true };
  columns.forEach((column, index) => {
    if (!column.tint) return;
    const cell = header.getCell(index + 1);
    cell.fill = { fgColor: { argb: column.tint }, pattern: "solid", type: "pattern" };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });
  return workbook;
}

export function listCheckFilename(generatedAtIso: string): string {
  const cairoDay = cairoDateTimeSortable(generatedAtIso).slice(0, 10) || "undated";
  return `marketing-doctor-list-check-${cairoDay}.xlsx`;
}
