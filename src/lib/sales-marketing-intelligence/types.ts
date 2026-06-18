export type SalesMarketingFilterOption = {
  label: string;
  value: string;
};

export type SalesMarketingDashboardFilters = {
  attributionQualities: string[];
  customerSearch: string;
  distributors: string[];
  fromMonth: string;
  limit: number;
  lines: string[];
  products: string[];
  regions: string[];
  roiStatuses: string[];
  toMonth: string;
};

export type SalesMarketingDashboardSummary = {
  actionRequiredRequests: number;
  activeCustomers: number;
  activePharmacies: number;
  actualAttributedSalesUnits: number;
  actualAttributedSalesValue: number;
  actualRoiCoverage: number;
  behindRequests: number;
  coverageGap: number;
  expectedGap: number;
  expectedRoiValue: number;
  marketingRequestCount: number;
  noDataRequests: number;
  noDataSpend: number;
  onTrackRequests: number;
  paidRequestCount: number;
  requiredRoiValue: number;
  spendAtRisk: number;
  totalMarketingCost: number;
};

export type SalesMarketingDecisionRequest = {
  actualRoiCoverage: number;
  actualRoiStatus: SalesMarketingRoiStatus;
  actualSalesValue: number;
  attributionQuality: SalesMarketingAttributionQuality;
  coverageGap: number;
  customerName: string;
  estimatedCost: number;
  id: string;
  line: string | null;
  recommendedAction: SalesMarketingRecommendedAction;
  requestCode: string;
  requiredRoiValue: number;
};

export type SalesMarketingDecisionSummary = {
  actionRequiredRequests: number;
  coverageGap: number;
  expectedGap: number;
  noDataSpend: number;
  spendAtRisk: number;
  topRiskRequest: SalesMarketingDecisionRequest | null;
};

export type SalesMarketingAttributionSummary = {
  exactSalesRows: number;
  fallbackSalesRows: number;
  mixedRequests: number;
  noSalesRequests: number;
  unmatchedMappingWarnings: number;
};

export type SalesMarketingRoiTrendPoint = {
  actualSalesValue: number;
  behindCount: number;
  coverageGap: number;
  expectedRoiValue: number;
  marketingCost: number;
  noDataCount: number;
  onTrackCount: number;
  period: string;
  requestCount: number;
  requiredRoiValue: number;
};

export type SalesMarketingRoiComparisonRow = {
  actualRoiCoverage: number;
  actualSalesUnits: number;
  actualSalesValue: number;
  behindRequests: number;
  coverageGap: number;
  customerCount: number;
  exactSalesRows: number;
  expectedRoiValue: number;
  fallbackSalesRows: number;
  label: string;
  line: string | null;
  marketingCost: number;
  noDataRequests: number;
  onTrackRequests: number;
  pharmacyCount: number;
  requestCount: number;
  requiredRoiValue: number;
  value: string;
};

export type SalesMarketingRoiStatus = "behind" | "no_data" | "on_track";

export type SalesMarketingAttributionQuality = "brick_fallback" | "exact_customer" | "mixed" | "no_sales";

export type SalesMarketingRecommendedAction = "follow_up" | "high_risk_gap" | "mapping_review" | "monitor";

export type SalesMarketingRequestRow = {
  actualRoiCoverage: number;
  actualRoiStatus: SalesMarketingRoiStatus;
  actualSalesUnits: number;
  actualSalesValue: number;
  attributionQuality: SalesMarketingAttributionQuality;
  coverageGap: number;
  customerCode: string | null;
  customerName: string;
  estimatedCost: number;
  exactSalesRows: number;
  expectedGap: number;
  expectedRoiValue: number;
  fallbackSalesRows: number;
  id: string;
  line: string | null;
  payDate: string | null;
  payMonth: string | null;
  recommendedAction: SalesMarketingRecommendedAction;
  requestCode: string;
  requiredRoiValue: number;
  roiDurationMonths: number;
  salesRows: number;
  status: string;
};

export type SalesMarketingCustomerImpactRow = {
  actualRoiCoverage: number;
  actualSalesUnits: number;
  actualSalesValue: number;
  coverageGap: number;
  customerCount: number;
  distributorCode: string | null;
  distributorName: string | null;
  exactSalesRows: number;
  expectedRoiValue: number;
  fallbackSalesRows: number;
  label: string;
  marketingCost: number;
  pharmacyCount: number;
  regionName: string | null;
  requestCount: number;
  requiredRoiValue: number;
  salesRows: number;
  value: string;
};

export type SalesMarketingDashboardSnapshot = {
  attributionHealth: SalesMarketingAttributionSummary;
  customerImpact: SalesMarketingCustomerImpactRow[];
  decisionSummary: SalesMarketingDecisionSummary;
  distributorRoi: SalesMarketingRoiComparisonRow[];
  filters: {
    attributionQualities: SalesMarketingFilterOption[];
    distributors: SalesMarketingFilterOption[];
    lines: SalesMarketingFilterOption[];
    products: SalesMarketingFilterOption[];
    regions: SalesMarketingFilterOption[];
    roiStatuses: SalesMarketingFilterOption[];
    selected: SalesMarketingDashboardFilters;
  };
  generatedAt: string | null;
  limits: {
    rawRowsReturned: number;
    tableLimit: number;
  };
  lineRoi: SalesMarketingRoiComparisonRow[];
  productRoi: SalesMarketingRoiComparisonRow[];
  regionRoi: SalesMarketingRoiComparisonRow[];
  requestReport: SalesMarketingRequestRow[];
  roiTrend: SalesMarketingRoiTrendPoint[];
  summary: SalesMarketingDashboardSummary;
};
