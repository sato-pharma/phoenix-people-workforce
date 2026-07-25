import ExcelJS from "exceljs";

import {
  PCT_FMT,
  UNITS_FMT,
  VALUE_FMT,
  buildCoverSheet,
  sanitizeSheetName,
  writeTable,
  type CellValue,
  type TableColumn,
} from "@/lib/export/phoenix-xlsx-style";
import type {
  MarketingRoiExportDetail,
  MarketingRoiReport,
  MarketingRoiViewSales,
  RoiFilterState,
} from "@/lib/marketing-requests/roi-report-types";

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_validation: "Pending validation",
  pending_approval: "Pending approval",
  returned: "Returned",
  rejected: "Rejected",
  approved: "Approved",
  active: "Active",
  roi_tracking: "ROI tracking",
  closed: "Closed",
  finance_hold: "Finance hold",
  archived: "Archived",
};

const RESULT_LABELS: Record<string, string> = {
  on_track: "On track",
  behind: "Behind",
  awaiting_data: "Awaiting data",
  no_data: "No data",
};

/** Human-readable summary of the applied filters for the cover sheet. */
export function describeRoiFilters(filters: RoiFilterState): string {
  const parts: string[] = [];
  const push = (label: string, values: Array<string | number>) => {
    if (values.length > 0) parts.push(`${label}: ${values.join(", ")}`);
  };
  push("DM", filters.dm);
  push("NSM", filters.nsm);
  push("RSM", filters.rsm);
  push("Line", filters.line);
  push("Approved by", filters.approvedBy);
  push("Requester", filters.requester);
  push("Status", filters.status);
  push("Request type", filters.requestType);
  push("Region", filters.region);
  push("Distributor", filters.distributor);
  push("Product", filters.product);
  push("Pharmacy", filters.pharmacy);
  push("ROI status", filters.roiStatus);
  if (filters.payDateFrom || filters.payDateTo) parts.push(`Pay date: ${filters.payDateFrom ?? "…"} → ${filters.payDateTo ?? "…"}`);
  if (filters.durationMin != null || filters.durationMax != null) parts.push(`Duration: ${filters.durationMin ?? "…"} → ${filters.durationMax ?? "…"} months`);
  if (filters.includeRestricted) parts.push("Includes confidential products");
  return parts.length > 0 ? parts.join("   ·   ") : "No filters applied (all visible requests)";
}

function bufferOf(workbook: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return workbook.xlsx.writeBuffer() as unknown as Promise<ArrayBuffer>;
}

export type RoiWorkbookMeta = {
  exportedByName: string;
  exportedByHrId: string;
  role: string;
  exportId: string;
  generatedAtIso: string;
};

const CONFIDENTIAL_INCLUDED =
  "CONFIDENTIAL — contains restricted products (LA003 / LA004 / SS001). Authorized for CEO / Super Admin only. Do not distribute.";
const CONFIDENTIAL_EXCLUDED =
  "Confidential products (LA003 / LA004 / SS001) are excluded from this report and its totals.";

export async function buildMarketingRoiReportWorkbook(input: {
  report: MarketingRoiReport;
  detail: MarketingRoiExportDetail;
  meta: RoiWorkbookMeta;
}): Promise<ArrayBuffer> {
  const { report, detail, meta } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(meta.generatedAtIso);

  const kpi = report.kpi;
  buildCoverSheet(workbook, {
    title: "Marketing ROI Report",
    subtitle: "Realized sales of promoted products vs the required return, role-scoped.",
    confidentialNote: report.includedRestricted ? CONFIDENTIAL_INCLUDED : CONFIDENTIAL_EXCLUDED,
    rows: [
      ["Generated (UTC)", meta.generatedAtIso],
      ["Exported by", `${meta.exportedByName} (${meta.exportedByHrId})`],
      ["Role", meta.role],
      ["Export ID", meta.exportId],
      ["Applied filters", describeRoiFilters(report.appliedFilters)],
      ["Requests", String(kpi.requestCount)],
      ["Total cost (EGP)", kpi.totalEstimatedCost.toLocaleString("en-US")],
      ["Required ROI (EGP)", kpi.totalRequiredRoi.toLocaleString("en-US")],
      ["Actual sales (EGP)", kpi.totalActualValue.toLocaleString("en-US")],
      ["Coverage", `${Math.round(kpi.coverageRatio * 100)}%`],
      ["On-track / Behind / Awaiting / No-data", `${kpi.onTrackCount} / ${kpi.behindCount} / ${kpi.awaitingDataCount} / ${kpi.noDataCount}`],
      ["Approved vs pending value", `${kpi.approvedValue.toLocaleString("en-US")} approved · ${kpi.pendingValue.toLocaleString("en-US")} pending`],
      ["Sales data as of", kpi.salesDataAsOf ?? "n/a"],
      ["Incomplete ROI windows", String(kpi.incompleteWindowCount)],
      ["Confidential products excluded", report.includedRestricted ? "No (included)" : `Yes (${kpi.restrictedExcludedCount} request[s] affected)`],
    ],
  });

  // ── Requests ────────────────────────────────────────────────────────────────
  const requestSheet = workbook.addWorksheet(sanitizeSheetName("Requests"));
  const requestColumns: TableColumn[] = [
    { label: "Request", width: 14 },
    { label: "Requester", width: 22 },
    { label: "Line", width: 14 },
    { label: "Region", width: 16 },
    { label: "Customer", width: 28 },
    { label: "Status", width: 16 },
    { label: "Type", width: 18 },
    { label: "Pay date", width: 12 },
    { label: "ROI window", width: 18 },
    { label: "Months", numFmt: UNITS_FMT, right: true, width: 9 },
    { label: "Cost", numFmt: VALUE_FMT, right: true, width: 14 },
    { label: "Required ROI", numFmt: VALUE_FMT, right: true, width: 14 },
    { label: "Expected ROI", numFmt: VALUE_FMT, right: true, width: 14 },
    { label: "Actual sales", numFmt: VALUE_FMT, right: true, width: 14, dataBar: true },
    { label: "Coverage", numFmt: PCT_FMT, right: true, width: 11 },
    { label: "Result", width: 14 },
    { label: "Attribution", width: 14 },
    { label: "Approved by", width: 24 },
    { label: "Products", width: 30 },
    { label: "Distributors", width: 16 },
  ];
  const requestRows: CellValue[][] = report.rows.map((row) => [
    row.requestCode,
    row.requesterName ?? row.requesterHrId,
    row.line ?? "—",
    row.region ?? "—",
    row.customerName,
    STATUS_LABELS[row.status] ?? row.status,
    row.requestTypeName ?? "—",
    row.payDate ?? "—",
    row.roiWindow ?? "—",
    row.roiDurationMonths,
    row.estimatedCost,
    row.requiredRoiValue,
    row.expectedRoiValue,
    row.actualSalesValue,
    row.actualCoverageRatio,
    RESULT_LABELS[row.resultStatus] ?? row.resultStatus,
    row.attributionQuality === "exact_customer" ? "Exact customer" : "No sales",
    row.approverRoleKeys.join(", "),
    row.productCodes.join(", "),
    row.distributorCodes.join(", "),
  ]);
  const totals: CellValue[] = new Array(requestColumns.length).fill(null);
  totals[0] = "TOTAL";
  totals[10] = report.rows.reduce((s, r) => s + r.estimatedCost, 0);
  totals[11] = report.rows.reduce((s, r) => s + r.requiredRoiValue, 0);
  totals[12] = report.rows.reduce((s, r) => s + r.expectedRoiValue, 0);
  totals[13] = report.rows.reduce((s, r) => s + r.actualSalesValue, 0);
  writeTable(requestSheet, 1, { columns: requestColumns, rows: requestRows, title: "Requests — actual vs required return", totals, note: `${report.rows.length} request(s). Sales data as of ${kpi.salesDataAsOf ?? "n/a"}.` });

  // ── Products ──────────────────────────────────────────────────────────────
  const productSheet = workbook.addWorksheet(sanitizeSheetName("Products"));
  writeTable(productSheet, 1, {
    title: "Promoted products (per request)",
    columns: [
      { label: "Request", width: 14 },
      { label: "Product code", width: 14 },
      { label: "Product", width: 30 },
      { label: "Line", width: 14 },
      { label: "Factory price", numFmt: VALUE_FMT, right: true, width: 14 },
      { label: "Forecast qty", numFmt: UNITS_FMT, right: true, width: 12 },
      { label: "Expected value", numFmt: VALUE_FMT, right: true, width: 14 },
      { label: "Value share", numFmt: PCT_FMT, right: true, width: 11 },
    ],
    rows: detail.products.map((p) => [p.requestCode, p.productCode, p.productName, p.line ?? "—", p.factoryPrice, p.forecastQty, p.expectedValue, p.valueShare]),
    note: `${detail.products.length} product line(s).`,
  });

  // ── Target Pharmacies ─────────────────────────────────────────────────────
  const pharmacySheet = workbook.addWorksheet(sanitizeSheetName("Target Pharmacies"));
  writeTable(pharmacySheet, 1, {
    title: "Target pharmacies (per request)",
    columns: [
      { label: "Request", width: 14 },
      { label: "Pharmacy", width: 32 },
      { label: "Customer code", width: 18 },
      { label: "Distributor", width: 14 },
      { label: "Tracking status", width: 18 },
    ],
    rows: detail.pharmacies.map((p) => [p.requestCode, p.pharmacyName, p.customerCode, p.distributorCode ?? "—", p.trackingStatus ?? "—"]),
    note: `${detail.pharmacies.length} target pharmacy code(s).`,
  });

  // ── Approvals ─────────────────────────────────────────────────────────────
  const approvalSheet = workbook.addWorksheet(sanitizeSheetName("Approvals"));
  writeTable(approvalSheet, 1, {
    title: "Approval history (per request)",
    columns: [
      { label: "Request", width: 14 },
      { label: "Seq", numFmt: UNITS_FMT, right: true, width: 7 },
      { label: "Step", width: 24 },
      { label: "Role", width: 20 },
      { label: "Assignee HR_ID", width: 16 },
      { label: "Status", width: 14 },
      { label: "Decided by", width: 16 },
      { label: "Decided at", width: 22 },
      { label: "CC", width: 6 },
      { label: "Note", width: 40 },
    ],
    rows: detail.approvals.map((a) => [a.requestCode, a.sequence, a.stepName, a.assignedRole, a.assignedHrId ?? "—", a.status, a.decisionByHrId ?? "—", a.decisionAt ?? "—", a.isCc ? "Yes" : "No", a.decisionNote ?? ""]),
    note: `${detail.approvals.length} approval step(s).`,
  });

  return bufferOf(workbook);
}

export async function buildMarketingRoiViewSalesWorkbook(input: {
  data: MarketingRoiViewSales;
  meta: RoiWorkbookMeta;
}): Promise<ArrayBuffer> {
  const { data, meta } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(meta.generatedAtIso);

  buildCoverSheet(workbook, {
    title: "Marketing ROI — View Sales",
    subtitle: `Realized sales for request ${data.context.requestCode}.`,
    confidentialNote: data.includedRestricted ? CONFIDENTIAL_INCLUDED : CONFIDENTIAL_EXCLUDED,
    rows: [
      ["Generated (UTC)", meta.generatedAtIso],
      ["Exported by", `${meta.exportedByName} (${meta.exportedByHrId})`],
      ["Role", meta.role],
      ["Export ID", meta.exportId],
      ["Request", data.context.requestCode],
      ["Customer", data.context.customerName],
      ["Requester", `${data.context.requesterName ?? data.context.requesterHrId}${data.context.line ? ` · ${data.context.line}` : ""}`],
      ["Period range", `${data.range.from} → ${data.range.to}${data.range.isCustom ? " (custom)" : " (ROI window)"}`],
      ["Cost (EGP)", data.context.estimatedCost.toLocaleString("en-US")],
      ["Required ROI (EGP)", data.context.requiredRoiValue.toLocaleString("en-US")],
      ["Actual sales (EGP)", data.actualValue.toLocaleString("en-US")],
      ["Coverage", `${Math.round(data.coverageRatio * 100)}%`],
      ["Matched rows / units", `${data.totals.rows} / ${data.totals.units.toLocaleString("en-US")}`],
      ["Sales data as of", data.salesDataAsOf ?? "n/a"],
    ],
  });

  const detailSheet = workbook.addWorksheet(sanitizeSheetName("Matched Sales"));
  writeTable(detailSheet, 1, {
    title: `Matched sales — ${data.context.requestCode}`,
    columns: [
      { label: "Period", width: 10 },
      { label: "Distributor", width: 16 },
      { label: "Product", width: 28 },
      { label: "Customer code", width: 18 },
      { label: "Pharmacy", width: 28 },
      { label: "Region", width: 16 },
      { label: "Units", numFmt: UNITS_FMT, right: true, width: 10 },
      { label: "Value", numFmt: VALUE_FMT, right: true, width: 14, dataBar: true },
    ],
    rows: data.rows.map((r) => [r.invoicePeriod, r.distributorName, r.productName, r.customerCode, r.customerName ?? "—", r.regionName ?? "—", r.qty, r.value]),
    totals: ["TOTAL", null, null, null, null, null, data.totals.units, data.totals.value],
    note: `${data.rows.length} matched row(s).`,
  });

  const byProductSheet = workbook.addWorksheet(sanitizeSheetName("By Product"));
  writeTable(byProductSheet, 1, {
    title: "Sales by product",
    columns: [
      { label: "Product", width: 30 },
      { label: "Units", numFmt: UNITS_FMT, right: true, width: 12 },
      { label: "Value", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
    ],
    rows: data.byProduct.map((p) => [p.label, p.units, p.value]),
  });

  const byPharmacySheet = workbook.addWorksheet(sanitizeSheetName("By Pharmacy"));
  writeTable(byPharmacySheet, 1, {
    title: "Sales by pharmacy",
    columns: [
      { label: "Pharmacy", width: 32 },
      { label: "Units", numFmt: UNITS_FMT, right: true, width: 12 },
      { label: "Value", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
    ],
    rows: data.byPharmacy.map((p) => [p.label, p.units, p.value]),
  });

  const byMonthSheet = workbook.addWorksheet(sanitizeSheetName("By Month"));
  writeTable(byMonthSheet, 1, {
    title: "Sales by month",
    columns: [
      { label: "Month", width: 12 },
      { label: "Units", numFmt: UNITS_FMT, right: true, width: 12 },
      { label: "Value", numFmt: VALUE_FMT, right: true, width: 16, dataBar: true },
    ],
    rows: data.byMonth.map((m) => [m.label, m.units, m.value]),
  });

  // Pharmacy × product × month matrix (the on-screen drill-down grid, flattened).
  const matrixSheet = workbook.addWorksheet(sanitizeSheetName("Matrix"));
  writeTable(matrixSheet, 1, {
    title: "Pharmacy × product × month",
    columns: [
      { label: "Customer code", width: 18 },
      { label: "Pharmacy", width: 28 },
      { label: "Product", width: 28 },
      { label: "Month", width: 10 },
      { label: "Units", numFmt: UNITS_FMT, right: true, width: 10 },
      { label: "Value", numFmt: VALUE_FMT, right: true, width: 14, dataBar: true },
    ],
    rows: data.matrix
      .slice()
      .sort((a, b) =>
        a.customerCode.localeCompare(b.customerCode) || a.productCode.localeCompare(b.productCode) || a.period.localeCompare(b.period),
      )
      .map((cell) => [cell.customerCode, cell.customerName ?? "—", cell.productName, cell.period, cell.units, cell.value]),
    note: `${data.matrix.length} pharmacy×product×month cell(s).`,
  });

  // Reverse-lookup: other (in-scope) requests targeting these pharmacies.
  const reverseSheet = workbook.addWorksheet(sanitizeSheetName("Also Targets"));
  writeTable(reverseSheet, 1, {
    title: "Other requests targeting these pharmacies",
    columns: [
      { label: "Request", width: 14 },
      { label: "Requester", width: 24 },
      { label: "Status", width: 16 },
      { label: "Shared pharmacies", numFmt: UNITS_FMT, right: true, width: 16 },
      { label: "Shared customer codes", width: 40 },
    ],
    rows: data.reverseLookup.map((r) => [r.requestCode, r.requesterName ?? "—", r.status, r.sharedPharmacyCodes.length, r.sharedPharmacyCodes.join(", ")]),
    note: data.reverseLookup.length === 0 ? "No other in-scope requests share these pharmacies." : `${data.reverseLookup.length} related request(s).`,
  });

  return bufferOf(workbook);
}
