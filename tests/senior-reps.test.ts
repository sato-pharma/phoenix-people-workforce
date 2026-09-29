import assert from "node:assert/strict";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { isSeniorRep, SENIOR_REP_HR_ID_KEYS, SENIOR_REP_BADGE_LABEL } from "../src/lib/employees/senior-reps.ts";

export function runSeniorRepsTests() {
  // Aya Ibrahim (B-7) is the seed senior rep — the badge exists to highlight her.
  assert.equal(isSeniorRep("B-7"), true, "B-7 is a senior rep");
  assert.equal(isSeniorRep("b-7"), true, "casing must not matter — the roster is keyed by the canonical lower-cased id");
  assert.equal(isSeniorRep(" B-7 "), true, "surrounding whitespace is trimmed before the lookup");

  // Everyone else is NOT senior — a false positive would badge the wrong person everywhere.
  assert.equal(isSeniorRep("B-10"), false, "the owner is not a senior medical rep");
  assert.equal(isSeniorRep("B-139"), false, "another 'Aya' (Aya Ashraf, B-139) must never inherit the badge");
  assert.equal(isSeniorRep(null), false, "a missing hr id is never senior — the badge self-hides");
  assert.equal(isSeniorRep(undefined), false, "undefined is never senior");
  assert.equal(isSeniorRep(""), false, "an empty string is never senior");

  // The roster stores canonical keys, so a lookup routed through canonicalHrIdKey always matches.
  assert.equal(SENIOR_REP_HR_ID_KEYS.has(canonicalHrIdKey("B-7")!), true, "the roster holds the canonical key for B-7");
  assert.equal(SENIOR_REP_HR_ID_KEYS.has("B-7"), false, "raw upper-cased ids are NOT stored — only the canonical lower key");

  // The wording every surface renders is fixed in one place.
  assert.equal(SENIOR_REP_BADGE_LABEL, "Senior", "the badge label is the single source of the wording");
}
