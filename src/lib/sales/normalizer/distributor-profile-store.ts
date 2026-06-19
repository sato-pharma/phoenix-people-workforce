// SINGLE SOURCE OF TRUTH for distributor column mappings: the code profiles (RAW_DISTRIBUTOR_PROFILES),
// generated from the unified Headers Mapping sheet. The old editable DB override
// (`source_of_sales_distributor_profile`) was removed — there is no second source of headers in
// Source of Sales, and the mapping cannot be overridden at runtime. Server-only.

import { RAW_DISTRIBUTOR_PROFILES, rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import type { DistributorProfile } from "@/lib/sales/normalizer/types";

// The mapping fields, in the exact column order of the exported workbook — consumed by the read-only
// "Distributor Mapping" viewer and by distributor auto-detection.
export const PROFILE_FIELDS = [
  { key: "productCodeColumns", column: "product_code_columns", label: "Product Code" },
  { key: "productNameColumns", column: "product_name_columns", label: "Product Name" },
  { key: "qtyColumns", column: "qty_columns", label: "Quantity" },
  { key: "branchCodeColumns", column: "branch_code_columns", label: "Branch Code" },
  { key: "branchNameColumns", column: "branch_name_columns", label: "Branch Name" },
  { key: "bonusColumns", column: "bonus_columns", label: "Bonus Qty" },
  { key: "valueColumns", column: "value_columns", label: "Value" },
  { key: "discountColumns", column: "discount_columns", label: "Discount %" },
  { key: "dateColumns", column: "date_columns", label: "Invoice Date" },
  { key: "customerCodeColumns", column: "customer_code_columns", label: "Customer Code" },
  { key: "customerNameColumns", column: "customer_name_columns", label: "Customer Name" },
  { key: "customerAddressColumns", column: "customer_address_columns", label: "Customer Address" },
  { key: "areaIdColumns", column: "area_id_columns", label: "Area ID" },
  { key: "areaNameColumns", column: "area_name_columns", label: "Area Name" },
  { key: "brickIdColumns", column: "brick_id_columns", label: "Brick ID" },
  { key: "brickNameColumns", column: "brick_name_columns", label: "Brick Name" },
  { key: "regionColumns", column: "region_columns", label: "Region" },
] as const;

export type ProfileFieldKey = (typeof PROFILE_FIELDS)[number]["key"];

export type EditableProfile = {
  distributorCode: string;
  distributorName: string;
  valueSource: "recompute" | "sheet";
  regionOnly: boolean;
  isCustom: boolean; // always false — there are no DB overrides; the code profile is the single source
  fields: Record<ProfileFieldKey, string[]>;
};

// Code profile -> read-only display shape. Product code/name come from the canonical split; the
// geography text is surfaced under "Area ID" (territoryColumns).
function defaultToEditable(p: DistributorProfile): EditableProfile {
  const product = p.productColumns ?? [];
  return {
    distributorCode: p.distributorCode,
    distributorName: p.distributorName,
    valueSource: p.valueSource,
    regionOnly: Boolean(p.regionOnly),
    isCustom: false,
    fields: {
      productCodeColumns: p.productCodeColumns ?? product.slice(0, 1),
      productNameColumns: p.productNameColumns ?? product.slice(1),
      qtyColumns: p.qtyColumns ?? [],
      branchCodeColumns: [],
      branchNameColumns: [],
      bonusColumns: p.bonusColumns ?? [],
      valueColumns: p.valueColumns ?? [],
      discountColumns: p.discountColumns ?? [],
      dateColumns: p.dateColumns ?? [],
      customerCodeColumns: p.customerCodeColumns ?? [],
      customerNameColumns: p.customerNameColumns ?? [],
      customerAddressColumns: p.customerAddressColumns ?? [],
      areaIdColumns: p.territoryColumns ?? [],
      areaNameColumns: [],
      brickIdColumns: p.brickIdColumns ?? [],
      brickNameColumns: [],
      regionColumns: [],
    },
  };
}

// SINGLE SOURCE: resolve a distributor's profile ONLY from the code profiles (the Headers Mapping).
// Kept async + same signature for its callers (recognize.ts / service.ts).
export async function resolveDistributorProfile(distributorCode: string): Promise<DistributorProfile | null> {
  return rawProfileForDistributor(String(distributorCode ?? "").trim().toUpperCase());
}

// All distributors as read-only profiles straight from the code profiles (= the Headers Mapping).
export async function listEditableProfiles(): Promise<EditableProfile[]> {
  return RAW_DISTRIBUTOR_PROFILES.map((p) => defaultToEditable(p));
}
