import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveClosingDetailFactoryPrice,
  resolveClosingDetailSalesValue,
} from "../src/lib/sales/monthly-closing-details.ts";
import { buildProductPeriodPrices } from "../src/lib/sales/product-period-price.ts";

// THE CLOSING DETAILS VALUE A ROW AT THE CLOSING MONTH'S PRICE — found by a sales-rules review on
// 2026-10-01, verified on production the same day.
//
// Saginko (SA001) is valued at 111.15 through 2026-09 and 170.52 from 2026-10 (owner, 2026-09-28),
// and the product master's own price STAYS 111.15 — typing 170.52 into it would restate every
// published month. The 31 database functions were repointed at `public.phx_factory_price(code,
// period)`, and tests/product-period-price.test.ts pins that half. The TypeScript half of the
// closing was missed: `loadMonthlyClosingDetails` valued every distributor row at
// `effectiveUnits x product.factoryPrice`, the MASTER price off loadSalesReferenceData.
//
// Nothing was wrong yet — production held no October file on 2026-10-01 — but the first one would
// have put two prices on one month. Measured at August 2026's Anti Infective volume, 2,983 units:
//
//   Closing Matrix (phx_factory_price, October)          508,661.16
//   Details tab / Data sheet / Total SUMIFS (master)     331,560.45   <- 177,100.71 short
//   live store split, 327 relocated units                19,413.99 of money landing in the wrong areas
//
// The attribution net those rows also feed stores UNITS only (au.monthly_store_split_net has no money
// column), so no persisted figure was ever at risk — the defect was every screen and workbook that
// shows the closing's money from these rows.
//
// July, August and September cannot move: the only override starts 2026-10, and on production every
// line of every month from January to August re-priced to a delta of exactly 0.00.

const SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/monthly-closing-details.ts", import.meta.url)),
  "utf8",
);

/** Comments name the old read on purpose (the history is the explanation); only code counts. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** The loader's own body: from its signature to the first closing brace at column 0. */
function loaderBody(source: string): string {
  const start = source.indexOf("export async function loadMonthlyClosingDetails(");
  assert.ok(start >= 0, "control: the details loader is still where this test reads it");
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "control: the details loader's body has an end");
  return stripComments(source.slice(start, end));
}

/** The pre-fix valuation: the product master's flat price, whatever the month. */
const MASTER_PRICE_READ = /\bproduct\?\.factoryPrice\b/;

export function runClosingDetailsPeriodPriceTests() {
  const prices = buildProductPeriodPrices(
    new Map([
      ["SA001", 111.15], // Saginko — the product master's price, which stays 111.15
      ["RO001", 60.7], // Royafloxacin — no override, valued exactly as always
    ]),
    new Map([["SA001", [{ effectivePeriod: "2026-10", factoryPrice: 170.52 }]]]),
  );

  // ── 1. The price a closing month values a row at ────────────────────────────
  assert.equal(
    resolveClosingDetailFactoryPrice(prices, "SA001", "2026-10"),
    170.52,
    "an October Saginko row is valued at 170.52 — the price phx_factory_price gives the Closing Matrix, "
      + "never the product master's 111.15",
  );
  assert.equal(resolveClosingDetailFactoryPrice(prices, "SA001", "2026-11"), 170.52, "and every month after October");
  for (const published of ["2026-07", "2026-08", "2026-09"]) {
    assert.equal(
      resolveClosingDetailFactoryPrice(prices, "SA001", published),
      111.15,
      `${published} keeps 111.15 — a published and announced month is never corrected`,
    );
  }
  for (const period of ["2026-01", "2026-09", "2026-10", "2027-06"]) {
    assert.equal(resolveClosingDetailFactoryPrice(prices, "RO001", period), 60.7, `RO001 has no override, so ${period} is untouched`);
  }
  assert.equal(
    resolveClosingDetailFactoryPrice(prices, " sa001 ", "2026-10"),
    170.52,
    "the code is trimmed and upper-cased, as the SQL resolver upper/btrims it",
  );
  assert.equal(
    resolveClosingDetailFactoryPrice(prices, "ZZ999", "2026-10"),
    0,
    "a product with no price contributes 0 — the Matrix's own coalesce(..., 0)",
  );

  // ── 2. What a row is worth, at August 2026's real Anti Infective volume ─────
  const distributorRow = (period: string) =>
    Number(
      resolveClosingDetailSalesValue({
        effectiveUnits: 2_983,
        factoryPrice: resolveClosingDetailFactoryPrice(prices, "SA001", period),
        invoicePeriod: period,
        isDirect: false,
        sheetValue: 0,
      }).toFixed(2),
    );
  assert.equal(distributorRow("2026-10"), 508_661.16, "October: 2,983 units x 170.52, the Matrix's own figure");
  assert.equal(distributorRow("2026-08"), 331_560.45, "August: the published Matrix figure, unchanged to the piastre");

  // A direct order is the deal it was struck at, in October as in every month — the period price
  // must never reach its value.
  assert.equal(
    resolveClosingDetailSalesValue({
      effectiveUnits: 570,
      factoryPrice: resolveClosingDetailFactoryPrice(prices, "SA001", "2026-10"),
      invoicePeriod: "2026-10",
      isDirect: true,
      sheetValue: 66_960,
    }),
    66_960,
    "a direct row takes its stored value whatever the factory price is",
  );

  // ── 3. The loader really prices through it ─────────────────────────────────
  // Behaviour alone cannot see this: loadMonthlyClosingDetails reads production, so the only way to
  // know every row goes through the period price is to read the loader. This is the assertion that
  // fires if the master read comes back.
  const body = loaderBody(SOURCE);
  assert.ok(
    /\bloadProductPeriodPrices\(\)/.test(body),
    "the details loader reads the period prices (product master + overrides) alongside its other references",
  );
  assert.ok(
    /const factoryPrice = resolveClosingDetailFactoryPrice\(prices, productCode, period\);/.test(body),
    "every detail row is priced at the CLOSING month — the period the Matrix's fact rollup is stamped with",
  );
  assert.ok(
    !MASTER_PRICE_READ.test(body),
    "no detail row may be valued at the product master's flat price — it values October's Saginko at 111.15",
  );
  assert.ok(
    /resolveClosingDetailSalesValue\(\{[^}]*\bfactoryPrice\b[^}]*\}\)/.test(body),
    "the row's value is derived from the same resolved price the row displays",
  );

  // Negative controls — without them a detector that matched nothing would pass everything above.
  assert.ok(
    MASTER_PRICE_READ.test("const factoryPrice = num(product?.factoryPrice);"),
    "the master-price detector fires on the exact line it replaced",
  );
  assert.ok(
    !MASTER_PRICE_READ.test(stripComments("// was num(product?.factoryPrice) until 2026-10-01\nconst x = 1;")),
    "a mention in a comment is not a read",
  );
}
