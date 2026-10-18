import assert from "node:assert/strict";

import { applyPhotoPinTerritory, type PinnedGeography } from "../src/lib/marketing-requests/photo-pin-territory.ts";

// THE EVIDENCE PHOTO IS THE PRIMARY SOURCE OF TRUST (owner, 2026-10-18). The live case: حضانه عبد
// الكريم was filed under Menoufia 1 / منشأة سلطان from the legacy `delta_1` label plus an in-area
// guess, while its photo's pin sat 0.7 km from منوف in Menoufia 2. A marketing transfer must file a
// venue where its photo's pin falls — even where a distributor code resolved elsewhere.

const INHERITED: PinnedGeography = { areaCode: "D12", brickId: null, regionCode: "D1", source: "marketing_area" };
const MASTER: PinnedGeography = { areaCode: "D12", brickId: "B201-3", regionCode: "D1", source: "master_code" };
const MENOUF = {
  areaCode: "D13",
  areaName: "Menoufia 2",
  brickId: "B202-1",
  brickName: "منوف",
  distanceKm: 0.74,
  regionCode: "D1",
  regionName: "Delta (1)",
};

export async function runPhotoPinTerritoryTests() {
  // The live case: the pin overrides the inherited marketing area, brick and all.
  const moved = applyPhotoPinTerritory(INHERITED, MENOUF);
  assert.equal(moved.geography.areaCode, "D13", "a venue the master did not place is filed where its photo's pin falls");
  assert.equal(moved.geography.brickId, "B202-1");
  assert.equal(moved.geography.regionCode, "D1");
  assert.equal(moved.geography.source, "photo_pin", "the page must be able to say where the territory came from");
  assert.deepEqual(moved.pinBrick, { brickId: "B202-1", brickName: "منوف", distanceKm: 0.7 });

  // A label that maps to no area at all is filed from the pin too.
  const unmapped = applyPhotoPinTerritory({ areaCode: null, brickId: null, regionCode: null, source: "none" }, MENOUF);
  assert.equal(unmapped.geography.areaCode, "D13");

  // THE PHOTO OUTRANKS THE REGISTERED CODE TOO (owner, 2026-10-18: "the photo wins everywhere,
  // including where a distributor code exists"): a venue whose code resolved elsewhere is still
  // filed where its pin falls, and the master answer it replaced is handed back for the reason text.
  const overruled = applyPhotoPinTerritory(MASTER, MENOUF);
  assert.equal(overruled.geography.areaCode, "D13", "a code-resolved venue is filed from its photo's pin");
  assert.equal(overruled.geography.brickId, "B202-1");
  assert.equal(overruled.geography.source, "photo_pin");
  assert.equal(overruled.overrode, MASTER, "the master territory the photo replaced is named");
  // A pin that AGREES with the master changes nothing worth saying.
  const agreed = applyPhotoPinTerritory(MASTER, { ...MENOUF, areaCode: "D12", brickId: "B201-3" });
  assert.equal(agreed.geography.areaCode, "D12");
  assert.equal(agreed.overrode, null, "no override is reported when the photo and the master agree");
  // Out of the trust radius the master's answer stands — a far-off pin is not an accusation.
  const farMaster = applyPhotoPinTerritory(MASTER, { ...MENOUF, distanceKm: 40 });
  assert.equal(farMaster.geography, MASTER, "an unusable pin leaves the master's territory alone");
  assert.equal(farMaster.overrode, null);

  // FAIL SOFT: a pin whose nearest brick centre is implausibly far names no territory, and no pin at
  // all changes nothing — brick centres are geocoded guesses and a wrong filing misroutes a shop.
  assert.equal(applyPhotoPinTerritory(INHERITED, { ...MENOUF, distanceKm: 40 }).geography, INHERITED);
  assert.equal(applyPhotoPinTerritory(INHERITED, { ...MENOUF, distanceKm: 15.01 }).geography, INHERITED);
  assert.equal(applyPhotoPinTerritory(INHERITED, { ...MENOUF, distanceKm: 15 }).geography.source, "photo_pin");
  assert.equal(applyPhotoPinTerritory(INHERITED, null).geography, INHERITED);
  assert.equal(applyPhotoPinTerritory(INHERITED, { ...MENOUF, areaCode: null }).geography, INHERITED, "a centre with no area cannot file a venue");
}
