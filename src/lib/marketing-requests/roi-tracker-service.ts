// ─────────────────────────────────────────────────────────────────────────────
// ROI Tracker — the single, complete per-request ROI picture.
//
// THIS MODULE ADDS NO ATTRIBUTION LOGIC. That is the entire point of it.
//
// The marketing module accumulated four ROI surfaces (ROI Dashboard, ROI Tracking,
// Marketing ROI Report, Coverage Report) sitting on three different SQL engines, and they
// disagreed with each other — most visibly, the executive dashboard scored every campaign
// still inside its measurement window as "behind", which put ~EGP 313k of healthy spend on a
// red "Spend At Risk" tile. A fifth engine would have made that worse.
//
// So this composes the ALREADY-AUTHORITATIVE pieces and adds only presentation:
//   getMarketingRoiReport      -> rows + KPI band  (phx_marketing_request_roi_actuals_v2)
//   loadMarketingRoiExportDetail -> products, target pharmacies, approval chain
//   + pharmacy code-reference state, the data-quality signal described below
//
// Because the rows come from getMarketingRoiReport verbatim, this page can never disagree
// with ROI Tracking about a number. If it ever does, that is a bug in the composition, not a
// second opinion.
//
// Role scoping, confidential-product masking (LA003/LA004/SS001) and the CEO/Super-Admin
// reveal clamp are all inherited from getMarketingRoiReport — none of it is re-implemented.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import {
  buildKpiBand,
  getMarketingRoiReport,
  loadMarketingRoiExportDetail,
  logRoiServiceFailure,
} from "@/lib/marketing-requests/roi-report-service";
import type {
  MarketingRoiExportApprovalRow,
  MarketingRoiExportProductRow,
  MarketingRoiKpiBand,
  MarketingRoiReportRow,
  RoiFilterState,
} from "@/lib/marketing-requests/roi-report-types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * How trustworthy a target pharmacy's distributor code is, per the marketing pharmacy
 * code-reference database.
 *
 * This is the module's best early warning that a target code is wrong, and until now it was
 * invisible on every ROI surface. Measured on production 2026-07-28: a code the reference
 * database cannot find has no sales 27.9% of the time, versus 1.3% for a matched code — ~21x
 * worse. Surfacing it here is what lets a reader tell "this campaign genuinely sold nothing"
 * apart from "this campaign is pointed at a pharmacy code that does not exist".
 */
export type RoiTrackerPharmacyRow = {
  pharmacyName: string;
  customerCode: string;
  distributorCode: string | null;
  /** Resolved from the Source-of-Sales distributor master; falls back to the code. */
  distributorName: string | null;
  trackingStatus: string | null;
  /** matched | ambiguous | not_found | pending (pending = never validated). */
  referenceStatus: string;
  /** True when the code is suspect — surfaced as a warning chip rather than hidden. */
  referenceSuspect: boolean;
};

/** One request, with everything a reader needs to judge it, in one object. */
export type RoiTrackerRow = MarketingRoiReportRow & {
  products: MarketingRoiExportProductRow[];
  pharmacies: RoiTrackerPharmacyRow[];
  approvals: MarketingRoiExportApprovalRow[];
  /** Gap to the required return; 0 once covered. */
  coverageGap: number;
  /** Target pharmacy codes the reference database could not confirm. */
  suspectPharmacyCount: number;
};

export type RoiTrackerReport = {
  generatedAt: string;
  rows: RoiTrackerRow[];
  kpi: MarketingRoiKpiBand;
  includedRestricted: boolean;
  salesDataAsOf: string | null;
  /** Requests whose targets include at least one unverifiable pharmacy code. */
  requestsWithSuspectCodes: number;
};

const SUSPECT_REFERENCE_STATES = new Set(["not_found", "ambiguous", "pending"]);

/**
 * Which provenance this tracker reports on. The two are deliberately separate modules:
 * `phoenix` requests are validated as they are created (the Customer Validation UI runs the
 * pharmacy code-reference check), while `xlsx_import` requests were bulk-loaded without that
 * check and carry no live approval chain. Reporting them together would drag genuine Phoenix
 * performance down with legacy data quality — see 20260728124544_marketing_requests_origin_split.
 */
export type MarketingRequestOrigin = "phoenix" | "xlsx_import";

/** id -> origin for the rows in play. One small query; the column is indexed. */
async function loadOriginByRequestId(requestIds: string[]): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const byId = new Map<string, string>();
  for (let from = 0; from < requestIds.length; from += 300) {
    const part = requestIds.slice(from, from + 300);
    const { data, error } = await supabase
      .from("marketing_requests")
      .select("id, origin")
      .in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; origin: string | null }>) {
      byId.set(row.id, (row.origin ?? "phoenix").trim().toLowerCase());
    }
  }
  return byId;
}

/**
 * Pharmacy code-reference state keyed by normalized customer code. One query for the whole
 * page rather than per request — the table is small (287 rows in production) and this avoids
 * an N+1 across the result set.
 */
async function loadPharmacyReferenceState(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_pharmacy_distributor_codes")
    .select("normalized_pharmacy_code, reference_status");
  if (error) throw error;

  const byCode = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ normalized_pharmacy_code: string | null; reference_status: string | null }>) {
    const key = (row.normalized_pharmacy_code ?? "").trim().toLowerCase();
    if (!key) continue;
    // A pharmacy code can be registered against more than one distributor. Keep the WORST
    // state so a suspect link is never masked by a healthy sibling.
    const next = (row.reference_status ?? "pending").trim().toLowerCase();
    const current = byCode.get(key);
    if (!current || (SUSPECT_REFERENCE_STATES.has(next) && !SUSPECT_REFERENCE_STATES.has(current))) {
      byCode.set(key, next);
    }
  }
  return byCode;
}

/**
 * Distributor code -> display name, from the Source-of-Sales distributor master.
 *
 * The target-pharmacy record carries only a distributor CODE, which is unreadable in an export.
 * One small query for the whole page; unknown codes fall back to the code itself rather than
 * going blank, so a distributor missing from the master is still visible.
 */
async function loadDistributorNames(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_distributors")
    .select("distributor_code, distributor_name");
  if (error) throw error;

  const byCode = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ distributor_code: string | null; distributor_name: string | null }>) {
    const key = (row.distributor_code ?? "").trim().toUpperCase();
    const name = (row.distributor_name ?? "").trim();
    if (key && name) byCode.set(key, name);
  }
  return byCode;
}

/**
 * The complete ROI picture for every request the caller may see, under `filters`.
 *
 * Access, scoping and masking are enforced inside getMarketingRoiReport — this function must
 * never widen them.
 */
export async function getMarketingRoiTracker(
  access: AccessContext,
  filters: RoiFilterState,
  generatedAtIso: string,
  origin: MarketingRequestOrigin = "phoenix",
): Promise<RoiTrackerReport> {
  const full = await getMarketingRoiReport(access, filters, generatedAtIso);

  // Split by provenance. Rows come from the authoritative engine untouched; only the SET of rows
  // narrows. The KPI band is then rebuilt with buildKpiBand — the very function the report service
  // uses — so the totals can never drift from the rows they summarise.
  const originById = await loadOriginByRequestId(full.rows.map((row) => row.requestId));
  const scopedRows = full.rows.filter((row) => (originById.get(row.requestId) ?? "phoenix") === origin);
  const report = {
    ...full,
    kpi: buildKpiBand(scopedRows, full.kpi.salesDataAsOf ?? null, full.kpi.restrictedExcludedCount ?? 0),
    rows: scopedRows,
  };

  if (report.rows.length === 0) {
    return {
      generatedAt: report.generatedAtIso,
      includedRestricted: report.includedRestricted,
      kpi: report.kpi,
      requestsWithSuspectCodes: 0,
      rows: [],
      salesDataAsOf: report.kpi.salesDataAsOf ?? null,
    };
  }

  // Detail + reference state + distributor names in parallel — none depends on the others.
  const [detail, referenceByCode, distributorNameByCode] = await Promise.all([
    loadMarketingRoiExportDetail(
      report.rows.map((row) => ({ requestCode: row.requestCode, requestId: row.requestId })),
      report.includedRestricted,
    ),
    loadPharmacyReferenceState().catch((error) => {
      // The reference signal is an enhancement, never a reason to fail the whole report.
      logRoiServiceFailure("getMarketingRoiTracker:loadPharmacyReferenceState", error, { role: access.role });
      return new Map<string, string>();
    }),
    loadDistributorNames().catch((error) => {
      // Same rule: a readable distributor name is a nicety; losing it must not fail the report.
      logRoiServiceFailure("getMarketingRoiTracker:loadDistributorNames", error, { role: access.role });
      return new Map<string, string>();
    }),
  ]);

  const productsByRequest = new Map<string, MarketingRoiExportProductRow[]>();
  for (const product of detail.products) {
    const list = productsByRequest.get(product.requestId);
    if (list) list.push(product);
    else productsByRequest.set(product.requestId, [product]);
  }

  const approvalsByRequest = new Map<string, MarketingRoiExportApprovalRow[]>();
  for (const approval of detail.approvals) {
    const list = approvalsByRequest.get(approval.requestId);
    if (list) list.push(approval);
    else approvalsByRequest.set(approval.requestId, [approval]);
  }

  const pharmaciesByRequest = new Map<string, RoiTrackerPharmacyRow[]>();
  for (const pharmacy of detail.pharmacies) {
    const key = (pharmacy.customerCode ?? "").trim().toLowerCase();
    const referenceStatus = referenceByCode.get(key) ?? "pending";
    const distributorCode = pharmacy.distributorCode;
    const enriched: RoiTrackerPharmacyRow = {
      customerCode: pharmacy.customerCode,
      distributorCode,
      distributorName: distributorCode
        ? distributorNameByCode.get(distributorCode.trim().toUpperCase()) ?? distributorCode
        : null,
      pharmacyName: pharmacy.pharmacyName,
      referenceStatus,
      referenceSuspect: SUSPECT_REFERENCE_STATES.has(referenceStatus),
      trackingStatus: pharmacy.trackingStatus,
    };
    const list = pharmaciesByRequest.get(pharmacy.requestId);
    if (list) list.push(enriched);
    else pharmaciesByRequest.set(pharmacy.requestId, [enriched]);
  }

  let requestsWithSuspectCodes = 0;
  const rows: RoiTrackerRow[] = report.rows.map((row) => {
    const pharmacies = pharmaciesByRequest.get(row.requestId) ?? [];
    const suspectPharmacyCount = pharmacies.filter((pharmacy) => pharmacy.referenceSuspect).length;
    if (suspectPharmacyCount > 0) requestsWithSuspectCodes += 1;

    return {
      ...row,
      approvals: (approvalsByRequest.get(row.requestId) ?? []).sort((a, b) => a.sequence - b.sequence),
      coverageGap: Math.max(row.requiredRoiValue - row.actualSalesValue, 0),
      pharmacies,
      products: productsByRequest.get(row.requestId) ?? [],
      suspectPharmacyCount,
    };
  });

  return {
    generatedAt: report.generatedAtIso,
    includedRestricted: report.includedRestricted,
    kpi: report.kpi,
    requestsWithSuspectCodes,
    rows,
    salesDataAsOf: report.kpi.salesDataAsOf ?? null,
  };
}
