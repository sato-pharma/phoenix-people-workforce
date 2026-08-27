import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  validateDistributorSalesWorkbookBuffer,
  type SalesReferenceData,
} from "../src/lib/sales/monthly-distributor-import.ts";

// The coded import auto-fills a blank brick from the customer→brick map, behind a cross-area guard:
// a stored mapping pointing OUTSIDE the area the sheet typed is rejected, so an unverified mapping
// can never move a sale — and a rep's numbers — to another area.
//
// That guard fired on an area that is not a place. "OTMS" (Main Store) is a distributor WAREHOUSE
// bucket: it owns no brick, has no rep, no DM and no target, and no row in au.sos_area_crosswalk.
// Because "OTMS" != the mapped brick's real area, the guard rejected every Main Store row and the
// brick stayed blank — so in 2026-07 CNS, 109 customers whose brick was ALREADY stored imported
// unmapped and EGP 47,385 reached no rep at all.
//
// The fix: an area that owns no brick in the master is not a territory, so there is nothing to
// cross. Treat it exactly like a blank area — take the mapping in full, and take the brick's real
// area and region with it (leaving the row on "OTMS" with a brick in OT5 would be a hierarchy that
// contradicts itself). A real area that owns bricks must still be guarded, unchanged.

const references: SalesReferenceData = {
  distributors: [{ code: "PS", name: "overseas" }],
  products: [
    { factoryPrice: 10, family: "CNS Family", familyCode: "CNS", line: "CNS", productCode: "P-A", productName: "Product A", source: "Phoenix" },
  ],
  regions: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
    { areaCode: "WH", areaName: "Main Store", regionCode: "OT", regionName: "Others" },
  ],
  areas: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
    // A real row in the area master, but it owns no brick below — the warehouse bucket.
    { areaCode: "WH", areaName: "Main Store", regionCode: "OT", regionName: "Others" },
  ],
  blocks: [
    { areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", blockCode: "BL-2", blockName: "Block Two", regionCode: "AB", regionName: "Alex" },
  ],
  bricks: [
    { areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", brickId: "B-1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", blockCode: "BL-2", blockName: "Block Two", brickId: "B-2", brickName: "Brick Two", regionCode: "AB", regionName: "Alex" },
  ],
  customerBricks: [{ brickId: "B-1", customerCode: "C-W", distributorCode: "PS" }],
};

async function buildPsBuffer(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  sheet.addRow(["Branch", "Branch Name", "Invoice Date", "Qty", "B. Qty", "Value", "Product ID", "Brick ID", "Area ID", "Region ID", "Distrub ID", "Customer"]);
  rows.forEach((r) => sheet.addRow(r));
  return workbook.xlsx.writeBuffer();
}

export async function runSosWarehouseAreaDoesNotBlockBrickFillTests() {
  // ── The bug: sheet types the warehouse area "WH", brick blank, mapping points at B-1 (area A1).
  // WH owns no brick, so it is not a territory and the mapping must be taken in full.
  const whBuffer = await buildPsBuffer([
    ["B1", "Branch", new Date("2026-08-01T00:00:00Z"), 10, 0, 100, "P-A", "", "WH", "OT", "PS", "C-W"],
  ]);
  const wh = await validateDistributorSalesWorkbookBuffer({
    buffer: whBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "warehouse-area.xlsx",
    references,
  });

  const filled = wh.byBrick.find((b) => b.brickId === "B-1");
  assert.ok(
    filled,
    "a warehouse area owns no brick, so there is no area to cross — the stored mapping must still fill the blank brick",
  );
  // The hierarchy must follow the brick, not the warehouse bucket it was parked in.
  assert.equal(filled.areaCode, "A1", "the filled row must take the brick's real area, not stay on the warehouse bucket");
  assert.equal(filled.regionCode, "CA", "the filled row must take the brick's real region, not the warehouse bucket's");
  // What the owner actually sees: the money must reach the real area, and nothing may be left
  // sitting in a warehouse bucket that has no rep, no DM and no target to receive it.
  assert.ok(
    !wh.byArea.some((a) => a.areaCode === "WH"),
    "no sale may remain attributed to the warehouse bucket once its brick is known — that is the EGP 47,385 that reached no rep",
  );
  assert.ok(
    wh.byArea.some((a) => a.areaCode === "A1"),
    "the sale must be reported under the brick's real area, where a rep can be credited for it",
  );

  // ── The guard must NOT be weakened for a real area: sheet types A2 (which owns B-2), mapping
  // points at B-1 in A1. That still crosses a genuine area boundary and must be rejected.
  const crossBuffer = await buildPsBuffer([
    ["B1", "Branch", new Date("2026-08-01T00:00:00Z"), 10, 0, 100, "P-A", "", "A2", "AB", "PS", "C-W"],
  ]);
  const cross = await validateDistributorSalesWorkbookBuffer({
    buffer: crossBuffer as unknown as ArrayBuffer,
    distributorCode: "PS",
    fileName: "still-guarded.xlsx",
    references,
  });
  assert.ok(
    !cross.byBrick.some((b) => b.brickId === "B-1"),
    "a mapping crossing a REAL area must still be rejected — the warehouse exemption must not widen the guard",
  );
  assert.ok(
    cross.issues.some((i) => i.field === "Brick ID"),
    "the rejected cross-area row must still surface as a row to fix",
  );
}
