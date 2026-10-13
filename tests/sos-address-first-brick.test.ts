import assert from "node:assert/strict";

import { addressBrick } from "../src/lib/sales/normalizer/address-brick.ts";
import { resolveBrick } from "../src/lib/sales/normalizer/resolvers.ts";
import type { BrickRef, Crosswalks } from "../src/lib/sales/normalizer/types.ts";

// THE ADDRESS IS THE FIRST SOURCE OF TRUST (owner, 2026-10-13). A brick named in the customer's own
// address outranks the distributor's territory label and the stored customer mapping; only an owner
// ruling (confidence 100) and a direct brick id stand above it. The 13 Oct 2026 audit found 1,463 map
// rows whose address named another brick — 380 of them in another area — and the importer had been
// re-stamping every one of them from the label or the stale map each month.
export function runSosAddressFirstBrickTests() {
  const brick = (brickId: string, brickName: string, areaCode: string, regionCode = "UE"): BrickRef => ({
    areaCode, areaName: areaCode, blockCode: `BL-${areaCode}`, blockName: "", brickId, brickName, regionCode, regionName: regionCode,
  });
  const bricks = [
    brick("B1", "مدينة سوهاج", "UE5"),
    brick("B2", "طهطا", "UE5"),
    brick("B3", "جرجا", "UE6"),
    brick("B4", "البلينا", "UE6"),
    brick("B6", "الصالحية", "D24", "D2"), // a Sharkia namesake in another region
    brick("B7", "الصالحية", "UE7"),
    brick("B8", "قوص", "UE7"), // moved: kept as history, must never be picked
    brick("B9", "قوص", "UE8"),
  ];
  const base = {
    areaAliasByKey: new Map(),
    areaByCode: new Map(),
    brickById: new Map(bricks.map((b) => [b.brickId, b])),
    customerBrickByCanonicalKey: new Map(),
    customerBrickByKey: new Map([
      ["PS CITY", "B1"],
      ["PS TAHTA", "B2"],
      ["PS RULED", "B2"],
      ["PS GERGA", "B3"],
      ["PS SALHIA", "B7"],
    ]),
    movedBrickIds: new Set(["B8"]),
    ownerVerifiedCustomerKeys: new Set(["PS RULED"]),
    productAliasByKey: new Map(),
    productByCanonicalCode: new Map(),
    productByCode: new Map(),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map([["tahta district", { targetCode: "B2", targetType: "brick" }]]),
  } as unknown as Crosswalks;
  const resolve = (customerKey: string | null, address: string | (string | null)[], extra: Record<string, unknown> = {}) =>
    resolveBrick({
      addressValues: Array.isArray(address) ? address : [address],
      customerKey,
      distributorCode: "PS",
      ...extra,
    }, base);

  // ── 1. The address beats the stored mapping, inside the area… ───────────────────────────────
  const sameArea = resolve("PS CITY", "طهطا - بجوار الموقف");
  assert.equal(sameArea?.brickId, "B2", "a town named in the address must replace the stored city brick");
  assert.equal(sameArea?.source, "address", "and say it came from the address, so the self-heal updates the map");

  // …and across areas, when the address names nothing in the current one.
  const crossArea = resolve("PS TAHTA", "جرجا - بجوار المستشفى");
  assert.equal(crossArea?.brickId, "B3");
  assert.equal(crossArea?.areaCode, "UE6", "the sale moves to the area the address names");

  // ── 2. The address beats the distributor's territory LABEL — the headline of the ruling ──────
  const overLabel = resolve("PS NEW", "جرجا", { territoryValues: ["Tahta District"] });
  assert.equal(overLabel?.brickId, "B3", "a brick named in the address must outrank the label's brick");
  assert.equal(overLabel?.source, "address");
  // With no address, the label still decides exactly as before.
  assert.equal(resolve("PS NEW", "", { territoryValues: ["Tahta District"] })?.source, "territory");

  // ── 3. An owner ruling (confidence 100) outranks the address, and the label too ─────────────
  const ruled = resolve("PS RULED", "جرجا", { territoryValues: ["Tahta District"] });
  assert.equal(ruled?.brickId, "B2", "nothing below an owner ruling may override it");
  assert.equal(ruled?.source, "customer", "source stays customer so the self-heal never rewrites a ruling");

  // ── 4. The address must DISAGREE to move anything ───────────────────────────────────────────
  assert.equal(resolve("PS TAHTA", "طهطا جرجا")?.brickId, "B2", "an address naming the current brick keeps it");
  assert.equal(resolve("PS GERGA", "مدينة سوهاج")?.brickId, "B3", "a governorate city alone never moves a pharmacy");
  assert.equal(resolve("PS TAHTA", "ش جرجا - امام البنك")?.brickId, "B2", "a street is not a place");
  assert.equal(resolve("PS TAHTA", "كفر جرجا")?.brickId, "B2", "a name inside a longer village name is not that place");
  assert.equal(resolve("PS TAHTA", "جرجا البلينا")?.brickId, "B2", "two bricks named is ambiguous: keep the baseline");
  // Across areas, naming anything in the current area keeps the pharmacy there — here its block.
  const blockNamed = {
    ...base,
    brickById: new Map([...base.brickById].map(([id, b]) => [id, id === "B2" ? { ...b, blockName: "المراغة" } : b])),
  } as unknown as Crosswalks;
  assert.equal(
    addressBrick({ addressValues: ["المراغة - جرجا"], baseline: { areaCode: "UE5", brickId: "B2", regionCode: "UE" }, distributorCode: "PS" }, blockNamed),
    null,
    "an address naming the current brick's block never moves the pharmacy to another area",
  );
  // A capped address whose markaz was cut to a stub that begins a place in the current area.
  assert.equal(
    addressBrick({ addressValues: ["بجوار السلخانه – جرجا – مركز ط"], baseline: { areaCode: "UE5", brickId: "B1", regionCode: "UE" }, distributorCode: "PS" }, base),
    null,
    "\"مركز ط\" may be مركز طهطا — never move out of the area on the village name alone",
  );

  // ── 5. Namesakes: only inside the region, never a moved (history) brick ──────────────────────
  const region = resolve("PS TAHTA", "الصالحية");
  assert.equal(region?.brickId, "B7", "the namesake in the pharmacy's own region is the one meant");
  const moved = resolve("PS SALHIA", "مركز قوص");
  assert.equal(moved?.brickId, "B9", "a brick kept as history after a move is never picked");

  // ── 6. Feeds the matcher does not read, and Ibn Sina's English column ─────────────────────────
  assert.equal(
    resolveBrick({ addressValues: ["جرجا"], customerKey: "PS TAHTA", distributorCode: "PS-T" }, base)?.brickId,
    "B2",
    "a tender feed's address is an institution, never read",
  );
  assert.equal(resolve("PS TAHTA", ["Gerga, Sohag", "جرجا"])?.brickId, "B3", "the Arabic column is the one read");

  // ── 7. With nothing else to go on, the address must also state the governorate ──────────────
  assert.equal(resolve(null, "جرجا"), null, "a bare village name with no region to check it against places nothing");
  assert.equal(resolve(null, "جرجا - سوهاج")?.brickId, "B3", "a village plus its governorate is enough");
  assert.equal(resolve(null, "جرجا - قنا"), null, "a village outside the governorate stated is a namesake");
}
