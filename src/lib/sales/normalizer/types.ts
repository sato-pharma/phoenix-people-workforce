// Source of Sales Normalizer — types shared by the pure resolvers, the engine, and the DB
// crosswalk loaders. The normalizer turns a RAW distributor sheet (any layout) into the system's
// coded rows by translating the distributor's own item/territory/customer codes into Phoenix
// Product ID + Brick ID, then deriving Area + Region from the brick hierarchy.

// One Phoenix brick with its parent hierarchy (from the brick master).
export type BrickRef = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  brickId: string;
  brickName: string;
  regionCode: string;
  regionName: string;
};

// All lookups the resolvers need. Plain maps so the resolvers stay pure + unit-testable.
export type Crosswalks = {
  // direct Phoenix codes (from the masters)
  brickById: Map<string, BrickRef>;
  areaByCode: Map<string, { areaCode: string; areaName: string; regionCode: string; regionName: string }>;
  regionByCode: Map<string, { regionCode: string; regionName: string }>;
  productByCode: Map<string, { productCode: string; productName: string; factoryPrice: number; line: string }>;
  // aliases (the learned translations)
  productAliasByKey: Map<string, string>; // normalized alias/name/code -> Phoenix product code
  territoryAliasByKey: Map<string, { targetType: string; targetCode: string }>; // -> brick/area/block code
  areaAliasByKey: Map<string, { areaCode: string; regionCode: string }>;
  regionAliasByKey: Map<string, string>; // -> region code
  // customer crosswalk: `${distributor} ${customerCode}` -> brick id
  customerBrickByKey: Map<string, string>;
};

// How to read ONE distributor's raw sheet: which raw column holds what. Lists are fallbacks
// (first present header wins). A code-defined registry seeds these; later they live in the DB.
export type DistributorProfile = {
  // Rows where is_bonus = 1 (or truthy) are free-goods deliveries — skip them from sales totals.
  bonusColumns?: string[];
  // "skip" (default) — blank customer/territory row is quietly tracked but never blocks import.
  // "error" — blank is a data error; the row goes to exceptions with reason "blank_customer".
  blankCustomerBehavior?: "skip" | "error";
  customerCodeColumns?: string[];
  customerNameColumns?: string[];
  customerAddressColumns?: string[];
  // When set, bypasses detectDayFirst() entirely. All Egyptian distributors use DD-MM-YYYY.
  // ISO dates (YYYY-MM-*) and real Excel Date objects are unaffected regardless of this setting.
  dateFormat?: "day-first" | "month-first";
  dateColumns?: string[];
  discountColumns?: string[];
  distributorCode: string;
  distributorName: string;
  // direct Phoenix brick-id column, if the sheet already carries one
  brickIdColumns?: string[];
  // Columns that uniquely identify this distributor's export format.
  // Used to detect wrong-distributor uploads via fingerprint scoring.
  fingerprintColumns?: string[];
  productColumns: string[]; // item code and/or item name (tried in order)
  qtyColumns: string[];
  regionOnly?: boolean;
  // territory text columns (district / area / street / governorate) used to resolve the brick
  territoryColumns?: string[];
  valueColumns?: string[];
  // "sheet" = take value from the value column as-is (Direct); else recompute qty×price×(1-disc)
  valueSource: "recompute" | "sheet";
};

// A fully-coded output row (matches what the import pipeline expects).
export type CodedRow = {
  areaCode: string;
  areaName: string;
  brickId: string;
  brickName: string;
  bonusQty: number;
  clientCode: string | null;
  clientName: string | null;
  clientAddress: string | null;
  discount: number;
  distributorCode: string;
  invoiceDate: string;
  isDirect: boolean;
  officialLine: string;
  productCode: string;
  productName: string;
  qty: number;
  rawRowNumber: number;
  regionCode: string;
  regionName: string;
  value: number;
};

// A row whose product is explicitly mapped as "ignore" — dropped from coding intentionally but
// tracked so the import surface can tell the user how many units were excluded and why.
export type NormalizeIgnoredRow = {
  rawProduct: string;
  rawProductName: string;
  rawRowNumber: number;
  qty: number;
};

// A row the normalizer could not fully code — surfaced for one-time mapping (never dropped).
export type NormalizeException = {
  rawProduct: string;
  rawProductName: string;
  rawTerritory: string;
  rawCustomerCode: string;
  rawCustomerName: string;
  rawCustomerAddress: string;
  rawRowNumber: number;
  // "blank_customer" = no customer code, territory, or brick ID at all; row is a data error
  // (EG-BR) or an unresolvable summary row — NOT actionable by adding to the customer map.
  reason: "product" | "brick" | "both" | "blank_customer";
};

// Reserved product code for "we don't sell this — neglect it". Rows whose item maps to this are
// dropped from coding (not coded, not an exception). Backed by an inactive sentinel product so the
// alias FK is satisfied and it never appears in reports/dropdowns.
export const IGNORE_PRODUCT_CODE = "IGNORE";

export type NormalizeResult = {
  coded: CodedRow[];
  distributorCode: string;
  exceptions: NormalizeException[];
  ignoredRows: NormalizeIgnoredRow[];
  // Rows skipped because they had no customer code, territory, or brick ID at all.
  // Non-blocking for most distributors (summary/total rows); hard error for EG-BR.
  blankCustomerRows: NormalizeIgnoredRow[];
  summary: {
    brickResolved: number;
    blankCustomerSkipped: number;
    fullyCoded: number;
    ignored: number;
    productResolved: number;
    totalRows: number;
  };
};
