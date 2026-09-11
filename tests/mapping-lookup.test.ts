import assert from "node:assert/strict";

import {
  classifyCustomerCodeCandidates,
  customerCodeVariants,
  normalizeCustomerCodeInput,
  resolveTerritoryText,
  type CodeCandidate,
} from "../src/lib/sales/mapping-lookup.ts";
import type { BrickRef, Crosswalks } from "../src/lib/sales/normalizer/types.ts";

const candidate = (
  distributorCode: string,
  brickId: string,
  areaCode: string,
  customerName = "pharmacy",
): CodeCandidate => ({
  address: null,
  areaCode,
  areaName: areaCode,
  brickId,
  brickName: brickId,
  confidence: null,
  customerCode: "2029",
  customerName,
  distributorCode,
  regionCode: "UE",
});

const brick = (brickId: string, areaCode: string): BrickRef => ({
  areaCode, areaName: `${areaCode} name`, blockCode: "B1", brickId,
  brickName: `${brickId} name`, regionCode: "UE", regionName: "Upper Egypt",
});

function crosswalks(over: Partial<Crosswalks> = {}): Crosswalks {
  return {
    areaAliasByKey: new Map(),
    areaByCode: new Map([["UE3", { areaCode: "UE3", areaName: "Assuit 1", regionCode: "UE", regionName: "Upper Egypt" }]]),
    brickById: new Map([["B133-5", brick("B133-5", "UE3")]]),
    customerBrickByCanonicalKey: new Map(),
    customerBrickByKey: new Map(),
    productAliasByKey: new Map(),
    productByCanonicalCode: new Map(),
    productByCode: new Map(),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map(),
    ...over,
  } as unknown as Crosswalks;
}

export function runMappingLookupTests() {
  // ── customer code, distributor unknown ───────────────────────────────────────────────────────

  // 1) 95.1% case: one distributor owns the code, so the distributor can be filled in for you.
  {
    const out = classifyCustomerCodeCandidates([candidate("PS", "B193-6", "D14")]);
    assert.equal(out.status, "resolved");
    assert.equal(out.candidates.length, 1);
    assert.equal(out.agreesOnArea, true);
  }

  // 2) Two distributors, SAME brick (2,612 live): the territory answer is identical, so it is safe
  //    to show — but it must NOT claim a single distributor.
  {
    const out = classifyCustomerCodeCandidates([
      candidate("IS", "B213-1", "UE5"),
      candidate("IS-S", "B213-1", "UE5"),
    ]);
    assert.equal(out.status, "resolved_multi_distributor");
    assert.equal(out.agreesOnBrick, true);
    assert.equal(out.agreesOnArea, true);
  }

  // 3) THE REFUSAL. Two distributors, different brick AND different area — 141 of these are live,
  //    e.g. code 2029 is الشفاء in UE9 under EG and شركة تيسلا in UE2 under QM. Guessing here moves a
  //    sale between governorates, so the only correct answer is "choose".
  {
    const out = classifyCustomerCodeCandidates([
      candidate("EG", "B-SHIFA", "UE9", "الشفاء - اهناسيا"),
      candidate("QM", "B-TESLA", "UE2", "شركة تيسلا المنيا"),
    ]);
    assert.equal(out.status, "choose", "different brick under two distributors must never auto-resolve");
    assert.equal(out.agreesOnBrick, false);
    assert.equal(out.agreesOnArea, false, "crossing an area is the case that moves money");
    assert.equal(out.candidates.length, 2, "both candidates must be shown so a person can tell them apart");
  }

  // 4) Different brick but the SAME area still refuses — the brick is what gets written.
  {
    const out = classifyCustomerCodeCandidates([
      candidate("IS", "B195-1", "GZ4"),
      candidate("IS-S", "B195-7", "GZ4"),
    ]);
    assert.equal(out.status, "choose");
    assert.equal(out.agreesOnArea, true);
    assert.equal(out.agreesOnBrick, false);
  }

  // 5) Not found, with the zero-variant offered SEPARATELY — never merged into candidates.
  {
    const out = classifyCustomerCodeCandidates([], [{ candidates: 1, customerCode: "0001500013", label: "with leading zeros" }]);
    assert.equal(out.status, "not_found");
    assert.equal(out.candidates.length, 0, "a variant is a suggestion, never an answer");
    assert.equal(out.variants.length, 1);
    assert.equal(out.variants[0].customerCode, "0001500013");
  }

  // 6) Leading zeros are identity. The variants are the other SPELLING of the same digits, and an
  //    alphanumeric code has none — stripping a zero off "TE001" would invent a code.
  {
    assert.deepEqual(customerCodeVariants("0001500013").sort(), ["1500013"].sort());
    assert.ok(customerCodeVariants("1500013").includes("0001500013"));
    assert.deepEqual(customerCodeVariants("TE001"), [], "alphanumeric codes must never be zero-stripped");
    assert.deepEqual(customerCodeVariants("B100-11"), []);
    assert.equal(normalizeCustomerCodeInput("  0001500013 "), "0001500013", "trim only — never re-number");
  }

  // ── territory text ───────────────────────────────────────────────────────────────────────────

  // 7) A brick alias resolves outright.
  {
    const maps = crosswalks({
      territoryAliasByKey: new Map([["الباجور", { targetCode: "B133-5", targetType: "brick" }]]),
    });
    const out = resolveTerritoryText("الباجور", maps);
    assert.equal(out.status, "brick");
    assert.equal(out.brickId, "B133-5");
    assert.equal(out.areaCode, "UE3");
  }

  // 8) No brick alias but an AREA alias: area only, brick stays an owner question. This is the
  //    live shape of كفرالدوار, which has an area alias and no brick alias.
  {
    const maps = crosswalks({
      areaAliasByKey: new Map([["كفرالدوار", { areaCode: "UE3", regionCode: "UE" }]]),
    });
    const out = resolveTerritoryText("كفرالدوار", maps);
    assert.equal(out.status, "area_only");
    assert.equal(out.areaCode, "UE3");
    assert.equal(out.areaName, "Assuit 1");
    assert.equal(out.brickId, null, "area-only must not invent a brick");
  }

  // 9) A key that pointed at two targets is dropped from the index by buildAliasIndex and parked in
  //    ambiguousAliasKeys. Say ambiguous, not unknown — Egypt reuses place names across governorates.
  {
    const maps = crosswalks({
      ambiguousAliasKeys: new Set(["الجمالية"]),
      territoryAliasByKey: new Map([["الجمالية", { targetCode: "B133-5", targetType: "brick" }]]),
    });
    const out = resolveTerritoryText("الجمالية", maps);
    assert.equal(out.status, "ambiguous", "an ambiguous key must beat a stale index hit");
    assert.equal(out.brickId, null);
  }

  // 10) Nothing at all — and the key is reported so a miss is explicable rather than mysterious.
  {
    const out = resolveTerritoryText("لا يوجد", crosswalks());
    assert.equal(out.status, "unresolved");
    assert.equal(out.key, "لا يوجد");
  }

  // 11) The key is normalizeAliasKey, which KEEPS spaces and does NOT fold ة. This is the trap that
  //     matters: phx_normalize_arabic folds ة→ه and would MANUFACTURE a hit for الخطاطبة that
  //     production never returns. Same spelling in, same key out; different ة spelling, different key.
  {
    const maps = crosswalks({
      territoryAliasByKey: new Map([["الخطاطبه", { targetCode: "B133-5", targetType: "brick" }]]),
    });
    assert.equal(resolveTerritoryText("الخطاطبه", maps).status, "brick", "the stored ه spelling resolves");
    assert.equal(
      resolveTerritoryText("الخطاطبة", maps).status,
      "unresolved",
      "the ة spelling must MISS, exactly as production does — folding it would invent an answer",
    );
    assert.equal(resolveTerritoryText("كفر الدوار", crosswalks()).key, "كفر الدوار", "spaces are kept");
  }
}
