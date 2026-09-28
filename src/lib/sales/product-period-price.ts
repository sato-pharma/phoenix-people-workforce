import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The factory price that values a product IN A GIVEN PERIOD.
 *
 * The database half of this lives in `public.phx_factory_price(product_code, period)`, which every
 * sales-value function now calls. This is the same rule for the TypeScript side — the targets grid,
 * the targets template and the dashboards that show a unit price next to a month.
 *
 * ── Why a period at all ──────────────────────────────────────────────────────────────────────
 * Until 2026-09-28 a product had exactly one price and it valued every month, which is the owner's
 * 2026-08-14 policy and is still what happens for every product with no override row. Saginko is
 * the first exception: the owner repriced it on 2026-09-28 and scoped the retail half to
 * "1 October", so `SA001` is valued at 111.15 through 2026-09 and 170.52 from 2026-10.
 *
 * ── Why the target side matters as much as the sales side ────────────────────────────────────
 * `au.monthly_targets.target_value` is STORED, not recomputed, and achievement is
 * `actual_value / target_value`. So a target authored at the old price against sales valued at the
 * new one would inflate achievement by the ratio of the two — 53% in Saginko's case — on a number
 * the incentive scheme reads. A target for October must be valued at October's price, which is what
 * makes this module part of the change rather than a nicety.
 */
export type ProductPeriodPrices = {
  /** The price that values `productCode` in `period`. A blank period falls back to the master price. */
  priceFor: (productCode: string, period: string | null | undefined) => number | null;
  /** The product master's current price, for the places that genuinely mean "today's price". */
  currentPrice: (productCode: string) => number | null;
};

export type ProductPriceOverride = { effectivePeriod: string; factoryPrice: number };

/**
 * The resolution rule itself, with the two tables already in hand.
 *
 * Split out from the loader so a registered test can pin it without a database — the rule is the
 * part that must not drift from `public.phx_factory_price()`, and a rule that can only be checked
 * against production is a rule nothing checks.
 */
export function buildProductPeriodPrices(
  base: Map<string, number>,
  overrides: Map<string, ProductPriceOverride[]>,
): ProductPeriodPrices {
  const currentPrice = (productCode: string): number | null => base.get(code(productCode)) ?? null;

  const priceFor = (productCode: string, period: string | null | undefined): number | null => {
    const key = code(productCode);
    const at = String(period ?? "").trim();
    // No period in hand means no period-scoped answer is possible; the master price is the same
    // answer the database resolver gives for a null period, so the two halves agree.
    if (!at) return currentPrice(key);
    const list = overrides.get(key);
    if (!list || list.length === 0) return currentPrice(key);
    let resolved: number | null = null;
    for (const entry of [...list].sort((a, b) => a.effectivePeriod.localeCompare(b.effectivePeriod))) {
      // 'YYYY-MM' compares correctly as a string, which is how the SQL resolver compares it too.
      if (entry.effectivePeriod <= at) resolved = entry.factoryPrice;
      else break;
    }
    return resolved ?? currentPrice(key);
  };

  return { priceFor, currentPrice };
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function code(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Loads the product master's prices and every period override once, and resolves per call.
 *
 * Both tables are tiny — around 30 products and, today, a single override row — so this is one
 * pair of reads for a whole page rather than a lookup per row.
 */
export async function loadProductPeriodPrices(): Promise<ProductPeriodPrices> {
  const supabase = getSupabaseAdmin();

  const [master, history] = await Promise.all([
    supabase.from("source_of_sales_products").select("product_code,factory_price"),
    supabase
      .from("source_of_sales_product_price_history")
      .select("product_code,effective_period,factory_price")
      .order("effective_period", { ascending: true }),
  ]);
  if (master.error) throw master.error;
  if (history.error) throw history.error;

  const base = new Map<string, number>();
  for (const row of master.data ?? []) {
    const record = row as Record<string, unknown>;
    const productCode = code(record.product_code);
    const price = num(record.factory_price);
    if (productCode && price != null) base.set(productCode, price);
  }

  const overrides = new Map<string, ProductPriceOverride[]>();
  for (const row of history.data ?? []) {
    const record = row as Record<string, unknown>;
    const productCode = code(record.product_code);
    const effectivePeriod = String(record.effective_period ?? "").trim();
    const price = num(record.factory_price);
    if (!productCode || !effectivePeriod || price == null) continue;
    const list = overrides.get(productCode) ?? [];
    list.push({ effectivePeriod, factoryPrice: price });
    overrides.set(productCode, list);
  }

  return buildProductPeriodPrices(base, overrides);
}

/** The `product_code -> price` map shape that the single-period callers want. */
export async function loadProductPriceMapForPeriod(
  period: string | null | undefined,
): Promise<Map<string, number>> {
  const prices = await loadProductPeriodPrices();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("source_of_sales_products").select("product_code");
  if (error) throw error;
  const map = new Map<string, number>();
  for (const row of data ?? []) {
    const productCode = code((row as Record<string, unknown>).product_code);
    if (!productCode) continue;
    const price = prices.priceFor(productCode, period);
    if (price != null) map.set(productCode, price);
  }
  return map;
}
