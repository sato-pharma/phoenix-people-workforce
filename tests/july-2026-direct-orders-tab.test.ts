import assert from "node:assert/strict";

import {
  JULY_2026_DIRECT_PERIOD,
  JULY_2026_DIRECT_ROWS,
} from "../src/lib/sales/july-2026-direct-orders.ts";

// July 2026 is the ONE month whose direct orders were mapped to areas by hand: the Direct Order
// module went live in August, so July's rows reached Source of Sales with a region but a blank
// area. The owner had them mapped once and asked for the result as its own tab.
//
// What these tests protect is the pair of properties that make that snapshot trustworthy:
//
//   1. It still adds up to the month that was actually reported. 628,267.65 EGP over 4,271 units
//      is the figure sitting in production (source_of_sales_fact_rollup, period 2026-07,
//      distributor 'Direct') and printed on the owner's signed-off workbook. If an edit ever
//      changes a line, the total moves and this test fails — which is the point, because the
//      month is closed and its numbers can no longer legitimately move.
//
//   2. Value is NEVER units x factory price. Direct deals carry negotiated bonus/discount
//      pricing, so value deliberately does not equal qty x price. Recomputing July at factory
//      price would have inflated it by 31,837.35 EGP (628,267.65 -> 660,105.00). The dataset must
//      keep carrying its own submitted value, so we pin rows where the two genuinely disagree.

const TOTAL_VALUE = 628267.65;
const TOTAL_UNITS = 4271;

/** El Otefy is one chain the owner ruled is shared evenly by three reps. */
const EL_OTEFY_SHEET_ROWS = [9, 10, 11];
const EL_OTEFY_AREAS = ["GZ1", "GZ4", "GZ7"];
const EL_OTEFY_PER_AREA = 59171.25;

export function runJuly2026DirectOrdersTabTests() {
  // ── the guard that keeps this a one-off ────────────────────────────────────
  assert.equal(
    JULY_2026_DIRECT_PERIOD,
    "2026-07",
    "the period guard is the only thing stopping this hand-mapped snapshot from appearing in another month",
  );

  // ── the month still reconciles ─────────────────────────────────────────────
  const totalValue = Math.round(JULY_2026_DIRECT_ROWS.reduce((sum, r) => sum + r.value, 0) * 100) / 100;
  const totalUnits = JULY_2026_DIRECT_ROWS.reduce((sum, r) => sum + r.qty, 0);
  assert.equal(
    totalValue,
    TOTAL_VALUE,
    "July direct value must still equal the 628,267.65 sitting in production for period 2026-07",
  );
  assert.equal(
    totalUnits,
    TOTAL_UNITS,
    "July direct units must still equal the 4,271 reported for the month",
  );

  // ── value is carried, never derived ────────────────────────────────────────
  // At least one row must disagree with qty x any single price, proving the dataset is not a
  // recomputation. (Rows 2 and 4 are the clearest: same product/qty/bonus as rows 26-31 but a
  // different negotiated value — the owner confirmed direct pricing is per-deal.)
  const row2 = JULY_2026_DIRECT_ROWS.find((r) => r.sheetRow === 2);
  const row26 = JULY_2026_DIRECT_ROWS.find((r) => r.sheetRow === 26);
  assert.ok(row2 && row26, "sheet rows 2 and 26 must both be present");
  assert.equal(row2.product, row26.product, "rows 2 and 26 are the same product");
  assert.equal(row2.qty, row26.qty, "rows 2 and 26 are the same quantity");
  assert.notEqual(
    row2.value,
    row26.value,
    "identical product+qty with DIFFERENT values is the proof that direct value is per-deal and must never be recomputed",
  );

  // ── El Otefy: one chain, split evenly three ways ───────────────────────────
  const elOtefy = JULY_2026_DIRECT_ROWS.filter((r) => EL_OTEFY_SHEET_ROWS.includes(r.sheetRow));
  assert.equal(
    elOtefy.length,
    9,
    "El Otefy's 3 sheet rows expand to 9 lines — three products across three sharing reps",
  );
  for (const areaCode of EL_OTEFY_AREAS) {
    const share = Math.round(
      elOtefy.filter((r) => r.areaCode === areaCode).reduce((sum, r) => sum + r.value, 0) * 100,
    ) / 100;
    assert.equal(
      share,
      EL_OTEFY_PER_AREA,
      `El Otefy area ${areaCode} must carry exactly one third (${EL_OTEFY_PER_AREA}) — the owner ruled an even split`,
    );
  }
  const elOtefyUnits = elOtefy.reduce((sum, r) => sum + r.qty, 0);
  assert.equal(
    elOtefyUnits,
    804,
    "splitting El Otefy three ways must neither create nor lose a unit (100 + 512 + 192)",
  );

  // ── the National Sales Manager's rows stay unattributed ────────────────────
  const areaLess = JULY_2026_DIRECT_ROWS.filter((r) => !r.areaCode);
  assert.equal(
    areaLess.length,
    3,
    "exactly the three National Sales Manager direct orders carry no area",
  );
  assert.equal(
    Math.round(areaLess.reduce((sum, r) => sum + r.value, 0) * 100) / 100,
    13732,
    "the unattributed direct total is 13,732.00 — counted in the month total but credited to no area",
  );
  for (const row of areaLess) {
    assert.equal(
      row.repName,
      "",
      "an area-less row must name no medical rep — the owner ruled these are not distributed",
    );
  }

  // ── every attributed row is internally consistent ──────────────────────────
  for (const row of JULY_2026_DIRECT_ROWS) {
    assert.ok(row.qty > 0, `sheet row ${row.sheetRow} must carry a positive quantity`);
    assert.ok(row.value > 0, `sheet row ${row.sheetRow} must carry a positive value`);
    assert.ok(
      row.line === "Pedia" || row.line === "Anti Infective",
      `sheet row ${row.sheetRow} must belong to a real line, got ${row.line}`,
    );
    if (row.areaCode) {
      assert.ok(
        row.repName.length > 0,
        `sheet row ${row.sheetRow} has area ${row.areaCode} so it must name the rep who covers it`,
      );
      assert.ok(
        row.repHrId.length > 0,
        `sheet row ${row.sheetRow} must carry the rep's HR_ID so the credit is traceable to a person`,
      );
    }
  }
}
