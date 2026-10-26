import type {
  SalesMarketingCustomerImpactRow,
  SalesMarketingDashboardSnapshot,
  SalesMarketingRoiComparisonRow,
} from "@/lib/sales-marketing-intelligence/types";

// ─────────────────────────────────────────────────────────────────────────────
// Every Marketing ROI breakdown adds up to the cards above it.
//
// WHAT WAS WRONG. The cards read 7 paid requests and EGP 51,800 while the Region and Distributor
// reports read 6 and EGP 48,200, and the Customer report had 6 rows. The missing request
// (MKT-REQ-20261004-6D1003DC, EGP 3,600) targets a pharmacy with no distributor account, and the
// breakdowns joined through that account, so the request fell out of every table but stayed in the
// totals. The database function now keeps it (migration 20261026160000).
//
// WHAT THIS DOES. The last step of both dashboard reads. When a breakdown's cost still falls short
// of the cards by more than 1 EGP, the gap is shown as an "Unassigned" row (folded into the one
// already there) instead of silently vanishing, so a manager can always reconcile a table with the
// cards. A table cut at the row limit is left alone — it is a top-N list, not a breakdown.
// ─────────────────────────────────────────────────────────────────────────────

const TOLERANCE_EGP = 1;

type GapRowBase = {
  actualRoiCoverage: number;
  actualSalesUnits: number;
  actualSalesValue: number;
  coverageGap: number;
  customerCount: number;
  exactSalesRows: number;
  expectedRoiValue: number;
  fallbackSalesRows: number;
  label: string;
  marketingCost: number;
  pharmacyCount: number;
  requestCount: number;
  requiredRoiValue: number;
  value: string;
};

function sum(values: number[]) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function reconcileRows<T extends GapRowBase>(
  rows: T[],
  params: {
    isGapRow: (row: T) => boolean;
    makeGapRow: (cost: number, requests: number) => T;
    paidRequestCount: number;
    tableLimit: number;
    totalMarketingCost: number;
  },
): T[] {
  if (params.tableLimit > 0 && rows.length >= params.tableLimit) return rows;
  const missingCost = params.totalMarketingCost - sum(rows.map((row) => row.marketingCost));
  if (missingCost <= TOLERANCE_EGP) return rows;
  const missingRequests = Math.max(1, params.paidRequestCount - sum(rows.map((row) => row.requestCount)));

  const existing = rows.findIndex(params.isGapRow);
  if (existing === -1) return [...rows, params.makeGapRow(missingCost, missingRequests)];
  return rows.map((row, index) =>
    index === existing
      ? {
          ...row,
          coverageGap: row.coverageGap + missingCost,
          marketingCost: row.marketingCost + missingCost,
          requestCount: row.requestCount + missingRequests,
        }
      : row,
  );
}

function gapBase(label: string, cost: number, requests: number): GapRowBase {
  return {
    actualRoiCoverage: 0,
    actualSalesUnits: 0,
    actualSalesValue: 0,
    coverageGap: cost,
    customerCount: 0,
    exactSalesRows: 0,
    expectedRoiValue: 0,
    fallbackSalesRows: 0,
    label,
    marketingCost: cost,
    pharmacyCount: 0,
    requestCount: requests,
    requiredRoiValue: 0,
    value: "Unassigned",
  };
}

function comparisonGapRow(label: string) {
  return (cost: number, requests: number): SalesMarketingRoiComparisonRow => ({
    ...gapBase(label, cost, requests),
    behindRequests: 0,
    line: null,
    noDataRequests: requests,
    onTrackRequests: 0,
  });
}

function isUnassigned(row: { label: string; value: string }) {
  return row.value === "Unassigned" || row.label === "Unassigned" || row.label === "Unmapped pharmacy";
}

/** Fold any cost the Region, Distributor and Customer breakdowns lost back in as an Unassigned row. */
export function reconcileMarketingRoiBreakdowns(
  snapshot: SalesMarketingDashboardSnapshot,
): SalesMarketingDashboardSnapshot {
  const common = {
    paidRequestCount: snapshot.summary.paidRequestCount,
    tableLimit: snapshot.limits.tableLimit,
    totalMarketingCost: snapshot.summary.totalMarketingCost,
  };
  return {
    ...snapshot,
    customerImpact: reconcileRows<SalesMarketingCustomerImpactRow>(snapshot.customerImpact, {
      ...common,
      isGapRow: (row) => row.value === "Unassigned",
      makeGapRow: (cost, requests) => ({
        ...gapBase("Unassigned customer", cost, requests),
        distributorCode: null,
        distributorName: null,
        regionName: "Unmapped pharmacy",
        salesRows: 0,
      }),
    }),
    distributorRoi: reconcileRows(snapshot.distributorRoi, {
      ...common,
      isGapRow: isUnassigned,
      makeGapRow: comparisonGapRow("No distributor account"),
    }),
    regionRoi: reconcileRows(snapshot.regionRoi, {
      ...common,
      isGapRow: isUnassigned,
      makeGapRow: comparisonGapRow("Unmapped pharmacy"),
    }),
  };
}
