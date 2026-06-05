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

const PROFILE_TABLE = "source_of_sales_distributor_profile";

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

const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map((x) => String(x).trim()).filter(Boolean) : []);

// DB row -> editable shape for the UI (one cell per field, exact order).
function rowToEditable(code: string, row: Record<string, unknown>): EditableProfile {
  return {
    distributorCode: code,
    distributorName: rawProfileForDistributor(code)?.distributorName ?? code,
    valueSource: row.value_source === "sheet" ? "sheet" : "recompute",
    regionOnly: Boolean(row.region_only),
    isCustom: true,
    fields: {
      productCodeColumns: arr(row.product_code_columns),
      productNameColumns: arr(row.product_name_columns),
      qtyColumns: arr(row.qty_columns),
      branchCodeColumns: arr(row.branch_code_columns),
      branchNameColumns: arr(row.branch_name_columns),
      bonusColumns: arr(row.bonus_columns),
      valueColumns: arr(row.value_columns),
      discountColumns: arr(row.discount_columns),
      dateColumns: arr(row.date_columns),
      customerCodeColumns: arr(row.customer_code_columns),
      customerNameColumns: arr(row.customer_name_columns),
      customerAddressColumns: arr(row.customer_address_columns),
      areaIdColumns: arr(row.area_id_columns),
      areaNameColumns: arr(row.area_name_columns),
      brickIdColumns: arr(row.brick_id_columns),
      brickNameColumns: arr(row.brick_name_columns),
      regionColumns: arr(row.region_columns),
    },
  };
}

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
      productCodeColumns: product.slice(0, 1),
      productNameColumns: product.slice(1),
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

// DB row -> engine DistributorProfile. productColumns = code then name; the brick is resolved from the
// geography text columns (Area ID / Area Name / Region) and/or the direct Brick ID.
function rowToProfile(code: string, row: Record<string, unknown>): DistributorProfile {
  return {
    distributorCode: code,
    distributorName: rawProfileForDistributor(code)?.distributorName ?? code,
    productColumns: [...arr(row.product_code_columns), ...arr(row.product_name_columns)],
    qtyColumns: arr(row.qty_columns),
    bonusColumns: arr(row.bonus_columns),
    valueColumns: arr(row.value_columns),
    valueSource: row.value_source === "sheet" ? "sheet" : "recompute",
    dateColumns: arr(row.date_columns),
    customerCodeColumns: arr(row.customer_code_columns),
    customerNameColumns: arr(row.customer_name_columns),
    customerAddressColumns: arr(row.customer_address_columns),
    territoryColumns: [...arr(row.area_id_columns), ...arr(row.area_name_columns), ...arr(row.region_columns)],
    brickIdColumns: arr(row.brick_id_columns),
    discountColumns: arr(row.discount_columns),
    regionOnly: Boolean(row.region_only),
  };
}

// DB-first resolve for ONE distributor — used by the normalizer engine.
export async function resolveDistributorProfile(distributorCode: string): Promise<DistributorProfile | null> {
  const code = String(distributorCode ?? "").trim().toUpperCase();
  if (!code) return null;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from(PROFILE_TABLE).select("*").eq("distributor_code", code).eq("active", true).maybeSingle();
    if (!error && data) return rowToProfile(code, data as Record<string, unknown>);
  } catch { /* table absent / db error -> code fallback */ }
  return rawProfileForDistributor(code);
}

// All distributors as editable profiles (DB override where present, else code default).
export async function listEditableProfiles(): Promise<EditableProfile[]> {
  let dbRows: Record<string, unknown>[] = [];
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase.from(PROFILE_TABLE).select("*").eq("active", true);
    dbRows = (data ?? []) as Record<string, unknown>[];
  } catch { /* ignore — all code defaults */ }
  const byCode = new Map(dbRows.map((r) => [String(r.distributor_code ?? "").toUpperCase(), r]));
  return RAW_DISTRIBUTOR_PROFILES.map((p) => {
    const row = byCode.get(p.distributorCode.toUpperCase());
    return row ? rowToEditable(p.distributorCode, row) : defaultToEditable(p);
  });
}

export type SaveProfileInput = {
  fields: Record<string, string[]>;
  valueSource: "recompute" | "sheet";
  regionOnly: boolean;
};

export async function saveDistributorProfile(distributorCode: string, input: SaveProfileInput, updatedBy: string): Promise<void> {
  const code = String(distributorCode ?? "").trim().toUpperCase();
  if (!code) throw new Error("Distributor code is required.");
  if (!RAW_DISTRIBUTOR_PROFILES.some((p) => p.distributorCode.toUpperCase() === code)) {
    throw new Error(`Unknown distributor: ${code}`);
  }
  const f = input.fields;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(PROFILE_TABLE).upsert({
    distributor_code: code,
    product_code_columns: arr(f.productCodeColumns),
    product_name_columns: arr(f.productNameColumns),
    qty_columns: arr(f.qtyColumns),
    branch_code_columns: arr(f.branchCodeColumns),
    branch_name_columns: arr(f.branchNameColumns),
    bonus_columns: arr(f.bonusColumns),
    value_columns: arr(f.valueColumns),
    discount_columns: arr(f.discountColumns),
    date_columns: arr(f.dateColumns),
    customer_code_columns: arr(f.customerCodeColumns),
    customer_name_columns: arr(f.customerNameColumns),
    customer_address_columns: arr(f.customerAddressColumns),
    area_id_columns: arr(f.areaIdColumns),
    area_name_columns: arr(f.areaNameColumns),
    brick_id_columns: arr(f.brickIdColumns),
    brick_name_columns: arr(f.brickNameColumns),
    region_columns: arr(f.regionColumns),
    value_source: input.valueSource === "sheet" ? "sheet" : "recompute",
    region_only: Boolean(input.regionOnly),
    active: true,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  }, { onConflict: "distributor_code" });
  if (error) throw new Error(`Failed to save distributor profile: ${error.message ?? "unknown error"}`);
}

// Reset one distributor back to the code default (delete its override row).
export async function resetDistributorProfile(distributorCode: string): Promise<void> {
  const code = String(distributorCode ?? "").trim().toUpperCase();
  if (!code) return;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from(PROFILE_TABLE).delete().eq("distributor_code", code);
  if (error) throw new Error(`Failed to reset distributor profile: ${error.message ?? "unknown error"}`);
}

// The "puzzle pieces": each distributor's real raw column headers, harvested from a sample of its
// imported rows (raw_row preserves the original sheet headers). Empty for distributors not yet imported.
export async function listDistributorHeaders(): Promise<Record<string, string[]>> {
  const supabase = getSupabaseAdmin();
  const out: Record<string, string[]> = {};
  await Promise.all(RAW_DISTRIBUTOR_PROFILES.map(async (p) => {
    try {
      const { data } = await supabase.from("source_of_sales_import_rows").select("raw_row").eq("distributor_code", p.distributorCode).limit(8);
      const keys = new Set<string>();
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const rr = r.raw_row;
        if (rr && typeof rr === "object") for (const k of Object.keys(rr as Record<string, unknown>)) { const t = k.trim(); if (t) keys.add(t); }
      }
      out[p.distributorCode] = [...keys].sort((a, b) => a.localeCompare(b));
    } catch { out[p.distributorCode] = []; }
  }));
  return out;
}
