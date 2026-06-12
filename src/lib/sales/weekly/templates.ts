// Per-distributor weekly column registry. Each distributor exports its weekly "Sales & Stock" file in
// its own layout; we recognise it by header aliases. New distributors are added here as their format
// is shared — the parser is generic, only this map is distributor-specific.

export type WeeklyTemplateField =
  | "weekStart"
  | "itemCode"
  | "itemName"
  | "branchCode"
  | "branchName"
  | "stockQty"
  | "salesQty"
  | "bonusQty"
  | "discount"
  | "regionCode"
  | "productCode"
  | "distributorId";

export type WeeklyTemplate = {
  key: string;
  name: string;
  /** standardRows = one sheet row is one fact row; overseasPosMatrix = product rows x outlet quantity columns */
  layout?: "standardRows" | "overseasPosMatrix";
  /** distributor codes that use this template */
  distributorCodes: string[];
  /** restrict matching to a sheet whose name contains this token (case-insensitive); optional */
  sheetNameIncludes?: string;
  /** header aliases per field — first present header wins. Required fields must resolve to validate. */
  fields: Record<WeeklyTemplateField, string[]>;
  /** fields that MUST be found in the header row for the template to be accepted */
  required: WeeklyTemplateField[];
};

// Ibn Sina Sato / IS-S (and legacy IS fallback) — "SalesAndStockReport2_DataHub" coded weekly feed.
// Product ID maps directly to our product_code; Item Code/name are the distributor SKU (fallback for unmapped/#N/A Product IDs).
const IBN_SINA_WEEKLY: WeeklyTemplate = {
  key: "ibn_sina_weekly_datahub",
  name: "Ibn Sina Sato weekly Sales & Stock (DataHub)",
  distributorCodes: ["IS-S", "IS"],
  sheetNameIncludes: "DataHub",
  fields: {
    weekStart: ["Date"],
    itemCode: ["Item Code"],
    itemName: ["Item name", "Item Name"],
    branchCode: ["Branch Code"],
    branchName: ["Branch Name"],
    stockQty: ["Stock"],
    salesQty: ["Sales Quantity", "Sales Qty"],
    bonusQty: ["Bonus", "Bonus Qty"],
    discount: ["Discount", "Disc"],
    regionCode: ["Region ID", "Region"],
    productCode: ["Product ID", "Product Code"],
    distributorId: ["Distrub ID", "Distributor ID", "Distrib ID"],
  },
  required: ["weekStart", "salesQty", "regionCode", "stockQty"],
};

const IBN_SINA_WEEKLY_PAS_VARIANT: WeeklyTemplate = {
  key: "ibn_sina_weekly_pas_raw",
  name: "Ibn Sina Sato weekly Sales & Stock (PAS raw)",
  distributorCodes: ["IS-S"],
  sheetNameIncludes: "DataHub",
  fields: {
    weekStart: ["Date"],
    itemCode: ["Item Code"],
    itemName: ["Item name", "Item Name"],
    branchCode: ["Branch Code"],
    branchName: ["Branch Name"],
    stockQty: ["Stock"],
    salesQty: ["Sales Quantity", "Sales Qty"],
    bonusQty: ["Bonus", "Bonus Qty"],
    discount: ["Discount", "Disc"],
    regionCode: ["Region ID", "Region", "Supplier Code", "Supplier ID"],
    productCode: ["Product ID", "Product Code", "Item Code"],
    distributorId: ["Distrub ID", "Distributor ID", "Distrib ID", "Supplier Code", "Supplier ID"],
  },
  required: ["weekStart", "salesQty", "stockQty"],
};

const IBN_SINA_WEEKLY_PAS_VARIANT_NO_DATE: WeeklyTemplate = {
  key: "ibn_sina_weekly_pas_raw_no_date",
  name: "Ibn Sina Sato weekly Sales & Stock (PAS raw, no date column)",
  distributorCodes: ["IS-S"],
  sheetNameIncludes: "DataHub",
  fields: {
    weekStart: ["Date"],
    itemCode: ["Item Code"],
    itemName: ["Item name", "Item Name"],
    branchCode: ["Branch Code"],
    branchName: ["Branch Name"],
    stockQty: ["Stock"],
    salesQty: ["Sales Quantity", "Sales Qty"],
    bonusQty: ["Bonus", "Bonus Qty"],
    discount: ["Discount", "Disc"],
    regionCode: ["Region ID", "Region", "Supplier Code", "Supplier ID"],
    productCode: ["Product ID", "Product Code", "Item Code"],
    distributorId: ["Distrub ID", "Distributor ID", "Distrib ID", "Supplier Code", "Supplier ID"],
  },
  required: ["salesQty", "stockQty", "itemCode"],
};

const OVERSEAS_POS_WEEKLY_MATRIX: WeeklyTemplate = {
  key: "overseas_pos_weekly_matrix",
  name: "Overseas weekly POS matrix",
  layout: "overseasPosMatrix",
  distributorCodes: ["PS"],
  sheetNameIncludes: "Data",
  fields: {
    weekStart: ["Date"],
    itemCode: ["Mat. Code"],
    itemName: ["Mat. Desc."],
    branchCode: [],
    branchName: [],
    stockQty: [],
    salesQty: ["Total Qty."],
    bonusQty: ["Bonus Qty."],
    discount: [],
    regionCode: [],
    productCode: ["Product ID"],
    distributorId: [],
  },
  required: ["weekStart", "salesQty", "productCode"],
};

const WEEKLY_DISTRIBUTOR_FALLBACK_NAMES: Record<string, string> = {
  IS: "Ibn Sina",
  "IS-S": "Ibn Sina Sato",
  PS: "Overseas",
};

export const WEEKLY_TEMPLATES: WeeklyTemplate[] = [
  IBN_SINA_WEEKLY,
  IBN_SINA_WEEKLY_PAS_VARIANT,
  IBN_SINA_WEEKLY_PAS_VARIANT_NO_DATE,
  OVERSEAS_POS_WEEKLY_MATRIX,
];

export function weeklyTemplatesForDistributor(distributorCode: string): WeeklyTemplate[] {
  const code = (distributorCode ?? "").trim().toUpperCase();
  return WEEKLY_TEMPLATES.filter((template) =>
    template.distributorCodes.some((candidate) => candidate.toUpperCase() === code),
  );
}

/** Distributor codes that currently have a registered weekly template (drives the upload dropdown). */
export function weeklyTemplateDistributorCodes(): string[] {
  const set = new Set<string>();
  for (const template of WEEKLY_TEMPLATES) for (const code of template.distributorCodes) set.add(code);
  return [...set];
}

export function weeklyTemplateDistributorFallbackName(distributorCode: string): string | null {
  const normalized = (distributorCode ?? "").trim().toUpperCase();
  return normalized ? WEEKLY_DISTRIBUTOR_FALLBACK_NAMES[normalized] ?? null : null;
}
