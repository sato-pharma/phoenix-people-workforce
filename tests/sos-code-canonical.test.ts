import assert from "node:assert/strict";

import { numericCanonicalKey, resolveBrick, resolveProduct } from "../src/lib/sales/normalizer/resolvers.ts";
import type { Crosswalks } from "../src/lib/sales/normalizer/types.ts";

function canonicalKeyRules() {
  assert.equal(numericCanonicalKey("0001502731"), "1502731", "strips leading zeros");
  assert.equal(numericCanonicalKey("1502731"), "1502731", "no-op when already canonical");
  assert.equal(numericCanonicalKey(" 0001502731 "), "1502731", "trims then canonicalizes");
  assert.equal(numericCanonicalKey("000"), "0", "all-zeros collapses to single zero");
  assert.equal(numericCanonicalKey("TE001"), null, "alphanumeric product code is NOT collapsed");
  assert.equal(numericCanonicalKey("B100-11"), null, "brick code with separators is NOT collapsed");
  assert.equal(numericCanonicalKey(""), null);
  assert.equal(numericCanonicalKey(null), null);
}

const baseMaps = (): Crosswalks => ({
  brickById: new Map([["B1", { areaCode: "A1", areaName: "Area One", blockCode: "BL1", brickId: "B1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" }]]),
  areaByCode: new Map(),
  regionByCode: new Map(),
  productByCode: new Map([["0123", { productCode: "0123", productName: "Padded Product", factoryPrice: 5, line: "X" }]]),
  productAliasByKey: new Map(),
  territoryAliasByKey: new Map(),
  areaAliasByKey: new Map(),
  regionAliasByKey: new Map(),
  customerBrickByKey: new Map([["PS 0001502731", "B1"]]),
  customerBrickByCanonicalKey: new Map([["PS 1502731", "B1"]]),
  productByCanonicalCode: new Map([["123", "0123"]]),
});

// The customer was saved zero-padded ("0001502731") but the new sheet read the code as a number
// ("1502731"). Exact key misses; the numeric-canonical fallback must still resolve the brick.
function customerCanonicalFallbackResolves() {
  const maps = baseMaps();
  const res = resolveBrick({ customerKey: "PS 1502731", customerCanonicalKey: "PS 1502731" }, maps);
  assert.ok(res, "leading-zero-dropped customer code still resolves via canonical fallback");
  assert.equal(res!.brickId, "B1");
  assert.equal(res!.source, "customer");
}

// Exact key must still win without needing the canonical fallback (no regression).
function exactKeyStillResolves() {
  const maps = baseMaps();
  const res = resolveBrick({ customerKey: "PS 0001502731", customerCanonicalKey: "PS 1502731" }, maps);
  assert.ok(res);
  assert.equal(res!.brickId, "B1");
}

function productCanonicalFallbackResolves() {
  const maps = baseMaps();
  // direct exact match
  assert.equal(resolveProduct(["0123"], maps, "PS"), "0123");
  // number-vs-text drift: "123" canonicalizes to the padded master code "0123"
  assert.equal(resolveProduct(["123"], maps, "PS"), "0123");
  // genuinely unknown stays unresolved
  assert.equal(resolveProduct(["999"], maps, "PS"), null);
}

export function runSosCodeCanonicalTests() {
  canonicalKeyRules();
  customerCanonicalFallbackResolves();
  exactKeyStillResolves();
  productCanonicalFallbackResolves();
}
