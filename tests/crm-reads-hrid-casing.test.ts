import assert from "node:assert/strict";

import { expandHrIdFilterValues } from "../src/lib/crm/reads.ts";
import { hrIdLookupKeys } from "../src/lib/hr-id.ts";

/**
 * Fix #7 — the CRM read door makes its `agent_hr_id`/`double_hr_id` list filters case-insensitive
 * by expanding every input id to all casing/alias variants before the case-SENSITIVE PostgREST
 * `.in(...)`. These tests pin the pure expansion so a future refactor can't silently make the door
 * case-sensitive again (which previously forced every consumer to spray variants itself).
 */
export function runCrmReadsHrIdCasingTests() {
  // A lowercase caller id must still surface the UPPERCASE-stored variant (the mirror's assumed
  // casing) — that is the whole point of the fix.
  const expanded = expandHrIdFilterValues(["b-100"]);
  assert.ok(expanded.includes("b-100"), "keeps the raw lowercase form");
  assert.ok(expanded.includes("B-100"), "adds the UPPERCASE form the mirror stores");

  // An UPPERCASE caller id must also surface the lowercase form (works both directions).
  const fromUpper = expandHrIdFilterValues(["A-12"]);
  assert.ok(fromUpper.includes("A-12"), "keeps the raw upper form");
  assert.ok(fromUpper.includes("a-12"), "adds the lowercase form");

  // Legacy alias fold (aaa -> aa) is covered because expansion delegates to hrIdLookupKeys.
  const alias = expandHrIdFilterValues(["AAA"]);
  assert.ok(alias.includes("aa") || alias.includes("AA"), "folds the aaa->aa legacy alias");

  // Exactly the de-duped union of hrIdLookupKeys over the inputs — no more, no less.
  const multi = expandHrIdFilterValues(["b-100", "B-100", "a-12"]);
  const expected = Array.from(new Set(["b-100", "B-100", "a-12"].flatMap((id) => hrIdLookupKeys(id))));
  assert.deepEqual([...multi].sort(), [...expected].sort(), "is the de-duped union of hrIdLookupKeys");

  // Empty input → empty output (the callers guard empty arrays before this runs, but stay safe).
  assert.deepEqual(expandHrIdFilterValues([]), [], "empty in → empty out");
}
