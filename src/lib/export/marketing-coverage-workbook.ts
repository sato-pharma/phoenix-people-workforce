import ExcelJS from "exceljs";

import {
  PCT_FMT,
  VALUE_FMT,
  buildCoverSheet,
  sanitizeSheetName,
  writeTable,
  type CellValue,
  type TableColumn,
} from "@/lib/export/phoenix-xlsx-style";
import type {
  MarketingCoverageFilterState,
  MarketingCoverageReport,
  MarketingRoiExportDetail,
} from "@/lib/marketing-requests/roi-report-types";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Coverage Report — XLSX export.
//
// Sibling of marketing-roi-workbook.ts, same styling helpers. The "Target
// Pharmacies" sheet reuses loadMarketingRoiExportDetail's bulk pharmacy-link
// list UNCHANGED (code/name/distributor/tracking status per request) rather
// than re-running the per-request attribution RPC for every row in the export
// — that RPC is designed for ONE request at a time (see getMarketingRequestView
// Sales) and calling it once per exported request would risk a timeout on a
// large filtered set. Per-pharmacy sales value (including zero) is shown live
// in the on-screen accordion, which lazy-loads one request at a time.
// ─────────────────────────────────────────────────────────────────────────────

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
};

const RESULT_LABELS: Record<string, string> = {
  on_track: "On track",
  behind: "Behind",
  awaiting_data: "Awaiting data",
  no_data: "No data",
};

const CONFIDENTIAL_INCLUDED =
  "CONFIDENTIAL — contains restricted products (LA003 / LA004 / SS001). Authorized for CEO / Super Admin only. Do not distribute.";
const CONFIDENTIAL_EXCLUDED =
  "Confidential products (LA003 / LA004 / SS001) are excluded from this report and its totals.";

export function describeCoverageFilters(filters: MarketingCoverageFilterState): string {
  const parts: string[] = [];
  const push = (label: string, values: Array<string | number>) => {
    if (values.length > 0) parts.push(`${label}: ${values.join(", ")}`);
  };
  push("Line", filters.line);
  push("Region", filters.region);
  push("Area", filters.area);
  push("Requester tier", filters.requesterTier);
  push("NSM", filters.nsm);
  push("RSM", filters.rsm);
  push("DM", filters.dm);
  push("Requester", filters.requester);
  push("Approved by", filters.approvedBy);
  push("Status", filters.status);
  push("Request type", filters.requestType);
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

export type CoverageWorkbookMeta = {
  exportedByName: string;
  exportedByHrId: string;
  role: string;
  exportId: string;
  generatedAtIso: string;
};

export async function buildMarketingCoverageReportWorkbook(input: {
  report: MarketingCoverageReport;
  detail: MarketingRoiExportDetail;
  meta: CoverageWorkbookMeta;
}): Promise<ArrayBuffer> {
  const { report, detail, meta } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(meta.generatedAtIso);

  const kpi = report.kpi;
  buildCoverSheet(workbook, {
    title: "Marketing Coverage Report",
    subtitle: "Filtered marketing requests, KPI totals, and target-pharmacy coverage, role-scoped.",
    confidentialNote: report.includedRestricted ? CONFIDENTIAL_INCLUDED : CONFIDENTIAL_EXCLUDED,
    rows: [
      ["Generated (UTC)", meta.generatedAtIso],
      ["Exported by", `${meta.exportedByName} (${meta.exportedByHrId})`],
      ["Role", meta.role],
      ["Export ID", meta.exportId],
      ["Applied filters", describeCoverageFilters(report.appliedFilters)],
      ["Requests", String(kpi.requestCount)],
      ["Total cost (EGP)", kpi.totalEstimatedCost.toLocaleString("en-US")],
      ["Required ROI (EGP)", kpi.totalRequiredRoi.toLocaleString("en-US")],
      ["Actual sales (EGP)", kpi.totalActualValue.toLocaleString("en-US")],
      ["Coverage", `${Math.round(kpi.coverageRatio * 100)}%`],
      ["On-track / Behind / Awaiting / No-data", `${kpi.onTrackCount} / ${kpi.behindCount} / ${kpi.awaitingDataCount} / ${kpi.noDataCount}`],
      ["Distinct target pharmacies", String(kpi.distinctPharmacyCount)],
      ["Distinct customers", String(kpi.distinctCustomerCount)],
      ["Sales data as of", kpi.salesDataAsOf ?? "n/a"],
      ["Incomplete ROI windows", String(kpi.incompleteWindowCount)],
      ["Confidential products excluded", report.includedRestricted ? "No (included)" : `Yes (${kpi.restrictedExcludedCount} request[s] affected)`],
    ],
  });

  const requestSheet = workbook.addWorksheet(sanitizeSheetName("Requests"));
  const requestColumns: TableColumn[] = [
    { label: "Request", width: 14 },
    { label: "Requester", width: 22 },
    { label: "Requester tier", width: 18 },
    { label: "Line", width: 14 },
    { label: "Region", width: 16 },
    { label: "Area", width: 16 },
    { label: "Customer", width: 28 },
    { label: "Status", width: 16 },
    { label: "Type", width: 18 },
    { label: "Pay date", width: 12 },
    { label: "ROI window", width: 18 },
    { label: "Cost", numFmt: VALUE_FMT, right: true, width: 14 },
    { label: "Required ROI", numFmt: VALUE_FMT, right: true, width: 14 },
    { label: "Actual sales", numFmt: VALUE_FMT, right: true, width: 14, dataBar: true },
    { label: "Coverage", numFmt: PCT_FMT, right: true, width: 11 },
    { label: "Result", width: 14 },
    { label: "Approved by", width: 24 },
    { label: "Products", width: 30 },
    { label: "Distributors", width: 16 },
  ];
  const requestRows: CellValue[][] = report.rows.map((row) => [
    row.requestCode,
    row.requesterName ?? row.requesterHrId,
    row.requesterTier ?? "—",
    row.line ?? "—",
    row.region ?? "—",
    row.areaName ?? "—",
    row.customerName,
    STATUS_LABELS[row.status] ?? row.status,
    row.requestTypeName ?? "—",
    row.payDate ?? "—",
    row.roiWindow ?? "—",
    row.estimatedCost,
    row.requiredRoiValue,
    row.actualSalesValue,
    row.actualCoverageRatio,
    RESULT_LABELS[row.resultStatus] ?? row.resultStatus,
    row.approverRoleKeys.join(", "),
    row.productCodes.join(", "),
    row.distributorCodes.join(", "),
  ]);
  const totals: CellValue[] = new Array(requestColumns.length).fill(null);
  totals[0] = "TOTAL";
  totals[11] = report.rows.reduce((s, r) => s + r.estimatedCost, 0);
  totals[12] = report.rows.reduce((s, r) => s + r.requiredRoiValue, 0);
  totals[13] = report.rows.reduce((s, r) => s + r.actualSalesValue, 0);
  writeTable(requestSheet, 1, {
    columns: requestColumns,
    rows: requestRows,
    title: "Requests — filtered coverage",
    totals,
    note: `${report.rows.length} request(s). Sales data as of ${kpi.salesDataAsOf ?? "n/a"}.`,
  });

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
    note: `${detail.pharmacies.length} target pharmacy code(s). Open a request's Coverage Report accordion for its per-pharmacy sales value (shown even at zero).`,
  });

  return bufferOf(workbook);
}
