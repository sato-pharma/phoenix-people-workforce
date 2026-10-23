import ExcelJS from "exceljs";
import { unstable_cache } from "next/cache.js";

import { writeAuditLog } from "@/lib/admin/audit";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import {
  isConfidentialRevealRole,
  isHeadOfficeLine,
  RESTRICTED_PRODUCT_CODES,
} from "@/lib/sales/confidential-products";
import { directRowsCarryOwnArea, isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import {
  allocateDirectToOperationalRegions,
  applyOperationalRegions,
  usesOrganogramRegions,
  loadDirectSubmitters,
  loadLineOperationalRegions,
  loadRegionBySubmitter,
} from "@/lib/sales/closing-organogram-regions";
import { applyClosingAreaMerges, markMergedAreaRowsStatic } from "@/lib/sales/closing-area-merges";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { assertNotADuplicateUpload, repriceableUploadRow, totalValueAtPeriod } from "@/lib/sales/import-duplicate-guard";
import { JULY_2026_DIRECT_PERIOD, JULY_2026_DIRECT_ROWS } from "@/lib/sales/july-2026-direct-orders";
import {
  addClosingSales,
  emptyClosingCell,
  roundedClosingCell,
  sumClosingRowTotal,
} from "@/lib/sales/monthly-closing-matrix-cells";
import { loadMonthlyTargets, resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { misplacedComma, needsAGuess, normalizeNumberText } from "@/lib/sales/normalizer/number-text";
import { numberProblem } from "@/lib/sales/normalizer/row-messages";
import { isOfficeDistributorCode } from "@/lib/sales/office-distributor";
import {
  loadProductPeriodPrices,
  productPeriodPricesFromRows,
  type ProductPriceOverrideRow,
} from "@/lib/sales/product-period-price";
import { finalizeSosBatchAndAuditSupersede } from "@/lib/sales/source-of-sales-batch-supersede";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, rpcAll, toQueryError } from "@/lib/supabase/server";
import { writeStoreSplitNetForBatch } from "@/lib/sales/attribution-store-split-refresh";

export type SalesDistributorOption = {
  code: string;
  name: string;
};

export type SalesAreaRegionReference = {
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
  /** Set only when the organogram re-homed this area for the selected line — see MonthlyClosingAreaRow. */
  sourceRegionCode?: string;
  sourceRegionName?: string;
};

export type SalesRegionReference = {
  regionCode: string;
  regionName: string;
};

export type SalesAreaReference = SalesAreaRegionReference;

export type SalesBlockReference = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  blockName: string;
  regionCode: string;
  regionName: string;
};

export type SalesBrickReference = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  blockName: string;
  brickId: string;
  brickName: string;
  regionCode: string;
  regionName: string;
};

export type SalesProductReference = {
  factoryPrice: number;
  family: string;
  familyCode: string;
  line: string;
  productCode: string;
  productName: string;
  source: string;
};

export type SalesDistributorReference = SalesDistributorOption;

export type SalesReferenceData = {
  areas?: SalesAreaReference[];
  blocks?: SalesBlockReference[];
  bricks?: SalesBrickReference[];
  // Customer -> brick crosswalk (source_of_sales_customer_map), keyed by distributor + customer
  // code. Used to auto-fill a row's Brick (and derived Area/Region) when the coded sheet leaves
  // the brick blank/#N/A. Optional so callers and unit tests can omit it.
  customerBricks?: { brickId: string; customerCode: string; distributorCode: string }[];
  distributors: SalesDistributorReference[];
  products: SalesProductReference[];
  // Dated factory-price overrides (source_of_sales_product_price_history). A product's `factoryPrice`
  // above is the master's flat price; a row is valued at the price OF ITS MONTH, which differs from it
  // only where one of these covers that month (Saginko from 2026-10). loadSalesReferenceData always
  // reads them; optional so hand-built test fixtures stay valid, and absent means "no overrides".
  productPriceOverrides?: ProductPriceOverrideRow[];
  regions: SalesAreaRegionReference[];
};

export type DistributorSalesValidationIssue = {
  field: string;
  message: string;
  rowNumber: number;
  severity: "failure" | "warning";
  value: string | null;
};

export type DistributorSalesTotal = {
  rowCount: number;
  totalBonusQty: number;
  totalQty: number;
  totalValue: number;
};

export type DistributorSalesLineSummary = DistributorSalesTotal & {
  line: string;
};

export type DistributorSalesRegionSummary = DistributorSalesTotal & {
  regionCode: string;
  regionName: string;
};

export type DistributorSalesAreaSummary = DistributorSalesTotal & {
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
};

export type DistributorSalesBrickSummary = DistributorSalesTotal & {
  areaCode: string;
  areaName: string;
  blockCode: string;
  blockName: string;
  brickId: string;
  brickName: string;
  regionCode: string;
  regionName: string;
};

// Cross-tab row: one entry per (brick × product) — only populated for the Office channel preview.
export type DistributorSalesBrickProductRow = {
  areaCode: string;
  areaName: string;
  brickId: string;
  brickName: string;
  productCode: string;
  productName: string;
  qty: number;
  regionCode: string;
  regionName: string;
  value: number;
};

export type DistributorSalesProductSummary = DistributorSalesTotal & {
  officialLine: string;
  productCode: string;
  productName: string;
};

export type DistributorSalesValidationResult = {
  // Non-blocking advisories surfaced to the user (e.g. the file's distributor column disagrees with
  // the selected distributor). These never block the upload — they just prompt a sanity check.
  advisories?: string[];
  batchId?: string;
  blockingReasons: string[];
  byArea: DistributorSalesAreaSummary[];
  byBrick: DistributorSalesBrickSummary[];
  /** Only populated for the Office channel — brick × product cross-tab. */
  byBrickProduct?: DistributorSalesBrickProductRow[];
  byLine: DistributorSalesLineSummary[];
  byProduct: DistributorSalesProductSummary[];
  byRegion: DistributorSalesRegionSummary[];
  createdAt?: string;
  distributor: SalesDistributorOption;
  failedRows: number;
  fileName: string;
  importableRows: number;
  issues: DistributorSalesValidationIssue[];
  period: string | null;
  rowCount: number;
  sheetName: string;
  status: "blocked" | "validated";
  templateKey: string;
  templateName: string;
  totals: DistributorSalesTotal;
  warningRows: number;
};

export type SourceOfSalesUploadBatch = {
  batchId: string;
  blockingReasons: string[];
  createdAt: string;
  distributorCode: string;
  distributorName: string;
  failedRows: number;
  fileName: string;
  importableRows: number;
  period: string | null;
  rowCount: number;
  status: "blocked" | "validated";
  templateKey: string;
  totalBonusQty: number;
  totalQty: number;
  totalValue: number;
  uploadedBy: string;
  warningRows: number;
};

export type SourceOfSalesDashboardGroup = DistributorSalesTotal & {
  code: string | null;
  key: string;
  label: string;
  line: string | null;
};

export type SourceOfSalesDashboardDistributor = DistributorSalesTotal & {
  distributorCode: string;
  distributorName: string;
  sheetCount: number;
};

export type SourceOfSalesDashboard = {
  availablePeriods: string[];
  byArea: SourceOfSalesDashboardGroup[];
  byBrick: SourceOfSalesDashboardGroup[];
  byDistributor: SourceOfSalesDashboardDistributor[];
  byLine: SourceOfSalesDashboardGroup[];
  byProduct: SourceOfSalesDashboardGroup[];
  byRegion: SourceOfSalesDashboardGroup[];
  period: string | null;
  sheetCount: number;
  totals: DistributorSalesTotal;
};

export type SourceOfSalesProduct = SalesProductReference & {
  active: boolean;
  createdAt: string;
  normalizedLine: string;
  normalizedProductName: string;
  sourceFile: string;
  sourceRowNumber: number | null;
  sourceSheet: string;
  updatedAt: string;
};

export type SourceOfSalesProductInput = {
  active?: boolean;
  factoryPrice: number | string;
  family: string;
  familyCode: string;
  line: string;
  productCode: string;
  productName: string;
  source: string;
  sourceFile?: string | null;
  sourceRowNumber?: number | string | null;
  sourceSheet?: string | null;
};

type NormalizedSourceOfSalesProductInput = {
  active: boolean;
  factoryPrice: number;
  family: string;
  familyCode: string;
  line: string;
  normalizedLine: string;
  normalizedProductName: string;
  productCode: string;
  productName: string;
  source: string;
  sourceFile: string;
  sourceRowNumber: number | null;
  sourceSheet: string;
};

type HeaderMap = {
  columns: Map<string, number>;
  labels: Map<string, string>;
  rowNumber: number;
  template: DistributorSalesTemplate;
};

export type ParsedDistributorRow = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  blockName: string;
  bonusQty: number;
  brickId: string;
  brickName: string;
  clientAddress: string | null;
  clientCode: string | null;
  clientName: string | null;
  discount: number;
  distributorCode: string;
  isDirect: boolean;
  /** Full day-level ISO date (YYYY-MM-DD); null when unparseable or outside the row's period. */
  invoiceDate: string | null;
  /** Raw invoice / document number from the distributor sheet; null when the column is absent. */
  invoiceNumber: string | null;
  invoicePeriod: string | null;
  officialLine: string;
  productCode: string;
  productName: string;
  qty: number;
  regionCode: string;
  regionName: string;
  rowNumber: number;
  rawRow: Record<string, string>;
  validationIssues: DistributorSalesValidationIssue[];
  validationState: "failed" | "valid" | "warning";
  value: number;
};

type DistributorSalesTemplateField =
  | "areaCode"
  | "brickId"
  | "distributorCode"
  | "invoiceDate"
  | "productCode"
  | "qty"
  | "regionCode";

type OptionalTemplateField = "areaName" | "brickName" | "productName" | "regionName";

type DistributorSalesTemplate = {
  // Optional bonus / free-unit column. Bonus is neglected in both quantity and value
  // (Qty only), so it is informational; feeds without a free-unit column simply omit it.
  bonusField?: string;
  // Optional per-row "this whole line is a bonus / free-goods line" flag column (e.g.
  // is_bonus = 1). When truthy, the row's qty is treated as bonus: it adds NO value and
  // does NOT count as sales quantity (qty-only rule).
  bonusFlagField?: string;
  // Optional per-customer columns (each a list of header fallbacks). Used to capture the
  // client identity for the Customer Directory; never affects validation.
  customerFields?: { address: string[]; code: string[]; name: string[] };
  // Optional per-row discount column. Captured and stored on the row for display only — since
  // 2026-09-07 it does NOT reduce anything (value = Qty x factory_price, full stop).
  discountField?: string;
  distributorCodes: string[];
  // areaCode / brickId are optional so a region-only channel (Direct) can omit them; the
  // other coded fields are always required.
  fields: Partial<Record<DistributorSalesTemplateField, string>> & {
    distributorCode: string;
    invoiceDate: string;
    productCode: string;
    qty: string;
    regionCode: string;
  };
  key: string;
  name: string;
  optionalFields?: Partial<Record<OptionalTemplateField, string[]>>;
  // Region-only channel (Direct): no area/brick, and the row value is taken from the sheet's
  // own value column (valueField) instead of being recomputed from Qty x factory_price.
  regionOnly?: boolean;
  // When set, the row value is read from this column verbatim (the Direct channel). The
  // factory-price recompute is skipped and the row is flagged is_direct.
  valueField?: string;
};

// A coded field may be expressed as a single header name OR a list of accepted header aliases.
// findHeaderMap resolves it to the first alias actually present in the sheet.
type FieldSpec = string | string[];

// Template DEFINITION — the coded ID columns are stable, but distributors keep their own raw names
// for qty / date / brick on hybrid (raw + hand-coded) sheets, so those fields list header aliases
// (first = canonical, used in messages). findHeaderMap resolves a Def to a DistributorSalesTemplate
// whose fields are the concrete single header names present in the sheet.
type DistributorSalesTemplateDef = Omit<DistributorSalesTemplate, "fields"> & {
  fields: Partial<Record<DistributorSalesTemplateField, FieldSpec>> & {
    distributorCode: FieldSpec;
    invoiceDate: FieldSpec;
    productCode: FieldSpec;
    qty: FieldSpec;
    regionCode: FieldSpec;
  };
};

// Shared header aliases for the columns whose names vary across distributors on hybrid sheets.
// Order = priority: the first alias present in the sheet wins (so the invoiced/sales qty is picked
// before pack/unit, and the explicit Brick ID before a duplicated "Brick ID2"). Matching is on the
// normalized (lower-cased, space-collapsed) header, so casing/spacing differences also match.
const QTY_HEADER_ALIASES = ["Qty", "Quantity", "QTY_INVOICE", "QTY_PACK", "qnt"];
// "BILLINGDATE" is Sofico's own invoice-date header. Appended LAST so the canonical "Invoice Date"
// still wins on sheets that carry both — this only lets Sofico's raw date column resolve.
const INVOICE_DATE_HEADER_ALIASES = ["Invoice Date", "Date", "INVOICE_DATE", "inv_date", "BILLINGDATE"];
const BRICK_ID_HEADER_ALIASES = ["Brick ID", "Brick ID2"];
// Common invoice / document number column aliases across distributor sheets. Probed automatically;
// no template-level config needed. Used only for duplicate detection — never stored in the DB.
const INVOICE_NUMBER_HEADER_ALIASES = [
  "Invoice No", "Invoice No.", "Invoice Number", "Invoice #", "INVOICE_NO", "INV_NO",
  "Doc. No", "Doc No", "Document No", "Document Number", "Bill No", "Bill Number",
  "رقم الفاتورة", "رقم المستند",
];

const OVERSEAS_PS_TEMPLATE: DistributorSalesTemplateDef = {
  customerFields: { address: ["Customer Address"], code: ["Customer"], name: ["Customer Name"] },
  discountField: "Discount%",
  distributorCodes: ["PS"],
  fields: {
    areaCode: "Area ID",
    brickId: BRICK_ID_HEADER_ALIASES,
    distributorCode: "Distrub ID",
    invoiceDate: INVOICE_DATE_HEADER_ALIASES,
    productCode: "Product ID",
    qty: QTY_HEADER_ALIASES,
    regionCode: "Region ID",
  },
  key: "overseas_ps",
  name: "Overseas PS coded template",
  optionalFields: {
    productName: ["Product Name", "Mat. Desc."],
  },
};

const IBN_SINA_IS_TEMPLATE: DistributorSalesTemplateDef = {
  customerFields: { address: ["Address_En", "Address_Ar"], code: ["Client Code"], name: ["Client Name"] },
  discountField: "Discount%",
  distributorCodes: ["IS"],
  fields: {
    areaCode: "Area ID",
    brickId: BRICK_ID_HEADER_ALIASES,
    distributorCode: "Distrub ID",
    invoiceDate: INVOICE_DATE_HEADER_ALIASES,
    productCode: "Product ID",
    qty: QTY_HEADER_ALIASES,
    regionCode: "Region ID",
  },
  key: "ibn_sina_is",
  name: "Ibn Sina IS coded template",
  optionalFields: {
    brickName: ["Brick Name"],
    productName: ["Item Name"],
  },
};

// Ibn Sina "Sato" branch (PAS feed) — treated as its own distributor (code IS-S). Same
// coded format as IS. "Quantity" is paid units only; "Total Quantity" (paid+free) is
// never used — free units are always neglected per the system-wide bonus-neglect policy.
const IBN_SINA_SATO_ISS_TEMPLATE: DistributorSalesTemplateDef = {
  customerFields: { address: ["Address_En", "Address_Ar"], code: ["Client Code"], name: ["Client Name"] },
  discountField: "Discount%",
  distributorCodes: ["IS-S"],
  fields: {
    areaCode: "Area ID",
    brickId: BRICK_ID_HEADER_ALIASES,
    distributorCode: "Distrub ID",
    invoiceDate: INVOICE_DATE_HEADER_ALIASES,
    productCode: "Product ID",
    qty: QTY_HEADER_ALIASES,
    regionCode: "Region ID",
  },
  key: "ibn_sina_sato_iss",
  name: "Ibn Sina Sato IS-S coded template",
  optionalFields: {
    brickName: ["Brick Name"],
    productName: ["Item Name"],
  },
};

// Ibn Sina "Lacto" supplier feed — its own distributor (code IS-L), by the owner's ruling of
// 2026-10-13: Ibn Sina exports one workbook PER SUPPLIER, so LACTO MISR EG (supplier 111399, the four
// Lacto SKUs) arrives separately from the Sato (PAS) one and must not share IS-S's code. Same coded
// format as IS and IS-S, so the template mirrors them; "Quantity" is paid units only, "Total
// Quantity" (paid+free) is never used, per the system-wide bonus-neglect policy.
const IBN_SINA_LACTO_ISL_TEMPLATE: DistributorSalesTemplateDef = {
  customerFields: { address: ["Address_En", "Address_Ar"], code: ["Client Code"], name: ["Client Name"] },
  discountField: "Discount%",
  distributorCodes: ["IS-L"],
  fields: {
    areaCode: "Area ID",
    brickId: BRICK_ID_HEADER_ALIASES,
    distributorCode: "Distrub ID",
    invoiceDate: INVOICE_DATE_HEADER_ALIASES,
    productCode: "Product ID",
    qty: QTY_HEADER_ALIASES,
    regionCode: "Region ID",
  },
  key: "ibn_sina_lacto_isl",
  name: "Ibn Sina Lacto IS-L coded template",
  optionalFields: {
    brickName: ["Brick Name"],
    productName: ["Item Name"],
  },
};

// EGD Branch (code EG-BR) — a separate branch of EGD (parent code EG). Fully-coded EGD monthly sheet:
// EGD's raw export with the Phoenix coded columns (Product ID / Brick ID / Area ID / Region ID /
// Distrub ID, where Distrub ID = "EG-BR") appended. Date is "Invoice Date", qty the net "Qty",
// customer CUSTOMER_CODE/NAME/ADDRESS. Value RECOMPUTED from Qty x factory_price.
const EGD_PH_TEMPLATE: DistributorSalesTemplateDef = {
  customerFields: { address: ["CUSTOMER_ADDRESS"], code: ["CUSTOMER_CODE"], name: ["CUSTOMER_NAME"] },
  discountField: "Discount%",
  distributorCodes: ["EG-BR"],
  fields: {
    areaCode: "Area ID",
    brickId: BRICK_ID_HEADER_ALIASES,
    distributorCode: "Distrub ID",
    invoiceDate: INVOICE_DATE_HEADER_ALIASES,
    productCode: "Product ID",
    qty: QTY_HEADER_ALIASES,
    regionCode: "Region ID",
  },
  key: "egd_ph",
  name: "EGD Branch coded template",
  optionalFields: {
    productName: ["ITEM_NAME"],
  },
};

// MEC (code MC). Fully-coded MEC monthly sheet (MEC's raw Arabic export + appended Product ID / Brick
// ID / Area ID / Region ID / Distrub ID, where Distrub ID = "MC"). MEC keeps ARABIC raw headers: qty
// "الكمية" (net), date "تاريخ المستند" (the invoice date — NOT the creation date "تاريخ الإنشاء"),
// customer كود/العميل/address, discount "خصم", productName "إسم الصنف". Value RECOMPUTED.
const MEC_MC_TEMPLATE: DistributorSalesTemplateDef = {
  customerFields: { address: ["address"], code: ["كود"], name: ["العميل"] },
  discountField: "خصم",
  distributorCodes: ["MC"],
  fields: {
    areaCode: "Area ID",
    brickId: BRICK_ID_HEADER_ALIASES,
    distributorCode: "Distrub ID",
    invoiceDate: ["تاريخ المستند", ...INVOICE_DATE_HEADER_ALIASES],
    productCode: "Product ID",
    qty: ["الكمية", ...QTY_HEADER_ALIASES],
    regionCode: "Region ID",
  },
  key: "mec_mc",
  name: "MEC coded template",
  optionalFields: {
    productName: ["إسم الصنف"],
  },
};

// Sofico (code SF). The canonical monthly upload is Sofico's own raw export with the Phoenix coded
// columns (Product ID / Brick ID / Area ID / Region ID / Distrub ID) appended, so it is read straight
// from those coded columns like every other distributor. Sofico keeps its raw header names: the date
// is "BILLINGDATE" (added to INVOICE_DATE_HEADER_ALIASES), the quantity is the net "qty" (returns
// already signed), and there is no free-unit column. Value is RECOMPUTED from
// Qty x factory_price (no valueField). Captures Sofico's customer code/name so
// client_code is populated like the other distributors.
const SOFICO_SF_TEMPLATE: DistributorSalesTemplateDef = {
  customerFields: {
    address: ["ADDRESS", "ADDRESSSHIP"],
    code: ["CUSTOMERCODE", "ORDERACCOUNT"],
    name: ["CUSTOMERNAME", "CUSTOMERNAME0013"],
  },
  discountField: "Discount%",
  distributorCodes: ["SF"],
  fields: {
    areaCode: "Area ID",
    brickId: BRICK_ID_HEADER_ALIASES,
    distributorCode: "Distrub ID",
    invoiceDate: INVOICE_DATE_HEADER_ALIASES,
    productCode: "Product ID",
    qty: QTY_HEADER_ALIASES,
    regionCode: "Region ID",
  },
  key: "sofico_sf",
  name: "Sofico SF coded template",
  optionalFields: {
    productName: ["ITEMNAME"],
  },
};

// Ramco (code RM). Same hybrid shape as Sofico: Ramco's own raw export with the Phoenix coded
// columns (Product ID / Brick ID / Area ID / Region ID / Distrub ID) appended, read straight from
// those coded columns. Ramco keeps ARABIC raw headers, so the qty is the net "صافى كمية" (returns
// already signed) and the date is "تاريخ" (a real Excel date cell — unambiguous, no day-first issue);
// both are listed first, then the shared English aliases as a defensive fallback. Discount is
// "خصم%". Value is RECOMPUTED from Qty x factory_price (no valueField —
// the sheet's "صافى البيع" includes tax and is ignored). Captures the Ramco customer code/name/address.
const RAMCO_RM_TEMPLATE: DistributorSalesTemplateDef = {
  customerFields: { address: ["عنوان"], code: ["كود"], name: ["عميل"] },
  discountField: "خصم%",
  distributorCodes: ["RM"],
  fields: {
    areaCode: "Area ID",
    brickId: BRICK_ID_HEADER_ALIASES,
    distributorCode: "Distrub ID",
    invoiceDate: ["تاريخ", ...INVOICE_DATE_HEADER_ALIASES],
    productCode: "Product ID",
    qty: ["صافى كمية", ...QTY_HEADER_ALIASES],
    regionCode: "Region ID",
  },
  key: "ramco_rm",
  name: "Ramco RM coded template",
  optionalFields: {
    productName: ["صنف"],
  },
};

// Direct (company) channel — orders shipped straight from the company, not through a
// distributor. Region-only (no area/brick), and the SALE VALUE is taken from the sheet's own
// "Value" column (real per-deal pricing; e.g. Satoslim has Price 0 but a real Value), never
// recomputed from factory price. Region "National" is a special bucket for orders tied to no region.
const DIRECT_TEMPLATE: DistributorSalesTemplateDef = {
  customerFields: { address: [], code: [], name: ["Pharmacy Name"] },
  distributorCodes: ["Direct"],
  fields: {
    distributorCode: "Distrub ID",
    invoiceDate: INVOICE_DATE_HEADER_ALIASES,
    productCode: "Product ID",
    qty: QTY_HEADER_ALIASES,
    regionCode: "Region ID",
  },
  key: "direct_orders",
  name: "Direct (Company) channel template",
  optionalFields: {
    productName: ["Product"],
  },
  regionOnly: true,
  valueField: "Value",
};

// Unified Normalizer coded sheet. The Source Normalizer emits ONE coded format (CODED_HEADERS in
// src/lib/sales/normalizer/service.ts) for every distributor, so its output can flow through the same
// Source-of-Sales validation + import as everything else. Value is RECOMPUTED from
// Qty x factory_price; the Normalizer still writes the discount it read into the coded sheet's
// "Discount%" column, but neither side multiplies by it any more. Offered as a FINAL fallback
// in templateForDistributor — tried AFTER the distributor's own template — so a coded sheet validates
// under any distributor while raw/hand-coded sheets still match their dedicated template first.
export const NORMALIZER_TEMPLATE: DistributorSalesTemplateDef = {
  customerFields: { address: ["Customer Address"], code: ["Customer"], name: ["Customer Name"] },
  discountField: "Discount%",
  distributorCodes: ["NORMALIZER"],
  fields: {
    areaCode: "Area ID",
    brickId: BRICK_ID_HEADER_ALIASES,
    distributorCode: "Distrub ID",
    invoiceDate: INVOICE_DATE_HEADER_ALIASES,
    productCode: "Product ID",
    qty: QTY_HEADER_ALIASES,
    regionCode: "Region ID",
  },
  key: "normalizer",
  name: "Normalized coded sheet",
  optionalFields: {
    productName: ["Product Name"],
  },
};

const DISTRIBUTOR_SALES_TEMPLATES = [
  OVERSEAS_PS_TEMPLATE,
  IBN_SINA_IS_TEMPLATE,
  IBN_SINA_SATO_ISS_TEMPLATE,
  IBN_SINA_LACTO_ISL_TEMPLATE,
  EGD_PH_TEMPLATE,
  MEC_MC_TEMPLATE,
  SOFICO_SF_TEMPLATE,
  RAMCO_RM_TEMPLATE,
  DIRECT_TEMPLATE,
] as const;

function normalizeKey(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCode(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

/** Region-code → region-name lookup built from `source_of_sales_regions` master rows. */
export function buildRegionNameByCode(
  regionRows: Array<Record<string, unknown>>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of regionRows) {
    const code = normalizeCode(row.region_code);
    if (code) map.set(code, String(row.region_name ?? ""));
  }
  return map;
}

/**
 * Maps `source_of_sales_areas` rows to area references, joining the Region NAME from the
 * regions master by region_code. The areas table does NOT carry `region_name` in every
 * Supabase project (schema diverges across staging/production), so the name is always
 * derived here from the master — never selected off the area row. Shared by both
 * `loadSalesReferenceData` and `listActiveSalesAreas` so the two paths cannot drift.
 */
export function buildAreaReferencesFromRows(
  areaRows: Array<Record<string, unknown>>,
  regionNameByCode: Map<string, string>,
): SalesAreaReference[] {
  return areaRows.map((row) => {
    const regionCode = String(row.region_code ?? "");
    return {
      areaCode: String(row.area_code ?? ""),
      areaName: String(row.area_name ?? ""),
      regionCode,
      regionName: regionNameByCode.get(normalizeCode(regionCode)) ?? "",
    };
  });
}

function normalizeDisplay(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeOptionalDisplay(value: unknown, fallback: string) {
  const normalized = normalizeDisplay(value);
  return normalized || fallback;
}

function isNotAvailable(value: unknown) {
  return normalizeDisplay(value).toUpperCase() === "#N/A";
}

function cellValue(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    if ("result" in value) return (value as { result?: unknown }).result ?? cell.text;
    if ("error" in value) return (value as { error?: unknown }).error ?? cell.text;
    if ("text" in value) return (value as { text?: unknown }).text ?? cell.text;
    if ("richText" in value) {
      const richText = (value as { richText?: Array<{ text?: string }> }).richText;
      return richText?.map((part) => part.text ?? "").join("") ?? cell.text;
    }
  }
  return value ?? cell.text;
}

function requiredHeadersForTemplate(template: DistributorSalesTemplate) {
  return Object.values(template.fields);
}

function templateForDistributor(distributorCode: string): DistributorSalesTemplateDef[] {
  const code = normalizeCode(distributorCode);
  const matchingTemplates = DISTRIBUTOR_SALES_TEMPLATES.filter((template) =>
    template.distributorCodes.map(normalizeCode).includes(code),
  );
  // Known distributor → try its own dedicated template first. Unknown distributor → no dedicated
  // template; do NOT fall back to every distributor's template (that made a normalizer-coded buffer
  // match OVERSEAS_PS first, since PS and NORMALIZER have identical headers, mislabelling the result
  // as "Overseas PS"). Only the Normalizer coded sheet applies to unknown distributors.
  const base = matchingTemplates.length > 0 ? [...matchingTemplates] : [];
  // Always allow the unified Normalizer coded sheet as the FINAL fallback (tried after the distributor's
  // own template), so a coded sheet validates under any distributor. Raw/hand-coded sheets still match
  // their dedicated template first; raw (uncoded) sheets match none and stay blocked as before.
  return [...base, NORMALIZER_TEMPLATE];
}

/** The keys of the DEDICATED coded templates a distributor has — the unified Normalizer fallback,
 *  which applies to every code, excluded. Empty means "no template of its own": a coded sheet for
 *  that distributor still validates, but under the generic "Normalized coded sheet" rather than its
 *  own named one. Read by tests/sales-profiles.test.ts to pin the three Ibn Sina feeds. */
export function dedicatedCodedTemplateKeys(distributorCode: string): string[] {
  const code = normalizeCode(distributorCode);
  return DISTRIBUTOR_SALES_TEMPLATES.filter((template) =>
    template.distributorCodes.map(normalizeCode).includes(code),
  ).map((template) => template.key);
}

function aliasList(spec: FieldSpec | undefined): string[] {
  if (spec === undefined) return [];
  return Array.isArray(spec) ? spec : [spec];
}

// ── Coded "system" channels (Direct) ───────────────────────────────────────────────────────────
// Direct (company) sales arrive ALREADY coded — the operator fills Product ID / Region ID / Distrub ID
// by hand — and are region-only with the sale value taken straight from the sheet. They have a
// dedicated coded template but NO raw normalizer profile, so the Sales Upload hub routes them through
// this coded importer instead of the raw recognizer (which rejects coded sheets). These helpers let the
// distributor registry / upload hub treat such a channel as monthly-uploadable and show a profile
// summary without inventing a fake raw profile. Discriminator: a coded template with regionOnly = true.
const CODED_SYSTEM_CHANNEL_DEFS = DISTRIBUTOR_SALES_TEMPLATES.filter((t) => t.regionOnly === true);

export function isCodedSystemChannel(distributorCode: string): boolean {
  const code = normalizeCode(distributorCode);
  return CODED_SYSTEM_CHANNEL_DEFS.some((t) => t.distributorCodes.map(normalizeCode).includes(code));
}

export type CodedSystemChannelSummary = {
  productColumns: string[];
  quantityColumns: string[];
  dateColumns: string[];
  customerNameColumns: string[];
  territoryColumns: string[];
  valueSource: "recompute" | "sheet";
  hasDateColumn: boolean;
  regionOnly: boolean;
};

// Project the coded template into the read-only "what the system reads" column view (the profile
// viewer on the upload hub). Returns null for a normal distributor (handled by its raw profile).
export function codedSystemChannelSummary(distributorCode: string): CodedSystemChannelSummary | null {
  const code = normalizeCode(distributorCode);
  const def = CODED_SYSTEM_CHANNEL_DEFS.find((t) => t.distributorCodes.map(normalizeCode).includes(code));
  if (!def) return null;
  const dateCols = aliasList(def.fields.invoiceDate);
  return {
    productColumns: [...aliasList(def.fields.productCode), ...(def.optionalFields?.productName ?? [])],
    quantityColumns: aliasList(def.fields.qty),
    dateColumns: dateCols,
    customerNameColumns: def.customerFields?.name ?? [],
    territoryColumns: aliasList(def.fields.regionCode),
    valueSource: def.valueField ? "sheet" : "recompute",
    hasDateColumn: dateCols.length > 0,
    regionOnly: Boolean(def.regionOnly),
  };
}

function findHeaderMap(sheet: ExcelJS.Worksheet, def: DistributorSalesTemplateDef): HeaderMap | null {
  const maxHeaderRow = Math.min(sheet.rowCount, 10);
  const fieldEntries = Object.entries(def.fields) as Array<[DistributorSalesTemplateField, FieldSpec]>;

  for (let rowNumber = 1; rowNumber <= maxHeaderRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const columns = new Map<string, number>();
    const labels = new Map<string, string>();
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const rawHeader = normalizeDisplay(cellValue(cell));
      const header = normalizeKey(rawHeader);
      if (header) {
        columns.set(header, columnNumber);
        labels.set(header, rawHeader);
      }
    });

    // Resolve every required field to the FIRST alias header present in this row. Hybrid sheets keep
    // distributor-raw qty/date/brick names (e.g. QTY_INVOICE, INVOICE_DATE, Brick ID2), so a coded
    // sheet still matches its template and is read from its own coded columns — no silent fallback to
    // the normalizer (which would re-code from raw text and drop unmapped rows, undercounting totals).
    const resolvedFields: Partial<Record<DistributorSalesTemplateField, string>> = {};
    let matched = true;
    for (const [field, spec] of fieldEntries) {
      const present = aliasList(spec).find((header) => columns.has(normalizeKey(header)));
      if (!present) {
        matched = false;
        break;
      }
      resolvedFields[field] = present;
    }
    if (!matched) continue;

    const resolvedTemplate: DistributorSalesTemplate = {
      bonusField: def.bonusField,
      bonusFlagField: def.bonusFlagField,
      customerFields: def.customerFields,
      discountField: def.discountField,
      distributorCodes: def.distributorCodes,
      fields: resolvedFields as DistributorSalesTemplate["fields"],
      key: def.key,
      name: def.name,
      optionalFields: def.optionalFields,
      regionOnly: def.regionOnly,
      valueField: def.valueField,
    };
    return { columns, labels, rowNumber, template: resolvedTemplate };
  }

  return null;
}

function findSalesSheet(workbook: ExcelJS.Workbook, distributorCode: string) {
  const templates = templateForDistributor(distributorCode);
  for (const template of templates) {
    for (const sheet of workbook.worksheets) {
      const headerMap = findHeaderMap(sheet, template);
      if (headerMap) return { sheet, headerMap };
    }
  }
  return null;
}

function requiredTemplateMessage(distributorCode: string) {
  return templateForDistributor(distributorCode)
    .map((template) => {
      const headers = Object.values(template.fields).map((spec) => aliasList(spec)[0] ?? "");
      return `${template.name}: ${headers.join(", ")}`;
    })
    .join(" | ");
}

function valueAtHeader(row: ExcelJS.Row, headerMap: HeaderMap, header: string | null | undefined) {
  if (!header) return null;
  const column = headerMap.columns.get(normalizeKey(header));
  return column ? cellValue(row.getCell(column)) : null;
}

function valueAt(row: ExcelJS.Row, headerMap: HeaderMap, field: DistributorSalesTemplateField) {
  return valueAtHeader(row, headerMap, headerMap.template.fields[field]);
}

function optionalValueAt(row: ExcelJS.Row, headerMap: HeaderMap, field: OptionalTemplateField) {
  const headers = headerMap.template.optionalFields?.[field] ?? [];
  for (const header of headers) {
    const value = valueAtHeader(row, headerMap, header);
    if (normalizeDisplay(value)) return value;
  }
  return null;
}

// Reads a customer field (code / name / address) by walking the template's header
// fallbacks; returns the first non-empty display value, or null. Never affects validation.
function customerValueAt(row: ExcelJS.Row, headerMap: HeaderMap, field: "address" | "code" | "name") {
  const headers = headerMap.template.customerFields?.[field] ?? [];
  for (const header of headers) {
    const normalized = normalizeDisplay(valueAtHeader(row, headerMap, header));
    if (normalized) return normalized;
  }
  return null;
}

function hasAnyImportValue(row: ExcelJS.Row, headerMap: HeaderMap) {
  return requiredHeadersForTemplate(headerMap.template).some(
    (header) => normalizeDisplay(valueAtHeader(row, headerMap, header)) !== "",
  );
}

function rawImportRow(row: ExcelJS.Row, headerMap: HeaderMap) {
  return Object.fromEntries(
    [...headerMap.columns.entries()].map(([key, column]) => [
      headerMap.labels.get(key) ?? key,
      normalizeDisplay(cellValue(row.getCell(column))),
    ]),
  );
}

// A cell Excel stores as a number is taken as it is. Text goes through normalizeNumberText first, so a
// form with one meaning only is read ("1.234,56" is 1234.56, "١٢٠" is 120), and a comma is dropped only
// where it separates whole groups of three ("1,200"). Anywhere else ("12,5": 12.5 or 125?) the text is
// unreadable. This used to strip every comma blind, so "1.234,56" was read as 1.23456 and "12,5" as 125,
// with nothing said (owner, 2026-09-18) — the defect the Normalizer's engine had in its parseNum.
function parseNumber(value: unknown, options?: { emptyAsZero?: boolean }) {
  const text = normalizeDisplay(value);
  if (!text && options?.emptyAsZero) return 0;
  if (!text) return Number.NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const written = normalizeNumberText(text);
  if (misplacedComma(written)) return Number.NaN;
  const parsed = Number(written.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

// A quantity or value cell of a sales sheet, read by parseNumber with one rule more: a TEXT cell with
// two readings is refused and named, not guessed at — "1.234" (1.234 or 1234?) as well as "12,5". A
// cell Excel stores as a number is never refused: 1.234 is 1.234 however it prints. The Direct channel
// follows the same rule (owner, 2026-09-18: refuse it like the distributors), and so does the
// Normalizer's engine (needsAGuess there). `readFrom` keeps a cell that was read only after
// normalizeNumberText rewrote it, so the row says what it read.
type SheetNumber = { value: number; problem: string | null; readFrom: string | null };

function readSheetNumber(raw: unknown, options?: { emptyAsZero?: boolean }): SheetNumber {
  const value = parseNumber(raw, options);
  const text = normalizeDisplay(raw);
  if (!text || typeof raw === "number") return { value, problem: null, readFrom: null };
  const written = normalizeNumberText(text);
  if (needsAGuess(written)) return { value: Number.NaN, problem: numberProblem(written), readFrom: null };
  return { value, problem: null, readFrom: Number.isFinite(value) && written !== text ? text : null };
}

// "Qty "12,5" could mean 12.5 or 125, so it is not guessed." when the cell was refused for a guess;
// the message the row has always carried otherwise.
function unreadableCellMessage(label: string, raw: unknown, cell: SheetNumber, fallback: string): string {
  return cell.problem ? `${label} "${normalizeDisplay(raw)}" ${cell.problem}.` : fallback;
}

function readAsMessage(label: string, cell: SheetNumber): string {
  return `${label} "${cell.readFrom}" was read as ${cell.value.toLocaleString("en-US", { maximumFractionDigits: 6 })}.`;
}

// A product's Source Row Number. A comma counts only between whole groups of three ("1,200"): "1,2" was
// read as row 12 with its comma dropped, and is refused now like any other unreadable row number.
function parseOptionalInteger(value: unknown) {
  const text = normalizeDisplay(value);
  if (!text) return null;
  const written = normalizeNumberText(text);
  if (misplacedComma(written)) return Number.NaN;
  const parsed = Number(written.replace(/,/g, ""));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

// Reads a per-row discount and returns it as a fraction (0.25 for 25%), CLAMPED to [0, 1], plus a
// flag when the raw cell was out of that range. Blank/0/non-numeric => 0 (no discount). Excel stores
// "25%" as 0.25, so any value with magnitude <= 1 is already a fraction; a whole number (e.g. 25) is
// treated as a percent. The sheet Value/Net column is never read.
//
// The clamp is a correctness guard: value = Qty x factory_price x (1 - rate). Without it a discount
// cell like "150" (a data-entry typo) parses to 1.5, and (1 - 1.5) = -0.5 silently produces a
// NEGATIVE row value; a negative cell like "-25" would instead INFLATE it (1 - (-0.25) = 1.25). A
// real discount can be neither negative (a surcharge) nor over 100% (free/negative price), so we
// clamp to [0, 1] and surface a warning at the call site so the bad cell is visible, not silent.
//
// The cell goes through normalizeNumberText like a quantity, so "12,5٪" or "1.234,56" is not read with
// its comma dropped. A comma anywhere but between whole groups of three leaves the cell unreadable, which
// here means no discount, exactly as for "abc": since 2026-09-07 a discount multiplies nothing, so it
// gets no new refusal (owner, 2026-09-18).
export function parseDiscount(value: unknown): { rate: number; outOfRange: boolean } {
  const written = normalizeNumberText(normalizeDisplay(value)).replace(/%/g, "");
  if (misplacedComma(written)) return { rate: 0, outOfRange: false };
  const text = written.replace(/,/g, "");
  if (!text) return { rate: 0, outOfRange: false };
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed === 0) return { rate: 0, outOfRange: false };
  const fraction = Math.abs(parsed) > 1 ? parsed / 100 : parsed;
  const rate = Math.min(1, Math.max(0, fraction));
  return { rate, outOfRange: rate !== fraction };
}

function requireSourceOfSalesProductField(
  input: SourceOfSalesProductInput,
  key: keyof SourceOfSalesProductInput,
  label: string,
) {
  const value = normalizeDisplay(input[key]);
  if (!value) {
    throw new SalesWorkflowError(
      "invalid_product_reference",
      `${label} is required.`,
      400,
      { field: key },
    );
  }
  return value;
}

export function normalizeSourceOfSalesProductInput(
  input: SourceOfSalesProductInput,
): NormalizedSourceOfSalesProductInput {
  const productCode = normalizeCode(requireSourceOfSalesProductField(input, "productCode", "Product Code"));
  const productName = requireSourceOfSalesProductField(input, "productName", "Product Name");
  const family = requireSourceOfSalesProductField(input, "family", "Family");
  const familyCode = normalizeCode(requireSourceOfSalesProductField(input, "familyCode", "Family Code"));
  const source = requireSourceOfSalesProductField(input, "source", "Source");
  const line = requireSourceOfSalesProductField(input, "line", "Line");
  const factoryPrice = parseNumber(input.factoryPrice);
  const sourceRowNumber = parseOptionalInteger(input.sourceRowNumber);

  if (!Number.isFinite(factoryPrice) || factoryPrice < 0) {
    throw new SalesWorkflowError(
      "invalid_product_reference",
      "Factory Price must be a non-negative number.",
      400,
      { field: "factoryPrice" },
    );
  }

  if (Number.isNaN(sourceRowNumber)) {
    throw new SalesWorkflowError(
      "invalid_product_reference",
      "Source Row Number must be a positive whole number.",
      400,
      { field: "sourceRowNumber" },
    );
  }

  return {
    active: input.active ?? true,
    factoryPrice,
    family,
    familyCode,
    line,
    normalizedLine: normalizeKey(line),
    normalizedProductName: normalizeKey(productName),
    productCode,
    productName,
    source,
    sourceFile: normalizeOptionalDisplay(input.sourceFile, "Manual Entry"),
    sourceRowNumber,
    sourceSheet: normalizeOptionalDisplay(input.sourceSheet, "Products"),
  };
}

function excelSerialToDate(serial: number) {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
}

function periodFromYearMonth(year: number, month: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

// Derives the YYYY-MM invoice period without timezone drift. Excel date objects
// and serial numbers are normalized to UTC midnight (read with UTC getters), while
// text dates are parsed directly from their civil components — never via
// `new Date(text)`, which interprets slash dates as *local* midnight and would roll
// day-1 invoices back to the previous month on any host ahead of UTC.
function invoicePeriod(value: unknown, dayFirst?: boolean) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return periodFromYearMonth(value.getUTCFullYear(), value.getUTCMonth() + 1);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = excelSerialToDate(value);
    return periodFromYearMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);
  }

  const text = normalizeDisplay(value);
  if (!text) return null;

  // ISO-like: YYYY-MM-DD (or YYYY/MM/DD). Year and month are unambiguous.
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?/);
  if (iso) return periodFromYearMonth(Number(iso[1]), Number(iso[2]));

  // Day/Month/Year or Month/Day/Year with a separator. Orientation is ambiguous per-row when both
  // parts are 1..12, so the caller passes `dayFirst` detected ONCE across the whole column (see
  // detectDateColumnDayFirst): Sofico's BILLINGDATE is DD-MM-YYYY, while distributor US exports are
  // MM-DD-YYYY. When the column orientation is unknown we keep the legacy >12 rule + month-first guess.
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmy) {
    const first = Number(dmy[1]);
    const second = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    let month: number;
    if (dayFirst === true) month = second >= 1 && second <= 12 ? second : first;     // DD-MM-YYYY → month is the 2nd part
    else if (dayFirst === false) month = first >= 1 && first <= 12 ? first : second; // MM-DD-YYYY → month is the 1st part
    else if (first > 12 && second <= 12) month = second;                            // unknown column: decisive day in 1st part
    else if (second > 12 && first <= 12) month = first;                             // unknown column: decisive day in 2nd part
    else month = first;                                                             // unknown + ambiguous: legacy month-first guess
    return periodFromYearMonth(year, month);
  }

  // Last resort: native parse, read in UTC for consistency with the date paths above.
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return periodFromYearMonth(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1);
}

function isoFromYmd(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  // Reject impossible civil dates (e.g. Feb 30) via UTC round-trip.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Resolves the row's full DAY-level invoice date (ISO YYYY-MM-DD) for daily analytics. Runs
// BESIDE invoicePeriod() — never replaces it — and is guarded by it: a candidate date is accepted
// ONLY when its YYYY-MM equals the row's derived period, so a slash-date m/d-vs-d/m ambiguity
// can never land in the wrong month; it resolves to null and the
// row simply stays "undated" in day-grain views. When the column orientation is unknown and a
// value is ambiguous, BOTH orientations are tried and the period match picks the right one.
export function resolveInvoiceDate(
  value: unknown,
  dayFirst: boolean | undefined,
  period: string | null,
): string | null {
  const guard = (iso: string | null) => (iso && period && iso.slice(0, 7) === period ? iso : null);
  if (!period) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return guard(isoFromYmd(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = excelSerialToDate(value);
    return guard(isoFromYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()));
  }

  const text = normalizeDisplay(value);
  if (!text) return null;

  // ISO-like: YYYY-MM-DD (or YYYY/MM/DD) — unambiguous.
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) return guard(isoFromYmd(Number(iso[1]), Number(iso[2]), Number(iso[3])));

  // D/M/Y or M/D/Y with a separator.
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmy) {
    const first = Number(dmy[1]);
    const second = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    const asDayFirst = guard(isoFromYmd(year, second, first));   // DD-MM-YYYY
    const asMonthFirst = guard(isoFromYmd(year, first, second)); // MM-DD-YYYY
    if (dayFirst === true) return asDayFirst;
    if (dayFirst === false) return asMonthFirst;
    // Unknown column orientation: the period guard arbitrates. When both survive it,
    // day == month and they are the same date.
    return asDayFirst ?? asMonthFirst;
  }

  // Last resort: native parse, read in UTC (handles JS Date.toString text).
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return guard(isoFromYmd(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate()));
}

// Decide a TEXT date column's orientation (DD-MM vs MM-DD) by scanning all its values, so every row
// parses consistently. A value whose 1st part is > 12 can only be a day → day-first (decisive). A
// value whose 2nd part is > 12 (1st <= 12) can only be a day there → month-first. Excel-native Date
// objects / serials are unambiguous and skipped. Returns undefined when every value is ambiguous
// (all parts 1..12), leaving invoicePeriod on its legacy best-guess. Mirrors the normalizer engine.
function detectDateColumnDayFirst(values: unknown[]): boolean | undefined {
  let sawMonthFirst = false;
  for (const value of values) {
    if (value instanceof Date || typeof value === "number") continue;
    const m = normalizeDisplay(value).match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!m) continue;
    if (Number(m[1]) > 12) return true;           // 1st part is a day → day-first (decisive)
    if (Number(m[2]) > 12) sawMonthFirst = true;  // 2nd part is a day → month-first
  }
  return sawMonthFirst ? false : undefined;
}

/**
 * Source-of-Sales region codes that are AMBIGUOUS for a line's Direct channel.
 *
 * A Direct row carries a region but never an area, so its District Manager is resolved from the
 * region alone (au.f_monthly_achievement's region_dm lookup). That works only while the region
 * maps to ONE DM territory. Anti Infective splits Upper Egypt into UE-1 and UE-2, so a Direct row
 * tagged plain "UE" belongs to two managers at once and therefore reaches neither.
 *
 * Not hypothetical: 3,110 units / 208,652.40 EGP accumulated exactly that way over six months.
 * 19 rows were recoverable from a place name buried in the customer text; the remaining 16 — five
 * with no customer name at all — had to be split by an owner-set 1:2 territory rule
 * (au.direct_region_allocation) because nothing in the row said where they belonged. Blocking at
 * upload is what stops it recurring.
 *
 * Deliberately per-LINE, not global: CNS and Pedia have a single Upper Egypt region with one DM,
 * so "UE" is unambiguous for them and must keep importing normally.
 */
const AMBIGUOUS_DIRECT_REGIONS: ReadonlyArray<{
  choices: string;
  detail: string;
  /** Normalised official line. Matched against the PRODUCT's line — where the line is resolved. */
  lineKey: string;
  lineLabel: string;
  regionCode: string;
}> = [
  {
    choices: "UE-1 or UE-2",
    detail:
      "UE-1 covers Minia 1, Minia 2 and Fayoum-Beni Suef; UE-2 covers Assuit 1/2, Sohag 1/2 and Qena 1/2.",
    lineKey: "anti infective",
    lineLabel: "Anti Infective",
    regionCode: "UE",
  },
];

/**
 * The ambiguity rule matching a Direct row, or null when the (line, region) pair is unambiguous.
 * Pure — exported so the rule can be unit-tested without building a workbook.
 */
export function ambiguousDirectRegion(
  officialLine: string | null | undefined,
  regionCode: string | null | undefined,
): (typeof AMBIGUOUS_DIRECT_REGIONS)[number] | null {
  const line = String(officialLine ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const region = String(regionCode ?? "").trim().toUpperCase();
  if (!line || !region) return null;
  return AMBIGUOUS_DIRECT_REGIONS.find((rule) => rule.lineKey === line && rule.regionCode === region) ?? null;
}

function addIssue(
  issues: DistributorSalesValidationIssue[],
  rowNumber: number,
  field: string,
  value: unknown,
  message: string,
  severity: "failure" | "warning" = "failure",
) {
  const issue = {
    field,
    message,
    rowNumber,
    severity,
    value: normalizeDisplay(value) || null,
  };
  issues.push(issue);
  return issue;
}

function validationStateForIssues(issues: DistributorSalesValidationIssue[]): ParsedDistributorRow["validationState"] {
  if (issues.some((issue) => issue.severity === "failure")) return "failed";
  if (issues.length > 0) return "warning";
  return "valid";
}

function addTotals<T extends DistributorSalesTotal>(current: T, row: ParsedDistributorRow) {
  current.rowCount += 1;
  current.totalQty += Number.isFinite(row.qty) ? row.qty : 0;
  current.totalBonusQty += Number.isFinite(row.bonusQty) ? row.bonusQty : 0;
  current.totalValue += Number.isFinite(row.value) ? row.value : 0;
}

function emptyTotals(): DistributorSalesTotal {
  return {
    rowCount: 0,
    totalBonusQty: 0,
    totalQty: 0,
    totalValue: 0,
  };
}

function roundedTotals<T extends DistributorSalesTotal>(row: T): T {
  return {
    ...row,
    totalBonusQty: Number(row.totalBonusQty.toFixed(6)),
    totalQty: Number(row.totalQty.toFixed(6)),
    totalValue: Number(row.totalValue.toFixed(6)),
  };
}

export function summarizeRows(rows: ParsedDistributorRow[]) {
  const totals = emptyTotals();
  const areaMap = new Map<string, DistributorSalesAreaSummary>();
  const brickMap = new Map<string, DistributorSalesBrickSummary>();
  const lineMap = new Map<string, DistributorSalesLineSummary>();
  const regionMap = new Map<string, DistributorSalesRegionSummary>();
  const productMap = new Map<string, DistributorSalesProductSummary>();

  rows.forEach((row) => {
    addTotals(totals, row);

    const line = row.officialLine || "";
    const lineSummary = lineMap.get(line) ?? { ...emptyTotals(), line };
    addTotals(lineSummary, row);
    lineMap.set(line, lineSummary);

    const regionKey = `${row.regionName}\u0000${row.regionCode}`;
    const regionSummary = regionMap.get(regionKey) ?? {
      ...emptyTotals(),
      regionCode: row.regionCode || "",
      regionName: row.regionName || "",
    };
    addTotals(regionSummary, row);
    regionMap.set(regionKey, regionSummary);

    const areaKey = `${row.areaCode}\u0000${row.areaName}\u0000${row.regionCode}`;
    const areaSummary = areaMap.get(areaKey) ?? {
      ...emptyTotals(),
      areaCode: row.areaCode || "",
      areaName: row.areaName || "",
      regionCode: row.regionCode || "",
      regionName: row.regionName || "",
    };
    addTotals(areaSummary, row);
    areaMap.set(areaKey, areaSummary);

    const brickKey = `${row.brickId}\u0000${row.blockCode}\u0000${row.areaCode}\u0000${row.regionCode}`;
    const brickSummary = brickMap.get(brickKey) ?? {
      ...emptyTotals(),
      areaCode: row.areaCode || "",
      areaName: row.areaName || "",
      blockCode: row.blockCode || "",
      blockName: row.blockName || "",
      brickId: row.brickId || "",
      brickName: row.brickName || "",
      regionCode: row.regionCode || "",
      regionName: row.regionName || "",
    };
    addTotals(brickSummary, row);
    brickMap.set(brickKey, brickSummary);

    const productKey = `${row.productName}\u0000${row.productCode}\u0000${line}`;
    const productSummary = productMap.get(productKey) ?? {
      ...emptyTotals(),
      officialLine: line,
      productCode: row.productCode || "",
      productName: row.productName || "",
    };
    addTotals(productSummary, row);
    productMap.set(productKey, productSummary);
  });

  return {
    totals: roundedTotals(totals),
    byArea: [...areaMap.values()]
      .map(roundedTotals)
      .sort((left, right) => left.regionCode.localeCompare(right.regionCode) || left.areaCode.localeCompare(right.areaCode)),
    byBrick: [...brickMap.values()]
      .map(roundedTotals)
      .sort((left, right) => left.regionCode.localeCompare(right.regionCode) || left.areaCode.localeCompare(right.areaCode) || left.brickId.localeCompare(right.brickId)),
    byLine: [...lineMap.values()]
      .map(roundedTotals)
      .sort((left, right) => left.line.localeCompare(right.line)),
    byRegion: [...regionMap.values()]
      .map(roundedTotals)
      .sort((left, right) => left.regionCode.localeCompare(right.regionCode) || left.regionName.localeCompare(right.regionName)),
    byProduct: [...productMap.values()]
      .map(roundedTotals)
      .sort((left, right) => right.totalValue - left.totalValue || left.productName.localeCompare(right.productName)),
  };
}

function buildReferenceMaps(references: SalesReferenceData) {
  const areas = references.areas ?? references.regions;
  const regionReferences = new Map<string, SalesRegionReference>();
  for (const row of [...references.regions, ...areas]) {
    const regionCode = normalizeCode(row.regionCode);
    if (regionCode && !regionReferences.has(regionCode)) {
      regionReferences.set(regionCode, {
        regionCode,
        regionName: normalizeDisplay(row.regionName),
      });
    }
  }

  return {
    areaByCode: new Map(areas.map((row) => [normalizeCode(row.areaCode), row])),
    // Area codes that actually OWN a brick in the master. A sheet may type an area that owns none
    // — "OTMS" (Main Store) is a distributor warehouse bucket, not a territory: it has no brick, no
    // rep, no target, and no row in au.sos_area_crosswalk. Since no brick can sit inside such an
    // area, the cross-area guard in the customer-map auto-fill has nothing to protect there; see
    // the comment at that guard for why treating it as a real area sent 109 customers nowhere.
    areaCodesWithBricks: new Set(
      (references.bricks ?? [])
        .map((row) => normalizeCode(row.areaCode))
        .filter((code) => code !== ""),
    ),
    blockByCode: new Map((references.blocks ?? []).map((row) => [normalizeCode(row.blockCode), row])),
    brickById: new Map((references.bricks ?? []).map((row) => [normalizeCode(row.brickId), row])),
    // (distributor code + customer code) -> brick id, for the customer-map brick fallback.
    // Only entries with a non-empty brick are kept.
    customerBrickByKey: new Map(
      (references.customerBricks ?? [])
        .map((row) => [
          `${normalizeCode(row.distributorCode)} ${normalizeCode(row.customerCode)}`,
          normalizeCode(row.brickId),
        ] as const)
        .filter(([, brick]) => brick !== ""),
    ),
    distributorByCode: new Map(references.distributors.map((row) => [normalizeCode(row.code), row])),
    productByCode: new Map(references.products.map((row) => [normalizeCode(row.productCode), row])),
    // The price of each of THOSE products in a given month — see SalesReferenceData's overrides.
    prices: productPeriodPricesFromRows(references.products, references.productPriceOverrides ?? []),
    regionByCode: regionReferences,
  };
}

async function workbookFromBuffer(buffer: ArrayBuffer | Buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new SalesWorkflowError(
      "invalid_workbook",
      "The uploaded workbook could not be read. Please use a valid .xlsx file.",
      400,
    );
  }
  return workbook;
}

async function parseDistributorSalesWorkbookBuffer(input: {
  buffer: ArrayBuffer | Buffer;
  distributorCode: string;
  fileName: string;
  references: SalesReferenceData;
  periodOverride?: string;
}): Promise<DistributorSalesValidationResult & { parsedRows: ParsedDistributorRow[] }> {
  const selectedDistributorCode = normalizeCode(input.distributorCode);
  // Optional period (YYYY-MM) the user picks when a sheet has no date column (e.g. Chimipharm). It is
  // applied only to rows whose own date can't be resolved — sheets that DO carry dates still auto-detect.
  const periodOverride = /^\d{4}-\d{2}$/.test(String(input.periodOverride ?? "").trim())
    ? String(input.periodOverride).trim()
    : "";
  const maps = buildReferenceMaps(input.references);
  const distributor = maps.distributorByCode.get(selectedDistributorCode);

  if (!distributor) {
    throw new SalesWorkflowError(
      "unknown_distributor",
      `Distributor code ${selectedDistributorCode || "(empty)"} is not in the distributor source-of-truth table.`,
      400,
    );
  }

  const workbook = await workbookFromBuffer(input.buffer);
  const detected = findSalesSheet(workbook, selectedDistributorCode);
  if (!detected) {
    throw new SalesWorkflowError(
      "unsupported_distributor_template",
      `This workbook does not match the selected distributor template. Required headers: ${requiredTemplateMessage(selectedDistributorCode)}.`,
      400,
    );
  }

  const { sheet, headerMap } = detected;
  const issues: DistributorSalesValidationIssue[] = [];
  const rows: ParsedDistributorRow[] = [];

  // Detect the invoice-date column's DD-MM vs MM-DD orientation ONCE for the whole sheet, so days
  // 1..12 are not misread as months (which made a single-month Sofico sheet look like it spanned 12
  // months and blocked the upload). Native Excel dates are unambiguous and ignored by the detector.
  const invoiceDateValues: unknown[] = [];
  for (let rowNumber = headerMap.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!hasAnyImportValue(row, headerMap)) continue;
    invoiceDateValues.push(valueAt(row, headerMap, "invoiceDate"));
  }
  const invoiceDateDayFirst = detectDateColumnDayFirst(invoiceDateValues);

  for (let rowNumber = headerMap.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!hasAnyImportValue(row, headerMap)) continue;
    const rowIssues: DistributorSalesValidationIssue[] = [];

    let rawAreaCode = valueAt(row, headerMap, "areaCode");
    const rawAreaName = optionalValueAt(row, headerMap, "areaName");
    let rawBrickId = valueAt(row, headerMap, "brickId");
    const rawBrickName = optionalValueAt(row, headerMap, "brickName");
    let rawRegionCode = valueAt(row, headerMap, "regionCode");
    const rawRegionName = optionalValueAt(row, headerMap, "regionName");
    const rawProductCode = valueAt(row, headerMap, "productCode");
    const rawProductName = optionalValueAt(row, headerMap, "productName");
    const rawQty = valueAt(row, headerMap, "qty");
    const rawDiscount = valueAtHeader(row, headerMap, headerMap.template.discountField);
    const rawDistributorCode = valueAt(row, headerMap, "distributorCode");
    const rawInvoiceDate = valueAt(row, headerMap, "invoiceDate");

    const clientCode = customerValueAt(row, headerMap, "code");
    const clientName = customerValueAt(row, headerMap, "name");
    const clientAddress = customerValueAt(row, headerMap, "address");

    // Probe for invoice/document number using common column aliases. Used only for duplicate
    // detection — not stored in the DB. Stays null when no matching column exists in the sheet.
    const rawInvoiceNumber = INVOICE_NUMBER_HEADER_ALIASES
      .reduce<unknown>((found, alias) => found ?? valueAtHeader(row, headerMap, alias), null);
    const invoiceNumber = rawInvoiceNumber != null ? (normalizeDisplay(rawInvoiceNumber) || null) : null;

    // Auto-fill Brick (and derived Area/Region) from the customer map when the coded sheet leaves
    // the brick blank or #N/A — keyed by distributor + customer code. This lets a raw export or a
    // raw+coded ("hybrid") sheet validate without hand-filled bricks. A valid typed brick is left
    // untouched, and a customer with no mapping still fails the brick checks below (surfacing in
    // "Rows To Fix"). Skipped for region-only channels (Direct), which carry no brick/area.
    if (
      !headerMap.template.regionOnly
      && (normalizeCode(rawBrickId) === "" || isNotAvailable(rawBrickId))
      && normalizeCode(clientCode) !== ""
    ) {
      const mappedBrickId = maps.customerBrickByKey.get(`${selectedDistributorCode} ${normalizeCode(clientCode)}`);
      const mappedBrick = mappedBrickId ? maps.brickById.get(mappedBrickId) : undefined;
      if (mappedBrick) {
        // Cross-area guard, mirroring resolveBrick in the normalizer: if the sheet already typed an
        // AREA, only accept a stored brick that sits INSIDE that area. Filling a blank brick from a
        // mapping that points at a DIFFERENT area would silently move the sale — and the rep's
        // numbers — across areas, which is exactly the unverified cross-area auto-apply the
        // normalizer forbids. When the sheet gave no area, there is nothing to cross, so the mapping
        // is taken in full (this is the common raw/hybrid case).
        const sheetArea = normalizeCode(rawAreaCode);
        const mappedArea = normalizeCode(mappedBrick.areaCode);
        // ...but only when the sheet typed a REAL territory. An area that owns no brick at all is a
        // warehouse bucket, not a place: "OTMS" (Main Store) is where a distributor parks a sale it
        // has not routed yet. No brick can ever sit inside it, so there is no cross-area move to
        // guard against — treat it exactly like a blank area and take the mapping in full. Without
        // this the guard fired on every Main Store row: 109 customers whose brick was already known
        // imported blank, and EGP 47,385 of 2026-07 CNS reached no rep at all.
        const sheetAreaIsNonTerritory = sheetArea !== "" && !maps.areaCodesWithBricks.has(sheetArea);
        const crossesArea = sheetArea !== ""
          && !sheetAreaIsNonTerritory
          && !isNotAvailable(rawAreaCode)
          && mappedArea !== sheetArea;
        if (!crossesArea) {
          rawBrickId = mappedBrick.brickId;
          // A non-territory area/region is overwritten as well as a blank one — leaving the row on
          // "OTMS" while its brick sits in OT5 would be a hierarchy that contradicts itself. The
          // blank-area case keeps its original rule: a typed region is respected.
          if (sheetArea === "" || isNotAvailable(rawAreaCode) || sheetAreaIsNonTerritory) {
            rawAreaCode = mappedBrick.areaCode;
          }
          if (normalizeCode(rawRegionCode) === "" || isNotAvailable(rawRegionCode) || sheetAreaIsNonTerritory) {
            rawRegionCode = mappedBrick.regionCode;
          }
        }
        // If it crosses the area, the brick stays blank and the row fails the brick checks below,
        // surfacing in "Rows To Fix" for a human to resolve — never silently re-homed.
      }
    }

    let areaCode = normalizeCode(rawAreaCode);
    const brickId = normalizeCode(rawBrickId);
    let regionCode = normalizeCode(rawRegionCode);
    const productCode = normalizeCode(rawProductCode);
    const rowDistributorCode = normalizeCode(rawDistributorCode);
    const qtyCell = readSheetNumber(rawQty);
    const parsedQty = qtyCell.value;
    // Whole-line bonus flag (e.g. is_bonus = 1 in EPDA exports): the row is a free-goods
    // delivery, not a sale. Skip it entirely — free units are never counted as sales qty.
    const rawBonusFlag = valueAtHeader(row, headerMap, headerMap.template.bonusFlagField);
    const isBonusRow = Boolean(headerMap.template.bonusFlagField)
      && ["1", "true", "yes", "y"].includes(normalizeDisplay(rawBonusFlag).toLowerCase());
    if (isBonusRow) continue;
    const bonusQty = 0;
    const qty = parsedQty;
    const { rate: discountRate, outOfRange: discountOutOfRange } = parseDiscount(rawDiscount);
    if (discountOutOfRange) {
      // Clamped to [0,1] above so row value can't go negative; warn (not fail) so a bad discount
      // cell is visible in validation rather than silently corrected.
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.discountField ?? "Discount",
        rawDiscount,
        `Discount is outside 0–100%; clamped to ${(discountRate * 100).toFixed(0)}%.`,
        "warning",
      );
    }
    let period = invoicePeriod(rawInvoiceDate, invoiceDateDayFirst);
    let invoiceDate = resolveInvoiceDate(rawInvoiceDate, invoiceDateDayFirst, period);
    // Sheet has no usable date for this row → fall back to the user-selected period (if any).
    if (!period && periodOverride) {
      period = periodOverride;
      invoiceDate = `${periodOverride}-01`;
    }

    // Direct (company) channel: the row value is read STRAIGHT from the sheet's value column
    // (real per-deal pricing), never recomputed from factory price. The row is flagged direct
    // so the closing/executive RPCs use the stored value and skip the factory recompute.
    const isDirect = Boolean(headerMap.template.valueField);
    const rawSheetValue = valueAtHeader(row, headerMap, headerMap.template.valueField);

    const productReference = !isNotAvailable(rawProductCode) ? maps.productByCode.get(productCode) : undefined;
    const brickReference = !isNotAvailable(rawBrickId) ? maps.brickById.get(brickId) : undefined;

    // The brick is the single source of truth for geography. When a row carries a brick that
    // exists in the master, its Region and Area ALWAYS come from the brick's master record;
    // the distributor sheet's own Region/Area columns are deliberately ignored (they often hold
    // the distributor's private territory labels — e.g. "BEHIRA 2" — which are not our regions).
    // Region-only channels (Direct) have no brick and keep their own sheet region.
    const geographyFromBrick = !headerMap.template.regionOnly && Boolean(brickReference);
    if (brickReference && geographyFromBrick) {
      areaCode = normalizeCode(brickReference.areaCode);
      regionCode = normalizeCode(brickReference.regionCode);
    }

    const regionReference = regionCode ? maps.regionByCode.get(regionCode) : undefined;
    const areaReference = areaCode ? maps.areaByCode.get(areaCode) : undefined;
    const blockReference = brickReference ? maps.blockByCode.get(normalizeCode(brickReference.blockCode)) : undefined;

    // Value is Qty times the product factory price. Nothing else touches it: bonus/free units are
    // neglected, the distributor sheet's own Value/Net column is ignored, and since 2026-09-07 the
    // per-row discount is ignored too — the owner struck that factor out of the whole system. The
    // Direct channel remains the one exception, the only sheet whose own Value column is truth.
    //
    // The price is the one OF THE ROW'S MONTH (`period`), never the master's flat price — the closing
    // prices every month through phx_factory_price(code, period), and Saginko is 111.15 through
    // 2026-09 and 170.52 from 2026-10 while the master stays 111.15. Stored at the flat price, an
    // October row would carry 111.15 into the Source of Sales dashboard, the import summaries and the
    // workbook's Sheet Value beside a closing at 170.52. A product the reference set does not hold is
    // still valued at 0, exactly as before.
    const valueCell = readSheetNumber(rawSheetValue, { emptyAsZero: true });
    const value = isDirect
      ? valueCell.value
      : Number.isFinite(qty)
        ? qty * (productReference ? (maps.prices.priceFor(productCode, period) ?? productReference.factoryPrice) : 0)
        : Number.NaN;

    // When geography is taken from the brick, the master Region/Area NAMES win too, so a stored
    // display name can never disagree with the master code that was just assigned.
    const regionName = (geographyFromBrick ? "" : normalizeDisplay(rawRegionName))
      || regionReference?.regionName
      || areaReference?.regionName
      || brickReference?.regionName
      || regionCode
      || "";
    const areaName = (geographyFromBrick ? "" : normalizeDisplay(rawAreaName))
      || areaReference?.areaName
      || brickReference?.areaName
      || areaCode
      || "";
    const blockCode = brickReference?.blockCode ?? "";
    const blockName = brickReference?.blockName
      || blockReference?.blockName
      || blockCode
      || "";
    const brickName = normalizeDisplay(rawBrickName)
      || brickReference?.brickName
      || brickId
      || "";
    const productName = productReference?.productName
      || normalizeDisplay(rawProductName)
      || productCode
      || "";

    // Region-only channels (Direct) carry no Area/Brick, so those are neither checked for
    // #N/A nor required. Region, product, distributor, date and qty are always required.
    const naFields: Array<[string, unknown]> = [
      [headerMap.template.fields.productCode, rawProductCode],
      [headerMap.template.fields.distributorCode, rawDistributorCode],
      [headerMap.template.fields.invoiceDate, rawInvoiceDate],
      [headerMap.template.fields.qty, rawQty],
    ];
    // When geography comes from the brick, the sheet's Region/Area columns are ignored entirely,
    // so a blank/#N/A in them is not a problem. Otherwise Region (and Area, when the template has
    // one) are still required and must not be #N/A.
    if (!geographyFromBrick) {
      naFields.push([headerMap.template.fields.regionCode, rawRegionCode]);
      if (headerMap.template.fields.areaCode) naFields.push([headerMap.template.fields.areaCode, rawAreaCode]);
    }
    if (headerMap.template.fields.brickId) naFields.push([headerMap.template.fields.brickId, rawBrickId]);

    naFields.forEach(([field, raw]) => {
      if (isNotAvailable(raw)) {
        addIssue(
          rowIssues,
          rowNumber,
          field,
          raw,
          `${field} is #N/A. Fix the workbook mapping before importing.`,
        );
      }
    });

    if (!headerMap.template.regionOnly) {
      if (!areaCode) addIssue(rowIssues, rowNumber, headerMap.template.fields.areaCode ?? "Area ID", rawAreaCode, "Area code is required.");
      if (!brickId) addIssue(rowIssues, rowNumber, headerMap.template.fields.brickId ?? "Brick ID", rawBrickId, "Brick ID is required.");
    }
    if (!regionCode) addIssue(rowIssues, rowNumber, headerMap.template.fields.regionCode, rawRegionCode, "Region code is required.");
    // A Direct row has no area, so its DM is resolved from the region alone. When that region
    // covers two DM territories the row reaches NEITHER manager — it is not a rounding problem,
    // the value simply lands nowhere. Blocking (severity defaults to "failure", which populates
    // blockingReasons and holds the batch at "blocked") is deliberate: the alternative is another
    // month of sales that can only ever be split by an assumption. Scoped to the Direct channel
    // and to the specific ambiguous (line, region) pairs, so every other upload is untouched.
    if (isDirect) {
      const ambiguous = ambiguousDirectRegion(productReference?.line, regionCode);
      if (ambiguous) {
        addIssue(
          rowIssues,
          rowNumber,
          headerMap.template.fields.regionCode,
          rawRegionCode,
          `${ambiguous.lineLabel} Direct sales cannot use region "${ambiguous.regionCode}" — it covers two district managers, ` +
            `so this row would reach neither. Use ${ambiguous.choices}. ${ambiguous.detail}`,
        );
      }
    }
    if (!productCode) addIssue(rowIssues, rowNumber, headerMap.template.fields.productCode, rawProductCode, "Product code is required.");
    if (!rowDistributorCode) addIssue(rowIssues, rowNumber, headerMap.template.fields.distributorCode, rawDistributorCode, "Distributor code is required.");
    if (rowDistributorCode && rowDistributorCode !== selectedDistributorCode) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.distributorCode,
        rawDistributorCode,
        `Distributor code must be ${selectedDistributorCode} for the selected distributor.`,
      );
    }
    // A text quantity with two readings ("12,5", "1.234") is refused by name; one read only after it was
    // rewritten ("1.234,56" as 1234.56) is listed, never blocking, so a person can still catch it.
    if (!Number.isFinite(qty)) {
      addIssue(rowIssues, rowNumber, headerMap.template.fields.qty, rawQty, unreadableCellMessage("Qty", rawQty, qtyCell, "Qty must be numeric."));
    } else if (qtyCell.readFrom) {
      addIssue(rowIssues, rowNumber, headerMap.template.fields.qty, rawQty, readAsMessage("Qty", qtyCell), "warning");
    }
    if (!period) addIssue(rowIssues, rowNumber, headerMap.template.fields.invoiceDate, rawInvoiceDate, "Invoice Date must be a valid date.");
    // Direct is the one channel whose VALUE comes straight from the sheet (see above), so it is the
    // one place an unreadable value cell can reach `value` unnoticed. For every other channel, value
    // is derived from qty * price and qty is already checked above — so this mirrors that check for
    // the one path it doesn't cover, rather than adding a new kind of guard.
    //
    // `parseNumber(x, { emptyAsZero: true })` returns 0 for an EMPTY cell (a legitimate zero) and
    // NaN for a NON-EMPTY cell that fails to parse — a currency symbol, a stray character, a typo.
    // Without this check that NaN reaches the DB insert unflagged and is silently zeroed there
    // (`value: Number.isFinite(row.value) ? row.value : 0`), so the row looks successfully imported
    // while its sale value has vanished.
    //
    // The same two-readings rule as the quantity above: a text value "1.234" or "12,5" is refused by name.
    if (isDirect && !Number.isFinite(value) && normalizeDisplay(rawSheetValue)) {
      addIssue(rowIssues, rowNumber, headerMap.template.valueField ?? "Value", rawSheetValue, unreadableCellMessage("Value", rawSheetValue, valueCell, "Value must be numeric."));
    } else if (isDirect && valueCell.readFrom) {
      addIssue(rowIssues, rowNumber, headerMap.template.valueField ?? "Value", rawSheetValue, readAsMessage("Value", valueCell), "warning");
    }

    if (productCode && !isNotAvailable(rawProductCode) && !productReference) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.productCode,
        rawProductCode,
        `Product Code ${productCode} is not in the product source-of-truth table.`,
      );
    }
    if (regionCode && !isNotAvailable(rawRegionCode) && !regionReference) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.regionCode,
        rawRegionCode,
        `Region Code ${regionCode} is not in the area/region source-of-truth table.`,
        "warning",
      );
    }
    if (areaCode && !isNotAvailable(rawAreaCode) && !areaReference) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.areaCode ?? "Area ID",
        rawAreaCode,
        `Area Code ${areaCode} is not in the area source-of-truth table. Uploaded code is kept for allocation.`,
        "warning",
      );
    }
    if (brickId && !isNotAvailable(rawBrickId) && !brickReference) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.brickId ?? "Brick ID",
        rawBrickId,
        `Brick ID ${brickId} is not in the brick source-of-truth table. Uploaded code is kept for allocation.`,
        "warning",
      );
    }
    if (regionReference && normalizeKey(regionName) !== normalizeKey(regionReference.regionName)) {
      addIssue(
        rowIssues,
        rowNumber,
        "Region Name",
        rawRegionName,
        `Region Name is different from the source table (${regionReference.regionName}) for Region Code ${regionCode}. Uploaded code is kept for allocation.`,
        "warning",
      );
    }
    if (areaReference && regionCode && normalizeCode(areaReference.regionCode) !== regionCode) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.areaCode ?? "Area ID",
        rawAreaCode,
        `Area Code ${areaCode} belongs to Region Code ${areaReference.regionCode} in the source table, but the upload says ${regionCode}. Uploaded hierarchy is kept.`,
        "warning",
      );
    }
    if (brickReference && areaCode && normalizeCode(brickReference.areaCode) !== areaCode) {
      addIssue(
        rowIssues,
        rowNumber,
        headerMap.template.fields.brickId ?? "Brick ID",
        rawBrickId,
        `Brick ID ${brickId} belongs to Area Code ${brickReference.areaCode} in the source table, but the upload says ${areaCode}. Uploaded hierarchy is kept.`,
        "warning",
      );
    }

    issues.push(...rowIssues);
    rows.push({
      areaCode: areaCode || normalizeDisplay(rawAreaCode),
      areaName,
      blockCode,
      blockName,
      bonusQty,
      brickId: brickId || normalizeDisplay(rawBrickId),
      brickName,
      clientAddress,
      clientCode,
      clientName,
      discount: discountRate,
      distributorCode: rowDistributorCode,
      isDirect,
      invoiceDate,
      invoiceNumber,
      invoicePeriod: period,
      officialLine: productReference?.line ?? "Unknown",
      productCode: productCode || normalizeDisplay(rawProductCode),
      productName,
      qty,
      regionCode: regionCode || normalizeDisplay(rawRegionCode),
      regionName,
      rowNumber,
      rawRow: rawImportRow(row, headerMap),
      validationIssues: rowIssues,
      validationState: validationStateForIssues(rowIssues),
      value,
    });
  }

  // Reused-code cross-area flag (advisory, non-blocking). A single distributor customer code should
  // belong to ONE territory. When a code's rows in this upload — together with the area it is already
  // pinned to in the customer map — resolve to more than one REAL area, the code is being shared by
  // pharmacies in different areas, and one side's sales are credited to the wrong territory. The audit
  // that motivated this (2026-09-22) found the hazard rare (2 codes system-wide) but it only ever
  // surfaces AFTER a month is published and locked, when it can no longer be corrected — so flag it at
  // import, as a WARNING, so a human resolves it before the period locks. Non-territory buckets (e.g.
  // "OTMS" Main Store) and blank areas are excluded: they are not places, so they cannot be a second
  // territory to cross — the same exclusion the customer-map cross-area guard uses above.
  {
    const isRealArea = (area: string) => {
      const code = normalizeCode(area);
      return code !== "" && maps.areaCodesWithBricks.has(code);
    };
    const realAreasByCode = new Map<string, Set<string>>();
    const addRealArea = (clientCode: string, area: string) => {
      if (!clientCode || !isRealArea(area)) return;
      let set = realAreasByCode.get(clientCode);
      if (!set) {
        set = new Set<string>();
        realAreasByCode.set(clientCode, set);
      }
      set.add(normalizeCode(area));
    };
    for (const row of rows) {
      const clientCode = normalizeCode(row.clientCode);
      if (!clientCode) continue;
      addRealArea(clientCode, row.areaCode);
      // Fold in the area this code is already pinned to in the customer map, so a code that DRIFTS from
      // its established territory across months is caught, not only one split within this single sheet.
      const mappedBrickId = maps.customerBrickByKey.get(`${selectedDistributorCode} ${clientCode}`);
      const mappedArea = mappedBrickId ? maps.brickById.get(mappedBrickId)?.areaCode : undefined;
      if (mappedArea) addRealArea(clientCode, mappedArea);
    }
    const areaLabel = (code: string) => {
      const name = maps.areaByCode.get(code)?.areaName;
      return name ? `${name} (${code})` : code;
    };
    for (const row of rows) {
      const clientCode = normalizeCode(row.clientCode);
      if (!clientCode) continue;
      if (!isRealArea(row.areaCode)) continue;
      const areaSet = realAreasByCode.get(clientCode);
      if (!areaSet || areaSet.size < 2) continue;
      const areaList = [...areaSet].sort().map(areaLabel).join(", ");
      const issue = addIssue(
        row.validationIssues,
        row.rowNumber,
        "Customer Code",
        row.clientCode,
        `Customer code ${clientCode} is used across ${areaSet.size} areas (${areaList}). One code should belong to a single territory — check it is not shared by pharmacies in different areas before this month is published.`,
        "warning",
      );
      issues.push(issue);
      row.validationState = validationStateForIssues(row.validationIssues);
    }
  }

  if (rows.length === 0) {
    throw new SalesWorkflowError("empty_sales_sheet", "No sales rows were found in this workbook.", 400);
  }

  const periods = [...new Set(rows.map((row) => row.invoicePeriod).filter(Boolean) as string[])].sort();
  const blockingReasons: string[] = [];
  const failureIssues = issues.filter((issue) => issue.severity === "failure");
  const warningRows = new Set(issues.filter((issue) => issue.severity === "warning").map((issue) => issue.rowNumber)).size;
  const failedRows = new Set(failureIssues.map((issue) => issue.rowNumber)).size;

  if (failureIssues.length > 0) {
    blockingReasons.push(
      `Fix ${failedRows} row${failedRows === 1 ? "" : "s"} before importing this distributor sales sheet.`,
    );
  }
  if (periods.length === 0) {
    blockingReasons.push("No invoice month found in this sheet — choose a Period (month) above, then upload again.");
  }
  if (periods.length > 1) {
    blockingReasons.push(`The sheet contains multiple invoice months: ${periods.join(", ")}.`);
  }

  // Guardrail (advisory, non-blocking): if the sheet's own distributor column consistently disagrees
  // with the selected distributor, surface it — a wrong dropdown pick would otherwise save a whole
  // month against the wrong company without any warning.
  const advisories: string[] = [];
  const fileDistribCounts = new Map<string, number>();
  for (const row of rows) {
    const code = normalizeCode(row.distributorCode);
    if (code) fileDistribCounts.set(code, (fileDistribCounts.get(code) ?? 0) + 1);
  }
  let dominantFileDistrib = "";
  let dominantCount = 0;
  for (const [code, count] of fileDistribCounts) {
    if (count > dominantCount) {
      dominantFileDistrib = code;
      dominantCount = count;
    }
  }
  if (dominantFileDistrib && dominantFileDistrib !== selectedDistributorCode) {
    advisories.push(
      `This file's distributor column says "${dominantFileDistrib}", but you selected "${distributor.name}" (${selectedDistributorCode}). Double-check you picked the right distributor before saving.`,
    );
  }

  return {
    ...summarizeRows(rows),
    advisories,
    blockingReasons,
    distributor,
    failedRows,
    fileName: input.fileName,
    importableRows: rows.length - failedRows,
    issues,
    period: periods.length === 1 ? periods[0] : null,
    rowCount: rows.length,
    sheetName: sheet.name,
    status: blockingReasons.length > 0 ? "blocked" : "validated",
    templateKey: headerMap.template.key,
    templateName: headerMap.template.name,
    warningRows,
    parsedRows: rows,
  };
}

export async function validateDistributorSalesWorkbookBuffer(input: {
  buffer: ArrayBuffer | Buffer;
  distributorCode: string;
  fileName: string;
  references: SalesReferenceData;
}): Promise<DistributorSalesValidationResult> {
  const parsed = await parseDistributorSalesWorkbookBuffer(input);

  return {
    advisories: parsed.advisories,
    batchId: parsed.batchId,
    blockingReasons: parsed.blockingReasons,
    byArea: parsed.byArea,
    byBrick: parsed.byBrick,
    byLine: parsed.byLine,
    byProduct: parsed.byProduct,
    byRegion: parsed.byRegion,
    createdAt: parsed.createdAt,
    distributor: parsed.distributor,
    failedRows: parsed.failedRows,
    fileName: parsed.fileName,
    importableRows: parsed.importableRows,
    issues: parsed.issues,
    period: parsed.period,
    rowCount: parsed.rowCount,
    sheetName: parsed.sheetName,
    status: parsed.status,
    templateKey: parsed.templateKey,
    templateName: parsed.templateName,
    totals: parsed.totals,
    warningRows: parsed.warningRows,
  };
}

/**
 * Page a reference master in full while preserving the `{ data, error }` shape the callers below
 * branch on (several tolerate an error as a schema-drift signal and fall back to a legacy table).
 */
async function selectAllReference<T = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
  tiebreakColumn: string,
): Promise<{ data: T[] | null; error: unknown }> {
  try {
    return { data: await fetchAllRows<T>(build, tiebreakColumn), error: null };
  } catch (error) {
    return { data: null, error };
  }
}

export async function loadSalesReferenceData(
  options?: { includeCustomerBricks?: boolean },
): Promise<SalesReferenceData> {
  const supabase = getSupabaseAdmin();
  // The customer -> brick crosswalk powers ONLY the import brick auto-fill (buildReferenceMaps), and
  // it is large: 69,217 active rows on 2026-09-15, paged 1000-at-a-time = 70 round-trips, ~3.5 s.
  // Every caller that needs only the name masters passes includeCustomerBricks:false to skip it;
  // tests/sales-reference-crosswalk-callers.test.ts pins those callers and the import loaders alike.
  const includeCustomerBricks = options?.includeCustomerBricks ?? true;
  // Paged past PostgREST's 1000-row cap; tolerant of errors (e.g. table absent pre-migration) so
  // a crosswalk failure never blocks a normal coded upload — it just disables the auto-fill.
  const customerBricksPromise = includeCustomerBricks
    ? (async () => {
        const collected: { brickId: string; customerCode: string; distributorCode: string }[] = [];
        const pageSize = 1000;
        let from = 0;
        for (;;) {
          const page = await supabase
            .from("source_of_sales_customer_map")
            .select("distributor_code,customer_code,brick_id")
            .eq("active", true)
            .order("distributor_code", { ascending: true })
            .order("customer_code", { ascending: true })
            .range(from, from + pageSize - 1);
          if (page.error) break;
          const data = page.data ?? [];
          for (const r of data) {
            const brickId = String(r.brick_id ?? "").trim();
            if (!brickId) continue;
            collected.push({
              brickId,
              customerCode: String(r.customer_code ?? ""),
              distributorCode: String(r.distributor_code ?? ""),
            });
          }
          if (data.length < pageSize) break;
          from += pageSize;
        }
        return collected;
      })()
    : Promise.resolve([] as { brickId: string; customerCode: string; distributorCode: string }[]);
  // These six masters are the reference set EVERY import row is attributed through, and they were
  // read unpaginated — so PostgREST's 1000-row cap silently truncated them. The brick master was
  // over that cap as recently as 2026-07-28 (696 active today), and a truncated brick list does not
  // fail: it just makes the missing bricks unresolvable, sending those customers' sales nowhere.
  // selectAllReference pages while preserving the { data, error } shape the schema-drift fallbacks
  // below depend on.
  const [
    newRegionsResult,
    areasResult,
    blocksResult,
    bricksResult,
    productsResult,
    distributorsResult,
    priceOverridesResult,
  ] = await Promise.all([
    selectAllReference(() =>
      supabase
        .from("source_of_sales_regions")
        .select("region_code,region_name")
        .eq("active", true), "region_code"),
    selectAllReference(() =>
      supabase
        .from("source_of_sales_areas")
        .select("area_code,area_name,region_code")
        .eq("active", true), "area_code"),
    selectAllReference(() =>
      supabase
        .from("source_of_sales_blocks")
        .select("block_code,description,area_code,region_code")
        .eq("active", true), "block_code"),
    selectAllReference(() =>
      supabase
        .from("source_of_sales_bricks")
        .select("brick_id,brick_name,block_code,area_code,region_code")
        .eq("active", true), "brick_id"),
    selectAllReference(() =>
      supabase
        .from("source_of_sales_products")
        .select("product_code,product_name,factory_price,family,family_code,source,line")
        .eq("active", true), "product_code"),
    selectAllReference(() =>
      supabase
        .from("source_of_sales_distributors")
        .select("distributor_code,distributor_name")
        .eq("active", true), "distributor_code"),
    // A handful of rows at most (one today), so one plain read — see productPriceOverrides.
    supabase
      .from("source_of_sales_product_price_history")
      .select("product_code,effective_period,factory_price")
      .order("product_code", { ascending: true })
      .order("effective_period", { ascending: true }),
  ]);

  if (productsResult.error) throw toQueryError(productsResult.error);
  if (distributorsResult.error) throw toQueryError(distributorsResult.error);
  // Loud, like the product master it qualifies: an unread override values its month at the flat
  // master price — exactly the wrong number this read exists to prevent — and says nothing.
  if (priceOverridesResult.error) throw toQueryError(priceOverridesResult.error);

  // Region names are joined from the regions master by code; the areas table does not carry
  // region_name in every Supabase project (schema drift across staging/prod).
  const masterRegionNameByCode = buildRegionNameByCode(
    newRegionsResult.error ? [] : (newRegionsResult.data ?? []),
  );

  let areas: SalesAreaReference[] = [];
  let regions: SalesAreaRegionReference[] = [];
  if (!areasResult.error) {
    areas = buildAreaReferencesFromRows(areasResult.data ?? [], masterRegionNameByCode);
  } else {
    const legacyRegionsResult = await supabase
      .from("source_of_sales_area_regions")
      .select("area_code,area_name,region_code,region_name")
      .eq("active", true)
      .order("region_code", { ascending: true });
    if (legacyRegionsResult.error) throw toQueryError(legacyRegionsResult.error);
    areas = (legacyRegionsResult.data ?? []).map((row) => ({
      areaCode: String(row.area_code ?? ""),
      areaName: String(row.area_name ?? ""),
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    }));
  }

  if (!newRegionsResult.error && (newRegionsResult.data ?? []).length > 0) {
    regions = (newRegionsResult.data ?? []).map((row) => ({
      areaCode: "",
      areaName: "",
      regionCode: String(row.region_code ?? ""),
      regionName: String(row.region_name ?? ""),
    }));
  } else {
    const seenRegions = new Set<string>();
    regions = areas.filter((row) => {
      const code = normalizeCode(row.regionCode);
      if (!code || seenRegions.has(code)) return false;
      seenRegions.add(code);
      return true;
    });
  }

  // Production's bricks/blocks tables only carry codes (no area_name/region_name/
  // block_name columns), so those names are derived from the region/area/block masters
  // by code. Selecting the missing columns directly would error the whole query and
  // wipe out every brick name (the brick label would fall back to its raw ID).
  const regionNameByCode = new Map<string, string>();
  for (const region of regions) {
    const code = normalizeCode(region.regionCode);
    if (code && region.regionName) regionNameByCode.set(code, region.regionName);
  }
  for (const area of areas) {
    const code = normalizeCode(area.regionCode);
    if (code && area.regionName && !regionNameByCode.has(code)) regionNameByCode.set(code, area.regionName);
  }
  const areaNameByCode = new Map<string, string>();
  for (const area of areas) {
    const code = normalizeCode(area.areaCode);
    if (code && area.areaName) areaNameByCode.set(code, area.areaName);
  }

  const blocks: SalesBlockReference[] = blocksResult.error
    ? []
    : (blocksResult.data ?? []).map((row) => {
      const areaCode = String(row.area_code ?? "");
      const regionCode = String(row.region_code ?? "");
      return {
        areaCode,
        areaName: areaNameByCode.get(normalizeCode(areaCode)) ?? "",
        blockCode: String(row.block_code ?? ""),
        blockName: String(row.description ?? ""),
        regionCode,
        regionName: regionNameByCode.get(normalizeCode(regionCode)) ?? "",
      };
    });
  const blockNameByCode = new Map<string, string>();
  for (const block of blocks) {
    const code = normalizeCode(block.blockCode);
    if (code && block.blockName) blockNameByCode.set(code, block.blockName);
  }
  const bricks: SalesBrickReference[] = bricksResult.error
    ? []
    : (bricksResult.data ?? []).map((row) => {
      const areaCode = String(row.area_code ?? "");
      const regionCode = String(row.region_code ?? "");
      const blockCode = String(row.block_code ?? "");
      return {
        areaCode,
        areaName: areaNameByCode.get(normalizeCode(areaCode)) ?? "",
        blockCode,
        blockName: blockNameByCode.get(normalizeCode(blockCode)) ?? "",
        brickId: String(row.brick_id ?? ""),
        brickName: String(row.brick_name ?? ""),
        regionCode,
        regionName: regionNameByCode.get(normalizeCode(regionCode)) ?? "",
      };
    });

  return {
    areas,
    blocks,
    bricks,
    customerBricks: await customerBricksPromise,
    regions,
    products: (productsResult.data ?? []).map((row) => ({
      factoryPrice: Number(row.factory_price ?? 0),
      family: String(row.family ?? ""),
      familyCode: String(row.family_code ?? ""),
      line: String(row.line ?? ""),
      productCode: String(row.product_code ?? ""),
      productName: String(row.product_name ?? ""),
      source: String(row.source ?? ""),
    })),
    productPriceOverrides: (priceOverridesResult.data ?? []).map((row) => ({
      productCode: String(row.product_code ?? ""),
      effectivePeriod: String(row.effective_period ?? ""),
      factoryPrice: Number(row.factory_price ?? 0),
    })),
    distributors: (distributorsResult.data ?? []).map((row) => ({
      code: String(row.distributor_code ?? ""),
      name: String(row.distributor_name ?? ""),
    })),
  };
}

export async function listSalesImportDistributors(): Promise<SalesDistributorOption[]> {
  // The upload dropdown only needs distributor code + name. Loading the full
  // reference bundle here used to page the entire ~29k-row customer→brick
  // crosswalk (and 5 other masters) on every page open — seconds of round-trips
  // for a dropdown. Query the one table directly instead.
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_distributors")
    .select("distributor_code,distributor_name")
    .eq("active", true)
    .order("distributor_name", { ascending: true });

  if (error) throw error;
  return (data ?? []).map((row) => ({
    code: String(row.distributor_code ?? ""),
    name: String(row.distributor_name ?? ""),
  }));
}

function mapSourceOfSalesProduct(row: Record<string, unknown>): SourceOfSalesProduct {
  return {
    active: Boolean(row.active ?? true),
    createdAt: String(row.created_at ?? ""),
    factoryPrice: Number(row.factory_price ?? 0),
    family: String(row.family ?? ""),
    familyCode: String(row.family_code ?? ""),
    line: String(row.line ?? ""),
    normalizedLine: String(row.normalized_line ?? ""),
    normalizedProductName: String(row.normalized_product_name ?? ""),
    productCode: String(row.product_code ?? ""),
    productName: String(row.product_name ?? ""),
    source: String(row.source ?? ""),
    sourceFile: String(row.source_file ?? ""),
    sourceRowNumber: row.source_row_number === null || row.source_row_number === undefined
      ? null
      : Number(row.source_row_number),
    sourceSheet: String(row.source_sheet ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function sourceOfSalesProductPayload(input: NormalizedSourceOfSalesProductInput) {
  return {
    active: input.active,
    factory_price: input.factoryPrice,
    family: input.family,
    family_code: input.familyCode,
    line: input.line,
    normalized_line: input.normalizedLine,
    normalized_product_name: input.normalizedProductName,
    product_code: input.productCode,
    product_name: input.productName,
    source: input.source,
    source_file: input.sourceFile,
    source_row_number: input.sourceRowNumber,
    source_sheet: input.sourceSheet,
    updated_at: new Date().toISOString(),
  };
}

function throwProductMutationError(error: { code?: string; message?: string } | null, fallback: string): never {
  if (error?.code === "23505") {
    throw new SalesWorkflowError(
      "duplicate_product_reference",
      "Product Code or Product Name already exists in the Source of Sales product reference.",
      409,
    );
  }
  throw new SalesWorkflowError("product_reference_mutation_failed", error?.message ?? fallback, 500);
}

// The SoS product master is identical for every viewer (the route applies the per-role confidential
// filter AFTER this returns), so cache the whole catalog and reuse it across requests. Tag
// "sos-reference" is busted on any validated import (invalidateSalesDashboardCache) and on product
// create below, so the 600s TTL is only a backstop. Keeps the product dropdown / reference lookups
// off a per-request `select *` on source_of_sales_products.
const loadSourceOfSalesProductsCached = unstable_cache(
  async (): Promise<SourceOfSalesProduct[]> => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("source_of_sales_products")
      .select("*")
      .order("line", { ascending: true })
      .order("product_name", { ascending: true });

    if (error) throw error;
    return (data ?? []).map((row) => mapSourceOfSalesProduct(row as Record<string, unknown>));
  },
  ["sos-products"],
  { revalidate: 600, tags: ["sos-reference"] },
);

export async function listSourceOfSalesProducts(): Promise<SourceOfSalesProduct[]> {
  return loadSourceOfSalesProductsCached();
}

export async function createSourceOfSalesProduct(input: {
  actorLoginId: string;
  product: SourceOfSalesProductInput;
}) {
  const normalized = normalizeSourceOfSalesProductInput(input.product);
  const supabase = getSupabaseAdmin();
  const insertResult = await supabase
    .from("source_of_sales_products")
    .insert(sourceOfSalesProductPayload(normalized))
    .select("*")
    .single();

  if (insertResult.error) {
    throwProductMutationError(insertResult.error, "Failed to add Source of Sales product.");
  }

  const product = mapSourceOfSalesProduct(insertResult.data as Record<string, unknown>);
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: product.productCode,
    entityType: "source_of_sales_product",
    newValues: { product, source: "source_of_sales" },
    summary: "Source of Sales product added.",
  });

  invalidateSalesDashboardCache("source of sales product created");
  return product;
}

export async function updateSourceOfSalesProduct(input: {
  actorLoginId: string;
  product: SourceOfSalesProductInput;
  productCode: string;
}) {
  const currentCode = normalizeCode(input.productCode);
  if (!currentCode) {
    throw new SalesWorkflowError("invalid_product_reference", "Product Code is required.", 400);
  }

  const normalized = normalizeSourceOfSalesProductInput(input.product);
  const supabase = getSupabaseAdmin();
  const existingResult = await supabase
    .from("source_of_sales_products")
    .select("*")
    .eq("product_code", currentCode)
    .maybeSingle();

  if (existingResult.error) throw existingResult.error;
  if (!existingResult.data) {
    throw new SalesWorkflowError("product_reference_not_found", "Source of Sales product was not found.", 404);
  }

  const updateResult = await supabase
    .from("source_of_sales_products")
    .update(sourceOfSalesProductPayload(normalized))
    .eq("product_code", currentCode)
    .select("*")
    .single();

  if (updateResult.error) {
    throwProductMutationError(updateResult.error, "Failed to update Source of Sales product.");
  }

  const product = mapSourceOfSalesProduct(updateResult.data as Record<string, unknown>);
  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: product.productCode,
    entityType: "source_of_sales_product",
    newValues: { product, source: "source_of_sales" },
    oldValues: {
      product: mapSourceOfSalesProduct(existingResult.data as Record<string, unknown>),
      source: "source_of_sales",
    },
    summary: "Source of Sales product updated.",
  });

  invalidateSalesDashboardCache("source of sales product updated");
  return product;
}

export async function deleteSourceOfSalesProduct(input: {
  actorLoginId: string;
  productCode: string;
}) {
  const productCode = normalizeCode(input.productCode);
  if (!productCode) {
    throw new SalesWorkflowError("invalid_product_reference", "Product Code is required.", 400);
  }

  const supabase = getSupabaseAdmin();
  const existingResult = await supabase
    .from("source_of_sales_products")
    .select("*")
    .eq("product_code", productCode)
    .maybeSingle();

  if (existingResult.error) throw existingResult.error;
  if (!existingResult.data) return null;

  const { error } = await supabase
    .from("source_of_sales_products")
    .delete()
    .eq("product_code", productCode);
  if (error) throwProductMutationError(error, "Failed to delete Source of Sales product.");

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: productCode,
    entityType: "source_of_sales_product",
    oldValues: {
      product: mapSourceOfSalesProduct(existingResult.data as Record<string, unknown>),
      source: "source_of_sales",
    },
    summary: "Source of Sales product deleted.",
  });

  invalidateSalesDashboardCache("source of sales product deleted");
  return true;
}

function mapSourceOfSalesBatch(row: Record<string, unknown>): SourceOfSalesUploadBatch {
  return {
    batchId: String(row.id ?? ""),
    blockingReasons: Array.isArray(row.blocking_reasons)
      ? row.blocking_reasons.map((reason) => String(reason))
      : [],
    createdAt: String(row.created_at ?? ""),
    distributorCode: String(row.distributor_code ?? ""),
    distributorName: String(row.distributor_name ?? ""),
    failedRows: Number(row.failed_rows ?? 0),
    fileName: String(row.file_name ?? ""),
    importableRows: Number(row.importable_rows ?? 0),
    period: row.period ? String(row.period) : null,
    rowCount: Number(row.total_rows ?? 0),
    status: String(row.status ?? "blocked") === "validated" ? "validated" : "blocked",
    templateKey: String(row.template_key ?? ""),
    totalBonusQty: Number(row.total_bonus_qty ?? 0),
    totalQty: Number(row.total_qty ?? 0),
    totalValue: Number(row.total_value ?? 0),
    uploadedBy: String(row.uploaded_by ?? "system"),
    warningRows: Number(row.warning_rows ?? 0),
  };
}

export async function listSourceOfSalesUploadBatches(): Promise<SourceOfSalesUploadBatch[]> {
  const supabase = getSupabaseAdmin();
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("source_of_sales_import_batches")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const pageRows = (data ?? []) as Record<string, unknown>[];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  return rows.map((row) => mapSourceOfSalesBatch(row));
}

export type DistributorUploadStatus = {
  /** Active distributors in the master (the "expected to upload" set). */
  expectedCount: number;
  /** Distinct active distributors with a VALIDATED batch for the period. */
  uploadedCount: number;
  /** Expected − uploaded; "awaiting upload" so a low total isn't read as real zero. */
  awaitingCount: number;
  /** ISO timestamp of the most recent validated upload for the period ("data as of"). */
  lastUploadedAt: string | null;
};

/**
 * Upload coverage for a period: how many distributors have a validated batch vs how many are
 * expected (active master). Lets a dashboard distinguish "awaiting upload" from a genuine zero.
 */
export async function getDistributorUploadStatus(period: string): Promise<DistributorUploadStatus> {
  const supabase = getSupabaseAdmin();
  const [distRes, batchRes] = await Promise.all([
    supabase.from("source_of_sales_distributors").select("distributor_code").eq("active", true),
    supabase.from("source_of_sales_import_batches").select("distributor_code,status,created_at").eq("period", period),
  ]);
  const norm = (value: unknown) => String(value ?? "").trim().toUpperCase();
  const expected = new Set(
    ((distRes.data ?? []) as Record<string, unknown>[]).map((row) => norm(row.distributor_code)).filter(Boolean),
  );
  const validatedBatches = ((batchRes.data ?? []) as Record<string, unknown>[]).filter(
    (row) => String(row.status ?? "") === "validated",
  );
  const uploaded = new Set(
    validatedBatches.map((row) => norm(row.distributor_code)).filter((code) => code && expected.has(code)),
  );
  let lastUploadedAt: string | null = null;
  let lastUploadedMs = -Infinity;
  for (const row of validatedBatches) {
    const at = row.created_at ? String(row.created_at) : null;
    if (!at) continue;
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && ms > lastUploadedMs) {
      lastUploadedMs = ms;
      lastUploadedAt = at;
    }
  }
  const expectedCount = expected.size;
  const uploadedCount = uploaded.size;
  return { expectedCount, uploadedCount, awaitingCount: Math.max(0, expectedCount - uploadedCount), lastUploadedAt };
}

/** Exported so tests can drive the pure `buildSourceOfSalesDashboard` directly (it already takes
 *  these on its public input type). */
export type SourceOfSalesSummaryRecord = {
  batchId?: string;
  groupCode: string | null;
  groupKey: string;
  groupLabel: string;
  groupType: string;
  officialLine: string | null;
  rowCount: number;
  totalBonusQty: number;
  totalQty: number;
  totalValue: number;
};

function addDashboardTotals<T extends DistributorSalesTotal>(current: T, row: DistributorSalesTotal) {
  current.rowCount += row.rowCount;
  current.totalQty += row.totalQty;
  current.totalBonusQty += row.totalBonusQty;
  current.totalValue += row.totalValue;
}

/**
 * Merge dashboard groups that are the SAME real place, and heal their label from the master.
 *
 * `aggregateDashboardGroups` groups on `group_key`, which `sourceOfSalesSummaryRows` builds as
 * `code|name` **as captured at import time** (`"CA|Cairo"`). So one code that arrived under two
 * different names in two different sheets produces two groups. The label heal then rewrote BOTH
 * to the master name — which is why the dashboard used to show several visually identical rows.
 * Measured against production, period 2026-07, by running this loader before and after the fix:
 *
 *     regions   23 rows ->   7    16 merged. `AB|Alex-BHR` + `AB|Cairo` + `AB|Giza` +
 *                                 `AB|Delta (1)` all rendered as "Alex-BHR".
 *     areas    101 rows ->  55    46 merged. The 55 are 50 named areas + 5 rows carrying an EMPTY
 *                                 code (unmapped sales, one per region), deliberately left split.
 *     bricks   504 rows -> 504    0 merged — bricks were ALREADY clean. 29 of them are the same
 *                                 empty-code unmapped rows, and the one repeated NAME, فوه, is two
 *                                 genuinely different bricks (B200-5 in Kafr El-Sheikh 2, B199-9 in
 *                                 Kafr El-Sheikh 1) that must stay apart.
 *     products  25 rows ->  25    unchanged; product keys carry no region name, so never affected.
 *
 * Do NOT quote a smaller "real" count for areas or bricks off a SQL sweep bucketing by
 * `coalesce(group_code, group_label)` — that collapses every empty-code row into one and
 * understates the answer. It produced a bogus "51 areas / 476 bricks" while this was being written.
 *
 * Every period from 2026-01 to 2026-07 is affected; 2026-08 escaped only because it has a single
 * batch. **No value was ever lost or double-counted** — the 16 phantom REGION rows held EGP 24,266
 * of 61,641,432 (0.04%), split off the real row rather than invented. The damage was the row count
 * and every per-row share computed from it.
 *
 * The fix is that identity is the CODE, not the key: whenever the master resolves the group's
 * code, every group carrying that code is ONE row. A code the master does not know — and an empty
 * code, which is what every unmapped row carries — keeps its own `group_key` and is left entirely
 * alone. Without a master entry there is nothing to prove two keys are the same place, and merging
 * on an unknown or blank code would fuse genuinely distinct groups: `فوه` above is two real bricks,
 * and folding the five empty-code area rows together would destroy the per-region split of
 * unmapped value. A row still repeating on screen after this is therefore a DATA finding
 * (unmapped, or a name reused across two codes), not a grouping defect.
 *
 * Merging here (rather than in `buildSourceOfSalesDashboard`) is deliberate on three counts:
 * the masters are only loaded in this function; it is sum-preserving, so the geo reconciliation
 * guard that fails closed on `byRegion`'s total is unaffected; and it repairs every historical
 * period on read, with no re-import — the same self-heal intent the label override already had.
 * Fixing `group_key` at import time instead would leave all seven affected periods broken.
 */
export function mergeDashboardGroupsByCode(
  groups: SourceOfSalesDashboardGroup[],
  /** Master lookup: return null when the master does not know this code (⇒ do not merge). */
  resolve: (code: string) => { label?: string; line?: string | null } | null,
): SourceOfSalesDashboardGroup[] {
  const merged = new Map<string, SourceOfSalesDashboardGroup>();
  for (const group of groups) {
    const resolved = group.code ? resolve(normalizeCode(group.code)) : null;
    // Unknown code (or no code at all) ⇒ identity stays the raw group_key, which
    // aggregateDashboardGroups already guarantees unique. Never merge on a bare label.
    const identity = resolved ? `code\u0000${normalizeCode(group.code ?? "")}` : `key\u0000${group.key}`;
    const existing = merged.get(identity);
    if (existing) {
      addDashboardTotals(existing, group);
      continue;
    }
    merged.set(identity, {
      ...group,
      label: resolved?.label || group.label,
      line: resolved?.line ?? group.line,
    });
  }

  return [...merged.values()]
    .map(roundedTotals)
    .sort((left, right) => right.totalValue - left.totalValue || left.label.localeCompare(right.label));
}

/**
 * What the SoS tables print for a group the master cannot name.
 *
 * Every unmapped row arrives from the import with an EMPTY code and an EMPTY label — sales whose
 * area or brick could not be resolved to a master row. Measured on production period 2026-07:
 * 5 such area rows worth EGP 149,289 (one per region) and 29 brick rows worth EGP 1,324,399.
 *
 * Until now those rendered as "-", because `cellDisplay` in the SoS workspace falls back to a dash
 * on any falsy value. A dash reads as a rendering fault, so the rows were invisible as a FINDING —
 * which is exactly what they are: real money that reached no area or brick. Worse, the dash was
 * screen-only; the XLSX export wrote the raw empty string, so screen and export disagreed. Naming
 * them here, in the data layer, makes both say the same word.
 *
 * This deliberately does NOT merge them. Each unmapped row keeps its own parent — the five area
 * rows carry their region, the 29 brick rows carry their area — and that parent is rendered beside
 * the label, so the rows stay distinguishable rather than becoming a wall of identical text.
 * Folding them together would print one meaningless total and destroy the per-parent split that
 * makes an unmapped row actionable. See mergeDashboardGroupsByCode for the guard that keeps a
 * blank code from ever becoming an identity.
 */
export const UNMAPPED_GROUP_LABEL = "Unmapped";

export function labelUnmappedGroups(
  groups: SourceOfSalesDashboardGroup[],
): SourceOfSalesDashboardGroup[] {
  return groups.map((group) =>
    String(group.label ?? "").trim() ? group : { ...group, label: UNMAPPED_GROUP_LABEL },
  );
}

function aggregateDashboardGroups(
  summaries: SourceOfSalesSummaryRecord[],
  groupType: string,
): SourceOfSalesDashboardGroup[] {
  const grouped = new Map<string, SourceOfSalesDashboardGroup>();
  summaries
    .filter((row) => row.groupType === groupType)
    .forEach((row) => {
      const current = grouped.get(row.groupKey) ?? {
        ...emptyTotals(),
        code: row.groupCode,
        key: row.groupKey,
        label: row.groupLabel,
        line: row.officialLine,
      };
      addDashboardTotals(current, row);
      grouped.set(row.groupKey, current);
    });

  return [...grouped.values()]
    .map(roundedTotals)
    .sort((left, right) => right.totalValue - left.totalValue || left.label.localeCompare(right.label));
}

export function buildSourceOfSalesDashboard(input: {
  availablePeriods: string[];
  batches: SourceOfSalesUploadBatch[];
  /**
   * Strip the confidential Head Office LINE from every dimension. Same lock class as
   * `restrictedProductCodes`, but at the line grain — see canViewHeadOfficeLine. Pass
   * `!canViewHeadOfficeLine(role)`; the loader derives it so callers cannot forget.
   */
  excludeHeadOfficeLine?: boolean;
  geoSummaries?: SourceOfSalesSummaryRecord[];
  period: string | null;
  restrictedProductCodes?: string[];
  summaries: SourceOfSalesSummaryRecord[];
}): SourceOfSalesDashboard {
  const restrictedSet = input.restrictedProductCodes?.length
    ? new Set(input.restrictedProductCodes.map((c) => c.trim().toUpperCase()))
    : null;
  const stripHeadOffice = input.excludeHeadOfficeLine === true;

  // `input.batches` deliberately carries EVERY status — the page shows recent upload history,
  // rejected files included. But a rejected upload's row is written with fully populated
  // total_qty/total_value (see persistDistributorSalesUpload), so anything SUMMED here must come
  // from the validated subset only. The loader already restricts the summaries query that way;
  // before this, the unrestricted fast path below summed the batch list UNFILTERED, so the
  // headline Total Value and the By-Distributor table counted a rejected sheet as revenue while
  // By Line / By Product / By Region — built from those same validated-only summaries — did not.
  // The page contradicted itself, and the half that was wrong is the half the CEO reads first.
  //
  // Whitelist, never a blacklist: mapSourceOfSalesBatch already coerces any status that is not
  // exactly "validated" to "blocked", so a batch stuck mid-write (the row is inserted before
  // finalize, a window of up to ~6h) cannot leak in through a status this code never heard of.
  const countedBatches = input.batches.filter((batch) => batch.status === "validated");

  // ── CEO / unrestricted path ──────────────────────────────────────────────
  // Only safe when BOTH locks are open. The fast path sums whole-BATCH totals, which bake in
  // every line — so a viewer who may see restricted products but not the Head Office line (or
  // vice versa) must take the re-derived path below instead.
  if (!restrictedSet && !stripHeadOffice) {
    const totals = emptyTotals();
    const distributorMap = new Map<string, SourceOfSalesDashboardDistributor>();
    countedBatches.forEach((batch) => {
      const batchTotals = { rowCount: batch.rowCount, totalBonusQty: batch.totalBonusQty, totalQty: batch.totalQty, totalValue: batch.totalValue };
      addDashboardTotals(totals, batchTotals);
      const key = batch.distributorCode;
      const distributor = distributorMap.get(key) ?? { ...emptyTotals(), distributorCode: batch.distributorCode, distributorName: batch.distributorName, sheetCount: 0 };
      distributor.sheetCount += 1;
      addDashboardTotals(distributor, batchTotals);
      distributorMap.set(key, distributor);
    });
    // Geography comes from `geoSummaries` when the loader supplied it, exactly as on the scoped
    // path below. This is a FRESHNESS fix, not a visibility one: `source_of_sales_import_summaries`
    // is written once at commit and has no updater anywhere in src, app or supabase/migrations, so
    // after a customer is re-mapped to another area its `area`/`brick`/`region` rows keep the
    // geography the file had at import time — for ever. `phx_sync_sos_run` re-stamps the ROWS and
    // refreshes fact_rollup, customer_directory_rollup and marketing ROI facts; summaries are not
    // among them.
    //
    // Measured on production for 2026-07: 40 areas disagree with the live rows, 314 rows sit in the
    // wrong area, 1,172,838.83 EGP is misattributed — GZ6/UE9 (the Fayoum / Beni Suef pair) being
    // the worst. Every fact-based surface (Executive, Monthly Closing, Analytics, the au
    // attribution chain) already reads the re-stamped rows, so only this dashboard disagreed.
    //
    // Before this, the fallback ran the wrong way round for the wrong people: the loader called the
    // live RPC only for viewers who needed something EXCLUDED, so a Super Admin or the CEO — who
    // need nothing excluded — got the stale summaries, while a Regional Manager on the same page in
    // the same minute got geography computed live. The privilege gradient was inverted, and the
    // stale number is the one that gets quoted.
    const unrestrictedGeoSource = input.geoSummaries ?? input.summaries;
    return {
      availablePeriods: input.availablePeriods,
      byArea: aggregateDashboardGroups(unrestrictedGeoSource, "area"),
      byBrick: aggregateDashboardGroups(unrestrictedGeoSource, "brick"),
      byDistributor: [...distributorMap.values()].map(roundedTotals).sort((l, r) => r.totalValue - l.totalValue || l.distributorName.localeCompare(r.distributorName)),
      byLine: aggregateDashboardGroups(input.summaries, "line"),
      byProduct: aggregateDashboardGroups(input.summaries, "product"),
      byRegion: aggregateDashboardGroups(unrestrictedGeoSource, "region"),
      period: input.period,
      sheetCount: countedBatches.length,
      totals: roundedTotals(totals),
    };
  }

  // ── Scoped path: strip confidential products AND/OR the Head Office line ──
  // product-type summary rows carry the product code AND the official line; all other group
  // types (line/region/area/brick) have the confidential value baked in from import time.
  // We re-derive totals / byLine / byProduct / byDistributor from the VISIBLE product rows,
  // and use the geoSummaries (from the DB RPC) for byRegion/byArea/byBrick.
  const isRestricted = (code: string | null) =>
    Boolean(restrictedSet && code && restrictedSet.has(code.trim().toUpperCase()));
  // The Head Office lock is applied at the LINE grain, so it catches every product on that line —
  // including one that is not in RESTRICTED_PRODUCT_CODES. That is the whole point: relying on the
  // product-code list to hide the line only works while every Head Office product happens to also
  // be restricted, and a single new product on that line would silently reopen the leak.
  const isHiddenRow = (row: SourceOfSalesSummaryRecord) =>
    isRestricted(row.groupCode) || (stripHeadOffice && isHeadOfficeLine(row.officialLine));
  const productRows = input.summaries.filter((s) => s.groupType === "product");
  const visibleProducts = productRows.filter((s) => !isHiddenRow(s));

  // Grand totals from the visible products only
  const totals = emptyTotals();
  visibleProducts.forEach((row) => addDashboardTotals(totals, row));

  // byLine: re-aggregate from the visible product rows using officialLine
  const lineMap = new Map<string, SourceOfSalesDashboardGroup>();
  visibleProducts.forEach((row) => {
    const line = row.officialLine ?? "(No Line)";
    const current = lineMap.get(line) ?? { ...emptyTotals(), code: null, key: line, label: line, line: line };
    addDashboardTotals(current, row);
    lineMap.set(line, current);
  });
  const byLine = [...lineMap.values()].map(roundedTotals).sort((l, r) => r.totalValue - l.totalValue || l.label.localeCompare(r.label));

  // byDistributor: re-aggregate from the visible product rows via batchId
  const batchById = new Map(countedBatches.map((b) => [b.batchId, b]));
  const sheetCountByCode = new Map<string, number>();
  countedBatches.forEach((b) => sheetCountByCode.set(b.distributorCode, (sheetCountByCode.get(b.distributorCode) ?? 0) + 1));
  const distMap = new Map<string, SourceOfSalesDashboardDistributor>();
  visibleProducts.forEach((row) => {
    const batch = batchById.get(row.batchId ?? "");
    if (!batch) return;
    const key = batch.distributorCode;
    const current = distMap.get(key) ?? { ...emptyTotals(), distributorCode: batch.distributorCode, distributorName: batch.distributorName, sheetCount: sheetCountByCode.get(key) ?? 0 };
    addDashboardTotals(current, row);
    distMap.set(key, current);
  });
  const byDistributor = [...distMap.values()].map(roundedTotals).sort((l, r) => r.totalValue - l.totalValue || l.distributorName.localeCompare(r.distributorName));

  // byProduct: filter from product-type summaries (same visibility rule as everything above)
  const byProduct = aggregateDashboardGroups(visibleProducts, "product");

  // byRegion/byArea/byBrick: use pre-filtered geo summaries from the DB RPC when available;
  // fall back to the (inflated) pre-aggregated summaries if the RPC was skipped.
  const geoSource = input.geoSummaries ?? input.summaries;
  let byRegion = aggregateDashboardGroups(geoSource, "region");
  let byArea = aggregateDashboardGroups(geoSource, "area");
  let byBrick = aggregateDashboardGroups(geoSource, "brick");

  // ── Geo reconciliation guard (fail closed) ───────────────────────────────
  // The geo dimensions have NO line dimension to filter on — the RPC that produces them can only
  // exclude PRODUCT CODES, so the loader hides the Head Office line there by excluding that line's
  // product codes (resolved live from the master). That is exact only while the master knows every
  // Head Office product. If an import ever lands a Head Office row whose product code is missing
  // from the master, the code-based exclusion under-filters and the geography silently leaks.
  //
  // We can detect precisely that: byRegion is the same underlying value re-cut by geography, so it
  // must sum to the authoritative line-scoped `totals`. If geography carries MORE value than the
  // scoped total, it contains rows the line scope excluded — withhold all three geo dimensions
  // rather than render a contaminated split. (Lower is not a leak — geography can be unmapped —
  // so it is left alone.) Tolerance is 1.00 against values rounded to 6dp, i.e. rounding only.
  //
  // Only scoped viewers reach here. The unrestricted CEO/Super-Admin path returned above and is
  // deliberately NOT reconciled: this guard exists to catch an under-filtered exclusion leaking
  // confidential value, and a viewer with both locks open has nothing being excluded to leak. (It
  // now reads the same live geo aggregates they do — see that path — so it is no longer reading the
  // stale summaries either; that changed the freshness, not the reconciliation question.)
  if (byRegion.length > 0) {
    const geoValue = byRegion.reduce((sum, group) => sum + group.totalValue, 0);
    if (geoValue - totals.totalValue > 1) {
      console.warn(
        "[sales dashboard] geography carries more value than the scoped total "
          + `(${geoValue.toFixed(2)} vs ${totals.totalValue.toFixed(2)}); withholding byRegion/byArea/byBrick `
          + "rather than showing a figure that still contains confidential rows",
      );
      byRegion = [];
      byArea = [];
      byBrick = [];
    }
  }

  return {
    availablePeriods: input.availablePeriods,
    byArea,
    byBrick,
    byDistributor,
    byLine,
    byProduct,
    byRegion,
    period: input.period,
    sheetCount: countedBatches.length,
    totals: roundedTotals(totals),
  };
}

function mapSourceOfSalesSummary(row: Record<string, unknown>): SourceOfSalesSummaryRecord {
  return {
    batchId: String(row.batch_id ?? ""),
    groupCode: row.group_code === null || row.group_code === undefined ? null : String(row.group_code),
    groupKey: String(row.group_key ?? ""),
    groupLabel: String(row.group_label ?? ""),
    groupType: String(row.group_type ?? ""),
    officialLine: row.official_line === null || row.official_line === undefined ? null : String(row.official_line),
    rowCount: Number(row.row_count ?? 0),
    totalBonusQty: Number(row.total_bonus_qty ?? 0),
    totalQty: Number(row.total_qty ?? 0),
    totalValue: Number(row.total_value ?? 0),
  };
}

/**
 * The product codes on the confidential Head Office line, resolved LIVE from the product master
 * (never hardcoded — a product added to that line must be hidden the moment it exists).
 *
 * Returns `null` when the master cannot be read. The caller MUST then withhold the geography
 * dimensions rather than proceed with an incomplete exclusion list: a partial list silently
 * under-filters, which is the fail-open shape this whole guard exists to prevent.
 */
async function loadHeadOfficeProductCodes(): Promise<Set<string> | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("source_of_sales_products").select("product_code,line");
  if (error || !data) {
    console.warn("[sales dashboard] could not read the product master to resolve the Head Office line", error);
    return null;
  }
  const codes = new Set<string>();
  for (const row of data as { line?: string | null; product_code?: string | null }[]) {
    if (!isHeadOfficeLine(row.line)) continue;
    const code = (row.product_code ?? "").trim().toUpperCase();
    if (code) codes.add(code);
  }
  return codes;
}

/**
 * Local aliases for access-scope.ts's `canViewHeadOfficeLine` / `canViewRestrictedProducts` — same
 * locked decision (CEO / Super Admin only), both delegating to the single shared predicate in
 * confidential-products.ts. Redeclared here rather than imported from access-scope.ts because this
 * module is reached from several CLIENT components (Monthly Closing, the closing period picker, the
 * portal closing view, the Performance Review) and access-scope.ts pulls the server-only
 * employee-directory chain that ends at node:crypto, which webpack refuses in a browser bundle.
 */
function canViewHeadOfficeLine(role: PhoenixRole): boolean {
  return isConfidentialRevealRole(role);
}
function canViewRestrictedProducts(role: PhoenixRole): boolean {
  return isConfidentialRevealRole(role);
}

/**
 * Who is asking. REQUIRED — the two confidential locks (restricted products, Head Office line) are
 * derived from the role in here, so no caller can forget one of them.
 *
 * This used to be a positional `canViewRestricted = true` boolean, which defaulted to FAIL OPEN and
 * carried no line lock at all. Every caller therefore showed the confidential Head Office line to
 * any role that could reach it — in practice the SFE Manager, the only non-Super-Admin role holding
 * `sales:import`. Passing the role instead of pre-computed booleans is what makes that class of
 * mistake impossible rather than merely fixed once.
 */
export type SourceOfSalesDashboardViewer = {
  role: PhoenixRole;
};

export async function loadSourceOfSalesDashboard(
  period: string | null | undefined,
  viewer: SourceOfSalesDashboardViewer,
): Promise<SourceOfSalesDashboard> {
  const canViewRestricted = canViewRestrictedProducts(viewer.role);
  const canViewHeadOffice = canViewHeadOfficeLine(viewer.role);
  const supabase = getSupabaseAdmin();
  // The brick/area/region-name masters are independent of period/batch/summary selection, so fire
  // them now in parallel instead of as extra sequential round-trips at the end. Used to self-heal
  // group labels to their master NAME (areas/regions/bricks), so the dashboard never shows a bare code.
  const brickNamesPromise = supabase
    .from("source_of_sales_bricks")
    .select("brick_id,brick_name")
    .eq("active", true);
  const regionNamesPromise = supabase
    .from("source_of_sales_regions")
    .select("region_code,region_name")
    .eq("active", true);
  const areaNamesPromise = supabase
    .from("source_of_sales_areas")
    .select("area_code,area_name,region_code")
    .eq("active", true);

  const periodsResult = await supabase
    .from("source_of_sales_import_batches")
    .select("period")
    .eq("status", "validated")
    .not("period", "is", null)
    .order("period", { ascending: false });

  if (periodsResult.error) throw periodsResult.error;

  const availablePeriods = [...new Set((periodsResult.data ?? [])
    .map((row) => String(row.period ?? ""))
    .filter(Boolean))]
    .sort((left, right) => right.localeCompare(left));
  const selectedPeriod = period && availablePeriods.includes(period) ? period : availablePeriods[0] ?? null;

  if (!selectedPeriod) {
    return buildSourceOfSalesDashboard({
      availablePeriods,
      batches: [],
      excludeHeadOfficeLine: !canViewHeadOffice,
      period: null,
      summaries: [],
    });
  }

  const batchesResult = await supabase
    .from("source_of_sales_import_batches")
    .select("*")
    .eq("period", selectedPeriod)
    .order("created_at", { ascending: false });

  if (batchesResult.error) throw batchesResult.error;

  const batches = (batchesResult.data ?? []).map((row) => mapSourceOfSalesBatch(row as Record<string, unknown>));
  // `batches` intentionally keeps every status (validated + blocked) — the dashboard shows recent
  // upload history including rejected files. But the SUMMED totals below must only ever reflect
  // validated batches (a rejected/blocked upload's row still gets inserted with populated
  // total_qty/total_value at write time — see the commit above this function — so a blocked batch
  // ID reaching the summaries query would permanently inflate this period's totals).
  const batchIds = batches.filter((batch) => batch.status === "validated").map((batch) => batch.batchId);
  if (batchIds.length === 0) {
    // No VALIDATED batch this period. `batches` may still hold blocked uploads (the dashboard shows
    // rejected history), and the unrestricted fast path sums whole-batch totals — which would put a
    // blocked batch's Head Office value in front of a scoped viewer. Carry the lock so they take the
    // re-derived path and get zeroes instead.
    return buildSourceOfSalesDashboard({
      availablePeriods,
      batches,
      excludeHeadOfficeLine: !canViewHeadOffice,
      period: selectedPeriod,
      summaries: [],
    });
  }

  const summariesResult = await supabase
    .from("source_of_sales_import_summaries")
    .select("batch_id,group_type,group_key,group_label,group_code,official_line,row_count,total_qty,total_bonus_qty,total_value")
    .in("batch_id", batchIds);

  if (summariesResult.error) throw summariesResult.error;

  // Call the geo RPC for EVERY viewer to get region/area/brick totals computed live from
  // `source_of_sales_import_rows`. The pre-aggregated summaries bake their value in at import time,
  // so they can neither be filtered post-hoc NOR reflect a later re-map — see the freshness note in
  // buildSourceOfSalesDashboard's unrestricted path.
  //
  // It used to run only when something had to be EXCLUDED, which quietly made an exclusion filter
  // the sole source of freshness and handed the stale copy to precisely the two roles that sign off
  // the month. A fully privileged viewer now passes an EMPTY exclusion list: the RPC guards its own
  // filter with `not exists (select 1 from excluded) or …`, so an empty array excludes nothing and
  // returns the complete live geography (and `coalesce(p_exclude_codes, '{}')` makes even NULL
  // safe). Nothing about who may see what changes here.
  //
  // The RPC excludes by PRODUCT CODE, and region/area/brick carry no line dimension — so the
  // Head Office LINE is hidden here by excluding that line's product codes, resolved live from the
  // master. Verified against production 2026-08-02: the Head Office line holds 4 products
  // (LA003/LA004/SS001 — already restricted — plus RY001, which is not), the master covers every
  // code the rows actually use, no Head Office row has a blank product code, and no code is shared
  // with another line. buildSourceOfSalesDashboard re-checks that equivalence at runtime by
  // reconciling the geography sum against the line-scoped total, so a future import that breaks it
  // withholds the split instead of leaking it.
  // A viewer with BOTH locks open has nothing to exclude, so an RPC failure cannot leak anything
  // past them. They fall back to the summaries (stale geography, but present) rather than to a
  // blank split; a scoped viewer still fails CLOSED to `[]`. Same call, two different failure
  // semantics, because the risk is not the same in the two directions.
  const scopedViewer = !canViewRestricted || !canViewHeadOffice;
  const geoFailureFallback = scopedViewer ? [] : undefined;
  let geoSummaries: SourceOfSalesSummaryRecord[] | undefined;
  if (batchIds.length > 0) {
    const excludeCodes = new Set<string>(
      canViewRestricted ? [] : RESTRICTED_PRODUCT_CODES.map((code) => code.trim().toUpperCase()),
    );
    // null ⇒ the master could not be read, so the exclusion list cannot be trusted to be complete.
    // Only reachable for a scoped viewer: `canViewHeadOffice` short-circuits the read for the other.
    const headOfficeCodes = canViewHeadOffice ? new Set<string>() : await loadHeadOfficeProductCodes();
    if (!headOfficeCodes) {
      geoSummaries = [];
    } else {
      headOfficeCodes.forEach((code) => excludeCodes.add(code));
      const geoResult = await supabase.rpc("phx_sos_geo_aggregates_without_restricted", {
        p_batch_ids: batchIds,
        p_exclude_codes: [...excludeCodes],
      });
      if (!geoResult.error && geoResult.data) {
        geoSummaries = (geoResult.data as Record<string, unknown>[]).map((row) => mapSourceOfSalesSummary(row));
      } else if (geoResult.error) {
        // Fail CLOSED for a SCOPED viewer: they must never see byRegion/byArea/byBrick fall back to
        // the unfiltered (confidential-inclusive) summaries just because this RPC call errored. An
        // empty geo breakdown (rather than `undefined`, which the geoSource ?? input.summaries
        // fallback would treat as "RPC skipped, use the inflated summaries") degrades to a blank
        // region/area/brick section instead of leaking confidential product value.
        //
        // A viewer with both locks open has no confidential rows to leak, so `undefined` there
        // degrades to the stale-but-present summaries — the behaviour they had before this call was
        // extended to them. Blanking their geography on a transient RPC error would be a NEW outage
        // introduced by a freshness fix.
        console.warn(
          `[sales dashboard] phx_sos_geo_aggregates_without_restricted failed; region/area/brick will ${
            scopedViewer ? "be empty rather than falling back to unfiltered totals" : "fall back to the (stale) import summaries"
          }`,
          geoResult.error,
        );
        geoSummaries = geoFailureFallback;
      }
    }
  }

  const dashboard = buildSourceOfSalesDashboard({
    availablePeriods,
    batches,
    excludeHeadOfficeLine: !canViewHeadOffice,
    geoSummaries,
    period: selectedPeriod,
    restrictedProductCodes: canViewRestricted ? undefined : (RESTRICTED_PRODUCT_CODES as unknown as string[]),
    summaries: (summariesResult.data ?? []).map((row) => mapSourceOfSalesSummary(row as Record<string, unknown>)),
  });

  // Resolve display NAMES live from the masters for regions, areas, and bricks. Historical imports
  // (and aggregated sheets that only carry a code or an Arabic territory) stored the raw code as the
  // label; overriding the label here self-heals the dashboard without a re-import so every group shows
  // its master name, never a bare code. The queries were started in parallel at the top of this fn.
  const [brickNamesResult, regionNamesResult, areaNamesResult] = await Promise.all([
    brickNamesPromise,
    regionNamesPromise,
    areaNamesPromise,
  ]);

  // region_code → region_name
  const regionNameByCode = new Map<string, string>();
  if (!regionNamesResult.error) {
    for (const row of regionNamesResult.data ?? []) {
      const code = normalizeCode(String(row.region_code ?? ""));
      const name = String(row.region_name ?? "");
      if (code && name) regionNameByCode.set(code, name);
    }
  }
  // area_code → { name, region_code } (region_code lets an area resolve its parent region name)
  const areaInfoByCode = new Map<string, { name: string; regionCode: string }>();
  if (!areaNamesResult.error) {
    for (const row of areaNamesResult.data ?? []) {
      const code = normalizeCode(String(row.area_code ?? ""));
      const name = String(row.area_name ?? "");
      if (code) areaInfoByCode.set(code, { name, regionCode: normalizeCode(String(row.region_code ?? "")) });
    }
  }
  // brick_id → brick_name
  const brickNameById = new Map<string, string>();
  if (!brickNamesResult.error) {
    for (const row of brickNamesResult.data ?? []) {
      const code = normalizeCode(String(row.brick_id ?? ""));
      const name = String(row.brick_name ?? "");
      if (code && name) brickNameById.set(code, name);
    }
  }

  // The master is the source of truth for IDENTITY as well as for names: it both heals the label
  // and decides which groups are the same place. See mergeDashboardGroupsByCode for why a code the
  // master does not know is deliberately left unmerged rather than folded in on its label.
  const byRegion = labelUnmappedGroups(mergeDashboardGroupsByCode(dashboard.byRegion, (code) => {
    const name = regionNameByCode.get(code);
    return name ? { label: name } : null;
  }));
  const byArea = labelUnmappedGroups(mergeDashboardGroupsByCode(dashboard.byArea, (code) => {
    const info = areaInfoByCode.get(code);
    if (!info) return null;
    // The area's parent column (group.line) holds the region label; resolve it to the region name
    // too. `label`/`line` fall back to the group's own values when the master row is name-less.
    return { label: info.name || undefined, line: (info.regionCode ? regionNameByCode.get(info.regionCode) : undefined) ?? undefined };
  }));
  const byBrick = labelUnmappedGroups(mergeDashboardGroupsByCode(dashboard.byBrick, (code) => {
    const name = brickNameById.get(code);
    return name ? { label: name } : null;
  }));

  return { ...dashboard, byArea, byBrick, byRegion };
}

function sourceOfSalesSummaryRows(batchId: string, result: DistributorSalesValidationResult) {
  return [
    ...result.byLine.map((row) => ({
      batch_id: batchId,
      group_type: "line",
      group_key: row.line,
      group_label: row.line,
      group_code: null,
      official_line: row.line,
      row_count: row.rowCount,
      total_qty: row.totalQty,
      total_bonus_qty: row.totalBonusQty,
      total_value: row.totalValue,
    })),
    ...result.byRegion.map((row) => ({
      batch_id: batchId,
      group_type: "region",
      group_key: `${row.regionCode}|${row.regionName}`,
      group_label: row.regionName,
      group_code: row.regionCode,
      official_line: null,
      row_count: row.rowCount,
      total_qty: row.totalQty,
      total_bonus_qty: row.totalBonusQty,
      total_value: row.totalValue,
    })),
    ...result.byArea.map((row) => ({
      batch_id: batchId,
      group_type: "area",
      group_key: `${row.areaCode}|${row.areaName}|${row.regionCode}`,
      group_label: row.areaName,
      group_code: row.areaCode,
      official_line: row.regionName || row.regionCode,
      row_count: row.rowCount,
      total_qty: row.totalQty,
      total_bonus_qty: row.totalBonusQty,
      total_value: row.totalValue,
    })),
    ...result.byProduct.map((row) => ({
      batch_id: batchId,
      group_type: "product",
      group_key: `${row.productCode}|${row.productName}|${row.officialLine}`,
      group_label: row.productName,
      group_code: row.productCode,
      official_line: row.officialLine,
      row_count: row.rowCount,
      total_qty: row.totalQty,
      total_bonus_qty: row.totalBonusQty,
      total_value: row.totalValue,
    })),
    ...result.byBrick.map((row) => ({
      batch_id: batchId,
      group_type: "brick",
      group_key: `${row.brickId}|${row.brickName}|${row.areaCode}|${row.regionCode}`,
      group_label: row.brickName,
      group_code: row.brickId,
      official_line: row.areaName || row.areaCode,
      row_count: row.rowCount,
      total_qty: row.totalQty,
      total_bonus_qty: row.totalBonusQty,
      total_value: row.totalValue,
    })),
  ];
}

async function insertSourceOfSalesRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  batchId: string,
  rows: ParsedDistributorRow[],
) {
  const inserts = rows.map((row) => ({
    area_code: row.areaCode,
    area_name: row.areaName,
    batch_id: batchId,
    block_code: row.blockCode,
    brick_id: row.brickId,
    client_address: row.clientAddress,
    client_code: row.clientCode,
    client_name: row.clientName,
    row_number: row.rowNumber,
    distributor_code: row.distributorCode,
    invoice_date: row.invoiceDate,
    invoice_period: row.invoicePeriod,
    region_name: row.regionName,
    region_code: row.regionCode,
    product_name: row.productName,
    product_code: row.productCode,
    official_line: row.officialLine,
    qty: Number.isFinite(row.qty) ? row.qty : 0,
    bonus_qty: Number.isFinite(row.bonusQty) ? row.bonusQty : 0,
    discount: Number.isFinite(row.discount) ? row.discount : 0,
    value: Number.isFinite(row.value) ? row.value : 0,
    is_direct: row.isDirect ?? false,
    validation_state: row.validationState,
    validation_issues: row.validationIssues,
    raw_row: row.rawRow,
  }));

  for (let index = 0; index < inserts.length; index += 500) {
    const { error } = await supabase
      .from("source_of_sales_import_rows")
      .insert(inserts.slice(index, index + 500));
    if (error) throw error;
  }
}

/** The slice of the client the lock read uses — structural, so a test can hand it a fake. */
type PeriodLockReader = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq: (column: string, value: unknown) => {
          maybeSingle: () => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
        };
      };
    };
  };
};

// PostgREST answers a missing table with PGRST205 and Postgres with 42P01 — the only two errors
// that mean "this deployment has no lock table", which is the one case read as "not locked".
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);

// Period lock guard — once a Monthly Sales period is locked, all uploads/deletes for that period are
// rejected until it is re-opened. Tolerant of a missing lock table (pre-migration = not locked) so it
// never blocks a normal upload before the Monthly Sales migration is applied.
//
// 🔴 ANY OTHER READ ERROR REFUSES, with a 503 (audit S-SAL-09, 2026-10-23). It used to return as
// "not locked" on every error, so a timeout let an upload for a LOCKED month write its rows; the SQL
// lock caught it only after the rows were inserted, leaving an orphan pending batch behind. A month
// whose lock cannot be read is not a month known to be open.
export async function assertPeriodNotLocked(period: string | null, client?: PeriodLockReader): Promise<void> {
  if (!period) return;
  const supabase = client ?? (getSupabaseAdmin() as unknown as PeriodLockReader);
  const { data, error } = await supabase
    .from("monthly_sales_period_lock")
    .select("locked")
    .eq("period", period)
    .eq("locked", true)
    .maybeSingle();
  if (error) {
    if (MISSING_TABLE_CODES.has(String(error.code ?? ""))) return;
    throw new SalesWorkflowError(
      "period_lock_unreadable",
      `Could not check whether ${period} is locked, so nothing was changed. Try again in a minute.`,
      503,
    );
  }
  if (data) {
    throw new SalesWorkflowError(
      "period_locked",
      `${period} is locked. Re-open the Monthly Sales closing for ${period} before changing its uploads.`,
      409,
    );
  }
}

// Shared persist step: insert the batch + its rows + summaries. Used by both the File-based upload and
// the in-memory buffer-based upload (the Normalizer's validated import).
export async function persistDistributorSalesUpload(
  parsed: DistributorSalesValidationResult & { parsedRows: ParsedDistributorRow[] },
  uploadedBy: string,
) {
  const { parsedRows, ...result } = parsed;

  // Locked period: reject before writing anything (covers normal, normalizer-buffer, and Office paths).
  await assertPeriodNotLocked(result.period);

  // The same workbook already loaded under another period: refuse before writing anything, with
  // exactly the figures the insert below stores (see import-duplicate-guard.ts). Only a batch that
  // will become sales is checked; a blocked one is kept for its reasons and never counts.
  if (result.status === "validated") {
    // Each stored batch is compared on ITS month's price basis, so a file re-dated across a reprice
    // (September's file loaded again as October) still reads as the same file — see totalValueAtPeriod.
    // Office rows arrive here too, valued at the master price in every month, so they keep their value.
    const prices = await loadProductPeriodPrices();
    const repriceable = parsedRows.map((row) =>
      repriceableUploadRow({
        distributorCode: row.distributorCode,
        isDirect: row.isDirect,
        period: row.invoicePeriod,
        productCode: row.productCode,
        value: row.value,
      }),
    );
    await assertNotADuplicateUpload({
      distributorCode: result.distributor.code,
      fileName: result.fileName,
      period: result.period,
      totalRows: result.rowCount,
      totalQty: result.totals.totalQty,
      totalValue: result.totals.totalValue,
      totalValueAt: (period) => totalValueAtPeriod(repriceable, prices, period),
    });
  }

  const supabase = getSupabaseAdmin();

  // A batch that will become validated is inserted as 'pending' first — invisible to every
  // rollup/refresh function and to the one-validated-batch-per-period index — so the old good
  // batch for this distributor + period is only ever superseded inside the SAME atomic
  // transaction that finishes validating this one (phx_finalize_sos_batch below). A bad upload
  // can never destroy a previously-good batch.
  const batchInsert = await supabase
    .from("source_of_sales_import_batches")
    .insert({
      distributor_code: result.distributor.code,
      distributor_name: result.distributor.name,
      template_key: result.templateKey,
      file_name: result.fileName,
      sheet_name: result.sheetName,
      period: result.period,
      status: result.status === "validated" ? "pending" : result.status,
      total_rows: result.rowCount,
      importable_rows: result.importableRows,
      failed_rows: result.failedRows,
      warning_rows: result.warningRows,
      total_qty: result.totals.totalQty,
      total_bonus_qty: result.totals.totalBonusQty,
      total_value: result.totals.totalValue,
      blocking_reasons: result.blockingReasons,
      uploaded_by: uploadedBy,
    })
    .select("id,created_at")
    .single();

  if (batchInsert.error) throw batchInsert.error;

  const batchId = String(batchInsert.data.id);
  await insertSourceOfSalesRows(supabase, batchId, parsedRows);

  const summaries = sourceOfSalesSummaryRows(batchId, result);
  if (summaries.length > 0) {
    const { error } = await supabase.from("source_of_sales_import_summaries").insert(summaries);
    if (error) throw error;
  }

  if (result.status === "validated" && result.period) {
    await finalizeSosBatchAndAuditSupersede({
      batchId,
      distributorCode: result.distributor.code,
      period: result.period,
      actorLoginId: uploadedBy,
    });
  } else if (result.status === "validated") {
    // Defensive fallback for a validated batch with no resolvable single period (e.g. a
    // multi-period sheet) — nothing sensible to dedupe/lock on without a period key, so promote
    // directly and refresh each rollup individually, exactly as before atomic finalize existed.
    const promote = await supabase
      .from("source_of_sales_import_batches")
      .update({ status: "validated", blocking_reasons: [] })
      .eq("id", batchId);
    if (promote.error) throw promote.error;
    const rollupRefresh = await supabase.rpc("phx_refresh_sos_fact_rollup", { p_batch_id: batchId });
    if (rollupRefresh.error) throw rollupRefresh.error;
    const customerRollupRefresh = await supabase.rpc("phx_refresh_sos_customer_directory_rollup", { p_batch_id: batchId });
    if (customerRollupRefresh.error) throw customerRollupRefresh.error;
    const roiRefresh = await supabase.rpc("phx_refresh_marketing_roi_facts", { p_batch_id: batchId });
    if (roiRefresh.error) throw roiRefresh.error;
    // Channel totals rollup — after fact+directory, which it reads. The main (period-known) path
    // gets this inside phx_finalize_sos_batch; this fallback refreshes each rollup individually.
    const channelRollupRefresh = await supabase.rpc("phx_refresh_sos_channel_rollup", { p_batch_id: batchId });
    if (channelRollupRefresh.error) throw channelRollupRefresh.error;
    // Distributor×product rollup — after the fact rollup it reads, same fallback site.
    const distProductRollupRefresh = await supabase.rpc("phx_refresh_sos_distributor_product_rollup", { p_batch_id: batchId });
    if (distProductRollupRefresh.error) throw distProductRollupRefresh.error;
  }

  // 🔴 GATED ON validated, unlike the same tail in normalizer/service.ts. That commit path is
  // only ever reached by an accepted upload; this one also runs for a REJECTED batch, which
  // refreshes no rollup at all today and must keep not refreshing one. The gate is the SAME
  // condition both branches above already test, lifted out so neither branch owns the tail.
  if (result.status === "validated") {
    // ── THE SPLIT NET, THEN ATTRIBUTION — ONE SHARED TAIL, OUTSIDE BOTH BRANCHES ────────────
    //
    // 🔴 THIS USED TO SIT INSIDE THE FALLBACK ABOVE, and that is the whole defect. The period-known
    // path calls phx_finalize_sos_batch, which refreshes the attribution rollup INSIDE its own SQL
    // transaction and knows nothing about au.monthly_store_split_net — so every real upload rebuilt
    // achievement from fresh sales against the PREVIOUS import's split, with no error anywhere.
    //
    // It cannot run BEFORE finalize either: writeStoreSplitNetForBatch resolves the batch's periods
    // from source_of_sales_fact_rollup, which finalize is what populates. Called earlier it finds no
    // periods and silently does nothing — the same failure, one step to the left.
    //
    // So it lives here, after the whole if/else, where BOTH paths reach it and the fact rows are
    // current either way: write the net, then refresh attribution on top of it. On the finalize path
    // that is a second attribution refresh, which is the price of keeping finalize atomic.
    await writeStoreSplitNetForBatch(supabase, batchId);
    const attributionAfterNet = await supabase.rpc("phx_refresh_monthly_attribution", { p_batch_id: batchId });
    if (attributionAfterNet.error) throw attributionAfterNet.error;
    // Import summaries beside it, so "every site that refreshes the rollups also refreshes the
    // summaries" holds with no exceptions. See tests/sos-import-summaries-refresh.test.ts.
    const summariesAfterNet = await supabase.rpc("phx_refresh_sos_import_summaries", { p_batch_id: batchId });
    if (summariesAfterNet.error) throw summariesAfterNet.error;
    // The cache bust belongs LAST, for the same reason the net does. Both paths busted it too
    // early: the fallback did it before this tail existed, and the finalize path does it inside
    // finalizeSosBatchAndAuditSupersede — in both cases before the net is written, so the very next
    // dashboard read re-cached the attribution the net had not reached yet and held it for the
    // full TTL. Those earlier busts are harmless and stay; this one is the one that matters.
    invalidateSalesDashboardCache("source of sales import — split net written, attribution refreshed");
  }

  return {
    ...result,
    batchId,
    createdAt: String(batchInsert.data.created_at),
  };
}

export async function createSourceOfSalesUpload(input: {
  distributorCode: string;
  file: File;
  uploadedBy: string;
  periodOverride?: string;
  // Dry run (preview): parse + validate but DO NOT persist. Returns the validation result WITH
  // parsedRows attached (batchId/createdAt null) so the caller can build the import-preview diff.
  dryRun?: boolean;
}) {
  const references = await loadSalesReferenceData();
  const buffer = await input.file.arrayBuffer();
  const parsed = await parseDistributorSalesWorkbookBuffer({
    buffer,
    distributorCode: input.distributorCode,
    fileName: input.file.name,
    references,
    periodOverride: input.periodOverride,
  });
  if (input.dryRun) {
    return { ...parsed, batchId: null as string | null, createdAt: null as string | null };
  }
  return persistDistributorSalesUpload(parsed, input.uploadedBy);
}

// Buffer-based upload — the Normalizer's one-click "Import (validated)" path builds the coded workbook in
// memory (no temp file) and runs it through the SAME validator + insert as a normal upload. With
// persistOnlyIfValidated, a blocked result is returned WITHOUT writing anything (fail-closed), so a
// mis-coded sheet can never silently land. batchId/createdAt are null when not persisted.
export async function createSourceOfSalesUploadFromBuffer(input: {
  buffer: ArrayBuffer | Buffer;
  distributorCode: string;
  fileName: string;
  persistOnlyIfValidated?: boolean;
  uploadedBy: string;
  periodOverride?: string;
  // Dry run (preview): parse + validate but DO NOT persist. Returns the validation result WITH
  // parsedRows attached (batchId/createdAt null) so the caller can build the import-preview diff.
  dryRun?: boolean;
}) {
  const references = await loadSalesReferenceData();
  const parsed = await parseDistributorSalesWorkbookBuffer({
    buffer: input.buffer,
    distributorCode: input.distributorCode,
    fileName: input.fileName,
    references,
    periodOverride: input.periodOverride,
  });
  if (input.dryRun) {
    // Preview: keep parsedRows so the caller can diff the customers; never persist.
    return { ...parsed, batchId: null as string | null, createdAt: null as string | null };
  }
  if (input.persistOnlyIfValidated && parsed.status !== "validated") {
    // Blocked: return the validation result WITHOUT persisting (fail-closed); drop parsedRows.
    const { parsedRows, ...result } = parsed;
    void parsedRows;
    return { ...result, batchId: null as string | null, createdAt: null as string | null };
  }
  return persistDistributorSalesUpload(parsed, input.uploadedBy);
}

export async function validateDistributorSalesFile(input: {
  distributorCode: string;
  file: File;
}) {
  const references = await loadSalesReferenceData();
  const buffer = await input.file.arrayBuffer();
  return validateDistributorSalesWorkbookBuffer({
    buffer,
    distributorCode: input.distributorCode,
    fileName: input.file.name,
    references,
  });
}

export async function deleteSourceOfSalesUploadBatch(input: {
  actorLoginId: string;
  batchId: string;
}) {
  const supabase = getSupabaseAdmin();
  const { data: existing, error: existingError } = await supabase
    .from("source_of_sales_import_batches")
    .select("id,file_name,distributor_code,period,status")
    .eq("id", input.batchId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (!existing) return null;

  // Locked period: deletes are frozen too, so a locked month can't be quietly altered.
  await assertPeriodNotLocked(existing.period ? String(existing.period) : null);

  const { error } = await supabase
    .from("source_of_sales_import_batches")
    .delete()
    .eq("id", input.batchId);
  if (error) throw error;

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: input.batchId,
    entityType: "sales_import_batch",
    oldValues: {
      distributorCode: existing.distributor_code,
      fileName: existing.file_name,
      period: existing.period,
      source: "source_of_sales",
      status: existing.status,
    },
    summary: "Source of Sales uploaded sheet deleted.",
  });

  return true;
}

// =====================================================================================
// Monthly Closing — manager-facing Sales-vs-Target report built from the uploaded
// distributor data. Phase 1 surfaces Sales Units/Value per Area x Product for one Line
// and one Month, rolled up Area -> Region (subtotal) -> National (grand total). Target/
// Achievement slots are reserved but stay null until the Phase 2 targets upload exists.
// =====================================================================================

export type MonthlyClosingCell = {
  achievement: number | null;
  salesUnits: number;
  salesValue: number;
  targetUnits: number | null;
  targetValue: number | null;
};

export type MonthlyClosingColumn = {
  family: string;
  productCode: string;
  productName: string;
};

export type MonthlyClosingAreaRow = {
  areaCode: string;
  areaName: string;
  cells: MonthlyClosingCell[];
  // "This row contains direct money" — NOT "this row is the anonymous company Direct row".
  // True for the synthetic "Direct" row injected inside a region (company direct sales) AND, since
  // July 2026's direct orders were restated to area grain, for a REAL area that absorbed hand-mapped
  // direct. Dakahlia 1 is still Dakahlia 1 and must keep its own code and name.
  // To ask "is this the synthetic pseudo-area?" use isSyntheticDirectArea (lib/sales/closing-direct-area)
  // — reading this flag for that question renames real areas and drops them out of every filter.
  isDirect?: boolean;
  kind: "area";
  regionCode: string;
  regionName: string;
  rowTotal: MonthlyClosingCell;
  // Where the area sits GEOGRAPHICALLY, kept only when the organogram moved it somewhere else on
  // this line. Access scoping resolves a viewer by their region NAME, and every Upper Egypt
  // employee is labelled "Upper Egypt" — never "Upper Egypt 1"/"Upper Egypt 2" — so without this
  // a split line would match no region for them and fail OPEN to the whole company.
  sourceRegionCode?: string;
  sourceRegionName?: string;
  // Set by applyStoreSplitToMatrix (store/wholesaler sales moved in or out by the city split) OR
  // by markMergedAreaRowsStatic (closing-area-merges.ts — this row folds in another area's sales
  // under one area code, e.g. Pedia/CNS's Fayoum-Beni Suef). Either way, this row's cached numbers
  // do not match what a live SUMIFS over the raw Data-sheet rows would give, so the export must
  // render it as static values — a live formula would recalculate straight back to the wrong
  // (pre-split, or single-area) figure.
  storeSplitAdjusted?: boolean;
};

export type MonthlyClosingSubtotalRow = {
  cells: MonthlyClosingCell[];
  kind: "regionSubtotal";
  regionCode: string;
  regionName: string;
  rowTotal: MonthlyClosingCell;
  // Same contract as MonthlyClosingAreaRow.storeSplitAdjusted — set when the split's net across
  // this region's areas is non-zero (a city crossing regions, or a filtered matrix).
  storeSplitAdjusted?: boolean;
};

export type MonthlyClosingRegionGroup = {
  areas: MonthlyClosingAreaRow[];
  regionCode: string;
  regionName: string;
  subtotal: MonthlyClosingSubtotalRow;
};

export type MonthlyClosingGrandTotalRow = {
  cells: MonthlyClosingCell[];
  kind: "grandTotal";
  rowTotal: MonthlyClosingCell;
  // Same contract as MonthlyClosingAreaRow.storeSplitAdjusted — only a filtered matrix can leave
  // a non-zero net at this level; a whole-month split always cancels to zero here.
  storeSplitAdjusted?: boolean;
};

export type MonthlyClosingMatrix = {
  availableLines: string[];
  availablePeriods: string[];
  columns: MonthlyClosingColumn[];
  // Direct (company) "National" bucket — orders tied to no region, shown as its own row after
  // the national grand total. Null when there is no national-direct data.
  companyTotal?: MonthlyClosingGrandTotalRow | null;
  directNational?: MonthlyClosingSubtotalRow | null;
  grandTotal: MonthlyClosingGrandTotalRow;
  line: string | null;
  period: string | null;
  // Set ONLY by mergeMonthlyClosingMatrices (monthly-closing-period-merge.ts) — every month folded
  // into this matrix, oldest first. Undefined on a matrix built for a single month, so its absence
  // means "one month" and never "unknown". `period` above stays the LATEST of them, so a caller
  // that needs one real month still reads one; a caller that must refuse a multi-month selection
  // (publish, lock) asks this field instead of trying to parse `period`.
  periods?: string[];
  regions: MonthlyClosingRegionGroup[];
};

export type MonthlyClosingAggregateCell = {
  areaCode: string;
  productCode: string;
  salesUnits: number;
  salesValue: number;
};

/**
 * One target cell (area × product) for the selected line and month, from au.monthly_targets.
 *
 * Targets ride the AREA, not the person, so they line up with the matrix's own grain exactly.
 * An area/product with no target row simply has no entry here — it must render "—", never 0.
 * "Other" areas carry no target by design, and the Direct channel has no area, so neither ever
 * appears in this list.
 */
export type MonthlyClosingTargetCell = {
  areaCode: string;
  productCode: string;
  targetUnits: number | null;
  targetValue: number | null;
};

// One direct-sales aggregate cell (region × area × product). Region may be a real code or "NATIONAL".
//
// `areaCode` is BLANK for every direct row booked before the Direct Orders module started stamping
// geography (all of 2026-02 … 2026-06, and 2026-07's rows in the database). Those rows genuinely have
// no area, so they keep the named "Direct orders (company)" row they have always had — spreading them
// would be inventing geography. From 2026-08 the module writes the customer's real area and brick, and
// a cell that HAS an area belongs in that area's row: `au.f_monthly_attribution` already credits the
// area's rep for exactly this money (verified on 2026-08 prod), so leaving the matrix anonymous made
// the closing contradict the company's own rep attribution.
export type MonthlyClosingDirectCell = {
  /** Real sales area, or "" when the row carries none. Never "DIRECT" — that is a display code. */
  areaCode?: string;
  productCode: string;
  regionCode: string;
  salesUnits: number;
  salesValue: number;
};

// UE-1 / UE-2 sit exactly where the single "UE" used to: on a line whose organogram splits Upper
// Egypt across two district managers, the reader still expects to find Upper Egypt in that slot.
// Exported for the same reason the store-split arithmetic below is: this is the sequence readers
// recognise from Monthly Closing, and any report that re-declares it is free to drift away from it.
export const MONTHLY_CLOSING_REGION_ORDER = ["CA", "GZ", "UE", "UE-1", "UE-2", "AB", "D1", "D2", "D3", "OT"] as const;

export function monthlyClosingRegionRank(regionCode: string) {
  const index = MONTHLY_CLOSING_REGION_ORDER.indexOf(regionCode as (typeof MONTHLY_CLOSING_REGION_ORDER)[number]);
  return index === -1 ? MONTHLY_CLOSING_REGION_ORDER.length : index;
}

// Moved to ./monthly-closing-matrix-cells.ts (a dependency-free module, imported at the top of this
// file) so the client components that only need this pure roll-up don't pull this file's
// server-only chain into their bundle; re-exported here for existing server callers, and still used
// below by buildMonthlyClosingMatrix and the rest of this file.
export { addClosingSales, emptyClosingCell, roundedClosingCell, sumClosingRowTotal };

/**
 * Pure matrix builder. Aggregates ONLY at the area layer; region subtotals and the
 * national grand total are derived from the area rows, so each area is counted exactly
 * once and region/total rows never get summed on top of the areas (no double counting).
 */
export function buildMonthlyClosingMatrix(input: {
  areas: SalesAreaReference[];
  availableLines: string[];
  availablePeriods: string[];
  cells: MonthlyClosingAggregateCell[];
  line: string | null;
  period: string | null;
  products: SalesProductReference[];
  /** Area × product targets for this line/month. Absent ⇒ every target column renders "—". */
  targets?: MonthlyClosingTargetCell[];
}): MonthlyClosingMatrix {
  const columns: MonthlyClosingColumn[] = input.products
    .map((product) => ({
      family: normalizeDisplay(product.family),
      productCode: normalizeCode(product.productCode),
      productName: normalizeDisplay(product.productName) || normalizeCode(product.productCode),
    }))
    .sort(
      (left, right) =>
        left.family.localeCompare(right.family) || left.productName.localeCompare(right.productName),
    );

  const cellLookup = new Map<string, MonthlyClosingAggregateCell>();
  input.cells.forEach((cell) => {
    cellLookup.set(`${normalizeCode(cell.areaCode)} ${normalizeCode(cell.productCode)}`, cell);
  });

  const targetLookup = new Map<string, MonthlyClosingTargetCell>();
  (input.targets ?? []).forEach((target) => {
    targetLookup.set(`${normalizeCode(target.areaCode)} ${normalizeCode(target.productCode)}`, target);
  });

  const sortedAreas = [...input.areas].sort((left, right) => {
    const leftRegion = normalizeCode(left.regionCode);
    const rightRegion = normalizeCode(right.regionCode);
    const rankDelta = monthlyClosingRegionRank(leftRegion) - monthlyClosingRegionRank(rightRegion);
    if (rankDelta !== 0) return rankDelta;
    if (leftRegion !== rightRegion) return leftRegion.localeCompare(rightRegion);
    return normalizeCode(left.areaCode).localeCompare(normalizeCode(right.areaCode));
  });

  const areaRowsByRegion = new Map<string, MonthlyClosingAreaRow[]>();
  const regionNames = new Map<string, string>();

  sortedAreas.forEach((area) => {
    const regionCode = normalizeCode(area.regionCode);
    const areaCode = normalizeCode(area.areaCode);
    const cells = columns.map((column) => {
      const aggregate = cellLookup.get(`${areaCode} ${column.productCode}`);
      const cell = emptyClosingCell();
      if (aggregate) {
        cell.salesUnits = aggregate.salesUnits;
        cell.salesValue = aggregate.salesValue;
      }
      // A target with no matching sales still belongs on the grid — an area that sold nothing
      // against a real target is exactly the row a reader is looking for.
      const target = targetLookup.get(`${areaCode} ${column.productCode}`);
      if (target) {
        cell.targetUnits = target.targetUnits;
        cell.targetValue = target.targetValue;
      }
      return roundedClosingCell(cell);
    });
    const row: MonthlyClosingAreaRow = {
      areaCode,
      areaName: normalizeDisplay(area.areaName) || areaCode,
      cells,
      kind: "area",
      regionCode,
      regionName: normalizeDisplay(area.regionName) || regionCode,
      rowTotal: sumClosingRowTotal(cells),
      ...(area.sourceRegionCode
        ? {
          sourceRegionCode: normalizeCode(area.sourceRegionCode),
          sourceRegionName: normalizeDisplay(area.sourceRegionName) || normalizeCode(area.sourceRegionCode),
        }
        : {}),
    };
    if (!areaRowsByRegion.has(regionCode)) areaRowsByRegion.set(regionCode, []);
    areaRowsByRegion.get(regionCode)?.push(row);
    if (!regionNames.has(regionCode)) regionNames.set(regionCode, row.regionName);
  });

  const regions: MonthlyClosingRegionGroup[] = [...areaRowsByRegion.entries()].map(([regionCode, areas]) => {
    const subtotalCells = columns.map((_column, columnIndex) => {
      const cell = emptyClosingCell();
      areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex]));
      return roundedClosingCell(cell);
    });
    const regionName = regionNames.get(regionCode) ?? regionCode;
    return {
      areas,
      regionCode,
      regionName,
      subtotal: {
        cells: subtotalCells,
        kind: "regionSubtotal",
        regionCode,
        regionName,
        rowTotal: sumClosingRowTotal(subtotalCells),
      },
    };
  });

  const grandCells = columns.map((_column, columnIndex) => {
    const cell = emptyClosingCell();
    regions.forEach((region) => {
      region.areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex]));
    });
    return roundedClosingCell(cell);
  });

  return {
    availableLines: input.availableLines,
    availablePeriods: input.availablePeriods,
    columns,
    grandTotal: {
      cells: grandCells,
      kind: "grandTotal",
      rowTotal: sumClosingRowTotal(grandCells),
    },
    line: input.line,
    period: input.period,
    regions,
  };
}

/** Direct money for one month, already resolved down to (areaCode, productCode). */
type JulyDirectByArea = {
  /** `${areaCode}|${productCode}` → the area's own direct units and value, exactly as submitted. */
  byAreaProduct: Map<string, { salesUnits: number; salesValue: number }>;
  /** Direct that belongs to no area (the National Sales Manager's own orders), by product code. */
  areaLessByProduct: Map<string, { salesUnits: number; salesValue: number }>;
  /**
   * `areaCode` → the region the mapping put it in. Needed to place direct whose area is absent from
   * the matrix: without it such money has no home and was silently dropped.
   */
  regionByArea: Map<string, string>;
};

/**
 * Resolve July 2026's hand-mapped direct sales to (area, product), or null to leave the matrix
 * exactly as it behaves today.
 *
 * Returns null — deliberately, and silently in the sense that the old layout simply persists —
 * whenever it cannot prove the mapping describes the SAME money the direct RPC returned:
 *   * the period is not July 2026 (every other month has no area mapping at all);
 *   * the mapping totals and the RPC totals disagree by more than a piastre.
 *
 * That reconciliation is the whole safety property. The mapping and the RPC are two descriptions
 * of one month at different grains; if they ever drift apart, merging one into the matrix while
 * the other set the region rows would move the month's reported total. Falling back to the
 * untouched region behaviour is always recoverable — a wrong total is not.
 */
function resolveJulyDirectByArea(
  matrix: MonthlyClosingMatrix,
  directCells: MonthlyClosingDirectCell[],
): JulyDirectByArea | null {
  if (matrix.period !== JULY_2026_DIRECT_PERIOD) return null;

  const line = (matrix.line ?? "").trim().toLowerCase();
  const mapped = line
    ? JULY_2026_DIRECT_ROWS.filter((row) => row.line.trim().toLowerCase() === line)
    : JULY_2026_DIRECT_ROWS;
  if (mapped.length === 0) return null;

  // Compare on the products this line's matrix actually shows: the RPC and the closing both drop
  // LA003/LA004/SS001, so counting a mapped row for a product with no column would guarantee a
  // false mismatch and permanently disable the merge.
  const columnCodes = new Set(matrix.columns.map((column) => normalizeCode(column.productCode)));
  const inScope = mapped.filter((row) => columnCodes.has(normalizeCode(row.productCode)));

  const mappedValue = inScope.reduce((sum, row) => sum + row.value, 0);
  const rpcValue = directCells
    .filter((cell) => columnCodes.has(normalizeCode(cell.productCode)))
    .reduce((sum, cell) => sum + cell.salesValue, 0);
  if (Math.abs(mappedValue - rpcValue) > 0.01) return null;

  const byAreaProduct = new Map<string, { salesUnits: number; salesValue: number }>();
  const areaLessByProduct = new Map<string, { salesUnits: number; salesValue: number }>();
  const add = (
    target: Map<string, { salesUnits: number; salesValue: number }>,
    key: string,
    units: number,
    value: number,
  ) => {
    const entry = target.get(key) ?? { salesUnits: 0, salesValue: 0 };
    entry.salesUnits += units;
    entry.salesValue += value;
    target.set(key, entry);
  };

  const regionByArea = new Map<string, string>();
  inScope.forEach((row) => {
    const productCode = normalizeCode(row.productCode);
    const areaCode = normalizeCode(row.areaCode);
    if (areaCode) {
      add(byAreaProduct, `${areaCode}|${productCode}`, row.qty, row.value);
      if (!regionByArea.has(areaCode)) regionByArea.set(areaCode, normalizeCode(row.regionCode));
    } else {
      add(areaLessByProduct, productCode, row.qty, row.value);
    }
  });

  return { areaLessByProduct, byAreaProduct, regionByArea };
}

/**
 * Pure injector. Adds the Direct (company) channel on top of the distributor matrix:
 *  - direct sales that name a REAL AREA fold into that area's own row, which is then flagged
 *    `isDirect` so the export renders it statically;
 *  - direct sales with only a region become a synthetic "Direct" area row inside that region, so
 *    the region subtotal (and hence the grand total) = its areas + Direct;
 *  - direct sales tagged "National" become a separate "Direct – National" row, and the
 *    companyTotal = grand total + Direct National.
 *
 * The area fold is what the Direct Orders module made possible: from 2026-08 it stamps the
 * customer's real area and brick on every row it books, and `au.f_monthly_attribution` already
 * credits that area's rep for the money. Before that the rows carry no area at all, so they take the
 * second bullet and every month up to 2026-07 renders unchanged.
 *
 * Direct value comes straight from the sheet (already aggregated by the direct RPC); no
 * factory-price recompute — that separation is what keeps the locked direct-order pricing rule
 * intact, since the area grid values distributor sales at factory price. Returns a new matrix; when
 * there are no direct cells the matrix is unchanged (directNational / companyTotal = null).
 */
export function injectDirectIntoMatrix(
  matrix: MonthlyClosingMatrix,
  directCells: MonthlyClosingDirectCell[],
): MonthlyClosingMatrix {
  if (directCells.length === 0) {
    return { ...matrix, companyTotal: null, directNational: null };
  }

  const NATIONAL = "NATIONAL";
  const columns = matrix.columns;
  const colIndex = new Map(columns.map((column, index) => [column.productCode, index]));

  // Aggregate direct cells per region (uppercased) into per-column cells.
  const byRegion = new Map<string, MonthlyClosingCell[]>();
  const cellsFor = (region: string) => {
    let arr = byRegion.get(region);
    if (!arr) { arr = columns.map(() => emptyClosingCell()); byRegion.set(region, arr); }
    return arr;
  };
  // Direct money that names its own AREA is kept apart from the region buckets, because it belongs in
  // that area's own row rather than the anonymous Direct row. Adding a cell to BOTH would double the
  // month, so every cell goes to exactly one of these two collections.
  const rpcByAreaProduct = new Map<string, { salesUnits: number; salesValue: number }>();
  const rpcRegionByArea = new Map<string, string>();
  directCells.forEach((cell) => {
    const region = normalizeCode(cell.regionCode);
    const productCode = normalizeCode(cell.productCode);
    const index = colIndex.get(productCode);
    if (index === undefined) return; // product not part of this line's columns
    // The overlay-owned rule, not the presence of an area, decides this. July's placement is the
    // owner's own mapping and is applied separately by applyJulyDirectAreasToBreakdown, so the
    // row's own area must not fold there; every other month honours a manually-placed area (owner
    // ruling 2026-09-01) — see OVERLAY_OWNED_DIRECT_PERIODS.
    const areaCode = directRowsCarryOwnArea(matrix.period) ? normalizeCode(cell.areaCode ?? "") : "";
    if (areaCode) {
      const key = `${areaCode}|${productCode}`;
      const entry = rpcByAreaProduct.get(key) ?? { salesUnits: 0, salesValue: 0 };
      entry.salesUnits += cell.salesUnits;
      entry.salesValue += cell.salesValue;
      rpcByAreaProduct.set(key, entry);
      if (!rpcRegionByArea.has(areaCode)) rpcRegionByArea.set(areaCode, region);
      return;
    }
    const target = cellsFor(region)[index];
    target.salesUnits += cell.salesUnits;
    target.salesValue += cell.salesValue;
  });

  // ── July 2026: direct merges INTO the real area rows ────────────────────────
  // July is the one month whose direct orders were mapped to areas by hand (the Direct Order
  // module went live in August, so July's rows reached Source of Sales with a region but a blank
  // area). The owner ruled that this month's direct money belongs in the areas that earned it,
  // not in a separate "Direct orders (company)" row.
  //
  // The mapping and the direct RPC describe the SAME money at different grains, so they must never
  // both be added. When the mapping applies we use it INSTEAD of the region cells. That is only
  // safe if the two agree, so we reconcile first and fall back to the untouched region behaviour
  // if they do not — a mismatch would silently move the month's total, which is far worse than
  // showing the old layout.
  const julyByArea = resolveJulyDirectByArea(matrix, directCells);
  const regionNameByCode = new Map(matrix.regions.map((region) => [region.regionCode, region.regionName]));
  const makeDirectArea = (regionCode: string, cells: MonthlyClosingCell[]): MonthlyClosingAreaRow => ({
    areaCode: "DIRECT",
    areaName: "Direct",
    cells: cells.map(roundedClosingCell),
    isDirect: true,
    kind: "area",
    regionCode,
    regionName: regionNameByCode.get(regionCode) ?? regionCode,
    rowTotal: sumClosingRowTotal(cells),
  });
  const subtotalOf = (regionCode: string, regionName: string, areas: MonthlyClosingAreaRow[]): MonthlyClosingSubtotalRow => {
    const cells = columns.map((_column, index) => {
      const cell = emptyClosingCell();
      areas.forEach((area) => addClosingSales(cell, area.cells[index]));
      return roundedClosingCell(cell);
    });
    return { cells, kind: "regionSubtotal", regionCode, regionName, rowTotal: sumClosingRowTotal(cells) };
  };

  const present = new Set(matrix.regions.map((region) => region.regionCode));
  let regions: MonthlyClosingRegionGroup[];

  if (julyByArea) {
    // July: fold each area's own direct money into that area's row and emit NO "Direct" row.
    // `isDirect` is set on any area that absorbed direct, because the export writes such rows as
    // static cached values — an area row containing direct must NOT be rendered as a SUMIFS over
    // the Calc sheet, which holds distributor invoice lines only and would silently undercount it.
    // LATENT-DROP GUARD. The merge below only places direct where `areaCode|productCode` matches an
    // existing area row; anything matching nothing used to be discarded with no warning. No live
    // month hits that today (verified 2026-08-05 on all three lines: output is byte-identical with
    // and without this guard), but a mapping that names an area the matrix does not carry would
    // otherwise delete real money from a published headline. Such money now becomes a Direct row.
    //
    // Track the mapping keys the merge actually consumed. Comparing per-region SUMS instead would
    // double-count whenever a direct cell's region differs from the region the matrix files that
    // area under — which is exactly what happens on a line whose regions come from the organogram.
    const consumed = new Set<string>();

    regions = matrix.regions.map((region) => {
      let regionTouched = false;
      const areas = region.areas.map((area) => {
        // Per-AREA flag. A region-scoped flag would mark every later area in the same region as
        // direct-bearing once any one of them absorbed direct, and the export would then render
        // untouched areas as static values instead of live formulas.
        let areaTouched = false;
        const areaCode = normalizeCode(area.areaCode);
        const cells = area.cells.map((cell, index) => {
          const key = `${areaCode}|${normalizeCode(columns[index].productCode)}`;
          const direct = julyByArea.byAreaProduct.get(key);
          if (!direct) return cell;
          areaTouched = true;
          consumed.add(key);
          const merged = { ...cell };
          merged.salesUnits += direct.salesUnits;
          merged.salesValue += direct.salesValue;
          return roundedClosingCell(merged);
        });
        if (!areaTouched) return area;
        regionTouched = true;
        return { ...area, cells, isDirect: true, rowTotal: sumClosingRowTotal(cells) };
      });
      if (!regionTouched) return region;
      return { ...region, areas, subtotal: subtotalOf(region.regionCode, region.regionName, areas) };
    });

    // Emit whatever the merge could not place as a Direct row in the region the mapping named,
    // exactly as every other month already does. Empty on every current month — this exists so a
    // future mapping cannot silently delete money by naming an area the matrix does not carry.
    const leftoverRegions = new Map<string, MonthlyClosingCell[]>();
    julyByArea.byAreaProduct.forEach((direct, key) => {
      if (consumed.has(key)) return;
      const [areaCode, productCode] = key.split("|");
      const index = colIndex.get(normalizeCode(productCode ?? ""));
      if (index === undefined) return;
      const regionCode = julyByArea.regionByArea.get(normalizeCode(areaCode ?? "")) ?? NATIONAL;
      let cells = leftoverRegions.get(regionCode);
      if (!cells) { cells = columns.map(() => emptyClosingCell()); leftoverRegions.set(regionCode, cells); }
      cells[index]!.salesUnits += direct.salesUnits;
      cells[index]!.salesValue += direct.salesValue;
    });

    leftoverRegions.forEach((cells, regionCode) => {
      const index = regions.findIndex((region) => region.regionCode === regionCode);
      if (index >= 0) {
        const region = regions[index]!;
        const areas = [...region.areas, makeDirectArea(regionCode, cells)];
        regions[index] = { ...region, areas, subtotal: subtotalOf(regionCode, region.regionName, areas) };
        return;
      }
      const regionName = regionNameByCode.get(regionCode) ?? regionCode;
      const areas = [makeDirectArea(regionCode, cells)];
      regions.push({ areas, regionCode, regionName, subtotal: subtotalOf(regionCode, regionName, areas) });
    });
  } else {
    // ── Direct that names its own area folds into that area's row ──────────────
    // Same treatment July's hand-mapped orders get above, but driven by the area the Direct Orders
    // module itself recorded rather than a checked-in table. Every month before 2026-08 has a blank
    // area on every direct row, so `rpcByAreaProduct` is empty for them and this loop is a no-op —
    // February through July render exactly as they did.
    const consumed = new Set<string>();
    regions = matrix.regions.map((region) => {
      let regionTouched = false;
      const areas = region.areas.map((area) => {
        // Per-AREA flag, for the same reason the July branch keeps one: a region-wide flag would mark
        // untouched areas as direct-bearing and the export would render them static.
        let areaTouched = false;
        const areaCode = normalizeCode(area.areaCode);
        const cells = area.cells.map((cell, index) => {
          const key = `${areaCode}|${normalizeCode(columns[index].productCode)}`;
          const direct = rpcByAreaProduct.get(key);
          if (!direct) return cell;
          areaTouched = true;
          consumed.add(key);
          const merged = { ...cell };
          merged.salesUnits += direct.salesUnits;
          merged.salesValue += direct.salesValue;
          return roundedClosingCell(merged);
        });
        if (!areaTouched) return area;
        regionTouched = true;
        return { ...area, cells, isDirect: true, rowTotal: sumClosingRowTotal(cells) };
      });
      if (!regionTouched) return region;
      return { ...region, areas, subtotal: subtotalOf(region.regionCode, region.regionName, areas) };
    });

    // LATENT-DROP GUARD, exactly as the July branch has: direct money naming an area this line's
    // matrix does not carry must never vanish. It rejoins its own region's Direct row instead, which
    // keeps the region subtotal and the grand total whole.
    rpcByAreaProduct.forEach((direct, key) => {
      if (consumed.has(key)) return;
      const [areaCode, productCode] = key.split("|");
      const index = colIndex.get(normalizeCode(productCode ?? ""));
      if (index === undefined) return;
      const regionCode = rpcRegionByArea.get(normalizeCode(areaCode ?? "")) ?? NATIONAL;
      const target = cellsFor(regionCode)[index]!;
      target.salesUnits += direct.salesUnits;
      target.salesValue += direct.salesValue;
    });

    // Direct with no area of its own keeps the named "Direct orders (company)" row it has always had.
    regions = regions.map((region) => {
      const direct = byRegion.get(region.regionCode);
      if (!direct) return region;
      const areas = [...region.areas, makeDirectArea(region.regionCode, direct)];
      return { ...region, areas, subtotal: subtotalOf(region.regionCode, region.regionName, areas) };
    });

    // Real direct regions absent from the distributor matrix (no distributor areas there).
    byRegion.forEach((cells, regionCode) => {
      if (regionCode === NATIONAL || present.has(regionCode)) return;
      const regionName = regionNameByCode.get(regionCode) ?? regionCode;
      const areas = [makeDirectArea(regionCode, cells)];
      regions.push({ areas, regionCode, regionName, subtotal: subtotalOf(regionCode, regionName, areas) });
    });
  }

  // Grand total = sum of every region's areas (now including the regional Direct rows).
  const grandCells = columns.map((_column, index) => {
    const cell = emptyClosingCell();
    regions.forEach((region) => region.areas.forEach((area) => addClosingSales(cell, area.cells[index])));
    return roundedClosingCell(cell);
  });
  const grandTotal: MonthlyClosingGrandTotalRow = {
    cells: grandCells,
    kind: "grandTotal",
    rowTotal: sumClosingRowTotal(grandCells),
  };

  // Direct – National row (no region) + the final company total.
  // In July that row carries the National Sales Manager's own direct orders: the owner ruled they
  // are distributed to no area, so they print once, immediately above the total, and are counted
  // only there. Every other month it is the RPC's "NATIONAL" bucket, unchanged.
  const nationalCells = julyByArea
    ? (julyByArea.areaLessByProduct.size > 0
        ? columns.map((column) => {
            const cell = emptyClosingCell();
            const direct = julyByArea.areaLessByProduct.get(normalizeCode(column.productCode));
            if (direct) {
              cell.salesUnits += direct.salesUnits;
              cell.salesValue += direct.salesValue;
            }
            return cell;
          })
        : undefined)
    : byRegion.get(NATIONAL);
  let directNational: MonthlyClosingSubtotalRow | null = null;
  let companyTotal: MonthlyClosingGrandTotalRow | null = null;
  if (nationalCells) {
    const rounded = nationalCells.map(roundedClosingCell);
    directNational = {
      cells: rounded,
      kind: "regionSubtotal",
      regionCode: "NATIONAL",
      regionName: "Direct – National",
      rowTotal: sumClosingRowTotal(nationalCells),
    };
    const companyCells = columns.map((_column, index) => {
      const cell = emptyClosingCell();
      addClosingSales(cell, grandCells[index]);
      addClosingSales(cell, rounded[index]);
      return roundedClosingCell(cell);
    });
    companyTotal = { cells: companyCells, kind: "grandTotal", rowTotal: sumClosingRowTotal(companyCells) };
  }

  return { ...matrix, companyTotal, directNational, grandTotal, regions };
}

// Moved to ./monthly-closing-matrix-cells.ts alongside the cell arithmetic it is built from — the
// portal/admin closing screens and the closing period picker call this directly and are CLIENT
// components; re-exported here for existing server callers (the export routes, the tests).
export { filterMonthlyClosingMatrix } from "./monthly-closing-matrix-cells";

/** The slice of a detail row this rebuild needs — structural, so the details module never has to
 * be imported here (which would be a cycle). `qty` mirrors the RPC's `sum(total_qty)` units and
 * `salesValue` its `sum(effective_units * factory_price)` value, so a rebuilt cell carries the
 * same measures as an RPC-built one. */
export type MatrixRebuildRow = {
  areaCode: string;
  includedInClosing: boolean;
  productCode: string;
  qty: number;
  salesValue: number;
  // Only read under `includeDirect`. Direct rows always arrive `includedInClosing: false`, so the
  // flag is the only way to tell them from a row a filter excluded. `sheetAreaCode` is the FACT
  // area — the one every closing RPC books against, and the one the on-screen matrix placed this
  // direct money in. See ./closing-row-area.ts.
  isDirect?: boolean;
  sheetAreaCode?: string;
};

/**
 * Rebuilds every cell of an already place/product-filtered matrix from raw invoice rows, for the
 * export path where a row-level filter (distributor, Included/Excluded, free-text search) is
 * active. Those filters slice INSIDE an area x product cell, which the aggregate RPCs cannot
 * express — so the cells are re-summed from the exact rows the Data sheet will show, and the
 * matrix ties to the audit pair by construction.
 *
 * What deliberately changes shape here:
 *  - Only rows feeding the closing are summed (Data still lists excluded rows; the CLOSING
 *    matrix has always meant included-only). An Excluded-only filter therefore yields a zero
 *    matrix, which is true: no closing sales exist in that slice.
 *  - Targets and achievement become null BY DEFAULT. Targets are set per area & product for the
 *    whole company; a distributor-sliced actual against a whole-company target would manufacture a
 *    fake achievement %. Blank reads as "—", never as a lie.
 *
 *    EXCEPTION — `preserveTargets`. The portal export rebuilds not to slice by distributor but to
 *    make the Matrix tie to the raw-row Data sheet (store split moves sales between a city's areas,
 *    so the store-split matrix and the pre-split rows disagree cell-by-cell). There the whole of the
 *    viewer's scope IS present, so each area x product cell's sales DO correspond to that cell's
 *    target and the achievement is honest. When `preserveTargets` is set, each rebuilt cell keeps
 *    its skeleton cell's targetUnits/targetValue (achievement re-derives from the rebuilt sales),
 *    so the exported Closing Matrix and Target vs Achievement sheets carry real targets instead of
 *    blanks. Callers slicing by a row-level filter (the admin filtered export) must leave it off.
 *  - Direct (company channel) rows, Direct – National and the company total are dropped BY DEFAULT.
 *    Direct orders are not distributor invoice rows, so no row-level filter can apply to them.
 *
 *    EXCEPTION — `includeDirect`. The portal export must show the reader the same numbers their
 *    Monthly Closing screen shows, and that screen has direct folded into the area rows. Dropping
 *    it there did not read as a filter — it read as MISSING SALES: a manager's July workbook was
 *    short its whole share of 1,059,259.65 EGP (Pedia) / 149,288.50 (Anti Infective), with nothing
 *    on any sheet saying so, because the Total sheet's direct bridge was left at its zero default
 *    too. When set, direct rows are folded into their area x product cell keyed by the FACT area.
 *    The caller MUST then also state the folded figure on the Total sheet (`directInMatrix`), or
 *    the workbook silently stops tying to its own Data sheet, which lists invoice lines only.
 *  - Areas keep their row even at zero — the place skeleton is the filtered matrix's, so "this
 *    distributor sold nothing in Mansoura" stays visible instead of vanishing.
 */
export function rebuildMatrixFromRows(
  matrix: MonthlyClosingMatrix,
  rows: MatrixRebuildRow[],
  options?: { preserveTargets?: boolean; includeDirect?: boolean },
): MonthlyClosingMatrix {
  const preserveTargets = options?.preserveTargets === true;
  const includeDirect = options?.includeDirect === true;
  const sums = new Map<string, { salesUnits: number; salesValue: number }>();
  rows.forEach((row) => {
    // Direct rows always come back `includedInClosing: false`, so they are reached only here.
    const directRow = includeDirect && row.isDirect === true;
    if (!row.includedInClosing && !directRow) return;
    // Invoice rows keep the resolved area they have always been keyed by; only direct is keyed by
    // the FACT area, which is where the on-screen matrix put it. Changing the invoice key would
    // move a hand-apportioned customer's rows between areas — a different bug, not this one.
    const areaCode = directRow ? (row.sheetAreaCode ?? row.areaCode) : row.areaCode;
    const key = `${normalizeCode(areaCode)} ${normalizeCode(row.productCode)}`;
    const entry = sums.get(key) ?? { salesUnits: 0, salesValue: 0 };
    entry.salesUnits += row.qty;
    entry.salesValue += row.salesValue;
    sums.set(key, entry);
  });

  // `skeleton` is the cell from the (already viewer-scoped) input matrix for this area x product —
  // the only place the target lives, since the rows carry no target dimension. Rebuilt sales
  // replace its sales; its target is kept only when `preserveTargets` is set.
  const cellFor = (areaCode: string, productCode: string, skeleton?: MonthlyClosingCell): MonthlyClosingCell => {
    const found = sums.get(`${normalizeCode(areaCode)} ${normalizeCode(productCode)}`);
    const cell = emptyClosingCell();
    if (found) {
      cell.salesUnits = found.salesUnits;
      cell.salesValue = found.salesValue;
    }
    if (preserveTargets && skeleton) {
      cell.targetUnits = skeleton.targetUnits;
      cell.targetValue = skeleton.targetValue;
    }
    // roundedClosingCell re-derives achievement from the (rebuilt) sales over the kept target.
    return roundedClosingCell(cell);
  };

  const regions: MonthlyClosingRegionGroup[] = matrix.regions.map((region) => {
    const areas = region.areas
      // ONLY the synthetic "Direct orders (company)" pseudo-area, which has no geography and no
      // invoice rows to rebuild from. NOT the raw `area.isDirect` flag: since July 2026's direct
      // orders were restated to area grain that flag is also true for REAL areas which merely
      // absorbed some hand-mapped direct money, and dropping those deletes the area outright —
      // its invoice sales AND its target — from every sheet built on this matrix. Measured on
      // production Anti Infective 2026-07, the raw flag removed 11 real areas (Dakahlia 1/2/3,
      // Kafr El-Sheikh 1, Minia 1/2, Qena 2, Behira 2, Menoufia 2, Cairo East 2, Port said -
      // Domiat) and with them 7,159.8 target units of 17,007.8 — so a Product Manager's exported
      // Target vs Achievement sheet showed 9,848 as the whole line's target and an achievement %
      // inflated against it, with nothing on the sheet saying anything was missing. Pedia was
      // untouched, which is exactly why this stayed invisible. See ./closing-direct-area.ts:
      // "Question 1 is this function. Never use the raw flag for it."
      //
      // Whether their direct PORTION appears is `includeDirect`, decided by the caller above:
      // off (the admin row-level-filtered export) leaves this matrix invoice-rows-only for every
      // area alike, which is that workbook's stated contract — direct is reported on its own line
      // because it never arrives as an invoice. On (the portal export) folds it back in, because
      // that workbook's contract is instead to show the reader their own screen.
      .filter((area) => !isSyntheticDirectArea(area))
      .map((area) => {
        const cells = matrix.columns.map((column, columnIndex) =>
          cellFor(area.areaCode, column.productCode, area.cells[columnIndex]));
        return { ...area, cells, rowTotal: sumClosingRowTotal(cells) };
      });
    const subtotalCells = matrix.columns.map((_column, columnIndex) => {
      const cell = emptyClosingCell();
      areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex]));
      return roundedClosingCell(cell);
    });
    return {
      areas,
      regionCode: region.regionCode,
      regionName: region.regionName,
      subtotal: {
        cells: subtotalCells,
        kind: "regionSubtotal",
        regionCode: region.regionCode,
        regionName: region.regionName,
        rowTotal: sumClosingRowTotal(subtotalCells),
      },
    };
  });

  const grandCells = matrix.columns.map((_column, columnIndex) => {
    const cell = emptyClosingCell();
    regions.forEach((region) => region.areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex])));
    return roundedClosingCell(cell);
  });

  return {
    ...matrix,
    companyTotal: null,
    directNational: null,
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: sumClosingRowTotal(grandCells) },
    regions,
  };
}

/**
 * The lines a Monthly Closing can be produced for.
 *
 * HEAD OFFICE IS DELIBERATELY NOT ONE OF THEM (owner decision, 2026-08-05). The closing excludes
 * the confidential products LA003 / LA004 / SS001 by construction — and on Head Office those
 * products are essentially the entire line. Measured on production for 2026-07: the closing showed
 * **546.00 EGP** against a line that actually held **50,965,312.08**, with zero targets to measure
 * any of it against. A sheet reporting 0.001% of a line is not a small inaccuracy, it is a
 * misleading document that anyone could forward.
 *
 * Excluding it HERE, at the single source every surface reads, is what makes it unreachable rather
 * than merely hidden: the admin page, `/api/sales/monthly-closing`, the export route and the portal
 * all take their line list from this function, and `loadMonthlyClosing` only accepts a line that
 * appears in it — so a hand-typed `?line=Head Office` falls back to a real line instead of
 * rendering the misleading sheet. Head Office data is untouched everywhere else (Source of Sales,
 * analytics, the confidential reveal); this is about one report that cannot represent it honestly.
 */
/**
 * Sentinel values that live in `source_of_sales_products.line` but are not sales lines at all.
 * "IGNORE" tags a product that is deliberately kept out of the numbers; it carries zero units and
 * zero value (production, 2026-07), so offering it as a closing produced an empty sheet and put a
 * word that is plainly not a business line in the owner's dropdown.
 */
const NON_SALES_LINE_KEYS = new Set(["ignore"]);

function isNonSalesLine(line: string): boolean {
  return NON_SALES_LINE_KEYS.has(line.trim().toLowerCase());
}

/**
 * Which of these raw `source_of_sales_products.line` values can be closed — the whole rule, with
 * no database in it, so it can be exercised directly rather than described.
 *
 * There is NO opt-in to Head Office and there must not be one again. It carried an
 * `includeHeadOffice` flag until 2026-08-30 for a single caller, the published-everything gate in
 * runSosMonthlyClosingReportCheck, which asks "is every active line published yet" rather than
 * "which lines can be closed" — a genuinely different question, and at the time a fair reason to
 * keep the wider set.
 *
 * The owner then settled the underlying question: "The head office will not be used in the weekly
 * sales or monthly sales." Once Head Office is out of monthly reporting entirely, "is every active
 * line published" cannot mean "including the one line nobody may publish" — see that gate for what
 * the flag actually cost. The flag is gone rather than merely unused, because a dead option
 * encoding a retired rule is exactly what a future caller copies.
 */
export function selectClosingLines(rawLines: readonly unknown[]): string[] {
  const lines = new Set<string>();
  rawLines.forEach((raw) => {
    const line = normalizeDisplay(raw);
    if (!line) return;
    // A sentinel is never a closing, for any caller — it would otherwise be waited on forever.
    if (isNonSalesLine(line)) return;
    if (isHeadOfficeLine(line)) return;
    lines.add(line);
  });
  return [...lines].sort((left, right) => left.localeCompare(right));
}

export async function listMonthlyClosingLines(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_products")
    .select("line")
    .eq("active", true);

  if (error) throw toQueryError(error);

  return selectClosingLines((data ?? []).map((row) => (row as Record<string, unknown>).line));
}

export async function listMonthlyClosingPeriods(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const rows = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("source_of_sales_import_batches")
      .select("period")
      .eq("status", "validated")
      .not("period", "is", null)
      .order("period", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw toQueryError(error);

    for (const row of data ?? []) {
      const period = String((row as Record<string, unknown>).period ?? "").trim();
      if (period) rows.add(period);
    }

    if (!(data ?? []).length || (data ?? []).length < pageSize) break;
  }

  return [...rows]
    .sort((left, right) => right.localeCompare(left));
}

async function listActiveSalesAreas(): Promise<SalesAreaReference[]> {
  const supabase = getSupabaseAdmin();
  // Region name is sourced from the regions master and joined by region_code. The areas
  // table does NOT carry region_name in every Supabase project (schema diverges across
  // staging/production), so we never select it from source_of_sales_areas.
  const [areasResult, regionsResult] = await Promise.all([
    supabase
      .from("source_of_sales_areas")
      .select("area_code,area_name,region_code")
      .eq("active", true)
      .order("region_code", { ascending: true })
      .order("area_code", { ascending: true }),
    supabase
      .from("source_of_sales_regions")
      .select("region_code,region_name")
      .eq("active", true),
  ]);

  if (areasResult.error) throw toQueryError(areasResult.error);
  if (regionsResult.error) throw toQueryError(regionsResult.error);

  const regionNameByCode = buildRegionNameByCode(
    (regionsResult.data ?? []) as Array<Record<string, unknown>>,
  );
  return buildAreaReferencesFromRows(
    (areasResult.data ?? []) as Array<Record<string, unknown>>,
    regionNameByCode,
  );
}

async function listLineProductsForClosing(line: string): Promise<SalesProductReference[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_products")
    .select("product_code,product_name,factory_price,family,family_code,source,line,normalized_line")
    .eq("active", true)
    .eq("normalized_line", normalizeKey(line))
    .order("family", { ascending: true })
    .order("product_name", { ascending: true });

  if (error) throw toQueryError(error);

  return (data ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      factoryPrice: Number(record.factory_price ?? 0),
      family: String(record.family ?? ""),
      familyCode: String(record.family_code ?? ""),
      line: String(record.line ?? ""),
      productCode: String(record.product_code ?? ""),
      productName: String(record.product_name ?? ""),
      source: String(record.source ?? ""),
    };
  });
}

/**
 * The closing's two channels, and the combination the sheet has always shown.
 *
 * The Closing Matrix is retail + direct in one grid, which is the right headline but makes the two
 * businesses impossible to read apart — the owner asked (2026-08-05) for each on its own tab beside
 * the master. `combined` is exactly what `loadMonthlyClosing` returns; `retail` is the same matrix
 * BEFORE direct is injected (distributor invoice rows only); `directCells` is the direct money
 * already allocated to this line's operational regions.
 *
 * By construction retail + direct = combined: `injectDirectIntoMatrix` only ever ADDS the direct
 * cells onto the retail matrix, never re-values it.
 */
export type MonthlyClosingParts = {
  combined: MonthlyClosingMatrix;
  retail: MonthlyClosingMatrix;
  directCells: MonthlyClosingDirectCell[];
  /**
   * The Office slice of `retail`, on the SAME grid — so any cell, subtotal or grand total in the
   * matrix can be read as "x units, of which y came from Office".
   *
   * Office is not a distributor: its units carry no customer and no geography of their own, they
   * are spread across areas by the owner's value-share rule (see office-allocation.ts). On CNS July
   * 2026 that is 42,838 of 105,152 units — 41% of the closing — and until 2026-08-11 it was
   * arithmetically inseparable from real distributor sell-out everywhere except the Data sheet.
   *
   * Built by running the SAME builder over the Office-only cells, rather than threading a second
   * number through every MonthlyClosingCell: subtotals and grand totals then come out of the same
   * code path as the headline figures and cannot drift from them.
   *
   * Folded from the SAME `phx_closing_distributor_product` rows that produce the headline matrix
   * (Office is just the Office-distributor subset), so whenever the closing renders the slice is
   * known: that read is load-bearing and a failure fails the whole closing rather than blanking this
   * one column. The `| null` is retained for API compatibility — no current path returns it, and a
   * genuinely Office-free month is a true zero grid, never null.
   */
  office: MonthlyClosingMatrix | null;
};

/**
 * Fold a `phx_closing_distributor_product` result up to the headline matrix's own grain —
 * area × product, summed over distributor and region.
 *
 * This reproduces `phx_monthly_closing_matrix` exactly: the two RPCs select identical rows under
 * identical filters (same period, same line, same `not is_direct`, same LA003/LA004/SS001
 * exclusion) and differ ONLY in GROUP BY grain, so the coarser matrix is the Σ of the finer over
 * (distributor, region). Verified piastre-identical across every validated (line, period) slice on
 * production — 28/28 slices, 0 rows different in either direction (2026-08-15), and earlier to
 * 0 units / 0 EGP on CNS July 2026 (2026-08-11). Deriving it here means the closing scans
 * source_of_sales_fact_rollup ONCE instead of twice: the matrix RPC used to run a second, identical
 * scan for numbers we already have at a finer grain.
 *
 * Grouping is by the RAW area_code/product_code strings, exactly as the matrix RPC groups by
 * `f.area_code, f.product_code` and exactly as the previous aggregate mapping stringified them
 * (`String(row.area_code ?? "")`), so no (area, product) key can split or merge differently — the
 * space-joined key mirrors the sibling `officeCellsFromDistributorRows`, and area/product codes are
 * short space-free codes (GZ6, LA003), so the tuple can never alias.
 *
 * Exported so a database-free test can cover the fold.
 */
export function matrixCellsFromDistributorRows(rows: Record<string, unknown>[]): MonthlyClosingAggregateCell[] {
  const byCell = new Map<string, MonthlyClosingAggregateCell>();
  for (const row of rows) {
    const areaCode = String(row.area_code ?? "");
    const productCode = String(row.product_code ?? "");
    const key = `${areaCode} ${productCode}`;
    const units = Number(row.units ?? 0);
    const value = Number(row.value ?? 0);
    const existing = byCell.get(key);
    if (existing) {
      existing.salesUnits += units;
      existing.salesValue += value;
    } else {
      byCell.set(key, { areaCode, productCode, salesUnits: units, salesValue: value });
    }
  }
  return [...byCell.values()];
}

/**
 * Keep only the Office rows of a `phx_closing_distributor_product` result and fold them to the
 * matrix's own grain.
 *
 * Two things go wrong here if it is done casually, and both are silent:
 *   1. NOT filtering to Office returns every distributor and makes "of which Office" equal to the
 *      whole closing — a column that always reads 100%.
 *   2. The RPC groups by REGION as well as area, so one (area, product) can arrive as several rows.
 *      Overwriting instead of summing drops every region but the last.
 * Exported so both are covered by a test that does not need a database.
 */
export function officeCellsFromDistributorRows(rows: Record<string, unknown>[]): MonthlyClosingAggregateCell[] {
  const byCell = new Map<string, MonthlyClosingAggregateCell>();
  for (const row of rows) {
    if (!isOfficeDistributorCode(row.distributor_code)) continue;
    const areaCode = String(row.area_code ?? "");
    const productCode = String(row.product_code ?? "");
    const key = `${normalizeCode(areaCode)} ${normalizeCode(productCode)}`;
    const existing = byCell.get(key);
    const units = Number(row.units ?? 0);
    const value = Number(row.value ?? 0);
    if (existing) {
      existing.salesUnits += units;
      existing.salesValue += value;
    } else {
      byCell.set(key, { areaCode, productCode, salesUnits: units, salesValue: value });
    }
  }
  return [...byCell.values()];
}

export async function loadMonthlyClosing(input?: {
  line?: string | null;
  period?: string | null;
}): Promise<MonthlyClosingMatrix> {
  return (await loadMonthlyClosingParts(input)).combined;
}

export async function loadMonthlyClosingParts(input?: {
  line?: string | null;
  period?: string | null;
}): Promise<MonthlyClosingParts> {
  const [availableLines, availablePeriods] = await Promise.all([
    listMonthlyClosingLines(),
    listMonthlyClosingPeriods(),
  ]);

  const selectedLine = input?.line && availableLines.includes(input.line)
    ? input.line
    : availableLines[0] ?? null;
  const selectedPeriod = input?.period && availablePeriods.includes(input.period)
    ? input.period
    : availablePeriods[0] ?? null;

  // Without a line or a validated month there is nothing to aggregate — still return the
  // area skeleton + product columns so the UI renders an empty (zeroed) matrix cleanly.
  if (!selectedLine || !selectedPeriod) {
    const skeletonLineCode = resolveTargetLineCode(selectedLine);
    const [areas, products, operationalRegions] = await Promise.all([
      listActiveSalesAreas(),
      selectedLine ? listLineProductsForClosing(selectedLine) : Promise.resolve<SalesProductReference[]>([]),
      // Only fetched for a line that actually groups by the organogram — see the gate's own note.
      usesOrganogramRegions(skeletonLineCode)
        ? loadLineOperationalRegions(skeletonLineCode, selectedPeriod)
        : Promise.resolve(null),
    ]);
    // Skeleton groups exactly as the loaded month will — including a merged Fayoum/Beni Suef row
    // on Pedia and CNS — so the area/region filters offer the same choices before and after a
    // month is picked.
    const skeletonMerged = applyClosingAreaMerges(skeletonLineCode, areas, [], [], null);
    const skeleton = buildMonthlyClosingMatrix({
      areas: applyOperationalRegions(skeletonMerged.areas, operationalRegions),
      availableLines,
      availablePeriods,
      cells: [],
      line: selectedLine,
      period: selectedPeriod,
      products,
    });
    return { combined: skeleton, retail: skeleton, directCells: [], office: skeleton };
  }

  const supabase = getSupabaseAdmin();
  // The target columns are read from the seat-model Targets engine (au.monthly_targets, the same
  // source the Targets workspace uses), so the closing grid and the achievement grid can never
  // disagree about a target. A line that resolves to no target code — Head Office — simply gets
  // none, and every target cell renders "—".
  const targetLineCode = resolveTargetLineCode(selectedLine);
  const [
    areas, products, distributorData, directData, targetRows,
    operationalRegions, directSubmitters, regionBySubmitter,
  ] = await Promise.all([
    listActiveSalesAreas(),
    listLineProductsForClosing(selectedLine),
    // One scan of source_of_sales_fact_rollup now serves BOTH the headline matrix and its Office
    // slice. phx_closing_distributor_product is phx_monthly_closing_matrix at a finer grain (it adds
    // distributor_code + region_code to the GROUP BY), so the matrix is the Σ of it over those two
    // columns — proven piastre-identical on prod. We fold it below instead of also issuing the matrix
    // RPC's second, identical scan. This read is load-bearing: a failure fails the whole closing (as
    // the matrix RPC did), which is correct — these are the sheet's headline numbers.
    rpcAll(supabase, "phx_closing_distributor_product", { p_line: selectedLine, p_period: selectedPeriod }, ["distributor_code", "region_code", "area_code", "product_code"]),
    rpcAll(supabase, "phx_monthly_closing_direct", { p_line: selectedLine, p_period: selectedPeriod }, ["region_code", "area_code", "product_code"]),
    // A targets outage must not take the whole closing down with it — the sales numbers are the
    // headline and stand on their own. On failure the target columns degrade to "—".
    targetLineCode ? loadMonthlyTargets(selectedPeriod).catch(() => []) : Promise.resolve([]),
    // Which DM territory owns each area on THIS line — fetched ONLY for a line whose closing
    // groups by the organogram (Anti Infective's UE-1 / UE-2 districts). Null for every other line,
    // which keeps the geographic grouping the owner reads those regions as. Null is also the right
    // answer for Head Office and for an org-chart outage: a closing must never fail to render, and
    // it must never quietly re-home an area. See CLOSING_ORGANOGRAM_REGION_LINES for the numbers
    // this gate is worth.
    usesOrganogramRegions(targetLineCode)
      ? loadLineOperationalRegions(targetLineCode, selectedPeriod)
      : Promise.resolve(null),
    // Who booked each Direct sale, and which territory that manager runs — so a Direct row tagged
    // with a region the line has split is credited to its real owner rather than estimated.
    loadDirectSubmitters(selectedLine, selectedPeriod),
    loadRegionBySubmitter(targetLineCode),
  ]);

  const targets: MonthlyClosingTargetCell[] = targetRows
    .filter((row) => row.lineCode === targetLineCode)
    .map((row) => ({
      areaCode: row.areaCode,
      productCode: row.productCode,
      targetUnits: row.targetUnits,
      targetValue: row.targetValue,
    }));

  // The single distributor read feeds both grids: the FULL fold is the headline matrix, the
  // Office-distributor subset is the "of which Office" slice. officeData is now always an array
  // (never the old fail-soft null), because Office is a subset of the rows the load-bearing headline
  // already required — if the closing renders at all, its Office slice is known.
  const distributorRows = distributorData as Record<string, unknown>[];
  const cells: MonthlyClosingAggregateCell[] = matrixCellsFromDistributorRows(distributorRows);
  const officeData: MonthlyClosingAggregateCell[] = officeCellsFromDistributorRows(distributorRows);

  // Belt and braces with the SQL mirror: strip the area at the boundary for any month an overlay
  // places instead of the row (July). Doing it HERE means every downstream
  // consumer — the organogram allocator as well as the injector — sees exactly what it saw before,
  // so no second copy of the rule can drift out of step with this one.
  const directCarriesArea = directRowsCarryOwnArea(selectedPeriod);
  const directCells: MonthlyClosingDirectCell[] = (directData as Record<string, unknown>[]).map((row) => ({
    areaCode: directCarriesArea ? String(row.area_code ?? "") : "",
    productCode: String(row.product_code ?? ""),
    regionCode: String(row.region_code ?? ""),
    salesUnits: Number(row.sales_units ?? 0),
    salesValue: Number(row.sales_value ?? 0),
  }));

  // Order matters: the Direct allocation reads the GEOGRAPHIC regions (that is what a Direct row is
  // tagged with) and must therefore run against `areas` before they are re-labelled below.
  const allocatedDirect = allocateDirectToOperationalRegions(directCells, {
    areas,
    cells,
    map: operationalRegions,
    submitters: directSubmitters,
    regionBySubmitter,
  });

  // Fayoum (GZ6) and Beni Suef (UE9) fold into one row on Pedia and CNS — see
  // closing-area-merges.ts. Applied to a COPY, after the Direct allocation above already read the
  // real (unmerged) areas/cells it needed for region-level attribution.
  const areaMerged = applyClosingAreaMerges(targetLineCode, areas, cells, targets, selectedPeriod);

  const matrix = markMergedAreaRowsStatic(
    buildMonthlyClosingMatrix({
      areas: applyOperationalRegions(areaMerged.areas, operationalRegions),
      availableLines,
      availablePeriods,
      cells: areaMerged.cells,
      line: selectedLine,
      period: selectedPeriod,
      products,
      targets: areaMerged.targets,
    }),
    targetLineCode,
    selectedPeriod,
  );

  // The Office grid, built through the SAME pipeline as `matrix` — same area merges, same
  // operational regions, same columns — so every row, subtotal and grand total lines up cell for
  // cell with the headline figures and can be read as "of which Office".
  //
  // Direct is deliberately NOT injected: Office units are distributor-channel units by definition
  // (phx_closing_distributor_product filters `not is_direct`), so injecting direct here would
  // report direct money as Office money.
  //
  // The city store split is not applied either, and must not be: it moves WHOLESALER customers
  // between the areas of a city, and Office rows carry no customer at all. An area's total moves
  // with the split; its Office component does not.
  const officeMerged = applyClosingAreaMerges(targetLineCode, areas, officeData, [], selectedPeriod);
  const officeMatrix = markMergedAreaRowsStatic(
    buildMonthlyClosingMatrix({
      areas: applyOperationalRegions(officeMerged.areas, operationalRegions),
      availableLines,
      availablePeriods,
      cells: officeMerged.cells,
      line: selectedLine,
      period: selectedPeriod,
      products,
    }),
    targetLineCode,
    selectedPeriod,
  );

  return {
    combined: injectDirectIntoMatrix(matrix, allocatedDirect),
    // `matrix` is the retail-only grid: buildMonthlyClosingMatrix was fed the non-direct cells
    // (phx_monthly_closing_matrix filters `not is_direct`) and injectDirectIntoMatrix returns a
    // NEW matrix rather than mutating this one.
    retail: matrix,
    directCells: allocatedDirect,
    office: officeMatrix,
  };
}
