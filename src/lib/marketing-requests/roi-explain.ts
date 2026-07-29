// ROI Explainability — pure types + diagnostic classifier for the per-request
// "Explain ROI / Attribution Details" view.
//
// This module is intentionally IO-free so the diagnostic reasoning can be unit-tested
// directly. The read-only data gathering (Supabase SELECTs + the existing view-sales RPC)
// lives in `roi-explain-service.ts`. Nothing here changes the attribution algorithm — it
// only explains, per request, WHY the current actual ROI is what it is.

/** Why a request's actual attributed sales are what they are. `attributed` = there ARE
 *  attributed sales; the other four explain a zero/low actual. */
export type RoiExplainReason =
  | "attributed"
  | "missing_pharmacy_code"
  | "pharmacy_no_product_sales"
  | "product_bridge_issue"
  | "no_validated_coverage"
  | "partial_data_pending";

/** The current attribution counts only exact (distributor + pharmacy code + product +
 *  period) matches, so every attributed ledger row is high confidence. */
export type RoiExplainConfidence = "high";

export const ROI_EXPLAIN_MATCH_REASON = "Exact distributor + pharmacy code + product + period";

export type RoiExplainLedgerRow = {
  /** Stable key for the ledger line — the source_of_sales_import_rows.id when it could be
   *  recovered read-only (see `sosRowId`), otherwise a composite of the attribution grain. */
  ledgerKey: string;
  /** The underlying source_of_sales_import_rows.id. Recovered by a read-only SELECT that
   *  replicates the exact match for THIS request and is only trusted when its total reconciles
   *  to the attribution RPC to the cent; `null` when that recovery didn't reconcile (the ledger
   *  still shows the RPC's authoritative rows, just without the source id). Never changes the RPC. */
  sosRowId: number | null;
  distributorCode: string;
  clientCode: string;
  productCode: string;
  /** display name — the ledger must always show this, never the raw SoS product code. */
  productName: string;
  invoicePeriod: string;
  qty: number;
  valueCounted: number;
  matchReason: string;
  confidence: RoiExplainConfidence;
};

export type RoiExplainProduct = {
  code: string;
  name: string;
  /** whether the marketing product's normalized name resolves to a Source-of-Sales product. */
  matchedToSos: boolean;
  sosProductCode: string | null;
};

export type RoiExplainPharmacy = {
  code: string;
  name: string;
  /** whether this pharmacy code appears in validated SoS under the request's distributors + window. */
  foundInSos: boolean;
};

export type RoiExplainDistributorFamily = {
  marketingDistributor: string;
  parentDistributorCode: string;
  sosDistributorCodes: string[];
};

/**
 * A near miss: real validated sales that failed to attribute because EXACTLY ONE of the four
 * attribution keys did not line up (distributor, pharmacy code, product, invoice period).
 *
 * Attribution is all-or-nothing on those four keys, which makes "no sales found" indistinguishable
 * from "sales found, one key off". That ambiguity is what turned a routine question — do these
 * campaigns have sales? — into a multi-hour investigation. A near miss is not a correction and is
 * never counted in ROI; it is a lead, telling a human exactly which key to look at.
 */
export type RoiNearMissKind =
  /** Right pharmacy, distributor and product — sold outside the ROI window. */
  | "outside_window"
  /** Right pharmacy, distributor and period — a product the request does not promote. */
  | "other_product"
  /** Right pharmacy, product and period — booked under a distributor the request does not target. */
  | "other_distributor"
  /** Every key matches, but the batch carrying it has not been validated yet. */
  | "unvalidated_batch";

export const ROI_NEAR_MISS_LABEL: Record<RoiNearMissKind, string> = {
  other_distributor: "Sold through a distributor this request does not target",
  other_product: "The pharmacy bought other products, not the promoted ones",
  outside_window: "Sold to the right pharmacy, outside the measurement window",
  unvalidated_batch: "Matches on every key, but its sales batch is not validated yet",
};

/** What a reader should actually do about each kind — a lead is only useful if it is actionable. */
export const ROI_NEAR_MISS_ACTION: Record<RoiNearMissKind, string> = {
  other_distributor: "Check whether the request named the right distributor for this pharmacy.",
  other_product: "Check whether the promoted product list matches what this pharmacy actually stocks.",
  outside_window: "Check the pay date and duration — the window may have opened late or closed early.",
  unvalidated_batch: "Validate the Source-of-Sales batch; these sales will then attribute normally.",
};

export type RoiNearMissRow = {
  kind: RoiNearMissKind;
  distributorCode: string;
  clientCode: string;
  productCode: string;
  productName: string;
  invoicePeriod: string;
  qty: number;
  /** What this row WOULD have contributed had the key lined up. Never added to actuals. */
  valueIfMatched: number;
};

export type RoiNearMissGroup = {
  kind: RoiNearMissKind;
  rows: number;
  units: number;
  valueIfMatched: number;
  /** A few representative rows; the full set lives in the export. */
  sample: RoiNearMissRow[];
};

export type RoiNearMissReport = {
  groups: RoiNearMissGroup[];
  totalValueIfMatched: number;
  /** True when a scan hit its row cap, so the figures are a floor rather than a total. */
  truncated: boolean;
};

export type RoiExplainDiagnostic = {
  reason: RoiExplainReason;
  pharmaciesTargeted: number;
  pharmaciesFound: number;
  pharmaciesMissing: number;
  productsTargeted: number;
  productsMatched: number;
  productsUnmatched: number;
  monthsInWindow: number;
  monthsCovered: number;
  monthsPending: number;
  hasAttributedSales: boolean;
};

export type MarketingRoiExplain = {
  summary: {
    requestId: string;
    requestCode: string;
    customerName: string;
    payDate: string | null;
    roiWindowLabel: string | null;
    requiredRoiValue: number;
    expectedRoiValue: number;
    actualSalesValue: number;
    actualCoverageRatio: number;
    salesDataAsOf: string | null;
  };
  targetSetup: {
    products: RoiExplainProduct[];
    pharmacies: RoiExplainPharmacy[];
    distributorFamilies: RoiExplainDistributorFamily[];
    validatedPeriodsInWindow: string[];
    pendingPeriodsInWindow: string[];
  };
  ledger: RoiExplainLedgerRow[];
  diagnostic: RoiExplainDiagnostic;
  /** Sales that failed to attribute on exactly one key. Null when the scan could not run. */
  nearMisses: RoiNearMissReport | null;
  includedRestricted: boolean;
  generatedAtIso: string;
};

/**
 * Classify the single dominant reason for a request's actual attributed sales.
 *
 * Precedence when actual = 0 follows "what has to be true before anything can attribute":
 *  1. a product must bridge to a SoS product — else `product_bridge_issue`;
 *  2. the ROI window must have validated SoS data — else `no_validated_coverage`
 *     (nothing validated anywhere) or `partial_data_pending` (data exists globally but the
 *     window's months aren't loaded yet);
 *  3. a targeted pharmacy code must exist in SoS — else `missing_pharmacy_code`;
 *  4. otherwise the pharmacies are present but simply didn't buy the targeted products →
 *     `pharmacy_no_product_sales` (a real, correctly-attributed zero).
 */
export function classifyRoiExplainReason(input: {
  actualValue: number;
  productsTargeted: number;
  productsMatched: number;
  pharmaciesFound: number;
  monthsCovered: number;
  salesDataAsOf: string | null;
}): RoiExplainReason {
  if (input.actualValue > 0) return "attributed";
  if (input.productsTargeted > 0 && input.productsMatched === 0) return "product_bridge_issue";
  if (input.monthsCovered === 0) {
    return input.salesDataAsOf === null ? "no_validated_coverage" : "partial_data_pending";
  }
  if (input.pharmaciesFound === 0) return "missing_pharmacy_code";
  return "pharmacy_no_product_sales";
}

export const ROI_EXPLAIN_REASON_LABEL: Record<RoiExplainReason, string> = {
  attributed: "Attributed sales found",
  missing_pharmacy_code: "Target pharmacy code missing from Source of Sales",
  pharmacy_no_product_sales: "Pharmacy found, but no targeted product sales",
  product_bridge_issue: "Product could not be matched to a Source-of-Sales product",
  no_validated_coverage: "No validated Source-of-Sales data for the ROI window",
  partial_data_pending: "ROI window data is still pending validation",
};

export function roiExplainReasonLabel(reason: RoiExplainReason): string {
  return ROI_EXPLAIN_REASON_LABEL[reason];
}
