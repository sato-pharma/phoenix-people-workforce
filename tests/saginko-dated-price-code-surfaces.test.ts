import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { productPeriodPricesFromRows } from "../src/lib/sales/product-period-price.ts";
import { generateTargetsTemplate, parseTargetsWorkbook } from "../src/lib/sales/targets-template.ts";
import { livePriceMap, liveUnitPrice } from "../src/lib/sales/weekly/live-price.ts";
import { buildWeeklyStockView, type WeeklyStockSourceRow } from "../src/lib/sales/weekly/stock-dashboard.ts";
import { weeklyZeroSalesBranches } from "../src/lib/sales/weekly/unit-totals.ts";

// THE LAST THREE CODE PATHS THAT PRICED SAGINKO AT ITS FLAT 111.15 — 2026-10-01.
//
// Saginko (SA001) is 111.15 through 2026-09 and 170.52 from 2026-10 (owner, 2026-09-28); the product
// master stays 111.15. A sweep of every reader of the master price found three code paths that turned
// units into money for a month without asking which month:
//
//   1. The targets template download. It priced every row at ONE price per product — the span's FIRST
//      month — so a SEMESTER sheet (Jul–Dec 2026) valued October–December Saginko at 111.15, and the
//      upload STORES that value as target_value. Against sales at 170.52 that inflates Saginko's
//      achievement by 53%, on the number the incentive scheme reads. Each row is now priced at its own
//      Period — in the cached figures the upload reads AND in the sheet's lookup formula.
//   2. The weekly stock dashboard (stock value, average weekly sales) and the zero-sales watchlist. Their
//      price came from today's flat master price, while the weekly sales screens price each month.
//   3. Marketing ROI "near misses" ("would have counted"), valued at the flat price, while the RPC they
//      mirror (phx_marketing_request_roi_actuals) prices each row at its invoice month.

const SAGINKO = "SA001";
const MASTER = [
  { productCode: SAGINKO, factoryPrice: 111.15 },
  { productCode: "RO001", factoryPrice: 60.7 },
];
const OVERRIDES = [{ productCode: SAGINKO, effectivePeriod: "2026-10", factoryPrice: 170.52 }];
const dated = productPeriodPricesFromRows(MASTER, OVERRIDES);
const today = livePriceMap(MASTER);
const round2 = (value: number) => Number(value.toFixed(2));

/** Source text with comments stripped, for the wiring the behaviour cannot reach. */
function code(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

function stockRow(partial: Partial<WeeklyStockSourceRow>): WeeklyStockSourceRow {
  return {
    distributorCode: "PS",
    distributorName: "Distributor One",
    regionCode: "CA",
    regionName: "Cairo",
    areaCode: "CA1",
    branchCode: "B1",
    branchName: "Branch One",
    productCode: SAGINKO,
    productName: "Saginko",
    line: "Anti Infective",
    cycleMonth: "2026-09-01",
    weekNumber: 1,
    weekStart: "2026-09-27",
    netUnits: 0,
    stockUnits: 0,
    factoryPrice: 111.15,
    ...partial,
  };
}

export async function runSaginkoDatedPriceCodeSurfacesTests() {
  // ── 1. The targets template prices every row at its own Period ──────────────────────────────────
  const products = [
    // The route hands the products priced for the span's FIRST month — September here.
    { productCode: SAGINKO, productName: "Saginko", factoryPrice: 111.15 },
    { productCode: "RO001", productName: "Royafloxacin", factoryPrice: 60.7 },
  ];
  const areas = [{ areaCode: "A1", areaName: "Area One", regionCode: "CA" }];
  const periods = ["2026-09", "2026-10"];
  const existing = new Map<string, { targetUnits: number | null; targetValue: number | null }>();
  for (const period of periods) {
    for (const product of products) existing.set(`${period}|A1|${product.productCode}`, { targetUnits: 100, targetValue: null });
  }
  const sheet = (withPrices: boolean) =>
    generateTargetsTemplate({
      lineLabel: "Anti Infective",
      areas,
      products,
      periods,
      existing,
      priceFor: withPrices ? (productCode, period) => dated.priceFor(productCode, period) : undefined,
      now: new Date(2026, 8, 1),
    });

  const buffer = await sheet(true);
  const parsed = await parseTargetsWorkbook(buffer);
  const stored = (period: string, product: string) =>
    parsed.find((row) => row.period === period && row.product === product)?.targetValue;
  assert.equal(
    stored("2026-10", SAGINKO),
    17_052,
    "targets template: an October Saginko target is valued at 170.52 (100 × 170.52), the price its sales are " +
      "valued at — never the span's first month's 111.15, which would inflate achievement 53%",
  );
  assert.equal(stored("2026-09", SAGINKO), 11_115, "a September Saginko target keeps 111.15");
  assert.equal(stored("2026-10", "RO001"), 6_070, "a product with no dated price is valued at its own price in October too");
  const flat = await parseTargetsWorkbook(await sheet(false));
  assert.equal(
    flat.find((row) => row.period === "2026-10" && row.product === SAGINKO)?.targetValue,
    11_115,
    "control: without the dated prices the sheet stores October at the first month's price — the hole this closes",
  );

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  assert.deepEqual(
    workbook.worksheets.map((worksheet) => worksheet.name),
    ["Targets", "Products (Anti Infective)", "Areas (Anti Infective)", "Lists", "Read Me"],
    "the dated table rides on the Lists sheet — the sheet set is unchanged",
  );
  const targets = workbook.getWorksheet("Targets");
  assert.ok(targets, "Targets sheet present");
  let octoberRow = 0;
  targets.eachRow((row, number) => {
    if (row.getCell(1).value === "2026-10" && row.getCell(2).value === "Saginko") octoberRow = number;
  });
  assert.ok(octoberRow > 0, "control: the October Saginko row is laid out");
  const unitPrice = targets.getCell(octoberRow, 8).value as { formula?: string; result?: unknown };
  assert.equal(unitPrice.result, 170.52, "the October row's Unit Price reads 170.52 before Excel recalculates");
  assert.match(
    String(unitPrice.formula),
    /VLOOKUP\(\$B\d+&"\|"&\$A\d+,'Lists'!\$C:\$D,2,FALSE\)/,
    "the Unit Price formula looks the price up by product AND the row's Period, so a re-picked month re-prices",
  );
  const table = new Map<string, unknown>();
  workbook.getWorksheet("Lists")?.eachRow((row, number) => {
    if (number > 1 && row.getCell(3).value) table.set(String(row.getCell(3).value), row.getCell(4).value);
  });
  assert.equal(table.get("Saginko|2026-10"), 170.52, "the dated table carries October's 170.52");
  assert.equal(table.get("Saginko|2026-09"), 111.15, "and September's 111.15");

  const route = code("app/api/sales/targets/template/route.ts");
  assert.match(route, /loadProductPeriodPrices\(\)/, "the template route loads the dated prices");
  assert.match(
    route,
    /priceFor: \(productCode, period\) => periodPrices\.priceFor\(productCode, period\)/,
    "and hands them to the template, so a downloaded semester prices each month at its own price",
  );

  // ── 2. Weekly stock and the zero-sales watchlist price by month ─────────────────────────────────
  assert.equal(liveUnitPrice(SAGINKO, "2026-10", today, dated), 170.52, "weekly: October Saginko is 170.52");
  assert.equal(liveUnitPrice(SAGINKO, "2026-09", today, dated), 111.15, "September stays 111.15");
  assert.equal(liveUnitPrice(SAGINKO, null, today, dated), 111.15, "no month: today's price, as before");
  assert.equal(liveUnitPrice("ZZ999", "2026-10", today, dated), null, "no master price: no price, as before");
  assert.equal(liveUnitPrice(SAGINKO, "2026-10", today), 111.15, "control: without the dated prices it is the flat 111.15");

  // Two distributors whose snapshots straddle the reprice: September (111.15) and October (170.52).
  const september = stockRow({ distributorCode: "PS", branchCode: "B1", netUnits: 4, stockUnits: 10, factoryPrice: 111.15 });
  const october = stockRow({
    distributorCode: "IS",
    branchCode: "B2",
    branchName: "Branch Two",
    cycleMonth: "2026-10-01",
    weekStart: "2026-10-04",
    netUnits: 6,
    stockUnits: 10,
    factoryPrice: 170.52,
  });
  const forward = buildWeeklyStockView([october, september], new Map());
  const backward = buildWeeklyStockView([september, october], new Map());
  assert.equal(
    forward.kpis.stockValue,
    round2(10 * 111.15 + 10 * 170.52),
    "weekly stock: each depot's stock is valued at the price of its own snapshot's month",
  );
  assert.equal(
    forward.kpis.avgWeeklyValue,
    backward.kpis.avgWeeklyValue,
    "weekly stock: the product's price for average weekly sales no longer depends on row order",
  );
  assert.equal(
    forward.kpis.avgWeeklyValue,
    round2((4 + 6) * 170.52),
    "it is the NEWEST snapshot's price — October's 170.52 — once a snapshot is in October",
  );

  const watchRow = (branchCode: string, productCode: string, stockQty: number) => ({
    branchCode,
    branchName: branchCode,
    regionName: "Cairo",
    productCode,
    productName: productCode,
    salesValue: 0,
    netQty: 0,
    stockQty,
    cycleMonth: "2026-10-01",
    weekStart: "2026-10-04",
  });
  const watchRows = [watchRow("ROYAFLOXACIN-DEPOT", "RO001", 25), watchRow("SAGINKO-DEPOT", SAGINKO, 10)];
  assert.deepEqual(
    weeklyZeroSalesBranches(watchRows, (productCode, period) => liveUnitPrice(productCode, period, today, dated) ?? undefined).map(
      (branch) => branch.branchCode,
    ),
    ["SAGINKO-DEPOT", "ROYAFLOXACIN-DEPOT"],
    "zero-sales watchlist: in October 10 Saginko (1,705.20) outrank 25 Royafloxacin (1,517.50)",
  );
  assert.deepEqual(
    weeklyZeroSalesBranches(watchRows, (productCode) => today.get(productCode)).map((branch) => branch.branchCode),
    ["ROYAFLOXACIN-DEPOT", "SAGINKO-DEPOT"],
    "control: at the flat 111.15 (1,111.50) the order flips",
  );

  const service = code("src/lib/sales/weekly/service.ts");
  assert.match(
    service,
    /factoryPrice: liveUnitPrice\(row\.productCode, weeklyRowPeriod\(row\.cycleMonth, row\.weekStart\), priceMap, datedPrices\)/,
    "the weekly service hands every stock row the price of its own month",
  );
  assert.match(
    service,
    /weeklyZeroSalesBranches\(\s*weekRowsAdj,\s*\(productCode, period\) => liveUnitPrice\(productCode, period, priceMap, datedPrices\)/,
    "and ranks the zero-sales watchlist by that price",
  );

  // ── 3. Marketing ROI near misses price each row at its invoice month ────────────────────────────
  const roi = code("src/lib/marketing-requests/roi-explain-service.ts");
  assert.match(roi, /\.from\("source_of_sales_product_price_history"\)/, "the ROI explanation reads the dated prices");
  assert.match(roi, /productPeriodPricesFromRows\(/, "and resolves them by phx_factory_price's rule");
  assert.equal(
    (roi.match(/priceFor\([^;]*invoice_period/g) ?? []).length,
    2,
    "both the near misses and the ledger rebuild price a row at its own invoice month",
  );
  assert.doesNotMatch(roi, /sosFactoryByCode|factoryByCode\.get/, "no flat price map is left in the ROI explanation");
}
