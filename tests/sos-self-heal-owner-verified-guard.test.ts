import assert from "node:assert/strict";

import { selectCorrectionRows, type BrickRef } from "../src/lib/sales/normalizer/customer-map.ts";
import type { CustomerBrickCorrection } from "../src/lib/sales/normalizer/types.ts";

function bricks(): Map<string, BrickRef> {
  return new Map<string, BrickRef>([
    ["B200-5", { areaCode: "D17", brickId: "B200-5", regionCode: "D1" }],
    ["B199-9", { areaCode: "D16", brickId: "B199-9", regionCode: "D1" }],
  ]);
}

function correction(over: Partial<CustomerBrickCorrection> = {}): CustomerBrickCorrection {
  return {
    distributorCode: "PS",
    customerCode: "1507402",
    brickId: "B200-5",
    previousBrickId: "B199-9",
    ...over,
  } as CustomerBrickCorrection;
}

export function runSosSelfHealOwnerVerifiedGuardTests() {
  // Baseline: with no owner ruling on file, the monthly upload's self-heal still wins. This is the
  // behaviour that keeps the crosswalk current, and the guard must not disturb it.
  {
    const out = selectCorrectionRows([correction()], bricks(), new Set<string>(), "admin");
    assert.equal(out.rows.length, 1, "an ordinary correction is still written");
    assert.equal(out.skippedOwnerVerified, 0, "nothing is owner-verified, so nothing is guarded");
    assert.equal(out.rows[0]?.brick_id, "B200-5", "the sheet's brick lands on the crosswalk");
  }

  // The regression: an owner ruling (confidence=100) must survive the upload untouched. Without the
  // guard this row is overwritten with the sheet's brick while confidence stays 100 — leaving a row
  // that still claims to be owner-verified but no longer carries the owner's brick.
  {
    const out = selectCorrectionRows([correction()], bricks(), new Set(["PS 1507402"]), "admin");
    assert.equal(out.rows.length, 0, "an owner-verified mapping is never overwritten by the sheet");
    assert.equal(out.skippedOwnerVerified, 1, "and the skip is counted, not silent");
    assert.equal(out.skipped, 0, "it is reported as owner-verified, not as an unresolvable row");
  }

  // The guard is keyed on (distributor, customer) exactly as the upsert's onConflict is, so a ruling
  // for one distributor must not shield the same customer code under another.
  {
    const out = selectCorrectionRows(
      [correction({ distributorCode: "IS-S" })], bricks(), new Set(["PS 1507402"]), "admin",
    );
    assert.equal(out.rows.length, 1, "a ruling on PS does not shield the IS-S mapping of that code");
    assert.equal(out.skippedOwnerVerified, 0, "the guard matches the upsert key, not the code alone");
  }

  // Distributor code is normalized the same way on both sides of the comparison.
  {
    const out = selectCorrectionRows([correction({ distributorCode: " ps " })], bricks(), new Set(["PS 1507402"]), "admin");
    assert.equal(out.skippedOwnerVerified, 1, "a padded/lower-cased distributor still matches the ruling");
  }

  // Mixed batch: the guard removes only the ruled customer and leaves the rest of the upload alone.
  {
    const out = selectCorrectionRows(
      [correction(), correction({ customerCode: "1507421" }), correction({ customerCode: "", brickId: "B199-9" })],
      bricks(),
      new Set(["PS 1507402"]),
      "admin",
    );
    assert.equal(out.rows.length, 1, "only the untouched, resolvable correction is written");
    assert.equal(out.skippedOwnerVerified, 1, "one skipped for the owner ruling");
    assert.equal(out.skipped, 1, "one skipped for a blank customer code — counted separately");
    assert.equal(out.rows[0]?.customer_code, "1507421", "the surviving row is the unruled customer");
  }

  // The payload must never carry `confidence`: the self-heal has no business scoring a mapping, and
  // an absent column is what lets an existing owner ruling keep its 100 on rows it does write.
  {
    const out = selectCorrectionRows([correction()], bricks(), new Set<string>(), "admin");
    assert.equal(
      Object.hasOwn(out.rows[0] ?? {}, "confidence"), false,
      "self-heal never writes confidence, so it cannot mint or erase an owner ruling",
    );
    assert.equal(out.rows[0]?.source, "sheet-verified", "provenance stays distinguishable in the Mapping Database");
  }
}
