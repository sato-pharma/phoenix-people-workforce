import assert from "node:assert/strict";

import { computeOfficeAllocation } from "@/lib/sales/office-allocation";
import type { SalesReferenceData } from "@/lib/sales/monthly-distributor-import";

// AN OFFICE RETURN MUST REDUCE OFFICE.
//
// `allocateProduct` began `if (!(units > 0)) return [];`, and the area loop skipped any slice that
// was not > 0. Together they discarded every negative, so an Office credit never reduced Office and
// the un-returned units stayed spread across real bricks and real reps' achievement.
//
// The tell was in production: Office was the ONLY channel with zero negative rows since 2026-05,
// against 380 for PS, 158 RM, 64 IS and eight others. That absence was the guard, not the business.
//
// Owner approved the locked-region change 2026-09-05 and re-pinned the rule himself.
//
// The behaviour fingerprint over the adversarial probe was IDENTICAL before and after
// (7603b7a278f5a482), because every edit is a no-op for positive units — only a case that
// previously produced nothing now produces something. These tests cover that new case.

const references: SalesReferenceData = {
  distributors: [{ code: "Office", name: "Office" }],
  products: [
    { factoryPrice: 10, family: "CNS", familyCode: "CNS", line: "CNS", productCode: "P1", productName: "Product One", source: "" },
  ],
  regions: [],
  areas: [],
  bricks: [
    { brickId: "BR-A", brickName: "Brick A", areaCode: "V1", areaName: "Area 1", regionCode: "R1", regionName: "Region 1", blockCode: "", blockName: "" },
    { brickId: "BR-B", brickName: "Brick B", areaCode: "V2", areaName: "Area 2", regionCode: "R1", regionName: "Region 1", blockCode: "", blockName: "" },
  ],
} as unknown as SalesReferenceData;

// Two areas, 75/25 by value, so a split is visible and checkable by hand.
const brickShare = [
  { productCode: "P1", brickId: "BR-A", areaCode: "V1", regionCode: "R1", units: 750 },
  { productCode: "P1", brickId: "BR-B", areaCode: "V2", regionCode: "R1", units: 250 },
];

function allocate(units: number) {
  return computeOfficeAllocation({
    period: "2026-07",
    distributor: { code: "Office", name: "Office" },
    fileName: "probe.xlsx",
    sheetName: "Sheet1",
    mapped: [{ productCode: "P1", productName: "Product One", units, rowNumber: 1 }],
    unmappedNames: [],
    regionShare: [],
    brickShare,
    references,
  });
}

function sumUnits(rows: Array<{ qty: number }>) {
  return Math.round(rows.reduce((acc, r) => acc + r.qty, 0) * 1e6) / 1e6;
}

function testANegativeProductIsAllocated() {
  const result = allocate(-100);

  assert.ok(result.parsedRows.length > 0, "a return must produce allocation rows — it used to produce none");
  assert.equal(sumUnits(result.parsedRows), -100, "the whole return must be allocated, not partly absorbed");
  assert.ok(
    result.parsedRows.every((r) => r.qty < 0),
    "every slice of a return must be negative — a return cannot add units to any brick",
  );
}

function testAReturnSplitsOnTheSameSharesAsASale() {
  // The golden rule is about WHERE units land. A return must land the same way a sale does, only
  // with the opposite sign — otherwise a sale and its own credit would not cancel.
  const sale = allocate(100);
  const credit = allocate(-100);

  const byBrick = (rows: typeof sale.parsedRows) =>
    new Map(rows.map((r) => [r.brickId || "NATIONAL", Math.round(r.qty * 1e6) / 1e6]));

  const s = byBrick(sale.parsedRows);
  const c = byBrick(credit.parsedRows);

  assert.deepEqual([...c.keys()].sort(), [...s.keys()].sort(), "a credit must touch exactly the bricks a sale touches");
  for (const [brick, units] of s) {
    assert.equal(c.get(brick), -units, `brick ${brick}: the credit must be the exact negative of the sale`);
  }
}

function testValueFollowsTheSign() {
  const credit = allocate(-100);
  const totalValue = Math.round(credit.parsedRows.reduce((acc, r) => acc + r.value, 0) * 1e6) / 1e6;
  assert.equal(totalValue, -1000, "value must be units × factory price, so a return reduces value too");
}

function testZeroAndNonFiniteStillAllocateNothing() {
  // These always meant "nothing", and must keep meaning it. Widening the guard to accept negatives
  // must not accidentally let a zero or a NaN through into the rollup.
  assert.equal(allocate(0).parsedRows.length, 0, "zero units must still allocate nothing");
  assert.equal(allocate(Number.NaN).parsedRows.length, 0, "a non-finite unit count must still allocate nothing");
}

export function runOfficeNegativeUnitsAreReturnsTests() {
  testANegativeProductIsAllocated();
  testAReturnSplitsOnTheSameSharesAsASale();
  testValueFollowsTheSign();
  testZeroAndNonFiniteStillAllocateNothing();
}
