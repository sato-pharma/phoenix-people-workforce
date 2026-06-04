import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { Crosswalks } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Loads every translation the resolvers need: the Phoenix masters (brick→area→region, products)
// plus the learned alias tables (product / territory / area / region) that are ALREADY populated
// in the database. Keyed via the same normalize functions the resolvers use, so matching is
// consistent regardless of how the stored normalized_alias was produced.
export async function loadCrosswalks(preRefs?: Awaited<ReturnType<typeof loadSalesReferenceData>>): Promise<Crosswalks> {
  const supabase = getSupabaseAdmin();
  const [refs, prodA, terrA, areaA, regionA, custMap] = await Promise.all([
    preRefs ?? loadSalesReferenceData(),
    supabase.from("source_of_sales_product_aliases").select("alias,product_code").eq("active", true),
    supabase.from("source_of_sales_territory_aliases").select("alias,target_type,target_code").eq("active", true),
    supabase.from("source_of_sales_area_aliases").select("alias,area_code,region_code").eq("active", true),
    supabase.from("source_of_sales_region_aliases").select("alias,region_code").eq("active", true),
    // customer→brick crosswalk (added by the normalizer migration; tolerate absence pre-migration)
    supabase.from("source_of_sales_customer_map").select("distributor_code,customer_code,brick_id").eq("active", true),
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
  for (const row of (prodA.error ? [] : prodA.data ?? []) as Array<Record<string, unknown>>) {
    const key = normalizeAliasKey(row.alias); const code = normalizeCodeKey(row.product_code);
    if (key && code) productAliasByKey.set(key, code);
  }
  const territoryAliasByKey = new Map<string, { targetType: string; targetCode: string }>();
  for (const row of (terrA.error ? [] : terrA.data ?? []) as Array<Record<string, unknown>>) {
    const key = normalizeAliasKey(row.alias);
    if (key) territoryAliasByKey.set(key, { targetType: String(row.target_type ?? "brick").toLowerCase(), targetCode: String(row.target_code ?? "") });
  }
  const areaAliasByKey = new Map<string, { areaCode: string; regionCode: string }>();
  for (const row of (areaA.error ? [] : areaA.data ?? []) as Array<Record<string, unknown>>) {
    const key = normalizeAliasKey(row.alias);
    if (key) areaAliasByKey.set(key, { areaCode: String(row.area_code ?? ""), regionCode: String(row.region_code ?? "") });
  }
  const regionAliasByKey = new Map<string, string>();
  for (const row of (regionA.error ? [] : regionA.data ?? []) as Array<Record<string, unknown>>) {
    const key = normalizeAliasKey(row.alias);
    if (key) regionAliasByKey.set(key, normalizeCodeKey(row.region_code));
  }
  const customerBrickByKey = new Map<string, string>();
  for (const row of (custMap.error ? [] : custMap.data ?? []) as Array<Record<string, unknown>>) {
    const key = `${normalizeCodeKey(row.distributor_code)} ${normalizeCodeKey(row.customer_code)}`;
    const brick = normalizeCodeKey(row.brick_id);
    if (brick) customerBrickByKey.set(key, brick);
  }

  return { areaAliasByKey, areaByCode, brickById, customerBrickByKey, productAliasByKey, productByCode, regionAliasByKey, regionByCode, territoryAliasByKey };
}
