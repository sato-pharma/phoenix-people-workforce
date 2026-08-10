import assert from "node:assert/strict";

import { buildOfficeAreaWeights, computeOfficeAllocation } from "../src/lib/sales/office-allocation.ts";
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

// A1 sells 40 units of the cheap product (10) -> value 400.
// A2 sells 40 of the cheap product AND 10 of the expensive one (50) -> value 900.
// Total 1300, so the shares are 400/1300 and 900/1300.
// The UNIT shares would be 40/90 and 50/90 — deliberately different, so a units-weighted
// regression cannot pass this test.
const brickShare = [
  { productCode: "P-A", brickId: "B-1", areaCode: "A1", regionCode: "CA", units: 40 },
  { productCode: "P-A", brickId: "B-2", areaCode: "A2", regionCode: "AB", units: 40 },
  { productCode: "P-B", brickId: "B-2", areaCode: "A2", regionCode: "AB", units: 10 },
];
const regionShare = [
  { productCode: "P-A", regionCode: "CA", units: 60 },
  { productCode: "P-A", regionCode: "AB", units: 40 },
  { productCode: "P-B", regionCode: "CA", units: 50 },
];

const near = (actual: number | undefined, expected: number, what: string) =>
  assert.ok(
    typeof actual === "number" && Math.abs(actual - expected) < 0.01,
    `${what}: expected ~${expected}, got ${actual}`,
  );

export function runOfficeAllocationTests() {
  // ── the weights themselves: VALUE, not units ────────────────────────────────
  const weights = buildOfficeAreaWeights(brickShare, (code) =>
    references.products.find((p) => p.productCode === code)?.factoryPrice ?? 0);

  assert.equal(weights.totalValue, 1300);
  near(weights.areaShare.get("A1"), 400 / 1300, "A1 share is its share of VALUE");
  near(weights.areaShare.get("A2"), 900 / 1300, "A2 share is its share of VALUE");
  // If this is ever weighted by units again, A1 becomes 40/90 = 0.444 and this fires.
  assert.ok(
    Math.abs((weights.areaShare.get("A1") ?? 0) - 40 / 90) > 0.1,
    "area share must be the VALUE share, not the units share",
  );

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
    regionShare,
    brickShare,
    references,
  });

  assert.equal(result.status, "validated");
  assert.equal(result.distributor.code, "Office");

  // Nothing is created or lost: 100 + 50 + 30 = 180. Value 1000 + 2500 + 150 = 3650.
  assert.equal(result.totals.totalQty, 180);
  near(result.totals.totalValue, 3650, "total value");

  // ── the owner's rule: ONE blended share applied to EVERY product ────────────
  // Every product splits 400/1300 : 900/1300, regardless of where that product itself sold.
  const b1 = result.byBrick.find((row) => row.brickId === "B-1");
  const b2 = result.byBrick.find((row) => row.brickId === "B-2");
  near(b1?.totalQty, 180 * (400 / 1300), "B-1 gets the blended area share of ALL products");
  near(b2?.totalQty, 180 * (900 / 1300), "B-2 gets the blended area share of ALL products");

  // The consequence the owner accepted: P-C sold NOWHERE this period and is still placed, because
  // the share is blended across products instead of computed per product. Under the old
  // per-product rule its 30 units fell to NATIONAL.
  const national = result.byRegion.find((row) => row.regionCode === "NATIONAL");
  assert.equal(national, undefined, "nothing falls to NATIONAL while an area carries value");
  const pc = result.byProduct.find((row) => row.productCode === "P-C");
  assert.equal(pc?.totalQty, 30, "a product that sold nowhere is still fully placed");

  // Conservation, per product, after rounding.
  assert.equal(result.byProduct.find((row) => row.productCode === "P-A")?.totalQty, 100);
  assert.equal(result.byProduct.find((row) => row.productCode === "P-B")?.totalQty, 50);

  // ── NATIONAL is reached only when there is no non-Office geography at all ───
  const nothingSold = computeOfficeAllocation({
    period: "2026-05",
    distributor: { code: "Office", name: "Office" },
    fileName: "office 5.xlsx",
    sheetName: "Sheet1",
    mapped: [{ productCode: "P-A", productName: "Product A", units: 100, rowNumber: 2 }],
    unmappedNames: [],
    regionShare: [],
    brickShare: [],
    references,
  });
  assert.equal(nothingSold.status, "validated");
  assert.equal(nothingSold.byRegion.find((row) => row.regionCode === "NATIONAL")?.totalQty, 100);
  assert.ok(nothingSold.advisories?.some((a) => a.includes("National bucket")));

  // ── BLOCKED path is unchanged: one unmapped name blocks the batch ───────────
  const blocked = computeOfficeAllocation({
    period: "2026-05",
    distributor: { code: "Office", name: "Office" },
    fileName: "office 5.xlsx",
    sheetName: "Sheet1",
    mapped: [{ productCode: "P-A", productName: "Product A", units: 100, rowNumber: 2 }],
    unmappedNames: [{ productName: "Mystery Item", units: 12, rowNumber: 5 }],
    regionShare,
    brickShare,
    references,
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.parsedRows.length, 0);
  assert.equal(blocked.issues.length, 1);
  assert.equal(blocked.issues[0].value, "Mystery Item");
  assert.ok(blocked.blockingReasons[0].includes("not mapped"));
}
