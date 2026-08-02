import ExcelJS from "exceljs";
import { unstable_cache } from "next/cache.js";

import { writeAuditLog } from "@/lib/admin/audit";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import {
  canViewHeadOfficeLine,
  canViewRestrictedProducts,
  isHeadOfficeLine,
  RESTRICTED_PRODUCT_CODES,
} from "@/lib/sales/access-scope";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { loadMonthlyTargets, resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { finalizeSosBatchAndAuditSupersede } from "@/lib/sales/source-of-sales-batch-supersede";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, rpcAll, toQueryError } from "@/lib/supabase/server";

export type SalesDistributorOption = {
  code: string;
  name: string;
};

export type SalesAreaRegionReference = {
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
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
  // Optional per-row discount column. Blank/0 means no discount; otherwise the
  // row value is reduced by the discount (value = Qty x factory_price x (1 - discount)).
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

// EGD Branch (code EG-BR) — a separate branch of EGD (parent code EG). Fully-coded EGD monthly sheet:
// EGD's raw export with the Phoenix coded columns (Product ID / Brick ID / Area ID / Region ID /
// Distrub ID, where Distrub ID = "EG-BR") appended. Date is "Invoice Date", qty the net "Qty",
// customer CUSTOMER_CODE/NAME/ADDRESS. Value RECOMPUTED from Qty x factory_price x (1 - Discount%).
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
// Qty x factory_price x (1 - Discount%) (no valueField). Captures Sofico's customer code/name so
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
// "خصم%". Value is RECOMPUTED from Qty x factory_price x (1 - discount) (no valueField —
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
// Qty x factory_price x (1 - Discount%); the Normalizer writes the exact discount it applied (the coded
// sheet's "Discount%" column) so the recompute reproduces the engine's value. Offered as a FINAL fallback
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

function parseNumber(value: unknown, options?: { emptyAsZero?: boolean }) {
  const text = normalizeDisplay(value);
  if (!text && options?.emptyAsZero) return 0;
  if (!text) return Number.NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseOptionalInteger(value: unknown) {
  const text = normalizeDisplay(value);
  if (!text) return null;
  const parsed = Number(text.replace(/,/g, ""));
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
export function parseDiscount(value: unknown): { rate: number; outOfRange: boolean } {
  const text = normalizeDisplay(value).replace(/%/g, "").replace(/,/g, "");
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
        const crossesArea = sheetArea !== "" && !isNotAvailable(rawAreaCode) && mappedArea !== sheetArea;
        if (!crossesArea) {
          rawBrickId = mappedBrick.brickId;
          if (normalizeCode(rawAreaCode) === "" || isNotAvailable(rawAreaCode)) rawAreaCode = mappedBrick.areaCode;
          if (normalizeCode(rawRegionCode) === "" || isNotAvailable(rawRegionCode)) rawRegionCode = mappedBrick.regionCode;
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
    const parsedQty = parseNumber(rawQty);
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

    // Value is computed from Qty only (bonus/free units neglected) times the
    // product factory price, reduced by the per-row discount. The distributor
    // sheet's own Value/Net column is intentionally ignored — EXCEPT for the Direct
    // channel, which is the only sheet whose own Value column is the source of truth.
    const value = isDirect
      ? parseNumber(rawSheetValue, { emptyAsZero: true })
      : Number.isFinite(qty)
        ? qty * (productReference?.factoryPrice ?? 0) * (1 - discountRate)
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
    if (!Number.isFinite(qty)) addIssue(rowIssues, rowNumber, headerMap.template.fields.qty, rawQty, "Qty must be numeric.");
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
    if (isDirect && !Number.isFinite(value) && normalizeDisplay(rawSheetValue)) {
      addIssue(rowIssues, rowNumber, headerMap.template.valueField ?? "Value", rawSheetValue, "Value must be numeric.");
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
  // The customer -> brick crosswalk powers ONLY the import brick auto-fill, and it is large
  // (tens of thousands of rows paged 1000-at-a-time = many round-trips). Callers that just need
  // the name masters (e.g. the executive report) pass includeCustomerBricks:false to skip it.
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
  const [newRegionsResult, areasResult, blocksResult, bricksResult, productsResult, distributorsResult] = await Promise.all([
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
  ]);

  if (productsResult.error) throw toQueryError(productsResult.error);
  if (distributorsResult.error) throw toQueryError(distributorsResult.error);

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

  // ── CEO / unrestricted path ──────────────────────────────────────────────
  // Only safe when BOTH locks are open. The fast path sums whole-BATCH totals, which bake in
  // every line — so a viewer who may see restricted products but not the Head Office line (or
  // vice versa) must take the re-derived path below instead.
  if (!restrictedSet && !stripHeadOffice) {
    const totals = emptyTotals();
    const distributorMap = new Map<string, SourceOfSalesDashboardDistributor>();
    input.batches.forEach((batch) => {
      const batchTotals = { rowCount: batch.rowCount, totalBonusQty: batch.totalBonusQty, totalQty: batch.totalQty, totalValue: batch.totalValue };
      addDashboardTotals(totals, batchTotals);
      const key = batch.distributorCode;
      const distributor = distributorMap.get(key) ?? { ...emptyTotals(), distributorCode: batch.distributorCode, distributorName: batch.distributorName, sheetCount: 0 };
      distributor.sheetCount += 1;
      addDashboardTotals(distributor, batchTotals);
      distributorMap.set(key, distributor);
    });
    return {
      availablePeriods: input.availablePeriods,
      byArea: aggregateDashboardGroups(input.summaries, "area"),
      byBrick: aggregateDashboardGroups(input.summaries, "brick"),
      byDistributor: [...distributorMap.values()].map(roundedTotals).sort((l, r) => r.totalValue - l.totalValue || l.distributorName.localeCompare(r.distributorName)),
      byLine: aggregateDashboardGroups(input.summaries, "line"),
      byProduct: aggregateDashboardGroups(input.summaries, "product"),
      byRegion: aggregateDashboardGroups(input.summaries, "region"),
      period: input.period,
      sheetCount: input.batches.length,
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
  const batchById = new Map(input.batches.map((b) => [b.batchId, b]));
  const sheetCountByCode = new Map<string, number>();
  input.batches.forEach((b) => sheetCountByCode.set(b.distributorCode, (sheetCountByCode.get(b.distributorCode) ?? 0) + 1));
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
  // Only scoped viewers reach here; the unrestricted CEO/Super-Admin path returned above, reads its
  // geography straight from the unfiltered summaries, and is deliberately not reconciled.
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
    sheetCount: input.batches.length,
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

  // For non-CEO/SuperAdmin: call the geo RPC to get region/area/brick totals with the confidential
  // rows excluded. The pre-aggregated summaries bake their value in at import time so cannot be
  // filtered post-hoc.
  //
  // The RPC excludes by PRODUCT CODE, and region/area/brick carry no line dimension — so the
  // Head Office LINE is hidden here by excluding that line's product codes, resolved live from the
  // master. Verified against production 2026-08-02: the Head Office line holds 4 products
  // (LA003/LA004/SS001 — already restricted — plus RY001, which is not), the master covers every
  // code the rows actually use, no Head Office row has a blank product code, and no code is shared
  // with another line. buildSourceOfSalesDashboard re-checks that equivalence at runtime by
  // reconciling the geography sum against the line-scoped total, so a future import that breaks it
  // withholds the split instead of leaking it.
  let geoSummaries: SourceOfSalesSummaryRecord[] | undefined;
  if ((!canViewRestricted || !canViewHeadOffice) && batchIds.length > 0) {
    const excludeCodes = new Set<string>(
      canViewRestricted ? [] : RESTRICTED_PRODUCT_CODES.map((code) => code.trim().toUpperCase()),
    );
    // null ⇒ the master could not be read, so the exclusion list cannot be trusted to be complete.
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
        // Fail CLOSED: a restricted viewer must never see byRegion/byArea/byBrick fall back to the
        // unfiltered (confidential-inclusive) summaries just because this RPC call errored. An empty
        // geo breakdown (rather than `undefined`, which buildSourceOfSalesDashboard's geoSource ??
        // input.summaries fallback would treat as "RPC skipped, use the inflated summaries") degrades
        // to a blank region/area/brick section instead of leaking confidential product value.
        console.warn("[sales dashboard] phx_sos_geo_aggregates_without_restricted failed; region/area/brick breakdown will be empty rather than falling back to unfiltered totals", geoResult.error);
        geoSummaries = [];
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

  // The master is the source of truth for names: whenever it has a name for the group's code, use it.
  const byRegion = dashboard.byRegion.map((group) => {
    const name = group.code ? regionNameByCode.get(normalizeCode(group.code)) : undefined;
    return name && name !== group.label ? { ...group, label: name } : group;
  });
  const byArea = dashboard.byArea.map((group) => {
    const info = group.code ? areaInfoByCode.get(normalizeCode(group.code)) : undefined;
    const label = info?.name || group.label;
    // The area's parent column (group.line) holds the region label; resolve it to the region name too.
    const parentName = info?.regionCode ? regionNameByCode.get(info.regionCode) : undefined;
    const line = parentName || group.line;
    return label !== group.label || line !== group.line ? { ...group, label, line } : group;
  });
  const byBrick = dashboard.byBrick.map((group) => {
    const name = group.code ? brickNameById.get(normalizeCode(group.code)) : undefined;
    return name && name !== group.label ? { ...group, label: name } : group;
  });

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

// Period lock guard — once a Monthly Sales period is locked, all uploads/deletes for that period are
// rejected until it is re-opened. Tolerant of a missing lock table (pre-migration = not locked) so it
// never blocks a normal upload before the Monthly Sales migration is applied.
export async function assertPeriodNotLocked(period: string | null): Promise<void> {
  if (!period) return;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("monthly_sales_period_lock")
    .select("locked")
    .eq("period", period)
    .eq("locked", true)
    .maybeSingle();
  if (error) return; // table absent or unreachable → treat as not locked (defensive)
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
    invalidateSalesDashboardCache("source of sales multi-period import (fallback refresh)");
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
  // True for the synthetic "Direct" row injected inside a region (company direct sales).
  isDirect?: boolean;
  kind: "area";
  regionCode: string;
  regionName: string;
  rowTotal: MonthlyClosingCell;
};

export type MonthlyClosingSubtotalRow = {
  cells: MonthlyClosingCell[];
  kind: "regionSubtotal";
  regionCode: string;
  regionName: string;
  rowTotal: MonthlyClosingCell;
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

// One direct-sales aggregate cell (region × product). Region may be a real code or "NATIONAL".
export type MonthlyClosingDirectCell = {
  productCode: string;
  regionCode: string;
  salesUnits: number;
  salesValue: number;
};

const MONTHLY_CLOSING_REGION_ORDER = ["CA", "GZ", "UE", "AB", "D1", "D2", "OT"] as const;

function monthlyClosingRegionRank(regionCode: string) {
  const index = MONTHLY_CLOSING_REGION_ORDER.indexOf(regionCode as (typeof MONTHLY_CLOSING_REGION_ORDER)[number]);
  return index === -1 ? MONTHLY_CLOSING_REGION_ORDER.length : index;
}

function emptyClosingCell(): MonthlyClosingCell {
  return { achievement: null, salesUnits: 0, salesValue: 0, targetUnits: null, targetValue: null };
}

/**
 * Null-preserving addition for the target columns.
 *
 * A missing target is NOT zero. If a region's areas all lack targets, the subtotal must stay
 * null so the UI renders "—"; folding them in as 0 would both assert "the target is zero" and
 * make every achievement % a division by nothing. Only once at least one contributing cell
 * actually carries a target does the sum become a number.
 */
function addTarget(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

/** Roll-up adds the sales figures AND the targets; achievement is re-derived from the sums. */
function addClosingSales(target: MonthlyClosingCell, source: MonthlyClosingCell) {
  target.salesUnits += source.salesUnits;
  target.salesValue += source.salesValue;
  target.targetUnits = addTarget(target.targetUnits, source.targetUnits);
  target.targetValue = addTarget(target.targetValue, source.targetValue);
}

/**
 * Achievement is ALWAYS recomputed from summed value ÷ summed target — never averaged from the
 * per-cell percentages (which would weight a tiny area the same as a whole region), and never
 * emitted against a null or zero target.
 */
function closingAchievement(cell: MonthlyClosingCell): number | null {
  if (cell.targetValue === null || cell.targetValue === 0) return null;
  return cell.salesValue / cell.targetValue;
}

function roundedClosingCell(cell: MonthlyClosingCell): MonthlyClosingCell {
  const rounded: MonthlyClosingCell = {
    achievement: null,
    salesUnits: Number(cell.salesUnits.toFixed(6)),
    salesValue: Number(cell.salesValue.toFixed(6)),
    targetUnits: cell.targetUnits === null ? null : Number(cell.targetUnits.toFixed(6)),
    targetValue: cell.targetValue === null ? null : Number(cell.targetValue.toFixed(6)),
  };
  rounded.achievement = closingAchievement(rounded);
  return rounded;
}

function sumClosingRowTotal(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  const total = emptyClosingCell();
  cells.forEach((cell) => addClosingSales(total, cell));
  return roundedClosingCell(total);
}

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

/**
 * Pure injector. Adds the Direct (company) channel on top of the distributor matrix:
 *  - direct sales in a REAL region become a synthetic "Direct" area row inside that region, so
 *    the region subtotal (and hence the grand total) = its areas + Direct;
 *  - direct sales tagged "National" become a separate "Direct – National" row, and the
 *    companyTotal = grand total + Direct National.
 * Direct value comes straight from the sheet (already aggregated by the direct RPC); no
 * factory-price recompute. Returns a new matrix; when there are no direct cells the matrix is
 * unchanged (directNational / companyTotal = null).
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
  directCells.forEach((cell) => {
    const region = normalizeCode(cell.regionCode);
    const index = colIndex.get(normalizeCode(cell.productCode));
    if (index === undefined) return; // product not part of this line's columns
    const target = cellsFor(region)[index];
    target.salesUnits += cell.salesUnits;
    target.salesValue += cell.salesValue;
  });

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

  // Append the Direct area to each existing region that has direct sales.
  const present = new Set(matrix.regions.map((region) => region.regionCode));
  const regions: MonthlyClosingRegionGroup[] = matrix.regions.map((region) => {
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
  const nationalCells = byRegion.get(NATIONAL);
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

/**
 * Pure client-side filter. Keeps the selected regions/areas/products (+ free-text area
 * search) and RE-DERIVES region subtotals and the national grand total from the surviving
 * AREA rows only — so the filtered totals stay exact and each area is still counted once.
 * Empty selections mean "all". This mirrors buildMonthlyClosingMatrix's roll-up.
 */
export function filterMonthlyClosingMatrix(
  matrix: MonthlyClosingMatrix,
  filter: { areaCodes?: string[]; productCodes?: string[]; regionCodes?: string[]; search?: string },
): MonthlyClosingMatrix {
  const regionSet = new Set((filter.regionCodes ?? []).map((code) => normalizeCode(code)));
  const areaSet = new Set((filter.areaCodes ?? []).map((code) => normalizeCode(code)));
  const productSet = new Set((filter.productCodes ?? []).map((code) => normalizeCode(code)));
  const search = normalizeKey(filter.search ?? "");

  const keptColumnIndexes: number[] = [];
  const columns: MonthlyClosingColumn[] = [];
  matrix.columns.forEach((column, index) => {
    if (productSet.size === 0 || productSet.has(normalizeCode(column.productCode))) {
      keptColumnIndexes.push(index);
      columns.push(column);
    }
  });

  const projectCells = (cells: MonthlyClosingCell[]) => keptColumnIndexes.map((index) => cells[index]);

  const regions: MonthlyClosingRegionGroup[] = [];
  matrix.regions.forEach((region) => {
    if (regionSet.size > 0 && !regionSet.has(normalizeCode(region.regionCode))) return;

    const areas = region.areas
      .filter((area) => {
        if (areaSet.size > 0 && !areaSet.has(normalizeCode(area.areaCode))) return false;
        if (search) {
          const haystack = `${normalizeKey(area.areaCode)} ${normalizeKey(area.areaName)}`;
          if (!haystack.includes(search)) return false;
        }
        return true;
      })
      .map((area) => {
        const cells = projectCells(area.cells);
        return { ...area, cells, rowTotal: sumClosingRowTotal(cells) };
      });

    if (areas.length === 0) return;

    const subtotalCells = columns.map((_column, columnIndex) => {
      const cell = emptyClosingCell();
      areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex]));
      return roundedClosingCell(cell);
    });

    regions.push({
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
    });
  });

  const grandCells = columns.map((_column, columnIndex) => {
    const cell = emptyClosingCell();
    regions.forEach((region) => region.areas.forEach((area) => addClosingSales(cell, area.cells[columnIndex])));
    return roundedClosingCell(cell);
  });

  // Carry the Direct – National row through (project to the kept columns) and recompute the
  // company total = filtered grand total + Direct National.
  const directNational = matrix.directNational
    ? (() => {
      const cells = projectCells(matrix.directNational!.cells);
      return { ...matrix.directNational!, cells, rowTotal: sumClosingRowTotal(cells) };
    })()
    : null;
  let companyTotal: MonthlyClosingGrandTotalRow | null = null;
  if (directNational) {
    const companyCells = columns.map((_column, columnIndex) => {
      const cell = emptyClosingCell();
      addClosingSales(cell, grandCells[columnIndex]);
      addClosingSales(cell, directNational.cells[columnIndex]);
      return roundedClosingCell(cell);
    });
    companyTotal = { cells: companyCells, kind: "grandTotal", rowTotal: sumClosingRowTotal(companyCells) };
  }

  return {
    availableLines: matrix.availableLines,
    availablePeriods: matrix.availablePeriods,
    columns,
    companyTotal,
    directNational,
    grandTotal: {
      cells: grandCells,
      kind: "grandTotal",
      rowTotal: sumClosingRowTotal(grandCells),
    },
    line: matrix.line,
    period: matrix.period,
    regions,
  };
}

export async function listMonthlyClosingLines(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("source_of_sales_products")
    .select("line")
    .eq("active", true);

  if (error) throw toQueryError(error);

  const lines = new Set<string>();
  (data ?? []).forEach((row) => {
    const line = normalizeDisplay((row as Record<string, unknown>).line);
    if (line) lines.add(line);
  });
  return [...lines].sort((left, right) => left.localeCompare(right));
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

export async function loadMonthlyClosing(input?: {
  line?: string | null;
  period?: string | null;
}): Promise<MonthlyClosingMatrix> {
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
    const [areas, products] = await Promise.all([
      listActiveSalesAreas(),
      selectedLine ? listLineProductsForClosing(selectedLine) : Promise.resolve<SalesProductReference[]>([]),
    ]);
    return buildMonthlyClosingMatrix({
      areas,
      availableLines,
      availablePeriods,
      cells: [],
      line: selectedLine,
      period: selectedPeriod,
      products,
    });
  }

  const supabase = getSupabaseAdmin();
  // The target columns are read from the seat-model Targets engine (au.monthly_targets, the same
  // source the Targets workspace uses), so the closing grid and the achievement grid can never
  // disagree about a target. A line that resolves to no target code — Head Office — simply gets
  // none, and every target cell renders "—".
  const targetLineCode = resolveTargetLineCode(selectedLine);
  const [areas, products, aggregateData, directData, targetRows] = await Promise.all([
    listActiveSalesAreas(),
    listLineProductsForClosing(selectedLine),
    rpcAll(supabase, "phx_monthly_closing_matrix", { p_line: selectedLine, p_period: selectedPeriod }, ["area_code", "product_code"]),
    rpcAll(supabase, "phx_monthly_closing_direct", { p_line: selectedLine, p_period: selectedPeriod }, ["region_code", "product_code"]),
    // A targets outage must not take the whole closing down with it — the sales numbers are the
    // headline and stand on their own. On failure the target columns degrade to "—".
    targetLineCode ? loadMonthlyTargets(selectedPeriod).catch(() => []) : Promise.resolve([]),
  ]);

  const targets: MonthlyClosingTargetCell[] = targetRows
    .filter((row) => row.lineCode === targetLineCode)
    .map((row) => ({
      areaCode: row.areaCode,
      productCode: row.productCode,
      targetUnits: row.targetUnits,
      targetValue: row.targetValue,
    }));

  const cells: MonthlyClosingAggregateCell[] = (aggregateData as Record<string, unknown>[]).map((row) => ({
    areaCode: String(row.area_code ?? ""),
    productCode: String(row.product_code ?? ""),
    salesUnits: Number(row.sales_units ?? 0),
    salesValue: Number(row.sales_value ?? 0),
  }));

  const directCells: MonthlyClosingDirectCell[] = (directData as Record<string, unknown>[]).map((row) => ({
    productCode: String(row.product_code ?? ""),
    regionCode: String(row.region_code ?? ""),
    salesUnits: Number(row.sales_units ?? 0),
    salesValue: Number(row.sales_value ?? 0),
  }));

  const matrix = buildMonthlyClosingMatrix({
    areas,
    availableLines,
    availablePeriods,
    cells,
    line: selectedLine,
    period: selectedPeriod,
    products,
    targets,
  });

  return injectDirectIntoMatrix(matrix, directCells);
}
