import assert from "node:assert/strict";

import { resolveBrick } from "../src/lib/sales/normalizer/resolvers.ts";
import type { Crosswalks } from "../src/lib/sales/normalizer/types.ts";

// January 2026 landed 3,282 rows (1,356 customers) at AREA level while each of those customers had
// an exact, active, valid brick sitting in source_of_sales_customer_map. 733 of them were the same
// customers that failed identically in June — systematic, not the random paging loss first
// suspected.
//
// Cause: resolveBrick returned the moment a territory text matched an AREA alias, so step 4
// (customer→brick) was never reached. Every one of those 3,282 rows had area_code AND region_code
// populated with brick_id empty — they all resolved, just to the wrong precision.
//
// The rule the fix encodes:
//   sheet names a BRICK          -> sheet wins (unchanged; a stored mapping never overrides it)
//   sheet names only an AREA     -> the customer's stored brick wins IF it sits inside that area
//   stored brick in another area -> keep the sheet's area (never move a sale across areas)
export function runSosResolveBrickPrecedenceTests() {
  const brick = (brickId: string, areaCode: string) => ({
    areaCode, areaName: areaCode, blockCode: "BLK", brickId, brickName: brickId,
    regionCode: areaCode.slice(0, 2), regionName: areaCode.slice(0, 2),
  });

  const maps = {
    areaAliasByKey: new Map([["behira 2", { areaCode: "AB5", regionCode: "AB" }]]),
    areaByCode: new Map([
      ["AB5", { areaCode: "AB5", areaName: "Behira 2", regionCode: "AB", regionName: "AB" }],
      ["CA2", { areaCode: "CA2", areaName: "Nasr City", regionCode: "CA", regionName: "CA" }],
    ]),
    brickById: new Map([
      ["B114-87", brick("B114-87", "AB5")], // customer's real brick, inside Behira 2
      ["B205-4", brick("B205-4", "CA2")],   // a brick in a DIFFERENT area
      ["B114-80", brick("B114-80", "AB5")], // what a territory alias points at
    ]),
    customerBrickByKey: new Map([["PS 0001506606", "B114-87"]]),
    customerBrickByCanonicalKey: new Map([["PS 1506606", "B114-87"]]),
    productAliasByKey: new Map(),
    productByCode: new Map(),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map([
      ["behira 2 area", { targetType: "area", targetCode: "AB5" }],
      ["abu homs", { targetType: "brick", targetCode: "B114-80" }],
    ]),
  } as unknown as Crosswalks;

  // ── 1. THE BUG: area-only text must no longer beat the customer's exact brick ──
  const fixed = resolveBrick(
    { customerKey: "PS 0001506606", territoryValues: ["Behira 2"] },
    maps,
  );
  assert.equal(fixed?.brickId, "B114-87", "the customer's exact brick must win over an area-only signal");
  assert.equal(fixed?.source, "customer");
  assert.equal(fixed?.areaCode, "AB5", "and it must stay in the area the sheet named");

  // Same via the territory alias that targets an area (the other path into the same fault).
  const viaTerritoryArea = resolveBrick(
    { customerKey: "PS 0001506606", territoryValues: ["Behira 2 Area"] },
    maps,
  );
  assert.equal(viaTerritoryArea?.brickId, "B114-87", "targetType 'area' must not short-circuit either");

  // ── 2. A BRICK named by the sheet still outranks the stored mapping ──────────
  // This is the original, deliberate design and must not regress.
  const sheetBrickWins = resolveBrick(
    { customerKey: "PS 0001506606", territoryValues: ["Abu Homs"] },
    maps,
  );
  assert.equal(sheetBrickWins?.brickId, "B114-80", "a brick named by the sheet still wins");
  assert.equal(sheetBrickWins?.source, "territory");

  // A direct brick-id column also still wins.
  const directWins = resolveBrick(
    { brickIdValues: ["B114-80"], customerKey: "PS 0001506606", territoryValues: ["Behira 2"] },
    maps,
  );
  assert.equal(directWins?.brickId, "B114-80");
  assert.equal(directWins?.source, "direct");

  // ── 3. CROSS-AREA GUARD: never move a sale to another area on a stored mapping ──
  const crossArea = resolveBrick(
    { customerKey: "PS CROSS", territoryValues: ["Behira 2"] },
    { ...maps, customerBrickByKey: new Map([["PS CROSS", "B205-4"]]) } as unknown as Crosswalks,
  );
  assert.equal(crossArea?.brickId, "", "a stored brick in a different area must NOT be applied");
  assert.equal(crossArea?.areaCode, "AB5", "the sheet's area is kept instead");
  assert.equal(crossArea?.source, "area");

  // ── 4. Behaviour with no area signal is unchanged ────────────────────────────
  const customerOnly = resolveBrick({ customerKey: "PS 0001506606" }, maps);
  assert.equal(customerOnly?.brickId, "B114-87", "customer mapping still resolves when the sheet says nothing");

  const canonical = resolveBrick(
    { customerCanonicalKey: "PS 1506606", customerKey: "PS unknown", territoryValues: ["Behira 2"] },
    maps,
  );
  assert.equal(canonical?.brickId, "B114-87", "the leading-zero canonical fallback still works");

  // ── 5. Area-only is still returned when the customer map has nothing ─────────
  // The fix must not turn a resolvable area row into an unresolved one.
  const noCustomer = resolveBrick({ customerKey: "PS NOTHING", territoryValues: ["Behira 2"] }, maps);
  assert.equal(noCustomer?.areaCode, "AB5", "an area-only row must still resolve to its area");
  assert.equal(noCustomer?.brickId, "");

  const nothingAtAll = resolveBrick({ territoryValues: ["totally unknown place"] }, maps);
  assert.equal(nothingAtAll, null, "genuinely unknown input must still resolve to nothing");

  // ── 6. A stored brick that no longer exists must not resurrect a dead brick ──
  const deadBrick = resolveBrick(
    { customerKey: "PS DEAD", territoryValues: ["Behira 2"] },
    { ...maps, customerBrickByKey: new Map([["PS DEAD", "B999-9"]]) } as unknown as Crosswalks,
  );
  assert.equal(deadBrick?.areaCode, "AB5", "a stored brick missing from the master falls back to the area");
  assert.equal(deadBrick?.brickId, "");

  console.log("sos resolveBrick precedence tests passed");
}
