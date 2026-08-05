import type { DirectOrderReportRow, DirectOrderStatus } from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// The one definition of the Direct Orders report's on-screen filter.
//
// The admin workspace, the portal report and the XLSX export route all narrow through
// filterDirectOrderReportRows. The export deliberately re-loads its own rows server-side and
// never trusts the client for data, so a second copy of this rule on either side is the only
// way the workbook can end up answering a different question than the Rows / Pending /
// Total value / Approved value cards the reader was looking at when they pressed Export.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectOrderReportFilters = {
  search: string;
  /** Empty = every status. Kept as plain strings: a value that is not a real status must narrow
   * to nothing rather than be dropped, since dropping it would WIDEN a tampered export. */
  statuses: string[];
};

/**
 * The status chips, in the order both screens render them.
 *
 * Every member of DirectOrderStatus appears here, and the exhaustiveness is asserted in
 * tests/direct-orders-cancel-held.test.ts rather than left to whoever adds the next status. The
 * three held-lane states were missing until 2026-08-05: `held` and `expired` had existed since the
 * lane was built (spec B6) but had no chip, so the report could not be filtered to the orders the
 * whole held/validation/cancel apparatus exists to manage. You could not list them, which is a
 * large part of why 11 held orders worth 509,736 EGP sat unnoticed.
 */
export const DIRECT_ORDER_REPORT_STATUS_OPTIONS: Array<{ key: DirectOrderStatus; label: string }> = [
  { key: "pending_approval", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "returned", label: "Returned" },
  { key: "rejected", label: "Rejected" },
  { key: "reversed", label: "Reversed" },
  { key: "draft", label: "Draft" },
  { key: "held", label: "Held" },
  { key: "expired", label: "Expired" },
  { key: "cancelled", label: "Cancelled" },
];

/** The columns the search box matches, in the order the screens list them. */
function searchableValues(row: DirectOrderReportRow): Array<string | null> {
  return [
    row.requesterName,
    row.requesterHrId,
    row.productName,
    row.productCode,
    row.pharmacyName,
    row.pharmacyCode,
    row.areaCode,
    row.regionCode,
    row.brickId,
    row.doctorName,
  ];
}

export function filterDirectOrderReportRows(
  rows: DirectOrderReportRow[],
  filters: DirectOrderReportFilters,
): DirectOrderReportRow[] {
  const statuses = new Set(filters.statuses);
  const needle = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (statuses.size > 0 && !statuses.has(row.status)) return false;
    if (!needle) return true;
    return searchableValues(row).some((value) => (value ?? "").toLowerCase().includes(needle));
  });
}

/** Reads the filter off an export request body. Anything unrecognised is ignored, never
 * defaulted to a wider slice. */
export function parseDirectOrderReportFilters(input: unknown): DirectOrderReportFilters {
  const source = (input ?? {}) as { search?: unknown; statuses?: unknown };
  return {
    search: typeof source.search === "string" ? source.search : "",
    statuses: Array.isArray(source.statuses) ? source.statuses.filter((value): value is string => typeof value === "string") : [],
  };
}

/**
 * Human-readable stamp for the workbook cover — status NAMES, never the raw codes. Null when
 * nothing is filtered. A downloaded file gets forwarded on its own, so it has to say which
 * slice it is; a filtered workbook that looks company-wide is how a partial number gets read
 * as the company total.
 */
export function describeDirectOrderReportFilters(filters: DirectOrderReportFilters): string | null {
  const parts: string[] = [];
  if (filters.statuses.length > 0) {
    // Stamped in chip order, not click order, so the same slice always reads the same way.
    const selected = new Set(filters.statuses);
    const known = DIRECT_ORDER_REPORT_STATUS_OPTIONS.filter((option) => selected.has(option.key)).map((option) => option.label);
    const unknown = filters.statuses.filter(
      (status) => !DIRECT_ORDER_REPORT_STATUS_OPTIONS.some((option) => option.key === status),
    );
    parts.push(`Status: ${[...known, ...unknown].join(", ")}`);
  }
  if (filters.search.trim()) parts.push(`Search: "${filters.search.trim()}"`);
  return parts.length > 0 ? `Filtered export — this workbook covers only: ${parts.join(" · ")}.` : null;
}
