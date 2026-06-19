// Sales Operations Module — engine types.
//
// This is a ground-up rewrite of the Source-of-Sales mapping engine, driven by the unified
// "Headers Mapping" sheet. Locked rules (owner-confirmed):
//   1. Each distributor template maps the distributor's RAW headers onto unified target fields.
//      Only the lookup keys + qty are mandatory; every other field is OPTIONAL.
//   2. The reference BRICK (and hence Area/Region) is looked up per the sheet's column L:
//        - "customer-code": look up the brick FROM the customer code (customer→brick crosswalk).
//        - "brick-name":    look up the brick FROM the brick/area NAME (territory/area alias).
//        - "office-allocation": Office — not a row lookup; units are allocated by contribution %.
//   3. The reference PRODUCT (id + name + family) is looked up BY DEFAULT from the product NAME;
//      the distributor product code is only a FALLBACK when the name cannot be matched.
//   4. value = qty × factory price. Discounts are ignored. Bonus / free units are excluded entirely.
//   5. Area + Region are ALWAYS derived from the brick master — never read from the distributor sheet.

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

// One Phoenix product (from the product master, source_of_sales_products).
export type ProductRef = {
  productCode: string;
  productName: string;
  factoryPrice: number;
  family: string;
  line: string;
};

// How a distributor's reference brick is resolved (the sheet's column L).
export type BrickLookupStrategy = "customer-code" | "brick-name" | "office-allocation";

// One distributor template — the unified mapping sheet, one row per distributor.
// Header lists are fallbacks: the first present header wins. An omitted/empty list means the
// distributor simply does not provide that (optional) field.
export type DistributorTemplate = {
  code: string; // column K
  name: string; // column J
  brickLookup: BrickLookupStrategy; // column L

  // Customer code (unified col A). When brickLookup = "customer-code" this is ALSO the brick key.
  customerCodeHeaders?: string[];
  customerNameHeaders?: string[]; // col B (optional, display only)
  customerAddressHeaders?: string[]; // col C (optional, display only)

  // Brick/area NAME (unified col E). The brick key when brickLookup = "brick-name".
  brickNameHeaders?: string[];

  // Product — NAME is the primary key (col H); code (col G) is a fallback only.
  productNameHeaders?: string[];
  productCodeHeaders?: string[];

  qtyHeaders?: string[]; // col I — units. value = qty × factory price.
  dateHeaders?: string[]; // col F — omit for date-less channels (ChemiPharm, Office).
  dateFormat?: "day-first" | "month-first"; // all Egyptian distributors are day-first.

  // Rows flagged here (truthy, not "0"/"false") are free goods — excluded entirely.
  bonusHeaders?: string[];

  // "skip" (default): a blank-key row is tracked but never blocks. "error": blank is a data error.
  blankCustomerBehavior?: "skip" | "error";

  // Columns that fingerprint this distributor's file (wrong-file detection on upload).
  fingerprintHeaders?: string[];

  // True when this distributor resolves to AREA/region only (no brick) BY DESIGN — e.g. ChemiPharm
  // maps the brick/area NAME ("Area name A") to an area, so coded rows legitimately have no brick.
  // Suppresses the "resolved to region/area only" warning for this channel.
  regionOnly?: boolean;

  // True when the file carries a per-row date column; false channels take the period from the picker.
  hasDateColumn: boolean;
};

// All lookups the pure resolvers need. Plain maps so the resolvers stay pure + unit-testable.
export type Crosswalks = {
  // Phoenix masters
  brickById: Map<string, BrickRef>;
  areaByCode: Map<string, { areaCode: string; areaName: string; regionCode: string; regionName: string }>;
  regionByCode: Map<string, { regionCode: string; regionName: string }>;
  productByCode: Map<string, ProductRef>;
  // Master product-NAME index (normalized name → product code) — powers name-first resolution
  // even without a learned alias. Built collision-safe (dropped if two products share a name).
  productByName: Map<string, string>;
  // Leading-zero / number-vs-text fallback for purely-numeric product codes.
  productByCanonicalCode: Map<string, string>;
  // Learned per-distributor product aliases: `${distributor} ${normalizedAlias}` → product code.
  productAliasByKey: Map<string, string>;
  // Geography aliases
  territoryAliasByKey: Map<string, { targetType: string; targetCode: string }>;
  areaAliasByKey: Map<string, { areaCode: string; regionCode: string }>;
  // Customer crosswalk: `${distributor} ${customerCode}` → brick id (+ numeric-canonical fallback).
  customerBrickByKey: Map<string, string>;
  customerBrickByCanonicalKey: Map<string, string>;
};

// A fully-coded output row.
export type CodedRow = {
  areaCode: string;
  areaName: string;
  brickId: string;
  brickName: string;
  clientCode: string | null;
  clientName: string | null;
  clientAddress: string | null;
  distributorCode: string;
  family: string;
  invoiceDate: string; // YYYY-MM
  officialLine: string;
  productCode: string;
  productName: string;
  qty: number;
  rawRowNumber: number;
  regionCode: string;
  regionName: string;
  value: number;
};

// A row the engine could not fully code — surfaced for one-time mapping, never silently dropped.
export type NormalizeException = {
  rawProduct: string;
  rawProductName: string;
  rawBrickName: string;
  rawCustomerCode: string;
  rawCustomerName: string;
  rawRowNumber: number;
  // "product" = name+code both unmapped; "brick" = geography unresolved; "both" = neither;
  // "blank_key" = no product/customer/brick key at all (summary/footer row or hard data error).
  reason: "product" | "brick" | "both" | "blank_key";
};

// A row intentionally excluded (bonus/free unit) — tracked so the upload can report excluded units.
export type ExcludedRow = {
  rawProduct: string;
  rawProductName: string;
  rawRowNumber: number;
  qty: number;
  reason: "bonus";
};

export type NormalizeResult = {
  distributorCode: string;
  coded: CodedRow[];
  exceptions: NormalizeException[];
  excluded: ExcludedRow[];
  summary: {
    scannedDataRows: number;
    fullyCoded: number;
    productResolved: number;
    // Coded rows whose product matched by the distributor CODE fallback rather than by NAME.
    // Should be low when the name-first rule is working; a spike means name aliases are missing.
    productByCodeFallback: number;
    brickResolved: number;
    excludedBonus: number;
    blankKeySkipped: number;
    exceptions: number;
  };
};
