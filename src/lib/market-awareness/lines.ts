import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

/**
 * One line, four spellings — and every one of them is a real join key somewhere.
 *
 *   public.lines.name                           "Anti Infective"  "Pedia"  "CNS"  "Head Office"
 *   au.lines.line_code                          "anti_infective"  "pedia"  "cns"
 *   source_of_sales_fact_rollup.official_line   "Anti Infective"  "Pedia"  "CNS"  "Head Office"
 *   au.sos_official_line_map.official_line      the above PLUS "Anti Inf"
 *
 * Measured on production 2026-09-06. A module that stores a line as free text picks one spelling and
 * silently fails to join the others — the sales query returns nothing, and a zero here reads as
 * "this area had no sales" rather than as a missed join.
 *
 * So: the activity stores `lines.id`, and NOTHING is derived in TypeScript. `phx_market_awareness_lines`
 * returns the canonical triple from `au.lines`, and the tracking function resolves the spellings
 * through `au.sos_official_line_map` inside Postgres. An earlier draft of this file derived
 * `line_code` by lower-casing and underscoring the name; it produced the right answer for all three
 * current lines and would have been wrong the moment a fourth arrived, in the direction nobody
 * notices.
 *
 * `au` is NOT reachable from the client — PostgREST exposes only `public`, `graphql_public` and
 * `analytics`, and `.schema("au")` answers PGRST106 — hence the RPC.
 */

export type MarketAwarenessLine = {
  id: number;
  /** `au.lines.line_code` — what the geography and tracking functions take. */
  lineCode: string;
  /** `au.lines.line_name` — what a human reads, and what `public.lines.name` holds. */
  name: string;
};

type LineRow = {
  line_id: number | string;
  line_code: string;
  line_name: string;
};

/**
 * The tracked lines, newest read each call. Head Office is absent by construction: `au.lines` holds
 * only closing lines, so it never has to be filtered out by name here.
 */
export async function loadMarketAwarenessLines(): Promise<MarketAwarenessLine[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_market_awareness_lines");
  if (error) throw toQueryError(error);

  const rows = (data as LineRow[] | null) ?? [];
  return rows.map((row) => ({
    id: Number(row.line_id),
    lineCode: String(row.line_code).trim(),
    name: String(row.line_name).trim(),
  }));
}

export function findLineById(
  lines: MarketAwarenessLine[],
  lineId: number | null | undefined,
): MarketAwarenessLine | null {
  if (lineId == null) return null;
  return lines.find((line) => line.id === Number(lineId)) ?? null;
}

/**
 * Head Office is absent from monthly closing tracking by golden rule — neither weekly nor monthly —
 * and it is roughly 90% of weekly VALUE, so it is never a gap to fill. `IGNORE` is a
 * `source_of_sales_products.line` bucket rather than a line at all. A product on either could only
 * render a permanent zero on the Tracking tab, which reads as a broken report, so the picker refuses
 * them (owner answer 29: "donot show head office products in the products droplist").
 */
const UNTRACKABLE_PRODUCT_LINES = new Set(["head office", "ignore"]);

export function isTrackableProductLine(productLine: string | null | undefined): boolean {
  const normalized = (productLine ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return !UNTRACKABLE_PRODUCT_LINES.has(normalized);
}
