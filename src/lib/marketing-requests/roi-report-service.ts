import type { AccessContext } from "@/lib/auth/permissions";
import { getUserLineScopeOverride } from "@/lib/auth/scope-visibility";
import { describeUnexpectedError, errorMessageOf, notFoundError } from "@/lib/http/api-errors";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { logError } from "@/lib/observability/log";
import { roundMarketingMoney, roundMarketingRatio } from "@/lib/marketing-requests/roi";
import { resolveRoiDataCoverage } from "@/lib/marketing-requests/roi-labels";
import { lastFinishedCairoMonth, pickLoadedFrontier } from "@/lib/marketing-requests/roi-frontier";
import { sharedAttributionOverlap } from "@/lib/marketing-requests/roi-attribution-overlap";
import {
  assertMarketingWorkspaceAccess,
  normalizeHrId,
  resolveStoredEmployeeHrId,
} from "@/lib/marketing-requests/service";
import {
  LINE_ROUTE_ROLE,
  collectRequestLineNames,
  computeMarketingFilterOptions,
  lineRouteAdmitsRequest,
  resolveMarketingRoiScope,
  territoryRouteAdmitsRequest,
} from "@/lib/marketing-requests/roi-report-scope";
import { entryMatchesRoiFilters } from "@/lib/marketing-requests/roi-facets";
import {
  emptyRoiFilterState,
  type MarketingRoiExportApprovalRow,
  type MarketingRoiExportDetail,
  type MarketingRoiExportPharmacyRow,
  type MarketingRoiExportProductRow,
  type MarketingRoiFilterFacets,
  type MarketingRoiKpiBand,
  type MarketingRoiPreset,
  type MarketingRoiReport,
  type MarketingRoiReportRow,
  type MarketingRoiRequestIndexEntry,
  type MarketingRoiResultStatus,
  type MarketingRoiReverseLookupRow,
  type MarketingRoiScope,
  type MarketingRoiViewSales,
  type MarketingRoiViewSalesAggregate,
  type MarketingRoiViewSalesRow,
  type RoiAttributionLine,
  type RoiFilterKey,
  type RoiFilterState,
} from "@/lib/marketing-requests/roi-report-types";
import {
  RESTRICTED_PRODUCT_CODES,
  canViewRestrictedProducts,
  isRestrictedProductCode,
  normalizeProductNameKey,
  restrictedProductNameSet,
} from "@/lib/sales/access-scope";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";
import { isUuid } from "@/lib/http/uuid";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing ROI Filter-Engine — server data layer.
//
// One scoped pass builds a lightweight per-request index for every request the
// viewer may see (drop the old load-200-then-filter). Filter options are computed
// from that index (cheap, no ROI math); the report runs the rolled-up attribution
// RPC only on the requests that survive the chosen filters. Confidential products
// (LA003/LA004/SS001) are masked out of options, rows, KPIs and the actuals RPC
// unless a CEO/Super Admin opts in.
// ─────────────────────────────────────────────────────────────────────────────

const RESTRICTED_CODES_UPPER = RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase());

/**
 * A marketing product is confidential when its CODE is a restricted code OR — the load-bearing
 * case — its NORMALIZED NAME matches a restricted product. marketing_products use a different
 * code namespace (MKT_PRD####) from the Source-of-Sales restricted codes (LA003/LA004/SS001),
 * and the ROI attribution bridges marketing→sales by NAME, so the name guard is what actually
 * protects this module (mirrors the sales pipeline's dual code+name guard).
 */
export function isRestrictedMarketingProduct(
  code: string | null | undefined,
  normalizedName: string | null | undefined,
  restrictedNames: Set<string>,
): boolean {
  if (isRestrictedProductCode(code)) return true;
  const key = normalizeProductNameKey(normalizedName);
  return key.length > 0 && restrictedNames.has(key);
}

export type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

export type RoiRequestRow = {
  id: string;
  request_code: string;
  requester_hr_id: string;
  manager_hr_id: string | null;
  customer_id: string;
  status: MarketingRoiReportRow["status"];
  request_type_id: number | string;
  pay_date: string | null;
  roi_duration_months: number | string;
  estimated_cost: number | string | null;
  expected_roi_value: number | string | null;
  required_roi_value: number | string | null;
};

export type MappedRoiRequest = {
  id: string;
  requestCode: string;
  requesterHrId: string;
  managerHrId: string | null;
  customerId: string;
  status: MarketingRoiReportRow["status"];
  requestTypeId: number;
  payDate: string | null;
  roiDurationMonths: number;
  estimatedCost: number;
  expectedRoiValue: number;
  requiredRoiValue: number;
};

const APPROVED_STATUSES = new Set<MarketingRoiReportRow["status"]>([
  "approved",
  "active",
  "roi_tracking",
  "closed",
  "finance_hold",
]);

/** Statuses whose money is still awaiting a decision. */
const PENDING_STATUSES = new Set<MarketingRoiReportRow["status"]>([
  "draft",
  "pending_approval",
  "pending_validation",
  "returned",
]);

/**
 * Which KPI money bucket a request's attributed sales belong to — `null` for `rejected` and
 * `archived`, which belong to NEITHER. Their sales are real history, but the money is neither
 * committed nor awaiting anyone: the band's own chip reads "held in pending requests", so
 * bucketing everything that is not approved as pending told an executive that 277,353 EGP of
 * refused and archived spend was still live.
 */
export function roiValueBucket(status: MarketingRoiReportRow["status"]): "approved" | "pending" | null {
  if (APPROVED_STATUSES.has(status)) return "approved";
  if (PENDING_STATUSES.has(status)) return "pending";
  return null;
}

/**
 * The default report scope — what an executive means by "our marketing spend".
 *
 * The ROI index deliberately loads every status that carries a pay date so archived and rejected
 * campaigns stay selectable in the filter panel; without this default an unfiltered page therefore
 * opened on all of them and its headline cost read 1,336,971 EGP against the Sales-Marketing
 * Intelligence dashboard's 762,010. An explicit status selection always wins, so opting back into
 * archived or rejected still works.
 */
export function resolveRoiStatusScope(status: RoiFilterState["status"]): RoiFilterState["status"] {
  return status.length > 0 ? status : [...APPROVED_STATUSES];
}

/**
 * The name printed as "Exported by" on a marketing workbook. Every export route passed the HR id
 * as BOTH the name and the id, so the cover sheet read "A-9 (A-9)" — names, never ids. Falls back
 * to the login, then to "Unknown user"; never throws, because a cover-sheet label must not fail
 * the export.
 */
export async function resolveMarketingExporterName(access: Pick<AccessContext, "hrId" | "loginId">): Promise<string> {
  const hrId = (access.hrId ?? "").trim();
  if (hrId) {
    try {
      const { data } = await getSupabaseAdmin()
        .from("employees")
        .select("full_name, nickname")
        .eq("hr_id", hrId)
        .maybeSingle();
      if (data) {
        const name = resolveEmployeeDisplayName(String(data.full_name ?? ""), data.nickname ?? null);
        if (name) return name;
      }
    } catch {
      // Fall through to the login — the label is never worth failing the export over.
    }
  }
  return (access.loginId ?? "").trim() || "Unknown user";
}

export function toNum(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function chunk<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Log an unexpected ROI service failure with FULL PostgREST detail (code/details/hint), then let
 * the caller rethrow. Production 500s on this module were undiagnosable because the route catch
 * only emitted a generic message; this records the exact DB error (e.g. SQLSTATE 57014 statement
 * timeout) and which stage raised it. Forbidden (access-control) throws are expected control-flow
 * and are deliberately NOT logged as errors.
 */
export function logRoiServiceFailure(stage: string, error: unknown, meta?: Record<string, unknown>): void {
  if (errorMessageOf(error).toLowerCase().startsWith("forbidden:")) return;
  logError(`Marketing ROI service failure: ${stage}`, {
    labels: { event: "marketing_roi_service_failed", stage },
    error,
    context: { details: describeUnexpectedError(error), ...(meta ?? {}) },
  });
}

/** Load every row of `table` for the given request ids (chunked .in()). */
export async function loadByRequestIds<T>(
  supabase: SupabaseAdmin,
  table: string,
  columns: string,
  requestIds: string[],
): Promise<T[]> {
  if (requestIds.length === 0) return [];
  const out: T[] = [];
  for (const part of chunk(requestIds)) {
    const { data, error } = await supabase.from(table).select(columns).in("request_id", part);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export function mapRoiRequest(row: RoiRequestRow): MappedRoiRequest {
  const estimatedCost = toNum(row.estimated_cost);
  const roiDurationMonths = Math.max(1, Number(row.roi_duration_months) || 1);
  return {
    id: row.id,
    requestCode: row.request_code,
    requesterHrId: row.requester_hr_id,
    managerHrId: row.manager_hr_id,
    customerId: row.customer_id,
    status: row.status,
    requestTypeId: Number(row.request_type_id),
    payDate: row.pay_date,
    roiDurationMonths,
    estimatedCost,
    expectedRoiValue: toNum(row.expected_roi_value),
    // Mirrors the generated DB column (marketing_roi_flat_no_duration): required ROI is a FLAT
    // 10× estimated cost — campaign duration does NOT scale the target.
    requiredRoiValue: toNum(row.required_roi_value ?? estimatedCost * 10),
  };
}

/** Walk the requester's manager chain and capture the first DM / NSM / RSM seat. */
export function resolveChainSeats(
  requesterHrId: string,
  byHrId: Map<string, EmployeeDirectoryRow>,
): {
  dmHrId: string | null;
  dmName: string | null;
  nsmHrId: string | null;
  nsmName: string | null;
  rsmHrId: string | null;
  rsmName: string | null;
} {
  const seats = {
    dmHrId: null as string | null,
    dmName: null as string | null,
    nsmHrId: null as string | null,
    nsmName: null as string | null,
    rsmHrId: null as string | null,
    rsmName: null as string | null,
  };
  const visited = new Set<string>();
  let current = byHrId.get(requesterHrId) ?? null;
  // Include the requester themselves so a DM/NSM submitter classifies under their own seat.
  let depth = 0;
  while (current && depth < 9) {
    const key = normalizeHrId(current.hrId);
    if (!key || visited.has(key)) break;
    visited.add(key);
    const fn = resolveJobFunctionRole(current.jobTitle);
    if (fn === "District Manager" && !seats.dmHrId) {
      seats.dmHrId = key;
      seats.dmName = current.displayName ?? null;
    } else if (fn === "Regional Manager" && !seats.rsmHrId) {
      seats.rsmHrId = key;
      seats.rsmName = current.displayName ?? null;
    } else if (fn === "National Sales Manager" && !seats.nsmHrId) {
      seats.nsmHrId = key;
      seats.nsmName = current.displayName ?? null;
    }
    const managerKey = normalizeHrId(current.managerHrId);
    current = managerKey ? byHrId.get(managerKey) ?? null : null;
    depth += 1;
  }
  return seats;
}

type RoiIndexContext = {
  scope: MarketingRoiScope;
  entries: MarketingRoiRequestIndexEntry[];
  requestById: Map<string, MappedRoiRequest>;
  customerNameById: Map<string, string>;
  salesDataAsOf: string | null;
};


// Best-effort warm-function cache for the expensive role-scoped ROI index.
const ROI_INDEX_CACHE_TTL_MS = 60_000;
const ROI_INDEX_CACHE_MAX_ENTRIES = 32;

type RoiIndexCacheEntry = {
  expiresAt: number;
  promise: Promise<RoiIndexContext>;
};

const roiIndexCache = new Map<string, RoiIndexCacheEntry>();

function roiIndexCacheKey(access: AccessContext, revealRestricted: boolean): string {
  return [
    access.source,
    access.role,
    access.scope,
    normalizeHrId(access.hrId) ?? "",
    (access.loginId ?? "").trim().toLowerCase(),
    revealRestricted ? "restricted" : "masked",
  ].join("|");
}

function trimRoiIndexCache(now: number) {
  for (const [key, entry] of roiIndexCache) {
    if (entry.expiresAt <= now) roiIndexCache.delete(key);
  }
  while (roiIndexCache.size > ROI_INDEX_CACHE_MAX_ENTRIES) {
    const oldestKey = roiIndexCache.keys().next().value;
    if (!oldestKey) break;
    roiIndexCache.delete(oldestKey);
  }
}

function getCachedRoiIndex(access: AccessContext, revealRestricted: boolean): Promise<RoiIndexContext> {
  const now = Date.now();
  trimRoiIndexCache(now);

  const key = roiIndexCacheKey(access, revealRestricted);
  const cached = roiIndexCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = buildRoiIndex(access, revealRestricted);
  roiIndexCache.set(key, { expiresAt: now + ROI_INDEX_CACHE_TTL_MS, promise });
  void promise.catch(() => {
    if (roiIndexCache.get(key)?.promise === promise) roiIndexCache.delete(key);
  });
  return promise;
}

/** PM/GPM product ownership (§A default = by their employees.line_id). */
export async function resolveOwnedProductScope(
  supabase: SupabaseAdmin,
  access: AccessContext,
  byHrId: Map<string, EmployeeDirectoryRow>,
): Promise<{ ownedProductCodes: Set<string>; ownedLineNames: Set<string> }> {
  const ownedProductCodes = new Set<string>();
  const ownedLineNames = new Set<string>();
  const viewer = byHrId.get(normalizeHrId(access.hrId) ?? "");
  const lineId = viewer?.lineId ?? null;
  if (viewer?.lineName) ownedLineNames.add(viewer.lineName);
  if (lineId === null || lineId === undefined) {
    return { ownedProductCodes, ownedLineNames };
  }
  const { data, error } = await supabase
    .from("marketing_products")
    .select("product_code, line_id, active")
    .eq("line_id", lineId)
    .or("active.is.null,active.eq.true");
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ product_code?: string | null }>) {
    const code = (row.product_code ?? "").trim().toUpperCase();
    if (code) ownedProductCodes.add(code);
  }
  return { ownedProductCodes, ownedLineNames };
}

/**
 * The National Sales Manager's `line_scope_override`, for the LINE route (owner, 2026-10-20: "He
 * sees every campaign on his line, whoever ran it"). Read only for that role — every other seat
 * answers null without a database read, and `resolveMarketingRoiScope` /
 * `resolveMarketingCoverageScope` ignore the value for any other role anyway. A login with no
 * override (or no login at all, e.g. a dev-auth header session) still has his own seat line.
 */
export async function resolveLineRouteOverride(access: AccessContext): Promise<string[] | null> {
  if (access.role !== LINE_ROUTE_ROLE) return null;
  return getUserLineScopeOverride(access.loginId ?? "");
}

/**
 * The last month whose sales are actually LOADED — the ROI report's completeness flag.
 *
 * 🔴 IT IS NOT "the newest month any validated batch mentions", AND THE DIFFERENCE IS A VERDICT.
 * That was the old reading, and on 2026-10-02 it answered 2026-09 on the strength of ONE batch of
 * eighteen — 41 rows against August's ~44,500. Everything downstream believed September was in:
 * three campaigns whose window is exactly 2026-09 flipped from `awaiting_data` to `no_data`, which
 * on this report means "the campaign sold nothing", and the page printed "sales loaded through
 * 2026-09" underneath. The money had not failed to arrive; the file had.
 *
 * 🔴 THE BAR IS THE EVERY-MONTH SET, NEVER A HEADCOUNT. "Not every distributor uploads every
 * month" is a standing owner rule and "N of 17 missing" is explicitly never a finding, so counting
 * distributors would mark a month incomplete for ever the moment one feed stops. The set is
 * measured over the SETTLED months — every month but the newest — because the newest is the one
 * being judged, and letting it vote would mean a single early file defines the bar it then passes.
 * Measured on production 2026-10-02: 12 distributors file every month, present 12/12 in each of
 * 2026-01..2026-08 and 0/12 in 2026-09, so the answer is 2026-08.
 *
 * The SQL helper answers the same question; this mirrors it for a database where the function has
 * not been applied yet, and the two must not drift — a report that silently falls back to a more
 * optimistic definition is the original bug wearing a different hat.
 */
export async function loadLatestValidatedPeriod(supabase: SupabaseAdmin): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("phx_marketing_roi_latest_validated_period");
    if (!error && typeof data === "string" && data) return data;
    if (!error && data == null) return null;
  } catch {
    // fall through
  }

  try {
    const { data, error } = await supabase
      .from("source_of_sales_import_batches")
      .select("period, distributor_code, template_key")
      .eq("status", "validated");
    if (error) throw error;
    return pickLoadedFrontier(
      (data ?? []) as Array<{ period?: string | null; distributor_code?: string | null; template_key?: string | null }>,
      lastFinishedCairoMonth(),
    );
  } catch {
    return null;
  }
}

/**
 * Build the role-scoped per-request index for one viewer: load every visible
 * request (any status, with a pay date) plus its products, target pharmacies,
 * approval stages and the requester's directory context, then keep only the
 * requests the viewer may see.
 *
 * `revealRestricted` controls whether confidential products are kept in each
 * entry's product list (so they can be offered as filter options / counted) —
 * false for everyone except an opted-in CEO/Super Admin.
 */
async function buildRoiIndex(access: AccessContext, revealRestricted: boolean): Promise<RoiIndexContext> {
  assertMarketingWorkspaceAccess(access);
  const supabase = getSupabaseAdmin();
  // Include terminated/resigned employees: marketing ROI is a HISTORICAL report, so requests
  // from departed reps must still resolve their requester name/line/region and manager chain.
  // Otherwise those requests show "unassigned". This does NOT widen the viewer's access scope.
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

  const scope = resolveMarketingRoiScope(access, employeeRows, {
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
  const allIds = requests.map((request) => request.id);

  const [productLinks, pharmacyLinks, approvalSteps, rollupRows, customersResult, typesResult, salesDataAsOf] =
    await Promise.all([
      loadByRequestIds<{ request_id: string; product_id: number | string }>(
        supabase,
        "marketing_request_products",
        "request_id, product_id",
        allIds,
      ),
      // `pharmacy_id` too: a target with no distributor code (a nursery) has nothing to look up
      // in the code table, and without this it would be dropped from the report entirely.
      loadByRequestIds<{ request_id: string; distributor_code_id: string | null; pharmacy_id: string }>(
        supabase,
        "marketing_request_pharmacies",
        "request_id, distributor_code_id, pharmacy_id",
        allIds,
      ),
      loadByRequestIds<{ request_id: string; assigned_role: string | null; is_cc: boolean | null; status: string | null }>(
        supabase,
        "marketing_request_approval_steps",
        "request_id, assigned_role, is_cc, status",
        allIds,
      ),
      supabase
        .from("marketing_roi_distributor_rollup")
        .select("marketing_normalized_name, parent_distributor_code"),
      // `area_id` too: it is the TERRITORY route a Medical Rep's ROI Tracker runs on — see the
      // scope gate below and MarketingRoiScope.visibleAreaIds.
      supabase.from("marketing_customers").select("id, display_name, area_id"),
      supabase.from("marketing_request_types").select("id, name"),
      loadLatestValidatedPeriod(supabase),
    ]);
  if (rollupRows.error) throw rollupRows.error;
  if (customersResult.error) throw customersResult.error;
  if (typesResult.error) throw typesResult.error;

  // ── product master lookup ──────────────────────────────────────────────────
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

  // ── pharmacy distributor codes → distributor → rollup parent ────────────────
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

  const pharmacyIds = Array.from(new Set([
    ...Array.from(codeById.values()).map((entry) => entry.pharmacyId),
    // The codeless targets, which reach the name lookup by no other route.
    ...pharmacyLinks.filter((link) => !link.distributor_code_id).map((link) => link.pharmacy_id),
  ].filter(Boolean)));
  const pharmacyNameById = new Map<string, string>();
  for (const part of chunk(pharmacyIds)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase.from("marketing_pharmacies").select("id, display_name").in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; display_name?: string | null }>) {
      pharmacyNameById.set(row.id, (row.display_name ?? "").trim());
    }
  }

  const customerRows = (customersResult.data ?? []) as Array<{
    id: string;
    display_name?: string | null;
    area_id?: number | string | null;
  }>;
  const customerNameById = new Map(
    customerRows.map((row) => [row.id, (row.display_name ?? "").trim() || row.id] as const),
  );
  const customerAreaIdById = new Map<string, number>();
  for (const row of customerRows) {
    if (row.area_id === null || row.area_id === undefined) continue;
    const areaId = Number(row.area_id);
    if (Number.isFinite(areaId)) customerAreaIdById.set(row.id, areaId);
  }
  /**
   * The territory route (owner, 2026-09-18; narrowed to the rep's own LINE 2026-09-30): a Medical
   * Rep sees a request raised by anyone when its TARGET CUSTOMER sits in their own area AND the
   * request is on their own line — in practice, their District Manager's spend on their own patch.
   * Empty for every other seat, so this is a no-op for them.
   *
   * The decision itself is `territoryRouteAdmitsRequest` in roi-report-scope.ts — pure, and pinned
   * by tests/medical-rep-marketing-scope.test.ts. This closure only supplies the target's area id.
   */
  const requestIsInViewerArea = (customerId: string, requestLineNames: Iterable<string>) =>
    territoryRouteAdmitsRequest(scope, customerAreaIdById.get(customerId) ?? null, requestLineNames);
  const typeNameById = new Map(
    ((typesResult.data ?? []) as Array<{ id: number | string; name?: string | null }>).map(
      (row) => [Number(row.id), (row.name ?? "").trim() || `Type ${row.id}`] as const,
    ),
  );

  // ── group links by request ──────────────────────────────────────────────────
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
    const code = link.distributor_code_id ? codeById.get(link.distributor_code_id) : null;
    // A target with no distributor code is NOT a broken row to skip past — it is a venue with no
    // distributor account, and the money spent on it is just as real. Listed with no parent
    // distributor, which is what makes it visibly unattributable rather than invisibly absent.
    if (!code) {
      if (link.distributor_code_id) continue;
      const list = pharmaciesByRequest.get(link.request_id) ?? [];
      list.push({
        key: link.pharmacy_id,
        name: pharmacyNameById.get(link.pharmacy_id) || link.pharmacy_id,
        parentCode: null,
      });
      pharmaciesByRequest.set(link.request_id, list);
      continue;
    }
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

  // Confidential products are matched by NAME here (marketing codes are a different namespace).
  const restrictedNames = await restrictedProductNameSet();

  // ── assemble + scope-filter entries ─────────────────────────────────────────
  const entries: MarketingRoiRequestIndexEntry[] = [];
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

    // Line: the promoted products' line (marketing_products carry one). A request spanning multiple
    // lines is shown as a sorted join.
    //
    // An older comment here said the employee master "leaves line_name unset for ~all reps", which
    // is why this never consulted the requester. Re-measured on production 2026-09-30 and it is no
    // longer true: `employees.line_id` is set for all 72 active reps and all 19 District Managers,
    // agrees 1:1 with `au.v_org_tree.line_name`, and all four `public.lines` rows are active — so the
    // seat line resolves for every requester. It is not swapped in as the label (the products' line
    // is what a reader of this column wants), but it IS one of the two signals the territory route
    // below unions, and a future session should not distrust it on the strength of that old note.
    const productLines = Array.from(new Set(rawProducts.map((p) => p.line).filter((l): l is string => Boolean(l)))).sort();
    const derivedLine = productLines.length > 0 ? productLines.join(" / ") : null;

    /**
     * Which line(s) this request belongs to, for the territory route's line half AND the National
     * Sales Manager's line route. Both signals are unioned rather than ranked: the requester's own
     * seat line and the promoted products' lines agree on all 45 production requests carrying a pay
     * date, and either one alone has a gap the other covers. Built from `rawProducts`, never
     * `visibleProducts`, so masking a confidential product can never widen or narrow who may see
     * the row.
     *
     * A request spanning two lines is on BOTH, so the rep of either line on that patch sees it, and
     * so does the NSM of either line. Empty means the line is unknown — both routes then refuse it.
     */
    const requestLineNames = collectRequestLineNames(requesterRow?.lineName ?? null, productLines);

    // Scope gate.
    if (!scope.isCompanyWide) {
      if (scope.visibleProductCodes) {
        // PM/GPM: product-centric — keep only requests promoting an owned product.
        const owned = scope.visibleProductCodes;
        if (!rawProducts.some((product) => owned.has(product.code))) continue;
      } else if (scope.visibleRequesterHrIds) {
        // Three doors, any one admits: the requester route (his chain raised it), the Medical
        // Rep's territory route, and the National Sales Manager's line route (owner, 2026-10-20 —
        // a Product / Group Product / Marketing Manager's campaign on his line, whoever ran it).
        if (
          !scope.visibleRequesterHrIds.has(requesterKey) &&
          !requestIsInViewerArea(request.customerId, requestLineNames) &&
          !lineRouteAdmitsRequest(scope, requestLineNames)
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

/**
 * The viewer's role-scoped request index for the SMART (faceted) filter panel. The
 * client computes dependent/cascading options from this index live (choose an NSM and
 * the DM list collapses to that NSM's DMs, etc.). Confidential products are revealed in
 * the index only to a CEO/Super Admin (so they can filter by them); everyone else never
 * receives them. No ROI math here — it's a cheap projection of the visible requests.
 */
export async function getMarketingRoiFilterOptions(access: AccessContext): Promise<MarketingRoiFilterFacets> {
  try {
    const ctx = await getCachedRoiIndex(access, /* revealRestricted */ access.role === "CEO" || access.role === "Super Admin");
    return {
      entries: ctx.entries,
      canRevealRestricted: ctx.scope.canRevealRestricted,
      totalCount: ctx.entries.length,
    };
  } catch (error) {
    logRoiServiceFailure("getMarketingRoiFilterOptions:buildRoiIndex", error, { role: access.role });
    throw error;
  }
}

export function monthAdd(period: string, months: number): string {
  // period = "YYYY-MM"; returns the YYYY-MM `months` later (months>=0).
  const [yearText, monthText] = period.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1 + months;
  const resultYear = year + Math.floor(monthIndex / 12);
  const resultMonth = ((monthIndex % 12) + 12) % 12;
  return `${resultYear}-${String(resultMonth + 1).padStart(2, "0")}`;
}

/**
 * Realized-ROI verdict for one request. "Actual vs required" is only a fair judgement once the
 * FULL ROI window has been loaded:
 *  - a request that has ALREADY met/exceeded its required return is `on_track` even mid-window;
 *  - a request still below target while its window has unuploaded months is `awaiting_data`
 *    (≠ behind) — an in-progress campaign must not be flagged as failing against its full
 *    multi-month required return;
 *  - only once the window is complete is the request judged `behind` (some sales, below target)
 *    or `no_data` (nothing attributed).
 * This honors the documented contract that `awaiting_data` means the window has unuploaded months.
 */
export function resolveRoiResultStatus(input: {
  salesRows: number;
  actualValue: number;
  requiredRoiValue: number;
  salesDataComplete: boolean;
}): MarketingRoiResultStatus {
  if (input.salesRows > 0 && input.actualValue >= input.requiredRoiValue) return "on_track";
  if (!input.salesDataComplete) return "awaiting_data";
  if (input.salesRows > 0) return "behind";
  return "no_data";
}

export function roiWindowLabel(payDate: string | null, months: number): { label: string | null; endPeriod: string | null } {
  if (!payDate) return { label: null, endPeriod: null };
  const start = payDate.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(start)) return { label: null, endPeriod: null };
  const end = monthAdd(start, Math.max(1, months) - 1);
  return { label: `${start} → ${end}`, endPeriod: end };
}

// Single source of truth for "does this entry match the chosen filters" — shared with
// the client's faceted filter engine (roi-facets) so the panel and the report agree.
function matchesNonRoiFilters(entry: MarketingRoiRequestIndexEntry, filters: RoiFilterState): boolean {
  return entryMatchesRoiFilters(entry, filters);
}

export type ActualsRow = {
  request_id: string;
  actual_value: number | string | null;
  actual_units: number | string | null;
  sales_rows: number | string | null;
  attribution_quality?: string | null;
};

export async function loadActuals(
  supabase: SupabaseAdmin,
  requestIds: string[],
  excludeCodes: string[],
): Promise<{ byRequest: Map<string, { value: number; units: number; salesRows: number; quality: string }>; masked: boolean }> {
  const byRequest = new Map<string, { value: number; units: number; salesRows: number; quality: string }>();
  if (requestIds.length === 0) return { byRequest, masked: false };

  const ingest = (rows: ActualsRow[]) => {
    for (const row of rows) {
      byRequest.set(row.request_id, {
        value: toNum(row.actual_value),
        units: toNum(row.actual_units),
        salesRows: toNum(row.sales_rows),
        quality: row.attribution_quality ?? "no_sales",
      });
    }
  };

  // Always prefer the v2 RPC — even when excludeCodes is empty (CEO/Super Admin with "include
  // restricted" ticked). v2 is not just "v1 + masking": since the 2026-07-19 Phase-D migration
  // (20260719151000_marketing_roi_actuals_v2_direct_branch.sql) it also carries the
  // track_direct_sales direct-order branch that v1 never received. Calling v1 directly whenever
  // there was nothing to mask used to be a safe, byte-identical shortcut — the original masking
  // migration's own comment documented "passing an empty array reproduces the base RPC exactly"
  // — but Phase-D silently broke that equivalence, so the shortcut made this report's total flip
  // between two different attribution engines depending purely on the includeRestricted toggle.
  // Fall back to v1 only when v2 itself errors (e.g. not deployed yet), never as a deliberate
  // no-masking-needed shortcut.
  try {
    for (const part of chunk(requestIds, 300)) {
      const { data, error } = await supabase.rpc("phx_marketing_request_roi_actuals_v2", {
        p_request_ids: part,
        p_exclude_product_codes: excludeCodes,
      });
      if (error) throw error;
      ingest((data ?? []) as ActualsRow[]);
    }
    return { byRequest, masked: false };
  } catch {
    // v2 not deployed yet. When masking was actually required, withhold confidential-bearing
    // requests (masked: true) so a non-revealing viewer can never see a confidential-inflated
    // number. When masking was NOT required, v1 is still a strictly-worse read (missing
    // direct-order sales) but there is no further fallback — masked stays false since nothing
    // needed withholding.
    for (const part of chunk(requestIds, 300)) {
      const { data, error } = await supabase.rpc("phx_marketing_request_roi_actuals", { p_request_ids: part });
      if (error) throw error;
      ingest((data ?? []) as ActualsRow[]);
    }
    return { byRequest, masked: excludeCodes.length > 0 };
  }
}

export type { RoiAttributionLine } from "@/lib/marketing-requests/roi-report-types";

type AttributionLineDbRow = {
  customer_code: string;
  distributor_code: string | null;
  invoice_period: string;
  product_code: string;
  qty: number | string | null;
  request_id: string;
  value: number | string | null;
};

const ATTRIBUTION_LINE_CHUNK_SIZE = 150;

/**
 * Every claimed invoice line for the given requests, one row per (request, matched sale), in a
 * few bulk calls — never one RPC per request.
 *
 * Deliberately a local loader rather than a call into coverage-report-service's export version of
 * the same read: that module imports this one, so reusing it would close an import cycle.
 */
export async function loadAttributionLines(
  supabase: SupabaseAdmin,
  requestIds: string[],
  excludeCodes: string[],
): Promise<RoiAttributionLine[]> {
  const lines: RoiAttributionLine[] = [];
  if (requestIds.length === 0) return lines;

  for (const part of chunk(requestIds, ATTRIBUTION_LINE_CHUNK_SIZE)) {
    if (part.length === 0) continue;
    // rpcAll, not a bare .rpc(): PostgREST caps every response at db-max-rows (1000) with no
    // error, and lines lost to that cap are lines whose overlap goes unseen — the KPI band would
    // silently drift back up toward the double-counted total it exists to correct.
    // Ordered for deterministic paging.
    const data = await rpcAll<AttributionLineDbRow>(
      supabase,
      "phx_marketing_coverage_export_sales_detail",
      { p_request_ids: part, p_exclude_product_codes: excludeCodes },
      ["request_id", "invoice_period", "product_code", "customer_code"],
    );
    for (const row of data ?? []) {
      lines.push({
        customerCode: row.customer_code,
        distributorCode: row.distributor_code ?? "",
        invoicePeriod: row.invoice_period,
        productCode: row.product_code,
        qty: toNum(row.qty),
        requestId: row.request_id,
        value: toNum(row.value),
      });
    }
  }
  return lines;
}

// The overlap arithmetic lives in roi-attribution-overlap.ts — pure and client-safe, so the
// Coverage Report's breakdown and trend can dedupe per bucket with the very same function.
export { sharedAttributionOverlap } from "@/lib/marketing-requests/roi-attribution-overlap";

/**
 * The filtered, role-scoped ROI report + executive KPI band. `filters` is the full
 * RoiFilterState; confidential products are included only when a CEO/Super Admin
 * sets `includeRestricted`.
 */
export async function getMarketingRoiReport(
  access: AccessContext,
  filters: RoiFilterState,
  generatedAtIso: string,
): Promise<MarketingRoiReport> {
  const includeRestricted = filters.includeRestricted && (access.role === "CEO" || access.role === "Super Admin");
  let ctx: RoiIndexContext;
  try {
    ctx = await getCachedRoiIndex(access, includeRestricted);
  } catch (error) {
    logRoiServiceFailure("getMarketingRoiReport:buildRoiIndex", error, { role: access.role });
    throw error;
  }
  const supabase = getSupabaseAdmin();
  const customerNameById = ctx.customerNameById;
  // The scope the report actually ran on, echoed back as appliedFilters.
  //
  // NOT yet visible in the Filter Engine panel: roi-filter-engine.tsx keeps its own `filters`
  // state and never reads report.appliedFilters, so today the only reader is the export
  // workbook's "Applied filters" line (marketing-roi-workbook.ts). Until the panel adopts
  // appliedFilters (or renders the default as chips itself), the default status scope IS applied
  // invisibly — an unfiltered viewer sees 101 requests where the index holds 218, with nothing
  // on screen saying why. Do not describe this line as the fix for that.
  const scopedFilters: RoiFilterState = { ...filters, status: resolveRoiStatusScope(filters.status) };

  // 1) apply every non-ROI filter to the scoped index.
  const candidates = ctx.entries.filter((entry) => matchesNonRoiFilters(entry, scopedFilters));

  // 2) attribution (rolled up, confidential-masked unless opted-in).
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
    // The attribution RPC (phx_marketing_request_roi_actuals[_v2]) is the prime statement-timeout
    // suspect on the unfiltered full request set — log the candidate count so it's obvious in prod.
    logRoiServiceFailure("getMarketingRoiReport:loadActuals", error, {
      role: access.role,
      candidateCount: candidates.length,
      masking: excludeCodes.length > 0,
    });
    throw error;
  }

  // 3) build rows + result status.
  const autoAppliedByDimension: Partial<Record<RoiFilterKey, string[]>> = {};
  const options = computeMarketingFilterOptions(ctx.scope, ctx.entries);
  for (const dim of options.dimensions) {
    if (dim.autoApplied) autoAppliedByDimension[dim.key] = dim.autoApplied;
  }

  const restrictedRequestIds = new Set<string>();
  const withheldRequestIds = new Set<string>();
  const rows: MarketingRoiReportRow[] = candidates.map((entry) => {
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
    // Forecast coverage (expected vs required) mirrors the stored roi_coverage_ratio, computed
    // here so the UI shows it as an explicit FORECAST figure beside the ACTUAL coverage.
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
      customerName: customerNameById.get(request.customerId) ?? request.customerId,
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
    };
  });

  // 4) ROI-status filter (needs the computed status).
  const finalRows = filters.roiStatus.length > 0
    ? rows.filter((row) => filters.roiStatus.includes(row.resultStatus))
    : rows;

  finalRows.sort((left, right) => (right.payDate ?? "").localeCompare(left.payDate ?? ""));

  // Count confidential-excluded requests over the DISPLAYED rows (after the ROI-status filter)
  // so the trust badge reconciles with what the viewer actually sees.
  const restrictedExcludedCount = finalRows.reduce(
    (count, row) => (restrictedRequestIds.has(row.requestId) ? count + 1 : count),
    0,
  );

  // 5) the claimed lines behind the DISPLAYED rows, so the company-wide band can count a sale that
  // several campaigns each legitimately claim exactly once. Withheld requests contribute 0 to the
  // rows, so their lines must not join the ledger either or the band would deduct value no row
  // ever added. A failure here is rethrown rather than swallowed: a band silently rebuilt without
  // the ledger reads ~50% high, and an inflated headline is worse than an error state.
  const ledgerRequestIds = finalRows
    .map((row) => row.requestId)
    .filter((requestId) => !withheldRequestIds.has(requestId));
  let attributionLines: RoiAttributionLine[];
  try {
    attributionLines = await loadAttributionLines(supabase, ledgerRequestIds, excludeCodes);
  } catch (error) {
    logRoiServiceFailure("getMarketingRoiReport:loadAttributionLines", error, {
      role: access.role,
      requestCount: ledgerRequestIds.length,
      masking: excludeCodes.length > 0,
    });
    throw error;
  }
  const kpi = buildKpiBand(finalRows, ctx.salesDataAsOf, restrictedExcludedCount, attributionLines);

  return {
    rows: finalRows,
    kpi,
    appliedFilters: scopedFilters,
    attributionLines,
    autoAppliedByDimension,
    includedRestricted: includeRestricted,
    generatedAtIso,
  };
}

/**
 * The executive band over one row set.
 *
 * `attributionLines` are the claimed invoice lines behind those rows. They are narrowed to the
 * rows present here before anything is deducted, so a caller that has already narrowed `rows`
 * CAN pass the full report's ledger and still get the overlap of ITS subset.
 *
 * Passing none leaves the money totals as the plain sum of the rows, which over-states any set
 * where two campaigns claim the same sale (production: 729,884.77 summed vs 480,155.92 real,
 * +52%). Every caller now passes its report's ledger — the ROI report, ROI Tracking / the Live
 * Tracker, the Coverage Report and the PM/GPM marketing card (the last wired 2026-10-09). The
 * default is `[]` only for tests; it is not a safe default for a new caller.
 */
export function buildKpiBand(
  rows: MarketingRoiReportRow[],
  salesDataAsOf: string | null,
  restrictedExcludedCount: number,
  attributionLines: RoiAttributionLine[] = [],
): MarketingRoiKpiBand {
  let totalEstimatedCost = 0;
  let totalExpectedRoi = 0;
  let totalRequiredRoi = 0;
  let totalActualValue = 0;
  let onTrackCount = 0;
  let behindCount = 0;
  let awaitingDataCount = 0;
  let noDataCount = 0;
  let approvedValue = 0;
  let pendingValue = 0;
  let incompleteWindowCount = 0;

  for (const row of rows) {
    totalEstimatedCost += row.estimatedCost;
    totalExpectedRoi += row.expectedRoiValue;
    totalRequiredRoi += row.requiredRoiValue;
    totalActualValue += row.actualSalesValue;
    if (row.resultStatus === "on_track") onTrackCount += 1;
    else if (row.resultStatus === "behind") behindCount += 1;
    else if (row.resultStatus === "awaiting_data") awaitingDataCount += 1;
    else noDataCount += 1;
    const bucket = roiValueBucket(row.status);
    if (bucket === "approved") approvedValue += row.actualSalesValue;
    else if (bucket === "pending") pendingValue += row.actualSalesValue;
    if (!row.salesDataComplete) incompleteWindowCount += 1;
  }

  // Deduct only value the ledger PROVES was claimed twice, rather than rebuilding the totals from
  // the ledger: direct-order sales are attributed per request and never appear as claimed lines,
  // so a ledger-built total would drop them entirely the moment a campaign tracks direct orders.
  const bucketByRequestId = new Map(rows.map((row) => [row.requestId, roiValueBucket(row.status)] as const));
  const bandLines = attributionLines.filter((line) => bucketByRequestId.has(line.requestId));
  const dedupe = (value: number, lines: RoiAttributionLine[]): number =>
    Math.max(value - sharedAttributionOverlap(lines), 0);
  const distinctActualValue = dedupe(totalActualValue, bandLines);
  const distinctApprovedValue = dedupe(
    approvedValue,
    bandLines.filter((line) => bucketByRequestId.get(line.requestId) === "approved"),
  );
  const distinctPendingValue = dedupe(
    pendingValue,
    bandLines.filter((line) => bucketByRequestId.get(line.requestId) === "pending"),
  );

  return {
    requestCount: rows.length,
    totalEstimatedCost: roundMarketingMoney(totalEstimatedCost),
    totalExpectedRoi: roundMarketingMoney(totalExpectedRoi),
    totalRequiredRoi: roundMarketingMoney(totalRequiredRoi),
    totalActualValue: roundMarketingMoney(distinctActualValue),
    coverageRatio: totalRequiredRoi > 0 ? roundMarketingRatio(distinctActualValue / totalRequiredRoi) : 0,
    onTrackCount,
    behindCount,
    awaitingDataCount,
    noDataCount,
    approvedValue: roundMarketingMoney(distinctApprovedValue),
    pendingValue: roundMarketingMoney(distinctPendingValue),
    salesDataAsOf,
    incompleteWindowCount,
    restrictedExcludedCount,
  };
}

/** Parse a loosely-typed request body into a complete RoiFilterState (defensive). */
export function parseRoiFilterState(input: unknown): RoiFilterState {
  const base = emptyRoiFilterState();
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
    status: strArray(body.status) as RoiFilterState["status"],
    requestType: numArray(body.requestType),
    region: strArray(body.region),
    distributor: strArray(body.distributor),
    product: strArray(body.product),
    pharmacy: strArray(body.pharmacy),
    roiStatus: strArray(body.roiStatus) as RoiFilterState["roiStatus"],
    payDateFrom: typeof body.payDateFrom === "string" && body.payDateFrom ? body.payDateFrom : null,
    payDateTo: typeof body.payDateTo === "string" && body.payDateTo ? body.payDateTo : null,
    durationMin: Number.isFinite(Number(body.durationMin)) && body.durationMin != null ? Number(body.durationMin) : null,
    durationMax: Number.isFinite(Number(body.durationMax)) && body.durationMax != null ? Number(body.durationMax) : null,
    includeRestricted: body.includeRestricted === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved filter presets (owner-scoped, enforced in the service layer)
// ─────────────────────────────────────────────────────────────────────────────

type PresetDbRow = {
  id: string;
  name: string;
  filter_json: unknown;
  is_default: boolean | null;
  updated_at: string | null;
};

function mapPreset(row: PresetDbRow): MarketingRoiPreset {
  return {
    id: row.id,
    name: row.name,
    filters: parseRoiFilterState(row.filter_json),
    isDefault: Boolean(row.is_default),
    updatedAt: row.updated_at ?? "",
  };
}

export function presetOwnerHrId(access: AccessContext): string {
  assertMarketingWorkspaceAccess(access);
  // employees(hr_id) FK is case-sensitive — store/compare the canonical (uppercase) HR_ID.
  const owner = resolveStoredEmployeeHrId(access.hrId);
  if (!owner) throw new Error("Forbidden: a Phoenix employee identity is required to manage presets.");
  return owner;
}

export async function listMarketingRoiPresets(access: AccessContext): Promise<MarketingRoiPreset[]> {
  const owner = presetOwnerHrId(access);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_roi_filter_presets")
    .select("id, name, filter_json, is_default, updated_at")
    .eq("owner_hr_id", owner)
    // This table is shared with the coverage report (report_kind = 'coverage_report');
    // ROI Tracking presets are report_kind = 'roi_tracking'. Without this filter the ROI
    // report would list the coverage report's presets too.
    .eq("report_kind", "roi_tracking")
    .order("is_default", { ascending: false })
    .order("name", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as PresetDbRow[]).map(mapPreset);
}

export async function saveMarketingRoiPreset(
  access: AccessContext,
  input: { name: string; filters: RoiFilterState; isDefault: boolean },
): Promise<MarketingRoiPreset> {
  const owner = presetOwnerHrId(access);
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A preset name is required.");
  const supabase = getSupabaseAdmin();

  // one default per owner PER report_kind: clear only the ROI default, not the coverage one
  // (the partial unique index is on (owner_hr_id, report_kind) WHERE is_default).
  if (input.isDefault) {
    const clear = await supabase
      .from("marketing_roi_filter_presets")
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq("owner_hr_id", owner)
      .eq("report_kind", "roi_tracking")
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
        // Required: the live unique index is (owner_hr_id, report_kind, name) since the coverage
        // report shipped (migration 20260704010000). Omitting report_kind + using the old
        // (owner_hr_id, name) onConflict throws "no unique or exclusion constraint matching the
        // ON CONFLICT specification" — i.e. every ROI preset save failed. Matches coverage-report-service.
        report_kind: "roi_tracking",
        filter_json: input.filters as unknown as Record<string, unknown>,
        is_default: input.isDefault,
        scope_role: access.role,
        updated_at: nowIso,
      },
      { onConflict: "owner_hr_id,report_kind,name" },
    )
    .select("id, name, filter_json, is_default, updated_at")
    .single();
  if (error) throw error;
  return mapPreset(data as PresetDbRow);
}

export async function deleteMarketingRoiPreset(access: AccessContext, id: string): Promise<void> {
  const owner = presetOwnerHrId(access);
  const cleanId = String(id ?? "").trim();
  if (!cleanId) throw new Error("A preset id is required.");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("marketing_roi_filter_presets")
    .delete()
    .eq("id", cleanId)
    .eq("owner_hr_id", owner); // owner-scoped: a user can only delete their own presets
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export audit (best-effort, append-only)
// ─────────────────────────────────────────────────────────────────────────────

/** Record one XLSX export in marketing_roi_export_audit. Best-effort: never fails the export. */
export async function writeMarketingRoiExportAudit(input: {
  access: AccessContext;
  exportId: string;
  kind: "report" | "request" | "coverage_report";
  requestId?: string | null;
  filterJson: Record<string, unknown>;
  rowCount: number;
  includedRestricted: boolean;
  sheets: string[];
  salesDataAsOf: string | null;
}): Promise<void> {
  try {
    // employees(hr_id) FK is case-sensitive — store the canonical (uppercase) HR_ID, never normalizeHrId().
    const storedHrId = resolveStoredEmployeeHrId(input.access.hrId);
    if (!storedHrId) return;
    // A test login's hrId is the real person it mirrors (src/lib/auth/test-persona.ts). The coverage
    // report shows this row as "last exported by", so writing it would name her for an export she never
    // made. The export itself is only a read and still goes ahead.
    if (input.access.testPersona) return;
    const supabase = getSupabaseAdmin();
    await supabase.from("marketing_roi_export_audit").insert({
      id: input.exportId,
      exported_by_hr_id: storedHrId,
      role: input.access.role,
      kind: input.kind,
      request_id: input.requestId ?? null,
      filter_json: input.filterJson,
      row_count: input.rowCount,
      included_restricted: input.includedRestricted,
      sheets: input.sheets,
      sales_data_as_of: input.salesDataAsOf,
    });
  } catch {
    // audit is best-effort; a missing table or FK miss must never break a successful export.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exhaustive export detail — flattened products / pharmacies / approvals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bulk-load the per-request detail (products, target pharmacies, approval steps) for the
 * filtered request set so the export workbook can render exhaustive sheets. Confidential
 * products are dropped unless `reveal`. `requests` carries the id→code map.
 */
export async function loadMarketingRoiExportDetail(
  requests: Array<{ requestId: string; requestCode: string }>,
  reveal: boolean,
): Promise<MarketingRoiExportDetail> {
  const products: MarketingRoiExportProductRow[] = [];
  const pharmacies: MarketingRoiExportPharmacyRow[] = [];
  const approvals: MarketingRoiExportApprovalRow[] = [];
  if (requests.length === 0) return { products, pharmacies, approvals };

  const supabase = getSupabaseAdmin();
  const codeByRequest = new Map(requests.map((row) => [row.requestId, row.requestCode] as const));
  const ids = requests.map((row) => row.requestId);

  const [productLinks, pharmacyLinks, approvalRows, rollupRows] = await Promise.all([
    loadByRequestIds<{ request_id: string; product_id: number | string; product_name_snapshot: string | null; line_snapshot: string | null; factory_price_snapshot: number | string | null; forecast_quantity: number | string | null; expected_value: number | string | null; value_share: number | string | null }>(
      supabase,
      "marketing_request_products",
      "request_id, product_id, product_name_snapshot, line_snapshot, factory_price_snapshot, forecast_quantity, expected_value, value_share",
      ids,
    ),
    loadByRequestIds<{ request_id: string; distributor_code_id: string | null; pharmacy_id: string; tracking_status: string | null }>(
      supabase,
      "marketing_request_pharmacies",
      "request_id, distributor_code_id, pharmacy_id, tracking_status",
      ids,
    ),
    loadByRequestIds<{ request_id: string; sequence: number | string; step_name: string | null; assigned_role: string | null; assigned_hr_id: string | null; status: string | null; decision_by_hr_id: string | null; decision_at: string | null; decision_note: string | null; is_cc: boolean | null }>(
      supabase,
      "marketing_request_approval_steps",
      "request_id, sequence, step_name, assigned_role, assigned_hr_id, status, decision_by_hr_id, decision_at, decision_note, is_cc",
      ids,
    ),
    supabase.from("marketing_roi_distributor_rollup").select("marketing_normalized_name, parent_distributor_code"),
  ]);
  if (rollupRows.error) throw rollupRows.error;

  // products — resolve code + normalized name (for confidential filtering) via product master
  const productIds = Array.from(new Set(productLinks.map((link) => Number(link.product_id)).filter(Boolean)));
  const productMetaById = new Map<number, { code: string; normalizedName: string }>();
  for (const part of chunk(productIds)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase.from("marketing_products").select("id, product_code, product_name, normalized_name").in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: number | string; product_code?: string | null; product_name?: string | null; normalized_name?: string | null }>) {
      productMetaById.set(Number(row.id), {
        code: (row.product_code ?? "").trim().toUpperCase(),
        normalizedName: (row.normalized_name ?? row.product_name ?? "").trim(),
      });
    }
  }
  const restrictedNames = await restrictedProductNameSet();
  for (const link of productLinks) {
    const meta = productMetaById.get(Number(link.product_id)) ?? { code: "", normalizedName: "" };
    const code = meta.code;
    if (!reveal && isRestrictedMarketingProduct(meta.code, meta.normalizedName, restrictedNames)) continue;
    products.push({
      requestId: link.request_id,
      requestCode: codeByRequest.get(link.request_id) ?? link.request_id,
      productCode: code,
      productName: (link.product_name_snapshot ?? "").trim() || code,
      line: link.line_snapshot,
      factoryPrice: toNum(link.factory_price_snapshot),
      forecastQty: toNum(link.forecast_quantity),
      expectedValue: toNum(link.expected_value),
      valueShare: toNum(link.value_share),
    });
  }

  // pharmacies — code + display name + rolled-up parent distributor
  const codeIds = Array.from(new Set(pharmacyLinks.map((link) => link.distributor_code_id).filter(Boolean)));
  const codeInfo = new Map<string, { pharmacyId: string; normalizedCode: string; distributorId: number | null }>();
  for (const part of chunk(codeIds)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("id, pharmacy_id, normalized_pharmacy_code, distributor_id")
      .in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; pharmacy_id: string; normalized_pharmacy_code?: string | null; distributor_id?: number | string | null }>) {
      codeInfo.set(row.id, {
        pharmacyId: row.pharmacy_id,
        normalizedCode: (row.normalized_pharmacy_code ?? "").trim(),
        distributorId: row.distributor_id == null ? null : Number(row.distributor_id),
      });
    }
  }
  const distributorIds = Array.from(new Set(Array.from(codeInfo.values()).map((entry) => entry.distributorId).filter((id): id is number => id != null)));
  const normalizedByDistributor = new Map<number, string>();
  for (const part of chunk(distributorIds)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase.from("marketing_distributors").select("id, normalized_name").in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: number | string; normalized_name?: string | null }>) {
      normalizedByDistributor.set(Number(row.id), (row.normalized_name ?? "").trim().toLowerCase());
    }
  }
  const parentByNormalized = new Map<string, string>();
  for (const row of (rollupRows.data ?? []) as Array<{ marketing_normalized_name: string; parent_distributor_code: string }>) {
    parentByNormalized.set(row.marketing_normalized_name.trim().toLowerCase(), row.parent_distributor_code);
  }
  const pharmacyIds = Array.from(new Set([
    ...Array.from(codeInfo.values()).map((entry) => entry.pharmacyId),
    ...pharmacyLinks.filter((link) => !link.distributor_code_id).map((link) => link.pharmacy_id),
  ].filter(Boolean)));
  const pharmacyNameById = new Map<string, string>();
  for (const part of chunk(pharmacyIds)) {
    if (part.length === 0) continue;
    const { data, error } = await supabase.from("marketing_pharmacies").select("id, display_name").in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; display_name?: string | null }>) {
      pharmacyNameById.set(row.id, (row.display_name ?? "").trim());
    }
  }
  for (const link of pharmacyLinks) {
    const info = link.distributor_code_id ? codeInfo.get(link.distributor_code_id) : null;
    // Same rule as the report above: an unattributable target still appears, with empty code
    // columns saying so. Dropping it would understate how many venues a request actually paid for.
    if (!info) {
      if (link.distributor_code_id) continue;
      pharmacies.push({
        requestId: link.request_id,
        requestCode: codeByRequest.get(link.request_id) ?? link.request_id,
        pharmacyName: pharmacyNameById.get(link.pharmacy_id) || link.pharmacy_id,
        customerCode: "",
        distributorCode: null,
        trackingStatus: link.tracking_status,
      });
      continue;
    }
    const normalized = info.distributorId != null ? normalizedByDistributor.get(info.distributorId) ?? null : null;
    pharmacies.push({
      requestId: link.request_id,
      requestCode: codeByRequest.get(link.request_id) ?? link.request_id,
      pharmacyName: pharmacyNameById.get(info.pharmacyId) || info.normalizedCode || info.pharmacyId,
      customerCode: info.normalizedCode,
      distributorCode: normalized ? parentByNormalized.get(normalized) ?? null : null,
      trackingStatus: link.tracking_status,
    });
  }

  for (const step of approvalRows) {
    approvals.push({
      requestId: step.request_id,
      requestCode: codeByRequest.get(step.request_id) ?? step.request_id,
      sequence: Number(step.sequence) || 0,
      stepName: (step.step_name ?? "").trim(),
      assignedRole: (step.assigned_role ?? "").trim(),
      assignedHrId: step.assigned_hr_id,
      status: (step.status ?? "").trim(),
      decisionByHrId: step.decision_by_hr_id,
      decisionAt: step.decision_at,
      decisionNote: step.decision_note,
      isCc: Boolean(step.is_cc),
    });
  }

  products.sort((a, b) => a.requestCode.localeCompare(b.requestCode) || a.productName.localeCompare(b.productName));
  pharmacies.sort((a, b) => a.requestCode.localeCompare(b.requestCode) || a.pharmacyName.localeCompare(b.pharmacyName));
  approvals.sort((a, b) => a.requestCode.localeCompare(b.requestCode) || a.sequence - b.sequence);

  return { products, pharmacies, approvals };
}

// ─────────────────────────────────────────────────────────────────────────────
// View Sales — per-request drill-down
// ─────────────────────────────────────────────────────────────────────────────

const PERIOD_RE = /^\d{4}-\d{2}$/;

/** Validate an optional YYYY-MM..YYYY-MM range; returns nulls (default window) if absent/invalid. */
export function parseViewSalesRange(
  fromInput: string | null | undefined,
  toInput: string | null | undefined,
): { from: string | null; to: string | null } {
  const from = typeof fromInput === "string" && PERIOD_RE.test(fromInput) ? fromInput : null;
  const to = typeof toInput === "string" && PERIOD_RE.test(toInput) ? toInput : null;
  if (from && to && from <= to) return { from, to };
  return { from: null, to: null };
}

type ViewSalesDbRow = {
  distributor_code: string;
  distributor_name: string | null;
  invoice_period: string;
  product_code: string;
  product_name: string | null;
  customer_code: string;
  customer_name: string | null;
  region_name: string | null;
  qty: number | string | null;
  value: number | string | null;
};

export function aggregateViewSales(
  rows: MarketingRoiViewSalesRow[],
  keyOf: (row: MarketingRoiViewSalesRow) => { key: string; label: string },
): MarketingRoiViewSalesAggregate[] {
  // Units are summed only within ONE product code — a month or a pharmacy that sold two products
  // (or two concentrations) has no meaningful unit total, so its `units` is null and it reads by value.
  const map = new Map<string, { key: string; label: string; value: number; units: number; products: Set<string> }>();
  for (const row of rows) {
    const { key, label } = keyOf(row);
    const current = map.get(key);
    if (current) {
      current.value += row.value;
      current.units += row.qty;
      current.products.add(row.productCode);
    } else {
      map.set(key, { key, label, value: row.value, units: row.qty, products: new Set([row.productCode]) });
    }
  }
  return Array.from(map.values()).map((entry) => ({
    key: entry.key,
    label: entry.label,
    value: roundMarketingMoney(entry.value),
    units: entry.products.size === 1 ? entry.units : null,
  }));
}

/**
 * View Sales drill-down for ONE request. Scoped EXACTLY like the report (so a user can
 * only open a request they can see in the report): company-wide sees all; PM/GPM by owned
 * product; everyone else by the visible-requester subtree. Confidential products are
 * excluded for non CEO/Super Admin. Reconciles to the cent with the report's actuals.
 */
export async function getMarketingRequestViewSales(
  access: AccessContext,
  requestId: string,
  fromInput: string | null | undefined,
  toInput: string | null | undefined,
  generatedAtIso: string,
  /**
   * `includeRestricted: false` masks confidential products even for a role allowed to see them —
   * the Coverage Report's drill-down passes its own toggle. Omitted, a revealing role sees them,
   * as View Sales always has.
   */
  options: { includeRestricted?: boolean } = {},
): Promise<MarketingRoiViewSales> {
  assertMarketingWorkspaceAccess(access);
  const cleanId = String(requestId ?? "").trim();
  if (!cleanId) throw new Error("Marketing request id is required.");
  // A malformed id is NOT FOUND, not a fault: this is a uuid column, and Postgres answers a
  // non-uuid with 22P02 from the WHERE clause instead of with no rows, which leaves as a 500.
  if (!isUuid(cleanId)) throw notFoundError("Marketing request was not found.", "marketing_request_not_found");

  const supabase = getSupabaseAdmin();
  // Include terminated/resigned employees: marketing ROI is a HISTORICAL report, so requests
  // from departed reps must still resolve their requester name/line/region and manager chain.
  // Otherwise those requests show "unassigned". This does NOT widen the viewer's access scope.
  const employeeRows = await getEmployeeDirectoryRows({ includeInactive: true });
  const byHrId = new Map(
    employeeRows
      .map((row) => [normalizeHrId(row.hrId), row] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );

  // Request header.
  const requestResult = await supabase
    .from("marketing_requests")
    .select(
      "id, request_code, requester_hr_id, customer_id, status, request_type_id, pay_date, roi_duration_months, estimated_cost, expected_roi_value, required_roi_value",
    )
    .eq("id", cleanId)
    .maybeSingle();
  if (requestResult.error) throw requestResult.error;
  if (!requestResult.data) throw new Error("marketing_request_not_found");
  const request = mapRoiRequest(requestResult.data as RoiRequestRow);
  const requesterKey = normalizeHrId(request.requesterHrId) ?? "";

  // Promoted product codes (for both scope check and the context list).
  const productLinks = await supabase
    .from("marketing_request_products")
    .select("product_id")
    .eq("request_id", cleanId);
  if (productLinks.error) throw productLinks.error;
  const productIds = Array.from(
    new Set(((productLinks.data ?? []) as Array<{ product_id: number | string }>).map((row) => Number(row.product_id)).filter(Boolean)),
  );
  const productByIdMap = new Map<number, { code: string; name: string; normalizedName: string; line: string | null }>();
  if (productIds.length > 0) {
    const { data, error } = await supabase
      .from("marketing_products")
      .select("id, product_code, product_name, normalized_name, line")
      .in("id", productIds);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: number | string; product_code?: string | null; product_name?: string | null; normalized_name?: string | null; line?: string | null }>) {
      productByIdMap.set(Number(row.id), {
        code: (row.product_code ?? "").trim().toUpperCase(),
        name: (row.product_name ?? "").trim(),
        normalizedName: (row.normalized_name ?? row.product_name ?? "").trim(),
        line: (row.line ?? "").trim() || null,
      });
    }
  }
  const derivedContextLine = Array.from(
    new Set(Array.from(productByIdMap.values()).map((p) => p.line).filter((l): l is string => Boolean(l))),
  ).sort().join(" / ") || null;
  const reveal = canViewRestrictedProducts(access.role) && options.includeRestricted !== false;
  const restrictedNames = await restrictedProductNameSet();
  const allProductCodes = Array.from(productByIdMap.values()).map((product) => product.code).filter(Boolean);
  const visibleProductsForContext = Array.from(productByIdMap.values()).filter(
    (product) => reveal || !isRestrictedMarketingProduct(product.code, product.normalizedName, restrictedNames),
  );

  // Scope gate — identical to the report (resolveMarketingRoiScope membership).
  let ownedProductCodes: Set<string> | null = null;
  if (access.role === "Product Manager" || access.role === "Group Product Manager") {
    ownedProductCodes = (await resolveOwnedProductScope(supabase, access, byHrId)).ownedProductCodes;
  }
  const scope = resolveMarketingRoiScope(access, employeeRows, {
    ownedProductCodes,
    lineScopeOverride: await resolveLineRouteOverride(access),
  });
  let visible = scope.isCompanyWide
    ? true
    : scope.visibleProductCodes
      ? allProductCodes.some((code) => (scope.visibleProductCodes as Set<string>).has(code))
      : scope.visibleRequesterHrIds
        ? scope.visibleRequesterHrIds.has(requesterKey)
        : false;
  // Line names come from the requester's seat and EVERY promoted product (never the masked list),
  // exactly as the report builds them — the one builder both routes below read.
  const requestLineNames = collectRequestLineNames(
    byHrId.get(requesterKey)?.lineName ?? null,
    Array.from(productByIdMap.values()).map((product) => product.line),
  );
  // The National Sales Manager's LINE route (owner, 2026-10-20) — the very rule the report admits
  // rows by (lineRouteAdmitsRequest), so a Product Manager's campaign on his line that he can see in
  // ROI Tracking also opens its View Sales, and the ROI Tracking export keeps its matched-sales
  // lines. Empty for every other seat.
  if (!visible && scope.visibleRequesterHrIds && scope.visibleLineRouteNames.size > 0) {
    visible = lineRouteAdmitsRequest(scope, requestLineNames);
  }
  // The Medical Rep's TERRITORY route — the very area-AND-line rule the report admits rows by
  // (territoryRouteAdmitsRequest). Without it a rep saw a District Manager's request on his own
  // patch in ROI Tracking, was refused its View Sales, and the ROI Tracking export dropped its
  // matched-sales lines without a word.
  if (!visible && scope.visibleRequesterHrIds && scope.visibleAreaIds.size > 0) {
    const customerArea = await supabase
      .from("marketing_customers")
      .select("area_id")
      .eq("id", request.customerId)
      .maybeSingle();
    if (customerArea.error) throw customerArea.error;
    const rawAreaId = (customerArea.data as { area_id?: number | string | null } | null)?.area_id;
    const areaId = rawAreaId === null || rawAreaId === undefined ? null : Number(rawAreaId);
    visible = territoryRouteAdmitsRequest(scope, Number.isFinite(areaId) ? areaId : null, requestLineNames);
  }
  if (!visible) throw new Error("Forbidden: you cannot view this marketing request.");

  // Target pharmacies (codes + display names, incl. zero-sales targets).
  const pharmacyLinks = await supabase
    .from("marketing_request_pharmacies")
    .select("distributor_code_id")
    .eq("request_id", cleanId);
  if (pharmacyLinks.error) throw pharmacyLinks.error;
  const codeIds = Array.from(new Set(((pharmacyLinks.data ?? []) as Array<{ distributor_code_id: string | null }>).map((row) => row.distributor_code_id).filter((id): id is string => Boolean(id))));
  const pharmacies: Array<{ code: string; name: string }> = [];
  const requestPharmacyCodes = new Set<string>();
  if (codeIds.length > 0) {
    const { data, error } = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("id, pharmacy_id, normalized_pharmacy_code")
      .in("id", codeIds);
    if (error) throw error;
    const codeRows = (data ?? []) as Array<{ id: string; pharmacy_id: string; normalized_pharmacy_code?: string | null }>;
    const pharmacyIds = Array.from(new Set(codeRows.map((row) => row.pharmacy_id).filter(Boolean)));
    const nameById = new Map<string, string>();
    if (pharmacyIds.length > 0) {
      const namesResult = await supabase.from("marketing_pharmacies").select("id, display_name").in("id", pharmacyIds);
      if (namesResult.error) throw namesResult.error;
      for (const row of (namesResult.data ?? []) as Array<{ id: string; display_name?: string | null }>) {
        nameById.set(row.id, (row.display_name ?? "").trim());
      }
    }
    const seen = new Set<string>();
    for (const row of codeRows) {
      const code = (row.normalized_pharmacy_code ?? "").trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      requestPharmacyCodes.add(code);
      pharmacies.push({ code, name: nameById.get(row.pharmacy_id) || code });
    }
  }

  // Approver role keys (approved gating steps) + customer + type names + requester context.
  const [stepsResult, customerResult, typeResult] = await Promise.all([
    supabase.from("marketing_request_approval_steps").select("assigned_role, is_cc, status").eq("request_id", cleanId),
    supabase.from("marketing_customers").select("display_name").eq("id", request.customerId).maybeSingle(),
    supabase.from("marketing_request_types").select("name").eq("id", request.requestTypeId).maybeSingle(),
  ]);
  if (stepsResult.error) throw stepsResult.error;
  const approverRoleKeys = Array.from(
    new Set(
      ((stepsResult.data ?? []) as Array<{ assigned_role: string | null; is_cc: boolean | null; status: string | null }>)
        .filter((step) => !step.is_cc && step.status === "approved")
        .map((step) => (step.assigned_role ?? "").trim())
        .filter(Boolean),
    ),
  );
  const requester = byHrId.get(requesterKey);
  const customerName = ((customerResult.data as { display_name?: string | null } | null)?.display_name ?? "").trim() || request.customerId;
  const requestTypeName = ((typeResult.data as { name?: string | null } | null)?.name ?? "").trim() || null;

  // Detail rows via the rolled-up, confidential-masked RPC.
  const range = parseViewSalesRange(fromInput, toInput);
  const excludeCodes = reveal ? [] : RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase());
  // rpcAll, not a bare .rpc(): this returns per-invoice-line detail over a multi-month ROI window
  // and feeds both the View Sales screen and its XLSX export. PostgREST caps every response at
  // db-max-rows (1000) with no error, so a wide request would silently lose lines and the totals
  // derived from them would be understated. rpcAll pages only when an exact count proves a cap was
  // hit. Ordered for deterministic paging.
  const salesRows = await rpcAll<ViewSalesDbRow>(
    supabase,
    "phx_marketing_request_view_sales",
    {
      p_request_id: cleanId,
      p_from_period: range.from,
      p_to_period: range.to,
      p_exclude_product_codes: excludeCodes,
    },
    ["invoice_period", "product_code", "customer_code", "distributor_code"],
  );
  const rows: MarketingRoiViewSalesRow[] = salesRows.map((row) => ({
    distributorCode: row.distributor_code,
    distributorName: row.distributor_name ?? row.distributor_code,
    invoicePeriod: row.invoice_period,
    productCode: row.product_code,
    productName: row.product_name ?? row.product_code,
    customerCode: row.customer_code,
    customerName: row.customer_name ?? null,
    regionName: row.region_name ?? null,
    qty: toNum(row.qty),
    value: roundMarketingMoney(toNum(row.value)),
  }));

  const totalValueRaw = rows.reduce((sum, row) => sum + toNum(row.value), 0);
  // Never add units of different products: a total exists only when every matched row is one product.
  const totalUnits = new Set(rows.map((row) => row.productCode)).size <= 1
    ? rows.reduce((sum, row) => sum + row.qty, 0)
    : null;
  const actualValue = roundMarketingMoney(totalValueRaw);
  const coverageRatio = request.requiredRoiValue > 0
    ? roundMarketingRatio(totalValueRaw / request.requiredRoiValue)
    : totalValueRaw > 0
      ? 1
      : 0;

  // Applied range label (custom or the request's own ROI window).
  const defaultWindow = roiWindowLabel(request.payDate, request.roiDurationMonths);
  const defaultFrom = request.payDate ? request.payDate.slice(0, 7) : null;
  const appliedRange = range.from && range.to
    ? { from: range.from, to: range.to, isCustom: true }
    : { from: defaultFrom ?? "", to: defaultWindow.endPeriod ?? "", isCustom: false };

  // Reverse-lookup: other visible requests targeting the same pharmacy codes.
  const reverseLookup = await buildReverseLookup({
    supabase,
    scope,
    excludeRequestId: cleanId,
    pharmacyCodes: Array.from(requestPharmacyCodes),
    byHrId,
    reveal,
  });

  const salesDataAsOf = await loadLatestValidatedPeriod(supabase);

  return {
    context: {
      requestId: cleanId,
      requestCode: request.requestCode,
      customerName,
      requesterHrId: request.requesterHrId,
      requesterName: requester?.displayName ?? null,
      line: requester?.lineName ?? derivedContextLine,
      status: request.status,
      requestTypeName,
      payDate: request.payDate,
      roiDurationMonths: request.roiDurationMonths,
      roiWindowLabel: defaultWindow.label,
      estimatedCost: roundMarketingMoney(request.estimatedCost),
      expectedRoiValue: roundMarketingMoney(request.expectedRoiValue),
      requiredRoiValue: roundMarketingMoney(request.requiredRoiValue),
      products: visibleProductsForContext.map((product) => ({ code: product.code, name: product.name || product.code })),
      pharmacies,
      approverRoleKeys,
    },
    range: appliedRange,
    rows,
    totals: { value: actualValue, units: totalUnits, rows: rows.length },
    actualValue,
    coverageRatio,
    byMonth: aggregateViewSales(rows, (row) => ({ key: row.invoicePeriod, label: row.invoicePeriod })).sort((a, b) => a.key.localeCompare(b.key)),
    byProduct: aggregateViewSales(rows, (row) => ({ key: row.productCode, label: row.productName })).sort((a, b) => b.value - a.value),
    byPharmacy: aggregateViewSales(rows, (row) => ({ key: row.customerCode, label: row.customerName ?? row.customerCode })).sort((a, b) => b.value - a.value),
    matrix: buildMatrix(rows),
    reverseLookup,
    includedRestricted: reveal,
    salesDataAsOf,
    generatedAtIso,
  };
}

function buildMatrix(rows: MarketingRoiViewSalesRow[]): MarketingRoiViewSales["matrix"] {
  const map = new Map<string, MarketingRoiViewSales["matrix"][number]>();
  for (const row of rows) {
    const key = `${row.customerCode}|${row.productCode}|${row.invoicePeriod}`;
    const current = map.get(key);
    if (current) {
      current.value += row.value;
      current.units += row.qty;
    } else {
      map.set(key, {
        customerCode: row.customerCode,
        customerName: row.customerName,
        productCode: row.productCode,
        productName: row.productName,
        period: row.invoicePeriod,
        value: row.value,
        units: row.qty,
      });
    }
  }
  return Array.from(map.values()).map((cell) => ({ ...cell, value: roundMarketingMoney(cell.value) }));
}

async function buildReverseLookup(params: {
  supabase: SupabaseAdmin;
  scope: MarketingRoiScope;
  excludeRequestId: string;
  pharmacyCodes: string[];
  byHrId: Map<string, EmployeeDirectoryRow>;
  reveal: boolean;
}): Promise<MarketingRoiReverseLookupRow[]> {
  const { supabase, scope, excludeRequestId, pharmacyCodes, reveal } = params;
  if (pharmacyCodes.length === 0) return [];

  // pharmacy distributor-code rows sharing any of this request's customer codes
  const sharedByRequest = new Map<string, Set<string>>();
  for (const part of chunk(pharmacyCodes, 200)) {
    const { data, error } = await supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("id, normalized_pharmacy_code")
      .in("normalized_pharmacy_code", part);
    if (error) throw error;
    const codeRows = (data ?? []) as Array<{ id: string; normalized_pharmacy_code?: string | null }>;
    const codeIdToCode = new Map(codeRows.map((row) => [row.id, (row.normalized_pharmacy_code ?? "").trim()] as const));
    const codeIds = Array.from(codeIdToCode.keys());
    for (const idPart of chunk(codeIds, 200)) {
      if (idPart.length === 0) continue;
      const linkResult = await supabase
        .from("marketing_request_pharmacies")
        .select("request_id, distributor_code_id")
        .in("distributor_code_id", idPart);
      if (linkResult.error) throw linkResult.error;
      for (const link of (linkResult.data ?? []) as Array<{ request_id: string; distributor_code_id: string | null }>) {
        if (link.request_id === excludeRequestId) continue;
        const code = link.distributor_code_id ? codeIdToCode.get(link.distributor_code_id) : undefined;
        if (!code) continue;
        const set = sharedByRequest.get(link.request_id) ?? new Set<string>();
        set.add(code);
        sharedByRequest.set(link.request_id, set);
      }
    }
  }
  const candidateIds = Array.from(sharedByRequest.keys());
  if (candidateIds.length === 0) return [];

  // load candidate requests (requester + code + status) and scope-filter
  type ReverseCandidate = { id: string; request_code: string; requester_hr_id: string; status: MarketingRoiReportRow["status"] };
  const toResult = (row: ReverseCandidate, requesterKey: string): MarketingRoiReverseLookupRow => ({
    requestId: row.id,
    requestCode: row.request_code,
    requesterName: params.byHrId.get(requesterKey)?.displayName ?? null,
    status: row.status,
    sharedPharmacyCodes: Array.from(sharedByRequest.get(row.id) ?? []),
  });
  // The National Sales Manager's LINE route (owner, 2026-10-20) admits here too, by the same
  // `lineRouteAdmitsRequest` the report uses, so a shared-pharmacy hit on a campaign he can already
  // open in ROI Tracking is listed rather than silently hidden. Only those the requester route
  // refused wait for it, and only when the viewer HAS a line route — nobody else pays the read.
  const lineRouteCandidates: Array<{ row: ReverseCandidate; requesterKey: string }> = [];
  const results: MarketingRoiReverseLookupRow[] = [];
  for (const part of chunk(candidateIds, 200)) {
    const { data, error } = await supabase
      .from("marketing_requests")
      .select("id, request_code, requester_hr_id, status")
      .in("id", part);
    if (error) throw error;
    for (const row of (data ?? []) as ReverseCandidate[]) {
      const requesterKey = normalizeHrId(row.requester_hr_id) ?? "";
      // scope: company sees all; requester-scoped by visible set; PM/GPM product-scope is
      // omitted from reverse-lookup (a cross-product pharmacy hit is not theirs to see).
      const allowed = scope.isCompanyWide
        ? true
        : scope.visibleProductCodes
          ? false
          : scope.visibleRequesterHrIds
            ? scope.visibleRequesterHrIds.has(requesterKey)
            : false;
      if (!allowed) {
        if (
          !scope.isCompanyWide &&
          !scope.visibleProductCodes &&
          scope.visibleRequesterHrIds &&
          scope.visibleLineRouteNames.size > 0
        ) {
          lineRouteCandidates.push({ row, requesterKey });
        }
        continue;
      }
      results.push(toResult(row, requesterKey));
    }
  }
  if (lineRouteCandidates.length > 0) {
    // Lines exactly as the report reads them: the requester's seat line plus EVERY promoted
    // product's line (never the masked list) — `collectRequestLineNames`.
    const links = await loadByRequestIds<{ request_id: string; product_id: number | string }>(
      supabase,
      "marketing_request_products",
      "request_id, product_id",
      lineRouteCandidates.map((candidate) => candidate.row.id),
    );
    const productIds = Array.from(new Set(links.map((link) => Number(link.product_id)).filter(Boolean)));
    const lineByProductId = new Map<number, string | null>();
    for (const part of chunk(productIds)) {
      if (part.length === 0) continue;
      const { data, error } = await supabase.from("marketing_products").select("id, product_code, line").in("id", part);
      if (error) throw error;
      for (const productRow of (data ?? []) as Array<{ id: number | string; product_code?: string | null; line?: string | null }>) {
        // The report skips a product with no code before it reads its line; so does this.
        if (!(productRow.product_code ?? "").trim()) continue;
        lineByProductId.set(Number(productRow.id), (productRow.line ?? "").trim() || null);
      }
    }
    const productLinesByRequest = new Map<string, Array<string | null>>();
    for (const link of links) {
      if (!lineByProductId.has(Number(link.product_id))) continue;
      const list = productLinesByRequest.get(link.request_id) ?? [];
      list.push(lineByProductId.get(Number(link.product_id)) ?? null);
      productLinesByRequest.set(link.request_id, list);
    }
    for (const { row, requesterKey } of lineRouteCandidates) {
      const requestLineNames = collectRequestLineNames(
        params.byHrId.get(requesterKey)?.lineName ?? null,
        productLinesByRequest.get(row.id) ?? [],
      );
      if (lineRouteAdmitsRequest(scope, requestLineNames)) results.push(toResult(row, requesterKey));
    }
  }

  // Confidential-aware: for a non-revealer, do not even enumerate a request whose promoted
  // products are ALL confidential (its existence/requester would otherwise leak).
  let visible = results;
  if (!reveal && results.length > 0) {
    const restrictedNames = await restrictedProductNameSet();
    const resultIds = results.map((row) => row.requestId);
    const links = await loadByRequestIds<{ request_id: string; product_id: number | string }>(
      supabase,
      "marketing_request_products",
      "request_id, product_id",
      resultIds,
    );
    const metaIds = Array.from(new Set(links.map((link) => Number(link.product_id)).filter(Boolean)));
    const restrictedById = new Map<number, boolean>();
    for (const part of chunk(metaIds)) {
      if (part.length === 0) continue;
      const { data, error } = await supabase.from("marketing_products").select("id, product_code, product_name, normalized_name").in("id", part);
      if (error) throw error;
      for (const productRow of (data ?? []) as Array<{ id: number | string; product_code?: string | null; product_name?: string | null; normalized_name?: string | null }>) {
        restrictedById.set(
          Number(productRow.id),
          isRestrictedMarketingProduct((productRow.product_code ?? "").trim().toUpperCase(), (productRow.normalized_name ?? productRow.product_name ?? "").trim(), restrictedNames),
        );
      }
    }
    const hasNonRestricted = new Map<string, boolean>();
    const hasAnyProduct = new Map<string, boolean>();
    for (const link of links) {
      hasAnyProduct.set(link.request_id, true);
      if (!restrictedById.get(Number(link.product_id))) hasNonRestricted.set(link.request_id, true);
    }
    // keep a request unless it has products AND every one of them is confidential
    visible = results.filter((row) => !hasAnyProduct.get(row.requestId) || hasNonRestricted.get(row.requestId));
  }

  visible.sort((a, b) => b.sharedPharmacyCodes.length - a.sharedPharmacyCodes.length || a.requestCode.localeCompare(b.requestCode));
  return visible;
}


