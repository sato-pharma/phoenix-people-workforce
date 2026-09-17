/**
 * Phoenix CRM — the products a rep can mark as discussed on a visit.
 *
 * Owner, 2026-09-16: each visit records the products discussed, "from the line's products". A rep
 * discusses a brand, not a pack size, so the choices are the product FAMILIES of the territory's line
 * (source_of_sales_products, active rows whose line is the seat's line name). The confidential codes
 * are never offered. No price is read.
 */

import { unstable_cache } from "next/cache";

import { normalizeLineKey, RESTRICTED_PRODUCT_CODES } from "@/lib/sales/confidential-products";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const RESTRICTED = new Set<string>(RESTRICTED_PRODUCT_CODES);

/** Family names by normalized line key, each list sorted by name. Plain objects: the cache serializes. */
const loadFamiliesByLine = unstable_cache(
  async (): Promise<Record<string, string[]>> => {
    // Paged on the product code, so the list never stops at the database's per-answer row cap.
    const rows = await fetchAllRowsKeyset<Record<string, unknown>>(
      () => getSupabaseAdmin().from("source_of_sales_products").select("product_code, family, line").eq("active", true),
      { cursorColumn: "product_code", cursorOf: (row) => (typeof row.product_code === "string" ? row.product_code : null) },
    );
    const byLine = new Map<string, Set<string>>();
    for (const row of rows) {
      const code = typeof row.product_code === "string" ? row.product_code.trim().toUpperCase() : "";
      const family = typeof row.family === "string" ? row.family.trim() : "";
      const line = normalizeLineKey(typeof row.line === "string" ? row.line : null);
      if (!code || !family || !line || RESTRICTED.has(code)) continue;
      const families = byLine.get(line) ?? new Set<string>();
      families.add(family);
      byLine.set(line, families);
    }
    return Object.fromEntries([...byLine].map(([line, families]) => [line, [...families].sort((left, right) => left.localeCompare(right))]));
  },
  ["phoenix-crm-line-families"],
  { revalidate: 600, tags: ["sos-reference"] },
);

/** The families a territory's rep can mark as discussed. Empty when the line has none on file. */
export async function lineProductFamilies(lineName: string | null): Promise<string[]> {
  const key = normalizeLineKey(lineName);
  if (!key) return [];
  const byLine = await loadFamiliesByLine();
  return byLine[key] ?? [];
}
