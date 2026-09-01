import assert from "node:assert/strict";

import {
  INSURANCE_WAGE_CEILING,
  INSURANCE_WAGE_DIVISOR,
  STATUTORY_BASIC_WAGE,
  insuranceWageFromBase,
} from "../src/lib/hiring-pack/insurance-wage.ts";

// The Form 1 insurance-wage rule, pinned to the owner's own worked example.
//
// OWNER SETUP — Yasmen, given 2026-09-01 as the setup "the rule" should be based on:
//   الأجر الشامل (base)       = 18,000   → the divisor's input (the header equates الشامل with base)
//   أجر الاشتراك (insurance)  = 13,846   → 18,000 ÷ 1.3, under the ceiling
//   الأجر الأساسي (statutory) = 2,450    → the flat basic wage, the SAME figure for every employee
//
// These three figures reproduce `insurance-wage.ts` exactly, so this test changes no behaviour — it
// locks the rule down so a later "tidy" of the divisor, the ceiling, the flat basic, or the rounding
// cannot move a figure the insurance office files without turning a registered test red. It is a
// PRINTING rule: nothing here reads or writes `employees.social_insurance_wage`.
export function runHiringPackInsuranceWageTests() {
  // The three constants the owner named, verbatim.
  assert.equal(INSURANCE_WAGE_DIVISOR, 1.3, "insurance-wage divisor is 1.3");
  assert.equal(INSURANCE_WAGE_CEILING, 16_700, "insurance-wage ceiling is 16,700");
  assert.equal(STATUTORY_BASIC_WAGE, 2_450, "flat statutory basic wage is 2,450");

  // Yasmen — the headline case. 18,000 ÷ 1.3 = 13,846.15 → 13,846, below the 16,700 ceiling.
  assert.equal(insuranceWageFromBase(18_000), 13_846, "Yasmen: base 18,000 declares an insurance wage of 13,846");

  // The rule module's own worked example: base 11,000 → 8,462 (11,000 ÷ 1.3 = 8,461.54 → 8,462).
  assert.equal(insuranceWageFromBase(11_000), 8_462, "base 11,000 declares 8,462");

  // A sub-ceiling base rounds through the divisor, proving the cap is a live min() and not a floor
  // that swallows everything: 20,000 ÷ 1.3 = 15,384.6 → 15,385, still below 16,700.
  assert.equal(insuranceWageFromBase(20_000), 15_385, "base 20,000 declares 15,385 (divisor path, not clamped)");

  // The ceiling binds. 90,000 ÷ 1.3 = 69,231, which the insurance office will not accept — it clamps.
  assert.equal(insuranceWageFromBase(90_000), INSURANCE_WAGE_CEILING, "a high base clamps to the ceiling");
  // Exactly on the boundary: 16,700 × 1.3 = 21,710 declares the ceiling, and one pound over stays there.
  assert.equal(insuranceWageFromBase(21_710), INSURANCE_WAGE_CEILING, "base at 16,700×1.3 sits exactly on the ceiling");
  assert.equal(insuranceWageFromBase(21_711), INSURANCE_WAGE_CEILING, "one pound over the boundary stays clamped");

  // A missing or unusable base prints a blank (null), never an invented figure — the contract then
  // shows its dotted rule and the fill screen's missing-field warning stands.
  assert.equal(insuranceWageFromBase(null), null, "null base → null");
  assert.equal(insuranceWageFromBase(0), null, "zero base → null");
  assert.equal(insuranceWageFromBase(-1), null, "negative base → null");
  assert.equal(insuranceWageFromBase(Number.NaN), null, "NaN base → null");
}
