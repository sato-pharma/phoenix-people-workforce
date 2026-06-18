import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { normalizeAliasKey, normalizeCodeKey, numericCanonicalKey } from "@/lib/sales/normalizer/resolvers";
import type { Crosswalks } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

// Read EVERY active row of an alias / crosswalk table, paging past PostgREST's 1000-row default cap.
// Without this, large tables (territory aliases + customer_map have thousands of rows) silently
// truncate to the first 1000, so freshly-saved mappings (highest ids, past row 1000) would never load
// and the rows they fix would re-appear as "needs mapping" on re-analyze. Tolerant of a missing table
// (returns what it gathered) so pre-migration setups still work.
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

// Loads every translation the resolvers need: the Phoenix masters (brick→area→region, products)
// plus the learned alias tables (product / territory / area / region) and the customer→brick map,
// ALL fully paginated. Keyed via the same normalize functions the resolvers use, so matching is
// consistent regardless of how the stored normalized_alias was produced.
export async function loadCrosswalks(preRefs?: Awaited<ReturnType<typeof loadSalesReferenceData>>): Promise<Crosswalks> {
  const supabase = getSupabaseAdmin();
  const [refs, prodA, terrA, areaA, regionA, custMap] = await Promise.all([
    preRefs ?? loadSalesReferenceData(),
    selectAllActive(supabase, "source_of_sales_product_aliases", "alias,product_code,distributor_code"),
    selectAllActive(supabase, "source_of_sales_territory_aliases", "alias,target_type,target_code"),
    selectAllActive(supabase, "source_of_sales_area_aliases", "alias,area_code,region_code"),
    selectAllActive(supabase, "source_of_sales_region_aliases", "alias,region_code"),
    // customer→brick crosswalk (added by the normalizer migration; tolerate absence pre-migration)
    selectAllActive(supabase, "source_of_sales_customer_map", "distributor_code,customer_code,brick_id"),
  ]);

  const brickById = new Map((refs.bricks ?? []).map((b) => [normalizeCodeKey(b.brickId), {
    areaCode: normalizeCodeKey(b.areaCode), areaName: b.areaName, blockCode: b.blockCode, brickId: normalizeCodeKey(b.brickId),
    brickName: b.brickName, regionCode: normalizeCodeKey(b.regionCode), regionName: b.regionName,
  }]));
  const areaByCode = new Map((refs.areas ?? []).map((a) => [normalizeCodeKey(a.areaCode), {
    areaCode: normalizeCodeKey(a.areaCode), areaName: a.areaName, regionCode: normalizeCodeKey(a.regionCode), regionName: a.regionName,
  }]));
  const regionByCode = new Map(refs.regions.map((r) => [normalizeCodeKey(r.regionCode), { regionCode: normalizeCodeKey(r.regionCode), regionName: r.regionName }]));
  const productByCode = new Map(refs.products.map((p) => [normalizeCodeKey(p.productCode), {
    productCode: normalizeCodeKey(p.productCode), productName: p.productName, factoryPrice: p.factoryPrice, line: p.line,
  }]));
  // Numeric-canonical product index (collision-safe): only for purely-numeric product codes.
  const productByCanonicalCode = new Map<string, string>();
  const productCanonConflict = new Set<string>();
  for (const p of refs.products) {
    const code = normalizeCodeKey(p.productCode);
    const canon = numericCanonicalKey(code);
    if (!canon || productCanonConflict.has(canon)) continue;
    const existing = productByCanonicalCode.get(canon);
    if (existing === undefined) productByCanonicalCode.set(canon, code);
    else if (existing !== code) { productByCanonicalCode.delete(canon); productCanonConflict.add(canon); }
  }

  // Per-distributor: key by `${distributor} ${normalized alias}` so each distributor's raw codes/names
  // resolve only for that distributor (resolveProduct builds the same composite key).
  const productAliasByKey = new Map<string, string>();
  for (const row of prodA) {
    const dist = normalizeCodeKey(row.distributor_code);
    const key = normalizeAliasKey(row.alias); const code = normalizeCodeKey(row.product_code);
    if (dist && key && code) productAliasByKey.set(`${dist} ${key}`, code);
  }
  const territoryAliasByKey = new Map<string, { targetType: string; targetCode: string }>();
  for (const row of terrA) {
    const key = normalizeAliasKey(row.alias);
    if (key) territoryAliasByKey.set(key, { targetType: String(row.target_type ?? "brick").toLowerCase(), targetCode: String(row.target_code ?? "") });
  }
  const areaAliasByKey = new Map<string, { areaCode: string; regionCode: string }>();
  for (const row of areaA) {
    const key = normalizeAliasKey(row.alias);
    if (key) areaAliasByKey.set(key, { areaCode: String(row.area_code ?? ""), regionCode: String(row.region_code ?? "") });
  }
  const regionAliasByKey = new Map<string, string>();
  for (const row of regionA) {
    const key = normalizeAliasKey(row.alias);
    if (key) regionAliasByKey.set(key, normalizeCodeKey(row.region_code));
  }
  const customerBrickByKey = new Map<string, string>();
  // Numeric-canonical customer index (collision-safe): tolerates leading-zero / number-vs-text drift.
  const customerBrickByCanonicalKey = new Map<string, string>();
  const customerCanonConflict = new Set<string>();
  for (const row of custMap) {
    const dist = normalizeCodeKey(row.distributor_code);
    const brick = normalizeCodeKey(row.brick_id);
    if (!brick) continue;
    customerBrickByKey.set(`${dist} ${normalizeCodeKey(row.customer_code)}`, brick);
    const canon = numericCanonicalKey(row.customer_code);
    if (!canon) continue;
    const ckey = `${dist} ${canon}`;
    if (customerCanonConflict.has(ckey)) continue;
    const existing = customerBrickByCanonicalKey.get(ckey);
    if (existing === undefined) customerBrickByCanonicalKey.set(ckey, brick);
    else if (existing !== brick) { customerBrickByCanonicalKey.delete(ckey); customerCanonConflict.add(ckey); }
  }

  return { areaAliasByKey, areaByCode, brickById, customerBrickByKey, customerBrickByCanonicalKey, productAliasByKey, productByCode, productByCanonicalCode, regionAliasByKey, regionByCode, territoryAliasByKey };
}
