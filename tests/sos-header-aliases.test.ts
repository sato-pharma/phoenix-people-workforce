import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  validateDistributorSalesWorkbookBuffer,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";

// Hybrid (raw + hand-coded) sheets keep each distributor's own raw column names for qty/date/brick
// (e.g. QTY_INVOICE, INVOICE_DATE, Quantity, Date, Brick ID2). Header aliasing must let those sheets
// match the CODED template — so the user's own coded columns are used and EVERY row is kept — instead
// of silently falling back to the normalizer (which re-codes from raw text and drops unmapped rows,
// undercounting totals). This is a pure, DB-free guard via validateDistributorSalesWorkbookBuffer.
const references: SalesReferenceData = {
  distributors: [
    { code: "EG", name: "EGD" },
    { code: "IS", name: "Ibn Sina" },
  ],
  products: [
    { factoryPrice: 10, family: "CNS Family", familyCode: "CNS", line: "CNS", productCode: "P-A", productName: "Product A", source: "Phoenix" },
  ],
  regions: [{ areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }],
  areas: [{ areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }],
  blocks: [{ areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", regionCode: "CA", regionName: "Cairo" }],
  bricks: [{ areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", brickId: "B-1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" }],
};

async function buildWorkbookBuffer(headers: string[], rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

export async function runSosHeaderAliasesTests() {
  // 1) EGD-style hybrid: unknown distributor "EG", coded ID columns present, but qty=QTY_INVOICE and
  //    date=INVOICE_DATE (raw names). Must match the Normalizer coded template and keep both rows.
  const egdBuffer = await buildWorkbookBuffer(
    ["BRANCH_NAME", "QTY_INVOICE", "INVOICE_DATE", "Product ID", "Brick ID", "Area ID", "Region ID", "Distrub ID"],
    [
      ["branch a", 10, new Date("2026-04-01T00:00:00Z"), "P-A", "B-1", "A1", "CA", "EG"],
      ["branch b", 5, new Date("2026-04-02T00:00:00Z"), "P-A", "B-1", "A1", "CA", "EG"],
    ],
  );
  const egd = await validateDistributorSalesWorkbookBuffer({
    buffer: egdBuffer as unknown as ArrayBuffer,
    distributorCode: "EG",
    fileName: "egd hybrid raw-names.xlsx",
    references,
  });
  assert.equal(egd.templateName, "Normalized coded sheet"); // coded path, NOT a normalizer fallback
  assert.equal(egd.status, "validated");
  assert.equal(egd.failedRows, 0);
  assert.equal(egd.rowCount, 2); // every row kept — nothing dropped
  assert.equal(egd.totals.totalQty, 15); // QTY_INVOICE summed (10 + 5)
  assert.equal(egd.totals.totalValue, 150); // 15 * factory price 10

  // 2) Ibn Sina-style hybrid: known distributor "IS" with qty=Quantity, date=Date, brick=Brick ID2,
  //    plus a Total Quantity column that must NOT be mistaken for the qty column.
  const isBuffer = await buildWorkbookBuffer(
    ["old brick", "Quantity", "Total Quantity", "Date", "Product ID", "Brick ID2", "Area ID", "Region ID", "Distrub ID"],
    [
      ["10101", 24, 999, new Date("2026-04-30T00:00:00Z"), "P-A", "B-1", "A1", "CA", "IS"],
      ["10104", 5, 999, new Date("2026-04-30T00:00:00Z"), "P-A", "B-1", "A1", "CA", "IS"],
    ],
  );
  const ibnsina = await validateDistributorSalesWorkbookBuffer({
    buffer: isBuffer as unknown as ArrayBuffer,
    distributorCode: "IS",
    fileName: "ibnsina hybrid brickid2.xlsx",
    references,
  });
  assert.equal(ibnsina.templateName, "Ibn Sina IS coded template"); // its own coded template, not normalizer
  assert.equal(ibnsina.status, "validated");
  assert.equal(ibnsina.failedRows, 0);
  assert.equal(ibnsina.rowCount, 2);
  assert.equal(ibnsina.totals.totalQty, 29); // Quantity (24 + 5) — NOT Total Quantity (999s ignored)
  const filledBrick = ibnsina.byBrick.find((row) => row.brickId === "B-1");
  assert.ok(filledBrick, "brick B-1 resolved from the Brick ID2 column");
  assert.equal(filledBrick?.areaCode, "A1");
}
