// DB-first distributor column-mapping store. The normalizer resolves a distributor's profile from the
// editable `source_of_sales_distributor_profile` table when a row exists, else falls back to the
// code-defined RAW_DISTRIBUTOR_PROFILES — so the table can start empty and edits take effect on the
// next normalize. Server-only (service-role).
//
// EVERY Phoenix target is its OWN field/column, in the exact order the admin laid out in the export.
// The engine's single productColumns list = [...productCodeColumns, ...productNameColumns]; the brick is
// resolved from the geography text columns (Area ID / Area Name / Region) and/or the direct Brick ID.

import { RAW_DISTRIBUTOR_PROFILES, rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import type { DistributorProfile } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// The editable fields — ONE cell each, in the exact column order of the exported workbook.
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
  isCustom: boolean; // true = a saved DB row exists (overriding the code default)
  fields: Record<ProfileFieldKey, string[]>;
};

// Code default -> editable shape. The code profile keeps product code+name in one list (first = code,
// rest = name) and the geography text under territoryColumns (-> the "Area ID" field).
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

// SINGLE SOURCE OF TRUTH: a distributor's column mapping comes ONLY from the code profiles, which are
// generated from the unified Headers Mapping sheet. The editable DB override was removed so NOTHING
// can override the mapping (no second source of headers in Source of Sales). Kept async + same
// signature for its callers (recognize.ts / service.ts).
export async function resolveDistributorProfile(distributorCode: string): Promise<DistributorProfile | null> {
  return rawProfileForDistributor(String(distributorCode ?? "").trim().toUpperCase());
}

// All distributors as read-only profiles straight from the code profiles (= the Headers Mapping).
// There is no DB override any more, so every profile is the single source of truth (isCustom=false).
export async function listEditableProfiles(): Promise<EditableProfile[]> {
  return RAW_DISTRIBUTOR_PROFILES.map((p) => defaultToEditable(p));
}

export type SaveProfileInput = {
  fields: Record<string, string[]>;
  valueSource: "recompute" | "sheet";
  regionOnly: boolean;
};

// Saving a per-distributor override is no longer allowed — distributor column mappings are defined
// ONLY by the Headers Mapping (the single source of truth). The editable DB override was removed.
export async function saveDistributorProfile(_distributorCode: string, _input: SaveProfileInput, _updatedBy: string): Promise<void> {
  throw new Error("Distributor header mappings are read-only — they are defined by the Headers Mapping (the single source of truth). Update the Headers Mapping / code profile instead of saving a per-distributor override.");
}

// No-op: there are no DB overrides to reset — the code profile (Headers Mapping) is always the live mapping.
export async function resetDistributorProfile(_distributorCode: string): Promise<void> {
  /* intentionally empty — distributor mappings are read-only (single source: the Headers Mapping). */
}

// The "puzzle pieces": each distributor's column headers. Seeded from the distributor's KNOWN columns
// (the code profile) so the list is NEVER empty — even before any file is imported — then enriched with
// the real headers seen in its imported rows (raw_row preserves the original sheet headers).
export async function listDistributorHeaders(): Promise<Record<string, string[]>> {
  const supabase = getSupabaseAdmin();
  const out: Record<string, string[]> = {};
  await Promise.all(RAW_DISTRIBUTOR_PROFILES.map(async (p) => {
    const keys = new Set<string>();
    // Seed from the distributor's known columns so SOFICO / EGD etc. show their headers with zero imports.
    for (const list of [p.productColumns, p.qtyColumns, p.bonusColumns, p.valueColumns, p.dateColumns, p.customerCodeColumns, p.customerNameColumns, p.customerAddressColumns, p.territoryColumns, p.brickIdColumns, p.discountColumns]) {
      for (const c of list ?? []) { const t = String(c).trim(); if (t) keys.add(t); }
    }
    // Enrich with the actual headers seen in this distributor's imported files.
    try {
      const { data } = await supabase.from("source_of_sales_import_rows").select("raw_row").eq("distributor_code", p.distributorCode).limit(8);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const rr = r.raw_row;
        if (rr && typeof rr === "object") for (const k of Object.keys(rr as Record<string, unknown>)) { const t = k.trim(); if (t) keys.add(t); }
      }
    } catch { /* keep the seeded columns */ }
    out[p.distributorCode] = [...keys].sort((a, b) => a.localeCompare(b));
  }));
  return out;
}
