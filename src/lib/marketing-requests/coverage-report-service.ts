import type { AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { roundMarketingMoney, roundMarketingRatio } from "@/lib/marketing-requests/roi";
import { resolveRoiDataCoverage } from "@/lib/marketing-requests/roi-labels";
import { assertMarketingWorkspaceAccess, normalizeHrId } from "@/lib/marketing-requests/service";
import {
  computeMarketingCoverageFilterOptions,
  resolveMarketingCoverageScope,
} from "@/lib/marketing-requests/coverage-report-scope";
import { coverageFilterLabels, entryMatchesCoverageFilters } from "@/lib/marketing-requests/coverage-report-facets";
import { collectRequestLineNames, lineRouteAdmitsRequest } from "@/lib/marketing-requests/roi-report-scope";
import type { RoiAttributionLine } from "@/lib/marketing-requests/roi-report-types";
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
  resolveLineRouteOverride,
  resolveOwnedProductScope,
  resolveRoiResultStatus,
  resolveRoiStatusScope,
  buildKpiBand,
  loadAttributionLines,
  getMarketingRequestViewSales,
  roiWindowLabel,
  toNum,
  type MappedRoiRequest,
  type RoiRequestRow,
  type SupabaseAdmin,
} from "@/lib/marketing-requests/roi-report-service";
import {
  emptyMarketingCoverageFilterState,
  type MarketingCoverageDistributorRollupRow,
  type MarketingCoverageFilterFacets,
  type MarketingCoverageFilterState,
  type MarketingCoverageExportSalesDetailRow,
  type MarketingCoverageKpiBand,
  type MarketingCoveragePharmacyRow,
  type MarketingCoveragePharmacySaleRow,
  type MarketingCoveragePreset,
  type MarketingCoverageReport,
  type MarketingCoverageReportRow,
  type MarketingCoverageRequestIndexEntry,
  type MarketingRoiScope,
  type MarketingRoiViewSalesRow,
} from "@/lib/marketing-requests/roi-report-types";
import {
  RESTRICTED_PRODUCT_CODES,
  restrictedProductNameSet,
} from "@/lib/sales/access-scope";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Coverage Report — server data layer.
//
// A separate, broader-access report over the SAME underlying requests as ROI
// Tracking. It reuses ROI Tracking's expensive/well-tested internals (KPI math,
// attribution loading, per-request pharmacy sales) unchanged, but builds its OWN
// role-scoped request index via `resolveMarketingCoverageScope` (the same
// company-wide roles as ROI Tracking since 2026-10-09, the same National Sales
// Manager line route since 2026-10-20, but no Medical Rep territory route).
// Kept as a fully separate
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
  distributorNameByCode: Map<string, string | null>;
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

// marketing_roi_distributor_rollup is small, slow-changing reference data, but was being
// re-fetched from scratch on every buildCoverageIndex call AND every pharmacy drill-down
// (getMarketingCoverageRequestPharmacies) — 2 redundant round-trips per typical request flow.
// Cached the same way as coverageIndexCache above, just with a longer TTL since this data
// changes far less often than a viewer's scoped request index.
const DISTRIBUTOR_ROLLUP_CACHE_TTL_MS = 5 * 60_000;
let distributorRollupCache: { expiresAt: number; promise: Promise<Map<string, string>> } | null = null;

function getCachedDistributorRollup(supabase: SupabaseAdmin): Promise<Map<string, string>> {
  const now = Date.now();
  if (distributorRollupCache && distributorRollupCache.expiresAt > now) return distributorRollupCache.promise;

  const promise = (async () => {
    const { data, error } = await supabase
      .from("marketing_roi_distributor_rollup")
      .select("marketing_normalized_name, parent_distributor_code");
    if (error) throw error;
    const map = new Map<string, string>();
    for (const row of (data ?? []) as Array<{ marketing_normalized_name: string; parent_distributor_code: string }>) {
      map.set(row.marketing_normalized_name.trim().toLowerCase(), row.parent_distributor_code);
    }
    return map;
  })();

  distributorRollupCache = { expiresAt: now + DISTRIBUTOR_ROLLUP_CACHE_TTL_MS, promise };
  void promise.catch(() => {
    if (distributorRollupCache?.promise === promise) distributorRollupCache = null;
  });
  return promise;
}

/**
 * Narrows the per-request product/pharmacy/approval-step fan-out (the expensive
 * `loadByRequestIds` calls in `buildCoverageIndex`) to just the visible subset for
 * manager-chain-scoped viewers — a concrete, finite `visibleRequesterHrIds` Set (District/
 * Regional Manager and similar). Company-wide roles and Product Manager/Group
 * Product Manager are returned unchanged: PM/GPM's own filter (in the entries loop, further
 * down in `buildCoverageIndex`) depends on product data that hasn't been fetched yet at this
 * point, so it can't be safely pre-narrowed here.
 *
 * 🔴 A viewer with a LINE route (the National Sales Manager, owner 2026-10-20) is returned
 * unchanged for the same reason: the route admits a request raised by ANYBODY whose promoted
 * products are on his line, and those products are exactly what has not been fetched yet. Narrowing
 * him by requester here would drop every Product / Group Product / Marketing Manager campaign
 * before the entries loop's line check could ever see it — the route would exist and admit nothing.
 *
 * This is the EXACT SAME comparison (`normalizeHrId` + `Set.has`) the entries-loop filter in
 * `buildCoverageIndex` already performs — just run once earlier, purely to shrink what gets
 * fetched for a narrowly-scoped viewer. The entries-loop filter itself is left unchanged, so it
 * can never disagree with this pre-narrowing. Deliberately NOT a SQL-level filter: an earlier
 * draft pushed `visibleRequesterHrIds` into a `.in("requester_hr_id", ...)` Supabase query, but
 * that Set is normalized/alias-mapped (`normalizeHrId`) while the raw `requester_hr_id` column
 * has known casing drift this codebase's own migrations work around via `upper(btrim(...))` —
 * a raw-to-normalized SQL comparison would silently exclude exactly the rows that drift affects.
 * Keeping this as a JS-level pre-filter (same function, same values, just called earlier)
 * carries no such risk.
 */
export function narrowRequestsForFanOut(
  requests: MappedRoiRequest[],
  scope: MarketingRoiScope,
): MappedRoiRequest[] {
  if (scope.isCompanyWide || !scope.visibleRequesterHrIds) return requests;
  if (scope.visibleLineRouteNames.size > 0) return requests;
  const visible = scope.visibleRequesterHrIds;
  return requests.filter((request) => visible.has(normalizeHrId(request.requesterHrId) ?? ""));
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

  const scope = resolveMarketingCoverageScope(access, employeeRows, {
    ownedProductCodes,
    ownedLineNames,
    lineScopeOverride: await resolveLineRouteOverride(access),
  });

  const requestsResult = await supabase
    .from("marketing_requests")
    .select(
      "id, request_code, requester_hr_id, manager_hr_id, customer_id, status, request_type_id, pay_date, roi_duration_months, estimated_cost, expected_roi_value, required_roi_value",
    )
    .not("pay_date", "is", null);
  if (requestsResult.error) throw requestsResult.error;
  const requests = ((requestsResult.data ?? []) as RoiRequestRow[]).map(mapRoiRequest);
  const requestById = new Map(requests.map((request) => [request.id, request] as const));
  const allIds = narrowRequestsForFanOut(requests, scope).map((request) => request.id);

  const [productLinks, pharmacyLinks, approvalSteps, parentByNormalized, customersResult, typesResult, salesDataAsOf, sosDistributorsResult] =
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
      getCachedDistributorRollup(supabase),
      supabase.from("marketing_customers").select("id, display_name"),
      supabase.from("marketing_request_types").select("id, name"),
      loadLatestValidatedPeriod(supabase),
      supabase.from("source_of_sales_distributors").select("distributor_code, distributor_name"),
    ]);
  if (customersResult.error) throw customersResult.error;
  if (typesResult.error) throw typesResult.error;
  if (sosDistributorsResult.error) throw sosDistributorsResult.error;

  const distributorNameByCode = new Map<string, string | null>(
    ((sosDistributorsResult.data ?? []) as Array<{ distributor_code: string; distributor_name?: string | null }>).map(
      (row) => [row.distributor_code, (row.distributor_name ?? "").trim() || null] as const,
    ),
  );

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

  const pharmaciesByRequest = new Map<string, Array<{ key: string; name: string; parentCode: string | null; pharmacyId: string }>>();
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
      pharmacyId: code.pharmacyId,
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
        // The requester route, or the National Sales Manager's line route (owner, 2026-10-20) —
        // the request's lines read exactly as ROI Tracking reads them (requester's seat line plus
        // every promoted product's line, from `rawProducts`, never the masked list).
        if (
          !scope.visibleRequesterHrIds.has(requesterKey) &&
          !lineRouteAdmitsRequest(scope, collectRequestLineNames(requesterRow?.lineName ?? null, productLines))
        ) {
          continue;
        }
      } else {
        continue;
      }
    }

    const pharmacies = pharmaciesByRequest.get(request.id) ?? [];
    const distributorCodes = Array.from(
      new Set(pharmacies.map((pharmacy) => pharmacy.parentCode).filter((code): code is string => Boolean(code))),
    );
    // Pharmacy-target-count weighting per distributor — mirrors phx_refresh_marketing_roi_facts'
    // own `1 / target_count` share exactly. Pharmacies with no resolvable parent code count
    // toward neither the numerator nor denominator.
    const resolvableTargetCount = pharmacies.filter((pharmacy) => Boolean(pharmacy.parentCode)).length;
    const distributorWeights: Array<{ distributorCode: string; weight: number }> = resolvableTargetCount > 0
      ? distributorCodes.map((code) => ({
          distributorCode: code,
          weight:
            pharmacies.filter((pharmacy) => pharmacy.parentCode === code).length / resolvableTargetCount,
        }))
      : [];
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
      requesterName: requesterRow?.displayName ?? null,
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
      distributorNames: distributorCodes.map((code) => distributorNameByCode.get(code) || code),
      distributorWeights,
      pharmacyIds: Array.from(new Set(pharmacies.map((pharmacy) => pharmacy.pharmacyId).filter(Boolean))),
      productCodes: visibleProducts.map((product) => product.code),
      productNames: visibleProducts.map((product) => product.name || product.code),
      pharmacyKeys,
      pharmacyNames,
      hasRestrictedProduct,
    });
  }

  return { scope, entries, requestById, customerNameById, salesDataAsOf, distributorNameByCode };
}

export async function getMarketingCoverageFilterOptions(access: AccessContext): Promise<MarketingCoverageFilterFacets> {
  try {
    const ctx = await getCachedCoverageIndex(access, access.role === "CEO" || access.role === "Super Admin");
    return {
      entries: ctx.entries,
      canRevealRestricted: ctx.scope.canRevealRestricted,
      totalCount: ctx.entries.length,
      lastExport: await getLatestCoverageReportExportAudit(),
    };
  } catch (error) {
    logRoiServiceFailure("getMarketingCoverageFilterOptions:buildCoverageIndex", error, { role: access.role });
    throw error;
  }
}

/** Read-only governance surface for the export-audit trail — best-effort: never throws,
 *  never blocks the filter-options response. Returns null on no export yet OR any read
 *  failure (e.g. the audit table/constraint migration hasn't landed on this database yet). */
async function getLatestCoverageReportExportAudit(): Promise<MarketingCoverageFilterFacets["lastExport"]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data: auditRow } = await supabase
      .from("marketing_roi_export_audit")
      .select("exported_by_hr_id, exported_at")
      .eq("kind", "coverage_report")
      .order("exported_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!auditRow) return null;

    const { data: employeeRow } = await supabase
      .from("employees")
      .select("full_name, nickname")
      .eq("hr_id", auditRow.exported_by_hr_id)
      .maybeSingle();

    return {
      // Names, never ids: an exporter with no employee row reads "Unknown user", not an HR id.
      exportedByName: employeeRow ? resolveEmployeeDisplayName(employeeRow.full_name, employeeRow.nickname) : "Unknown user",
      exportedAt: auditRow.exported_at,
    };
  } catch {
    return null;
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

/**
 * Distinct target-pharmacy + distinct-customer counts over the final filtered rows.
 *
 * Pharmacies are counted by PHARMACY, not by distributor code: one pharmacy can hold a code at
 * several distributors, and counting codes read 55 "pharmacies" where there were 49 (2026-10-09).
 */
export function countDistinctCoverage(rows: Array<Pick<MarketingCoverageReportRow, "customerId" | "pharmacyIds">>): {
  distinctPharmacyCount: number;
  distinctCustomerCount: number;
} {
  const pharmacies = new Set<string>();
  const customers = new Set<string>();
  for (const row of rows) {
    for (const id of row.pharmacyIds) pharmacies.add(id);
    if (row.customerId) customers.add(row.customerId);
  }
  return { distinctPharmacyCount: pharmacies.size, distinctCustomerCount: customers.size };
}

/**
 * Distributor cost/required-ROI roll-up over the final filtered rows, weighted by each
 * request's distributorWeights (pharmacy-target-count share — see
 * MarketingCoverageRequestIndexEntry). Deliberately carries no actual-sales/coverage figure —
 * see the MarketingCoverageDistributorRollupRow type comment for why. requestCount is an
 * unweighted count of distinct requests touching each distributor (a real yes/no fact).
 */
export function computeDistributorRollup(
  rows: MarketingCoverageReportRow[],
  entryById: Map<string, MarketingCoverageRequestIndexEntry>,
  distributorNameByCode: Map<string, string | null>,
): MarketingCoverageDistributorRollupRow[] {
  const byCode = new Map<string, MarketingCoverageDistributorRollupRow>();

  for (const row of rows) {
    const entry = entryById.get(row.requestId);
    if (!entry) continue;
    for (const { distributorCode, weight } of entry.distributorWeights) {
      const bucket = byCode.get(distributorCode) ?? {
        distributorCode,
        distributorName: distributorNameByCode.get(distributorCode) ?? null,
        requestCount: 0,
        allocatedCost: 0,
        allocatedRequiredRoi: 0,
      };
      bucket.requestCount += 1;
      bucket.allocatedCost += row.estimatedCost * weight;
      bucket.allocatedRequiredRoi += row.requiredRoiValue * weight;
      byCode.set(distributorCode, bucket);
    }
  }

  const result = Array.from(byCode.values()).map((bucket) => ({
    ...bucket,
    allocatedCost: roundMarketingMoney(bucket.allocatedCost),
    allocatedRequiredRoi: roundMarketingMoney(bucket.allocatedRequiredRoi),
  }));
  result.sort((a, b) => b.allocatedCost - a.allocatedCost);
  return result;
}

type CoverageActualsRow = {
  request_id: string;
  actual_sales_value: number | string | null;
  actual_sales_units: number | string | null;
  sales_rows: number | string | null;
  attribution_quality?: string | null;
};

type CoverageActualsByRequest = Map<string, { value: number; units: number; salesRows: number; quality: string }>;

/** Pure: given the full requested id list and what the fact-table read actually returned,
 *  determine which ids need the slow RPC fallback. Every id in `requestIds` ends up covered —
 *  from `factByRequest` when present, from the fallback otherwise. Extracted as a pure function
 *  so this "which ids are missing" decision is independently testable without a live Supabase
 *  call, matching this report's convention (e.g. mergePharmacyCoverage). */
export function findCoverageActualsGaps(requestIds: string[], factByRequest: CoverageActualsByRequest): string[] {
  return requestIds.filter((id) => !factByRequest.has(id));
}

/**
 * Fact-first actuals read for the Coverage Report. `marketing_roi_request_facts` now covers
 * every request status (not just approved) via the 2026-07-04 reliability migration, so it's a
 * fast, indexed source for the common case — falling back to the existing live-RPC `loadActuals`
 * only for requests genuinely missing a fact row (e.g. never refreshed since being created).
 *
 * The fast path is only safe when `excludeCodes` is empty: `marketing_roi_request_facts.
 * actual_sales_value` is a flat per-request total that cannot distinguish confidential-product
 * sales from the rest, so a masked/restricted viewer always uses the existing RPC path unchanged
 * (which already handles per-product exclusion correctly) — this is the expected, correct path
 * for that case, not a degradation.
 */
async function loadCoverageActuals(
  supabase: SupabaseAdmin,
  requestIds: string[],
  excludeCodes: string[],
): Promise<{ byRequest: CoverageActualsByRequest; masked: boolean; degradedRequestIds: string[] }> {
  if (requestIds.length === 0) return { byRequest: new Map(), masked: false, degradedRequestIds: [] };

  if (excludeCodes.length > 0) {
    const { byRequest, masked } = await loadActuals(supabase, requestIds, excludeCodes);
    return { byRequest, masked, degradedRequestIds: [] };
  }

  const factByRequest: CoverageActualsByRequest = new Map();
  for (const part of chunk(requestIds)) {
    const { data, error } = await supabase
      .from("marketing_roi_request_facts")
      .select("request_id, actual_sales_value, actual_sales_units, sales_rows, attribution_quality")
      .in("request_id", part);
    if (error) throw error;
    for (const row of (data ?? []) as CoverageActualsRow[]) {
      factByRequest.set(row.request_id, {
        value: toNum(row.actual_sales_value),
        units: toNum(row.actual_sales_units),
        salesRows: toNum(row.sales_rows),
        quality: row.attribution_quality ?? "no_sales",
      });
    }
  }

  const missingIds = findCoverageActualsGaps(requestIds, factByRequest);
  if (missingIds.length === 0) {
    return { byRequest: factByRequest, masked: false, degradedRequestIds: [] };
  }

  const fallback = await loadActuals(supabase, missingIds, []);
  for (const [id, value] of fallback.byRequest) factByRequest.set(id, value);
  return { byRequest: factByRequest, masked: false, degradedRequestIds: missingIds };
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

  // 🔴 The SAME default status scope as the ROI report: no status selected means approved money
  // (approved, active, ROI tracking, closed, finance hold), never "every status". Without it the
  // unfiltered page added 27 pending, sent-back, rejected and cancelled requests into its headline —
  // a cost of 276,057 EGP against 138,107 committed (production, 2026-10-09). An explicit status
  // selection always wins. `appliedFilters` echoes what the viewer CHOSE (status empty), so the
  // workspace can say on screen that the default is in force.
  const scopedFilters: MarketingCoverageFilterState = { ...filters, status: resolveRoiStatusScope(filters.status) };
  const candidates = ctx.entries.filter((entry) => entryMatchesCoverageFilters(entry, scopedFilters));

  const excludeCodes = includeRestricted ? [] : RESTRICTED_CODES_UPPER;
  let actualsByRequest: Map<string, { value: number; units: number; salesRows: number; quality: string }>;
  let masked: boolean;
  let degradedRequestIds: string[];
  try {
    ({ byRequest: actualsByRequest, masked, degradedRequestIds } = await loadCoverageActuals(
      supabase,
      candidates.map((entry) => entry.requestId),
      excludeCodes,
    ));
  } catch (error) {
    logRoiServiceFailure("getMarketingCoverageReport:loadCoverageActuals", error, {
      role: access.role,
      candidateCount: candidates.length,
      masking: excludeCodes.length > 0,
    });
    throw error;
  }
  const degradedRequestIdSet = new Set(degradedRequestIds);

  const autoAppliedByDimension: MarketingCoverageReport["autoAppliedByDimension"] = {};
  const options = computeMarketingCoverageFilterOptions(ctx.scope, ctx.entries);
  for (const dim of options.dimensions) {
    if (dim.autoApplied) autoAppliedByDimension[dim.key] = dim.autoApplied;
  }

  const restrictedRequestIds = new Set<string>();
  const withheldRequestIds = new Set<string>();
  const rows: MarketingCoverageReportRow[] = candidates.map((entry) => {
    const request = ctx.requestById.get(entry.requestId)!;
    const withheld = masked && entry.hasRestrictedProduct;
    if (withheld) withheldRequestIds.add(entry.requestId);
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
      hasAttributedSales: actuals.salesRows > 0,
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
      productNames: entry.productNames,
      distributorNames: entry.distributorNames,
      pharmacyKeys: entry.pharmacyKeys,
      pharmacyIds: entry.pharmacyIds,
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
  // The ledger of claimed invoice lines behind these rows. Several campaigns can legitimately
  // claim the SAME sale (same distributor + pharmacy + product + month), and each per-request
  // figure is correct on its own — so summing them counts that sale once per claimant. Production:
  // 729,884.77 summed against 480,155.92 real, +52%. buildKpiBand deducts the proven overlap, but
  // only when it is given the ledger; without this argument the "Actual sales (EGP)" and
  // "Coverage" cards on this page read ~50% high. Withheld rows contribute 0 to the totals, so
  // their lines must not enter the ledger either or the band would deduct value no row added.
  //
  // 🔴 The filter is on WITHHELD rows, exactly as getMarketingRoiReport's. It used to drop the
  // DEGRADED rows instead — requests read from the live engine because their fact row was missing.
  // Those carry real, non-zero actuals, so leaving their lines out of the ledger let any sale they
  // share with another campaign be counted twice in the headline.
  const ledgerRequestIds = finalRows
    .map((row) => row.requestId)
    .filter((requestId) => !withheldRequestIds.has(requestId));
  let coverageAttributionLines: RoiAttributionLine[];
  try {
    coverageAttributionLines = await loadAttributionLines(supabase, ledgerRequestIds, excludeCodes);
  } catch (error) {
    // Rethrown, never swallowed: a band silently rebuilt without the ledger reads ~50% high, and
    // an inflated headline is worse than an error state.
    logRoiServiceFailure("getMarketingCoverageReport:loadAttributionLines", error, {
      role: access.role,
      requestCount: ledgerRequestIds.length,
      masking: excludeCodes.length > 0,
    });
    throw error;
  }
  const baseKpi = buildKpiBand(finalRows, ctx.salesDataAsOf, restrictedExcludedCount, coverageAttributionLines);
  const { distinctPharmacyCount, distinctCustomerCount } = countDistinctCoverage(finalRows);
  const degradedInFinalRows = finalRows
    .map((row) => row.requestId)
    .filter((requestId) => degradedRequestIdSet.has(requestId));
  const kpi: MarketingCoverageKpiBand = {
    ...baseKpi,
    distinctPharmacyCount,
    distinctCustomerCount,
    actualsDegraded: { count: degradedInFinalRows.length, requestIds: degradedInFinalRows },
  };
  const entryById = new Map(ctx.entries.map((entry) => [entry.requestId, entry] as const));
  const distributorRollup = computeDistributorRollup(finalRows, entryById, ctx.distributorNameByCode);

  return {
    rows: finalRows,
    kpi,
    appliedFilters: filters,
    // From the whole index, not the final rows: a selected requester whose requests another
    // filter removed is still named on the export's cover.
    filterLabels: coverageFilterLabels(ctx.entries, filters),
    autoAppliedByDimension,
    includedRestricted: includeRestricted,
    generatedAtIso,
    distributorRollup,
    attributionLines: coverageAttributionLines,
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
  byPharmacy: Map<string, { value: number; units: number | null }>,
  distributorNameByCode: Map<string, string | null>,
  parentDistributorCodeByCode: Map<string, string | null>,
  salesDetailByPharmacy: Map<string, MarketingCoveragePharmacySaleRow[]> = new Map(),
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
      salesDetail: salesDetailByPharmacy.get(pharmacy.code) ?? [],
    };
  });
  rows.sort((a, b) => b.salesValue - a.salesValue || a.pharmacyName.localeCompare(b.pharmacyName));
  return rows;
}

/**
 * Groups a request's already-fetched View Sales rows by target pharmacy (customerCode),
 * sorted oldest-period-first then by product name — the same rows behind salesValue/
 * salesUnits, just broken out instead of summed. Never a second RPC call.
 */
export function groupSalesDetailByPharmacy(rows: MarketingRoiViewSalesRow[]): Map<string, MarketingCoveragePharmacySaleRow[]> {
  const byPharmacy = new Map<string, MarketingCoveragePharmacySaleRow[]>();
  for (const row of rows) {
    const list = byPharmacy.get(row.customerCode) ?? [];
    list.push({
      productCode: row.productCode,
      productName: row.productName,
      invoicePeriod: row.invoicePeriod,
      qty: row.qty,
      value: roundMarketingMoney(row.value),
    });
    byPharmacy.set(row.customerCode, list);
  }
  for (const list of byPharmacy.values()) {
    list.sort((a, b) => a.invoicePeriod.localeCompare(b.invoicePeriod) || a.productName.localeCompare(b.productName));
  }
  return byPharmacy;
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
  includeRestrictedInput = false,
): Promise<MarketingCoveragePharmacyRow[]> {
  // Admitted by the COVERAGE report's own index, not by View Sales' ROI scope: the two scopes are
  // not the same (a Medical Rep's territory route runs in ROI only), and a drill-down must never
  // open a request the report itself does not list for this viewer.
  const includeRestricted = includeRestrictedInput && (access.role === "CEO" || access.role === "Super Admin");
  const ctx = await getCachedCoverageIndex(access, includeRestricted);
  if (!ctx.entries.some((entry) => entry.requestId === requestId)) {
    throw new Error("Forbidden: this request is not in your Marketing Coverage Report.");
  }
  // Confidential products follow the report's toggle — a CEO who has it OFF must not see them here.
  const viewSales = await getMarketingRequestViewSales(access, requestId, fromInput, toInput, generatedAtIso, { includeRestricted });
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

  const parentByNormalized = await getCachedDistributorRollup(supabase);

  const byPharmacy = new Map(viewSales.byPharmacy.map((aggregate) => [aggregate.key, aggregate] as const));
  const distributorNameByCode = new Map<string, string | null>();
  const parentDistributorCodeByCode = new Map<string, string | null>();
  for (const pharmacy of pharmacies) {
    const distributorId = distributorIdByCode.get(pharmacy.code);
    const distributor = distributorId != null ? distributorById.get(distributorId) : undefined;
    distributorNameByCode.set(pharmacy.code, distributor?.name || null);
    parentDistributorCodeByCode.set(pharmacy.code, distributor ? parentByNormalized.get(distributor.normalizedName) ?? null : null);
  }

  const salesDetailByPharmacy = groupSalesDetailByPharmacy(viewSales.rows);
  return mergePharmacyCoverage(pharmacies, byPharmacy, distributorNameByCode, parentDistributorCodeByCode, salesDetailByPharmacy);
}

// ─────────────────────────────────────────────────────────────────────────────
// Export "Sales Detail" sheet — bulk, many-requests-at-once (never a per-request RPC loop).
// ─────────────────────────────────────────────────────────────────────────────

const EXPORT_SALES_DETAIL_CHUNK_SIZE = 150;

/**
 * Bulk per-sale detail (product + invoice month + pharmacy) for the coverage-report export's
 * "Sales Detail" sheet, across MANY requests in a few RPC calls — never one call per request
 * (that's exactly the N+1 pattern loadMarketingRoiExportDetail's header comment documents as
 * a timeout risk). Calls phx_marketing_coverage_export_sales_detail in bounded batches.
 * Confidential products are excluded unless `reveal` (CEO/Super Admin opt-in only).
 */
export async function loadMarketingCoverageExportSalesDetail(
  requests: Array<{ requestId: string; requestCode: string }>,
  reveal: boolean,
): Promise<MarketingCoverageExportSalesDetailRow[]> {
  if (requests.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const codeByRequest = new Map(requests.map((row) => [row.requestId, row.requestCode] as const));
  const excludeCodes = reveal ? [] : RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase());

  const rows: MarketingCoverageExportSalesDetailRow[] = [];
  for (const part of chunk(requests.map((row) => row.requestId), EXPORT_SALES_DETAIL_CHUNK_SIZE)) {
    if (part.length === 0) continue;
    // rpcAll, not a bare .rpc(): PostgREST caps every response at db-max-rows (1000), and a
    // truncated export is silent — the workbook's own footnotes would report the cut-down count
    // as authoritative. rpcAll asks for an exact count and only pages when the count proves a cap
    // was hit, so it costs one extra round-trip's worth of counting and nothing else under the cap.
    // Ordered for deterministic paging.
    const data = await rpcAll(
      supabase,
      "phx_marketing_coverage_export_sales_detail",
      { p_request_ids: part, p_exclude_product_codes: excludeCodes },
      ["request_id", "invoice_period", "product_code", "customer_code"],
    );
    for (const dbRow of (data ?? []) as Array<{
      request_id: string;
      distributor_code: string | null;
      distributor_name: string | null;
      invoice_period: string;
      product_code: string;
      product_name: string | null;
      customer_code: string;
      qty: number | string | null;
      value: number | string | null;
    }>) {
      rows.push({
        requestId: dbRow.request_id,
        requestCode: codeByRequest.get(dbRow.request_id) ?? dbRow.request_id,
        customerCode: dbRow.customer_code,
        distributorCode: dbRow.distributor_code,
        distributorName: dbRow.distributor_name,
        productCode: dbRow.product_code,
        productName: (dbRow.product_name ?? "").trim() || dbRow.product_code,
        invoicePeriod: dbRow.invoice_period,
        qty: toNum(dbRow.qty),
        value: roundMarketingMoney(toNum(dbRow.value)),
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.requestCode.localeCompare(b.requestCode) ||
      a.invoicePeriod.localeCompare(b.invoicePeriod) ||
      a.productName.localeCompare(b.productName),
  );
  return rows;
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
