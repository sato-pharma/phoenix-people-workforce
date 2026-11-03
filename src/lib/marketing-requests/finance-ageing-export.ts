import ExcelJS from "exceljs";

import { cairoDateTime, cairoDateTimeSortable, utcDate } from "@/lib/format/cairo-datetime";
import { MARKETING_WAITING_OVERDUE_DAYS, type MarketingFinanceAgeing } from "@/lib/marketing-requests/finance-ageing";

/**
 * The Finance Ageing workbook, built from the same object the page renders so the file can never
 * disagree with the screen. Flat and complete: cost and days stay numeric so the columns still sum.
 */
export async function buildMarketingFinanceAgeingWorkbook(report: MarketingFinanceAgeing): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const info = workbook.addWorksheet("Report Info");
  info.columns = [
    { header: "Field", key: "field", width: 30 },
    { header: "Value", key: "value", width: 60 },
  ];
  info.addRows([
    { field: "Report", value: "Marketing Finance Ageing" },
    { field: "Generated", value: `${cairoDateTime(report.generatedAtIso)} Cairo` },
    { field: "Scope", value: "Approved requests waiting at the Finance Execution step, oldest first" },
    { field: "Requests", value: report.totals.count },
    { field: "Total cost (EGP)", value: Math.round(report.totals.totalCost) },
    { field: "Oldest (days)", value: report.totals.oldestDays },
    { field: `Waiting ${MARKETING_WAITING_OVERDUE_DAYS} days or more`, value: report.totals.overdueCount },
    { field: "Approximate days", value: report.totals.approximateCount },
    {
      field: "Approximate means",
      value: "The step has no recorded opening, so the days are counted from the step's own row dates",
    },
  ]);

  const sheet = workbook.addWorksheet("Finance Ageing");
  sheet.columns = [
    { header: "Request Code", key: "requestCode", width: 28 },
    { header: "Customer", key: "customerName", width: 34 },
    { header: "Request Type", key: "requestType", width: 26 },
    { header: "Requester", key: "requesterName", width: 30 },
    { header: "Line", key: "lineName", width: 16 },
    { header: "Cost (EGP)", key: "estimatedCost", width: 14 },
    { header: "Pay Date", key: "payDate", width: 14 },
    { header: "Reached Finance (Cairo)", key: "reachedFinanceAt", width: 24 },
    { header: "Days Waiting", key: "daysWaiting", width: 14 },
    { header: "Days Are Approximate", key: "approximate", width: 21 },
  ];
  sheet.addRows(
    report.rows.map((row) => ({
      approximate: row.approximate ? "Yes" : "No",
      customerName: row.customerName,
      daysWaiting: row.daysWaiting,
      estimatedCost: row.estimatedCost,
      lineName: row.lineName,
      payDate: utcDate(row.payDate),
      reachedFinanceAt: cairoDateTime(row.reachedFinanceAt),
      requestCode: row.requestCode,
      requesterName: row.requesterName,
      requestType: row.requestType,
    })),
  );
  sheet.getColumn("estimatedCost").numFmt = "#,##0";
  sheet.getRow(1).font = { bold: true };

  return workbook;
}

export function marketingFinanceAgeingFilename(generatedAtIso: string): string {
  const cairoDay = cairoDateTimeSortable(generatedAtIso).slice(0, 10) || "undated";
  return `marketing-finance-ageing-${cairoDay}.xlsx`;
}
