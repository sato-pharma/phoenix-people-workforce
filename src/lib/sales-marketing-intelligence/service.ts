import { forbiddenError } from "@/lib/http/api-errors";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
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

export async function getSalesMarketingDashboardSnapshot(
  access: AccessContext,
  filters: SalesMarketingDashboardFilters = defaultFilters,
): Promise<SalesMarketingDashboardSnapshot> {
  assertSalesMarketingIntelligenceAccess(access);

  const supabase = getSupabaseAdmin({ requestTimeoutMs: 50000 });
  const result = await supabase.rpc("phx_marketing_roi_customer_dashboard", {
    p_attribution_qualities: filters.attributionQualities,
    p_customer_search: filters.customerSearch || null,
    p_distributor_codes: filters.distributors,
    p_from_month: filters.fromMonth || null,
    p_limit: filters.limit,
    p_lines: filters.lines,
    p_product_codes: filters.products,
    p_regions: filters.regions,
    p_roi_statuses: filters.roiStatuses,
    p_to_month: filters.toMonth || null,
  });

  if (result.error) {
    throw result.error;
  }

  return normalizeDashboardSnapshot(result.data);
}
