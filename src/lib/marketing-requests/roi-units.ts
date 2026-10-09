// ─────────────────────────────────────────────────────────────────────────────
// Units on an ROI surface — only ever for ONE product.
//
// 🔒 Owner golden rule: units of different products or concentrations are NEVER added. A unit total
// is valid for one product code only; above that, aggregate by VALUE.
//
// The attribution engine's `actual_units` is the sum of qty over EVERY product a request promotes,
// and each product carries its own forecast quantity, so "321 of 2,600 units" on a request promoting
// Tebofortine 40 mg, 80 mg, 120 mg and 240 mg added four concentrations together — a figure, and a
// percentage, that mean nothing. Measured on production 2026-10-09: 26 of the 52 Phoenix requests
// promote more than one product, 11 of them on the live tracker.
//
// Every ROI surface asks this function instead of summing `forecastQty` itself, so the rule lives
// in one place.
// ─────────────────────────────────────────────────────────────────────────────

export type RoiUnitFigures = {
  forecastUnits: number;
  actualUnits: number;
};

/**
 * The request's forecast and attributed units — or `null` when it promotes anything other than
 * exactly one product code, in which case the surface shows value only.
 */
export function singleProductUnits(row: {
  products: ReadonlyArray<{ productCode: string; forecastQty: number }>;
  actualSalesUnits: number;
}): RoiUnitFigures | null {
  const codes = new Set(row.products.map((product) => product.productCode.trim().toUpperCase()).filter(Boolean));
  if (codes.size !== 1) return null;
  return {
    actualUnits: row.actualSalesUnits,
    forecastUnits: row.products.reduce((sum, product) => sum + product.forecastQty, 0),
  };
}
