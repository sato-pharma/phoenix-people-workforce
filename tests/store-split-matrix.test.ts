import assert from "node:assert/strict";

import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";
import { areaProductKey } from "../src/lib/sales/store-sales-city-split.ts";
import { applyStoreSplitToMatrix, matrixSalesValue } from "../src/lib/sales/store-split-matrix.ts";

function cell(salesUnits: number, salesValue: number, targetValue: number | null = null): MonthlyClosingCell {
  return {
    achievement: targetValue === null || targetValue === 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits: targetValue === null ? null : targetValue / 100,
    targetValue,
  };
}

function areaRow(areaCode: string, areaName: string, cells: MonthlyClosingCell[], isDirect = false) {
  return {
    areaCode,
    areaName,
    cells,
    ...(isDirect ? { isDirect: true } : {}),
    kind: "area" as const,
    regionCode: "D1",
    regionName: "Delta (1)",
    rowTotal: cell(
      cells.reduce((sum, c) => sum + c.salesUnits, 0),
      cells.reduce((sum, c) => sum + c.salesValue, 0),
    ),
  };
}

function buildMatrix(): MonthlyClosingMatrix {
  // Two Menoufia areas on one product, plus an in-region Direct row that must never move.
  const areas = [
    areaRow("D12", "Menoufia 1", [cell(100, 30_000, 40_000)]),
    areaRow("D13", "Menoufia 2", [cell(40, 12_000, 20_000)]),
    areaRow("DIRECT", "Direct", [cell(7, 5_000, null)], true),
  ];
  const subtotalCells = [cell(147, 47_000, 60_000)];
  return {
    availableLines: ["Pedia"],
    availablePeriods: ["2026-06"],
    columns: [{ family: "Milk", productCode: "LA001", productName: "Lacto Advanced 1" }],
    grandTotal: { cells: [cell(147, 47_000, 60_000)], kind: "grandTotal", rowTotal: cell(147, 47_000, 60_000) },
    line: "Pedia",
    period: "2026-06",
    regions: [{
      areas,
      regionCode: "D1",
      regionName: "Delta (1)",
      subtotal: {
        cells: subtotalCells,
        kind: "regionSubtotal",
        regionCode: "D1",
        regionName: "Delta (1)",
        rowTotal: cell(147, 47_000, 60_000),
      },
    }],
  } as unknown as MonthlyClosingMatrix;
}

export function runStoreSplitMatrixTests() {
  const before = buildMatrix();

  // Nothing to move: the matrix comes back as the very same object, untouched.
  const empty = applyStoreSplitToMatrix(before, new Map());
  assert.equal(empty.matrix, before, "an empty split returns the identical matrix");
  assert.deepEqual(empty.applied, { qty: 0, value: 0 }, "and reports that it moved nothing");

  // Menoufia 1 sends 9,000 to Menoufia 2 — the shape of a real even split between two areas.
  const net = new Map([
    [areaProductKey("D12", "LA001"), { qty: -30, value: -9_000 }],
    [areaProductKey("D13", "LA001"), { qty: 30, value: 9_000 }],
  ]);
  const { applied, matrix: after } = applyStoreSplitToMatrix(before, net);
  assert.deepEqual(applied, { qty: 0, value: 0 }, "both ends of the move are in the matrix, so nothing crossed its edge");
  const areaOf = (matrix: MonthlyClosingMatrix, code: string) =>
    matrix.regions[0]?.areas.find((area) => area.areaCode === code);

  const d12 = areaOf(after, "D12");
  const d13 = areaOf(after, "D13");
  assert.equal(d12?.cells[0]?.salesValue, 21_000, "Menoufia 1 gives up 9,000");
  assert.equal(d13?.cells[0]?.salesValue, 21_000, "Menoufia 2 receives 9,000");
  assert.equal(d12?.cells[0]?.salesUnits, 70);
  assert.equal(d13?.cells[0]?.salesUnits, 70);

  // THE headline of this change: targets are NEVER touched.
  assert.equal(d12?.cells[0]?.targetValue, 40_000, "Menoufia 1's target is untouched by the split");
  assert.equal(d13?.cells[0]?.targetValue, 20_000, "Menoufia 2's target is untouched by the split");
  assert.equal(d12?.cells[0]?.targetUnits, 400, "target units are untouched too");
  assert.equal(
    after.regions[0]?.subtotal.cells[0]?.targetValue,
    60_000,
    "the region's target is untouched — the split moves sales between areas, never the ask",
  );

  // Achievement re-derives from the NEW sales over the SAME target.
  assert.equal(d12?.cells[0]?.achievement, 21_000 / 40_000, "Menoufia 1 achievement falls with its sales");
  assert.equal(d13?.cells[0]?.achievement, 21_000 / 20_000, "Menoufia 2 achievement rises with its sales");
  assert.notEqual(d12?.cells[0]?.achievement, before.regions[0]?.areas[0]?.cells[0]?.achievement);

  // Row totals follow their cells.
  assert.equal(d12?.rowTotal.salesValue, 21_000);
  assert.equal(d13?.rowTotal.salesValue, 21_000);

  // The Direct row never participates — it carries no area.
  const direct = areaOf(after, "DIRECT");
  assert.equal(direct?.cells[0]?.salesValue, 5_000, "the in-region Direct row is untouched");
  assert.equal(direct, before.regions[0]?.areas[2], "the Direct row is passed through as the same object");

  // The grand total CANNOT move: a store's sale is redistributed inside one city and one product.
  assert.equal(
    after.grandTotal.cells[0]?.salesValue,
    before.grandTotal.cells[0]?.salesValue,
    "the national headline is unchanged — this is what keeps the Total sheet's tie intact",
  );
  assert.equal(after.grandTotal.cells[0]?.targetValue, 60_000, "the national target is unchanged");
  assert.equal(
    matrixSalesValue(after),
    matrixSalesValue(before),
    "total sales across every area cell are preserved exactly",
  );

  // The region subtotal moved by the net of its areas, which here is zero.
  assert.equal(after.regions[0]?.subtotal.cells[0]?.salesValue, 47_000, "both areas are in one region, so its subtotal holds");

  // A one-sided net (a city spanning two regions) must still land on the right region subtotal.
  const oneSidedResult = applyStoreSplitToMatrix(before, new Map([[areaProductKey("D13", "LA001"), { qty: 5, value: 1_000 }]]));
  const oneSided = oneSidedResult.matrix;
  assert.equal(areaOf(oneSided, "D13")?.cells[0]?.salesValue, 13_000);
  assert.equal(oneSided.regions[0]?.subtotal.cells[0]?.salesValue, 48_000, "the region subtotal absorbs a one-sided move");
  assert.equal(oneSided.grandTotal.cells[0]?.salesValue, 48_000, "and so does the grand total");
  assert.equal(oneSided.regions[0]?.subtotal.cells[0]?.targetValue, 60_000, "targets still untouched on a one-sided move");
  assert.deepEqual(
    oneSidedResult.applied,
    { qty: 5, value: 1_000 },
    "a one-sided move is reported, so the workbook can say where the other end of it went",
  );

  // An area the split never touches is returned as the identical object, not a copy.
  const untouched = applyStoreSplitToMatrix(before, new Map([[areaProductKey("D13", "LA001"), { qty: 1, value: 1 }]])).matrix;
  assert.equal(areaOf(untouched, "D12"), before.regions[0]?.areas[0], "an untouched area is passed through unchanged");

  // A delta for an area that is NOT in this matrix (the filtered-export case) has nowhere to land.
  // It must be REPORTED, not silently dropped — that report is what keeps the Total sheet tying.
  const offMatrix = applyStoreSplitToMatrix(
    before,
    new Map([
      [areaProductKey("D12", "LA001"), { qty: -20, value: -6_000 }],
      [areaProductKey("D14", "LA001"), { qty: 20, value: 6_000 }], // Gharbia — not in this matrix
    ]),
  );
  assert.equal(matrixSalesValue(offMatrix.matrix), matrixSalesValue(before) - 6_000, "only the origin's side lands");
  assert.deepEqual(
    offMatrix.applied,
    { qty: -20, value: -6_000 },
    "the amount that left the matrix is reported exactly, so nothing goes missing unexplained",
  );

  // ── A REAL area that absorbed direct money still takes its city split ───────────────────────
  // `isDirect` marks two different things on an area row: the synthetic "Direct orders (company)"
  // pseudo-area, and — in July 2026 — a real area that absorbed hand-mapped direct money and is
  // still Menoufia. Skipping the second broke the invariant this whole module rests on: a
  // redistribution that nets to zero changed the grand total, because only one side of each move
  // landed. Anti Infective 2026-07 came out 22,336.87 EGP short on the master that way, while the
  // Retail tab and the Store Split sheet both showed the move.
  const julyLike = buildMatrix();
  const absorbed = julyLike.regions[0]?.areas[1] as { isDirect?: boolean };
  absorbed.isDirect = true; // D13 "Menoufia 2" — a REAL area, flagged only because it took direct

  const zeroSum = new Map([
    [areaProductKey("D12", "LA001"), { qty: -30, value: -9_000 }],
    [areaProductKey("D13", "LA001"), { qty: 30, value: 9_000 }],
  ]);
  const withAbsorbed = applyStoreSplitToMatrix(julyLike, zeroSum);
  assert.equal(
    matrixSalesValue(withAbsorbed.matrix),
    matrixSalesValue(julyLike),
    "a net-zero redistribution cannot change the grand total, even when the receiving area carries direct",
  );
  assert.deepEqual(
    withAbsorbed.applied,
    { qty: 0, value: 0 },
    "both sides of the move landed inside the matrix, so nothing is reported as escaping it",
  );
  assert.equal(
    areaOf(withAbsorbed.matrix, "D13")?.rowTotal.salesValue,
    12_000 + 9_000,
    "the direct-absorbing area receives its share — it is Menoufia, not the synthetic Direct row",
  );
  assert.equal(
    areaOf(withAbsorbed.matrix, "DIRECT")?.rowTotal.salesValue,
    5_000,
    "…while the synthetic Direct row, identified by its areaCode, is still never moved",
  );
}
