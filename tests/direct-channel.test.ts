import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { JULY_2026_DIRECT_PERIOD, JULY_2026_DIRECT_ROWS } from "../src/lib/sales/july-2026-direct-orders.ts";
import {
  buildMonthlyClosingMatrix,
  injectDirectIntoMatrix,
  validateDistributorSalesWorkbookBuffer,
  type MonthlyClosingDirectCell,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";

const references: SalesReferenceData = {
  distributors: [
    { code: "PS", name: "overseas" },
    { code: "Direct", name: "Direct (Company)" },
  ],
  products: [
    { factoryPrice: 10, family: "CNS", familyCode: "CNS", line: "Pedia", productCode: "P-A", productName: "Product A", source: "" },
    { factoryPrice: 50, family: "Pedia", familyCode: "PED", line: "Pedia", productCode: "P-B", productName: "Product B", source: "" },
  ],
  regions: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
  ],
  areas: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
  ],
  blocks: [],
  bricks: [],
};

async function buildDirectWorkbookBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["Date", "Line", "Product", "Price", "QTY", "Bonus", "Value", "Product ID", "Region ID", "Distrub ID"]);
  rows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

export async function runDirectChannelTests() {
  // ── Importer: Direct template — value from the sheet, region-only, no area/brick error ──
  const buffer = await buildDirectWorkbookBuffer([
    // Real region (Cairo). Value 250 comes from the sheet, NOT qty(10) × factory(10) = 100.
    [new Date("2026-05-03T00:00:00Z"), "Pedia", "Product A", 25, 10, 2, 250, "P-A", "CA", "Direct"],
    // National bucket. Value 300 ≠ qty(5) × factory(50) = 250. Satoslim-style: real sheet value.
    [new Date("2026-05-04T00:00:00Z"), "Pedia", "Product B", 0, 5, 1, 300, "P-B", "National", "Direct"],
  ]);
  const result = await validateDistributorSalesWorkbookBuffer({
    buffer: buffer as unknown as ArrayBuffer,
    distributorCode: "Direct",
    fileName: "Direct 5.xlsx",
    references,
  });
  assert.equal(result.templateKey, "direct_orders");
  assert.equal(result.status, "validated"); // no "Area code is required" / "Brick ID is required"
  assert.deepEqual(result.blockingReasons, []);
  assert.equal(result.period, "2026-05");
  assert.equal(result.totals.totalQty, 15); // 10 + 5
  assert.equal(result.totals.totalBonusQty, 0); // bonus column no longer read
  assert.equal(result.totals.totalValue, 550); // 250 + 300, straight from the sheet (NOT 100 + 250)

  // ── injectDirectIntoMatrix: regional Direct → region subtotal; National → its own row ──
  const matrix = buildMonthlyClosingMatrix({
    areas: references.areas ?? [],
    availableLines: ["Pedia"],
    availablePeriods: ["2026-05"],
    cells: [
      { areaCode: "A1", productCode: "P-A", salesUnits: 4, salesValue: 40 },
      { areaCode: "A2", productCode: "P-B", salesUnits: 2, salesValue: 100 },
    ],
    line: "Pedia",
    period: "2026-05",
    products: references.products,
  });
  // Columns sort by family: P-A (CNS) is column 0, P-B (Pedia) is column 1.
  assert.equal(matrix.columns[0]?.productCode, "P-A");
  assert.equal(matrix.columns[1]?.productCode, "P-B");

  const directCells: MonthlyClosingDirectCell[] = [
    { productCode: "P-A", regionCode: "CA", salesUnits: 10, salesValue: 250 },
    { productCode: "P-B", regionCode: "National", salesUnits: 5, salesValue: 300 },
  ];
  const withDirect = injectDirectIntoMatrix(matrix, directCells);

  const cairo = withDirect.regions.find((r) => r.regionCode === "CA");
  assert.ok(cairo);
  assert.equal(cairo!.areas.length, 2); // A1 + Direct
  const directArea = cairo!.areas.find((a) => a.isDirect);
  assert.ok(directArea);
  assert.equal(directArea!.cells[0]!.salesValue, 250); // P-A direct value
  assert.equal(cairo!.subtotal.cells[0]!.salesValue, 290); // 40 (A1) + 250 (Direct)
  assert.equal(cairo!.subtotal.cells[0]!.salesUnits, 14); // 4 + 10

  // Grand total includes regional Direct but NOT National.
  assert.equal(withDirect.grandTotal.cells[0]!.salesValue, 290); // P-A: 40 + 250
  assert.equal(withDirect.grandTotal.cells[1]!.salesValue, 100); // P-B: A2 only

  // Direct – National row + company total = grand + national.
  assert.ok(withDirect.directNational);
  assert.equal(withDirect.directNational!.cells[1]!.salesValue, 300); // P-B national
  assert.ok(withDirect.companyTotal);
  assert.equal(withDirect.companyTotal!.cells[0]!.salesValue, 290); // P-A
  assert.equal(withDirect.companyTotal!.cells[1]!.salesValue, 400); // P-B: 100 + 300

  // No direct cells → matrix unchanged, no national/company rows.
  const none = injectDirectIntoMatrix(matrix, []);
  assert.equal(none.directNational, null);
  assert.equal(none.companyTotal, null);
  assert.equal(none.regions.find((r) => r.regionCode === "CA")?.areas.length, 1);

  // ── July 2026: direct money whose AREA is not in the matrix must still be counted ──
  // July merges hand-mapped direct into the real area rows, but only where `areaCode|productCode`
  // matches an existing row — anything matching nothing used to be discarded with no warning. No
  // live month hits that today, so this guards a latent trap rather than a past incident: a mapping
  // naming an area the matrix does not carry would delete real money from a published headline.
  // The fixture deliberately omits one mapped area from the grid to reproduce exactly that.
  const julyPedia = JULY_2026_DIRECT_ROWS.filter((row) => row.line.trim().toLowerCase() === "pedia");
  assert.ok(julyPedia.length > 0, "fixture sanity: the July hand-map must carry Pedia rows");

  const orphanArea = julyPedia[0]!.areaCode;
  const keptAreaCodes = [...new Set(julyPedia.map((row) => row.areaCode))].filter((code) => code !== orphanArea);
  const julyAreas = keptAreaCodes.map((areaCode) => {
    const row = julyPedia.find((entry) => entry.areaCode === areaCode)!;
    return { areaCode, areaName: row.areaName, regionCode: row.regionCode, regionName: row.regionCode };
  });

  const julyMatrix = buildMonthlyClosingMatrix({
    areas: julyAreas,
    availableLines: ["Pedia"],
    availablePeriods: [JULY_2026_DIRECT_PERIOD],
    cells: [],
    line: "Pedia",
    period: JULY_2026_DIRECT_PERIOD,
    products: [...new Set(julyPedia.map((row) => row.productCode))].map((productCode) => ({
      factoryPrice: 1, family: "Pedia", familyCode: "PED", line: "Pedia",
      productCode, productName: productCode, source: "",
    })),
  });

  // The direct RPC's view of the SAME money, grouped region × product the way it returns it — so
  // resolveJulyDirectByArea's value reconciliation passes and the July merge path actually runs.
  const byRegionProduct = new Map<string, MonthlyClosingDirectCell>();
  julyPedia.forEach((row) => {
    const key = `${row.regionCode}|${row.productCode}`;
    const cell = byRegionProduct.get(key)
      ?? { productCode: row.productCode, regionCode: row.regionCode, salesUnits: 0, salesValue: 0 };
    cell.salesUnits += row.qty;
    cell.salesValue += row.value;
    byRegionProduct.set(key, cell);
  });

  const julyInjected = injectDirectIntoMatrix(julyMatrix, [...byRegionProduct.values()]);
  const sumRegions = (pick: (cell: { salesUnits: number; salesValue: number }) => number) =>
    julyInjected.regions.reduce(
      (sum, region) => sum + region.areas.reduce((inner, area) => inner + pick(area.rowTotal), 0),
      0,
    );
  const placedValue = sumRegions((cell) => cell.salesValue) + (julyInjected.directNational?.rowTotal.salesValue ?? 0);
  const placedUnits = sumRegions((cell) => cell.salesUnits) + (julyInjected.directNational?.rowTotal.salesUnits ?? 0);

  assert.equal(
    Number(placedValue.toFixed(2)),
    Number(julyPedia.reduce((sum, row) => sum + row.value, 0).toFixed(2)),
    "every EGP of July direct must reach the matrix — an area missing from the grid must never delete its money",
  );
  assert.equal(
    Number(placedUnits.toFixed(6)),
    julyPedia.reduce((sum, row) => sum + row.qty, 0),
    "every UNIT of July direct must reach the matrix too",
  );
}
