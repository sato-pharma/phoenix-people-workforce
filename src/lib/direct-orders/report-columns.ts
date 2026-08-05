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

/**
 * The held fuse, in days (spec B6).
 *
 * Deliberately a SECOND copy of service.ts's `HELD_ORDER_LIFETIME_DAYS`, not a shared import. This
 * file must stay free of Supabase and ExcelJS (see the header), so it cannot import from
 * service.ts — and moving the constant here instead would have meant editing the expiry sweep's
 * own default, a line the owner's spec B6 pins and a test asserts literally. Rewriting a
 * money-expiring default to tidy up a report is the wrong trade.
 *
 * `tests/direct-orders-report-columns.test.ts` asserts the two stay equal, so the copy cannot
 * drift silently — which is the only thing that made duplication dangerous in the first place.
 */
export const HELD_ORDER_LIFETIME_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** Whole-tenths of a day between two instants, or null when either end is missing. */
function daysBetween(from: string | null | undefined, to: Date): number | null {
  if (!from) return null;
  const start = new Date(from).getTime();
  if (Number.isNaN(start)) return null;
  return Math.round(((to.getTime() - start) / MS_PER_DAY) * 10) / 10;
}

/**
 * The held clock for one order: when it was held, how long it has sat, when the sweep takes it, and
 * how long is left. All four are blank for an order that is not held — a countdown on an approved
 * order would read as a deadline that does not exist.
 */
export function heldClockCells(heldAt: string | null | undefined, now: Date = new Date()): DirectOrderReportCell[] {
  const daysHeld = daysBetween(heldAt, now);
  if (!heldAt || daysHeld === null) return ["", null, "", null];

  const expiresAt = new Date(new Date(heldAt).getTime() + HELD_ORDER_LIFETIME_DAYS * MS_PER_DAY);
  const daysLeft = Math.round(((expiresAt.getTime() - now.getTime()) / MS_PER_DAY) * 10) / 10;
  return [heldAt, daysHeld, expiresAt.toISOString(), daysLeft];
}

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
  // The held clock. A held order is not parked — it is on a 14-day fuse (spec B6,
  // expireStaleHeldDirectOrders). "Status: held" says nothing about how much of that fuse is left,
  // and on 2026-08-05 that gap covered 11 orders worth 509,736 EGP all due to expire the same day.
  { label: "Held at" },
  { label: "Days held", right: true, numFmt: "#,##0.0" },
  { label: "Held expires" },
  { label: "Days to expiry", right: true, numFmt: "#,##0.0" },
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
    ...heldClockCells(row.heldAt),
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
