import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { normalizeAliasKey, normalizeCodeKey, numericCanonicalKey } from "@/lib/sales/normalizer/resolvers";
import type { Crosswalks } from "@/lib/sales/normalizer/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

/**
 * THE AMBIGUOUS NAME RULE: a place name that resolves to two different targets must resolve to
 * NOTHING, never to whichever row happened to be read last.
 *
 * Egypt reuses place names across governorates — الصالحية is in both Sharkia and Qena, الرحمانية in
 * both Behira and Kafr El-Sheikh, ابراهيميه in both Alexandria and Sharkia, مصطفى كامل is a street
 * in Alexandria and a square downtown. Those are real, distinct bricks and are deliberately kept
 * separate.
 *
 * The alias table's unique index is on (normalized_alias, target_type, target_code), so it happily
 * holds ONE name pointing at TWO bricks. A plain `.set()` then silently keeps whichever row the
 * database returned last, and every sale carrying that name lands in the wrong area — credited to
 * the wrong rep, in the wrong district manager's numbers, with nothing to show it happened.
 *
 * Dropping the key instead sends the row to review, which is the standing rule: an ambiguous
 * territory label is never auto-resolved. Same shape as the customer-map collision handling in
 * loadCrosswalks, and as `detectDistributor`'s tie -> `best: null`.
 */
export function buildAliasIndex<T>(
  rows: Array<Record<string, unknown>>,
  valueOf: (row: Record<string, unknown>) => T,
  identityOf: (value: T) => string,
): { conflicts: Set<string>; index: Map<string, T> } {
  const index = new Map<string, T>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    const key = normalizeAliasKey(row.alias);
    if (!key || conflicts.has(key)) continue;
    const value = valueOf(row);
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, value);
    } else if (identityOf(existing) !== identityOf(value)) {
      // Two different targets for one name: neither wins.
      index.delete(key);
      conflicts.add(key);
    }
  }
  return { conflicts, index };
}

// Read EVERY active row of an alias / crosswalk table, paging past PostgREST's 1000-row default cap.
// Without this, large tables (territory aliases + customer_map have thousands of rows) silently
// truncate to the first 1000, so freshly-saved mappings would never load and the rows they fix would
// re-appear as "needs mapping" on re-analyze. Tolerant of a missing table (returns what it gathered)
// so pre-migration setups still work.
//
// KEYSET, NOT OFFSET. This paged with `.range(from, from+999)` and NO `.order()`. Postgres gives no
// stable row order without ORDER BY, so consecutive pages could return the same row twice and skip
// others entirely — at random, differently on every run. The June 2026 import lost 1,262 of 49,713
// customer→brick mappings that way (2.5%), scattered evenly across the id range, every one of them
// active with a valid brick. The sales landed unmapped and the cause looked like missing data.
//
// Two separate faults, both fixed by keyset:
//   1. no ORDER BY  -> arbitrary page boundaries, silent row loss;
//   2. OFFSET even when ordered -> the import WRITES to source_of_sales_customer_map while this
//      reads it, and every insert below the cursor shifts later rows across a page boundary.
// Ordering by the table's bigint primary key and seeking past the last id read is immune to both.
async function selectAllActive(supabase: SupabaseAdmin, table: string, columns: string, fallbackColumns?: string): Promise<Array<Record<string, unknown>>> {
  const pageSize = 1000;
  const rows: Array<Record<string, unknown>> = [];
  // `id` is needed as the cursor; every table read here has a bigint identity PK.
  const select = columns.split(",").map((c) => c.trim()).includes("id") ? columns : `id,${columns}`;
  let cursor: number | null = null;
  for (;;) {
    let query = supabase.from(table).select(select).eq("active", true)
      .order("id", { ascending: true }).limit(pageSize);
    if (cursor !== null) query = query.gt("id", cursor);
    const result = await query;
    if (result.error) {
      // A first-page error with a provided fallback means an OPTIONAL column is absent (one that only
      // lands with a later migration). Retry the whole read with the reduced column set instead of
      // returning nothing: this helper swallows errors, so a single missing column would otherwise
      // drop EVERY row of a critical crosswalk silently.
      if (cursor === null && rows.length === 0 && fallbackColumns && fallbackColumns !== columns) {
        return selectAllActive(supabase, table, fallbackColumns);
      }
      break; // tolerate (e.g. table absent); return rows gathered so far
    }
    const page = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
    if (page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    const last = Number(page[page.length - 1]?.id);
    if (!Number.isFinite(last)) break; // no usable cursor — stop rather than loop forever
    cursor = last;
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
    // customer→brick crosswalk (added by the normalizer migration; tolerate absence pre-migration).
    // confidence lands with the phase-4 migration — fall back to the base columns if it is absent.
    selectAllActive(supabase, "source_of_sales_customer_map", "distributor_code,customer_code,brick_id,confidence", "distributor_code,customer_code,brick_id"),
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

  // Master product-NAME index (collision-safe): normalized product name -> Phoenix code. Name-first
  // resolution checks this BEFORE any code lookup. If two products share a normalized name the entry
  // is DROPPED so a name can never mis-map to the wrong product.
  const productByName = new Map<string, string>();
  const productNameConflict = new Set<string>();
  for (const p of refs.products) {
    const key = normalizeAliasKey(p.productName);
    const code = normalizeCodeKey(p.productCode);
    if (!key || !code || productNameConflict.has(key)) continue;
    const existing = productByName.get(key);
    if (existing === undefined) productByName.set(key, code);
    else if (existing !== code) { productByName.delete(key); productNameConflict.add(key); }
  }

  // Per-distributor: key by `${distributor} ${normalized alias}` so each distributor's raw codes/names
  // resolve only for that distributor (resolveProduct builds the same composite key).
  const productAliasByKey = new Map<string, string>();
  for (const row of prodA) {
    const dist = normalizeCodeKey(row.distributor_code);
    const key = normalizeAliasKey(row.alias); const code = normalizeCodeKey(row.product_code);
    if (dist && key && code) productAliasByKey.set(`${dist} ${key}`, code);
  }
  const territory = buildAliasIndex(
    terrA,
    (row) => ({ targetType: String(row.target_type ?? "brick").toLowerCase(), targetCode: String(row.target_code ?? "") }),
    (v) => `${v.targetType} ${v.targetCode}`,
  );
  const territoryAliasByKey = territory.index;

  const area = buildAliasIndex(
    areaA,
    (row) => ({ areaCode: String(row.area_code ?? ""), regionCode: String(row.region_code ?? "") }),
    (v) => `${v.areaCode} ${v.regionCode}`,
  );
  const areaAliasByKey = area.index;

  const region = buildAliasIndex(regionA, (row) => normalizeCodeKey(row.region_code), (v) => v);
  const regionAliasByKey = region.index;

  const ambiguousAliasKeys = new Set<string>([...territory.conflicts, ...area.conflicts, ...region.conflicts]);
  const customerBrickByKey = new Map<string, string>();
  // Numeric-canonical customer index (collision-safe): tolerates leading-zero / number-vs-text drift.
  const customerBrickByCanonicalKey = new Map<string, string>();
  const customerCanonConflict = new Set<string>();
  // Owner-verified (confidence=100) customer keys. An explicit owner ruling is absolute: resolveBrick
  // lets these outrank an area-only sheet signal even ACROSS areas, whereas every other mapping keeps
  // the same-area guard (#1458). confidence 100 is a deliberate sentinel — algorithmic scores top out
  // at 95 — so this stays a tiny, owner-curated set. Indexed under both the exact and canonical keys.
  const ownerVerifiedCustomerKeys = new Set<string>();
  for (const row of custMap) {
    const dist = normalizeCodeKey(row.distributor_code);
    const brick = normalizeCodeKey(row.brick_id);
    if (!brick) continue;
    const ownerVerified = Number(row.confidence) === 100;
    const exactKey = `${dist} ${normalizeCodeKey(row.customer_code)}`;
    customerBrickByKey.set(exactKey, brick);
    if (ownerVerified) ownerVerifiedCustomerKeys.add(exactKey);
    const canon = numericCanonicalKey(row.customer_code);
    if (!canon) continue;
    const ckey = `${dist} ${canon}`;
    if (ownerVerified) ownerVerifiedCustomerKeys.add(ckey);
    if (customerCanonConflict.has(ckey)) continue;
    const existing = customerBrickByCanonicalKey.get(ckey);
    if (existing === undefined) customerBrickByCanonicalKey.set(ckey, brick);
    else if (existing !== brick) { customerBrickByCanonicalKey.delete(ckey); customerCanonConflict.add(ckey); }
  }

  return { ambiguousAliasKeys, areaAliasByKey, areaByCode, brickById, customerBrickByKey, customerBrickByCanonicalKey, ownerVerifiedCustomerKeys, productAliasByKey, productByCode, productByName, productByCanonicalCode, regionAliasByKey, regionByCode, territoryAliasByKey };
}
