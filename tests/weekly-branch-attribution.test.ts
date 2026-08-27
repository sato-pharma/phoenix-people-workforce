import assert from "node:assert/strict";

import { buildWeeklyAreaSplitIndex } from "../src/lib/sales/weekly/branch-area-split.ts";
import {
  describeSplitPreview,
  previewWeeklyBranchSplit,
  splitWeeklyRowsByBranch,
  type WeeklySplittableRow,
} from "../src/lib/sales/weekly/branch-attribution.ts";

/**
 * Weekly rows arrive per DEPOT. branch-name-scope.ts decides WHICH areas a depot serves; this file
 * pins what happens to the MONEY once it has decided — which is the half that can quietly change a
 * national total, and the half a manager's dashboard is built from.
 *
 * The rule being pinned is the owner's, 2026-08-27: "Minia and Assiut" pays fifty percent to Minia
 * and fifty to Assiut, and Minia then divides by two. Four things must hold every time: the parts
 * add back to the original exactly, a branch he has mapped by hand is never touched, a warehouse is
 * never split down to reps, and a depot that states no place is left exactly where it is today.
 *
 * A private hospital WAS in that last group until he ruled otherwise on 2026-08-27 - see block 4b.
 */
const AREA_ROWS = [
  ["CA1", "Heliopolis"], ["CA2", "Nasr City"], ["CA3", "Cairo East 1"],
  ["UE1", "Minia 1"], ["UE2", "Minia 2"], ["UE3", "Assuit 1"], ["UE4", "Assuit 2"],
  ["UE5", "Sohag1"], ["UE6", "Sohag2"], ["UE9", "Beni Suef"],
].map(([area_code, area_name]) => ({ area_code, area_name }));

/**
 * Two lines, and Beni Suef deliberately sits in a different region on each.
 *
 * That is the owner's own ruling — Beni Suef is Upper Egypt on Anti Infective and Giza on Pedia —
 * and it is the reason the preview computes the arithmetic per line instead of once.
 */
const MAP_ROWS = [
  ...AREA_ROWS.map((a) => ({
    line_code: "anti_infective",
    area_code: a.area_code,
    operational_region_code: a.area_code.replace(/\d$/, ""),
    effective_from: "2026-07-13",
    effective_to: null,
  })),
  ...AREA_ROWS.filter((a) => a.area_code !== "UE9").map((a) => ({
    line_code: "cns",
    area_code: a.area_code,
    operational_region_code: a.area_code.replace(/\d$/, ""),
    effective_from: "2026-07-13",
    effective_to: null,
  })),
];

const index = buildWeeklyAreaSplitIndex(MAP_ROWS, AREA_ROWS, "2026-08-27", [
  { brick_name: "ملاوى", area_code: "UE2" },
]);

/** "Minia and Assiut" — the owner's worked example, and the branch this whole file is about. */
const MINYA_ASSIUT = "ك.ع.المنيا واسيوط";
const WAREHOUSE = "Assiut 2 Warehouse";

function row(over: Partial<WeeklySplittableRow> = {}): WeeklySplittableRow {
  return {
    line: "Anti Infective",
    regionCode: "UE",
    areaCode: null,
    branchName: MINYA_ASSIUT,
    branchCode: "UE-KA-01",
    salesValue: 1_000_000,
    salesUnits: 400,
    stockUnits: 50,
    ...over,
  };
}

const sum = (rows: WeeklySplittableRow[], field: "salesValue" | "salesUnits" | "stockUnits") =>
  rows.reduce((total, item) => total + item[field], 0);

export async function runWeeklyBranchAttributionTests() {
  // 1) HEADLINE — the owner's own example, and the money adds back to the last piastre.
  //    A mapping decision reassigns value; it must never create or destroy any. The totals here are
  //    deliberately awkward (an odd piastre, a prime unit count) because a split that only balances
  //    on round numbers balances by luck.
  {
    for (const value of [1_000_000, 999_999.99, 1_000_000.01, 7, 0.03, -4_512.37]) {
      const { rows: out } = splitWeeklyRowsByBranch([row({ salesValue: value, salesUnits: 401, stockUnits: 13 })], index);
      assert.equal(out.length, 4, `${value} must land on all four Upper Egypt areas`);
      assert.equal(sum(out, "salesValue"), value, `value must be conserved exactly, got ${sum(out, "salesValue")}`);
      assert.equal(sum(out, "salesUnits"), 401, "units must be conserved exactly");
      assert.equal(sum(out, "stockUnits"), 13, "stock must be conserved exactly");
    }
  }

  // 2) HEADLINE — 50% per governorate, then evenly inside each. Not 25% because there happen to be
  //    four areas: if Assiut had three areas Minia would still keep half, and the areas named are
  //    the ones the organogram maps, never the ones the code spelling suggests.
  {
    const { rows: out } = splitWeeklyRowsByBranch([row()], index);
    const byArea = new Map(out.map((item) => [item.areaCode, item.salesValue]));
    assert.deepEqual([...byArea.keys()].sort(), ["UE1", "UE2", "UE3", "UE4"]);
    for (const area of ["UE1", "UE2", "UE3", "UE4"]) {
      assert.equal(byArea.get(area), 250_000, `${area} must receive a quarter of the branch`);
    }
    // Every other field rides along unchanged — the split moves money, it does not rewrite the row.
    assert.equal(out[0].branchName, MINYA_ASSIUT);
    assert.equal(out[0].line, "Anti Infective");
  }

  // 3) HEADLINE — a hand-mapped area is NEVER touched. This is the owner's override: he disagrees
  //    with a reading, sets the Area on the mapping sheet, and the branch stops being read at all.
  //    A split that ignored it would overwrite his decision on every export, invisibly.
  {
    const pinned = row({ areaCode: "UE3" });
    const { rows: out } = splitWeeklyRowsByBranch([pinned], index);
    assert.equal(out.length, 1, "a pinned branch stays one row");
    assert.equal(out[0], pinned, "and is the very same object — not a rebuilt copy");
    assert.equal(out[0].salesValue, 1_000_000, "the whole value goes where he put it");
  }

  // 4) The classes that are not territories keep today's behaviour, and so does a depot whose name
  //    states no place and carries no usable region. Both are left alone rather than guessed at.
  {
    const untouched = [
      row({ branchName: WAREHOUSE }),
      row({ branchName: "Unallocated POS", regionCode: "" }),
    ];
    const { rows: out } = splitWeeklyRowsByBranch(untouched, index);
    assert.equal(out.length, 2, "nothing is expanded");
    assert.equal(out, untouched, "and the array itself is handed straight back");
    for (const item of out) assert.equal(item.areaCode, null, `${item.branchName} must keep no area`);
  }

  // 4b) A PRIVATE HOSPITAL IS NOW MONEY THAT MOVES. It sat in the block above until 2026-08-27,
  //     when the owner ruled that a hospital's sales credit the area it physically sits in. It is
  //     pinned here rather than only in weekly-branch-name-scope because that file proves the NAME
  //     is read, and this one proves the VALUE arrives whole — EGP 1,091,946 of production value
  //     that credited nobody now lands on real areas, so it has to add back to the penny.
  {
    const hospital = row({ branchName: "Private Hospi Cairo", regionCode: "CA" });
    const { rows: out } = splitWeeklyRowsByBranch([hospital], index);
    assert.deepEqual(out.map((item) => item.areaCode), ["CA1", "CA2", "CA3"], "Cairo's areas, in order");
    assert.equal(
      out.reduce((sum, item) => sum + item.salesValue, 0),
      1_000_000,
      "a third of a million does not divide evenly - the parts must still add back exactly",
    );
    assert.equal(out[0].line, "Anti Infective", "the split moves money, it does not rewrite the row");
  }

  // 5) A missing organogram is a supported state, not a crash. loadWeeklyAreaSplitIndex is allowed
  //    to fail on the export path, and when it does the weekly workbook must be exactly the book it
  //    was before this feature existed.
  {
    const input = [row()];
    const { rows: out, stats } = splitWeeklyRowsByBranch(input, null);
    assert.equal(out, input, "no index means the same array, untouched");
    assert.equal(stats.rowsOut, 1);
    assert.equal(stats.branchesPlaced, 0);
  }

  // 6) A name that resolves to ONE area is not a split at all — it is a placement, and it must stay
  //    a single row. Mallawi is the owner's own brick example.
  {
    const { rows: out, stats } = splitWeeklyRowsByBranch(
      [row({ branchName: "ملوى", salesValue: 123.45 })],
      index,
    );
    assert.equal(out.length, 1, "one area, one row");
    assert.equal(out[0].areaCode, "UE2", "Mallawi belongs to Minia 2 entirely");
    assert.equal(out[0].salesValue, 123.45, "and keeps the whole value");
    assert.equal(stats.branchesPlaced, 1);
    assert.equal(stats.branchesSplit, 0, "a placement is not a split");
  }

  // 7) The stats are what the owner is told, so they must count branches rather than rows. One depot
  //    repeated across twenty products is one branch that was split, not twenty.
  {
    const many = Array.from({ length: 20 }, (_, i) => row({ salesValue: 1_000 + i }));
    const { rows: out, stats } = splitWeeklyRowsByBranch(many, index);
    assert.equal(out.length, 80, "twenty rows over four areas");
    assert.equal(stats.branchesSplit, 1, "one depot, however many products it sells");
    assert.equal(stats.valuePlaced, sum(many, "salesValue"), "the value reported as placed is the value that moved");
    assert.equal(sum(out, "salesValue"), sum(many, "salesValue"), "and still adds back exactly");
  }

  // 8) HEADLINE — the arithmetic is SHOWN, per line, which is the owner's actual instruction: "this
  //    concept you must show in the weekly mapping sheet, with calculation like this". A branch that
  //    reads the same on every line says so once; Beni Suef is the case that genuinely differs, so
  //    Anti Infective (which maps it) and CNS (which does not) must not be collapsed together.
  {
    const preview = previewWeeklyBranchSplit(index, { branchName: MINYA_ASSIUT, regionCode: "UE" });
    assert.equal(preview.branchClass, "territory");
    assert.equal(preview.arithmetic.length, 1, "both lines split it identically, so it is stated once");
    assert.equal(preview.arithmetic[0].shares.length, 4);
    assert.deepEqual(
      preview.arithmetic[0].shares.map((share) => `${share.areaName} ${share.percentLabel}`),
      ["Minia 1 25%", "Minia 2 25%", "Assuit 1 25%", "Assuit 2 25%"],
      "the sheet shows real area names and whole percentages, not codes and decimals",
    );
    assert.ok(describeSplitPreview(preview).includes("Minia 1 25%"), "and the workbook cell says the same thing");

    const perLine = previewWeeklyBranchSplit(index, { branchName: "Direct - Upper Egypt", regionCode: "UE" });
    assert.equal(perLine.arithmetic.length, 2, "Beni Suef is in Upper Egypt on one line and not the other");
    const withBeniSuef = perLine.arithmetic.find((entry) => entry.shares.some((s) => s.areaCode === "UE9"));
    assert.ok(withBeniSuef, "one of the two must include Beni Suef");
    assert.deepEqual(withBeniSuef?.lines, ["Anti Infective"], "and it is the line the organogram maps it on");
  }

  // 9) A pinned or excluded branch explains ITSELF on the sheet rather than showing an arithmetic
  //    that is not being applied — the sheet must never display a split the export does not perform.
  {
    const pinned = previewWeeklyBranchSplit(index, { branchName: MINYA_ASSIUT, regionCode: "UE", areaCode: "UE3" });
    assert.equal(pinned.branchClass, "pinned");
    assert.equal(pinned.arithmetic.length, 0, "a pinned branch shows no split");
    assert.ok(pinned.note.includes("Assuit 1"), `the note must name the area it is pinned to, got: ${pinned.note}`);
    assert.equal(describeSplitPreview(pinned), "", "and the workbook cell is blank, not a stale formula");

    const excluded = previewWeeklyBranchSplit(index, { branchName: MINYA_ASSIUT, regionCode: "UE", excluded: true });
    assert.equal(excluded.branchClass, "excluded");
    assert.equal(excluded.arithmetic.length, 0);

    const warehouse = previewWeeklyBranchSplit(index, { branchName: WAREHOUSE, regionCode: "UE" });
    assert.equal(warehouse.branchClass, "warehouse");
    assert.equal(warehouse.arithmetic.length, 0, "a warehouse is not a territory and shows no split");
  }
}
