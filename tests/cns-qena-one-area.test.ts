import assert from "node:assert/strict";

import {
  applyAchievementAreaMerges,
  applyClosingAreaMerges,
  applyClosingAreaMergesToDetails,
  expandAreaCodeForLine,
  foldAreaCodeForLine,
  foldAreaOptionsForLine,
  getMergedAreaName,
} from "../src/lib/sales/closing-area-merges.ts";
import {
  MERGED_AREA_SPLIT_FOLD_START_PERIOD,
  foldNetOntoMergedAreas,
} from "../src/lib/sales/store-split-matrix.ts";
import { areaProductKey } from "../src/lib/sales/store-sales-city-split.ts";
import { vacancyAreaName } from "../src/lib/recruitment/vacancy-options.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CNS HAS A SINGLE QENA — AND ANTI INFECTIVE AND PEDIA MUST NEVER FOLD THE SAME PAIR.
//
// Owner, 2026-10-13: "in cns consider qena 1 and qena 2 as 1 area called qena". He was asked as a
// choice and answered with the LINE merge, not the rep-row merge that was recommended to him, so
// this is a `CLOSING_AREA_MERGES` rule on `cns` and nothing narrower.
//
// What it fixes, measured against production the same day. His 2026-10-12 ruling already points
// `cns / UE8` at `SEAT-CNS-REP-UE7`, so Snagik Ayman holds both Qenas — but only Qena 1 carries a
// CNS target (September: 337,469.87 EGP over 15 product rows; UE8 has no CNS target row at all from
// March on, deliberately, because the one-target-per-rep rule is kept by never uploading one). The
// two rows therefore graded his own September as Qena 1 80,860 / 337,470 = 24% and Qena 2 176,773
// against "no target", where the single row reads 257,633 / 337,470 = 76%.
//
// 🔴 THE LINE BOUNDARY IS THE POINT. Anti Infective has two real Qena seats in every month of 2026
// and Pedia from 2026-09-01, each carrying its own target — folding the pair there would hide one
// rep's target behind the other's row, which is the exact inverse of the defect being fixed.
//
// 🔴 AND THE START PERIOD IS LOAD-BEARING, not cosmetic. A merge outside the store-split fold window
// DROPS the folded-away area's net leg: `applyStoreSplitToMatrix` asks the net one question per row
// it renders, and `foldNetOntoMergedAreas` only re-keys the folded-away code's leg onto the merged
// row from `MERGED_AREA_SPLIT_FOLD_START_PERIOD`. CNS carries a net on BOTH Qena codes in all nine
// months of 2026 (read live 2026-10-13: January UE8 +155.30 packs, February −74.58, September
// −131.52), written by the Office respread his "Recompute from January 2026" ruling now covers. So
// a January start would have re-introduced, on CNS, the very hole fixed on Pedia the day before.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const QENA_AREAS = [
  { areaCode: "UE7", areaName: "Qena 1", regionCode: "UE", regionName: "Upper Egypt" },
  { areaCode: "UE8", areaName: "Qena 2", regionCode: "UE", regionName: "Upper Egypt" },
];

export async function runCnsQenaOneAreaTests() {
  // ── The rule itself: CNS, named "Qena", from July 2026 ──────────────────────────────────────────
  assert.equal(getMergedAreaName("cns", "UE7", "2026-09"), "Qena");
  assert.equal(getMergedAreaName("cns", "UE7", "2026-07"), "Qena");
  assert.equal(getMergedAreaName("cns", "UE7", "2026-12"), "Qena");
  assert.equal(foldAreaCodeForLine("cns", "UE8", "2026-09"), "UE7");

  // June and earlier keep the two rows their revalued manual closings were built on.
  assert.equal(getMergedAreaName("cns", "UE7", "2026-06"), null);
  assert.equal(foldAreaCodeForLine("cns", "UE8", "2026-06"), "UE8");
  assert.equal(getMergedAreaName("cns", "UE7", "2026-01"), null);

  // 🔴 The start period must equal the split-fold window's, or the merged row silently loses UE8's
  // net leg. Moving one of these two constants without the other is the defect, so they are pinned
  // against each other rather than each against a literal.
  assert.equal(
    "2026-07",
    MERGED_AREA_SPLIT_FOLD_START_PERIOD,
    "the CNS Qena merge starts where the split-fold window starts — a merge outside it drops UE8's leg",
  );
  assert.equal(
    getMergedAreaName("cns", "UE7", MERGED_AREA_SPLIT_FOLD_START_PERIOD),
    "Qena",
    "the first month of the fold window must already be merged",
  );

  // ── 🔴 THE OTHER TWO LINES NEVER FOLD THIS PAIR ────────────────────────────────────────────────
  for (const period of ["2026-01", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-12"]) {
    for (const line of ["anti_infective", "pedia"]) {
      assert.equal(
        getMergedAreaName(line, "UE7", period),
        null,
        `${line} must keep two Qenas in ${period} — both halves carry their own target`,
      );
      assert.equal(foldAreaCodeForLine(line, "UE8", period), "UE8");
      assert.deepEqual(expandAreaCodeForLine(line, "UE7", period), ["UE7"]);
      assert.equal(foldAreaOptionsForLine(line, QENA_AREAS, period).length, 2);
    }
  }

  // ── The closing row: both areas' sales, Qena 1's lone target ────────────────────────────────────
  // His real September, to the piastre as the live engine reads it.
  const cells = [
    { areaCode: "UE7", productCode: "TB001", salesUnits: 1_000, salesValue: 80_860 },
    { areaCode: "UE8", productCode: "TB001", salesUnits: 2_100, salesValue: 176_773 },
  ];
  const targets = [
    { areaCode: "UE7", productCode: "TB001", targetUnits: 4_825.15, targetValue: 337_469.87 },
    // UE8 has NO CNS target row — the blank must stay a blank's absence, never become a 0.
  ];
  const merged = applyClosingAreaMerges("cns", QENA_AREAS, cells, targets, "2026-09");
  assert.equal(merged.areas.length, 1);
  assert.equal(merged.areas[0]!.areaCode, "UE7");
  assert.equal(merged.areas[0]!.areaName, "Qena");
  assert.equal(merged.cells.length, 1);
  assert.equal(merged.cells[0]!.salesUnits, 3_100);
  assert.equal(merged.cells[0]!.salesValue, 257_633);
  assert.equal(merged.targets.length, 1);
  assert.equal(merged.targets[0]!.areaCode, "UE7");
  assert.equal(merged.targets[0]!.targetValue, 337_469.87);
  // 76%, where the two rows read 24% and "no target".
  assert.equal(
    Math.round((merged.cells[0]!.salesValue / merged.targets[0]!.targetValue!) * 100),
    76,
  );

  // Two blanks stay blank: a merged row with no target on either half must render "—", never 0.
  const noTarget = applyClosingAreaMerges(
    "cns",
    QENA_AREAS,
    cells,
    [
      { areaCode: "UE7", productCode: "XX001", targetUnits: null, targetValue: null },
      { areaCode: "UE8", productCode: "XX001", targetUnits: null, targetValue: null },
    ],
    "2026-09",
  );
  assert.equal(noTarget.targets.length, 1);
  assert.equal(noTarget.targets[0]!.targetValue, null);
  assert.equal(noTarget.targets[0]!.targetUnits, null);

  // June: two rows, two cells, and Qena 2's sales still stand on their own.
  const june = applyClosingAreaMerges("cns", QENA_AREAS, cells, targets, "2026-06");
  assert.equal(june.areas.length, 2);
  assert.equal(june.cells.length, 2);

  // Anti Infective's own September keeps both rows and both targets.
  const antiInfective = applyClosingAreaMerges("anti_infective", QENA_AREAS, cells, targets, "2026-09");
  assert.equal(antiInfective.areas.length, 2);
  assert.deepEqual(
    antiInfective.areas.map((area) => area.areaName),
    ["Qena 1", "Qena 2"],
  );

  // ── The picker folds to one option, and a filter on it still pulls Qena 2's sales ───────────────
  const options = foldAreaOptionsForLine("cns", QENA_AREAS, "2026-09");
  assert.equal(options.length, 1);
  assert.equal(options[0]!.areaCode, "UE7");
  assert.equal(options[0]!.areaName, "Qena");
  assert.deepEqual(
    expandAreaCodeForLine("cns", "UE7", "2026-09"),
    ["UE7", "UE8"],
    "filtering the closing on Qena must query BOTH codes — UE8 carries its own sales",
  );
  assert.deepEqual(expandAreaCodeForLine("cns", "UE7", "2026-06"), ["UE7"]);

  // ── 🔴 The store-split net lands on the merged row instead of being dropped ─────────────────────
  const net = new Map([
    [areaProductKey("UE7", "TB001"), { qty: 179.63, value: 12_000 }],
    [areaProductKey("UE8", "TB001"), { qty: -131.52, value: -9_000 }],
  ]);
  const foldedNet = foldNetOntoMergedAreas({ line: "CNS", period: "2026-09" }, net);
  assert.equal(foldedNet.size, 1, "both Qena legs must collapse onto the one row the matrix renders");
  const landed = foldedNet.get(areaProductKey("UE7", "TB001"));
  assert.ok(landed);
  assert.equal(Number(landed.qty.toFixed(2)), 48.11);
  assert.equal(landed.value, 3_000);
  // Anti Infective renders both rows, so its net must come back untouched — the same map object.
  assert.equal(foldNetOntoMergedAreas({ line: "Anti Infective", period: "2026-09" }, net), net);
  // And June is outside the fold window on both counts, so nothing is re-keyed there either.
  assert.equal(foldNetOntoMergedAreas({ line: "CNS", period: "2026-06" }, net), net);

  // ── The Data sheet / Details panel rows carry the merged name, never "Qena 2" ───────────────────
  const details = applyClosingAreaMergesToDetails(
    "cns",
    [
      { areaCode: "UE8", areaName: "Qena 2", sheetAreaCode: "UE8", sheetAreaName: "Qena 2" },
      { areaCode: "UE7", areaName: "Qena 1", sheetAreaCode: "UE7", sheetAreaName: "Qena 1" },
    ],
    "2026-09",
  );
  assert.deepEqual(
    details.map((row) => [row.areaCode, row.areaName]),
    [
      ["UE7", "Qena"],
      ["UE7", "Qena"],
    ],
  );
  assert.deepEqual(
    details.map((row) => row.sheetAreaName),
    ["Qena", "Qena"],
  );

  // ── Achievement rows re-key per ROW period, so one list spanning June and July splits correctly ─
  const achievement = applyAchievementAreaMerges([
    { areaCode: "UE8", lineCode: "cns", period: "2026-09" },
    { areaCode: "UE8", lineCode: "cns", period: "2026-06" },
    { areaCode: "UE8", lineCode: "anti_infective", period: "2026-09" },
  ]);
  assert.deepEqual(
    achievement.map((row) => row.areaCode),
    ["UE7", "UE8", "UE8"],
  );

  // ── A CNS Qena vacancy is advertised as "Qena"; the other lines keep their halves ───────────────
  assert.equal(
    vacancyAreaName({ areas: { name: "Qena 1", code: "UE7" }, lines: { name: "CNS", code: "cns" } }),
    "Qena",
  );
  assert.equal(
    vacancyAreaName({
      areas: { name: "Qena 1", code: "UE7" },
      lines: { name: "Anti Infective", code: "anti_infective" },
    }),
    "Qena 1",
  );

  // ── The CNS Fayoum / Beni Suef rule is untouched by all of this ─────────────────────────────────
  assert.equal(getMergedAreaName("cns", "GZ6", "2026-09"), "Fayoum - Beni Suef");
  assert.equal(getMergedAreaName("cns", "GZ6", "2026-07"), null);
  assert.deepEqual(expandAreaCodeForLine("cns", "GZ6", "2026-09"), ["GZ6", "UE9"]);
}
