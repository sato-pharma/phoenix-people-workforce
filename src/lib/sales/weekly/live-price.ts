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

/** The row's value at today's price; the stored value where the rule above says to keep it. */
export function liveSalesValue(
  row: { distributorCode: string | null | undefined; productCode: string | null | undefined; netQty: number; storedValue: number },
  prices: ReadonlyMap<string, number>,
): number {
  if (normalizeCode(row.distributorCode) === "DIRECT") return row.storedValue;
  const price = prices.get(normalizeCode(row.productCode));
  if (price == null) return row.storedValue;
  return Number((row.netQty * price).toFixed(6));
}
