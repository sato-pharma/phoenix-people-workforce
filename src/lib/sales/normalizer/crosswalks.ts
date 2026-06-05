import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
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
    selectAllActive(supabase, "source_of_sales_product_aliases", "alias,product_code"),
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

  const productAliasByKey = new Map<string, string>();
  for (const row of prodA) {
    const key = normalizeAliasKey(row.alias); const code = normalizeCodeKey(row.product_code);
    if (key && code) productAliasByKey.set(key, code);
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
  for (const row of custMap) {
    const key = `${normalizeCodeKey(row.distributor_code)} ${normalizeCodeKey(row.customer_code)}`;
    const brick = normalizeCodeKey(row.brick_id);
    if (brick) customerBrickByKey.set(key, brick);
  }

  return { areaAliasByKey, areaByCode, brickById, customerBrickByKey, productAliasByKey, productByCode, regionAliasByKey, regionByCode, territoryAliasByKey };
}
