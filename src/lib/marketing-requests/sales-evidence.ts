import { forbiddenError, notFoundError } from "@/lib/http/api-errors";
import type { AccessContext } from "@/lib/auth/permissions";
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
  customerName: string;
  /** The distributor pharmacy codes this evidence was gathered from — shown so a null result is auditable. */
  matchedPharmacyCodes: string[];
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

const marketingEvidenceRoles = new Set<AccessContext["role"]>([
  "Marketing Manager",
  "SFE Manager",
  "Super Admin",
  "CEO",
]);

function assertSalesEvidenceAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (!marketingEvidenceRoles.has(access.role)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot view marketing sales evidence.`);
  }
}

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
  assertSalesEvidenceAccess(access);

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
  const matchedPharmacyCodes = [...pharmacyCodes].sort();

  // A customer with no validated pharmacy code has no way to be matched to a sales row. Return the
  // empty verdict rather than running a query that would return nothing anyway — and let the panel
  // say WHY it is empty, instead of rendering a bare zero.
  if (matchedPharmacyCodes.length === 0) {
    return {
      ask,
      byDistributor: [],
      byMonth: [],
      byProduct: [],
      customerName,
      matchedPharmacyCodes,
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
      customerName,
      matchedPharmacyCodes,
      verdict: emptyVerdict(),
    };
  }

  type SalesRow = {
    distributor_code: string | null;
    invoice_period: string | null;
    product_name: string | null;
    qty: unknown;
    value: unknown;
  };

  const salesRows: SalesRow[] = [];
  // Both lists are folded into the request URL by PostgREST, so batch each independently.
  for (const codeBatch of chunk(matchedPharmacyCodes)) {
    for (const batchIdBatch of chunk(batchIds as string[])) {
      const rowsResult = await supabase
        .from("source_of_sales_import_rows")
        .select("invoice_period, distributor_code, product_name, qty, value")
        .eq("validation_state", "valid")
        .in("batch_id", batchIdBatch)
        .in("client_code", codeBatch);
      if (rowsResult.error) throw rowsResult.error;
      salesRows.push(...((rowsResult.data ?? []) as SalesRow[]));
    }
  }

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
    customerName,
    matchedPharmacyCodes,
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
