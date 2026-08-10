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
//   1. It still adds up to the month that was actually reported. 1,201,548.15 EGP over 8,240 units
//      is the figure sitting in production (source_of_sales_fact_rollup, period 2026-07,
//      distributor 'Direct') and printed on the owner's signed-off workbook. If an edit ever
//      changes a line, the total moves and this test fails — which is the point, because the
//      month is closed and its numbers can no longer legitimately move.
//
//      That total was 628,267.65 over 4,271 units until 2026-08-06, when the owner restated
//      Anti-Infective from his own sheets: the line's 14 region-only rows became 16 area rows,
//      1,150 units / 93,554.00 -> 2,120 units / 149,288.50. Pedia was then RESTATED on 2026-08-07
//      from the owner's 33-row area × product hand sheet: the previous 38 anonymous-region-only /
//      3,121 units / 534,713.65 EGP Pedia rows (sheetRow 2-70) were replaced with 33 area-mapped
//      rows (sheetRow 201-233), 5,120 units / 1,038,259.65 EGP. D16 Kafr El-Sheikh 1 carries the
//      Pedia organogram override: region=AB per the hand sheet, not the canonical crosswalk D1.
//      The owner then booked further 500-unit Ivyronc direct sales at 14 EGP/unit: to
//      October-Zayed on 2026-08-09 (sheetRow 234) and to Alex Center on 2026-08-10 (sheetRow 235),
//      7,000.00 EGP each. On 2026-08-10 he added a further 500 at 14 EGP to October-Zayed, which
//      RAISED sheetRow 234 in place to 1,000 units / 14,000.00 EGP rather than adding a row —
//      Pedia is now 35 rows / 6,620 units / 1,059,259.65 EGP. Each production row landed in the
//      same operation, so this file and source_of_sales_fact_rollup still agree to the piastre.
//      The production rows were replaced in the same operation, and that is the rule a restatement
//      must follow — this file and source_of_sales_fact_rollup move together or the closing stops
//      trusting either, because the merge is gated on the two agreeing to the piastre.
//
//   2. Value is NEVER units x factory price. Direct deals carry negotiated bonus/discount
//      pricing, so value deliberately does not equal qty x price. Recomputing July at factory
//      price would have inflated it by tens of thousands of EGP. The dataset must keep carrying
//      its own submitted value, so we pin rows where the two genuinely disagree.

const TOTAL_VALUE = 1208548.15;
const TOTAL_UNITS = 8740;

/** The owner's 2026-08-06 Anti-Infective restatement, as it now stands in production. */
const ANTI_INFECTIVE_VALUE = 149288.5;
const ANTI_INFECTIVE_UNITS = 2120;
const ANTI_INFECTIVE_ROWS = 16;
/**
 * Pedia was RESTATED on 2026-08-07 — 33 area rows / 5,120 units / EGP 1,038,259.65 — then
 * owner-instructed Ivyronc direct sales at 14 EGP were added on top:
 *   2026-08-09  October-Zayed  (sheetRow 234)  +500 units / +7,000.00 EGP  (new row)
 *   2026-08-10  Alex Center    (sheetRow 235)  +500 units / +7,000.00 EGP  (new row)
 *   2026-08-10  October-Zayed  (sheetRow 234)  +500 units / +7,000.00 EGP  (RAISED that row in
 *                                              place to 1,000 units / 14,000.00 EGP)
 * giving 35 rows / 6,620 units / EGP 1,059,259.65, matching source_of_sales_fact_rollup. The row
 * count stays 35 because the last addition grew an existing area×product row instead of adding one.
 *
 * These three numbers are not decoration. resolveJulyDirectByArea merges this overlay ONLY when its
 * total equals the database's to within 0.01 — otherwise it falls back to region-only and Pedia's
 * area detail disappears with no error. So the overlay, import_rows and fact_rollup have to be
 * changed in one operation, and this test is what catches it when they are not.
 */
const PEDIA_VALUE = 1059259.65;
const PEDIA_UNITS = 6620;
const PEDIA_ROWS = 35;

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
    "July direct value must still equal the 1,208,548.15 sitting in production for period 2026-07 (149,288.50 AI + 1,059,259.65 Pedia — restated 2026-08-07, +7,000.00 Ivyronc to October-Zayed 2026-08-09, +7,000.00 Ivyronc to Alex Center 2026-08-10, +7,000.00 more Ivyronc to October-Zayed 2026-08-10)",
  );
  assert.equal(
    totalUnits,
    TOTAL_UNITS,
    "July direct units must still equal the 8,740 reported for the month (2,120 AI + 6,620 Pedia — restated 2026-08-07, +500 Ivyronc to October-Zayed 2026-08-09, +500 Ivyronc to Alex Center 2026-08-10, +500 more Ivyronc to October-Zayed 2026-08-10)",
  );

  // ── the 2026-08-06 Anti-Infective restatement ──────────────────────────────
  // The month total alone cannot catch a restatement that moves money BETWEEN the two lines, so
  // each line is pinned on its own. Anti-Infective is the line the owner restated first; Pedia is
  // the 2026-08-07 second restatement.
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

  // ── the 2026-08-07 Pedia restatement ────────────────────────────────────────
  const pedia = byLine("Pedia");
  assert.equal(
    pedia.length,
    PEDIA_ROWS,
    `Pedia is exactly ${PEDIA_ROWS} area rows — the 2026-08-07 restatement (sheetRow 201-233) plus the two Ivyronc additions (sheetRow 234 October-Zayed, sheetRow 235 Alex Center)`,
  );
  assert.equal(
    sumValue(pedia),
    PEDIA_VALUE,
    "Pedia must now carry 1,059,259.65 — the 33 restated 2026-08-07 hand rows plus both Ivyronc rows, with October-Zayed's raised to 14,000.00, matching source_of_sales_fact_rollup",
  );
  assert.equal(sumUnits(pedia), PEDIA_UNITS, "Pedia must now carry 6,620 units (5,120 restated 2026-08-07 + 500 Ivyronc 2026-08-09 + 500 Ivyronc 2026-08-10 + 500 more to October-Zayed 2026-08-10)");

  // D16 organogram override (Kafr El-Sheikh 1) — region=AB per hand sheet, NOT canonical D1 crosswalk
  const d16 = pedia.find((r) => r.areaCode === "D16");
  assert.ok(d16, "D16 Kafr El-Sheikh 1 must be present in Pedia restatement");
  assert.equal(d16.regionCode, "AB", "D16 Pedia organogram override: region=AB per owner hand sheet, not canonical D1 crosswalk");
  assert.ok(
    d16.note.includes("region=AB (not crosswalk D1)"),
    "the D16 Pedia row must carry an explicit audit-trail note documenting the region override so the exception survives future reads",
  );

  // ── value is carried, never derived ────────────────────────────────────────
  // At least one row must disagree with qty x any single price, proving the dataset is not a
  // recomputation. Same LA001 (Lacto 1 Advance New Price) qty=144 appears in both D22 Dakahlia 2
  // and GZ1 Giza Centers, with values 35,640 vs 36,432 — the owner confirmed direct pricing is
  // per-deal.
  const la001_144 = pedia.filter((r) => r.productCode === "LA001" && r.qty === 144);
  assert.ok(
    la001_144.length >= 2,
    "the restated Pedia set must contain at least two LA001 rows with qty=144 for the per-deal pricing proof",
  );
  assert.equal(la001_144[0].product, la001_144[1].product, "the two proof rows are the same product");
  assert.equal(la001_144[0].qty, la001_144[1].qty, "the two proof rows are the same quantity");
  assert.notEqual(
    la001_144[0].value,
    la001_144[1].value,
    "identical product+qty with DIFFERENT values is the proof that direct value is per-deal and must never be recomputed",
  );

  // ── 2026-08-07 restatement: every Pedia row is area-attributed ─────────────
  // The old Pedia set carried 3 area-less National Sales Manager orders (sheetRow 21/22/24
  // = 13,732 EGP). Those were removed in the 2026-08-07 restatement; all 33 new Pedia rows name
  // a real area, so there are zero unattributed Pedia rows now.
  const areaLess = JULY_2026_DIRECT_ROWS.filter((r) => !r.areaCode);
  assert.equal(
    areaLess.length,
    0,
    "after the 2026-08-07 Pedia restatement, every remaining row names an area — the three old NSM area-less orders (sheetRow 21/22/24) were retired",
  );
  assert.equal(
    areaLess.reduce((sum, r) => sum + r.value, 0),
    0,
    "zero area-less rows ⇒ zero area-less value",
  );

  // ── every attributed row is internally consistent ──────────────────────────
  for (const row of JULY_2026_DIRECT_ROWS) {
    assert.ok(row.qty > 0, `sheet row ${row.sheetRow} must carry a positive quantity`);
    assert.ok(row.value > 0, `sheet row ${row.sheetRow} must carry a positive value`);
    assert.ok(
      row.line === "Pedia" || row.line === "Anti Infective",
      `sheet row ${row.sheetRow} must belong to a real line, got ${row.line}`,
    );
    if (row.areaCode) {
      if (row.line === "Anti Infective") {
        // The 2026-08-06 Anti-Infective restatement is 100% rep-assigned (16 named reps / HR IDs).
        assert.ok(
          row.repName.length > 0,
          `Anti-Infective sheet row ${row.sheetRow} has area ${row.areaCode} so it must name the rep who covers it`,
        );
        assert.ok(
          row.repHrId.length > 0,
          `Anti-Infective sheet row ${row.sheetRow} must carry the rep's HR_ID so the credit is traceable to a person`,
        );
      } else {
        // Pedia 2026-08-07 restatement is an area × product hand map. Rep is inherited from old rows
        // where the generator could find a single dominant rep for the area; otherwise both fields
        // are empty because the owner did not supply rep attribution at this level. The closing
        // aggregates by area anyway, so the tab still shows the right totals.
        if (row.repName.length > 0) {
          assert.ok(
            row.repHrId.length > 0,
            `Pedia sheet row ${row.sheetRow} names a rep so it must also carry the HR_ID so the credit is traceable`,
          );
        } else {
          assert.equal(
            row.repHrId,
            "",
            `Pedia sheet row ${row.sheetRow} has no rep name so it must also leave HR_ID blank — no partial identity allowed`,
          );
        }
      }
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
  assert.equal(total(giza), 293958.95, "a Giza-filtered export must show exactly Giza's direct sales after the 2026-08-07 Pedia restatement plus the GZ7 Ivyronc row, raised to 14,000.00 on 2026-08-10 (10 rows)");
  assert.ok(
    giza.every((row) => row.regionCode === "GZ"),
    "a Giza-filtered export must not list a single row from another region — this is the bug that shipped",
  );
  assert.ok(
    giza.every((row) => row.areaCode !== ""),
    "after the 2026-08-07 Pedia restatement every row carries an area — no NSM area-less rows remain under any area-bearing filter",
  );

  // Others / OT filter: after the 2026-08-07 restatement, Pedia's 3 area-less NSM orders
  // (sheetRow 21/22/24, 13,732 EGP) were retired. OT/Others therefore has zero rows for both
  // lines, and the explicit "no area-less rows" rule is what we now guard.
  const others = selectJulyDirectRowsForScope(
    fakeMatrix([{ areaCodes: [], regionCode: "OT" }], "Pedia"),
  );
  assert.equal(total(others), 0, "after the 2026-08-07 Pedia restatement, OT/Others has zero rows — the 3 old NSM area-less orders were retired");
  assert.equal(others.length, 0, "Others carries zero rows post restatement — no area-bearing row belongs there and no area-less rows remain");

  // Unfiltered — every region present, so the whole month must survive.
  const all = selectJulyDirectRowsForScope(
    fakeMatrix(
      [
        { areaCodes: ["CA3", "CA4", "CA6"], regionCode: "CA" },
        { areaCodes: ["GZ1", "GZ2", "GZ3", "GZ4", "GZ5", "GZ6", "GZ7", "UE9"], regionCode: "GZ" },
        { areaCodes: ["D11", "D12", "D13", "D14", "D15", "D17"], regionCode: "D1" },
        { areaCodes: ["D21", "D22", "D23", "D24", "D25", "D26"], regionCode: "D2" },
        { areaCodes: ["UE1", "UE2", "UE3", "UE4", "UE5", "UE6", "UE7", "UE8"], regionCode: "UE" },
        // Alex-BHR entered this dataset with the 2026-08-06 Anti-Infective restatement via AB5.
        // D16 Kafr El-Sheikh 1 joined AB via the 2026-08-07 Pedia organogram override
        // (region=AB per owner hand sheet, NOT the canonical crosswalk D1), so it must appear
        // under the AB area list or the unfiltered export silently drops 240 units / 42,900.00.
        { areaCodes: ["AB1", "AB2", "AB3", "AB4", "AB5", "D16"], regionCode: "AB" },
        { areaCodes: [], regionCode: "OT" },
      ],
      null,
    ),
  );
  assert.equal(total(all), 1208548.15, "an unfiltered export must still carry the whole month, both lines — 149,288.50 AI + 1,059,259.65 Pedia (restated 2026-08-07, +7,000.00 Ivyronc to October-Zayed 2026-08-09, +7,000.00 Ivyronc to Alex Center 2026-08-10, +7,000.00 more to October-Zayed 2026-08-10) = 1,208,548.15");

  // Delta (2) arrived with the 2026-08-06 Anti-Infective restatement; it is untouched.
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
