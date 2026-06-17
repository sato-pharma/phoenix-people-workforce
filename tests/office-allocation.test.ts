import assert from "node:assert/strict";

import { computeOfficeAllocation } from "../src/lib/sales/office-allocation.ts";
import type { SalesReferenceData } from "../src/lib/sales/monthly-distributor-import.ts";

const references: SalesReferenceData = {
  distributors: [{ code: "Office", name: "Office" }],
  products: [
    { factoryPrice: 10, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "P-A", productName: "Product A", source: "" },
    { factoryPrice: 50, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "P-B", productName: "Product B", source: "" },
    { factoryPrice: 5, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "P-C", productName: "Product C", source: "" },
  ],
  regions: [
    { areaCode: "", areaName: "", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "", areaName: "", regionCode: "AB", regionName: "Alex" },
  ],
  areas: [
    { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", regionCode: "AB", regionName: "Alex" },
  ],
  bricks: [
    { areaCode: "A1", areaName: "Area One", blockCode: "BL-1", blockName: "Block One", brickId: "B-1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" },
    { areaCode: "A2", areaName: "Area Two", blockCode: "BL-2", blockName: "Block Two", brickId: "B-2", brickName: "Brick Two", regionCode: "AB", regionName: "Alex" },
  ],
};

export function runOfficeAllocationTests() {
  const result = computeOfficeAllocation({
    period: "2026-05",
    distributor: { code: "Office", name: "Office" },
    fileName: "office 5.xlsx",
    sheetName: "Sheet1",
    mapped: [
      { productCode: "P-A", productName: "Product A", units: 100, rowNumber: 2 },
      { productCode: "P-B", productName: "Product B", units: 50, rowNumber: 3 },
      { productCode: "P-C", productName: "Product C", units: 30, rowNumber: 4 },
    ],
    unmappedNames: [],
    // Region share INCLUDES Direct: CA total 60 (40 brick + 20 Direct), AB 40. P-B only sold via Direct in CA.
    regionShare: [
      { productCode: "P-A", regionCode: "CA", units: 60 },
      { productCode: "P-A", regionCode: "AB", units: 40 },
      { productCode: "P-B", regionCode: "CA", units: 50 },
    ],
    // Brick share EXCLUDES Direct: CA has only B-1=40 (Direct's 20 is not here); AB has B-2=40. P-B has no brick rows.
    brickShare: [
      { productCode: "P-A", brickId: "B-1", areaCode: "A1", regionCode: "CA", units: 40 },
      { productCode: "P-A", brickId: "B-2", areaCode: "A2", regionCode: "AB", units: 40 },
    ],
    references,
  });

  assert.equal(result.status, "validated");
  assert.equal(result.distributor.code, "Office");

  // Totals: 100 + 50 + 30 = 180 units. Value = 600 + 400 + 2500 + 150 = 3650.
  assert.equal(result.totals.totalQty, 180);
  assert.equal(result.totals.totalValue, 3650);

  // P-A: region step (incl. Direct) sends 60 to CA, 40 to AB. Brick step (excl. Direct) places all of
  // CA's 60 on B-1 and all of AB's 40 on B-2. If Direct had been used in the brick key, B-1 would be 50.
  const b1 = result.byBrick.find((row) => row.brickId === "B-1");
  const b2 = result.byBrick.find((row) => row.brickId === "B-2");
  assert.equal(b1?.totalQty, 60);
  assert.equal(b1?.totalValue, 600); // 60 × factory price 10
  assert.equal(b2?.totalQty, 40);

  // P-B: sold only via Direct in CA (region-level, no brick detail) → its 50 units fall to NATIONAL.
  // P-C: sold nowhere this period → its 30 units fall to NATIONAL. National total = 80.
  const national = result.byRegion.find((row) => row.regionCode === "NATIONAL");
  assert.equal(national?.totalQty, 80);
  assert.equal(national?.totalValue, 2650); // P-B 50×50 + P-C 30×5

  // Conservation: P-A's allocated slices sum to exactly its office units (100).
  const paQty = result.byProduct.find((row) => row.productCode === "P-A")?.totalQty;
  assert.equal(paQty, 100);

  // National products are surfaced as an advisory.
  assert.ok(result.advisories?.some((a) => a.includes("National bucket")));

  // BLOCKED path: any unmapped office product name blocks the whole batch, persists nothing.
  const blocked = computeOfficeAllocation({
    period: "2026-05",
    distributor: { code: "Office", name: "Office" },
    fileName: "office 5.xlsx",
    sheetName: "Sheet1",
    mapped: [{ productCode: "P-A", productName: "Product A", units: 100, rowNumber: 2 }],
    unmappedNames: [{ productName: "Mystery Item", units: 12, rowNumber: 5 }],
    regionShare: [{ productCode: "P-A", regionCode: "CA", units: 60 }],
    brickShare: [{ productCode: "P-A", brickId: "B-1", areaCode: "A1", regionCode: "CA", units: 40 }],
    references,
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.parsedRows.length, 0);
  assert.equal(blocked.issues.length, 1);
  assert.equal(blocked.issues[0].value, "Mystery Item");
  assert.ok(blocked.blockingReasons[0].includes("not mapped"));
}
