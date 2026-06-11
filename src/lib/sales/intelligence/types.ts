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

export type SiProductRow = SiRanked & { officialLine: string; cumulativeShare: number };

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

// Everything Page 1 (Executive Dashboard) needs from a SINGLE distributor×product scan, plus
// the multi-period trend. Customers are loaded lazily by the client (heaviest aggregate).
export type SiDashboardBundle = {
  period: string | null;
  availablePeriods: string[];
  kpis: SiKpiSummary;
  products: SiProductPerformance;
  geography: SiGeography;
  distributors: SiDistributorPerformance;
  trend: SiTrend;
  access: SiAccessBadge;
};
