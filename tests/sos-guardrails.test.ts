import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  validateDistributorSalesWorkbookBuffer,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";

// Accuracy guardrails. C2 (wrong-distributor advisory) is pure and tested here: the validator already
// BLOCKS rows whose distributor column doesn't match the selected distributor; on top of that block we
// now surface a single, plain-English advisory explaining the likely cause (a wrong dropdown pick),
// instead of leaving the user to decode N per-row "Distributor code must be X" failures. (C1, the
// duplicate-batch block, lives in the persist path and is covered by manual/CI smoke — it needs the DB.)
const references: SalesReferenceData = {
  distributors: [
    { code: "PS", name: "Overseas" },
    { code: "EG", name: "EGD" },
  ],
  products: [
    { factoryPrice: 10, family: "CNS Family", familyCode: "CNS", line: "CNS", productCode: "P-A", productName: "Product A", source: "Phoenix" },
  ],
  regions: [{ areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }],
  areas: [{ areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }],
  blocks: [{ areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", regionCode: "CA", regionName: "Cairo" }],
  bricks: [{ areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", brickId: "B-1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" }],
};

async function buildPsBuffer(distribIdValue: string) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["Customer", "Invoice Date", "Qty", "Product ID", "Brick ID", "Area ID", "Region ID", "Distrub ID"]);
  sheet.addRow(["C-1", new Date("2026-04-01T00:00:00Z"), 10, "P-A", "B-1", "A1", "CA", distribIdValue]);
  return workbook.xlsx.writeBuffer();
}

export async function runSosGuardrailsTests() {
  // 1) Mismatch: selected PS, but the file's Distrub ID column says EG. The per-row distributor check
  //    blocks it, AND our clarifying advisory is surfaced alongside.
  const mismatchBuffer = await buildPsBuffer("EG");
  const mismatch = await validateDistributorSalesWorkbookBuffer({
    buffer: mismatchBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "mismatch.xlsx",
    references,
  });
  assert.equal(mismatch.status, "blocked"); // existing per-row distributor check blocks the upload
  assert.ok(mismatch.advisories && mismatch.advisories.length === 1, "a distributor-mismatch advisory is present");
  assert.match(mismatch.advisories![0], /EG/);
  assert.match(mismatch.advisories![0], /PS/);
  assert.ok(
    mismatch.issues.some((i) => i.severity === "failure" && /distributor code/i.test(i.message)),
    "the per-row distributor-mismatch failure is present",
  );

  // 2) Match: selected PS, file's Distrub ID says PS -> no advisory.
  const matchBuffer = await buildPsBuffer("PS");
  const match = await validateDistributorSalesWorkbookBuffer({
    buffer: matchBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "match.xlsx",
    references,
  });
  assert.equal(match.status, "validated");
  assert.equal((match.advisories ?? []).length, 0, "no advisory when the distributor matches");
}
