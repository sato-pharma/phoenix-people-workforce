import { cache } from "react";

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
 * A value already priced in `fromPeriod`, moved to `toPeriod`'s price: scaled by the product's price
 * in `toPeriod` over its price in `fromPeriod`. A value of 0, an unknown price, or two equal prices
 * leave it EXACTLY as it was — so a row no override reaches keeps its figure to the last digit.
 *
 * For an import that values a row at one month and then files it under another (a date-less sheet
 * consolidated under the month the operator picked), and for comparing a file against a batch stored
 * under a different month.
 */
export function repriceValue(
  prices: Pick<ProductPeriodPrices, "priceFor">,
  productCode: string,
  value: number,
  fromPeriod: string | null | undefined,
  toPeriod: string | null | undefined,
): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const from = prices.priceFor(productCode, fromPeriod);
  const to = prices.priceFor(productCode, toPeriod);
  if (from == null || to == null || from <= 0 || to === from) return value;
  return (value * to) / from;
}

/** One `source_of_sales_product_price_history` row, as a caller that already read it holds it. */
export type ProductPriceOverrideRow = { productCode: string; effectivePeriod: string; factoryPrice: number };

/**
 * The same rule, built from rows a caller already holds. The import paths read the product master
 * as part of their reference set, so they resolve against THAT set — the products they can price —
 * rather than reading the master a second time.
 */
export function productPeriodPricesFromRows(
  products: readonly { productCode: unknown; factoryPrice: unknown }[],
  overrides: readonly { productCode: unknown; effectivePeriod: unknown; factoryPrice: unknown }[],
): ProductPeriodPrices {
  const base = new Map<string, number>();
  for (const product of products) {
    const productCode = code(product.productCode);
    const price = num(product.factoryPrice);
    if (productCode && price != null) base.set(productCode, price);
  }

  const byProduct = new Map<string, ProductPriceOverride[]>();
  for (const row of overrides) {
    const productCode = code(row.productCode);
    const effectivePeriod = String(row.effectivePeriod ?? "").trim();
    const price = num(row.factoryPrice);
    if (!productCode || !effectivePeriod || price == null) continue;
    const list = byProduct.get(productCode) ?? [];
    list.push({ effectivePeriod, factoryPrice: price });
    byProduct.set(productCode, list);
  }

  return buildProductPeriodPrices(base, byProduct);
}

/** One product master row, every column the per-request readers below need. */
export type ProductMasterRow = {
  product_code: unknown;
  product_name: unknown;
  family: unknown;
  factory_price: unknown;
  active: unknown;
  normalized_line: unknown;
};

/**
 * The product master, read ONCE per request. A Targets render asked `source_of_sales_products` for the
 * same ~30 rows four times — names, families, prices, and the code list the price map walks — each a
 * full round trip to the database. Throws on a failed read, exactly as each of those reads did.
 */
export const loadProductMasterRows = cache(async (): Promise<ProductMasterRow[]> => {
  const { data, error } = await getSupabaseAdmin()
    .from("source_of_sales_products")
    .select("product_code,product_name,family,factory_price,active,normalized_line");
  if (error) throw error;
  return (data ?? []) as ProductMasterRow[];
});

/**
 * Loads the product master's prices and every period override once, and resolves per call.
 *
 * Both tables are tiny — around 30 products and, today, a single override row — so this is one
 * pair of reads for a whole page rather than a lookup per row, and it is shared across the request.
 */
export const loadProductPeriodPrices = cache(async (): Promise<ProductPeriodPrices> => {
  const supabase = getSupabaseAdmin();

  const [masterRows, history] = await Promise.all([
    loadProductMasterRows(),
    supabase
      .from("source_of_sales_product_price_history")
      .select("product_code,effective_period,factory_price")
      .order("effective_period", { ascending: true }),
  ]);
  if (history.error) throw history.error;

  return productPeriodPricesFromRows(
    masterRows.map((record) => ({ productCode: record.product_code, factoryPrice: record.factory_price })),
    (history.data ?? []).map((row) => {
      const record = row as Record<string, unknown>;
      return {
        productCode: record.product_code,
        effectivePeriod: record.effective_period,
        factoryPrice: record.factory_price,
      };
    }),
  );
});

/** The `product_code -> price` map shape that the single-period callers want. */
export async function loadProductPriceMapForPeriod(
  period: string | null | undefined,
): Promise<Map<string, number>> {
  const [prices, masterRows] = await Promise.all([loadProductPeriodPrices(), loadProductMasterRows()]);
  const map = new Map<string, number>();
  for (const row of masterRows) {
    const productCode = code(row.product_code);
    if (!productCode) continue;
    const price = prices.priceFor(productCode, period);
    if (price != null) map.set(productCode, price);
  }
  return map;
}
