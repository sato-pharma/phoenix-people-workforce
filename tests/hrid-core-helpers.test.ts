import assert from "node:assert/strict";
import {
  canonicalHrIdForDisplay,
  canonicalHrIdKey,
  formatHrIdForDisplay,
  hrIdLookupKeys,
  hrIdsMatch,
  resolveStoredHrId,
} from "../src/lib/hr-id.ts";

// src/lib/hr-id.ts's own exported helpers had no direct unit test: hrid-alias-normalization.test.ts
// exercises other modules' *usage* of them (hierarchy-governance.ts, seat-lifecycle.ts) but never
// calls canonicalHrIdKey/hrIdsMatch/hrIdLookupKeys/resolveStoredHrId/formatHrIdForDisplay directly.
export function runHrIdCoreHelpersTests() {
  assert.equal(canonicalHrIdKey("AAA"), "aa", "the legacy AAA alias resolves to canonical aa");
  assert.equal(canonicalHrIdKey(null), null, "a null/empty value has no canonical key");
  assert.equal(canonicalHrIdForDisplay("aaa"), "AA", "display form is the canonical key, upper-cased");

  assert.equal(hrIdsMatch("AAA", "AA"), true, "alias and canonical form match");
  assert.equal(hrIdsMatch("A-9", "a9"), true, "hyphen/case drift still matches via the symbol-stripped fallback");
  assert.equal(hrIdsMatch(null, "AA"), false, "a null side never matches");

  assert.deepEqual(
    hrIdLookupKeys("AAA"),
    ["AAA", "aaa", "aa", "AA"],
    "lookup keys cover raw/lower/upper plus the canonical alias, deduped",
  );

  assert.equal(
    resolveStoredHrId("aaa", new Map([["aa", { hrId: "AA-CEO" }]])),
    "AA-CEO",
    "prefers the actually-stored HR_ID over the display fallback",
  );
  assert.equal(
    resolveStoredHrId("aaa", undefined),
    "AA",
    "falls back to canonical display form when nothing is stored",
  );

  assert.equal(formatHrIdForDisplay(" a-9 "), "A-9", "trims and upper-cases for display");
  assert.equal(formatHrIdForDisplay(null), null, "no value displays as null, not a literal string");
}
