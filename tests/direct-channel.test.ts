import assert from "node:assert/strict";

import ExcelJS from "exceljs";

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
}
