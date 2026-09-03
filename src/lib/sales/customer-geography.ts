import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The PLACE half of the system spine: what territory a distributor's customer code sits in.
 *
 * `source_of_sales_customer_map` is the authority — 66,563 rows on production, every one of them
 * carrying a brick, an area and a region. Source of Sales, the monthly closing, direct orders and
 * marketing all ultimately ask it the same question, and until now each asked it in its own way:
 * the only resolver that existed was `resolveCustomerCodeGeography`, private inside
 * src/lib/direct-orders/service.ts, so no other domain could reach it.
 *
 * The PERSON half of the spine is `src/lib/hr-id.ts` and needs nothing added — `canonicalHrIdKey`
 * for comparing, `hrIdForStorage` for writing. Do not build a second one here.
 *
 * Three things this gets right that a hand-rolled lookup does not:
 *
 *  1. EXACT PAIRS. PostgREST's two `.in()` filters are INDEPENDENT: `.in(distributor, [PS, IBN])`
 *     with `.in(customer, [111, 222])` also matches PS/222 and IBN/111, pairs nobody asked about.
 *     Measured on production 2026-09-03: 54 pairs asked, 45 rows wanted, 53 rows returned. The
 *     over-match grows as distributors x codes while the wanted set grows linearly.
 *  2. NO SILENT TRUNCATION. PostgREST caps every response at 1000 rows with no marker, so once
 *     that over-match crosses the cap a real pair is dropped and its geography reads null — which
 *     looks like "this customer has no territory", not like a query that got cut off. Paged with
 *     the keyset pager because the customer map is read while imports write to it (see
 *     src/lib/supabase/paginated.ts, which records losing 1,262 of 49,713 rows to an offset walk).
 *  3. CHUNKED. An `.in()` carrying several hundred values returns ZERO rows and no error.
 *
 * Deliberately NOT filtered to `active` rows. Every row is active today (66,563 of 66,563), so a
 * filter would be invisible now and would silently turn a deactivated mapping into "no territory"
 * later. The existing direct-orders resolver did not filter either; changing that belongs in a
 * change about deactivation, not in this one.
 */

export type CustomerGeography = {
  areaCode: string | null;
  brickId: string | null;
  regionCode: string | null;
};

export type CustomerCodePair = {
  customerCode: string;
  distributorCode: string;
};

/**
 * How many pairs are resolved per round trip. Each chunk sends at most this many distributor codes
 * and this many customer codes, so the worst-case over-match per request is bounded.
 */
export const CUSTOMER_GEOGRAPHY_CHUNK_SIZE = 50;

/** The key both sides of a lookup must agree on. Trimmed, because the map's codes are stored trimmed. */
export function customerGeographyKey(
  distributorCode: string | null | undefined,
  customerCode: string | null | undefined,
): string {
  return `${String(distributorCode ?? "").trim()}::${String(customerCode ?? "").trim()}`;
}

function normalizePairs(pairs: Iterable<CustomerCodePair>): CustomerCodePair[] {
  const seen = new Set<string>();
  const normalized: CustomerCodePair[] = [];
  for (const pair of pairs) {
    const distributorCode = String(pair?.distributorCode ?? "").trim();
    const customerCode = String(pair?.customerCode ?? "").trim();
    if (!distributorCode || !customerCode) continue;
    const key = customerGeographyKey(distributorCode, customerCode);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ customerCode, distributorCode });
  }
  return normalized;
}

/**
 * Keep only rows whose (distributor, customer) pair was actually asked for.
 *
 * Pure and exported so the over-match can be tested without a database — getting this wrong is
 * silent, and the same trap already has a named guard for the ownership query in direct-orders
 * (`selectExactCodePairOwners`). A phantom pair here would attach one customer's territory to a
 * different customer's code.
 */
export function selectExactPairGeography(
  pairs: readonly CustomerCodePair[],
  rows: readonly Record<string, unknown>[],
): Map<string, CustomerGeography> {
  const wanted = new Set(pairs.map((pair) => customerGeographyKey(pair.distributorCode, pair.customerCode)));
  const resolved = new Map<string, CustomerGeography>();
  for (const row of rows) {
    const key = customerGeographyKey(
      row.distributor_code as string | null,
      row.customer_code as string | null,
    );
    if (!wanted.has(key) || resolved.has(key)) continue;
    resolved.set(key, {
      areaCode: row.area_code ? String(row.area_code) : null,
      brickId: row.brick_id ? String(row.brick_id) : null,
      regionCode: row.region_code ? String(row.region_code) : null,
    });
  }
  return resolved;
}

/**
 * Resolve (distributor code, customer code) pairs to their territory.
 *
 * Returns a map keyed by `customerGeographyKey`. A pair the customer map does not know is simply
 * ABSENT — never a row of nulls, so a caller can tell "unmapped" from "mapped to nothing".
 */
export async function resolveCustomerGeography(
  pairs: Iterable<CustomerCodePair>,
): Promise<Map<string, CustomerGeography>> {
  const normalized = normalizePairs(pairs);
  const resolved = new Map<string, CustomerGeography>();
  if (normalized.length === 0) return resolved;

  const supabase = getSupabaseAdmin();
  for (let index = 0; index < normalized.length; index += CUSTOMER_GEOGRAPHY_CHUNK_SIZE) {
    const chunk = normalized.slice(index, index + CUSTOMER_GEOGRAPHY_CHUNK_SIZE);
    const distributorCodes = Array.from(new Set(chunk.map((pair) => pair.distributorCode)));
    const customerCodes = Array.from(new Set(chunk.map((pair) => pair.customerCode)));

    const rows = await fetchAllRowsKeyset<Record<string, unknown>>(
      () =>
        supabase
          .from("source_of_sales_customer_map")
          .select("id, distributor_code, customer_code, brick_id, area_code, region_code")
          .in("distributor_code", distributorCodes)
          .in("customer_code", customerCodes),
      { cursorColumn: "id", cursorOf: (row) => row.id as number | string | null },
    );

    for (const [key, geography] of selectExactPairGeography(chunk, rows)) {
      if (!resolved.has(key)) resolved.set(key, geography);
    }
  }

  return resolved;
}
