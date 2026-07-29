// Marketing ROI Report — pure, business-friendly classification + grouping for the
// standalone "browse by requester / by customer" report.
//
// IO-free by design (matches the roi-explain.ts precedent) so every mapping rule is unit
// testable directly. Reuses the ALREADY-COMPUTED fields on MarketingRoiReportRow (from
// roi-report-service.ts, unmodified) and, where a request has zero attributed sales, the
// ALREADY-COMPUTED per-request diagnostic reason from roi-explain.ts (unmodified) — no new
// attribution logic, no new enums feeding the DB, purely a display-layer simplification.

import { roundMarketingMoney } from "@/lib/marketing-requests/roi";
import type { RoiExplainReason } from "@/lib/marketing-requests/roi-explain";
import type { MarketingRoiReportRow } from "@/lib/marketing-requests/roi-report-types";

export type SimpleRoiStatus = "good" | "behind" | "data_pending" | "no_sales" | "needs_review";

export type RoiMainProblem =
  | "data_pending"
  | "no_validated_sos_data"
  | "pharmacy_code_missing"
  | "no_sales_for_target_products"
  | "product_mapping_issue"
  | "sales_found";

export type RoiNextAction =
  | "no_action"
  | "wait_for_next_sos_upload"
  | "review_pharmacy_code"
  | "review_product_mapping"
  | "investigate_low_sales";

export const SIMPLE_ROI_STATUS_LABEL: Record<SimpleRoiStatus, string> = {
  good: "Good",
  behind: "Behind",
  data_pending: "Data Pending",
  no_sales: "No Sales",
  needs_review: "Needs Review",
};

export const ROI_MAIN_PROBLEM_LABEL: Record<RoiMainProblem, string> = {
  data_pending: "Data pending",
  no_validated_sos_data: "No validated SoS data",
  pharmacy_code_missing: "Pharmacy code missing",
  no_sales_for_target_products: "No sales found for target products",
  product_mapping_issue: "Product mapping issue",
  sales_found: "Sales found",
};

export const ROI_NEXT_ACTION_LABEL: Record<RoiNextAction, string> = {
  no_action: "No action",
  wait_for_next_sos_upload: "Wait for next SoS upload",
  review_pharmacy_code: "Review pharmacy code",
  review_product_mapping: "Review product mapping",
  investigate_low_sales: "Investigate low sales",
};

/**
 * Business status/problem when a request's ROI window isn't fully backed by validated SoS
 * data yet — always "the system just hasn't caught up," never a data-quality problem.
 */
function resolveForPendingWindow(dataCoverage: MarketingRoiReportRow["dataCoverage"]): {
  status: SimpleRoiStatus;
  problem: RoiMainProblem;
} {
  return dataCoverage === "partial_pending"
    ? { problem: "data_pending", status: "data_pending" }
    : { problem: "no_validated_sos_data", status: "data_pending" };
}

/**
 * Fast, bulk-only fallback (no per-request explain call) — used while the precise explain
 * diagnostic hasn't loaded yet, or for the small number of requests we don't bother explaining
 * because they already have attributed sales. Only reads fields the bulk ROI report already
 * returns: dataCoverage, hasSalesData, distributorCodes, productCodes, actual vs required.
 */
export function resolveMainProblemFallback(
  row: Pick<MarketingRoiReportRow, "dataCoverage" | "hasSalesData" | "distributorCodes" | "productCodes" | "actualSalesValue" | "requiredRoiValue">,
): { status: SimpleRoiStatus; problem: RoiMainProblem } {
  if (row.dataCoverage !== "complete") return resolveForPendingWindow(row.dataCoverage);

  if (!row.hasSalesData) {
    if (row.distributorCodes.length === 0) return { problem: "pharmacy_code_missing", status: "needs_review" };
    if (row.productCodes.length === 0) return { problem: "product_mapping_issue", status: "needs_review" };
    return { problem: "no_sales_for_target_products", status: "no_sales" };
  }

  return row.actualSalesValue >= row.requiredRoiValue
    ? { problem: "sales_found", status: "good" }
    : { problem: "sales_found", status: "behind" };
}

/** Exact mapping from the per-request Explain ROI diagnostic (roi-explain.ts, unmodified) to
 *  the business Main Problem — used whenever the explain reason has been fetched, since it is
 *  strictly more precise than the bulk-only fallback above (it actually checked whether each
 *  target pharmacy code exists in SoS and each product bridges to a SoS product). */
export function resolveMainProblemFromExplainReason(
  reason: RoiExplainReason,
  row: Pick<MarketingRoiReportRow, "actualSalesValue" | "requiredRoiValue">,
): { status: SimpleRoiStatus; problem: RoiMainProblem } {
  switch (reason) {
    case "attributed":
      return row.actualSalesValue >= row.requiredRoiValue
        ? { problem: "sales_found", status: "good" }
        : { problem: "sales_found", status: "behind" };
    case "missing_pharmacy_code":
      return { problem: "pharmacy_code_missing", status: "needs_review" };
    case "product_bridge_issue":
      return { problem: "product_mapping_issue", status: "needs_review" };
    case "pharmacy_no_product_sales":
      return { problem: "no_sales_for_target_products", status: "no_sales" };
    case "no_validated_coverage":
      return { problem: "no_validated_sos_data", status: "data_pending" };
    case "partial_data_pending":
      return { problem: "data_pending", status: "data_pending" };
    default:
      return { problem: "no_sales_for_target_products", status: "no_sales" };
  }
}

export function resolveNextAction(problem: RoiMainProblem): RoiNextAction {
  switch (problem) {
    case "sales_found":
      return "no_action";
    case "data_pending":
    case "no_validated_sos_data":
      return "wait_for_next_sos_upload";
    case "pharmacy_code_missing":
      return "review_pharmacy_code";
    case "product_mapping_issue":
      return "review_product_mapping";
    case "no_sales_for_target_products":
      return "investigate_low_sales";
    default:
      return "no_action";
  }
}

export type RoiBusinessRow = MarketingRoiReportRow & {
  simpleStatus: SimpleRoiStatus;
  mainProblem: RoiMainProblem;
  nextAction: RoiNextAction;
  /** present only when the per-request Explain ROI diagnostic was fetched for this row
   *  (zero-attributed-sales rows only — see roi-business-report-service.ts). */
  explainReason: RoiExplainReason | null;
};

/** Compose one business-friendly row. Pure — the explain reason (if any) must already have
 *  been fetched by the caller; this function never performs IO. */
export function buildRoiBusinessRow(row: MarketingRoiReportRow, explainReason: RoiExplainReason | null): RoiBusinessRow {
  const { problem, status } = explainReason
    ? resolveMainProblemFromExplainReason(explainReason, row)
    : resolveMainProblemFallback(row);

  return {
    ...row,
    explainReason,
    mainProblem: problem,
    nextAction: resolveNextAction(problem),
    simpleStatus: status,
  };
}

export type RoiRequesterOption = { hrId: string; name: string; requestCount: number };
export type RoiCustomerOption = { name: string; requestCount: number };

/** Distinct requesters who have at least one visible marketing request, sorted by name. */
export function groupRoiRowsByRequester(rows: MarketingRoiReportRow[]): RoiRequesterOption[] {
  const byHrId = new Map<string, RoiRequesterOption>();
  for (const row of rows) {
    const existing = byHrId.get(row.requesterHrId);
    if (existing) {
      existing.requestCount += 1;
    } else {
      byHrId.set(row.requesterHrId, {
        hrId: row.requesterHrId,
        name: row.requesterName ?? row.requesterHrId,
        requestCount: 1,
      });
    }
  }
  return Array.from(byHrId.values()).sort((left, right) => left.name.localeCompare(right.name));
}

/** Distinct customers who have at least one visible marketing request, sorted by name. */
export function groupRoiRowsByCustomer(rows: MarketingRoiReportRow[]): RoiCustomerOption[] {
  const byName = new Map<string, RoiCustomerOption>();
  for (const row of rows) {
    const existing = byName.get(row.customerName);
    if (existing) {
      existing.requestCount += 1;
    } else {
      byName.set(row.customerName, { name: row.customerName, requestCount: 1 });
    }
  }
  return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
}

// ── ROI cohorts — the "who/what actually returns" slice ───────────────────────
// ROI-weighted aggregates across the report's own dimensions: cost, required, expected
// (forecast) and actual, plus the two derived ratios execs ask for — coverage (actual/required)
// and EFFICIENCY (actual/cost = EGP returned per EGP spent) — and, per cohort, forecast accuracy
// (actual/expected). Pure + IO-free: computed from the rows the report already produced, so it
// adds no query and is unit-testable directly.

export type RoiCohortRow = {
  key: string;
  label: string;
  requestCount: number;
  totalCost: number;
  totalRequired: number;
  totalExpected: number;
  totalActual: number;
  /** actual / required (0..1+). */
  coverageRatio: number;
  /** actual / cost — EGP returned per EGP spent. The efficiency-league metric. */
  efficiencyRatio: number;
  /** actual / expected forecast (1 = spot on). null when there is no forecast to score against. */
  forecastAccuracyRatio: number | null;
};

export type RoiCohorts = {
  byRequestType: RoiCohortRow[];
  byRequester: RoiCohortRow[];
  byApproverRole: RoiCohortRow[];
  byLine: RoiCohortRow[];
  byRegion: RoiCohortRow[];
};

function roiRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

// Aggregate rows into cohorts. `keysOf` returns 0+ (key,label) pairs per row, so a multi-valued
// dimension (a request approved by several roles) lands in each of its cohorts — totals for such a
// dimension can therefore sum above the grand total, by design. Sorted by the chosen metric desc,
// except "label" which sorts alphabetically.
function aggregateRoiCohort(
  rows: MarketingRoiReportRow[],
  keysOf: (row: MarketingRoiReportRow) => Array<{ key: string; label: string }>,
  sortBy: "actual" | "efficiency" | "label",
): RoiCohortRow[] {
  const acc = new Map<string, { label: string; count: number; cost: number; required: number; expected: number; actual: number }>();
  for (const row of rows) {
    for (const { key, label } of keysOf(row)) {
      const bucket = acc.get(key) ?? { label, count: 0, cost: 0, required: 0, expected: 0, actual: 0 };
      bucket.count += 1;
      bucket.cost += row.estimatedCost;
      bucket.required += row.requiredRoiValue;
      bucket.expected += row.expectedRoiValue;
      bucket.actual += row.actualSalesValue;
      acc.set(key, bucket);
    }
  }
  const cohorts: RoiCohortRow[] = Array.from(acc.entries()).map(([key, bucket]) => ({
    key,
    label: bucket.label,
    requestCount: bucket.count,
    totalCost: roundMarketingMoney(bucket.cost),
    totalRequired: roundMarketingMoney(bucket.required),
    totalExpected: roundMarketingMoney(bucket.expected),
    totalActual: roundMarketingMoney(bucket.actual),
    coverageRatio: roiRatio(bucket.actual, bucket.required),
    efficiencyRatio: roiRatio(bucket.actual, bucket.cost),
    forecastAccuracyRatio: bucket.expected > 0 ? roiRatio(bucket.actual, bucket.expected) : null,
  }));
  return cohorts.sort((a, z) =>
    sortBy === "label"
      ? a.label.localeCompare(z.label)
      : sortBy === "efficiency"
        ? z.efficiencyRatio - a.efficiencyRatio
        : z.totalActual - a.totalActual,
  );
}

/** ROI-weighted cohorts across the report dimensions — the answer to "which request type,
 *  requester, approver role, line or region actually returns, and how efficiently". Pure; call it
 *  on the rows the report already returned. line/region are sorted by efficiency (the league),
 *  the rest by realized actual. */
export function buildRoiCohorts(rows: MarketingRoiReportRow[]): RoiCohorts {
  return {
    byRequestType: aggregateRoiCohort(rows, (row) => [{ key: row.requestTypeName ?? "—", label: row.requestTypeName ?? "Unspecified type" }], "actual"),
    byRequester: aggregateRoiCohort(rows, (row) => [{ key: row.requesterHrId, label: row.requesterName ?? row.requesterHrId }], "actual"),
    byApproverRole: aggregateRoiCohort(
      rows,
      (row) => (row.approverRoleKeys.length > 0 ? row.approverRoleKeys : ["(none)"]).map((role) => ({ key: role, label: role })),
      "actual",
    ),
    byLine: aggregateRoiCohort(rows, (row) => [{ key: row.line ?? "—", label: row.line ?? "Unspecified line" }], "efficiency"),
    byRegion: aggregateRoiCohort(rows, (row) => [{ key: row.region ?? "—", label: row.region ?? "Unspecified region" }], "efficiency"),
  };
}
