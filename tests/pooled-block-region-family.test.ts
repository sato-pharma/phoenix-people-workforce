import assert from "node:assert/strict";

import {
  isPooledBlockRegion,
  POOLED_BLOCK_REGION_CODE,
  pooledBlockMembers,
  type SplitRegions,
} from "../src/lib/sales/store-sales-city-split.ts";

/** Pedia's Upper Egypt as it is coded TODAY: one region, `UE`. */
const BEFORE: SplitRegions = {
  areasByRegion: new Map([
    ["UE", new Set(["UE1", "UE2", "UE3", "UE4", "UE5", "UE6", "UE7"])],
    ["GZ", new Set(["GZ6", "UE9"])],
    ["OT", new Set(["UE8", "OT6"])],
  ]),
  others: new Set(["UE8", "OT6"]),
};

/**
 * THE RENAME IN ISOLATION — the same areas, the same Others, only the region CODE changed. This is
 * the pair the fix is about, and holding everything else still is what makes the comparison mean
 * something: if the pool differs here, the rename alone broke it.
 */
const RENAME_ONLY: SplitRegions = {
  areasByRegion: new Map([
    ["UE-1", new Set(["UE1", "UE2", "UE3", "UE4"])],
    ["UE-2", new Set(["UE5", "UE6", "UE7"])],
    ["GZ", new Set(["GZ6", "UE9"])],
    ["OT", new Set(["UE8", "OT6"])],
  ]),
  others: new Set(["UE8", "OT6"]),
};

/**
 * The REAL September shape the migration writes: the rename PLUS the membership moves. Fayoum
 * (GZ6) and Beni Suef (UE9) arrive from Giza, and Qena 2 (UE8) and Luxor (OT6) leave Others.
 *
 * The pool legitimately GROWS here, and by exactly the two that left Others — the same two that
 * take the El Qema divisor from 37 to 39. That is the intended change, and keeping it in its own
 * fixture is what stops it being mistaken for the rename defect.
 */
const SEPTEMBER: SplitRegions = {
  areasByRegion: new Map([
    ["UE-1", new Set(["GZ6", "UE9", "UE1", "UE2", "UE3", "UE4"])],
    ["UE-2", new Set(["UE5", "UE6", "UE7", "UE8", "OT6"])],
  ]),
  others: new Set(),
};

/**
 * El Qema's Upper Egypt pooling must survive a RENAME of the region, not only a MOVE of a seat.
 *
 * WHAT THIS CAUGHT. The pool looked up one literal region code, `UE`. Splitting Pedia's Upper
 * Egypt into `UE-1` and `UE-2` leaves no area coded `UE` at all, so the lookup found nothing and
 * `pooledBlockMembers` returned its empty "no pooling" answer — which is indistinguishable from
 * "this line has no Upper Egypt". El Qema's Upper Egypt block would have switched itself off on
 * Pedia from September, with no error, no red test, and no number obviously out of place.
 *
 * Measured before the fix: 8 members under `UE`, 0 under `UE-1`/`UE-2`.
 *
 * The module's own comment is what made it look safe — "the members are READ, not listed … so it
 * moves when he moves a seat". True of a move, false of a rename, and the split is a rename.
 */
export function runPooledBlockRegionFamilyTests() {
  // ── 1. the family, and what is NOT in it ──────────────────────────────────────────────────
  assert.equal(isPooledBlockRegion("UE"), true, "the base code is still Upper Egypt");
  assert.equal(isPooledBlockRegion("UE-1"), true);
  assert.equal(isPooledBlockRegion("UE-2"), true);
  assert.equal(isPooledBlockRegion("ue-1"), true, "region codes are compared case-insensitively");
  assert.equal(isPooledBlockRegion(" UE-2 "), true, "a padded code from the map still matches");
  // A future UE-3 joins on its own, which is the point of a family over a list.
  assert.equal(isPooledBlockRegion("UE-3"), true);

  // The negatives matter more than the positives: a prefix rule that is too loose would drag
  // unrelated regions into a pool that moves real money.
  for (const outside of ["GZ", "OT", "DELTA", "UEX", "UE1", "CA", "ALX", "", null, undefined]) {
    assert.equal(
      isPooledBlockRegion(outside),
      false,
      `${JSON.stringify(outside)} is not an Upper Egypt region and must never join the pool`,
    );
  }
  // UE1 above is the sharp one: it is an AREA code, not a region, and differs from UE-1 by a
  // single hyphen. Matching it would pool one area against itself.
  assert.equal(isPooledBlockRegion("UE1"), false);

  // ── 2. THE HEADLINE: the RENAME ALONE must not change what the rule does ─────────────────
  const before = pooledBlockMembers("Pedia", BEFORE);
  const renamed = pooledBlockMembers("Pedia", RENAME_ONLY);

  assert.ok(before.length > 0, "the pool must be non-empty today, or the comparison below is vacuous");
  assert.deepEqual(
    renamed,
    before,
    "re-coding Upper Egypt to UE-1/UE-2 must leave the pool IDENTICAL — this is the assertion that fails if the single-string lookup comes back",
  );

  // Stated as absolutes too, so a change breaking BOTH sides equally could not pass by agreeing
  // with itself.
  assert.equal(before.length, 8, "Fayoum-Beni Suef as one member, plus seven Upper Egypt areas");
  assert.deepEqual(before[0], ["GZ6", "UE9"], "Fayoum and Beni Suef pool as ONE member");

  // ── 2b. the real September shape grows by exactly the two that left Others ───────────────
  // Asserted as a DIFFERENCE, not a count, so it says WHY it grew. Qena 2 and Luxor leaving
  // Others is the same fact that takes El Qema's divisor from 37 to 39.
  const september = pooledBlockMembers("Pedia", SEPTEMBER);
  const gained = september.flat().filter((area) => !before.flat().includes(area)).sort();
  assert.deepEqual(
    gained,
    ["OT6", "UE8"],
    "September adds Qena 2 and Luxor to the pool — and nothing else — because they left Others",
  );
  assert.equal(september.length, before.length + 2);

  // ── 3. an empty organogram still means no pooling ────────────────────────────────────────
  // The safe direction, and unchanged: no members means the money stays where the split put it.
  assert.deepEqual(pooledBlockMembers("Pedia", undefined), [], "no organogram, no pooling");
  assert.deepEqual(
    pooledBlockMembers("Pedia", { areasByRegion: new Map([["GZ", new Set(["GZ1"])]]), others: new Set() }),
    [],
    "a line with no Upper Egypt region pools nothing",
  );

  // ── 4. Others is still excluded, whichever region an area is coded under ─────────────────
  const withOthers = pooledBlockMembers("Pedia", {
    areasByRegion: SEPTEMBER.areasByRegion,
    others: new Set(["UE8", "OT6"]),
  });
  assert.ok(
    !withOthers.flat().includes("UE8") && !withOthers.flat().includes("OT6"),
    "an area parked in Others never joins the pool, even when its region is in the family",
  );

  assert.equal(POOLED_BLOCK_REGION_CODE, "UE", "the base code is what the family is built from");
}
