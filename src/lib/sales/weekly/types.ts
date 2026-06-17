// Weekly Sales — serializable shapes for the upload pipeline and dashboard. A separate module from
// the monthly Source-of-Sales surface; nothing here is read by or merged with the monthly tables.

export type WeeklyValidationIssue = {
  field: string;
  message: string;
  rowNumber: number;
  severity: "failure" | "warning";
  value: string | null;
};

export type WeeklyTotals = {
  rowCount: number;
  /** gross sales units (before returns) */
  salesQty: number;
  /** returned units (always >= 0) */
  returnQty: number;
  /** net units = salesQty - returnQty (the priced quantity) */
  netQty: number;
  bonusQty: number;
  /** salesValue = netQty x factory_price (discount + sheet value columns ignored) */
  salesValue: number;
  /** stock is units only — there is deliberately no stock value */
  stockQty: number;
};

export type WeeklyRegionSummary = WeeklyTotals & { regionCode: string; regionName: string };
export type WeeklyProductSummary = WeeklyTotals & {
  productCode: string;
  productName: string;
  officialLine: string;
};
export type WeeklyBranchSummary = WeeklyTotals & {
  branchCode: string;
  branchName: string;
  regionCode: string;
  regionName: string;
};

// One parsed fact row (branch × product × week). Internal — persisted to weekly_sales_rows.
export type WeeklyParsedRow = {
  rowNumber: number;
  weekStart: string | null; // YYYY-MM-DD
  distributorCode: string;
  distributorName: string;
  regionCode: string;
  regionName: string;
  branchCode: string;
  branchName: string;
  itemCode: string;
  productCode: string;
  productName: string;
  officialLine: string;
  /** gross sales units (before returns) */
  salesQty: number;
  /** returned units, always stored as a positive number */
  returnQty: number;
  /** net units = salesQty - returnQty; this is the priced quantity */
  netQty: number;
  bonusQty: number; // free units — read for audit, never priced
  salesValue: number; // netQty x factory_price (no discount, no sheet value)
  stockQty: number; // units only
  validationState: "valid" | "warning" | "failed";
  validationIssues: WeeklyValidationIssue[];
  rawRow: Record<string, string>;
};

export type WeeklyDistributorOption = { code: string; name: string };

export type WeeklySalesValidationResult = {
  advisories?: string[];
  batchId?: string;
  createdAt?: string;
  distributor: WeeklyDistributorOption;
  fileName: string;
  sheetName: string;
  templateKey: string;
  templateName: string;
  /** the single week-start date carried in the sheet (YYYY-MM-DD), or null when undated */
  weekStart: string | null;
  status: "blocked" | "validated";
  blockingReasons: string[];
  rowCount: number;
  importableRows: number;
  failedRows: number;
  warningRows: number;
  totals: WeeklyTotals;
  byRegion: WeeklyRegionSummary[];
  byProduct: WeeklyProductSummary[];
  byBranch: WeeklyBranchSummary[];
  issues: WeeklyValidationIssue[];
};

// Upload-history list item (weekly_sales_batches).
export type WeeklyBatch = {
  id: string;
  distributorCode: string;
  distributorName: string;
  templateKey: string;
  fileName: string;
  sheetName: string;
  weekStart: string | null;
  status: "blocked" | "validated";
  totalRows: number;
  importableRows: number;
  failedRows: number;
  warningRows: number;
  /** gross sales units (audit) */
  totalSalesQty: number;
  /** returned units */
  totalReturnQty: number;
  /** net units = gross - returns (the priced quantity) */
  totalNetQty: number;
  totalBonusQty: number;
  totalSalesValue: number;
  totalStockQty: number;
  blockingReasons: string[];
  uploadedBy: string | null;
  createdAt: string;
};

// ── Dashboard ────────────────────────────────────────────────────────────────────────────────

export type WeeklyRanked = {
  name: string;
  code: string;
  salesValue: number;
  salesUnits: number;
  stockUnits: number;
  /** share 0..1 of the scoped total sales value */
  share: number;
};

export type WeeklyBranchComparisonRow = WeeklyRanked & {
  regionName: string;
};

export type WeeklyDelta = {
  current: number;
  /** null = prior week not uploaded — render an em dash, never a fake 0 baseline */
  prior: number | null;
  pct: number | null;
};

export type WeeklyBranchRow = {
  branchCode: string;
  branchName: string;
  regionName: string;
  salesValue: number;
  salesUnits: number;
  stockUnits: number;
};

export type WeeklyDashboard = {
  weekStart: string | null;
  priorWeekStart: string | null;
  availableWeeks: string[];
  availableLines: string[];
  distributors: WeeklyDistributorOption[];
  appliedFilters: {
    weekStart: string | null;
    weekStarts: string[];
    allWeeks: boolean;
    distributorCode: string | null;
    regionCode: string | null;
    productCode: string | null;
    lineCode: string | null;
  };
  kpis: {
    salesValue: number;
    salesUnits: number;
    stockUnits: number;
    branchCount: number;
    regionCount: number;
    productCount: number;
    distributorCount: number;
  };
  compare: { salesValue: WeeklyDelta; salesUnits: WeeklyDelta; stockUnits: WeeklyDelta };
  /** consolidated across all distributors for the selected week */
  regions: WeeklyRanked[];
  products: WeeklyRanked[];
  distributorBreakdown: WeeklyRanked[];
  branchBreakdown: WeeklyBranchComparisonRow[];
  /** branches with stock on hand but zero sales this week */
  zeroSalesBranches: WeeklyBranchRow[];
  /** simple value trend across the available weeks (in-scope) */
  trend: {
    weekStart: string;
    salesValue: number;
    salesUnits: number;
    stockUnits: number;
    byDistributor: { distributorCode: string; distributorName: string; salesValue: number }[];
  }[];
};

// ── Missing product resolution ───────────────────────────────────────────────────────────────────
// Rows stored with validation_state='warning' + field='productCode' — no alias yet mapped.
// Shown on the missing-products page; auto-healed when an alias is added.
export type WeeklyMissingProduct = {
  distributorCode: string;
  distributorName: string;
  itemCode: string;
  itemName: string;
  rowCount: number;
  batchCount: number;
  totalStock: number;
  earliestWeek: string | null;
  latestWeek: string | null;
};

// ── Mapping pipeline ─────────────────────────────────────────────────────────────────────────────

/** A raw label captured from an uploaded file that the mapping engine couldn't resolve. */
export type WeeklyMissingLabel = { dimension: "product" | "region"; rawValue: string };

// ── product-scope administration (which PM/GPM/Marketing Manager owns which products) ──────────

export type WeeklyProductOption = { code: string; name: string; line: string };

export type WeeklyScopeAssignment = {
  hrId: string;
  name: string;
  role: string;
  productCodes: string[];
};

export type WeeklyProductScopeAdmin = {
  products: WeeklyProductOption[];
  /** People who currently hold (or are eligible to hold) a product scope. */
  assignments: WeeklyScopeAssignment[];
  /** Eligible people with no assignment yet (for the "add" picker). */
  eligibleWithoutScope: { hrId: string; name: string; role: string }[];
};
