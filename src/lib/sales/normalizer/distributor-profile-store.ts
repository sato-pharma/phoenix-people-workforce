// Distributor column mappings: code profiles (RAW_DISTRIBUTOR_PROFILES, from the Headers Mapping sheet)
// MERGED with a governed, DB-backed editable override (source_of_sales_distributor_profile). An active
// DB row WHOLLY overrides the code profile for that distributor (whole-profile override, per owner
// decision); code is the fallback/seed; a DB-only row is a newly-onboarded distributor. Server-only.
//
// Resolution is DB-first with a short cache. If the table is absent (unapplied migration) the load
// fails CLOSED to the code profiles and LOGS — it never silently behaves as code-only without a trace.

import { logError } from "@/lib/observability/log";
import { FREE_GOODS_FLAG_LABEL } from "@/lib/sales/normalizer/free-goods-flag";
import { RAW_DISTRIBUTOR_PROFILES, rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { DistributorProfile } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// The mapping fields, in the exact column order of the exported workbook + the DB table columns —
// consumed by the read-only "Distributor Mapping" viewer, the editor, and distributor auto-detection.
export const PROFILE_FIELDS = [
  { key: "productCodeColumns", column: "product_code_columns", label: "Product Code" },
  { key: "productNameColumns", column: "product_name_columns", label: "Product Name" },
  { key: "qtyColumns", column: "qty_columns", label: "Quantity" },
  { key: "branchCodeColumns", column: "branch_code_columns", label: "Branch Code" },
  { key: "branchNameColumns", column: "branch_name_columns", label: "Branch Name" },
  // A free-goods FLAG that skips the whole row, never a bonus quantity (free-goods-flag.ts).
  { key: "bonusColumns", column: "bonus_columns", label: FREE_GOODS_FLAG_LABEL },
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
  isCustom: boolean; // true → sourced from a DB override row (edited/onboarded in-app); false → code default
  fields: Record<ProfileFieldKey, string[]>;
};

const PROFILE_TABLE = "source_of_sales_distributor_profile";
const CACHE_TTL_MS = 30_000;

export type DbProfileRow = {
  distributor_code: string;
  distributor_name?: string | null;
  value_source?: string | null;
  region_only?: boolean | null;
} & Partial<Record<(typeof PROFILE_FIELDS)[number]["column"], unknown>>;

let cache: { at: number; byCode: Map<string, DbProfileRow> } | null = null;

/** Drop the cached DB overrides so the next read reflects a just-saved edit. */
export function invalidateDistributorProfileCache(): void {
  cache = null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

// Active DB override rows keyed by canonical code. Fail-closed to {} on a missing table / error, but LOG
// (so an unapplied migration is visible rather than a silent revert to code-only).
async function loadDbProfiles(): Promise<Map<string, DbProfileRow>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.byCode;
  const byCode = new Map<string, DbProfileRow>();
  // Only a read that SUCCEEDED is cached (cache audit, 2026-10-26). A failed one used to cache the
  // empty map for the whole TTL, so every upload in that window parsed on the code defaults with the
  // saved overrides ignored; now it answers this one call and the next call reads again.
  let loaded = false;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from(PROFILE_TABLE).select("*").eq("active", true);
    if (error) {
      logError("Distributor profile override load failed", {
        labels: { event: "distributor_profile_load_failed", errorCode: error.code ?? "unknown" },
        error,
      });
    } else {
      for (const raw of data ?? []) {
        const row = raw as DbProfileRow;
        const code = normalizeCodeKey(row.distributor_code);
        if (code) byCode.set(code, row);
      }
      loaded = true;
    }
  } catch (e) {
    logError("Distributor profile override load threw", {
      labels: { event: "distributor_profile_load_threw" },
      error: e,
    });
  }
  if (loaded) cache = { at: Date.now(), byCode };
  return byCode;
}

// DB row -> engine DistributorProfile (only the engine-relevant fields; product columns are rebuilt as
// code-then-name for the name-first/code-fallback resolver; territory = area_id; brick = brick_id).
export function dbRowToProfile(row: DbProfileRow): DistributorProfile | null {
  const code = normalizeCodeKey(row.distributor_code);
  if (!code) return null;
  const productCode = strArray(row.product_code_columns);
  const productName = strArray(row.product_name_columns);
  return {
    distributorCode: code,
    distributorName: (row.distributor_name && String(row.distributor_name).trim()) || rawProfileForDistributor(code)?.distributorName || code,
    productColumns: [...productCode, ...productName],
    productCodeColumns: productCode,
    productNameColumns: productName,
    qtyColumns: strArray(row.qty_columns),
    bonusColumns: strArray(row.bonus_columns),
    valueColumns: strArray(row.value_columns),
    discountColumns: strArray(row.discount_columns),
    dateColumns: strArray(row.date_columns),
    customerCodeColumns: strArray(row.customer_code_columns),
    customerNameColumns: strArray(row.customer_name_columns),
    // A code-level BEHAVIOUR flag, not a user-editable column: carry it from the code profile so a DB
    // override (which wins whole-row) keeps El Qema's name-fallback. A blank-code→name key is a rule
    // about this distributor's data shape, not something an operator sets per field.
    customerKeyNameFallback: rawProfileForDistributor(code)?.customerKeyNameFallback,
    customerAddressColumns: strArray(row.customer_address_columns),
    territoryColumns: strArray(row.area_id_columns),
    brickIdColumns: strArray(row.brick_id_columns),
    valueSource: row.value_source === "sheet" ? "sheet" : "recompute",
    regionOnly: Boolean(row.region_only),
  };
}

// DB row -> EditableProfile (ALL 17 fields, for round-tripping in the editor).
export function dbRowToEditable(row: DbProfileRow): EditableProfile {
  const code = normalizeCodeKey(row.distributor_code);
  const fields = {} as Record<ProfileFieldKey, string[]>;
  for (const f of PROFILE_FIELDS) fields[f.key] = strArray(row[f.column]);
  return {
    distributorCode: code,
    distributorName: (row.distributor_name && String(row.distributor_name).trim()) || rawProfileForDistributor(code)?.distributorName || code,
    valueSource: row.value_source === "sheet" ? "sheet" : "recompute",
    regionOnly: Boolean(row.region_only),
    isCustom: true,
    fields,
  };
}

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

// Resolve a distributor's profile: DB override (active) first, else code. (Async signature unchanged.)
export async function resolveDistributorProfile(distributorCode: string): Promise<DistributorProfile | null> {
  const code = normalizeCodeKey(distributorCode);
  if (!code) return null;
  const db = await loadDbProfiles();
  const row = db.get(code);
  return (row && dbRowToProfile(row)) || rawProfileForDistributor(code);
}

// PURE: code ∪ DB profiles, DB wins whole-row (unit-tested precedence).
export function mergeProfilesByCode(codeProfiles: DistributorProfile[], dbProfiles: DistributorProfile[]): DistributorProfile[] {
  const byCode = new Map<string, DistributorProfile>();
  for (const p of codeProfiles) byCode.set(normalizeCodeKey(p.distributorCode), p);
  for (const p of dbProfiles) byCode.set(normalizeCodeKey(p.distributorCode), p);
  return [...byCode.values()];
}

// Every distributor's ENGINE profile, code ∪ DB (DB wins whole-row). Used by the readers that need the
// full fingerprint/recognition set (recognize.ts, registry, the profile viewer).
export async function listMergedDistributorProfiles(): Promise<DistributorProfile[]> {
  const db = await loadDbProfiles();
  const dbProfiles = [...db.values()].map(dbRowToProfile).filter((p): p is DistributorProfile => p !== null);
  return mergeProfilesByCode(RAW_DISTRIBUTOR_PROFILES, dbProfiles);
}

// All distributors as EditableProfiles (code defaults overridden by DB rows). Drives the editor + the
// detection profile builder.
export async function listEditableProfiles(): Promise<EditableProfile[]> {
  const db = await loadDbProfiles();
  const byCode = new Map<string, EditableProfile>();
  for (const p of RAW_DISTRIBUTOR_PROFILES) byCode.set(normalizeCodeKey(p.distributorCode), defaultToEditable(p));
  for (const [code, row] of db) byCode.set(code, dbRowToEditable(row));
  return [...byCode.values()];
}
