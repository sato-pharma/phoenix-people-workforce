import type { AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { roundMarketingMoney, roundMarketingRatio } from "@/lib/marketing-requests/roi";
import { resolveRoiDataCoverage } from "@/lib/marketing-requests/roi-labels";
import { assertMarketingWorkspaceAccess, normalizeHrId } from "@/lib/marketing-requests/service";
import {
  computeMarketingCoverageFilterOptions,
  resolveMarketingCoverageScope,
} from "@/lib/marketing-requests/coverage-report-scope";
import { entryMatchesCoverageFilters } from "@/lib/marketing-requests/coverage-report-facets";
import {
  chunk,
  isRestrictedMarketingProduct,
  loadActuals,
  loadByRequestIds,
  loadLatestValidatedPeriod,
  logRoiServiceFailure,
  mapRoiRequest,
  presetOwnerHrId,
  resolveChainSeats,
  resolveOwnedProductScope,
  resolveRoiResultStatus,
  buildKpiBand,
  getMarketingRequestViewSales,
  roiWindowLabel,
  type MappedRoiRequest,
  type RoiRequestRow,
} from "@/lib/marketing-requests/roi-report-service";
import {
  emptyMarketingCoverageFilterState,
  type MarketingCoverageFilterFacets,
  type MarketingCoverageFilterState,
  type MarketingCoverageKpiBand,
  type MarketingCoveragePharmacyRow,
  type MarketingCoveragePreset,
  type MarketingCoverageReport,
  type MarketingCoverageReportRow,
  type MarketingCoverageRequestIndexEntry,
  type MarketingRoiScope,
} from "@/lib/marketing-requests/roi-report-types";
import {
  RESTRICTED_PRODUCT_CODES,
  restrictedProductNameSet,
} from "@/lib/sales/access-scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Coverage Report — server data layer.
//
// A separate, broader-access report over the SAME underlying requests as ROI
// Tracking. It reuses ROI Tracking's expensive/well-tested internals (KPI math,
// attribution loading, per-request pharmacy sales) unchanged, but builds its OWN
// role-scoped request index via `resolveMarketingCoverageScope` — a DELIBERATELY
// NARROWER company-wide role set (Finance Manager/Financial Advisor are scoped
// to their own subtree here, unlike ROI Tracking). Kept as a fully separate
// index + cache from ROI Tracking's so the two reports' scope decisions can
// never leak into each other via a shared cache key.
// ─────────────────────────────────────────────────────────────────────────────

const RESTRICTED_CODES_UPPER = RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase());

type CoverageIndexContext = {
  scope: MarketingRoiScope;
  entries: MarketingCoverageRequestIndexEntry[];
  requestById: Map<string, MappedRoiRequest>;
  customerNameById: Map<string, string>;
  salesDataAsOf: string | null;
};

const COVERAGE_INDEX_CACHE_TTL_MS = 60_000;
const COVERAGE_INDEX_CACHE_MAX_ENTRIES = 32;

type CoverageIndexCacheEntry = {
  expiresAt: number;
  promise: Promise<CoverageIndexContext>;
};

const coverageIndexCache = new Map<string, CoverageIndexCacheEntry>();

function coverageIndexCacheKey(access: AccessContext, revealRestricted: boolean): string {
  return [
    "coverage",
    access.source,
    access.role,
    access.scope,
    normalizeHrId(access.hrId) ?? "",
    (access.loginId ?? "").trim().toLowerCase(),
    revealRestricted ? "restricted" : "masked",
  ].join("|");
}

function trimCoverageIndexCache(now: number) {
  for (const [key, entry] of coverageIndexCache) {
    if (entry.expiresAt <= now) coverageIndexCache.delete(key);
  }
  while (coverageIndexCache.size > COVERAGE_INDEX_CACHE_MAX_ENTRIES) {
    const oldestKey = coverageIndexCache.keys().next().value;
    if (!oldestKey) break;
    coverageIndexCache.delete(oldestKey);
  }
}

function getCachedCoverageIndex(access: AccessContext, revealRestricted: boolean): Promise<CoverageIndexContext> {
  const now = Date.now();
  trimCoverageIndexCache(now);

  const key = coverageIndexCacheKey(access, revealRestricted);
  const cached = coverageIndexCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = buildCoverageIndex(access, revealRestricted);
  coverageIndexCache.set(key, { expiresAt: now + COVERAGE_INDEX_CACHE_TTL_MS, promise });
  void promise.catch(() => {
    if (coverageIndexCache.get(key)?.promise === promise) coverageIndexCache.delete(key);
  });
  return promise;
}

/**
 * Build the role-scoped per-request index for one viewer. Near-twin of
 * roi-report-service.ts's buildRoiIndex, scoped via resolveMarketingCoverageScope
 * instead, and carrying 2 extra facet fields (areaName, requesterTier) per entry.
 */
async function buildCoverageIndex(access: AccessContext, revealRestricted: boolean): Promise<CoverageIndexContext> {
  assertMarketingWorkspaceAccess(access);
  const supabase = getSupabaseAdmin();
  const employeeRows = await getEmployeeDirectoryRows({ includeInactive: true });
  const byHrId = new Map(
    employeeRows
      .map((row) => [normalizeHrId(row.hrId), row] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );

  let ownedProductCodes: Set<string> | null = null;
  let ownedLineNames: Set<string> | null = null;
  if (access.role === "Product Manager" || access.role === "Group Product Manager") {
    const owned = await resolveOwnedProductScope(supabase, access, byHrId);
    ownedProductCodes = owned.ownedProductCodes;
    ownedLineNames = owned.ownedLineNames;
  }

  const scope = resolveMarketingCoverageScope(access, employeeRows, { ownedProductCodes, ownedLineNames });

  const requestsResult = await supabase
    .from("marketing_requests")
    .select(
      "id, request_code, requester_hr_id, manager_hr_id, customer_id, status, request_type_id, pay_date, roi_duration_months, estimated_cost, expected_roi_value, required_roi_value",
    )
    .not("pay_date", "is", null);
  if (requestsResult.error) throw requestsResult.error;
  const requests = ((requestsResult.data ?? []) as RoiRequestRow[]).map(mapRoiRequest);
  const requestById = new Map(requests.map((request) => [request.id, request] as const));
  const allIds = requests.map((request) => request.id);

  const [productLinks, pharmacyLinks, approvalSteps, rollupRows, customersResult, typesResult, salesDataAsOf] =
    await Promise.all([
      loadByRequestIds<{ request_id: string; product_id: number | string }>(
        supabase,
        "marketing_request_products",
        "request_id, product_id",
        allIds,
      ),
      loadByRequestIds<{ request_id: string; distributor_code_id: string }>(
        supabase,
        "marketing_request_pharmacies",
        "request_id, distributor_code_id",
        allIds,
      ),
      loadByRequestIds<{ request_id: string; assigned_role: string | null; is_cc: boolean | null; status: string | null }>(
        supabase,
        "marketing_request_approval_steps",
        "request_id, assigned_role, is_cc, status",
        allIds,
      ),
      supabase.from("marketing_roi_distributor_rollup").select("marketing_normalized_name, parent_distributor_code"),
      supabase.from("marketing_customers").select("id, display_name"),
      supabase.from("marketing_request_types").select("id, name"),
      loadLatestValidatedPeriod(supabase),
    ]);
  if (rollupRows.error) throw rollupRows.error;
  if (customersResult.error) throw customersResult.error;
  if (typesResult.error) throw typesResult.error;

  const productIds = Array.from(new Set(productLinks.map((link) => Number(link.product_id)).filter(Boolean)));
  const productById = new Map<number, { code: string; name: string; normalizedName: string; line: string | null }>();
  for (const part of chunk(productIds)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase
      .from("marketing_products")
      .select("id, product_code, product_name, normalized_name, line")
      .in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: number | string; product_code?: string | null; product_name?: string | null; normalized_name?: string | null; line?: string | null }>) {
      productById.set(Number(row.id), {
        code: (row.product_code ?? "").trim().toUpperCase(),
        name: (row.product_name ?? "").trim(),
        normalizedName: (row.normalized_name ?? row.product_name ?? "").trim(),
        line: (row.line ?? "").trim() || null,
      });
    }
  }

  const codeIds = Array.from(new Set(pharmacyLinks.map((link) => link.distributor_code_id).filter(Boolean)));
  const codeById = new Map<string, { pharmacyId: string; normalizedCode: string; distributorId: number | null }>();
  for (const part of chunk(codeIds)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("id, pharmacy_id, normalized_pharmacy_code, distributor_id")
      .in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      id: string;
      pharmacy_id: string;
      normalized_pharmacy_code?: string | null;
      distributor_id?: number | string | null;
    }>) {
      codeById.set(row.id, {
        pharmacyId: row.pharmacy_id,
        normalizedCode: (row.normalized_pharmacy_code ?? "").trim(),
        distributorId: row.distributor_id == null ? null : Number(row.distributor_id),
      });
    }
  }

  const distributorIds = Array.from(
    new Set(Array.from(codeById.values()).map((entry) => entry.distributorId).filter((id): id is number => id != null)),
  );
  const distributorNormalizedById = new Map<number, string>();
  for (const part of chunk(distributorIds)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase.from("marketing_distributors").select("id, normalized_name").in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: number | string; normalized_name?: string | null }>) {
      distributorNormalizedById.set(Number(row.id), (row.normalized_name ?? "").trim().toLowerCase());
    }
  }
  const parentByNormalized = new Map<string, string>();
  for (const row of (rollupRows.data ?? []) as Array<{ marketing_normalized_name: string; parent_distributor_code: string }>) {
    parentByNormalized.set(row.marketing_normalized_name.trim().toLowerCase(), row.parent_distributor_code);
  }

  const pharmacyIds = Array.from(new Set(Array.from(codeById.values()).map((entry) => entry.pharmacyId).filter(Boolean)));
  const pharmacyNameById = new Map<string, string>();
  for (const part of chunk(pharmacyIds)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase.from("marketing_pharmacies").select("id, display_name").in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; display_name?: string | null }>) {
      pharmacyNameById.set(row.id, (row.display_name ?? "").trim());
    }
  }

  const customerNameById = new Map(
    ((customersResult.data ?? []) as Array<{ id: string; display_name?: string | null }>).map(
      (row) => [row.id, (row.display_name ?? "").trim() || row.id] as const,
    ),
  );
  const typeNameById = new Map(
    ((typesResult.data ?? []) as Array<{ id: number | string; name?: string | null }>).map(
      (row) => [Number(row.id), (row.name ?? "").trim() || `Type ${row.id}`] as const,
    ),
  );

  const productsByRequest = new Map<string, Array<{ code: string; name: string; normalizedName: string; line: string | null }>>();
  for (const link of productLinks) {
    const prod = productById.get(Number(link.product_id));
    if (!prod || !prod.code) continue;
    const list = productsByRequest.get(link.request_id) ?? [];
    list.push(prod);
    productsByRequest.set(link.request_id, list);
  }

  const pharmaciesByRequest = new Map<string, Array<{ key: string; name: string; parentCode: string | null }>>();
  for (const link of pharmacyLinks) {
    const code = codeById.get(link.distributor_code_id);
    if (!code) continue;
    const normalized = code.distributorId != null ? distributorNormalizedById.get(code.distributorId) ?? null : null;
    const parentCode = normalized ? parentByNormalized.get(normalized) ?? null : null;
    const list = pharmaciesByRequest.get(link.request_id) ?? [];
    list.push({
      key: code.normalizedCode || code.pharmacyId,
      name: pharmacyNameById.get(code.pharmacyId) || code.normalizedCode || code.pharmacyId,
      parentCode,
    });
    pharmaciesByRequest.set(link.request_id, list);
  }

  const approverRolesByRequest = new Map<string, Set<string>>();
  for (const step of approvalSteps) {
    if (step.is_cc) continue;
    if (step.status !== "approved") continue;
    const role = (step.assigned_role ?? "").trim();
    if (!role) continue;
    const set = approverRolesByRequest.get(step.request_id) ?? new Set<string>();
    set.add(role);
    approverRolesByRequest.set(step.request_id, set);
  }

  const restrictedNames = await restrictedProductNameSet();

  const entries: MarketingCoverageRequestIndexEntry[] = [];
  for (const request of requests) {
    const requesterKey = normalizeHrId(request.requesterHrId) ?? "";
    const requesterRow = byHrId.get(requesterKey);

    const rawProducts = productsByRequest.get(request.id) ?? [];
    const hasRestrictedProduct = rawProducts.some((product) =>
      isRestrictedMarketingProduct(product.code, product.normalizedName, restrictedNames),
    );
    const visibleProducts = revealRestricted
      ? rawProducts
      : rawProducts.filter((product) => !isRestrictedMarketingProduct(product.code, product.normalizedName, restrictedNames));

    const productLines = Array.from(new Set(rawProducts.map((p) => p.line).filter((l): l is string => Boolean(l)))).sort();
    const derivedLine = productLines.length > 0 ? productLines.join(" / ") : null;

    if (!scope.isCompanyWide) {
      if (scope.visibleProductCodes) {
        const owned = scope.visibleProductCodes;
        if (!rawProducts.some((product) => owned.has(product.code))) continue;
      } else if (scope.visibleRequesterHrIds) {
        if (!scope.visibleRequesterHrIds.has(requesterKey)) continue;
      } else {
        continue;
      }
    }

    const pharmacies = pharmaciesByRequest.get(request.id) ?? [];
    const distributorCodes = Array.from(
      new Set(pharmacies.map((pharmacy) => pharmacy.parentCode).filter((code): code is string => Boolean(code))),
    );
    const pharmacyKeys: string[] = [];
    const pharmacyNames: string[] = [];
    const seenPharmacy = new Set<string>();
    for (const pharmacy of pharmacies) {
      if (!pharmacy.key || seenPharmacy.has(pharmacy.key)) continue;
      seenPharmacy.add(pharmacy.key);
      pharmacyKeys.push(pharmacy.key);
      pharmacyNames.push(pharmacy.name);
    }

    const seats = resolveChainSeats(requesterKey, byHrId);

    entries.push({
      requestId: request.id,
      requestCode: request.requestCode,
      requesterHrId: requesterKey,
      requesterName: requesterRow?.fullName ?? null,
      managerHrId: request.managerHrId,
      status: request.status,
      requestTypeId: request.requestTypeId,
      requestTypeName: typeNameById.get(request.requestTypeId) ?? null,
      payDate: request.payDate,
      roiDurationMonths: request.roiDurationMonths,
      lineName: requesterRow?.lineName ?? derivedLine,
      regionName: requesterRow?.regionName ?? null,
      areaName: requesterRow?.areaName ?? null,
      requesterTier: resolveJobFunctionRole(requesterRow?.jobTitle),
      dmHrId: seats.dmHrId,
      dmName: seats.dmName,
      nsmHrId: seats.nsmHrId,
      nsmName: seats.nsmName,
      rsmHrId: seats.rsmHrId,
      rsmName: seats.rsmName,
      approverRoleKeys: Array.from(approverRolesByRequest.get(request.id) ?? []),
      distributorCodes,
      productCodes: visibleProducts.map((product) => product.code),
      productNames: visibleProducts.map((product) => product.name || product.code),
      pharmacyKeys,
      pharmacyNames,
      hasRestrictedProduct,
    });
  }

  return { scope, entries, requestById, customerNameById, salesDataAsOf };
}

export async function getMarketingCoverageFilterOptions(access: AccessContext): Promise<MarketingCoverageFilterFacets> {
  try {
    const ctx = await getCachedCoverageIndex(access, access.role === "CEO" || access.role === "Super Admin");
    return {
      entries: ctx.entries,
      canRevealRestricted: ctx.scope.canRevealRestricted,
      totalCount: ctx.entries.length,
    };
  } catch (error) {
    logRoiServiceFailure("getMarketingCoverageFilterOptions:buildCoverageIndex", error, { role: access.role });
    throw error;
  }
}

/** Parse a loosely-typed request body into a complete MarketingCoverageFilterState. */
export function parseMarketingCoverageFilterState(input: unknown): MarketingCoverageFilterState {
  const base = emptyMarketingCoverageFilterState();
  if (!input || typeof input !== "object") return base;
  const body = input as Record<string, unknown>;
  const strArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((item) => String(item)).filter((item) => item.length > 0) : [];
  const numArray = (value: unknown): number[] =>
    Array.isArray(value) ? value.map((item) => Number(item)).filter((item) => Number.isFinite(item)) : [];

  return {
    dm: strArray(body.dm),
    nsm: strArray(body.nsm),
    rsm: strArray(body.rsm),
    line: strArray(body.line),
    approvedBy: strArray(body.approvedBy),
    requester: strArray(body.requester),
    status: strArray(body.status) as MarketingCoverageFilterState["status"],
    requestType: numArray(body.requestType),
    region: strArray(body.region),
    distributor: strArray(body.distributor),
    product: strArray(body.product),
    pharmacy: strArray(body.pharmacy),
    roiStatus: strArray(body.roiStatus) as MarketingCoverageFilterState["roiStatus"],
    payDateFrom: typeof body.payDateFrom === "string" && body.payDateFrom ? body.payDateFrom : null,
    payDateTo: typeof body.payDateTo === "string" && body.payDateTo ? body.payDateTo : null,
    durationMin: Number.isFinite(Number(body.durationMin)) && body.durationMin != null ? Number(body.durationMin) : null,
    durationMax: Number.isFinite(Number(body.durationMax)) && body.durationMax != null ? Number(body.durationMax) : null,
    includeRestricted: body.includeRestricted === true,
    area: strArray(body.area),
    requesterTier: strArray(body.requesterTier),
  };
}

/** Distinct target-pharmacy + distinct-customer counts over the final filtered rows. */
export function countDistinctCoverage(rows: MarketingCoverageReportRow[]): {
  distinctPharmacyCount: number;
  distinctCustomerCount: number;
} {
  const pharmacies = new Set<string>();
  const customers = new Set<string>();
  for (const row of rows) {
    for (const key of row.pharmacyKeys) pharmacies.add(key);
    if (row.customerId) customers.add(row.customerId);
  }
  return { distinctPharmacyCount: pharmacies.size, distinctCustomerCount: customers.size };
}

export async function getMarketingCoverageReport(
  access: AccessContext,
  filters: MarketingCoverageFilterState,
  generatedAtIso: string,
): Promise<MarketingCoverageReport> {
  const includeRestricted = filters.includeRestricted && (access.role === "CEO" || access.role === "Super Admin");
  let ctx: CoverageIndexContext;
  try {
    ctx = await getCachedCoverageIndex(access, includeRestricted);
  } catch (error) {
    logRoiServiceFailure("getMarketingCoverageReport:buildCoverageIndex", error, { role: access.role });
    throw error;
  }
  const supabase = getSupabaseAdmin();
  const customerNameById = ctx.customerNameById;

  const candidates = ctx.entries.filter((entry) => entryMatchesCoverageFilters(entry, filters));

  const excludeCodes = includeRestricted ? [] : RESTRICTED_CODES_UPPER;
  let actualsByRequest: Map<string, { value: number; units: number; salesRows: number; quality: string }>;
  let masked: boolean;
  try {
    ({ byRequest: actualsByRequest, masked } = await loadActuals(
      supabase,
      candidates.map((entry) => entry.requestId),
      excludeCodes,
    ));
  } catch (error) {
    logRoiServiceFailure("getMarketingCoverageReport:loadActuals", error, {
      role: access.role,
      candidateCount: candidates.length,
      masking: excludeCodes.length > 0,
    });
    throw error;
  }

  const autoAppliedByDimension: MarketingCoverageReport["autoAppliedByDimension"] = {};
  const options = computeMarketingCoverageFilterOptions(ctx.scope, ctx.entries);
  for (const dim of options.dimensions) {
    if (dim.autoApplied) autoAppliedByDimension[dim.key] = dim.autoApplied;
  }

  const restrictedRequestIds = new Set<string>();
  const rows: MarketingCoverageReportRow[] = candidates.map((entry) => {
    const request = ctx.requestById.get(entry.requestId)!;
    const withheld = masked && entry.hasRestrictedProduct;
    const actuals = withheld
      ? { value: 0, units: 0, salesRows: 0, quality: "no_sales" }
      : actualsByRequest.get(entry.requestId) ?? { value: 0, units: 0, salesRows: 0, quality: "no_sales" };
    if (entry.hasRestrictedProduct && !includeRestricted) restrictedRequestIds.add(entry.requestId);

    const { label: roiWindow, endPeriod } = roiWindowLabel(entry.payDate, entry.roiDurationMonths);
    const salesDataComplete = Boolean(ctx.salesDataAsOf && endPeriod && endPeriod <= ctx.salesDataAsOf);
    const actualValue = roundMarketingMoney(actuals.value);
    const coverage = request.requiredRoiValue > 0
      ? roundMarketingRatio(actuals.value / request.requiredRoiValue)
      : actuals.value > 0
        ? 1
        : 0;
    const forecastCoverageRatio = request.requiredRoiValue > 0
      ? roundMarketingRatio(request.expectedRoiValue / request.requiredRoiValue)
      : request.expectedRoiValue > 0
        ? 1
        : 0;
    const dataCoverage = resolveRoiDataCoverage({
      windowStart: entry.payDate ? entry.payDate.slice(0, 7) : null,
      windowEnd: endPeriod,
      salesDataAsOf: ctx.salesDataAsOf,
    });

    const resultStatus = resolveRoiResultStatus({
      salesRows: actuals.salesRows,
      actualValue: actuals.value,
      requiredRoiValue: request.requiredRoiValue,
      salesDataComplete,
    });

    let attributionGapReason: string | null = null;
    if (withheld && actuals.salesRows === 0) {
      attributionGapReason = "Confidential — attribution masking pending deploy";
    } else if (resultStatus === "awaiting_data") {
      attributionGapReason = `ROI window runs to ${endPeriod ?? "?"}; sales loaded through ${ctx.salesDataAsOf ?? "n/a"}`;
    } else if (actuals.salesRows === 0) {
      attributionGapReason = entry.pharmacyKeys.length === 0
        ? "No target pharmacy distributor codes"
        : "No matching sales in the ROI window";
    }

    return {
      requestId: entry.requestId,
      requestCode: entry.requestCode,
      requesterHrId: entry.requesterHrId,
      requesterName: entry.requesterName,
      line: entry.lineName,
      region: entry.regionName,
      areaName: entry.areaName,
      requesterTier: entry.requesterTier,
      customerName: customerNameById.get(request.customerId) ?? request.customerId,
      customerId: request.customerId,
      status: entry.status,
      requestTypeName: entry.requestTypeName,
      payDate: entry.payDate,
      roiWindow,
      roiDurationMonths: entry.roiDurationMonths,
      estimatedCost: roundMarketingMoney(request.estimatedCost),
      expectedRoiValue: roundMarketingMoney(request.expectedRoiValue),
      requiredRoiValue: roundMarketingMoney(request.requiredRoiValue),
      actualSalesValue: actualValue,
      actualSalesUnits: actuals.units,
      actualCoverageRatio: coverage,
      forecastCoverageRatio,
      dataCoverage,
      resultStatus,
      attributionQuality: actuals.quality === "exact_customer" ? "exact_customer" : "no_sales",
      hasSalesData: actuals.salesRows > 0,
      salesDataComplete,
      attributionGapReason,
      approverRoleKeys: entry.approverRoleKeys,
      productCodes: entry.productCodes,
      distributorCodes: entry.distributorCodes,
      pharmacyKeys: entry.pharmacyKeys,
    };
  });

  const finalRows = filters.roiStatus.length > 0
    ? rows.filter((row) => filters.roiStatus.includes(row.resultStatus))
    : rows;

  finalRows.sort((left, right) => (right.payDate ?? "").localeCompare(left.payDate ?? ""));

  const restrictedExcludedCount = finalRows.reduce(
    (count, row) => (restrictedRequestIds.has(row.requestId) ? count + 1 : count),
    0,
  );
  const baseKpi = buildKpiBand(finalRows, ctx.salesDataAsOf, restrictedExcludedCount);
  const { distinctPharmacyCount, distinctCustomerCount } = countDistinctCoverage(finalRows);
  const kpi: MarketingCoverageKpiBand = { ...baseKpi, distinctPharmacyCount, distinctCustomerCount };

  return {
    rows: finalRows,
    kpi,
    appliedFilters: filters,
    autoAppliedByDimension,
    includedRestricted: includeRestricted,
    generatedAtIso,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-request target-pharmacy drill-down (accordion detail) — zero-sales-safe.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure merge: builds one row per TARGET pharmacy (never per matched-sales row),
 * defaulting to a zero value/units when the pharmacy has no sales aggregate.
 * Driving the loop off `targetPharmacies` (not `byPharmacy`) is what guarantees
 * the output always has exactly one row per target pharmacy — a pharmacy can
 * never be silently dropped for having zero matched sales, and a stray sales
 * aggregate for a non-target pharmacy can never fabricate an extra row.
 */
export function mergePharmacyCoverage(
  targetPharmacies: Array<{ code: string; name: string }>,
  byPharmacy: Map<string, { value: number; units: number }>,
  distributorNameByCode: Map<string, string | null>,
  parentDistributorCodeByCode: Map<string, string | null>,
): MarketingCoveragePharmacyRow[] {
  const rows: MarketingCoveragePharmacyRow[] = targetPharmacies.map((pharmacy) => {
    const sales = byPharmacy.get(pharmacy.code);
    return {
      pharmacyCode: pharmacy.code,
      pharmacyName: pharmacy.name,
      distributorName: distributorNameByCode.get(pharmacy.code) ?? null,
      parentDistributorCode: parentDistributorCodeByCode.get(pharmacy.code) ?? null,
      salesValue: sales ? roundMarketingMoney(sales.value) : 0,
      salesUnits: sales ? sales.units : 0,
      hasSalesRows: Boolean(sales),
    };
  });
  rows.sort((a, b) => b.salesValue - a.salesValue || a.pharmacyName.localeCompare(b.pharmacyName));
  return rows;
}

/**
 * Target pharmacies for one request, ALWAYS including pharmacies with zero
 * matched sales. Reuses getMarketingRequestViewSales unchanged (inherits its
 * scope gate + confidential masking + attribution RPC), then merges via
 * mergePharmacyCoverage: the loop is driven off `context.pharmacies` (the
 * request's actual targets), never off the sales aggregate, so a zero-sales
 * pharmacy can never be silently dropped.
 */
export async function getMarketingCoverageRequestPharmacies(
  access: AccessContext,
  requestId: string,
  fromInput: string | null | undefined,
  toInput: string | null | undefined,
  generatedAtIso: string,
): Promise<MarketingCoveragePharmacyRow[]> {
  const viewSales = await getMarketingRequestViewSales(access, requestId, fromInput, toInput, generatedAtIso);
  const { pharmacies } = viewSales.context;
  if (pharmacies.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const codes = pharmacies.map((pharmacy) => pharmacy.code).filter(Boolean);
  const codeRowsResult = await supabase
    .from("marketing_pharmacy_distributor_codes")
    .select("normalized_pharmacy_code, distributor_id")
    .in("normalized_pharmacy_code", codes);
  if (codeRowsResult.error) throw codeRowsResult.error;
  const distributorIdByCode = new Map<string, number>();
  for (const row of (codeRowsResult.data ?? []) as Array<{ normalized_pharmacy_code?: string | null; distributor_id?: number | string | null }>) {
    const code = (row.normalized_pharmacy_code ?? "").trim();
    if (!code || row.distributor_id == null) continue;
    if (!distributorIdByCode.has(code)) distributorIdByCode.set(code, Number(row.distributor_id));
  }

  const distributorIds = Array.from(new Set(Array.from(distributorIdByCode.values())));
  const distributorById = new Map<number, { name: string; normalizedName: string }>();
  for (const part of chunk(distributorIds)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase.from("marketing_distributors").select("id, display_name, normalized_name").in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: number | string; display_name?: string | null; normalized_name?: string | null }>) {
      distributorById.set(Number(row.id), {
        name: (row.display_name ?? "").trim(),
        normalizedName: (row.normalized_name ?? "").trim().toLowerCase(),
      });
    }
  }

  const rollupResult = await supabase.from("marketing_roi_distributor_rollup").select("marketing_normalized_name, parent_distributor_code");
  if (rollupResult.error) throw rollupResult.error;
  const parentByNormalized = new Map<string, string>();
  for (const row of (rollupResult.data ?? []) as Array<{ marketing_normalized_name: string; parent_distributor_code: string }>) {
    parentByNormalized.set(row.marketing_normalized_name.trim().toLowerCase(), row.parent_distributor_code);
  }

  const byPharmacy = new Map(viewSales.byPharmacy.map((aggregate) => [aggregate.key, aggregate] as const));
  const distributorNameByCode = new Map<string, string | null>();
  const parentDistributorCodeByCode = new Map<string, string | null>();
  for (const pharmacy of pharmacies) {
    const distributorId = distributorIdByCode.get(pharmacy.code);
    const distributor = distributorId != null ? distributorById.get(distributorId) : undefined;
    distributorNameByCode.set(pharmacy.code, distributor?.name || null);
    parentDistributorCodeByCode.set(pharmacy.code, distributor ? parentByNormalized.get(distributor.normalizedName) ?? null : null);
  }

  return mergePharmacyCoverage(pharmacies, byPharmacy, distributorNameByCode, parentDistributorCodeByCode);
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved filter presets — same table as ROI Tracking, discriminated by report_kind.
// ─────────────────────────────────────────────────────────────────────────────

type CoveragePresetDbRow = {
  id: string;
  name: string;
  filter_json: unknown;
  is_default: boolean | null;
  updated_at: string | null;
};

function mapCoveragePreset(row: CoveragePresetDbRow): MarketingCoveragePreset {
  return {
    id: row.id,
    name: row.name,
    filters: parseMarketingCoverageFilterState(row.filter_json),
    isDefault: Boolean(row.is_default),
    updatedAt: row.updated_at ?? "",
  };
}

export async function listMarketingCoveragePresets(access: AccessContext): Promise<MarketingCoveragePreset[]> {
  const owner = presetOwnerHrId(access);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_roi_filter_presets")
    .select("id, name, filter_json, is_default, updated_at")
    .eq("owner_hr_id", owner)
    .eq("report_kind", "coverage_report")
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as CoveragePresetDbRow[]).map(mapCoveragePreset);
}

export async function saveMarketingCoveragePreset(
  access: AccessContext,
  input: { name: string; filters: MarketingCoverageFilterState; isDefault: boolean },
): Promise<MarketingCoveragePreset> {
  const owner = presetOwnerHrId(access);
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A preset name is required.");
  const supabase = getSupabaseAdmin();

  if (input.isDefault) {
    const clear = await supabase
      .from("marketing_roi_filter_presets")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq("owner_hr_id", owner)
      .eq("report_kind", "coverage_report")
      .eq("is_default", true);
    if (clear.error) throw clear.error;
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("marketing_roi_filter_presets")
    .upsert(
      {
        owner_hr_id: owner,
        name,
        filter_json: input.filters as unknown as Record<string, unknown>,
        is_default: input.isDefault,
        scope_role: access.role,
        report_kind: "coverage_report",
        updated_at: nowIso,
      },
      { onConflict: "owner_hr_id,report_kind,name" },
    )
    .select("id, name, filter_json, is_default, updated_at")
    .single();
  if (error) throw error;
  return mapCoveragePreset(data as CoveragePresetDbRow);
}

export async function deleteMarketingCoveragePreset(access: AccessContext, id: string): Promise<void> {
  const owner = presetOwnerHrId(access);
  const cleanId = String(id ?? "").trim();
  if (!cleanId) throw new Error("A preset id is required.");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("marketing_roi_filter_presets")
    .delete()
    .eq("id", cleanId)
    .eq("owner_hr_id", owner)
    .eq("report_kind", "coverage_report");
  if (error) throw error;
}
