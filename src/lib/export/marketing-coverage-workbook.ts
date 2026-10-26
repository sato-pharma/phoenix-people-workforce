import { countOf } from "@/lib/i18n/format";
import ExcelJS from "exceljs";

// The HOUSE helpers for the cover and the tables — SATO-DIS-2026-01 v1.0. `phoenix-xlsx-style`
// keeps serving the five other families that still read it, so it is not changed here; its
// formats and helpers below are unaffected and still come from it.
import { buildHouseCoverSheet, writeHouseTable } from "@/lib/export/house-table-workbook";

import {
  PCT_FMT,
  VALUE_FMT,
  sanitizeSheetName,
  type CellValue,
  type TableColumn,
} from "@/lib/export/phoenix-xlsx-style";
import { houseGeneratedRow } from "@/lib/export/house-xlsx-identity";
import { HOUSE_XLSX_COLORS } from "@/lib/export/house-xlsx-palette";
import { marketingRequestStatusLabel, ROI_RESULT_STATUS_LABEL } from "@/lib/marketing-requests/roi-labels";
import type {
  MarketingCoverageExportSalesDetailRow,
  MarketingCoverageFilterKey,
  MarketingCoverageFilterLabels,
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
// large filtered set. The "Sales Detail" sheet below gets the finer product +
// month + pharmacy breakdown from a SEPARATE bulk RPC
// (phx_marketing_coverage_export_sales_detail, called via
// loadMarketingCoverageExportSalesDetail) that takes an array of request ids
// in a few batched calls, not one call per request — same reasoning, different
// query shape.
// ─────────────────────────────────────────────────────────────────────────────


// Sourced from roi-labels.ts, never re-declared — see the note in marketing-roi-workbook.ts.
const RESULT_LABELS: Record<string, string> = ROI_RESULT_STATUS_LABEL;

const CONFIDENTIAL_INCLUDED =
  "CONFIDENTIAL — contains restricted products (LA003 / LA004 / SS001). Authorized for CEO / Super Admin only. Do not distribute.";
const CONFIDENTIAL_EXCLUDED =
  "Confidential products (LA003 / LA004 / SS001) are excluded from this report and its totals.";

/** Display name per product / distributor code, read off the report's own rows — never a lookup. */
export type CoverageCodeNames = { product: Map<string, string>; distributor: Map<string, string> };

export function coverageCodeNames(rows: MarketingCoverageReport["rows"]): CoverageCodeNames {
  const product = new Map<string, string>();
  const distributor = new Map<string, string>();
  for (const row of rows) {
    row.productCodes.forEach((code, index) => {
      const name = row.productNames[index];
      if (name && !product.has(code)) product.set(code, name);
    });
    row.distributorCodes.forEach((code, index) => {
      const name = row.distributorNames[index];
      if (name && !distributor.has(code)) distributor.set(code, name);
    });
  }
  return { product, distributor };
}

/**
 * The cover's "Applied filters" line. Every value prints as the label the filter panel showed for
 * it (`report.filterLabels`, read off the viewer's own index): a person by name, a request type by
 * name, a status as a reader sees it — never an HR id, a type id or a raw status word (owner rule:
 * names, never codes or IDs). A person the index does not carry reads "Name not on file", exactly
 * as the panel says it.
 */
export function describeCoverageFilters(filters: MarketingCoverageFilterState, labels: MarketingCoverageFilterLabels = {}): string {
  const parts: string[] = [];
  const push = (label: string, values: Array<string | number>, nameOf: (value: string) => string) => {
    if (values.length > 0) parts.push(`${label}: ${values.map((value) => nameOf(String(value))).join(", ")}`);
  };
  const labelled = (key: MarketingCoverageFilterKey, fallback: (value: string) => string) => (value: string) =>
    labels[key]?.[value] ?? fallback(value);
  const asIs = (value: string) => value;
  const personNotOnFile = () => "Name not on file";
  push("Line", filters.line, labelled("line", asIs));
  push("Region", filters.region, labelled("region", asIs));
  push("Area", filters.area, labelled("area", asIs));
  push("Requester tier", filters.requesterTier, labelled("requesterTier", asIs));
  push("NSM", filters.nsm, labelled("nsm", personNotOnFile));
  push("RSM", filters.rsm, labelled("rsm", personNotOnFile));
  push("DM", filters.dm, labelled("dm", personNotOnFile));
  push("Requester", filters.requester, labelled("requester", personNotOnFile));
  push("Approved by", filters.approvedBy, labelled("approvedBy", asIs));
  push("Status", filters.status, marketingRequestStatusLabel);
  push("Request type", filters.requestType, labelled("requestType", () => "Unknown request type"));
  push("Distributor", filters.distributor, labelled("distributor", asIs));
  push("Product", filters.product, labelled("product", asIs));
  push("Pharmacy", filters.pharmacy, labelled("pharmacy", asIs));
  push("ROI status", filters.roiStatus, (value) => RESULT_LABELS[value] ?? "Unknown result");
  if (filters.payDateFrom || filters.payDateTo) parts.push(`Pay date: ${filters.payDateFrom ?? "…"} → ${filters.payDateTo ?? "…"}`);
  if (filters.durationMin != null || filters.durationMax != null) parts.push(`Duration: ${filters.durationMin ?? "…"} → ${filters.durationMax ?? "…"} months`);
  if (filters.includeRestricted) parts.push("Includes confidential products");
  return parts.length > 0 ? parts.join("   ·   ") : "No filters applied (all visible requests)";
}

function bufferOf(workbook: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return workbook.xlsx.writeBuffer() as unknown as Promise<ArrayBuffer>;
}

/**
 * Real Excel conditional formatting (not a static fill) on the Status column: Approved, Rejected and
 * any "Pending …" label each take their own colour. `containsText` (not `cellIs equal`) so "Pending
 * validation" and "Pending approval" both match one rule.
 *
 * TYPE, NOT A FILL, under SATO-DIS-2026-01 v1.0. The old form was Excel's built-in Good/Bad/Neutral
 * triplet — a green, red or yellow BLOCK behind the word. The ink rule removes it and the test for
 * whether a fill may go is met here about as plainly as it ever is: the cell already says
 * "Approved", "Rejected" or "Pending approval" in words, so the block was saying a second time what
 * the reader was already reading. Colour still marks the three apart, carried by the word itself.
 *
 * This is the opposite call to the weekly BI workbook's heatmaps, which KEEP their fills: a colour
 * scale over a matrix of bare numbers is the only thing saying which cells are large, and no word
 * in those cells says it.
 */
/** The Status column's three verdicts, as TYPE. Approved takes the brand deep rather than a
 *  green the palette does not have; rejected takes the standard's own sanctioned red. */
const STATUS_APPROVED = HOUSE_XLSX_COLORS.deep;
const STATUS_REJECTED = HOUSE_XLSX_COLORS.flag;
const STATUS_PENDING = HOUSE_XLSX_COLORS.muted;

function applyStatusConditionalFormat(sheet: ExcelJS.Worksheet, ref: string, firstCellRef: string) {
  try {
    const rule = (text: string, priority: number, fontColor: string) => ({
      type: "containsText" as const,
      operator: "containsText" as const,
      text,
      formulae: [`NOT(ISERROR(SEARCH("${text}",${firstCellRef})))`],
      priority,
      style: { font: { bold: true, color: { argb: fontColor } } },
    });
    sheet.addConditionalFormatting({
      ref,
      rules: [
        rule("Approved", 1, STATUS_APPROVED),
        rule("Rejected", 2, STATUS_REJECTED),
        rule("Pending", 3, STATUS_PENDING),
      ],
    });
  } catch {
    // conditional formatting is a cosmetic enhancement — never fail the export over it.
  }
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
  salesDetail: MarketingCoverageExportSalesDetailRow[];
  meta: CoverageWorkbookMeta;
}): Promise<ArrayBuffer> {
  const { report, detail, salesDetail, meta } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(meta.generatedAtIso);

  const kpi = report.kpi;
  // Products and distributors are printed by NAME on every sheet, never by code (owner rule).
  const names = coverageCodeNames(report.rows);
  buildHouseCoverSheet(workbook, {
    title: "Marketing Coverage Report",
    subtitle: "Filtered marketing requests, KPI totals, and target-pharmacy coverage, role-scoped.",
    confidentialNote: report.includedRestricted ? CONFIDENTIAL_INCLUDED : CONFIDENTIAL_EXCLUDED,
    rows: [
      houseGeneratedRow(meta.generatedAtIso),
      ["Exported by", meta.exportedByName],
      ["Role", meta.role],
      ["Export ID", meta.exportId],
      ["Applied filters", describeCoverageFilters(report.appliedFilters, report.filterLabels)],
      ["Requests", String(kpi.requestCount)],
      ["Total cost (EGP)", kpi.totalEstimatedCost.toLocaleString("en-US")],
      ["Required ROI (EGP)", kpi.totalRequiredRoi.toLocaleString("en-US")],
      ["Actual sales (EGP)", kpi.totalActualValue.toLocaleString("en-US")],
      ["Coverage", `${Math.round(kpi.coverageRatio * 100)}%`],
      [
        `${RESULT_LABELS.on_track} / ${RESULT_LABELS.behind} / ${RESULT_LABELS.awaiting_data} / ${RESULT_LABELS.no_data}`,
        `${kpi.onTrackCount} / ${kpi.behindCount} / ${kpi.awaitingDataCount} / ${kpi.noDataCount}`,
      ],
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
    { label: "Distributors", width: 24 },
  ];
  const requestRows: CellValue[][] = report.rows.map((row) => [
    row.requestCode,
    row.requesterName ?? "Unknown requester",
    row.requesterTier ?? "—",
    row.line ?? "—",
    row.region ?? "—",
    row.areaName ?? "—",
    row.customerName,
    marketingRequestStatusLabel(row.status),
    row.requestTypeName ?? "—",
    row.payDate ?? "—",
    row.roiWindow ?? "—",
    row.estimatedCost,
    row.requiredRoiValue,
    row.actualSalesValue,
    row.actualCoverageRatio,
    RESULT_LABELS[row.resultStatus] ?? row.resultStatus,
    row.approverRoleKeys.join(", "),
    row.productNames.join(", "),
    row.distributorNames.join(", "),
  ]);
  const totals: CellValue[] = new Array(requestColumns.length).fill(null);
  totals[0] = "TOTAL";
  totals[11] = report.rows.reduce((s, r) => s + r.estimatedCost, 0);
  totals[12] = report.rows.reduce((s, r) => s + r.requiredRoiValue, 0);
  // The headline's DEDUPED actual, not the column sum: two campaigns can claim the same sale, and
  // each row is right to show it, but a total that adds them counts it twice (45,153.88 vs the
  // page's 42,433.56 on production, 2026-10-09). The note says why the column does not add up.
  totals[13] = kpi.totalActualValue;
  writeHouseTable(requestSheet, 1, {
    columns: requestColumns,
    rows: requestRows,
    title: "Requests — filtered coverage",
    totals,
    note: `${countOf(report.rows.length, "request")}. Sales data as of ${kpi.salesDataAsOf ?? "n/a"}. The actual-sales TOTAL counts a sale claimed by more than one campaign once, so it can be lower than the column added up.`,
  });

  if (requestRows.length > 0) {
    const statusColIndex = requestColumns.findIndex((c) => c.label === "Status") + 1; // 1-based for ExcelJS
    const statusColLetter = requestSheet.getColumn(statusColIndex).letter;
    const statusFirstRow = 3; // row 1 = title, row 2 = header, data starts row 3 (writeTable's layout)
    const statusLastRow = 2 + requestRows.length;
    applyStatusConditionalFormat(
      requestSheet,
      `${statusColLetter}${statusFirstRow}:${statusColLetter}${statusLastRow}`,
      `${statusColLetter}${statusFirstRow}`,
    );
  }

  const pharmacySheet = workbook.addWorksheet(sanitizeSheetName("Target Pharmacies"));
  writeHouseTable(pharmacySheet, 1, {
    title: "Target pharmacies (per request)",
    columns: [
      { label: "Request", width: 14 },
      { label: "Pharmacy", width: 32 },
      { label: "Customer code", width: 18 },
      { label: "Distributor", width: 22 },
      { label: "Tracking status", width: 18 },
    ],
    rows: detail.pharmacies.map((p) => [
      p.requestCode,
      p.pharmacyName,
      p.customerCode,
      p.distributorCode ? names.distributor.get(p.distributorCode) ?? p.distributorCode : "—",
      p.trackingStatus ?? "—",
    ]),
    note: `${detail.pharmacies.length} target pharmacy code(s). Open a request's Coverage Report accordion for its per-pharmacy sales value (shown even at zero).`,
  });

  // Resolves a display name for (requestId, customerCode) from the pharmacy-link list above —
  // never a third lookup query, just reusing data already loaded for the Target Pharmacies sheet.
  const pharmacyNameByRequestAndCode = new Map(detail.pharmacies.map((p) => [`${p.requestId}|${p.customerCode}`, p.pharmacyName] as const));

  const salesDetailSheet = workbook.addWorksheet(sanitizeSheetName("Sales Detail"));
  writeHouseTable(salesDetailSheet, 1, {
    title: "Matched sales — by pharmacy, product and month",
    columns: [
      { label: "Request", width: 14 },
      { label: "Pharmacy", width: 32 },
      { label: "Customer code", width: 18 },
      { label: "Distributor", width: 22 },
      { label: "Product", width: 26 },
      { label: "Month", width: 12 },
      { label: "Qty", right: true, width: 10 },
      { label: "Value", numFmt: VALUE_FMT, right: true, width: 14, dataBar: true },
    ],
    rows: salesDetail.map((s) => [
      s.requestCode,
      pharmacyNameByRequestAndCode.get(`${s.requestId}|${s.customerCode}`) ?? s.customerCode,
      s.customerCode,
      s.distributorName ?? (s.distributorCode ? names.distributor.get(s.distributorCode) ?? s.distributorCode : "—"),
      s.productName,
      s.invoicePeriod,
      s.qty,
      s.value,
    ]),
    note: `${salesDetail.length} matched sale line(s), one row per product per month per pharmacy. Zero-sales pharmacies have no rows here — see Target Pharmacies for the full target list including zero.`,
  });

  return bufferOf(workbook);
}
