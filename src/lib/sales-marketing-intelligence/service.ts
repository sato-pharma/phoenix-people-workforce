import { forbiddenError } from "@/lib/http/api-errors";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  canViewRestrictedProducts,
  isRestrictedProductCode,
  normalizeLineKey,
  normalizeProductNameKey,
  resolveSalesAccessScope,
  restrictedProductNameSet,
} from "@/lib/sales/access-scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  SalesMarketingAttributionQuality,
  SalesMarketingAttributionSummary,
  SalesMarketingCustomerImpactRow,
  SalesMarketingDashboardFilters,
  SalesMarketingDashboardSnapshot,
  SalesMarketingDashboardSummary,
  SalesMarketingDecisionRequest,
  SalesMarketingDecisionSummary,
  SalesMarketingFilterOption,
  SalesMarketingRecommendedAction,
  SalesMarketingRequestRow,
  SalesMarketingRoiComparisonRow,
  SalesMarketingRoiStatus,
  SalesMarketingRoiTrendPoint,
} from "@/lib/sales-marketing-intelligence/types";

const dashboardAccessRoles = new Set<PhoenixRole>([
  "CEO",
  "Group Product Manager",
  "Marketing Manager",
  "National Sales Manager",
  "Product Manager",
  "SFE Manager",
  "Super Admin",
]);

const defaultFilters: SalesMarketingDashboardFilters = {
  attributionQualities: [],
  customerSearch: "",
  distributors: [],
  fromMonth: "",
  limit: 100,
  lines: [],
  products: [],
  regions: [],
  roiStatuses: [],
  toMonth: "",
};

function cleanArray(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return Array.from(
    new Set(
      raw
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  );
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanMonth(value: unknown) {
  const text = cleanText(Array.isArray(value) ? value[0] : value);
  return /^\d{4}-\d{2}$/.test(text) ? text : "";
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toInteger(value: unknown) {
  return Math.round(toNumber(value));
}

function toText(value: unknown, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeOption(value: unknown): SalesMarketingFilterOption {
  const row = asRecord(value);
  const optionValue = toText(row.value ?? row.label, "Unassigned");
  return {
    label: toText(row.label, optionValue),
    value: optionValue,
  };
}

function normalizeRoiStatus(value: unknown): SalesMarketingRoiStatus {
  return value === "behind" || value === "on_track" || value === "no_data" ? value : "no_data";
}

function normalizeAttributionQuality(value: unknown): SalesMarketingAttributionQuality {
  return value === "exact_customer" || value === "brick_fallback" || value === "mixed" || value === "no_sales"
    ? value
    : "no_sales";
}

function normalizeRecommendedAction(value: unknown): SalesMarketingRecommendedAction {
  return value === "monitor" || value === "mapping_review" || value === "high_risk_gap" || value === "follow_up"
    ? value
    : "follow_up";
}

function normalizeSummary(value: unknown): SalesMarketingDashboardSummary {
  const row = asRecord(value);
  return {
    actionRequiredRequests: toInteger(row.actionRequiredRequests),
    activeCustomers: toInteger(row.activeCustomers),
    activePharmacies: toInteger(row.activePharmacies),
    actualAttributedSalesUnits: toNumber(row.actualAttributedSalesUnits),
    actualAttributedSalesValue: toNumber(row.actualAttributedSalesValue),
    actualRoiCoverage: toNumber(row.actualRoiCoverage),
    behindRequests: toInteger(row.behindRequests),
    coverageGap: toNumber(row.coverageGap),
    expectedGap: toNumber(row.expectedGap),
    expectedRoiValue: toNumber(row.expectedRoiValue),
    marketingRequestCount: toInteger(row.marketingRequestCount),
    noDataRequests: toInteger(row.noDataRequests),
    noDataSpend: toNumber(row.noDataSpend),
    onTrackRequests: toInteger(row.onTrackRequests),
    paidRequestCount: toInteger(row.paidRequestCount),
    requiredRoiValue: toNumber(row.requiredRoiValue),
    spendAtRisk: toNumber(row.spendAtRisk),
    totalMarketingCost: toNumber(row.totalMarketingCost),
  };
}

function normalizeDecisionRequest(value: unknown): SalesMarketingDecisionRequest | null {
  const row = asRecord(value);
  if (!row.id && !row.requestCode) return null;
  return {
    actualRoiCoverage: toNumber(row.actualRoiCoverage),
    actualRoiStatus: normalizeRoiStatus(row.actualRoiStatus),
    actualSalesValue: toNumber(row.actualSalesValue),
    attributionQuality: normalizeAttributionQuality(row.attributionQuality),
    coverageGap: toNumber(row.coverageGap),
    customerName: toText(row.customerName, "Unassigned"),
    estimatedCost: toNumber(row.estimatedCost),
    id: toText(row.id),
    line: row.line == null ? null : toText(row.line, "Unassigned"),
    recommendedAction: normalizeRecommendedAction(row.recommendedAction),
    requestCode: toText(row.requestCode, "Request"),
    requiredRoiValue: toNumber(row.requiredRoiValue),
  };
}

function normalizeDecisionSummary(value: unknown): SalesMarketingDecisionSummary {
  const row = asRecord(value);
  return {
    actionRequiredRequests: toInteger(row.actionRequiredRequests),
    coverageGap: toNumber(row.coverageGap),
    expectedGap: toNumber(row.expectedGap),
    noDataSpend: toNumber(row.noDataSpend),
    spendAtRisk: toNumber(row.spendAtRisk),
    topRiskRequest: normalizeDecisionRequest(row.topRiskRequest),
  };
}

function normalizeAttribution(value: unknown): SalesMarketingAttributionSummary {
  const row = asRecord(value);
  return {
    exactSalesRows: toInteger(row.exactSalesRows),
    fallbackSalesRows: toInteger(row.fallbackSalesRows),
    mixedRequests: toInteger(row.mixedRequests),
    noSalesRequests: toInteger(row.noSalesRequests),
    unmatchedMappingWarnings: toInteger(row.unmatchedMappingWarnings),
  };
}

function normalizeRoiTrend(value: unknown): SalesMarketingRoiTrendPoint {
  const row = asRecord(value);
  return {
    actualSalesValue: toNumber(row.actualSalesValue),
    behindCount: toInteger(row.behindCount),
    coverageGap: toNumber(row.coverageGap),
    expectedRoiValue: toNumber(row.expectedRoiValue),
    marketingCost: toNumber(row.marketingCost),
    noDataCount: toInteger(row.noDataCount),
    onTrackCount: toInteger(row.onTrackCount),
    period: toText(row.period),
    requestCount: toInteger(row.requestCount),
    requiredRoiValue: toNumber(row.requiredRoiValue),
  };
}

function normalizeRoiComparisonRow(value: unknown): SalesMarketingRoiComparisonRow {
  const row = asRecord(value);
  const label = toText(row.label ?? row.value, "Unassigned");
  return {
    actualRoiCoverage: toNumber(row.actualRoiCoverage),
    actualSalesUnits: toNumber(row.actualSalesUnits),
    actualSalesValue: toNumber(row.actualSalesValue),
    behindRequests: toInteger(row.behindRequests),
    coverageGap: toNumber(row.coverageGap),
    customerCount: toInteger(row.customerCount),
    exactSalesRows: toInteger(row.exactSalesRows),
    expectedRoiValue: toNumber(row.expectedRoiValue),
    fallbackSalesRows: toInteger(row.fallbackSalesRows),
    label,
    line: row.line == null ? null : toText(row.line, "Unassigned"),
    marketingCost: toNumber(row.marketingCost),
    noDataRequests: toInteger(row.noDataRequests),
    onTrackRequests: toInteger(row.onTrackRequests),
    pharmacyCount: toInteger(row.pharmacyCount),
    requestCount: toInteger(row.requestCount),
    requiredRoiValue: toNumber(row.requiredRoiValue),
    value: toText(row.value, label),
  };
}

function normalizeRequestRow(value: unknown): SalesMarketingRequestRow {
  const row = asRecord(value);
  return {
    actualRoiCoverage: toNumber(row.actualRoiCoverage),
    actualRoiStatus: normalizeRoiStatus(row.actualRoiStatus),
    actualSalesUnits: toNumber(row.actualSalesUnits),
    actualSalesValue: toNumber(row.actualSalesValue),
    attributionQuality: normalizeAttributionQuality(row.attributionQuality),
    coverageGap: toNumber(row.coverageGap),
    customerCode: row.customerCode == null ? null : toText(row.customerCode),
    customerName: toText(row.customerName, "Unassigned"),
    estimatedCost: toNumber(row.estimatedCost),
    exactSalesRows: toInteger(row.exactSalesRows),
    expectedGap: toNumber(row.expectedGap),
    expectedRoiValue: toNumber(row.expectedRoiValue),
    fallbackSalesRows: toInteger(row.fallbackSalesRows),
    id: toText(row.id),
    line: row.line == null ? null : toText(row.line, "Unassigned"),
    payDate: row.payDate == null ? null : toText(row.payDate),
    payMonth: row.payMonth == null ? null : toText(row.payMonth),
    recommendedAction: normalizeRecommendedAction(row.recommendedAction),
    requestCode: toText(row.requestCode, "Request"),
    requiredRoiValue: toNumber(row.requiredRoiValue),
    roiDurationMonths: toInteger(row.roiDurationMonths),
    salesRows: toInteger(row.salesRows),
    status: toText(row.status, "unknown"),
  };
}

function normalizeCustomerImpact(value: unknown): SalesMarketingCustomerImpactRow {
  const row = asRecord(value);
  return {
    actualRoiCoverage: toNumber(row.actualRoiCoverage),
    actualSalesUnits: toNumber(row.actualSalesUnits),
    actualSalesValue: toNumber(row.actualSalesValue),
    coverageGap: toNumber(row.coverageGap),
    customerCount: toInteger(row.customerCount),
    distributorCode: row.distributorCode == null ? null : toText(row.distributorCode),
    distributorName: row.distributorName == null ? null : toText(row.distributorName),
    exactSalesRows: toInteger(row.exactSalesRows),
    expectedRoiValue: toNumber(row.expectedRoiValue),
    fallbackSalesRows: toInteger(row.fallbackSalesRows),
    label: toText(row.label, "Unassigned"),
    marketingCost: toNumber(row.marketingCost),
    pharmacyCount: toInteger(row.pharmacyCount),
    regionName: row.regionName == null ? null : toText(row.regionName),
    requestCount: toInteger(row.requestCount),
    requiredRoiValue: toNumber(row.requiredRoiValue),
    salesRows: toInteger(row.salesRows),
    value: toText(row.value, "Unassigned"),
  };
}

function normalizeDashboardSnapshot(value: unknown): SalesMarketingDashboardSnapshot {
  const row = asRecord(value);
  const filters = asRecord(row.filters);
  const selected = asRecord(filters.selected);
  const limits = asRecord(row.limits);

  const selectedFilters: SalesMarketingDashboardFilters = {
    attributionQualities: cleanArray(selected.attributionQualities),
    customerSearch: toText(selected.customerSearch),
    distributors: cleanArray(selected.distributors),
    fromMonth: cleanMonth(selected.fromMonth),
    limit: toInteger(limits.tableLimit || defaultFilters.limit),
    lines: cleanArray(selected.lines),
    products: cleanArray(selected.products),
    regions: cleanArray(selected.regions),
    roiStatuses: cleanArray(selected.roiStatuses),
    toMonth: cleanMonth(selected.toMonth),
  };

  return {
    attributionHealth: normalizeAttribution(row.attributionHealth),
    customerImpact: asArray(row.customerImpact).map(normalizeCustomerImpact),
    decisionSummary: normalizeDecisionSummary(row.decisionSummary),
    distributorRoi: asArray(row.distributorRoi).map(normalizeRoiComparisonRow),
    filters: {
      attributionQualities: asArray(filters.attributionQualities).map(normalizeOption),
      distributors: asArray(filters.distributors).map(normalizeOption),
      lines: asArray(filters.lines).map(normalizeOption),
      products: asArray(filters.products).map(normalizeOption),
      regions: asArray(filters.regions).map(normalizeOption),
      roiStatuses: asArray(filters.roiStatuses).map(normalizeOption),
      selected: selectedFilters,
    },
    generatedAt: row.generatedAt == null ? null : toText(row.generatedAt),
    limits: {
      rawRowsReturned: toInteger(limits.rawRowsReturned),
      tableLimit: selectedFilters.limit,
    },
    lineRoi: asArray(row.lineRoi).map(normalizeRoiComparisonRow),
    productRoi: asArray(row.productRoi).map(normalizeRoiComparisonRow),
    regionRoi: asArray(row.regionRoi).map(normalizeRoiComparisonRow),
    requestReport: asArray(row.requestReport).map(normalizeRequestRow),
    roiTrend: asArray(row.roiTrend).map(normalizeRoiTrend),
    summary: normalizeSummary(row.summary),
  };
}

export function canAccessSalesMarketingIntelligence(access: Pick<AccessContext, "role" | "scope">) {
  return access.scope === "system" || dashboardAccessRoles.has(access.role);
}

export function assertSalesMarketingIntelligenceAccess(access: AccessContext) {
  if (!canAccessSalesMarketingIntelligence(access)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot view Marketing ROI & Customer Intelligence.`);
  }
}

export function parseSalesMarketingDashboardFilters(input: {
  attribution?: string | string[];
  customer?: string | string[];
  distributor?: string | string[];
  fromMonth?: string | string[];
  line?: string | string[];
  limit?: string | string[];
  product?: string | string[];
  region?: string | string[];
  roiStatus?: string | string[];
  toMonth?: string | string[];
}): SalesMarketingDashboardFilters {
  const rawLimit = Array.isArray(input.limit) ? input.limit[0] : input.limit;
  const parsedLimit = Number(rawLimit ?? defaultFilters.limit);
  const limit = Number.isFinite(parsedLimit) ? Math.max(10, Math.min(Math.round(parsedLimit), 100)) : defaultFilters.limit;

  return {
    attributionQualities: cleanArray(input.attribution),
    customerSearch: cleanText(Array.isArray(input.customer) ? input.customer[0] : input.customer),
    distributors: cleanArray(input.distributor),
    fromMonth: cleanMonth(input.fromMonth),
    limit,
    lines: cleanArray(input.line),
    products: cleanArray(input.product),
    regions: cleanArray(input.region),
    roiStatuses: cleanArray(input.roiStatus),
    toMonth: cleanMonth(input.toMonth),
  };
}

function normalizeIdentity(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Lines this viewer may see in the marketing ROI dashboard.
 *  - `null`  → unrestricted (company-wide: CEO / SFE / Marketing Manager / Super Admin / system).
 *  - Set     → bounded to the viewer's own line. Empty set = fail closed (no line resolved).
 *
 * Line-bounded roles (Product / Group Product / National Sales Manager) must NOT see other lines'
 * marketing ROI, customer impact, or summary totals — previously the RPC was called with the
 * caller's filters only, so any of them saw COMPANY-WIDE data. We return the line as BOTH the raw
 * org `lines.name` (which the RPC matches against `request_line`) AND the bridged Source-of-Sales
 * official line (which it matches against product line labels), so either match path is covered.
 */
async function resolveDashboardLineScope(access: AccessContext): Promise<Set<string> | null> {
  const scope = await resolveSalesAccessScope(access);
  if (scope.canViewAllSales) return null;

  const tokens = new Set<string>();
  for (const officialLine of scope.allowedLineNames ?? []) tokens.add(officialLine);

  const hrId = resolveEmployeeIdentityId(access);
  if (hrId) {
    const directory = await getEmployeeDirectory();
    const viewer = directory.employees.find(
      (employee) => normalizeIdentity(employee.hrId) === normalizeIdentity(hrId),
    );
    const rawLine = viewer?.lineName?.trim();
    if (rawLine) tokens.add(rawLine);
  }
  return tokens;
}

/**
 * Resolve the effective `p_lines` passed to the RPC: company-wide viewers keep their own filter
 * choices; line-bounded viewers are hard-limited to their line (intersected with any line they
 * picked). An unresolved line fails closed to a sentinel that matches nothing.
 */
function mergeLineFilter(userLines: string[], allowed: Set<string> | null): string[] {
  if (!allowed) return userLines;
  if (allowed.size === 0) return [" __no_line__"];
  const allowedKeys = new Set([...allowed].map(normalizeLineKey));
  if (userLines.length === 0) return [...allowed];
  const narrowed = userLines.filter((line) => allowedKeys.has(normalizeLineKey(line)));
  return narrowed.length > 0 ? narrowed : [...allowed];
}

/**
 * Scope the line dropdown to the viewer's allowed lines and restore the user's own selected lines
 * for display. The dashboard DATA (summary + every breakdown) is already scoped inside the RPC via
 * the injected `p_lines`, so rows and totals stay consistent — we never post-filter rows here.
 */
function applyDashboardLineScope(
  snapshot: SalesMarketingDashboardSnapshot,
  userLines: string[],
  allowed: Set<string> | null,
): SalesMarketingDashboardSnapshot {
  if (!allowed) return snapshot;
  const allowedKeys = new Set([...allowed].map(normalizeLineKey));
  const inScope = (option: SalesMarketingFilterOption) =>
    allowedKeys.has(normalizeLineKey(option.value)) || allowedKeys.has(normalizeLineKey(option.label));
  return {
    ...snapshot,
    filters: {
      ...snapshot.filters,
      lines: snapshot.filters.lines.filter(inScope),
      selected: { ...snapshot.filters.selected, lines: userLines },
    },
  };
}

/** Remove the confidential products (LA003 / LA004) from the per-product ROI breakdown and the
 *  product filter list — by code (the row/option `value`) and by name (`label`) as a backstop. */
function stripRestrictedFromMarketingSnapshot(
  snapshot: SalesMarketingDashboardSnapshot,
  restrictedNames: Set<string>,
): SalesMarketingDashboardSnapshot {
  const isRestricted = (entry: { value: string; label: string }) =>
    isRestrictedProductCode(entry.value) || restrictedNames.has(normalizeProductNameKey(entry.label));
  return {
    ...snapshot,
    productRoi: snapshot.productRoi.filter((row) => !isRestricted(row)),
    filters: {
      ...snapshot.filters,
      products: snapshot.filters.products.filter((option) => !isRestricted(option)),
    },
  };
}

export async function getSalesMarketingDashboardSnapshot(
  access: AccessContext,
  filters: SalesMarketingDashboardFilters = defaultFilters,
): Promise<SalesMarketingDashboardSnapshot> {
  assertSalesMarketingIntelligenceAccess(access);

  const lineScope = await resolveDashboardLineScope(access);
  const effectiveLines = mergeLineFilter(filters.lines, lineScope);

  const supabase = getSupabaseAdmin({ requestTimeoutMs: 50000 });
  const result = await supabase.rpc("phx_marketing_roi_customer_dashboard", {
    p_attribution_qualities: filters.attributionQualities,
    p_customer_search: filters.customerSearch || null,
    p_distributor_codes: filters.distributors,
    p_from_month: filters.fromMonth || null,
    p_limit: filters.limit,
    p_lines: effectiveLines,
    p_product_codes: filters.products,
    p_regions: filters.regions,
    p_roi_statuses: filters.roiStatuses,
    p_to_month: filters.toMonth || null,
  });

  if (result.error) {
    throw result.error;
  }

  const snapshot = applyDashboardLineScope(normalizeDashboardSnapshot(result.data), filters.lines, lineScope);

  // Confidential products (LA003 / LA004): only CEO / Super Admin may see them. For everyone else
  // strip the per-product ROI rows and the product filter. NOTE: the summary totals, request
  // report and customer-impact figures are aggregated INSIDE the RPC and still include these
  // products' value until the staged `p_exclude_codes` migration is applied (tracked separately).
  if (canViewRestrictedProducts(access.role)) return snapshot;
  return stripRestrictedFromMarketingSnapshot(snapshot, await restrictedProductNameSet());
}
