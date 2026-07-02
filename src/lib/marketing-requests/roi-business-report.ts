// Marketing ROI Report — pure, business-friendly classification + grouping for the
// standalone "browse by requester / by customer" report.
//
// IO-free by design (matches the roi-explain.ts precedent) so every mapping rule is unit
// testable directly. Reuses the ALREADY-COMPUTED fields on MarketingRoiReportRow (from
// roi-report-service.ts, unmodified) and, where a request has zero attributed sales, the
// ALREADY-COMPUTED per-request diagnostic reason from roi-explain.ts (unmodified) — no new
// attribution logic, no new enums feeding the DB, purely a display-layer simplification.

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
