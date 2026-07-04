import { roundMarketingMoney, roundMarketingRatio } from "@/lib/marketing-requests/roi";
import type { MarketingCoverageReportRow } from "@/lib/marketing-requests/roi-report-types";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Coverage Report — client-side analytical layer.
//
// Every function here is pure and derives entirely from `MarketingCoverageReportRow[]`
// (the rows the report already returns) — no new API fields, no backend dependency.
// Kept in its own module (not the workspace component) so it's independently
// unit-testable, matching this codebase's convention for pure report-math functions
// (e.g. mergePharmacyCoverage in coverage-report-service.ts).
// ─────────────────────────────────────────────────────────────────────────────

export type CoverageRollupDimension = "line" | "region" | "requesterTier";

// ── Request-list column sorting — same local { key, direction } pattern already
// established in marketing-request-sales-view.tsx (the View Sales table); kept here
// (not inline in the workspace component) purely so it's independently unit-testable,
// matching this module's own convention.
export type RequestSortKey =
  | "requestCode"
  | "requesterName"
  | "line"
  | "customerName"
  | "status"
  | "payDate"
  | "estimatedCost"
  | "requiredRoiValue"
  | "actualSalesValue"
  | "actualCoverageRatio"
  | "resultStatus";
export type SortDirection = "asc" | "desc";

export function sortRequestRows(
  rows: MarketingCoverageReportRow[],
  key: RequestSortKey,
  direction: SortDirection,
): MarketingCoverageReportRow[] {
  const dir = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
  });
}

export type CoverageDimensionRollupRow = {
  key: string;
  label: string;
  requestCount: number;
  totalCost: number;
  totalRequiredRoi: number;
  totalActualValue: number;
  coverageRatio: number;
  onTrackCount: number;
  behindCount: number;
  awaitingDataCount: number;
  noDataCount: number;
};

const UNASSIGNED_LABEL = "Unassigned";

function dimensionValue(row: MarketingCoverageReportRow, dimension: CoverageRollupDimension): string {
  const raw = row[dimension];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || UNASSIGNED_LABEL;
}

/**
 * Groups rows by the given dimension (null/empty → "Unassigned"), sums cost/required-ROI/
 * actual-sales, and tallies result-status counts. Sorted ascending by coverage ratio (worst
 * coverage first) then total cost descending — "where is coverage failing" surfaces at the top.
 */
export function computeCoverageRollupByDimension(
  rows: MarketingCoverageReportRow[],
  dimension: CoverageRollupDimension,
): CoverageDimensionRollupRow[] {
  const byKey = new Map<string, CoverageDimensionRollupRow>();

  for (const row of rows) {
    const key = dimensionValue(row, dimension);
    const bucket = byKey.get(key) ?? {
      key,
      label: key,
      requestCount: 0,
      totalCost: 0,
      totalRequiredRoi: 0,
      totalActualValue: 0,
      coverageRatio: 0,
      onTrackCount: 0,
      behindCount: 0,
      awaitingDataCount: 0,
      noDataCount: 0,
    };

    bucket.requestCount += 1;
    bucket.totalCost += row.estimatedCost;
    bucket.totalRequiredRoi += row.requiredRoiValue;
    bucket.totalActualValue += row.actualSalesValue;
    if (row.resultStatus === "on_track") bucket.onTrackCount += 1;
    else if (row.resultStatus === "behind") bucket.behindCount += 1;
    else if (row.resultStatus === "awaiting_data") bucket.awaitingDataCount += 1;
    else if (row.resultStatus === "no_data") bucket.noDataCount += 1;

    byKey.set(key, bucket);
  }

  const result = Array.from(byKey.values()).map((bucket) => ({
    ...bucket,
    totalCost: roundMarketingMoney(bucket.totalCost),
    totalRequiredRoi: roundMarketingMoney(bucket.totalRequiredRoi),
    totalActualValue: roundMarketingMoney(bucket.totalActualValue),
    coverageRatio:
      bucket.totalRequiredRoi > 0
        ? roundMarketingRatio(bucket.totalActualValue / bucket.totalRequiredRoi)
        : bucket.totalActualValue > 0
          ? 1
          : 0,
  }));

  result.sort((a, b) => a.coverageRatio - b.coverageRatio || b.totalCost - a.totalCost);
  return result;
}

export type CoverageTrendPoint = {
  month: string;
  requestCount: number;
  totalCost: number;
  totalRequiredRoi: number;
  totalActualValue: number;
  coverageRatio: number;
};

/** Groups rows by payDate's YYYY-MM, sums the same three values, sorts ascending by month.
 *  Operates over whatever's currently filtered — not a separate all-time query. */
export function computeCoverageTrend(rows: MarketingCoverageReportRow[]): CoverageTrendPoint[] {
  const byMonth = new Map<string, CoverageTrendPoint>();

  for (const row of rows) {
    if (!row.payDate) continue;
    const month = row.payDate.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;

    const point = byMonth.get(month) ?? {
      month,
      requestCount: 0,
      totalCost: 0,
      totalRequiredRoi: 0,
      totalActualValue: 0,
      coverageRatio: 0,
    };
    point.requestCount += 1;
    point.totalCost += row.estimatedCost;
    point.totalRequiredRoi += row.requiredRoiValue;
    point.totalActualValue += row.actualSalesValue;
    byMonth.set(month, point);
  }

  const result = Array.from(byMonth.values()).map((point) => ({
    ...point,
    totalCost: roundMarketingMoney(point.totalCost),
    totalRequiredRoi: roundMarketingMoney(point.totalRequiredRoi),
    totalActualValue: roundMarketingMoney(point.totalActualValue),
    coverageRatio:
      point.totalRequiredRoi > 0
        ? roundMarketingRatio(point.totalActualValue / point.totalRequiredRoi)
        : point.totalActualValue > 0
          ? 1
          : 0,
  }));

  result.sort((a, b) => a.month.localeCompare(b.month));
  return result;
}

/**
 * The single highest-spend request with genuinely zero attributed sales — the "money
 * question" this report exists to answer. Considers ONLY resultStatus === "no_data" (the
 * ROI window has closed and sales are truly zero) — never "awaiting_data" (window still
 * open, sales legitimately not computed yet). Same honest-zero distinction used elsewhere
 * in this report: never flag a request as an outlier just because it hasn't had a chance
 * to show sales yet.
 */
export function findWorstZeroSalesOutlier(
  rows: MarketingCoverageReportRow[],
): MarketingCoverageReportRow | null {
  let worst: MarketingCoverageReportRow | null = null;
  for (const row of rows) {
    if (row.resultStatus !== "no_data") continue;
    if (!worst || row.estimatedCost > worst.estimatedCost) worst = row;
  }
  return worst;
}
