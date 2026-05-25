import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  validateDistributorSalesWorkbookBuffer,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";

const references: SalesReferenceData = {
  distributors: [{ code: "PS", name: "overseas" }],
  products: [
    {
      factoryPrice: 10,
      family: "CNS Family",
      familyCode: "CNS",
      line: "CNS",
      productCode: "P-A",
      productName: "Product A",
      source: "Phoenix",
    },
    {
      factoryPrice: 50,
      family: "Pedia Family",
      familyCode: "PED",
      line: "Pedia",
      productCode: "P-B",
      productName: "Product B",
      source: "Phoenix",
    },
  ],
  regions: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
  ],
};

async function buildWorkbookBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow([
    "Branch",
    "Branch Name",
    "Vendor Name",
    "Customer",
    "Customer Name",
    "Customer Address",
    "Sal. District",
    "Sal. Dist. Desc.",
    "Region Name",
    "Region Code",
    "Invoice Serial",
    "Invoice Date",
    "Trans. Type",
    "Mat. Code",
    "Mat. Desc.",
    "Product Name",
    "Product Code",
    "Qty",
    "B. Qty",
    "Value",
    "Distrb code",
  ]);
  rows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

export async function runSalesDistributorImportTests() {
  const buffer = await buildWorkbookBuffer([
    ["B1", "Branch", "Vendor", "C1", "Customer", "Address", "D", "Desc", "Cairo", "CA", "INV1", new Date("2026-04-01T00:00:00Z"), "Sales", "M1", "Mat", "Product A", "P-A", 10, 1, 100, "PS"],
    ["B1", "Branch", "Vendor", "C2", "Customer", "Address", "D", "Desc", "Alex", "AB", "INV2", new Date("2026-04-02T00:00:00Z"), "Sales", "M2", "Mat", "Product B", "P-B", 5, 2, 250, "PS"],
    ["B1", "Branch", "Vendor", "C3", "Customer", "Address", "D", "Desc", "#N/A", "#N/A", "INV3", new Date("2026-04-03T00:00:00Z"), "Sales", "M1", "Mat", "Product A", "P-A", 3, 0, 30, "PS"],
  ]);

  const result = await validateDistributorSalesWorkbookBuffer({
    buffer: buffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "POS REFERENCE.xlsx",
    references,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.rowCount, 3);
  assert.equal(result.failedRows, 1);
  assert.equal(result.totals.totalQty, 18);
  assert.equal(result.totals.totalBonusQty, 3);
  assert.equal(result.totals.totalValue, 380);
  assert.equal(result.period, "2026-04");

  const cns = result.byLine.find((row) => row.line === "CNS");
  assert.equal(cns?.totalQty, 13);
  assert.equal(cns?.totalBonusQty, 1);
  assert.equal(cns?.totalValue, 130);

  const unknownRegion = result.byRegion.find((row) => row.regionCode === "#N/A");
  assert.equal(unknownRegion?.regionName, "#N/A");
  assert.equal(unknownRegion?.totalQty, 3);
  assert.equal(unknownRegion?.totalValue, 30);

  const productA = result.byProduct.find((row) => row.productCode === "P-A");
  assert.equal(productA?.officialLine, "CNS");
  assert.equal(productA?.totalQty, 13);
  assert.equal(productA?.totalBonusQty, 1);
  assert.equal(productA?.totalValue, 130);
  assert.ok(result.issues.some((issue) => issue.field === "Region Code" && issue.value === "#N/A"));

  const mismatchBuffer = await buildWorkbookBuffer([
    ["B1", "Branch", "Vendor", "C4", "Customer", "Address", "D", "Desc", "Wrong Region", "CA", "INV4", new Date("2026-04-04T00:00:00Z"), "Sales", "M1", "Mat", "Product A", "P-A", 1, 0, 10, "PS"],
    ["B1", "Branch", "Vendor", "C5", "Customer", "Address", "D", "Desc", "Cairo", "CA", "INV5", new Date("2026-04-05T00:00:00Z"), "Sales", "M1", "Mat", "Wrong Product", "P-A", 2, 0, 20, "PS"],
  ]);

  const mismatchResult = await validateDistributorSalesWorkbookBuffer({
    buffer: mismatchBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "POS REFERENCE.xlsx",
    references,
  });

  assert.equal(mismatchResult.status, "blocked");
  assert.equal(mismatchResult.failedRows, 2);
  assert.ok(mismatchResult.issues.some((issue) => issue.field === "Region Name" && issue.value === "Wrong Region"));
  assert.ok(mismatchResult.issues.some((issue) => issue.field === "Product Name" && issue.value === "Wrong Product"));
}
