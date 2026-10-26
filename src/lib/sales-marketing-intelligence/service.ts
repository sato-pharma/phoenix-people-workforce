import { unstable_cache } from "next/cache.js";

import { forbiddenError } from "@/lib/http/api-errors";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  canViewHeadOfficeLine,
  canViewRestrictedProducts,
  isHeadOfficeLine,
  isRestrictedProductCode,
  normalizeLineKey,
  normalizeProductNameKey,
  resolveSalesAccessScope,
  RESTRICTED_PRODUCT_CODES,
  restrictedProductNameSet,
} from "@/lib/sales/access-scope";
import { reconcileMarketingRoiBreakdowns } from "@/lib/marketing-requests/roi-breakdown-reconcile";
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
  return value === "behind" || value === "on_track" || value === "no_data" || value === "awaiting_data"
    ? value
    : "no_data";
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
    // The RPC names a pharmacy with no brick region "Unassigned"; say what it is, as the Region report does.
    regionName:
      row.regionName == null || toText(row.regionName) === "Unassigned" ? "Unmapped pharmacy" : toText(row.regionName),
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
    regionRoi: asArray(row.regionRoi)
      .map(normalizeRoiComparisonRow)
      // Region groups by the target pharmacy's brick (the authoritative geography). Pharmacies
      // not yet brick-mapped fall into the null-region bucket the RPC labels "Unassigned";
      // relabel so it reads as the customer-mapping gap it is, not a missing line/value.
      .map((region) =>
        region.value === "Unassigned" || region.label === "Unassigned"
          ? { ...region, label: "Unmapped pharmacy" }
          : region,
      ),
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
  // Head Office is confidential — never let a non-CEO/Super-Admin viewer scope INTO it (e.g. an
  // HO-based Marketing Manager whose own line is Head Office). Fail-closed: drop the HO tokens.
  if (!canViewHeadOfficeLine(access.role)) {
    for (const token of [...tokens]) if (isHeadOfficeLine(token)) tokens.delete(token);
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
  if (allowed.size === 0) return ["__no_line__"];
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

/**
 * Scope the PRODUCT filter dropdown to the viewer's allowed line(s).
 *
 * The RPC builds the product option list from the WHOLE active product catalog, so a line-bounded
 * viewer (Product / Group Product / National Sales Manager) was offered EVERY line's products even
 * though the dashboard DATA was already line-scoped via the injected `p_lines`. We map each option's
 * product code to its Source-of-Sales line and keep only those in scope. Fail closed: an unresolved
 * line, an unknown product line, or a read error yields no options (never widens visibility).
 *
 * `allowed === null` (company-wide viewers) keeps the full catalog untouched.
 */
async function scopeProductFilterToLines(
  snapshot: SalesMarketingDashboardSnapshot,
  allowed: Set<string> | null,
): Promise<SalesMarketingDashboardSnapshot> {
  if (!allowed) return snapshot;
  if (snapshot.filters.products.length === 0) return snapshot;

  const allowedKeys = new Set([...allowed].map(normalizeLineKey));
  if (allowedKeys.size === 0) {
    return { ...snapshot, filters: { ...snapshot.filters, products: [] } };
  }

  const lineByCode = new Map<string, string>();
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("source_of_sales_products")
      .select("product_code, line")
      .eq("active", true);
    for (const row of data ?? []) {
      const code = String((row as { product_code?: string | null }).product_code ?? "").trim().toUpperCase();
      if (!code) continue;
      lineByCode.set(code, normalizeLineKey((row as { line?: string | null }).line));
    }
  } catch {
    // Keep lineByCode empty → no options survive (fail closed; never widen the viewer's scope).
  }

  const inScope = (option: SalesMarketingFilterOption) => {
    const lineKey = lineByCode.get(option.value.trim().toUpperCase());
    return lineKey !== undefined && allowedKeys.has(lineKey);
  };

  return {
    ...snapshot,
    filters: {
      ...snapshot.filters,
      products: snapshot.filters.products.filter(inScope),
    },
  };
}

/**
 * Close the cross-line leak in the product / region / distributor ROI breakdowns for
 * line-bounded viewers (Product / Group Product / National Sales Manager).
 *
 * The RPC scopes the marketing-REQUEST side of every breakdown by the injected `p_lines`,
 * but the ACTUAL-sales side is grafted on via a FULL JOIN to line-agnostic `*_actuals`
 * fact CTEs (marketing_roi_{product,region,distributor}_facts) that are NOT line-filtered.
 * So any product / region / distributor with company-wide attributed sales surfaced as an
 * actuals-only row (no in-scope marketing request), leaking other lines' footprint into a
 * single-line viewer's Product/Region/Distributor ROI reports. (lineRoi is unaffected — its
 * actuals CTE IS `p_lines`-filtered; the summary/trend/customer breakdowns read only `fr`.)
 *
 * We drop those actuals-only rows here. Doing it in the app layer keeps it source-agnostic
 * (covers both the live `phx_marketing_roi_customer_dashboard` and the fast
 * `phx_marketing_roi_fast` RPCs) and needs no DB migration:
 *   • productRoi — keep a row if it has an in-scope request (`requestCount > 0`) OR its line
 *     is in scope. A product resolves to exactly one line, so an out-of-scope product always
 *     carries another line's label and is dropped; an in-scope product (even one with sales
 *     but no request) is kept.
 *   • region/distributor Roi — these rows carry no line, so key on request footprint alone:
 *     an in-scope row always has `requestCount >= 1` (it came from the line-scoped request
 *     aggregate); an actuals-only leak has `requestCount === 0`. Fail-closed — an actual-sales
 *     row we cannot attribute to a line is hidden, never shown.
 *
 * `allowed === null` (company-wide viewers) returns the snapshot untouched — they are meant
 * to see the full "sales but no marketing request" picture across every line.
 */
export function scopeBreakdownRowsToLine(
  snapshot: SalesMarketingDashboardSnapshot,
  allowed: Set<string> | null,
): SalesMarketingDashboardSnapshot {
  if (!allowed) return snapshot;
  const allowedKeys = new Set([...allowed].map(normalizeLineKey));
  const lineInScope = (line: string | null) => allowedKeys.has(normalizeLineKey(line));
  return {
    ...snapshot,
    productRoi: snapshot.productRoi.filter((row) => row.requestCount > 0 || lineInScope(row.line)),
    regionRoi: snapshot.regionRoi.filter((row) => row.requestCount > 0),
    distributorRoi: snapshot.distributorRoi.filter((row) => row.requestCount > 0),
  };
}

/**
 * Server-side confidential-product exclusion passed to the RPC's `p_exclude_codes`. CEO / Super
 * Admin get the full picture (empty list = nothing excluded); every other dashboard role
 * (Marketing Manager, SFE Manager, …) gets the restricted codes excluded INSIDE the RPC, so the
 * summary and EVERY breakdown (customer / region / distributor / product / line / trend /
 * attribution) drop confidential sales value at source. Driven purely from the caller's role —
 * never from client input. Defense in depth alongside stripRestrictedFromMarketingSnapshot.
 */
export function resolveMarketingExcludeCodes(role: AccessContext["role"]): string[] {
  return canViewRestrictedProducts(role) ? [] : [...RESTRICTED_PRODUCT_CODES];
}

/** Remove the confidential products (LA003 / LA004 / SS001) from the per-product ROI breakdown and
 *  the product filter list — by code (the row/option `value`) and by name (`label`) as a backstop. */
function stripRestrictedFromMarketingSnapshot(
  snapshot: SalesMarketingDashboardSnapshot,
  restrictedNames: Set<string>,
): SalesMarketingDashboardSnapshot {
  const isRestricted = (entry: { value: string; label: string }) =>
    isRestrictedProductCode(entry.value) || restrictedNames.has(normalizeProductNameKey(entry.label));

  // Identify restricted product rows BEFORE filtering so their values can be
  // subtracted from the pre-aggregated summary totals (which were computed
  // inside the RPC and include restricted products for all callers).
  const restrictedProductRows = snapshot.productRoi.filter(isRestricted);
  const rCost    = restrictedProductRows.reduce((s, r) => s + r.marketingCost, 0);
  const rActual  = restrictedProductRows.reduce((s, r) => s + r.actualSalesValue, 0);
  const rUnits   = restrictedProductRows.reduce((s, r) => s + r.actualSalesUnits, 0);
  const rReqRoi  = restrictedProductRows.reduce((s, r) => s + r.requiredRoiValue, 0);
  const rExpRoi  = restrictedProductRows.reduce((s, r) => s + r.expectedRoiValue, 0);

  const correctedCost    = Math.max(0, snapshot.summary.totalMarketingCost - rCost);
  const correctedActual  = Math.max(0, snapshot.summary.actualAttributedSalesValue - rActual);
  const correctedUnits   = Math.max(0, snapshot.summary.actualAttributedSalesUnits - rUnits);
  const correctedReqRoi  = Math.max(0, snapshot.summary.requiredRoiValue - rReqRoi);
  const correctedExpRoi  = Math.max(0, snapshot.summary.expectedRoiValue - rExpRoi);

  // Lines that consist ONLY of restricted products (e.g. "Lacto Basic") are removed
  // from lineRoi entirely. Mixed lines lose their restricted product contribution
  // proportionally — not attempted here to keep the fix simple and safe.
  const productLineMap = new Map<string, { restricted: number; total: number }>();
  snapshot.productRoi.forEach((row) => {
    const line = row.line ?? "(Unassigned)";
    const entry = productLineMap.get(line) ?? { restricted: 0, total: 0 };
    entry.total += 1;
    if (isRestricted(row)) entry.restricted += 1;
    productLineMap.set(line, entry);
  });
  const restrictedOnlyLines = new Set(
    [...productLineMap.entries()]
      .filter(([, counts]) => counts.total > 0 && counts.restricted === counts.total)
      .map(([line]) => line),
  );

  return {
    ...snapshot,
    productRoi: snapshot.productRoi.filter((row) => !isRestricted(row)),
    lineRoi: snapshot.lineRoi.filter((row) => !restrictedOnlyLines.has(row.value) && !restrictedOnlyLines.has(row.line ?? "")),
    filters: {
      ...snapshot.filters,
      products: snapshot.filters.products.filter((option) => !isRestricted(option)),
    },
    summary: {
      ...snapshot.summary,
      totalMarketingCost:            correctedCost,
      actualAttributedSalesValue:    correctedActual,
      actualAttributedSalesUnits:    correctedUnits,
      requiredRoiValue:              correctedReqRoi,
      expectedRoiValue:              correctedExpRoi,
      actualRoiCoverage:             correctedReqRoi > 0 ? correctedActual / correctedReqRoi : 0,
      coverageGap:                   Math.max(0, correctedReqRoi - correctedActual),
      expectedGap:                   Math.max(0, correctedReqRoi - correctedExpRoi),
      noDataSpend:                   Math.max(0, snapshot.summary.noDataSpend - rCost),
      spendAtRisk:                   Math.max(0, snapshot.summary.spendAtRisk - rCost),
    },
  };
}

/**
 * Remove the confidential Head Office line from EVERY line-bearing breakdown (product / line /
 * region / distributor / customer / requests) + the line filter, and subtract its product-level
 * contribution from the pre-aggregated summary. Only ever called for non-CEO/Super-Admin viewers
 * (the CEO/SA path early-returns the untouched snapshot), so it strips unconditionally.
 */
function stripHeadOfficeFromMarketingSnapshot(
  snapshot: SalesMarketingDashboardSnapshot,
): SalesMarketingDashboardSnapshot {
  const isHo = (row: { line?: string | null }) => isHeadOfficeLine(row.line);

  const hoProductRows = snapshot.productRoi.filter(isHo);
  const rCost   = hoProductRows.reduce((s, r) => s + r.marketingCost, 0);
  const rActual = hoProductRows.reduce((s, r) => s + r.actualSalesValue, 0);
  const rUnits  = hoProductRows.reduce((s, r) => s + r.actualSalesUnits, 0);
  const rReqRoi = hoProductRows.reduce((s, r) => s + r.requiredRoiValue, 0);
  const rExpRoi = hoProductRows.reduce((s, r) => s + r.expectedRoiValue, 0);

  const correctedCost   = Math.max(0, snapshot.summary.totalMarketingCost - rCost);
  const correctedActual = Math.max(0, snapshot.summary.actualAttributedSalesValue - rActual);
  const correctedUnits  = Math.max(0, snapshot.summary.actualAttributedSalesUnits - rUnits);
  const correctedReqRoi = Math.max(0, snapshot.summary.requiredRoiValue - rReqRoi);
  const correctedExpRoi = Math.max(0, snapshot.summary.expectedRoiValue - rExpRoi);

  return {
    ...snapshot,
    productRoi:     snapshot.productRoi.filter((row) => !isHo(row)),
    lineRoi:        snapshot.lineRoi.filter((row) => !isHeadOfficeLine(row.value) && !isHo(row)),
    regionRoi:      snapshot.regionRoi.filter((row) => !isHo(row)),
    distributorRoi: snapshot.distributorRoi.filter((row) => !isHo(row)),
    requestReport:  snapshot.requestReport.filter((row) => !isHo(row)),
    filters: {
      ...snapshot.filters,
      lines: snapshot.filters.lines.filter(
        (option) => !isHeadOfficeLine(option.value) && !isHeadOfficeLine(option.label),
      ),
    },
    summary: {
      ...snapshot.summary,
      totalMarketingCost:         correctedCost,
      actualAttributedSalesValue: correctedActual,
      actualAttributedSalesUnits: correctedUnits,
      requiredRoiValue:           correctedReqRoi,
      expectedRoiValue:           correctedExpRoi,
      actualRoiCoverage:          correctedReqRoi > 0 ? correctedActual / correctedReqRoi : 0,
      coverageGap:                Math.max(0, correctedReqRoi - correctedActual),
      expectedGap:                Math.max(0, correctedReqRoi - correctedExpRoi),
      noDataSpend:                Math.max(0, snapshot.summary.noDataSpend - rCost),
      spendAtRisk:                Math.max(0, snapshot.summary.spendAtRisk - rCost),
    },
  };
}

// Cached wrapper for the heavy marketing ROI RPC. Cache key = ['smi-rpc'] plus
// the serialized params object (Next.js appends it automatically). TTL = 300s.
// Arrays are pre-sorted by callers so the same logical query always maps to the
// same key regardless of insertion order. Tag 'smi-dashboard' is revalidated by
// SoS import paths after each validated upload so the cache clears promptly.
const cachedRpcCall = unstable_cache(
  async (params: {
    role: string;
    effectiveLines: string[];
    excludeCodes: string[];
    filters: SalesMarketingDashboardFilters;
  }) => {
    const supabase = getSupabaseAdmin({ requestTimeoutMs: 50000 });
    const result = await supabase.rpc("phx_marketing_roi_customer_dashboard", {
      p_attribution_qualities: params.filters.attributionQualities,
      p_customer_search: params.filters.customerSearch || null,
      p_distributor_codes: params.filters.distributors,
      p_exclude_codes: params.excludeCodes,
      p_from_month: params.filters.fromMonth || null,
      p_limit: params.filters.limit,
      p_lines: params.effectiveLines,
      p_product_codes: params.filters.products,
      p_regions: params.filters.regions,
      p_roi_statuses: params.filters.roiStatuses,
      p_to_month: params.filters.toMonth || null,
    });
    if (result.error) throw result.error;
    return result.data;
  },
  ["smi-rpc"],
  { revalidate: 300, tags: ["smi-dashboard"] },
);

// Fast variant — reads from pre-computed fact tables (PR 4 migration).
// Same caching strategy; p_distributors / p_products instead of the original param names.
const cachedFastRpcCall = unstable_cache(
  async (params: {
    role: string;
    effectiveLines: string[];
    excludeCodes: string[];
    filters: SalesMarketingDashboardFilters;
  }) => {
    const supabase = getSupabaseAdmin({ requestTimeoutMs: 10000 });
    const result = await supabase.rpc("phx_marketing_roi_fast", {
      p_attribution_qualities: params.filters.attributionQualities,
      p_customer_search: params.filters.customerSearch || null,
      p_distributors: params.filters.distributors,
      p_exclude_codes: params.excludeCodes,
      p_from_month: params.filters.fromMonth || null,
      p_limit: params.filters.limit,
      p_lines: params.effectiveLines,
      p_products: params.filters.products,
      p_regions: params.filters.regions,
      p_roi_statuses: params.filters.roiStatuses,
      p_to_month: params.filters.toMonth || null,
    });
    if (result.error) throw result.error;
    return result.data;
  },
  ["smi-fast-rpc"],
  { revalidate: 300, tags: ["smi-dashboard"] },
);

export async function getSalesMarketingDashboardSnapshot(
  access: AccessContext,
  filters: SalesMarketingDashboardFilters = defaultFilters,
): Promise<SalesMarketingDashboardSnapshot> {
  assertSalesMarketingIntelligenceAccess(access);

  const lineScope = await resolveDashboardLineScope(access);
  const effectiveLines = mergeLineFilter(filters.lines, lineScope);
  const excludeCodes = resolveMarketingExcludeCodes(access.role);

  // Sort all arrays before caching so the same logical query always hits the same cache key
  // regardless of the order URL params arrive in.
  const stableFilters: SalesMarketingDashboardFilters = {
    ...filters,
    attributionQualities: [...filters.attributionQualities].sort(),
    distributors: [...filters.distributors].sort(),
    lines: [...filters.lines].sort(),
    products: [...filters.products].sort(),
    regions: [...filters.regions].sort(),
    roiStatuses: [...filters.roiStatuses].sort(),
  };

  const rawData = await cachedRpcCall({
    role: access.role,
    effectiveLines: [...effectiveLines].sort(),
    excludeCodes: [...excludeCodes].sort(),
    filters: stableFilters,
  });

  const lineScopedSnapshot = applyDashboardLineScope(normalizeDashboardSnapshot(rawData), filters.lines, lineScope);
  // Line-bounded viewers must only be offered THEIR line's products in the filter dropdown — the
  // RPC returns the full catalog, so we scope it here to match the already line-scoped data.
  const productScopedSnapshot = await scopeProductFilterToLines(lineScopedSnapshot, lineScope);
  // …and must never see other lines' products / regions / distributors that leaked in as
  // actuals-only rows via the RPC's FULL JOIN to line-agnostic actuals fact tables.
  const snapshot = scopeBreakdownRowsToLine(productScopedSnapshot, lineScope);

  // Confidential products (LA003 / LA004 / SS001): only CEO / Super Admin may see them. The RPC
  // now excludes them server-side via `p_exclude_codes` (above), so the summary and EVERY breakdown
  // already drop their value at source. We still strip the per-product ROI rows and the product
  // filter here as defense in depth — a future RPC edit or new entrypoint cannot leak them.
  // Last step on every path: the Region, Distributor and Customer reports add up to the cards.
  if (canViewRestrictedProducts(access.role)) return reconcileMarketingRoiBreakdowns(snapshot);
  // Non-CEO/SA: strip confidential products AND the confidential Head Office line.
  return reconcileMarketingRoiBreakdowns(
    stripHeadOfficeFromMarketingSnapshot(
      stripRestrictedFromMarketingSnapshot(snapshot, await restrictedProductNameSet()),
    ),
  );
}

/**
 * Fast variant of getSalesMarketingDashboardSnapshot. Reads from the pre-computed
 * marketing_roi_*_facts tables (populated by phx_refresh_marketing_roi_facts) instead
 * of re-running the live 40-CTE query on every request. Returns the same snapshot shape.
 *
 * Enable with NEXT_PUBLIC_SMI_USE_FACT_TABLES=true. The original function remains
 * available as fallback; call getSalesMarketingDashboard() from pages — not this directly.
 */
async function getSalesMarketingDashboardFast(
  access: AccessContext,
  filters: SalesMarketingDashboardFilters = defaultFilters,
): Promise<SalesMarketingDashboardSnapshot> {
  assertSalesMarketingIntelligenceAccess(access);

  const lineScope = await resolveDashboardLineScope(access);
  const effectiveLines = mergeLineFilter(filters.lines, lineScope);
  const excludeCodes = resolveMarketingExcludeCodes(access.role);

  const stableFilters: SalesMarketingDashboardFilters = {
    ...filters,
    attributionQualities: [...filters.attributionQualities].sort(),
    distributors: [...filters.distributors].sort(),
    lines: [...filters.lines].sort(),
    products: [...filters.products].sort(),
    regions: [...filters.regions].sort(),
    roiStatuses: [...filters.roiStatuses].sort(),
  };

  const rawData = await cachedFastRpcCall({
    role: access.role,
    effectiveLines: [...effectiveLines].sort(),
    excludeCodes: [...excludeCodes].sort(),
    filters: stableFilters,
  });

  const lineScopedSnapshot = applyDashboardLineScope(normalizeDashboardSnapshot(rawData), filters.lines, lineScope);
  const productScopedSnapshot = await scopeProductFilterToLines(lineScopedSnapshot, lineScope);
  // Drop other lines' products / regions / distributors that leaked in as actuals-only rows.
  const snapshot = scopeBreakdownRowsToLine(productScopedSnapshot, lineScope);
  // Last step on every path: the Region, Distributor and Customer reports add up to the cards.
  if (canViewRestrictedProducts(access.role)) return reconcileMarketingRoiBreakdowns(snapshot);
  // Non-CEO/SA: strip confidential products AND the confidential Head Office line.
  return reconcileMarketingRoiBreakdowns(
    stripHeadOfficeFromMarketingSnapshot(
      stripRestrictedFromMarketingSnapshot(snapshot, await restrictedProductNameSet()),
    ),
  );
}

/**
 * Primary entry point for both dashboard pages. When NEXT_PUBLIC_SMI_USE_FACT_TABLES=true
 * it calls the fast pre-computed RPC; otherwise falls back to the original live query.
 * The flag can be toggled without a code change or redeploy (env-var only).
 */
export async function getSalesMarketingDashboard(
  access: AccessContext,
  filters: SalesMarketingDashboardFilters = defaultFilters,
): Promise<SalesMarketingDashboardSnapshot> {
  if (process.env.NEXT_PUBLIC_SMI_USE_FACT_TABLES === "true") {
    return getSalesMarketingDashboardFast(access, filters);
  }
  return getSalesMarketingDashboardSnapshot(access, filters);
}
