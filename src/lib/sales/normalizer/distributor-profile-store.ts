// DB-first distributor column-mapping store. The normalizer resolves a distributor's profile from the
// editable `source_of_sales_distributor_profile` table when a row exists, else falls back to the
// code-defined RAW_DISTRIBUTOR_PROFILES — so the table can start empty and edits take effect on the
// next normalize. Server-only (service-role).

import { RAW_DISTRIBUTOR_PROFILES, rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import type { DistributorProfile } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const PROFILE_TABLE = "source_of_sales_distributor_profile";

// The editable fields, in display order. label = the Phoenix target shown in the editor.
export const PROFILE_FIELDS = [
  { key: "productColumns", column: "product_columns", label: "Product (code / name)" },
  { key: "qtyColumns", column: "qty_columns", label: "Quantity" },
  { key: "bonusColumns", column: "bonus_columns", label: "Bonus Qty" },
  { key: "valueColumns", column: "value_columns", label: "Value" },
  { key: "discountColumns", column: "discount_columns", label: "Discount %" },
  { key: "dateColumns", column: "date_columns", label: "Invoice Date" },
  { key: "customerCodeColumns", column: "customer_code_columns", label: "Customer Code" },
  { key: "customerNameColumns", column: "customer_name_columns", label: "Customer Name" },
  { key: "territoryColumns", column: "territory_columns", label: "Territory → Brick" },
  { key: "brickIdColumns", column: "brick_id_columns", label: "Brick ID (if sheet has one)" },
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

function rowToProfile(code: string, row: Record<string, unknown>): DistributorProfile {
  return {
    distributorCode: code,
    distributorName: rawProfileForDistributor(code)?.distributorName ?? code,
    productColumns: arr(row.product_columns),
    qtyColumns: arr(row.qty_columns),
    bonusColumns: arr(row.bonus_columns),
    valueColumns: arr(row.value_columns),
    valueSource: row.value_source === "sheet" ? "sheet" : "recompute",
    dateColumns: arr(row.date_columns),
    customerCodeColumns: arr(row.customer_code_columns),
    customerNameColumns: arr(row.customer_name_columns),
    territoryColumns: arr(row.territory_columns),
    brickIdColumns: arr(row.brick_id_columns),
    discountColumns: arr(row.discount_columns),
    regionOnly: Boolean(row.region_only),
  };
}

function profileToEditable(p: DistributorProfile, isCustom: boolean): EditableProfile {
  return {
    distributorCode: p.distributorCode,
    distributorName: p.distributorName,
    valueSource: p.valueSource,
    regionOnly: Boolean(p.regionOnly),
    isCustom,
    fields: {
      productColumns: p.productColumns ?? [],
      qtyColumns: p.qtyColumns ?? [],
      bonusColumns: p.bonusColumns ?? [],
      valueColumns: p.valueColumns ?? [],
      discountColumns: p.discountColumns ?? [],
      dateColumns: p.dateColumns ?? [],
      customerCodeColumns: p.customerCodeColumns ?? [],
      customerNameColumns: p.customerNameColumns ?? [],
      territoryColumns: p.territoryColumns ?? [],
      brickIdColumns: p.brickIdColumns ?? [],
    },
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
    return row ? profileToEditable(rowToProfile(p.distributorCode, row), true) : profileToEditable(p, false);
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
    product_columns: arr(f.productColumns),
    qty_columns: arr(f.qtyColumns),
    bonus_columns: arr(f.bonusColumns),
    value_columns: arr(f.valueColumns),
    discount_columns: arr(f.discountColumns),
    date_columns: arr(f.dateColumns),
    customer_code_columns: arr(f.customerCodeColumns),
    customer_name_columns: arr(f.customerNameColumns),
    territory_columns: arr(f.territoryColumns),
    brick_id_columns: arr(f.brickIdColumns),
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
