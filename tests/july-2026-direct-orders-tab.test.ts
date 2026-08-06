import assert from "node:assert/strict";

import {
  JULY_2026_DIRECT_PERIOD,
  JULY_2026_DIRECT_ROWS,
} from "../src/lib/sales/july-2026-direct-orders.ts";
import { selectJulyDirectRowsForScope } from "../src/lib/sales/monthly-closing-export.ts";

// July 2026 is the ONE month whose direct orders were mapped to areas by hand: the Direct Order
// module went live in August, so July's rows reached Source of Sales with a region but a blank
// area. The owner had them mapped once and asked for the result as its own tab.
//
// What these tests protect is the pair of properties that make that snapshot trustworthy:
//
//   1. It still adds up to the month that was actually reported. 684,002.15 EGP over 5,241 units
//      is the figure sitting in production (source_of_sales_fact_rollup, period 2026-07,
//      distributor 'Direct') and printed on the owner's signed-off workbook. If an edit ever
//      changes a line, the total moves and this test fails — which is the point, because the
//      month is closed and its numbers can no longer legitimately move.
//
//      That total was 628,267.65 over 4,271 units until 2026-08-06, when the owner restated
//      Anti-Infective from his own sheets: the line's 14 region-only rows became 16 area rows,
//      1,150 units / 93,554.00 -> 2,120 units / 149,288.50. Pedia did not move. The production
//      rows were replaced in the same operation, and that is the rule a restatement must follow —
//      this file and source_of_sales_fact_rollup move together or the closing stops trusting
//      either, because the merge is gated on the two agreeing to the piastre.
//
//   2. Value is NEVER units x factory price. Direct deals carry negotiated bonus/discount
//      pricing, so value deliberately does not equal qty x price. Recomputing July at factory
//      price would have inflated it by 31,837.35 EGP (628,267.65 -> 660,105.00). The dataset must
//      keep carrying its own submitted value, so we pin rows where the two genuinely disagree.

const TOTAL_VALUE = 684002.15;
const TOTAL_UNITS = 5241;

/** The owner's 2026-08-06 Anti-Infective restatement, as it now stands in production. */
const ANTI_INFECTIVE_VALUE = 149288.5;
const ANTI_INFECTIVE_UNITS = 2120;
const ANTI_INFECTIVE_ROWS = 16;
/** Pedia was not part of that restatement and must still carry exactly what it always did. */
const PEDIA_VALUE = 534713.65;
const PEDIA_UNITS = 3121;

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
    "July direct value must still equal the 684,002.15 sitting in production for period 2026-07",
  );
  assert.equal(
    totalUnits,
    TOTAL_UNITS,
    "July direct units must still equal the 5,241 reported for the month",
  );

  // ── the 2026-08-06 Anti-Infective restatement ──────────────────────────────
  // The month total alone cannot catch a restatement that moves money BETWEEN the two lines, so
  // each line is pinned on its own. Anti-Infective is the line the owner restated; Pedia is the
  // control that proves the restatement stayed inside its own line.
  const byLine = (name: string) => JULY_2026_DIRECT_ROWS.filter((r) => r.line === name);
  const sumValue = (rows: readonly { value: number }[]) =>
    Math.round(rows.reduce((sum, r) => sum + r.value, 0) * 100) / 100;
  const sumUnits = (rows: readonly { qty: number }[]) => rows.reduce((sum, r) => sum + r.qty, 0);

  const antiInfective = byLine("Anti Infective");
  assert.equal(
    antiInfective.length,
    ANTI_INFECTIVE_ROWS,
    "the owner's restatement is 16 area rows — the 14 region-only rows it replaced must be gone",
  );
  assert.equal(
    sumValue(antiInfective),
    ANTI_INFECTIVE_VALUE,
    "Anti-Infective direct must equal the restated 149,288.50 — the same figure written to source_of_sales_fact_rollup",
  );
  assert.equal(
    sumUnits(antiInfective),
    ANTI_INFECTIVE_UNITS,
    "Anti-Infective direct must equal the restated 2,120 units",
  );
  assert.ok(
    antiInfective.every((r) => r.areaCode !== ""),
    "the whole point of the restatement is that every Anti-Infective row now names an area",
  );

  const pedia = byLine("Pedia");
  assert.equal(
    sumValue(pedia),
    PEDIA_VALUE,
    "Pedia was not restated and must still carry 534,713.65 — if this moved, the edit crossed lines",
  );
  assert.equal(sumUnits(pedia), PEDIA_UNITS, "Pedia was not restated and must still carry 3,121 units");

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

  runJulyDirectScopeTests();
}

// ── the tab must FOLLOW the on-screen filter ─────────────────────────────────
// This shipped wrong once: the tab scoped by LINE only, so an export filtered to Giza still
// listed Mahalla, Qena, Dakahlia and Sohag. The owner found it in a real export. What makes the
// fix hold is that the tab reads its scope from the ALREADY-FILTERED matrix it is handed, so it
// cannot list an area the Closing Matrix dropped.
function fakeMatrix(regions: { regionCode: string; areaCodes: string[] }[], line: string | null) {
  return {
    line,
    regions: regions.map((region) => ({
      areas: region.areaCodes.map((areaCode) => ({ areaCode })),
      regionCode: region.regionCode,
    })),
  } as unknown as Parameters<typeof selectJulyDirectRowsForScope>[0];
}

function runJulyDirectScopeTests() {
  const total = (rows: readonly { value: number }[]) =>
    Math.round(rows.reduce((sum, row) => sum + row.value, 0) * 100) / 100;

  // Giza only — the exact slice the owner exported when he found the bug.
  const giza = selectJulyDirectRowsForScope(
    fakeMatrix([{ areaCodes: ["GZ1", "GZ2", "GZ3", "GZ4", "GZ5", "GZ6", "GZ7", "UE9"], regionCode: "GZ" }], "Pedia"),
  );
  assert.equal(total(giza), 203913.75, "a Giza-filtered export must show exactly Giza's direct sales");
  assert.ok(
    giza.every((row) => row.regionCode === "GZ"),
    "a Giza-filtered export must not list a single row from another region — this is the bug that shipped",
  );
  assert.ok(
    giza.every((row) => row.areaCode !== ""),
    "the National Sales Manager's area-less rows belong to Others and must NOT appear under a Giza filter",
  );

  // Others only — where the National Sales Manager's own orders DO belong.
  const others = selectJulyDirectRowsForScope(
    fakeMatrix([{ areaCodes: [], regionCode: "OT" }], "Pedia"),
  );
  assert.equal(total(others), 13732, "an Others-filtered export must show exactly the 13,732.00 booked to Others");
  assert.ok(
    others.every((row) => row.areaCode === ""),
    "Others carries only the unattributed rows — no area-bearing row belongs there",
  );

  // Unfiltered — every region present, so the whole month must survive.
  const all = selectJulyDirectRowsForScope(
    fakeMatrix(
      [
        { areaCodes: ["CA3", "CA4", "CA6"], regionCode: "CA" },
        { areaCodes: ["GZ1", "GZ2", "GZ3", "GZ4", "GZ5", "GZ6", "GZ7", "UE9"], regionCode: "GZ" },
        { areaCodes: ["D11", "D12", "D13", "D14", "D15", "D16", "D17"], regionCode: "D1" },
        { areaCodes: ["D21", "D22", "D23", "D24", "D25", "D26"], regionCode: "D2" },
        { areaCodes: ["UE1", "UE2", "UE3", "UE4", "UE5", "UE6", "UE7", "UE8"], regionCode: "UE" },
        // Alex-BHR entered this dataset with the 2026-08-06 restatement — Behira 2 is the only
        // area it contributes, and leaving the region out would silently drop 9,200.00.
        { areaCodes: ["AB1", "AB2", "AB3", "AB4", "AB5"], regionCode: "AB" },
        { areaCodes: [], regionCode: "OT" },
      ],
      null,
    ),
  );
  assert.equal(total(all), 684002.15, "an unfiltered export must still carry the whole month, both lines");

  // Delta (2) arrived with the restatement too: before it, no July direct row sat in D2 at all.
  const delta2 = selectJulyDirectRowsForScope(
    fakeMatrix([{ areaCodes: ["D21", "D22", "D23", "D24", "D25", "D26"], regionCode: "D2" }], "Anti Infective"),
  );
  assert.equal(
    total(delta2),
    56696,
    "Delta (2) carries exactly the restated Dakahlia and Port Said direct — 56,696.00 across six rows",
  );
  assert.ok(
    delta2.every((row) => row.regionCode === "D2"),
    "a Delta (2) filtered export must not leak a row from another region",
  );
}
