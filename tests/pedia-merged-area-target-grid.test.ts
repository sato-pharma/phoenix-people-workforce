import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { applyAchievementAreaMerges } from "../src/lib/sales/closing-area-merges.ts";
import {
  foldMergedAchievementCells,
  rollupAchievementByLine,
  type AchievementRow,
} from "../src/lib/sales/monthly-targets.ts";

/**
 * THE PEDIA MERGED AREA IS ONE ROW, ONE KEY, ONE TARGET — AND THE ROLL-UPS STAY UNFOLDED.
 *
 * ## The defect (2026-08-09 audit, verified 2026-09-04, run `wf_b7ad5542-d94`)
 *
 * `applyAchievementAreaMerges` rewrites Beni Suef (`UE9`) to Fayoum (`GZ6`) on Pedia and does NOT
 * re-aggregate — it is a one-for-one `map`. Its docstring used to promise the opposite ("the
 * aggregation will naturally sum them together"), which is true for a consumer that sums afterwards
 * and false for one that KEYS on `(areaCode, productCode)`.
 *
 * The Targets grid is exactly such a consumer: `${areaCode}|${productCode}` is its React key, its
 * `edits`/`unitEdits` key, and the `areaCode` it reconstructs and POSTs on Save. So the merge handed
 * it two rows with one key —
 *
 *   · both rows read the same `edits` entry, so typing in one updated both;
 *   · `rowByKey = new Map(...)` kept only the LAST of the pair;
 *   · Save posted a single `{ areaCode: "GZ6" }`, and `phx_upsert_monthly_targets` (ON CONFLICT DO
 *     UPDATE) overwrote Fayoum's target while Beni Suef's was never written.
 *
 * The operator believes he set Beni Suef and has in fact overwritten Fayoum. Latent only because no
 * Pedia UE9 target row exists yet — but `au_v_line_area_map` has pedia|UE9 `carries_target = true`,
 * so the download template offers "Beni Suef" for Pedia today and the upload validator accepts it.
 *
 * ## The owner's ruling, and why it is also the only sound arithmetic
 *
 * Restated 2026-09-05: **on Pedia they are one area.** So the merged cell carries ONE target
 * covering both halves. That is forced anyway — the row already sums both areas' actuals, so a
 * target covering only Fayoum would inflate attainment. (On CNS and Anti Infective they stay two
 * areas and nothing here applies; `CLOSING_AREA_MERGES` is pedia-only since 2026-08-30.)
 *
 * ## The trap this file also pins
 *
 * The fold is for the GRID ONLY. `foldAchievement` re-derives `coveredActualValue` from
 * `hasTarget`, which the fold OR-s — so folding before a roll-up would let an untargeted area's
 * actuals count as covered and inflate the exact percentage the covered rule exists to protect.
 * That is asserted below with real numbers, because it is the mistake a later "tidy-up" would make.
 */

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function row(input: Partial<AchievementRow> & { areaCode: string; productCode: string }): AchievementRow {
  return {
    period: "2026-08",
    lineCode: "pedia",
    regionCode: "GZ",
    areaState: null,
    isOther: false,
    repSeatId: "SEAT-PED-REP-GZ6",
    repHrId: "B-94",
    dmSeatId: "SEAT-PED-DM-GZ",
    dmHrId: "A-8",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: false,
    ...input,
  };
}

export function runPediaMergedAreaTargetGridTests() {
  // Fayoum carries the target; Beni Suef sells into the same product with no target of its own.
  const fayoum = row({
    areaCode: "GZ6", productCode: "P1",
    actualUnits: 121, actualValue: 121_000, targetUnits: 100, targetValue: 100_000,
    hasTarget: true, hasActual: true,
  });
  const beniSuef = row({
    areaCode: "UE9", productCode: "P1",
    actualUnits: 58, actualValue: 58_000,
    hasTarget: false, hasActual: true,
  });

  // ── 1. The merge really does produce a duplicate key — the premise, not an assumption ────────
  const merged = applyAchievementAreaMerges([fayoum, beniSuef]);
  assert.deepEqual(
    merged.map((r) => `${r.areaCode}|${r.productCode}`),
    ["GZ6|P1", "GZ6|P1"],
    "applyAchievementAreaMerges must still fold Pedia UE9 onto GZ6 without aggregating — if this "
      + "stops being true the grid fix below is guarding nothing, and the pedia-only merge rule may "
      + "have been changed (CNS and Anti Infective are deliberately NOT merged)",
  );

  // ── 2. THE HEADLINE — one row, one key, both halves' actuals ────────────────────────────────
  const grid = foldMergedAchievementCells(merged);
  assert.equal(
    grid.length,
    1,
    "the Pedia merged pair must be ONE grid row. Two rows share the key `GZ6|P1`, so the grid gives "
      + "them one edit box, keeps only the last in rowByKey, and Save posts one areaCode — writing "
      + "Fayoum's target and silently never writing Beni Suef's",
  );
  assert.equal(grid[0]!.actualValue, 179_000, "the merged row carries both halves' value (121k + 58k)");
  assert.equal(grid[0]!.actualUnits, 179, "and both halves' units — 179u = GZ6 121u + UE9 58u");
  assert.equal(grid[0]!.targetValue, 100_000, "one target covers the merged pair (owner: on Pedia they are one area)");

  // ── 3. Achievement is RECOMPUTED from the COVERED slice, never summed ────────────────────────
  // Covered = the actual sitting on a key that has a target = Fayoum's 121,000 only. Dividing the
  // merged 179,000 by the 100,000 target would read 179% for a 121% cell — the same error
  // foldAchievement's own note records costing Pedia February a 67.99% reading on a 35.71% month.
  assert.equal(
    grid[0]!.achievementValue,
    1.21,
    "achievement must divide the COVERED actual (121,000) by the target, not the merged actual "
      + "(179,000) — a percentage cannot be re-aggregated, only the parts it divides can",
  );

  // ── 4. "No target at all" must stay distinguishable from a target of zero ────────────────────
  const untargeted = foldMergedAchievementCells(
    applyAchievementAreaMerges([
      row({ areaCode: "GZ6", productCode: "P2", actualValue: 10, actualUnits: 1, hasActual: true }),
      row({ areaCode: "UE9", productCode: "P2", actualValue: 20, actualUnits: 2, hasActual: true }),
    ]),
  );
  assert.equal(
    untargeted[0]!.targetValue,
    null,
    "two untargeted halves must fold to a NULL target, not 0 — the grid renders those differently, "
      + "and a 0 would claim a target exists that nobody authored",
  );
  assert.equal(untargeted[0]!.achievementValue, null, "and no target means no achievement, not a divide by zero");

  // ── 5. THE TRAP — the roll-ups must keep the UNFOLDED rows ───────────────────────────────────
  // This is the mistake a later tidy-up would make: fold once, reuse everywhere.
  const fromUnfolded = rollupAchievementByLine(merged)[0]!;
  const fromFolded = rollupAchievementByLine(grid)[0]!;
  assert.equal(
    fromUnfolded.coveredActualValue,
    121_000,
    "rolled up from the unfolded rows, only Fayoum's actual is covered — Beni Suef has no target",
  );
  assert.equal(
    fromFolded.coveredActualValue,
    179_000,
    "rolled up from the FOLDED rows it becomes 179,000, because the fold OR-s hasTarget. That is why "
      + "the page feeds the roll-ups `lineRows` and not the folded grid rows — this assertion exists "
      + "to make that difference visible rather than a comment nobody re-derives",
  );
  // The PERCENTAGE is no longer the thing folding corrupts. Since the owner's 2026-09-05 ruling
  // ("FOLLOW THE OLD MONTHLY CLOSING ... MUST BE 100% IDENTICAL") achievement divides actualValue,
  // and folding changes neither the actual nor the target — only which rows carry `hasTarget`. So
  // the two roll-ups now agree on the grade and disagree on the COVERAGE figure beside it.
  //
  // That is a narrowing of the blast radius, not a reason to fold: `coveredActualValue` is what the
  // Targets card prints as "With a target", so folding first would still overstate how much of the
  // line was targeted — by 58,000 here — while the percentage stayed innocent. Pinned as an
  // equality rather than deleted, because an assertion that silently starts passing for a new
  // reason is worth less than one that says which reason.
  assert.equal(
    fromFolded.achievementValue,
    fromUnfolded.achievementValue,
    "folding no longer moves the grade — achievement divides ALL sales, and the fold changes neither "
      + "the actual nor the target",
  );
  assert.notEqual(
    fromFolded.coveredActualValue,
    fromUnfolded.coveredActualValue,
    "but it still corrupts the coverage figure the card prints beside that grade — never fold before "
      + "a roll-up",
  );

  // ── 6. The page must wire it that way ────────────────────────────────────────────────────────
  const page = readSource("../app/(admin)/sales/targets/page.tsx");
  assert.ok(
    /const gridRows = foldMergedAchievementCells\(lineRows\);/.test(page),
    "the Targets page must fold before building its keyed grid rows",
  );
  assert.ok(
    /rows = gridRows\s*\n?\s*\.map\(/.test(page),
    "and the grid must be built from the FOLDED rows — mapping lineRows again would restore the "
      + "duplicate key while leaving the fold in place, looking fixed",
  );
  for (const rollup of ["rollupAchievementByLine", "rollupAchievementByRegion", "rollupAchievementByDm"]) {
    assert.ok(
      new RegExp(`${rollup}\\(lineRows\\)`).test(page),
      `${rollup} must keep reading the UNFOLDED lineRows — see assertion 5; passing it gridRows would `
        + "inflate every covered-actual percentage on this page",
    );
  }
}
