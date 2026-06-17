// Weekly Sales — unified per-distributor mapping service.
//
// One table (weekly_distributor_mapping) translates a distributor's own raw labels into
// official Phoenix codes, in two dimensions:
//   • product → raw item code/name           → official source_of_sales product_code
//   • region  → raw branch column / customer  → official region_code
//
// The official codes + product price are NOT stored here; they are referenced from the
// Source-of-Sales product/region masters by code only (via loadSalesReferenceData), exactly
// as the weekly parser already does. Only this mapping layer is weekly-owned.
//
// map_type distinguishes POS's separate Sales and Stock files (whose branch columns differ);
// every other distributor uses 'combined'. The raw-value normalization reuses
// normalizeWeeklyPosColumnName so migrated POS region rows keep matching at parse time.

import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeWeeklyPosColumnName } from "@/lib/sales/weekly/pos-region-mappings";
import { weeklyMappingDistributors } from "@/lib/sales/weekly/templates";

export type MappingDimension = "product" | "region";
export type MapType = "sales" | "stock" | "combined";

export type WeeklyMappingRow = {
  id: string;
  distributorCode: string;
  dimension: MappingDimension;
  mapType: MapType;
  rawValue: string;
  normalizedRawValue: string;
  officialCode: string;
  officialName: string;
  updatedAt: string;
};

/** Shape consumed by the parser when translating a raw file. */
export type WeeklyMappingReference = {
  rawValue: string;
  normalizedRawValue: string;
  officialCode: string;
};

export type OfficialProductRef = { code: string; name: string; line: string; price: number };
export type OfficialRegionRef = { code: string; name: string };

export type WeeklyMappingDistributor = { code: string; name: string };

export type WeeklyMappingAdmin = {
  distributorCode: string;
  distributors: WeeklyMappingDistributor[];
  product: WeeklyMappingRow[];
  region: WeeklyMappingRow[];
  productRefs: OfficialProductRef[];
  regionRefs: OfficialRegionRef[];
};

export type WeeklyMappingUpsertResult = {
  inserted: number;
  updated: number;
  skipped: number;
  blockedRows: { row: number; key: string; reason: string }[];
};

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

const clean = (v: unknown) => String(v ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const codeKey = (v: unknown) => clean(v).toUpperCase();

/** Raw-label normalization — shared with the POS region path for parse-time match parity. */
export function normalizeMappingValue(value: unknown): string {
  return normalizeWeeklyPosColumnName(value);
}

function isMissingTable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  const c = String((error as { code?: unknown })?.code ?? "");
  return c === "42P01" || /weekly_distributor_mapping|does not exist|Could not find the table/i.test(msg);
}

function resolveDistributorCode(distributorCode: unknown): string {
  const requested = codeKey(distributorCode);
  const distributors = weeklyMappingDistributors();
  const match = distributors.find((d) => d.code.toUpperCase() === requested);
  return match?.code ?? distributors[0]?.code ?? "PS";
}

export type OfficialRefs = {
  products: Map<string, OfficialProductRef>;
  regions: Map<string, OfficialRegionRef>;
  productRefs: OfficialProductRef[];
  regionRefs: OfficialRegionRef[];
};

/** Load the official product + region reference from the Source-of-Sales masters (by code only). */
export async function loadOfficialRefs(): Promise<OfficialRefs> {
  const refs = await loadSalesReferenceData({ includeCustomerBricks: false });
  const products = new Map<string, OfficialProductRef>();
  for (const p of refs.products ?? []) {
    const key = codeKey(p.productCode);
    if (key && !products.has(key)) {
      products.set(key, { code: clean(p.productCode), name: clean(p.productName), line: clean(p.line), price: Number(p.factoryPrice) || 0 });
    }
  }
  const regions = new Map<string, OfficialRegionRef>();
  for (const r of refs.regions ?? []) {
    const key = codeKey(r.regionCode);
    if (key && !regions.has(key)) regions.set(key, { code: clean(r.regionCode), name: clean(r.regionName) });
  }
  return {
    products,
    regions,
    productRefs: [...products.values()].sort((a, b) => a.code.localeCompare(b.code)),
    regionRefs: [...regions.values()].sort((a, b) => a.code.localeCompare(b.code)),
  };
}

function officialNameFor(dimension: MappingDimension, officialCode: string, refs: OfficialRefs): string {
  const key = codeKey(officialCode);
  return dimension === "product" ? (refs.products.get(key)?.name ?? "") : (refs.regions.get(key)?.name ?? "");
}

// ── parser-facing read ─────────────────────────────────────────────────────────────────────────

/** Load mapping rows for one distributor + dimension + map type, in the parser's expected shape. */
export async function listMapping(
  distributorCode: string,
  dimension: MappingDimension,
  mapType: MapType = "combined",
): Promise<WeeklyMappingReference[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("weekly_distributor_mapping")
    .select("raw_value, normalized_raw_value, official_code")
    .eq("distributor_code", codeKey(distributorCode))
    .eq("dimension", dimension)
    .eq("map_type", mapType)
    .order("raw_value");
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data ?? []).map((row) => ({
    rawValue: String(row.raw_value ?? ""),
    normalizedRawValue: String(row.normalized_raw_value ?? ""),
    officialCode: String(row.official_code ?? ""),
  }));
}

// ── admin read ──────────────────────────────────────────────────────────────────────────────────

/** Full admin payload for the Weekly Mapping UI + workbook for one distributor. */
export async function loadMappingAdmin(distributorCode?: string): Promise<WeeklyMappingAdmin> {
  const distributors: WeeklyMappingDistributor[] = weeklyMappingDistributors().map((d) => ({
    code: d.code,
    name: d.name,
  }));
  const activeCode = resolveDistributorCode(distributorCode);
  const [refs, supabase] = [await loadOfficialRefs(), getSupabaseAdmin()];

  const { data, error } = await supabase
    .from("weekly_distributor_mapping")
    .select("id, distributor_code, dimension, map_type, raw_value, normalized_raw_value, official_code, updated_at")
    .eq("distributor_code", activeCode)
    .order("dimension")
    .order("map_type")
    .order("raw_value");
  if (error && !isMissingTable(error)) throw error;

  const rows: WeeklyMappingRow[] = (data ?? []).map((row) => {
    const dimension = (row.dimension as MappingDimension) ?? "region";
    const officialCode = String(row.official_code ?? "");
    return {
      id: String(row.id ?? ""),
      distributorCode: String(row.distributor_code ?? activeCode),
      dimension,
      mapType: (row.map_type as MapType) ?? "combined",
      rawValue: String(row.raw_value ?? ""),
      normalizedRawValue: String(row.normalized_raw_value ?? ""),
      officialCode,
      officialName: officialNameFor(dimension, officialCode, refs),
      updatedAt: String(row.updated_at ?? ""),
    };
  });

  return {
    distributorCode: activeCode,
    distributors,
    product: rows.filter((r) => r.dimension === "product"),
    region: rows.filter((r) => r.dimension === "region"),
    productRefs: refs.productRefs,
    regionRefs: refs.regionRefs,
  };
}

// ── per-row classifier (pure; testable) ───────────────────────────────────────────────────────

export type MappingClassifyContext = {
  dimension: MappingDimension;
  validCodes: Set<string>; // uppercased official codes valid for this dimension
  seen: Map<string, string>; // normalized raw value -> official code already accepted in this batch
};

export type MappingClassification =
  | { kind: "skip-blank" }
  | { kind: "duplicate" } // same raw value → same official code as an earlier row; apply once
  | { kind: "blocked"; key: string; reason: string }
  | { kind: "ok"; normalizedRawValue: string; rawValue: string; officialCode: string };

export function classifyMappingRow(
  raw: { rawValue?: unknown; officialCode?: unknown },
  ctx: MappingClassifyContext,
): MappingClassification {
  const rawValue = clean(raw.rawValue);
  const officialCode = codeKey(raw.officialCode);

  if (!rawValue && !officialCode) return { kind: "skip-blank" };
  if (!rawValue) return { kind: "blocked", key: "", reason: "Raw value is required." };

  const normalizedRawValue = normalizeMappingValue(rawValue);
  if (!normalizedRawValue) {
    return { kind: "blocked", key: rawValue, reason: `Raw value "${rawValue}" could not be normalized.` };
  }
  if (!officialCode) {
    return { kind: "blocked", key: rawValue, reason: `Official ${ctx.dimension} code is required for "${rawValue}".` };
  }
  if (!ctx.validCodes.has(officialCode)) {
    return {
      kind: "blocked",
      key: rawValue,
      reason: `Official ${ctx.dimension} code "${officialCode}" is not in the Source of Sales ${ctx.dimension} master.`,
    };
  }

  // Two rows can share a normalized key (e.g. "Helwan K.Acc" and "Helwan K.Acc_ك").
  // Same target → apply once (silent dedup); different targets → a real conflict to resolve.
  const prior = ctx.seen.get(normalizedRawValue);
  if (prior !== undefined) {
    if (prior === officialCode) return { kind: "duplicate" };
    return {
      kind: "blocked",
      key: rawValue,
      reason: `"${rawValue}" maps to ${officialCode}, but another row maps the same value to ${prior}. Resolve the conflict.`,
    };
  }
  ctx.seen.set(normalizedRawValue, officialCode);
  return { kind: "ok", normalizedRawValue, rawValue, officialCode };
}

// ── write ────────────────────────────────────────────────────────────────────────────────────────

/** Add or update mapping rows for one distributor + dimension + map type. Valid rows apply; bad rows are reported. */
export async function upsertMappingRows(input: {
  actorId: string;
  distributorCode: string;
  dimension: MappingDimension;
  mapType: MapType;
  rows: { rawValue: string; officialCode: string }[];
  refs?: OfficialRefs;
}): Promise<WeeklyMappingUpsertResult> {
  const distributorCode = resolveDistributorCode(input.distributorCode);
  const refs = input.refs ?? (await loadOfficialRefs());
  const validCodes =
    input.dimension === "product"
      ? new Set([...refs.products.keys()])
      : new Set([...refs.regions.keys()]);
  const supabase = getSupabaseAdmin();

  const ctx: MappingClassifyContext = { dimension: input.dimension, validCodes, seen: new Map() };
  const blockedRows: WeeklyMappingUpsertResult["blockedRows"] = [];
  const payload: {
    distributor_code: string;
    dimension: string;
    map_type: string;
    raw_value: string;
    normalized_raw_value: string;
    official_code: string;
    updated_by: string;
    updated_at: string;
  }[] = [];
  let skipped = 0;

  input.rows.forEach((row, index) => {
    const result = classifyMappingRow(row, ctx);
    if (result.kind === "skip-blank" || result.kind === "duplicate") {
      skipped += 1;
      return;
    }
    if (result.kind === "blocked") {
      blockedRows.push({ row: index + 2, key: result.key, reason: result.reason });
      return;
    }
    payload.push({
      distributor_code: distributorCode,
      dimension: input.dimension,
      map_type: input.mapType,
      raw_value: result.rawValue,
      normalized_raw_value: result.normalizedRawValue,
      official_code: result.officialCode,
      updated_by: input.actorId,
      updated_at: new Date().toISOString(),
    });
  });

  if (payload.length === 0) return { inserted: 0, updated: 0, skipped, blockedRows };

  const existing = await supabase
    .from("weekly_distributor_mapping")
    .select("normalized_raw_value")
    .eq("distributor_code", distributorCode)
    .eq("dimension", input.dimension)
    .eq("map_type", input.mapType)
    .in("normalized_raw_value", payload.map((p) => p.normalized_raw_value));
  if (existing.error) throw existing.error;
  const existingKeys = new Set((existing.data ?? []).map((r) => String(r.normalized_raw_value ?? "")));

  const upsert = await supabase
    .from("weekly_distributor_mapping")
    .upsert(payload, { onConflict: "distributor_code,dimension,map_type,normalized_raw_value" });
  if (upsert.error) throw upsert.error;

  let inserted = 0;
  let updated = 0;
  for (const row of payload) {
    if (existingKeys.has(row.normalized_raw_value)) updated += 1;
    else inserted += 1;
  }
  return { inserted, updated, skipped, blockedRows };
}

/** Delete a single mapping row by its UUID. */
export async function deleteMappingRow(id: string): Promise<void> {
  if (!id) throw new SalesWorkflowError("invalid_id", "Row ID is required.", 400);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("weekly_distributor_mapping").delete().eq("id", id);
  if (error) throw new SalesWorkflowError("delete_failed", error.message, 500);
}
