import assert from "node:assert/strict";

import {
  applyClosingAreaMerges,
  expandAreaCodeForLine,
  foldAreaCodeForLine,
  foldAreaOptionsForLine,
  getMergedAreaName,
} from "../src/lib/sales/closing-area-merges.ts";
import { vacancyAreaName } from "../src/lib/recruitment/vacancy-options.ts";

// OWNER RULING 2026-09-19: on the Anti Infective line, Delta (3)'s Suez (OT2) and Ismailia (OT9)
// are ONE area, "Ismailia and Suez", from 2026-09-01. Sales, bricks, customers and targets stay on
// the two codes (same as Pedia's Fayoum GZ6 + Beni Suef UE9), so the one-row presentation is the
// DATED rule in CLOSING_AREA_MERGES — and July / August, already published, must NOT move.

const LINE = "anti_infective";
const AREAS = [
  { areaCode: "OT2", areaName: "Suez", regionCode: "D3", regionName: "Delta (3)" },
  { areaCode: "OT9", areaName: "Ismailia", regionCode: "D3", regionName: "Delta (3)" },
];

export async function runAntiInfectiveIsmailiaSuezOneAreaTests() {
  // September on: one area, named the way the owner says it, keyed under Suez.
  assert.equal(getMergedAreaName(LINE, "OT2", "2026-09"), "Ismailia and Suez");
  assert.equal(getMergedAreaName(LINE, "OT2", "2026-10"), "Ismailia and Suez");
  assert.deepEqual(expandAreaCodeForLine(LINE, "OT2", "2026-09"), ["OT2", "OT9"]);
  assert.equal(foldAreaCodeForLine(LINE, "OT9", "2026-09"), "OT2");

  // August and earlier: still two areas — a published month is never restated.
  assert.equal(getMergedAreaName(LINE, "OT2", "2026-08"), null);
  assert.deepEqual(expandAreaCodeForLine(LINE, "OT2", "2026-08"), ["OT2"]);
  assert.equal(foldAreaCodeForLine(LINE, "OT9", "2026-08"), "OT9");

  // The picker shows ONE option from September, two before.
  const sept = foldAreaOptionsForLine(LINE, AREAS, "2026-09");
  assert.equal(sept.length, 1);
  assert.equal(sept[0].areaCode, "OT2");
  assert.equal(sept[0].areaName, "Ismailia and Suez");
  assert.equal(foldAreaOptionsForLine(LINE, AREAS, "2026-08").length, 2);

  // The closing folds Ismailia's sales into the one row: no money lost or duplicated.
  const cells = [
    { areaCode: "OT2", productCode: "P1", salesUnits: 1000, salesValue: 100_000 },
    { areaCode: "OT9", productCode: "P1", salesUnits: 1900, salesValue: 190_000 },
  ];
  const merged = applyClosingAreaMerges(LINE, AREAS, cells, [], "2026-09");
  assert.equal(merged.areas.length, 1);
  assert.equal(merged.areas[0].areaName, "Ismailia and Suez");
  assert.equal(merged.cells.length, 1);
  assert.equal(merged.cells[0].salesUnits, 2900);
  assert.equal(merged.cells[0].salesValue, 290_000);

  const august = applyClosingAreaMerges(LINE, AREAS, cells, [], "2026-08");
  assert.equal(august.areas.length, 2);
  assert.equal(august.cells.length, 2);

  // Other lines are untouched: CNS and Pedia have no Suez/Ismailia rule.
  assert.equal(getMergedAreaName("cns", "OT2", "2026-09"), null);
  assert.equal(getMergedAreaName("pedia", "OT2", "2026-09"), null);

  // The recruitment vacancy screens print the area name from the DB — they read the same rule.
  assert.equal(
    vacancyAreaName({ areas: { name: "Suez", code: "OT2" }, lines: { name: "Anti Infective", code: "anti_infective" } }),
    "Ismailia and Suez",
  );
  assert.equal(
    vacancyAreaName({ areas: { name: "Suez", code: "OT2" }, lines: { name: "CNS", code: "cns" } }),
    "Suez",
  );
}
