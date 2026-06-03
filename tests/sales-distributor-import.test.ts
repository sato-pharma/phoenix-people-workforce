import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildSourceOfSalesDashboard,
  normalizeSourceOfSalesProductInput,
  validateDistributorSalesWorkbookBuffer,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";
import { SalesWorkflowError } from "../src/lib/sales/contracts.ts";

const references: SalesReferenceData = {
  distributors: [
    { code: "PS", name: "overseas" },
    { code: "IS", name: "Ibn sina" },
  ],
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
  areas: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
  ],
  blocks: [
    {
      areaCode: "A1",
      areaName: "Area One",
      blockCode: "BL-1",
      blockName: "Block One",
      regionCode: "CA",
      regionName: "Cairo",
    },
  ],
  bricks: [
    {
      areaCode: "A1",
      areaName: "Area One",
      blockCode: "BL-1",
      blockName: "Block One",
      brickId: "B-1",
      brickName: "Brick One",
      regionCode: "CA",
      regionName: "Cairo",
    },
    {
      areaCode: "A2",
      areaName: "Area Two",
      blockCode: "BL-2",
      blockName: "Block Two",
      brickId: "B-2",
      brickName: "Brick Two",
      regionCode: "AB",
      regionName: "Alex",
    },
  ],
};

async function buildWorkbookBuffer(headers: string[], rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

async function buildPsWorkbookBuffer(rows: unknown[][]) {
  return buildWorkbookBuffer(
    [
      "Branch",
      "Branch Name",
      "Invoice Date",
      "Qty",
      "B. Qty",
      "Value",
      "Product ID",
      "Brick ID",
      "Area ID",
      "Region ID",
      "Distrub ID",
    ],
    rows,
  );
}

async function buildIbnSinaWorkbookBuffer(rows: unknown[][]) {
  return buildWorkbookBuffer(
    [
      "old brick",
      "Quantity",
      "Item Name",
      "Net",
      "Date",
      "Free Unit",
      "type",
      "Product ID",
      "Brick ID2",
      "Area ID",
      "Region ID",
      "Distrub ID",
    ],
    rows,
  );
}

export async function runSalesDistributorImportTests() {
  const normalizedProduct = normalizeSourceOfSalesProductInput({
    active: true,
    factoryPrice: "1,250.75",
    family: "Tebofortin",
    familyCode: " te ",
    line: "  CNS  ",
    productCode: " te009 ",
    productName: "  Tebofortin Test  ",
    source: "Marcyl",
    sourceFile: "",
    sourceRowNumber: "",
    sourceSheet: "",
  });

  assert.equal(normalizedProduct.productCode, "TE009");
  assert.equal(normalizedProduct.productName, "Tebofortin Test");
  assert.equal(normalizedProduct.familyCode, "TE");
  assert.equal(normalizedProduct.factoryPrice, 1250.75);
  assert.equal(normalizedProduct.normalizedProductName, "tebofortin test");
  assert.equal(normalizedProduct.normalizedLine, "cns");
  assert.equal(normalizedProduct.sourceFile, "Manual Entry");
  assert.equal(normalizedProduct.sourceSheet, "Products");
  assert.equal(normalizedProduct.sourceRowNumber, null);

  assert.throws(
    () => normalizeSourceOfSalesProductInput({
      factoryPrice: "-1",
      family: "Family",
      familyCode: "FA",
      line: "Line",
      productCode: "P-X",
      productName: "Product X",
      source: "Source",
    }),
    SalesWorkflowError,
  );

  const psBuffer = await buildPsWorkbookBuffer([
    ["B1", "Branch", new Date("2026-04-01T00:00:00Z"), 10, 1, 100, "P-A", "B-1", "A1", "CA", "PS"],
    ["B1", "Branch", new Date("2026-04-02T00:00:00Z"), 5, 2, 250, "P-B", "B-2", "A2", "AB", "PS"],
    ["B1", "Branch", new Date("2026-04-03T00:00:00Z"), 3, 0, 30, "P-A", "#N/A", "A1", "CA", "PS"],
  ]);

  const psResult = await validateDistributorSalesWorkbookBuffer({
    buffer: psBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "customer sales - Copy.XLSX",
    references,
  });

  assert.equal(psResult.templateKey, "overseas_ps");
  assert.equal(psResult.status, "blocked");
  assert.equal(psResult.rowCount, 3);
  assert.equal(psResult.failedRows, 1);
  assert.equal(psResult.totals.totalQty, 18);
  assert.equal(psResult.totals.totalBonusQty, 3);
  assert.equal(psResult.totals.totalValue, 380);
  assert.equal(psResult.period, "2026-04");
  assert.equal(psResult.byArea.find((row) => row.areaCode === "A1")?.totalQty, 13);
  assert.equal(psResult.byBrick.find((row) => row.brickId === "B-1")?.totalValue, 100);
  assert.equal(psResult.byProduct.find((row) => row.productCode === "P-A")?.officialLine, "CNS");
  assert.ok(psResult.issues.some((issue) => issue.field === "Brick ID" && issue.value === "#N/A"));

  const ibnBuffer = await buildIbnSinaWorkbookBuffer([
    ["10101", 24, "Product A", 240, "2026/04/30", 0, "#N/A", "P-A", "B-1", "A1", "CA", "IS"],
    ["10102", 2, "Product B", 100, "2026/04/29", 1, "#N/A", "P-B", "B-2", "A2", "AB", "IS"],
  ]);

  const ibnResult = await validateDistributorSalesWorkbookBuffer({
    buffer: ibnBuffer as unknown as ArrayBuffer,
    distributorCode: "IS",
    fileName: "ibnsina 4.xlsx",
    references,
  });

  assert.equal(ibnResult.templateKey, "ibn_sina_is");
  assert.equal(ibnResult.status, "validated");
  assert.equal(ibnResult.failedRows, 0);
  assert.equal(ibnResult.warningRows, 0);
  assert.equal(ibnResult.totals.totalQty, 26);
  assert.equal(ibnResult.totals.totalBonusQty, 1);
  assert.equal(ibnResult.totals.totalValue, 340);
  assert.equal(ibnResult.byLine.find((row) => row.line === "CNS")?.totalQty, 24);

  const mismatchBuffer = await buildPsWorkbookBuffer([
    ["B1", "Branch", new Date("2026-04-04T00:00:00Z"), 1, 0, 10, "P-A", "B-1", "A1", "AB", "PS"],
  ]);

  const mismatchResult = await validateDistributorSalesWorkbookBuffer({
    buffer: mismatchBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "customer sales - Copy.XLSX",
    references,
  });

  assert.equal(mismatchResult.status, "validated");
  assert.equal(mismatchResult.failedRows, 0);
  assert.equal(mismatchResult.warningRows, 1);
  assert.ok(mismatchResult.issues.some((issue) => issue.severity === "warning" && issue.field === "Area ID"));

  const dashboard = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-04"],
    batches: [
      {
        batchId: "batch-1",
        blockingReasons: [],
        createdAt: "2026-05-01T00:00:00Z",
        distributorCode: "PS",
        distributorName: "overseas",
        failedRows: 0,
        fileName: "ps.xlsx",
        importableRows: 2,
        period: "2026-04",
        rowCount: 2,
        status: "validated",
        templateKey: "overseas_ps",
        totalBonusQty: 1,
        totalQty: 15,
        totalValue: 350,
        uploadedBy: "tester",
        warningRows: 0,
      },
      {
        batchId: "batch-2",
        blockingReasons: [],
        createdAt: "2026-05-01T00:00:00Z",
        distributorCode: "IS",
        distributorName: "Ibn sina",
        failedRows: 0,
        fileName: "is.xlsx",
        importableRows: 1,
        period: "2026-04",
        rowCount: 1,
        status: "validated",
        templateKey: "ibn_sina_is",
        totalBonusQty: 0,
        totalQty: 24,
        totalValue: 240,
        uploadedBy: "tester",
        warningRows: 0,
      },
    ],
    period: "2026-04",
    summaries: [
      {
        groupCode: null,
        groupKey: "CNS",
        groupLabel: "CNS",
        groupType: "line",
        officialLine: "CNS",
        rowCount: 3,
        totalBonusQty: 1,
        totalQty: 39,
        totalValue: 590,
      },
      {
        groupCode: "A1",
        groupKey: "A1|Area One|CA",
        groupLabel: "Area One",
        groupType: "area",
        officialLine: "CA",
        rowCount: 2,
        totalBonusQty: 1,
        totalQty: 34,
        totalValue: 340,
      },
    ],
  });

  assert.equal(dashboard.sheetCount, 2);
  assert.equal(dashboard.totals.totalQty, 39);
  assert.equal(dashboard.byDistributor.length, 2);
  assert.equal(dashboard.byLine[0]?.label, "CNS");
  assert.equal(dashboard.byArea[0]?.code, "A1");
}
