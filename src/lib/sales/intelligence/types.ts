// Sales Intelligence — serializable response shapes for the dashboards/APIs. Everything is
// BY NAME (region/area/line/product/distributor/customer names); codes never surface in the UI.

export type SiTotals = { value: number; units: number };

export type SiRanked = {
  name: string;
  value: number;
  units: number;
  /** ratio 0..1 of the scoped (restricted-excluded) total value */
  share: number;
};

export type SiMonthCompleteness = {
  period: string;
  expected: string[];
  uploaded: string[];
  missing: string[];
  complete: boolean;
};

export type SiKpiSummary = {
  period: string | null;
  totals: SiTotals;
  distributorCount: number;
  lineCount: number;
  productCount: number;
  areaCount: number;
  regionCount: number;
  topRegion: { name: string; value: number } | null;
  topProduct: { name: string; value: number } | null;
  /** restricted products are currently hidden (true for everyone unless a CEO/SA opted in) */
  restrictedExcluded: boolean;
  restrictedIncluded: boolean;
  monthComplete: boolean;
  missingDistributors: string[];
};

export type SiProductRow = SiRanked & {
  officialLine: string;
  cumulativeShare: number;
  /** opaque drill key (product code) — never displayed */
  code: string;
};

export type SiProductPerformance = {
  period: string | null;
  products: SiProductRow[];
  lineMix: SiRanked[];
};

export type SiAreaRow = SiRanked & { regionName: string };

export type SiGeography = {
  period: string | null;
  regions: SiRanked[];
  areas: SiAreaRow[];
};

export type SiDistributorRow = SiRanked & { productMix: SiRanked[] };

export type SiDistributorPerformance = {
  period: string | null;
  distributors: SiDistributorRow[];
};

export type SiCustomerRow = SiRanked & { distributorName: string };

export type SiCustomerInsights = {
  period: string | null;
  customers: SiCustomerRow[];
  customerCount: number;
  /** share of total value held by the top 10 customers (concentration risk) */
  top10Share: number;
};

export type SiTrendPoint = {
  period: string;
  value: number;
  units: number;
  monthComplete: boolean;
  expected: number;
  uploaded: number;
};

export type SiTrend = { points: SiTrendPoint[] };

export type SiDataQualityBatch = {
  period: string;
  distributorCode: string;
  distributorName: string;
  status: string;
  totalRows: number;
  importableRows: number;
  warningRows: number;
  failedRows: number;
  fileName: string;
  uploadedBy: string;
  createdAt: string;
};

export type SiDataQuality = {
  period: string | null;
  availablePeriods: string[];
  filesByMonth: { period: string; batches: SiDataQualityBatch[] }[];
  rowQuality: { totalRows: number; importableRows: number; warningRows: number; failedRows: number };
  mappingGaps: { missingCustomer: number; missingArea: number; missingRegion: number; missingBrick: number };
  monthCompletion: SiMonthCompleteness[];
};

export type SiAccessBadge = {
  role: string;
  canViewAllSales: boolean;
  includeRestrictedAllowed: boolean;
  restrictedIncluded: boolean;
  restrictedExcluded: boolean;
  /** allowed Source-of-Sales lines for this viewer; [] = all lines */
  lineNames: string[];
  /** allowed region names for this viewer; [] = all regions in scope */
  regionNames: string[];
};

export type SiTransactionRow = {
  distributorName: string;
  officialLine: string;
  regionName: string;
  areaName: string;
  productName: string;
  units: number;
  value: number;
};

// Page 2 (Sales Details) — condensed, scoped tables from a single distributor×product scan.
// Transactions are bounded (top-N by value) — the raw 75k rows never reach the browser.
export type SiDetailsBundle = {
  period: string | null;
  availablePeriods: string[];
  transactions: SiTransactionRow[];
  products: SiProductRow[];
  distributors: SiRanked[];
  regions: SiRanked[];
  areas: SiAreaRow[];
  access: SiAccessBadge;
};

// ── v2 executive analytics ────────────────────────────────────────────────────────────────────

export type SiDelta = {
  current: number;
  /** null = baseline month not imported — render an em dash, never invent a 0-baseline. */
  prior: number | null;
  /** ratio (0.124 = +12.4%); null when prior is missing or zero. */
  pct: number | null;
};

export type SiCompare = {
  priorPeriod: string | null;
  yoyPeriod: string | null;
  value: { mom: SiDelta; yoy: SiDelta };
  units: { mom: SiDelta; yoy: SiDelta };
};

// Upload coverage for the selected month. Distributor files arrive independently, so a month can
// legitimately hold 2 distributors or 9. This surfaces how much of the month has actually landed
// and carries the like-for-like avg-price delta (computed over only the distributors present in
// BOTH the selected and prior month) so coverage gaps are never read as performance swings.
export type SiCoverage = {
  /** distributors that uploaded a validated batch for the selected period */
  reporting: number;
  /** distributors expected for the selected period (ever-seen and still active) */
  expected: number;
  /** the selected period is still missing one or more expected distributors */
  incomplete: boolean;
  /** prior period used as the like-for-like baseline (null = none imported yet) */
  priorPeriod: string | null;
  /** distributors present in BOTH the selected and prior period — the like-for-like basis */
  commonDistributors: number;
  /** avg realized price (value ÷ units) over the common distributor set: current vs prior */
  avgPrice: SiDelta;
};

// ── Advanced filters ───────────────────────────────────────────────────────────────────────────
// A selectable value (opaque code + display name) for one filter dimension.
export type SiFilterOption = { code: string; name: string };

// The available values for each dimension, built from the UNFILTERED month scan so the chips
// always offer the full menu regardless of the active selection. `customers` is the exception:
// the full customer list (~thousands) is fetched lazily by the picker, so here it carries only the
// currently-selected customers resolved to names (so the panel can render them with labels).
export type SiFilterFacets = {
  regions: SiFilterOption[];
  areas: SiFilterOption[];
  lines: SiFilterOption[];
  distributors: SiFilterOption[];
  products: SiFilterOption[];
  customers: SiFilterOption[];
};

// The active selection (codes; line uses its name as the code). Empty array = no filter on that dim.
export type SiFilters = {
  regions: string[];
  areas: string[];
  lines: string[];
  distributors: string[];
  products: string[];
  customers: string[];
};

export const EMPTY_SI_FILTERS: SiFilters = { regions: [], areas: [], lines: [], distributors: [], products: [], customers: [] };

export type SiMoverRow = {
  /** stable code (product/distributor/region) — joins never use display names */
  key: string;
  name: string;
  officialLine?: string;
  value: number;
  priorValue: number | null;
  deltaValue: number;
  deltaPct: number | null;
  rank: number;
  priorRank: number | null;
  isNew: boolean;
};

export type SiMoverSet = {
  gainers: SiMoverRow[];
  decliners: SiMoverRow[];
  entrants: SiMoverRow[];
  /** prior keys absent this month, ranked by prior value */
  lost: SiMoverRow[];
};

export type SiMovers = {
  priorPeriod: string | null;
  products: SiMoverSet;
  distributors: SiMoverSet;
  regions: SiMoverSet;
};

export type SiDailyPoint = {
  date: string;
  day: number;
  value: number;
  units: number;
  /** sum of per-distributor distinct customer counts — "customer touches" (cross-distributor
   *  identity cannot be deduped at this grain) */
  customers: number;
  cumulativeValue: number;
};

export type SiDailyCurve = {
  period: string;
  points: SiDailyPoint[];
  undatedValue: number;
  undatedUnits: number;
  /** dated value ÷ (dated + undated) — drives the "day data unavailable" empty state */
  datedValueShare: number;
};

export type SiRunRate = {
  projectedValue: number;
  daysElapsed: number;
  daysInMonth: number;
  dailyAvgValue: number;
  datedValueShare: number;
  reliable: boolean;
} | null;

export type SiConcentrationIndex = {
  /** Herfindahl–Hirschman index ×10000 */
  hhi: number;
  top1Share: number;
  top5Share: number;
  band: "low" | "moderate" | "high";
};

export type SiConcentration = {
  products: SiConcentrationIndex;
  distributors: SiConcentrationIndex;
};

export type SiInsight = {
  category: "products" | "distributors" | "geography" | "customers" | "risk" | "coverage";
  headline: string;
  detail: string;
  /** section anchor on the dashboard, e.g. "#products" */
  anchor: string;
  deltaPct?: number | null;
};

export type SiKpiSparkPoint = {
  period: string;
  value: number;
  units: number;
  customers: number;
  products: number;
  areas: number;
  avgPrice: number;
  monthComplete: boolean;
};

export type SiProductDrill = {
  period: string;
  productCode: string;
  productName: string;
  officialLine: string;
  totals: SiTotals;
  shareOfScopedTotal: number;
  avgRealizedPrice: number | null;
  compare: { value: SiDelta; units: SiDelta };
  regions: SiRanked[];
  distributors: SiRanked[];
  customers: SiCustomerRow[];
  daily: SiDailyCurve | null;
};

export type SiCustomerDrill = {
  period: string;
  clientCode: string;
  customerName: string;
  distributorName: string;
  regionName: string;
  areaName: string;
  totals: SiTotals;
  basket: Array<{
    productName: string;
    officialLine: string;
    units: number;
    value: number;
    share: number;
    priorValue: number | null;
    deltaPct: number | null;
  }>;
};

export type SiCustomerChurn = {
  period: string;
  priorPeriod: string | null;
  newCount: number;
  lostCount: number;
  retainedCount: number;
  retentionRate: number | null;
  newValue: number;
  lostPriorValue: number;
  topNew: SiCustomerRow[];
  topLost: SiCustomerRow[];
};

// Everything Page 1 (Executive Dashboard) needs, loaded as: ONE current-month scan + ONE
// all-periods grouped scan (trend/sparks/MoM/YoY) + the cheap day-grain reads. Movers, customers
// and churn are loaded lazily by the client (each needs an extra heavy scan).
export type SiDashboardBundle = {
  period: string | null;
  availablePeriods: string[];
  kpis: SiKpiSummary;
  products: SiProductPerformance;
  geography: SiGeography;
  distributors: SiDistributorPerformance;
  trend: SiTrend;
  access: SiAccessBadge;
  compare: SiCompare;
  coverage: SiCoverage;
  /** the menu of values for each filter dimension (from the unfiltered month) */
  facets: SiFilterFacets;
  /** the filter selection this bundle was computed under */
  filters: SiFilters;
  kpiSparks: SiKpiSparkPoint[];
  daily: SiDailyCurve | null;
  dailyPrior: SiDailyCurve | null;
  runRate: SiRunRate;
  concentration: SiConcentration;
  insights: SiInsight[];
  /** zero-sales areas within scope (white-space), by name */
  zeroSalesAreas: string[];
};
