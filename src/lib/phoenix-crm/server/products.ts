/**
 * Phoenix CRM — the products a rep can mark as discussed on a visit, and the pharmacy-stock check.
 *
 * Owner, 2026-09-16: each visit records the products discussed, "from the line's products". A rep
 * discusses a brand, not a pack size, so the DISCUSSED choices are the product FAMILIES of the
 * territory's line (source_of_sales_products, active rows whose line is the seat's line name). The
 * confidential codes are never offered. No price is read.
 *
 * Owner, 2026-09-24: the pharmacy-stock check ("does this pharmacy have these products?") is finer —
 * a pharmacy can carry one concentration of a family and not another, so it is answered per PRODUCT,
 * the products grouped under their family. `lineProductsByFamily` returns that grouping; the discussed
 * families are just its family names, so both read one cached query.
 */

import { unstable_cache } from "next/cache";

import { normalizeLineKey, RESTRICTED_PRODUCT_CODES } from "@/lib/sales/confidential-products";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const RESTRICTED = new Set<string>(RESTRICTED_PRODUCT_CODES);

/** A product family and the individual products (concentrations) within it, both sorted by name. */
export type LineProductFamily = { family: string; products: string[] };

/**
 * Group active product rows into families by normalized line key: confidential codes are dropped, a
 * product with no name falls back to its family name (so a single-product family still answers once),
 * duplicates collapse, and both families and their products come out sorted by name. Pure, so the
 * grouping is tested without a database.
 */
export function groupLineProducts(rows: readonly Record<string, unknown>[]): Record<string, LineProductFamily[]> {
  const byLine = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    const code = typeof row.product_code === "string" ? row.product_code.trim().toUpperCase() : "";
    const family = typeof row.family === "string" ? row.family.trim() : "";
    const name = typeof row.product_name === "string" ? row.product_name.trim() : "";
    const line = normalizeLineKey(typeof row.line === "string" ? row.line : null);
    if (!code || !family || !line || RESTRICTED.has(code)) continue;
    const families = byLine.get(line) ?? new Map<string, Set<string>>();
    const products = families.get(family) ?? new Set<string>();
    // A family with a single unnamed product falls back to the family name, so it still answers once.
    products.add(name || family);
    families.set(family, products);
    byLine.set(line, families);
  }
  return Object.fromEntries(
    [...byLine].map(([line, families]) => [
      line,
      [...families]
        .map(([family, products]) => ({ family, products: [...products].sort((left, right) => left.localeCompare(right)) }))
        .sort((left, right) => left.family.localeCompare(right.family)),
    ]),
  );
}

/** Products grouped by family, by normalized line key. Plain objects/arrays: the cache serializes. */
const loadProductsByLine = unstable_cache(
  async (): Promise<Record<string, LineProductFamily[]>> => {
    // Paged on the product code, so the list never stops at the database's per-answer row cap.
    const rows = await fetchAllRowsKeyset<Record<string, unknown>>(
      () => getSupabaseAdmin().from("source_of_sales_products").select("product_code, product_name, family, line").eq("active", true),
      { cursorColumn: "product_code", cursorOf: (row) => (typeof row.product_code === "string" ? row.product_code : null) },
    );
    return groupLineProducts(rows);
  },
  ["phoenix-crm-line-products"],
  { revalidate: 600, tags: ["sos-reference"] },
);

/** A line's products grouped by family, for the pharmacy-stock check. Empty when the line has none. */
export async function lineProductsByFamily(lineName: string | null): Promise<LineProductFamily[]> {
  const key = normalizeLineKey(lineName);
  if (!key) return [];
  const byLine = await loadProductsByLine();
  return byLine[key] ?? [];
}

/** The families a territory's rep can mark as discussed. Empty when the line has none on file. */
export async function lineProductFamilies(lineName: string | null): Promise<string[]> {
  return (await lineProductsByFamily(lineName)).map((entry) => entry.family);
}
