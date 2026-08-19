import { forbiddenError, notFoundError } from "@/lib/http/api-errors";
import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { pharmacyCodeLookupSet } from "@/lib/marketing-requests/pharmacy-code-match";
import {
  canViewRestrictedProducts,
  isRestrictedProductCode,
  normalizeProductNameKey,
  RESTRICTED_PRODUCT_NAME_FALLBACKS,
} from "@/lib/sales/access-scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Historical sales evidence for the customer behind a marketing request.
 *
 * The SFE Validation step exists to answer one question — "is this customer worth spending on?" —
 * and until now the approver had nothing to answer it with. This assembles the evidence the step
 * was always supposed to have: does this customer's pharmacies have any sales history at all, and
 * if so how much, over how many months, across which products and distributors.
 *
 * Deliberately NOT scoped to the request's promoted products or its ROI window (that is what
 * MarketingRequestSalesView already does, after the fact). Validation needs the customer's FULL
 * history, including products this request does not promote — a pharmacy that buys nothing today
 * is a different bet from one already turning over stock.
 */

/** One month of the customer's history. */
export type SalesEvidenceMonth = {
  period: string;
  qty: number;
  value: number;
};

export type SalesEvidenceBreakdown = {
  label: string;
  qty: number;
  value: number;
};

export type MarketingSalesEvidence = {
  /** The request's ask, so the approver can weigh it against the history without leaving. */
  ask: {
    estimatedCost: number;
    requestCode: string;
    requiredRoiValue: number;
    roiCoverageRatio: number | null;
    roiDurationMonths: number;
    roiStatus: string | null;
  };
  byDistributor: SalesEvidenceBreakdown[];
  byMonth: SalesEvidenceMonth[];
  byProduct: SalesEvidenceBreakdown[];
  /** True when confidential products were excluded from every figure here for this viewer. */
  confidentialProductsWithheld: boolean;
  customerName: string;
  /** The distributor pharmacy codes this evidence was gathered from — shown so a null result is auditable. */
  matchedPharmacyCodes: string[];
  /**
   * The same history narrowed to the products THIS request is promoting.
   *
   * The whole-customer figure flatters a request badly. On MKT-REQ-20260802-DCF31EC4 the customer
   * had traded EGP 2,774 over six months — but of the five promoted products only ONE had ever
   * sold there, once, for EGP 79. The customer buys Tebofortine 40mg (TE003); the request promotes
   * Tebofortine Forte 80 (TE002) and Tebofortin 120 (TE005). Same family, different SKUs — and an
   * approver reading only the customer total would never see that.
   */
  requested: {
    /** Requested products with no recorded sale at this customer — the headline risk. */
    neverSold: string[];
    productCount: number;
    /** Requested products that HAVE sold here, biggest first. */
    sold: SalesEvidenceBreakdown[];
    totalQty: number;
    totalValue: number;
  };
  /**
   * The judgement the panel leads with. `projectedOverWindow` extrapolates the observed monthly
   * run-rate across the request's own ROI window, so "is this reachable?" is answerable at a
   * glance instead of being arithmetic the approver has to do in their head.
   */
  verdict: {
    activeMonths: number;
    distributorCount: number;
    hasHistory: boolean;
    monthlyRunRate: number;
    productCount: number;
    projectedOverWindow: number;
    /** Positive when the projection falls short of the required ROI. */
    projectedShortfall: number;
    totalQty: number;
    totalValue: number;
  };
};

/**
 * Company-wide oversight: roles whose remit covers EVERY marketing request, so they may read this
 * evidence without being named on the request itself.
 */
const marketingEvidenceRoles = new Set<AccessContext["role"]>([
  "Marketing Manager",
  "SFE Manager",
  "Super Admin",
  "CEO",
]);

/**
 * The company-wide half of the gate, as a pure predicate — no request, no database.
 *
 * Split out so the rule is directly executable in a test instead of being asserted against source
 * text. Answers only "may this role read ANY request's evidence?"; being an approver on ONE request
 * is the separate, per-request path in assertSalesEvidenceAccess below.
 */
export function canReadMarketingSalesEvidenceByRole(access: AccessContext): boolean {
  if (access.scope === "system") return true;
  return marketingEvidenceRoles.has(access.role);
}

/**
 * Who may read a request's sales evidence.
 *
 * A hard-coded role list was the whole gate, and it locked out the first rung of the live chain:
 * National Sales Manager -> SFE Manager -> Marketing Manager -> CEO. The NSM was 403'd and decided
 * with no sales history at all. The chain is CONFIGURABLE per request, so adding more role names
 * would only drift again — the question that actually matters is "is this person an approver on
 * THIS request?", so that is what we ask.
 *
 * Deliberately NOT filtered on `is_cc` or on step status: a CC/advisory reviewer (Product Manager /
 * Group Product Manager) is asked to advise on the spend and currently sees nothing, and an
 * approver whose rung has not opened yet should be able to read ahead rather than meet the evidence
 * for the first time at the moment they must decide.
 *
 * FAILS CLOSED throughout: no HR_ID and a failed steps lookup both deny. Neither ever falls
 * through to allow.
 */
async function assertSalesEvidenceAccess(requestId: string, access: AccessContext): Promise<void> {
  if (canReadMarketingSalesEvidenceByRole(access)) return;

  const denied = forbiddenError(`Forbidden: ${access.role} cannot view marketing sales evidence.`);

  // Fail closed: an actor with no HR_ID can never be matched to an approval step, so there is
  // nothing left to check.
  const actorHrId = String(access.hrId ?? "").trim();
  if (!actorHrId) throw denied;

  const supabase = getSupabaseAdmin();
  // `assigned_hr_id` is stored in the employee master's real casing while the session id is
  // lower-cased — match every HR_ID dialect, the same way getApproverPendingRequests does against
  // this table, or a real approver silently reads as "not on this request".
  const stepResult = await supabase
    .from("marketing_request_approval_steps")
    .select("id")
    .eq("request_id", requestId)
    .in("assigned_hr_id", hrIdLookupKeys(actorHrId))
    .limit(1);
  // Fail closed: a lookup error means "unknown", not "not an approver". Rethrow rather than let an
  // unreadable steps table widen access to the sales history.
  if (stepResult.error) throw stepResult.error;
  if ((stepResult.data ?? []).length === 0) throw denied;
}

/**
 * Strip the confidential products from raw sales rows.
 *
 * Products LA003 / LA004 ("Lacto Basic 1 & 2") and SS001 ("Satoslim") are excluded from every
 * total, KPI, chart, table, filter and export for everyone except CEO / Super Admin — see
 * src/lib/sales/access-scope.ts, which owns that rule. This panel read source_of_sales_import_rows
 * with NO product filter at all, so a Marketing Manager or SFE Manager (neither permitted to see
 * them) could reach them here.
 *
 * Gated ONLY on `canViewRestrictedProducts(role)`. There is deliberately no `scope === "system"`
 * bypass: the locked rule is role-based, and a scope bypass would reopen the leak for every
 * non-CEO role whose context happens to be system-scoped.
 *
 * Pure — no DB, no access context — so the rule is unit-testable directly.
 */
export function stripConfidentialSalesRows<T extends { product_code?: string | null }>(
  rows: T[],
  role: AccessContext["role"],
): { rows: T[]; withheld: boolean } {
  if (canViewRestrictedProducts(role)) return { rows, withheld: false };
  const kept = rows.filter((row) => !isRestrictedProductCode(row.product_code));
  return { rows: kept, withheld: kept.length !== rows.length };
}

/** Confidential product names, for the snapshot fallback below where no product code survives. */
const restrictedProductNameFallbackKeys = new Set<string>(
  RESTRICTED_PRODUCT_NAME_FALLBACKS.map(normalizeProductNameKey),
);

/**
 * PostgREST folds every `.in()` value into the request URL, and an unbatched list of a few hundred
 * ids can push it past undici's ~16KB header limit ("TypeError: fetch failed"). Same guard the
 * marketing service uses; kept local rather than exported to avoid widening its surface.
 */
function chunk<T>(items: T[], size = 100): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function cleanProductName(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim() || "Unnamed product";
}

/** Sum into a label-keyed bucket, then return it sorted by value, biggest first. */
function foldBreakdown(rows: Array<{ label: string; qty: number; value: number }>): SalesEvidenceBreakdown[] {
  const totals = new Map<string, { qty: number; value: number }>();
  for (const row of rows) {
    const key = row.label || "Unknown";
    const current = totals.get(key) ?? { qty: 0, value: 0 };
    totals.set(key, { qty: current.qty + row.qty, value: current.value + row.value });
  }
  return [...totals.entries()]
    .map(([label, totalsForLabel]) => ({
      label,
      qty: round2(totalsForLabel.qty),
      value: round2(totalsForLabel.value),
    }))
    .sort((left, right) => right.value - left.value);
}

export async function getMarketingSalesEvidence(
  requestId: string,
  access: AccessContext,
): Promise<MarketingSalesEvidence> {
  // Stays the FIRST statement — no customer or sales data is read until access is settled.
  await assertSalesEvidenceAccess(requestId, access);

  const supabase = getSupabaseAdmin();

  const requestResult = await supabase
    .from("marketing_requests")
    .select("id, request_code, customer_id, estimated_cost, required_roi_value, roi_coverage_ratio, roi_duration_months, roi_status")
    .eq("id", requestId)
    .maybeSingle();
  if (requestResult.error) throw requestResult.error;
  if (!requestResult.data) throw notFoundError("Marketing request was not found.", "request_not_found");

  const request = requestResult.data as {
    customer_id: string;
    estimated_cost: unknown;
    request_code: string;
    required_roi_value: unknown;
    roi_coverage_ratio: unknown;
    roi_duration_months: unknown;
    roi_status: string | null;
  };

  const [customerResult, linksResult] = await Promise.all([
    supabase.from("marketing_customers").select("display_name").eq("id", request.customer_id).maybeSingle(),
    supabase
      .from("marketing_customer_pharmacies")
      .select("distributor_code_id")
      .eq("customer_id", request.customer_id)
      .or("active.is.null,active.eq.true"),
  ]);
  if (customerResult.error) throw customerResult.error;
  if (linksResult.error) throw linksResult.error;

  const codeIds = ((linksResult.data ?? []) as Array<{ distributor_code_id: string | null }>)
    .map((row) => row.distributor_code_id)
    .filter((id): id is string => Boolean(id));

  const pharmacyCodes = new Set<string>();
  for (const batch of chunk(codeIds)) {
    const codesResult = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("distributor_pharmacy_code")
      .in("id", batch);
    if (codesResult.error) throw codesResult.error;
    for (const row of (codesResult.data ?? []) as Array<{ distributor_pharmacy_code: string | null }>) {
      const code = String(row.distributor_pharmacy_code ?? "").trim().toUpperCase();
      if (code) pharmacyCodes.add(code);
    }
  }

  const ask = {
    estimatedCost: round2(toNumber(request.estimated_cost)),
    requestCode: request.request_code,
    requiredRoiValue: round2(toNumber(request.required_roi_value)),
    roiCoverageRatio: request.roi_coverage_ratio === null || request.roi_coverage_ratio === undefined
      ? null
      : toNumber(request.roi_coverage_ratio),
    roiDurationMonths: Math.max(1, Math.round(toNumber(request.roi_duration_months)) || 1),
    roiStatus: request.roi_status ?? null,
  };
  const customerName = (customerResult.data as { display_name: string | null } | null)?.display_name ?? "Unknown customer";
  // What the rep registered, shown to the approver as they typed it.
  const matchedPharmacyCodes = [...pharmacyCodes].sort();
  // What the sales table is actually searched for. The same pharmacy is written `1548234` here and
  // `0001548234` in Source of Sales, so matching on the entered spelling alone reported a hard zero
  // for customers with years of trade — see pharmacy-code-match.ts.
  const lookupPharmacyCodes = pharmacyCodeLookupSet(pharmacyCodes);

  // A customer with no validated pharmacy code has no way to be matched to a sales row. Return the
  // empty verdict rather than running a query that would return nothing anyway — and let the panel
  // say WHY it is empty, instead of rendering a bare zero.
  if (matchedPharmacyCodes.length === 0) {
    return {
      ask,
      byDistributor: [],
      byMonth: [],
      byProduct: [],
      confidentialProductsWithheld: false,
      customerName,
      matchedPharmacyCodes,
      requested: emptyRequested(),
      verdict: emptyVerdict(),
    };
  }

  // Only rows that are BOTH valid and inside a validated batch count — the same gate marketing ROI
  // attribution uses. Anything looser would show the approver numbers the ROI engine will not honour.
  const validatedBatches = await supabase
    .from("source_of_sales_import_batches")
    .select("id")
    .eq("status", "validated");
  if (validatedBatches.error) throw validatedBatches.error;
  const batchIds = ((validatedBatches.data ?? []) as Array<{ id: string | number }>).map((row) => row.id);
  if (batchIds.length === 0) {
    return {
      ask,
      byDistributor: [],
      byMonth: [],
      byProduct: [],
      confidentialProductsWithheld: false,
      customerName,
      matchedPharmacyCodes,
      requested: emptyRequested(),
      verdict: emptyVerdict(),
    };
  }

  type SalesRow = {
    distributor_code: string | null;
    invoice_period: string | null;
    product_code: string | null;
    product_name: string | null;
    qty: unknown;
    value: unknown;
  };

  const salesRows: SalesRow[] = [];
  // Confidential products are stripped HERE, as the rows arrive — not at the end. Everything below
  // (byMonth, byProduct, byDistributor, the requested block, the verdict run-rate and projection)
  // is derived from `salesRows`, so filtering at the source is what keeps a restricted product out
  // of every figure rather than out of one table.
  let confidentialProductsWithheld = false;
  // Both lists are folded into the request URL by PostgREST, so batch each independently.
  for (const codeBatch of chunk(lookupPharmacyCodes)) {
    for (const batchIdBatch of chunk(batchIds as string[])) {
      const rowsResult = await supabase
        .from("source_of_sales_import_rows")
        .select("invoice_period, distributor_code, product_code, product_name, qty, value")
        .eq("validation_state", "valid")
        .in("batch_id", batchIdBatch)
        .in("client_code", codeBatch);
      if (rowsResult.error) throw rowsResult.error;
      const visible = stripConfidentialSalesRows((rowsResult.data ?? []) as SalesRow[], access.role);
      if (visible.withheld) confidentialProductsWithheld = true;
      salesRows.push(...visible.rows);
    }
  }

  // ── The request's own products, matched to this customer's history by product CODE ──
  // Code, not name: "Tebofortine Forte 80" and "Tebofortine 40 mg" read as the same family to a
  // human but are different SKUs, and a name match would quietly credit one to the other.
  const requestProductsResult = await supabase
    .from("marketing_request_products")
    .select("product_id, product_name_snapshot")
    .eq("request_id", requestId);
  if (requestProductsResult.error) throw requestProductsResult.error;
  const requestProductRows = (requestProductsResult.data ?? []) as Array<{
    product_id: number | string | null;
    product_name_snapshot: string | null;
  }>;

  const requestedProductIds = requestProductRows
    .map((row) => row.product_id)
    .filter((id): id is number | string => id !== null && id !== undefined);
  const canSeeConfidential = canViewRestrictedProducts(access.role);
  const requestedByCode = new Map<string, string>();
  // Counted before the confidential filter, so "the master had nothing for this id" (fall back to
  // the snapshot name) stays distinguishable from "the master answered but this viewer may not see
  // the product" (show nothing).
  let requestedMasterCodeCount = 0;
  for (const batch of chunk(requestedProductIds)) {
    const productsResult = await supabase
      .from("marketing_products")
      .select("id, product_code, product_name")
      .in("id", batch);
    if (productsResult.error) throw productsResult.error;
    for (const row of (productsResult.data ?? []) as Array<{
      product_code: string | null;
      product_name: string | null;
    }>) {
      const code = String(row.product_code ?? "").trim().toUpperCase();
      if (!code) continue;
      requestedMasterCodeCount += 1;
      // Defensive: no marketing_products row carries a restricted code today, so no live request
      // promotes one. If one ever does, a viewer who may not see it must find it in NEITHER list —
      // reporting it under "never sold here" would both name the product and state something false
      // about it, since its sales were stripped from the history above.
      if (!canSeeConfidential && isRestrictedProductCode(code)) {
        confidentialProductsWithheld = true;
        continue;
      }
      requestedByCode.set(code, cleanProductName(row.product_name));
    }
  }
  // Fall back to the snapshot names so a product removed from the master since submission is still
  // named in the "never sold" list rather than vanishing from the count. That path has no product
  // code left to gate on, so match the confidential names instead — the fallback must not become
  // the way a restricted product gets named.
  const requestedProductNames = requestedMasterCodeCount > 0
    ? [...requestedByCode.values()]
    : requestProductRows
        .map((row) => cleanProductName(row.product_name_snapshot))
        .filter((name) => {
          if (canSeeConfidential) return true;
          if (!restrictedProductNameFallbackKeys.has(normalizeProductNameKey(name))) return true;
          confidentialProductsWithheld = true;
          return false;
        });

  const requestedSalesRows = salesRows.filter((row) =>
    requestedByCode.has(String(row.product_code ?? "").trim().toUpperCase()),
  );
  const requestedSold = foldBreakdown(
    requestedSalesRows.map((row) => ({
      label: cleanProductName(row.product_name),
      qty: toNumber(row.qty),
      value: toNumber(row.value),
    })),
  );
  const soldNames = new Set(requestedSold.map((row) => row.label.toLowerCase()));
  const neverSold = requestedProductNames.filter((name) => !soldNames.has(name.toLowerCase()));

  const monthTotals = new Map<string, { qty: number; value: number }>();
  for (const row of salesRows) {
    const period = String(row.invoice_period ?? "").trim();
    if (!period) continue;
    const current = monthTotals.get(period) ?? { qty: 0, value: 0 };
    monthTotals.set(period, {
      qty: current.qty + toNumber(row.qty),
      value: current.value + toNumber(row.value),
    });
  }

  const byMonth = [...monthTotals.entries()]
    .map(([period, totals]) => ({ period, qty: round2(totals.qty), value: round2(totals.value) }))
    .sort((left, right) => left.period.localeCompare(right.period));

  const byProduct = foldBreakdown(
    salesRows.map((row) => ({
      label: String(row.product_name ?? "").trim(),
      qty: toNumber(row.qty),
      value: toNumber(row.value),
    })),
  );
  const byDistributor = foldBreakdown(
    salesRows.map((row) => ({
      label: String(row.distributor_code ?? "").trim(),
      qty: toNumber(row.qty),
      value: toNumber(row.value),
    })),
  );

  const totalValue = round2(byMonth.reduce((sum, row) => sum + row.value, 0));
  const totalQty = round2(byMonth.reduce((sum, row) => sum + row.qty, 0));
  const activeMonths = byMonth.length;
  // Run-rate is per ACTIVE month, not per calendar month in the range: a pharmacy that bought in 3
  // of 6 months has a 3-month run-rate, and averaging over the gaps would understate it.
  const monthlyRunRate = activeMonths > 0 ? round2(totalValue / activeMonths) : 0;
  const projectedOverWindow = round2(monthlyRunRate * ask.roiDurationMonths);

  return {
    ask,
    byDistributor,
    byMonth,
    byProduct,
    confidentialProductsWithheld,
    customerName,
    matchedPharmacyCodes,
    requested: {
      neverSold,
      productCount: requestedProductNames.length,
      sold: requestedSold,
      totalQty: round2(requestedSold.reduce((sum, row) => sum + row.qty, 0)),
      totalValue: round2(requestedSold.reduce((sum, row) => sum + row.value, 0)),
    },
    verdict: {
      activeMonths,
      distributorCount: byDistributor.length,
      hasHistory: activeMonths > 0,
      monthlyRunRate,
      productCount: byProduct.length,
      projectedOverWindow,
      projectedShortfall: round2(Math.max(0, ask.requiredRoiValue - projectedOverWindow)),
      totalQty,
      totalValue,
    },
  };
}

function emptyRequested(): MarketingSalesEvidence["requested"] {
  return { neverSold: [], productCount: 0, sold: [], totalQty: 0, totalValue: 0 };
}

function emptyVerdict(): MarketingSalesEvidence["verdict"] {
  return {
    activeMonths: 0,
    distributorCount: 0,
    hasHistory: false,
    monthlyRunRate: 0,
    productCount: 0,
    projectedOverWindow: 0,
    projectedShortfall: 0,
    totalQty: 0,
    totalValue: 0,
  };
}
