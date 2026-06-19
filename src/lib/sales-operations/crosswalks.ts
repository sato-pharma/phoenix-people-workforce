// Sales Operations Module — crosswalk loader.
//
// Builds every lookup the pure resolvers need (see types.ts / normalize.ts). The Phoenix MASTERS
// (brick→area→region, products) and the customer→brick crosswalk are read via the existing
// loadSalesReferenceData() — that is drift-tolerant master-data loading, not engine logic, so it is
// reused rather than re-implemented. On top of it this module adds:
//   • productByName — a collision-safe master product-NAME index that powers name-first resolution
//     even without a learned alias;
//   • the learned alias tables (product / territory / area), fully paged.

import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { normalizeAliasKey, normalizeCodeKey, numericCanonicalKey } from "@/lib/sales-operations/normalize";
import type { Crosswalks, ProductRef } from "@/lib/sales-operations/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;
type SalesReferenceData = Awaited<ReturnType<typeof loadSalesReferenceData>>;

// Read EVERY active row of an alias table, paging past PostgREST's 1000-row cap. Tolerant of a
// missing table (returns what it gathered) so pre-migration / fresh setups still work.
async function selectAllActive(supabase: SupabaseAdmin, table: string, columns: string): Promise<Array<Record<string, unknown>>> {
  const pageSize = 1000;
  const rows: Array<Record<string, unknown>> = [];
  let from = 0;
  for (;;) {
    const result = await supabase.from(table).select(columns).eq("active", true).range(from, from + pageSize - 1);
    if (result.error) break; // tolerate (e.g. table absent); return rows gathered so far
    const page = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

// Build the master product-NAME index (normalized name → product code). Collision-safe: if two
// distinct products share a normalized name the entry is DROPPED, so name resolution never
// mis-maps to the wrong product (it falls through to the code fallback instead).
export function buildProductByName(products: SalesReferenceData["products"]): Map<string, string> {
  const byName = new Map<string, string>();
  const conflict = new Set<string>();
  for (const p of products) {
    const code = normalizeCodeKey(p.productCode);
    const key = normalizeAliasKey(p.productName);
    if (!key || !code) continue;
    if (conflict.has(key)) continue;
    const existing = byName.get(key);
    if (existing === undefined) byName.set(key, code);
    else if (existing !== code) {
      byName.delete(key);
      conflict.add(key);
    }
  }
  return byName;
}

// Collision-safe numeric-canonical product index (leading-zero / number-vs-text drift fallback).
function buildProductByCanonicalCode(products: SalesReferenceData["products"]): Map<string, string> {
  const byCanon = new Map<string, string>();
  const conflict = new Set<string>();
  for (const p of products) {
    const code = normalizeCodeKey(p.productCode);
    const canon = numericCanonicalKey(code);
    if (!canon || conflict.has(canon)) continue;
    const existing = byCanon.get(canon);
    if (existing === undefined) byCanon.set(canon, code);
    else if (existing !== code) {
      byCanon.delete(canon);
      conflict.add(canon);
    }
  }
  return byCanon;
}

// Load the full crosswalk bundle for the Sales Operations engine.
export async function loadSalesOperationsCrosswalks(preRefs?: SalesReferenceData): Promise<Crosswalks> {
  const supabase = getSupabaseAdmin();
  const [refs, prodAliases, terrAliases, areaAliases] = await Promise.all([
    preRefs ?? loadSalesReferenceData(),
    selectAllActive(supabase, "source_of_sales_product_aliases", "alias,product_code,distributor_code"),
    selectAllActive(supabase, "source_of_sales_territory_aliases", "alias,target_type,target_code"),
    selectAllActive(supabase, "source_of_sales_area_aliases", "alias,area_code,region_code"),
  ]);

  // ── Phoenix masters ──
  const brickById = new Map((refs.bricks ?? []).map((b) => [normalizeCodeKey(b.brickId), {
    areaCode: normalizeCodeKey(b.areaCode),
    areaName: b.areaName,
    blockCode: b.blockCode,
    brickId: normalizeCodeKey(b.brickId),
    brickName: b.brickName,
    regionCode: normalizeCodeKey(b.regionCode),
    regionName: b.regionName,
  }]));
  const areaByCode = new Map((refs.areas ?? []).map((a) => [normalizeCodeKey(a.areaCode), {
    areaCode: normalizeCodeKey(a.areaCode),
    areaName: a.areaName,
    regionCode: normalizeCodeKey(a.regionCode),
    regionName: a.regionName,
  }]));
  const regionByCode = new Map((refs.regions ?? []).map((r) => [normalizeCodeKey(r.regionCode), {
    regionCode: normalizeCodeKey(r.regionCode),
    regionName: r.regionName,
  }]));
  const productByCode = new Map<string, ProductRef>((refs.products ?? []).map((p) => [normalizeCodeKey(p.productCode), {
    productCode: normalizeCodeKey(p.productCode),
    productName: p.productName,
    factoryPrice: p.factoryPrice,
    family: p.family,
    line: p.line,
  }]));
  const productByName = buildProductByName(refs.products ?? []);
  const productByCanonicalCode = buildProductByCanonicalCode(refs.products ?? []);

  // ── learned aliases ──
  // Product aliases are PER-DISTRIBUTOR: `${distributor} ${normalizedAlias}` → product code.
  const productAliasByKey = new Map<string, string>();
  for (const row of prodAliases) {
    const dist = normalizeCodeKey(row.distributor_code);
    const key = normalizeAliasKey(row.alias);
    const code = normalizeCodeKey(row.product_code);
    if (dist && key && code) productAliasByKey.set(`${dist} ${key}`, code);
  }
  const territoryAliasByKey = new Map<string, { targetType: string; targetCode: string }>();
  for (const row of terrAliases) {
    const key = normalizeAliasKey(row.alias);
    if (key) territoryAliasByKey.set(key, { targetType: String(row.target_type ?? "brick").toLowerCase(), targetCode: String(row.target_code ?? "") });
  }
  const areaAliasByKey = new Map<string, { areaCode: string; regionCode: string }>();
  for (const row of areaAliases) {
    const key = normalizeAliasKey(row.alias);
    if (key) areaAliasByKey.set(key, { areaCode: String(row.area_code ?? ""), regionCode: String(row.region_code ?? "") });
  }

  // ── customer → brick crosswalk (from loadSalesReferenceData), exact + numeric-canonical ──
  const customerBrickByKey = new Map<string, string>();
  const customerBrickByCanonicalKey = new Map<string, string>();
  const customerCanonConflict = new Set<string>();
  for (const row of refs.customerBricks ?? []) {
    const dist = normalizeCodeKey(row.distributorCode);
    const brick = normalizeCodeKey(row.brickId);
    if (!brick) continue;
    customerBrickByKey.set(`${dist} ${normalizeCodeKey(row.customerCode)}`, brick);
    const canon = numericCanonicalKey(row.customerCode);
    if (!canon) continue;
    const ckey = `${dist} ${canon}`;
    if (customerCanonConflict.has(ckey)) continue;
    const existing = customerBrickByCanonicalKey.get(ckey);
    if (existing === undefined) customerBrickByCanonicalKey.set(ckey, brick);
    else if (existing !== brick) {
      customerBrickByCanonicalKey.delete(ckey);
      customerCanonConflict.add(ckey);
    }
  }

  return {
    brickById,
    areaByCode,
    regionByCode,
    productByCode,
    productByName,
    productByCanonicalCode,
    productAliasByKey,
    territoryAliasByKey,
    areaAliasByKey,
    customerBrickByKey,
    customerBrickByCanonicalKey,
  };
}
