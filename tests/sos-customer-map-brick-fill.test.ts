import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  validateDistributorSalesWorkbookBuffer,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";

// References mirror tests/sales-distributor-import.ts, plus a customer -> brick crosswalk so the
// Upload Sales validator can auto-fill a blank/#N/A Brick from (distributor + customer code).
const references: SalesReferenceData = {
  distributors: [
    { code: "PS", name: "overseas" },
    { code: "Direct", name: "Direct" },
  ],
  products: [
    { factoryPrice: 10, family: "CNS Family", familyCode: "CNS", line: "CNS", productCode: "P-A", productName: "Product A", source: "Phoenix" },
  ],
  regions: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
  ],
  areas: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
  ],
  blocks: [
    { areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", regionCode: "CA", regionName: "Cairo" },
  ],
  bricks: [
    { areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", brickId: "B-1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" },
  ],
  // Only C-100 is mapped; C-999 is intentionally absent (negative case).
  customerBricks: [
    { distributorCode: "PS", customerCode: "C-100", brickId: "B-1" },
  ],
};

async function buildWorkbookBuffer(headers: string[], rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

// PS coded layout WITH a "Customer" column, and Brick/Area/Region present as headers but blank in
// the cells — exactly the "hybrid" shape whose VLOOKUP came out blank/#N/A.
async function buildPsHybridBuffer(rows: unknown[][]) {
  return buildWorkbookBuffer(
    ["Customer", "Invoice Date", "Qty", "Product ID", "Brick ID", "Area ID", "Region ID", "Distrub ID"],
    rows,
  );
}

export async function runSosCustomerMapBrickFillTests() {
  // 1) Mapped customer, blank Brick/Area/Region -> auto-filled from the customer map, validates.
  const mappedBuffer = await buildPsHybridBuffer([
    ["C-100", new Date("2026-04-01T00:00:00Z"), 10, "P-A", "", "", "", "PS"],
  ]);
  const mapped = await validateDistributorSalesWorkbookBuffer({
    buffer: mappedBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "egd hybrid.xlsx",
    references,
  });
  assert.equal(mapped.status, "validated");
  assert.equal(mapped.failedRows, 0);
  assert.equal(mapped.totals.totalQty, 10);
  assert.equal(mapped.totals.totalValue, 100); // 10 * 10, derived not from the sheet
  const filledBrick = mapped.byBrick.find((row) => row.brickId === "B-1");
  assert.ok(filledBrick, "brick B-1 should appear after customer-map fill");
  assert.equal(filledBrick?.areaCode, "A1"); // area derived from the mapped brick
  assert.equal(filledBrick?.regionCode, "CA"); // region derived from the mapped brick
  assert.ok(!mapped.issues.some((issue) => issue.message === "Brick ID is required."));

  // 2) Padding / case differences in the customer code still match.
  const paddedBuffer = await buildPsHybridBuffer([
    [" c-100 ", new Date("2026-04-02T00:00:00Z"), 5, "P-A", "#N/A", "#N/A", "#N/A", "PS"],
  ]);
  const padded = await validateDistributorSalesWorkbookBuffer({
    buffer: paddedBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "egd hybrid padded.xlsx",
    references,
  });
  assert.equal(padded.status, "validated");
  assert.equal(padded.failedRows, 0);
  assert.equal(padded.byBrick.find((row) => row.brickId === "B-1")?.totalQty, 5);

  // 3) Unmapped customer, blank brick -> still blocked with the brick-required failure.
  const unmappedBuffer = await buildPsHybridBuffer([
    ["C-999", new Date("2026-04-03T00:00:00Z"), 7, "P-A", "", "", "", "PS"],
  ]);
  const unmapped = await validateDistributorSalesWorkbookBuffer({
    buffer: unmappedBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "egd hybrid unmapped.xlsx",
    references,
  });
  assert.equal(unmapped.status, "blocked");
  assert.equal(unmapped.failedRows, 1);
  assert.ok(unmapped.issues.some((issue) => issue.message === "Brick ID is required."));

  // 4) A valid typed brick is respected even with no customer code (fallback never overrides it).
  const typedBuffer = await buildPsHybridBuffer([
    ["", new Date("2026-04-04T00:00:00Z"), 3, "P-A", "B-1", "A1", "CA", "PS"],
  ]);
  const typed = await validateDistributorSalesWorkbookBuffer({
    buffer: typedBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "ps typed.xlsx",
    references,
  });
  assert.equal(typed.status, "validated");
  assert.equal(typed.failedRows, 0);
  assert.equal(typed.byBrick.find((row) => row.brickId === "B-1")?.totalQty, 3);

  // 5) Direct (region-only) channel is unaffected: no brick is required and the fill never runs.
  const directBuffer = await buildWorkbookBuffer(
    ["Date", "QTY", "Value", "Product ID", "Region ID", "Distrub ID"],
    [[new Date("2026-04-05T00:00:00Z"), 10, 500, "P-A", "CA", "Direct"]],
  );
  const direct = await validateDistributorSalesWorkbookBuffer({
    buffer: directBuffer as unknown as ArrayBuffer,
    distributorCode: "Direct",
    fileName: "direct.xlsx",
    references,
  });
  assert.equal(direct.status, "validated");
  assert.equal(direct.failedRows, 0);
  assert.equal(direct.totals.totalValue, 500); // Direct value read verbatim from the sheet
}
