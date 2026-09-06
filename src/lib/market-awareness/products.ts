import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

/**
 * The products an awareness activity may target.
 *
 * Head Office products and the `IGNORE` bucket can never appear: `phx_market_awareness_products`
 * joins through `au.lines` on `is_closing_line`, so they are excluded by construction rather than by
 * a name list that would have to be kept in step. A Head Office product would render a permanent
 * zero on the Tracking tab — Head Office is absent from monthly closing tracking by golden rule —
 * and a permanent zero reads as a broken report rather than as a rule.
 */

export type MarketAwarenessProductOption = {
  productCode: string;
  productName: string;
  lineName: string;
  /** The price the closing revalues at. Shown so a PM can sanity-check an expected uplift. */
  factoryPrice: number | null;
};

export async function loadActivityProducts(
  lineCode: string,
): Promise<MarketAwarenessProductOption[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_market_awareness_products", {
    p_line_code: lineCode,
  });
  if (error) throw toQueryError(error);

  return ((data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
    productCode: String(row.product_code ?? "").trim(),
    productName: String(row.product_name ?? row.product_code ?? "").trim(),
    lineName: String(row.line_name ?? "").trim(),
    factoryPrice: row.factory_price === null || row.factory_price === undefined
      ? null
      : Number(row.factory_price),
  }));
}
