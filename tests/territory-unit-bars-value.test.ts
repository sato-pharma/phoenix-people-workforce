import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// The Territory drilldown's per-pharmacy monthly trend bar must plot VALUE, never a units
// total. A units total is only meaningful for one product_code — summing the units of two
// different products (Saginko + Royafloxacin) into one bar height is the owner's forbidden
// "add units of different products" (units-of-different-products-are-never-added). Value is
// additive across products and is the only correct basis for the bar.
//
// Until this fix the bar plotted month.units, built in pharmacies.ts as sum(units) across every
// product a pharmacy bought that month. This pins the three source points so a later edit that
// repoints the bar back to a summed-units field goes red. The per-product tooltip keeps showing
// units, because each tooltip line is a SINGLE product and its units are valid.

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments (incl. JSDoc)
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

function readCode(rel: string): string {
  return stripComments(readFileSync(path.join(process.cwd(), rel), "utf8"));
}

export function runTerritoryUnitBarsValueTests() {
  // 1) The bar chart plots value, not a summed-units total.
  const sparkline = readCode("src/components/sales/territory/pharmacy-trend-sparkline.tsx");
  assert.ok(
    /dataKey="value"/.test(sparkline),
    "the monthly trend Bar must plot value (dataKey=\"value\") — the additive, per-product-safe basis",
  );
  assert.ok(
    !/dataKey="units"/.test(sparkline),
    "the monthly trend Bar must NOT plot units — summing units of different products is forbidden",
  );

  // 2) The month accumulator sums value, never a units total.
  const pharmacies = readCode("src/lib/sales/territory/pharmacies.ts");
  assert.ok(
    /monthEntry\.value\s*\+=/.test(pharmacies),
    "a month's trend figure must accumulate value (monthEntry.value += value)",
  );
  assert.ok(
    !/monthEntry\.units\s*\+=/.test(pharmacies),
    "a month must NOT accumulate a units total across products (monthEntry.units += ...) — the removed bug",
  );

  // 3) The month-presence type carries value, not a bare summed-units field.
  const types = readCode("src/lib/sales/territory/types.ts");
  const monthType = types.match(/export type TerritoryMonthPresence = \{[\s\S]*?\};/);
  assert.ok(monthType, "TerritoryMonthPresence type must exist");
  assert.ok(
    /\bvalue:\s*number/.test(monthType![0]),
    "TerritoryMonthPresence must declare value: number (the bar's basis)",
  );
  assert.ok(
    !/\bunits:\s*number/.test(monthType![0]),
    "TerritoryMonthPresence must NOT declare a bare units: number — a summed-across-products total has no valid meaning",
  );
}
