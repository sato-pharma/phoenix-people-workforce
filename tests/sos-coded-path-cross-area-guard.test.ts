import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  validateDistributorSalesWorkbookBuffer,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";

// The coded distributor-import path auto-fills a blank brick from the customer→brick map. It did so
// WITHOUT the cross-area guard the normalizer's resolveBrick applies: if the sheet already typed an
// area but left the brick blank, and the stored mapping points at a brick in a DIFFERENT area, the
// old code filled it anyway — silently moving the sale, and the rep's numbers, across areas on an
// unverified stored mapping. resolveBrick forbids exactly that.
//
// (This path currently runs for ZERO production rows — every batch uses the normalizer/office/direct
// templates — so this is a latent divergence. The guard keeps it from becoming live loss the day a
// coded sheet is uploaded.)
//
// Fixture: B-1 lives in area A1, B-2 in area A2. A customer mapped to B-2 (area A2), on a coded row
// that types area A1 with a blank brick, must NOT be auto-filled to B-2.

const references: SalesReferenceData = {
  distributors: [{ code: "PS", name: "overseas" }],
  products: [
    { factoryPrice: 10, family: "CNS Family", familyCode: "CNS", line: "CNS", productCode: "P-A", productName: "Product A", source: "Phoenix" },
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
    { areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", blockCode: "BL-2", blockName: "Block Two", regionCode: "AB", regionName: "Alex" },
  ],
  bricks: [
    { areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", brickId: "B-1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", blockCode: "BL-2", blockName: "Block Two", brickId: "B-2", brickName: "Brick Two", regionCode: "AB", regionName: "Alex" },
  ],
  // Customer C-X is mapped to B-2, which is in area A2.
  customerBricks: [{ brickId: "B-2", customerCode: "C-X", distributorCode: "PS" }],
};

async function buildPsBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["Branch", "Branch Name", "Invoice Date", "Qty", "B. Qty", "Value", "Product ID", "Brick ID", "Area ID", "Region ID", "Distrub ID", "Customer"]);
  rows.forEach((r) => sheet.addRow(r));
  return workbook.xlsx.writeBuffer();
}

export async function runSosCodedPathCrossAreaGuardTests() {
  // ── Cross-area: sheet types A1, brick blank, mapping points at B-2 (A2) ─────
  // The mapping must be REJECTED — the row keeps its blank brick and fails the brick check.
  const crossBuffer = await buildPsBuffer([
    ["B1", "Branch", new Date("2026-04-01T00:00:00Z"), 10, 0, 100, "P-A", "", "A1", "CA", "PS", "C-X"],
  ]);
  const cross = await validateDistributorSalesWorkbookBuffer({
    buffer: crossBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "cross-area.xlsx",
    references,
  });
  // Not auto-filled to B-2: no brick landed on B-2 in area A2.
  assert.ok(
    !cross.byBrick.some((b) => b.brickId === "B-2"),
    "a mapping that crosses the sheet's area must NOT auto-fill — the sale must not move to another area",
  );
  assert.ok(
    cross.issues.some((i) => i.field === "Brick ID"),
    "with the cross-area mapping rejected, the blank brick must surface as a row to fix",
  );

  // ── Same area: sheet types A1, brick blank, mapping points at B-1 (A1) ──────
  // The mapping IS inside the typed area, so it must be accepted as before.
  const sameArea: SalesReferenceData = { ...references, customerBricks: [{ brickId: "B-1", customerCode: "C-Y", distributorCode: "PS" }] };
  const okBuffer = await buildPsBuffer([
    ["B1", "Branch", new Date("2026-04-01T00:00:00Z"), 10, 0, 100, "P-A", "", "A1", "CA", "PS", "C-Y"],
  ]);
  const ok = await validateDistributorSalesWorkbookBuffer({
    buffer: okBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "same-area.xlsx",
    references: sameArea,
  });
  assert.ok(
    ok.byBrick.some((b) => b.brickId === "B-1"),
    "an in-area mapping must still auto-fill the blank brick — the guard narrows only, it must not block valid fills",
  );

  // ── No area typed: mapping taken in full (the common raw/hybrid case) ───────
  const noArea: SalesReferenceData = { ...references, customerBricks: [{ brickId: "B-2", customerCode: "C-Z", distributorCode: "PS" }] };
  const noAreaBuffer = await buildPsBuffer([
    ["B1", "Branch", new Date("2026-04-01T00:00:00Z"), 10, 0, 100, "P-A", "", "", "", "PS", "C-Z"],
  ]);
  const noAreaResult = await validateDistributorSalesWorkbookBuffer({
    buffer: noAreaBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "no-area.xlsx",
    references: noArea,
  });
  assert.ok(
    noAreaResult.byBrick.some((b) => b.brickId === "B-2"),
    "with no area typed there is nothing to cross, so the mapping fills the brick in full",
  );
}
