// Source of Sales Normalizer — types shared by the pure resolvers, the engine, and the DB
// crosswalk loaders. The normalizer turns a RAW distributor sheet (any layout) into the system's
// coded rows by translating the distributor's own item/territory/customer codes into Phoenix
// Product ID + Brick ID, then deriving Area + Region from the brick hierarchy.

import type { ProductPeriodPrices } from "@/lib/sales/product-period-price";

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
  // The price of a productByCode product IN A GIVEN MONTH: its `factoryPrice` unless a dated override
  // covers that month (Saginko is 170.52 from 2026-10 while the master stays 111.15). A row is valued
  // at its own month's price. Optional so hand-built test fixtures stay valid; loadCrosswalks always
  // sets it, and absent means the flat price.
  prices?: Pick<ProductPeriodPrices, "priceFor">;
  // Master product-NAME index (normalized name -> Phoenix code), collision-safe. Drives NAME-FIRST
  // product resolution. Optional so hand-built test fixtures stay valid; loadCrosswalks always sets it.
  productByName?: Map<string, string>;
  // aliases (the learned translations)
  productAliasByKey: Map<string, string>; // normalized alias/name/code -> Phoenix product code
  territoryAliasByKey: Map<string, { targetType: string; targetCode: string }>; // -> brick/area/block code
  areaAliasByKey: Map<string, { areaCode: string; regionCode: string }>;
  regionAliasByKey: Map<string, string>; // -> region code
  // Alias keys that pointed at two different targets and were therefore dropped from every index
  // above (Egypt reuses place names across governorates). Present so callers can say "ambiguous"
  // rather than "unknown". Optional so hand-built test fixtures stay valid.
  ambiguousAliasKeys?: Set<string>;
  // customer crosswalk: `${distributor} ${customerCode}` -> brick id
  customerBrickByKey: Map<string, string>;
  // ── Leading-zero / number-vs-text drift guards (additive fallbacks; never replace the exact maps) ──
  // Numeric codes whose leading zeros / text-vs-number serialization differ between months would
  // otherwise miss the exact key and re-surface as "unknown". These index the SAME rows under a
  // numeric-canonical key (leading zeros stripped) so "0001502731" and "1502731" resolve to each
  // other. Built collision-safe: if two distinct raw codes canonicalize to the same value the entry
  // is dropped, so a fallback never mis-resolves.
  customerBrickByCanonicalKey: Map<string, string>; // `${distributor} ${canonicalCustomerCode}` -> brick id
  // Customer keys (exact AND numeric-canonical) whose stored mapping is owner-verified (confidence=100).
  // resolveBrick lets these outrank an area-only sheet signal even across areas — an explicit owner
  // ruling is absolute. Optional so hand-built test fixtures stay valid; loadCrosswalks always sets it.
  ownerVerifiedCustomerKeys?: Set<string>;
  productByCanonicalCode: Map<string, string>; // canonicalProductCode -> Phoenix product code
};

// How to read ONE distributor's raw sheet: which raw column holds what. Lists are fallbacks
// (first present header wins). A code-defined registry seeds these; later they live in the DB.
export type DistributorProfile = {
  // A FREE-GOODS FLAG, never a bonus quantity. Rows where is_bonus = 1 (or truthy) are free-goods
  // deliveries — the WHOLE row is skipped from sales totals. So only a column that marks an entire
  // line as free goods (EPDA's `is_bonus`) belongs here. A bonus COUNT printed beside the paid units
  // (El Qema's `بونص`) must never be mapped: any non-zero cell would drop the row's paid units with it.
  bonusColumns?: string[];
  // "skip" (default) — blank customer/territory row is quietly tracked but never blocks import.
  // "error" — blank is a data error; the row goes to exceptions with reason "blank_customer".
  blankCustomerBehavior?: "skip" | "error";
  customerCodeColumns?: string[];
  customerNameColumns?: string[];
  // Owner rule 2026-10-05, El Qema only: "map by id if not available fall back to name". When true and
  // a row's customer-CODE cell is blank, the engine uses the customer NAME as the customer key — so the
  // row resolves through the SAME customer→brick crosswalk and surfaces in the SAME mapping UI as a
  // code would. El Qema's distributor stopped filling ACCOUNT_ID in some monthly exports (the Sept file
  // left it and رقم الصنف blank on every row), leaving the name as the sole customer identity; without
  // this, every such row was treated as a locationless footer and silently skipped. The crosswalk is
  // keyed by `${distributor} ${normalizeCodeKey(customer_code)}`, stable for an Arabic name. Other
  // distributors keep the strict default (a blank code is a footer row), so nothing else changes.
  customerKeyNameFallback?: boolean;
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
  productColumns: string[]; // legacy merged list (item code and/or name) — kept for existing consumers
  // Name-first split + strict conformance. productNameColumns is the PRIMARY product lookup (owner
  // rule: resolve by NAME); productCodeColumns is the fallback. The strict header validator requires
  // the product NAME column. When set, these are the canonical (Headers-Mapping) headers.
  productNameColumns?: string[];
  productCodeColumns?: string[];
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
  /** The row's PERIOD, "YYYY-MM" — what the closing groups by. */
  invoiceDate: string;
  /** The row's real invoice date, "YYYY-MM-DD", or null when the sheet carries none. */
  invoiceDay: string | null;
  invoiceNumber: string | null;
  isDirect: boolean;
  officialLine: string;
  productCode: string;
  productName: string;
  qty: number;
  /**
   * The source row exactly as the file had it, keyed by the file's OWN column headings.
   *
   * Required, not optional, so a future producer of a CodedRow cannot quietly omit it — which is
   * how `raw_row` came to be written as `{}` on 282,215 of 294,445 rows, leaving no record of what
   * columns a distributor actually sent. That mattered: when the customer address came out empty
   * for every row, the file's real headers could not be recovered from the database to prove why.
   */
  rawRow: Record<string, string>;
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
  // The units the SHEET carried on this row. A free-goods row used to record 0 here, so the units it
  // excluded were invisible on every surface: the Validate screen showed a smaller Qty than the file
  // and nothing said where the difference went (EPDA-BULK, read 2026-10-09 — a sheet carrying 6,736
  // Ivyronc packs validated at 5,214, and the missing 1,522 were free goods on 14 is_bonus rows).
  qty: number;
  // "ignore_mapped" = user explicitly mapped this product to IGNORE; "bonus" = distributor sheet flag
  reason?: "ignore_mapped" | "bonus";
  // Resolved product identity, when the alias dictionary placed the row before it was skipped. Lets
  // the validation breakdowns report the excluded units UNDER THE PRODUCT, in the Bonus column, so
  // the sheet's own total reconciles on screen. Absent when the product itself is unmapped.
  productCode?: string;
  productName?: string;
  officialLine?: string;
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
  //
  // The three unparseable_* reasons are cell-level data errors, not mapping gaps: the row's
  // quantity, value or discount is present but cannot be read. They exist because those cells used
  // to be coerced to 0 (or the discount clamped into range), which made the sale silently vanish
  // from every total instead of appearing here for review.
  reason:
    | "product"
    | "brick"
    | "both"
    | "blank_customer"
    | "unparseable_qty"
    | "unparseable_value"
    | "discount_out_of_range";
  // For the three unparseable_* reasons: the cell exactly as the sheet wrote it, trimmed, so the person
  // uploading is told WHAT is wrong in row N, not only that something is. Empty for the other reasons.
  rawCell?: string;
};

// A number cell written in a form with one meaning only — Arabic-Indic digits, space-grouped
// thousands, dots for thousands before a decimal comma ("1.234,56") — that the engine rewrote and then
// read (normalizeNumberText). Kept so the upload says exactly what it read, instead of quietly reading
// it: before, the first two refused the whole file and "1.234,56" was read silently as 1.23456.
export type CellCorrection = {
  rawRowNumber: number;
  field: "quantity" | "value" | "discount";
  raw: string;
  // The number the row was imported with — a discount as the fraction the engine stores.
  read: number;
};

// Reserved product code for "we don't sell this — neglect it". Rows whose item maps to this are
// dropped from coding (not coded, not an exception). Backed by an inactive sentinel product so the
// alias FK is satisfied and it never appears in reports/dropdowns.
export const IGNORE_PRODUCT_CODE = "IGNORE";

// A customer whose brick, as resolved directly from THIS sheet (source !== "customer"), differs
// from — or is missing from — the stored customer->brick crosswalk. The sheet's own brick always
// wins for the row it came from; this list lets the caller self-heal the stored crosswalk so future
// rows for this customer (even ones whose territory text is blank or unrecognized) resolve correctly
// too, instead of the stale/absent stored mapping silently winning again next time.
export type CustomerBrickCorrection = {
  distributorCode: string;
  customerCode: string;
  brickId: string;
  previousBrickId: string | null;
};

export type NormalizeResult = {
  coded: CodedRow[];
  distributorCode: string;
  exceptions: NormalizeException[];
  ignoredRows: NormalizeIgnoredRow[];
  // Rows skipped because they had no customer code, territory, or brick ID at all.
  // Non-blocking for most distributors (summary/total rows); hard error for EG-BR.
  blankCustomerRows: NormalizeIgnoredRow[];
  // Deduped (last-row-wins per customer) sheet-verified brick corrections — see CustomerBrickCorrection.
  customerBrickCorrections: CustomerBrickCorrection[];
  // Optional because only the engine reads cells; results built elsewhere carry none.
  cellCorrections?: CellCorrection[];
  summary: {
    brickResolved: number;
    blankCustomerSkipped: number;
    fullyCoded: number;
    ignored: number;
    productResolved: number;
    totalRows: number;
    // Independent physical counter: every non-empty data row the engine scanned. Equals totalRows by
    // construction today, but lets the validator assert no-silent-loss for real (totalRows is itself
    // DEFINED as the bucket sum, so it can never catch a future "skipped without bucketing" bug).
    scannedDataRows?: number;
  };
};
