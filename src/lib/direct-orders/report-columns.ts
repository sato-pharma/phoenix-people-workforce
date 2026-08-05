import type { DirectOrderReportRow } from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// The Direct Orders report column set — the ONE definition behind every surface that renders it.
//
// It lives here rather than in report-workbook.ts because that module imports ExcelJS at the top
// level (via sales-workbook-kit), and the share-link CSV feed is polled every 60 seconds by the
// owner's Google Sheet. Importing the columns from the workbook would have pulled the whole
// spreadsheet engine into that hot path to read a list of strings.
//
// Keeping it here also means the downloadable .xlsx and the live Sheet cannot drift: they are the
// same 39 columns in the same order, because they are literally the same array.
//
// COLUMNS and directOrderReportRowCells() below remain POSITIONAL TWINS with no compile-time link.
// Adding an entry to one without the other silently shifts every later column — the header would
// say "Area" over region data. `tests/direct-orders-approval-flow.test.ts` asserts the two lengths
// match; keep that test passing rather than trusting care.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Excel number-format literals.
 *
 * Deliberately written out rather than imported from sales-workbook-kit's UNITS_FMT/VALUE_FMT:
 * that module loads ExcelJS, which is precisely the dependency this file exists to avoid. They are
 * plain format strings, and report-workbook.ts still consumes these same values, so the workbook
 * and the feed cannot disagree about them.
 */
const UNITS_FMT = "#,##0";
const VALUE_FMT = "#,##0.00";

export type DirectOrderReportColumn = {
  label: string;
  right?: boolean;
  numFmt?: string;
  width?: number;
};

export type DirectOrderReportCell = string | number | null;

/** Every column — the owner's rule is "do not minus even one field". */
export const DIRECT_ORDER_REPORT_COLUMNS: DirectOrderReportColumn[] = [
  { label: "Status" },
  { label: "Requester" },
  { label: "Requester HR_ID" },
  { label: "Requester role" },
  { label: "Line" },
  { label: "Product code" },
  { label: "Product" },
  { label: "Qty (units)", right: true, numFmt: UNITS_FMT },
  { label: "Bonus (units)", right: true, numFmt: UNITS_FMT },
  { label: "Pharmacy price", right: true, numFmt: VALUE_FMT },
  { label: "Sales value (EGP)", right: true, numFmt: VALUE_FMT },
  { label: "Deal type" },
  { label: "Discount %", right: true },
  { label: "Public price", right: true, numFmt: VALUE_FMT },
  { label: "Bonus override reason", width: 26 },
  { label: "Pharmacy code" },
  { label: "Pharmacy name", width: 24 },
  { label: "Pharmacy address", width: 28 },
  { label: "Brick", width: 18 },
  { label: "Brick code" },
  { label: "Area", width: 16 },
  { label: "Area code" },
  { label: "Region", width: 14 },
  { label: "Region code" },
  { label: "Doctor" },
  { label: "Distributor codes", width: 34 },
  { label: "Collection date" },
  { label: "Sales month" },
  { label: "Payment date" },
  { label: "Paid (EGP)", right: true, numFmt: VALUE_FMT },
  { label: "Remaining (EGP)", right: true, numFmt: VALUE_FMT },
  { label: "Marketing request", width: 20 },
  { label: "Reversal of", width: 20 },
  { label: "Reversed by", width: 20 },
  { label: "SoS batch", width: 20 },
  { label: "Awaiting step" },
  { label: "Request ID", width: 20 },
  { label: "Created at" },
  { label: "Decided at" },
];

export function directOrderReportRowCells(row: DirectOrderReportRow): DirectOrderReportCell[] {
  return [
    row.status,
    row.requesterName,
    row.requesterHrId,
    row.requesterRole,
    row.line,
    row.productCode,
    row.productName,
    row.qty,
    row.bonus,
    row.pharmacyPriceSnapshot ?? "",
    row.salesValue,
    row.dealType,
    row.discountPct ?? "",
    row.publicPriceSnapshot ?? "",
    row.bonusOverrideReason ?? "",
    row.pharmacyCode,
    row.pharmacyName,
    row.pharmacyAddress,
    row.brickName,
    row.brickId,
    row.areaName,
    row.areaCode,
    row.regionName,
    row.regionCode,
    row.doctorName,
    row.distributorCodesText,
    row.collectionDate ?? "",
    row.salesMonth ?? "",
    row.paymentDate ?? "",
    row.paidAmount,
    row.remainingAmount,
    row.marketingRequestId ?? "",
    row.reversalOfRequestId ?? "",
    row.reversedByRequestId ?? "",
    row.sosBatchId ?? "",
    row.activeStepLabel,
    row.id,
    row.createdAt,
    row.decidedAt ?? "",
  ];
}

/** The index a named column sits at, so a consumer never hard-codes a position. */
export function directOrderReportColumnIndex(label: string): number {
  return DIRECT_ORDER_REPORT_COLUMNS.findIndex((column) => column.label === label);
}

/**
 * The report's headline aggregates, computed once so the .xlsx cover, the .xlsx totals row and the
 * live Sheet all quote the same numbers.
 */
export function summariseDirectOrderReport(rows: DirectOrderReportRow[]): {
  totalValue: number;
  approvedValue: number;
  totalUnits: number;
  byStatus: Array<{ status: string; count: number; value: number }>;
} {
  const finite = (value: number): number => (Number.isFinite(value) ? value : 0);
  const byStatus = new Map<string, { count: number; value: number }>();
  for (const row of rows) {
    const entry = byStatus.get(row.status) ?? { count: 0, value: 0 };
    entry.count += 1;
    entry.value += finite(row.salesValue);
    byStatus.set(row.status, entry);
  }
  return {
    totalValue: rows.reduce((sum, r) => sum + finite(r.salesValue), 0),
    approvedValue: rows.filter((r) => r.status === "approved").reduce((sum, r) => sum + finite(r.salesValue), 0),
    totalUnits: rows.reduce((sum, r) => sum + finite(r.qty), 0),
    byStatus: Array.from(byStatus.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([status, entry]) => ({ status, count: entry.count, value: entry.value })),
  };
}
