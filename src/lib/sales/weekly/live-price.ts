// A weekly row's sales value at TODAY's Product Master price. Product Master factory_price is the single
// source of truth, so a price edit reaches every weekly surface without a re-upload: the row's stored
// value is only what the price was on the day the sheet was imported.
//
// One rule, read by both places that price weekly rows: the dashboard (loadWeeklyDashboard, which feeds
// every weekly screen and export built from it) and the Upload screen's Combined Report, which reads the
// stored rows directly. The Combined Report used to print the stored value, so after a price edit it
// disagreed with the dashboard for every upload imported before the edit (audit, confirmed high: the
// resync that was meant to rewrite the stored values called a function that has never existed).
//
//   • Direct keeps its own sheet Value (locked invariant — never recomputed from price).
//   • A product with no current positive master price keeps its stored value (never zero a row).
//   • A DATED price wins for the month it covers (owner, 2026-10-01: weekly Saginko at 170.52 from
//     October too). Saginko is 111.15 through 2026-09 and 170.52 from 2026-10 while its master price stays
//     111.15, so "today's price" alone would value October's weekly Saginko at 111.15 beside a closing at
//     170.52. Every product with no dated price is priced exactly as before.

import type { ProductPeriodPrices } from "@/lib/sales/product-period-price";

const normalizeCode = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();

/** Normalized product code → current factory price, for every product with a positive price. */
export function livePriceMap(
  products: Iterable<{ productCode: string | null | undefined; factoryPrice: number | string | null | undefined }>,
): Map<string, number> {
  const prices = new Map<string, number>();
  for (const product of products) {
    const code = normalizeCode(product.productCode);
    if (!code) continue;
    const price = Number(product.factoryPrice);
    if (Number.isFinite(price) && price > 0) prices.set(code, price);
  }
  return prices;
}

/**
 * The month a weekly row is reported under, `YYYY-MM`: its month-cycle when the upload is tagged with
 * one, else the month its week starts in. Null when it carries neither.
 */
export function weeklyRowPeriod(cycleMonth: string | null | undefined, weekStart: string | null | undefined): string | null {
  const month = (value: string | null | undefined) => /^(\d{4}-\d{2})/.exec(String(value ?? "").trim())?.[1] ?? null;
  return month(cycleMonth) ?? month(weekStart);
}

/**
 * The unit price a weekly figure for `period` is valued at: the dated price that covers that month where
 * one does, else today's price. Null when the product has no current positive master price — the caller
 * then keeps what it had (a sale's stored value; a stock value of nothing). Every weekly money figure —
 * sales, stock, the zero-sales watchlist — reads this one rule.
 */
export function liveUnitPrice(
  productCode: string | null | undefined,
  period: string | null | undefined,
  prices: ReadonlyMap<string, number>,
  datedPrices?: Pick<ProductPeriodPrices, "priceFor">,
): number | null {
  const code = normalizeCode(productCode);
  const price = prices.get(code);
  if (price == null) return null;
  const dated = datedPrices && period ? datedPrices.priceFor(code, period) : null;
  return dated != null && dated > 0 ? dated : price;
}

/**
 * The row's value at today's price — or at the dated price that covers the row's month, where one does —
 * and the stored value where the rule above says to keep it.
 */
export function liveSalesValue(
  row: {
    distributorCode: string | null | undefined;
    productCode: string | null | undefined;
    netQty: number;
    storedValue: number;
    /** The month the row is reported under (weeklyRowPeriod). */
    period?: string | null;
  },
  prices: ReadonlyMap<string, number>,
  datedPrices?: Pick<ProductPeriodPrices, "priceFor">,
): number {
  if (normalizeCode(row.distributorCode) === "DIRECT") return row.storedValue;
  const unit = liveUnitPrice(row.productCode, row.period, prices, datedPrices);
  if (unit == null) return row.storedValue;
  return Number((row.netQty * unit).toFixed(6));
}
