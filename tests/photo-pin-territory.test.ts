import assert from "node:assert/strict";

import { applyPhotoPinTerritory, type PinnedGeography } from "../src/lib/marketing-requests/photo-pin-territory.ts";

// THE EVIDENCE PHOTO IS THE PRIMARY SOURCE OF TRUST (owner, 2026-10-18). The live case: حضانه عبد
// الكريم was filed under Menoufia 1 / منشأة سلطان from the legacy `delta_1` label plus an in-area
// guess, while its photo's pin sat 0.7 km from منوف in Menoufia 2. A marketing transfer must file a
// venue the master did not place where its photo's pin falls.

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

  // The master's own answer is untouched — whether a registered code outranks the photo is still an
  // open ruling, so nothing changes for a venue whose distributor code resolved.
  const kept = applyPhotoPinTerritory(MASTER, MENOUF);
  assert.equal(kept.geography, MASTER, "a code-resolved venue keeps the master's territory");
  assert.equal(kept.pinBrick, null);

  // FAIL SOFT: a pin whose nearest brick centre is implausibly far names no territory, and no pin at
  // all changes nothing — brick centres are geocoded guesses and a wrong filing misroutes a shop.
  assert.equal(applyPhotoPinTerritory(INHERITED, { ...MENOUF, distanceKm: 40 }).geography, INHERITED);
  assert.equal(applyPhotoPinTerritory(INHERITED, { ...MENOUF, distanceKm: 15.01 }).geography, INHERITED);
  assert.equal(applyPhotoPinTerritory(INHERITED, { ...MENOUF, distanceKm: 15 }).geography.source, "photo_pin");
  assert.equal(applyPhotoPinTerritory(INHERITED, null).geography, INHERITED);
  assert.equal(applyPhotoPinTerritory(INHERITED, { ...MENOUF, areaCode: null }).geography, INHERITED, "a centre with no area cannot file a venue");
}
