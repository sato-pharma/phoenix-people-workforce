import assert from "node:assert/strict";

import {
  UNLOCK_INSTRUCTIONS,
  evaluateOfficeRuleLock,
  normalizeSource,
  readLockedRegion,
  runBehaviourProbe,
  stripComments,
} from "../scripts/check-office-golden-rule.ts";
import { OFFICE_GOLDEN_RULE } from "../src/lib/sales/office-golden-rule.ts";

/**
 * THE LOCK. The owner set the Office allocation rule on 2026-08-10 and locked it on 2026-08-11: it
 * may not change unless he supplies his password. This test is the enforcement — it runs inside
 * `pnpm run test`, which is the required CI `validate` check, so a PR that changes the rule cannot
 * merge.
 *
 * If this test is red and you did not mean to touch the Office rule, revert your edit. If you DID
 * mean to, the rule is his, not yours: ask him, and he runs `pnpm run office-rule:unlock`.
 */
export function runOfficeGoldenRuleLockTests() {
  // ── 1. the pins ────────────────────────────────────────────────────────────
  const report = evaluateOfficeRuleLock();

  assert.ok(
    report.clausesOk,
    `The Office golden rule lost a required clause:\n  ${report.missing.join("\n  ")}\n\n${UNLOCK_INSTRUCTIONS}`,
  );
  assert.equal(
    report.source.actual,
    report.source.pinned,
    `THE OFFICE ALLOCATION FORMULA HAS CHANGED.\nThe locked region of src/lib/sales/office-allocation.ts no longer matches its pinned fingerprint.\n  pinned ${report.source.pinned}\n  actual ${report.source.actual}\n\n${UNLOCK_INSTRUCTIONS}`,
  );
  assert.equal(
    report.behaviour.actual,
    report.behaviour.pinned,
    `THE OFFICE ALLOCATION NOW PRODUCES DIFFERENT NUMBERS.\nThe formula's own text may be untouched — something it depends on changed the result.\n  pinned ${report.behaviour.pinned}\n  actual ${report.behaviour.actual}\n\n${UNLOCK_INSTRUCTIONS}`,
  );

  // ── 2. the clauses, in numbers ─────────────────────────────────────────────
  // A fingerprint says "this changed" but not "this is still right". These read the probe's actual
  // output and assert the rule the owner stated, clause by clause, so a re-pin done for the wrong
  // reason still gets caught.
  const rows = runBehaviourProbe();
  const units = (product: string, area: string) =>
    rows.filter((r) => r.product === product && r.area === area).reduce((a, r) => a + r.units, 0);
  const value = (product: string, area: string) =>
    rows.filter((r) => r.product === product && r.area === area).reduce((a, r) => a + r.value, 0);
  const near = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) < 0.01, `${what}: expected ~${expected}, got ${actual}`);

  // The CNS line's non-Office value: V1 900x4 = 3,600 · V2 60x220 = 13,200 · V3 400x0 + 100x37.5 = 3,750.
  const cnsValue = 3_600 + 13_200 + 3_750;
  const share = { V1: 3_600 / cnsValue, V2: 13_200 / cnsValue, V3: 3_750 / cnsValue };

  // contribution-basis-value: shares come from VALUE. On UNITS, V1 would take 900/1,460 = 62% instead
  // of 18%, so this single assertion is what catches a units-weighted regression.
  near(units("CHEAP", "V1"), 5_000 * share.V1, "V1 takes its share of the line's VALUE, not its units");
  near(units("CHEAP", "V2"), 5_000 * share.V2, "V2's 60 dear units earn it the largest share");
  near(units("CHEAP", "V3"), 5_000 * share.V3, "V3's zero-priced units contribute no value");
  assert.ok(
    units("CHEAP", "V1") < units("CHEAP", "V2"),
    "the area with fewer but dearer units must take MORE office units — that is what 'by value' means",
  );

  // one-blended-share: XRARE sold only in V3, yet its office units still spread by the line's blend.
  near(units("XRARE", "V1"), 813 * share.V1, "one blended share applies to every product on the line");
  assert.ok(
    units("XRARE", "V1") > 0,
    "a product's office units must reach areas that sold none of it — the owner accepted this",
  );

  // per-line: Pedia sold only in P1, and its 90 EGP x 1,000 units would dominate a blended share.
  near(units("PEDIA", "P1"), 2_435, "every Pedia office unit stays on the Pedia line's own geography");
  assert.equal(units("PEDIA", "V1") + units("PEDIA", "V2") + units("PEDIA", "V3"), 0, "Pedia must not leak onto CNS areas");
  assert.equal(units("CHEAP", "P1"), 0, "CNS must not leak onto the Pedia area");

  // distribute-units-not-value + value-derived-last: units split by share, value = units x price.
  near(value("DEAR", "V2"), units("DEAR", "V2") * 220, "value is derived from the allocated units");
  near(value("FREE" /* not in the office file */, "V3"), 0, "a product with no office units has no value");
  near(units("DEAR", "V1") / units("CHEAP", "V1"), 137 / 5_000, "each product splits on the SAME share, whatever its price");

  // brick-split-by-units: V1's two bricks are 675:225, so 75/25 of V1's slice.
  const v1a = rows.find((r) => r.product === "CHEAP" && r.brick === "BR-1A")?.units ?? 0;
  const v1b = rows.find((r) => r.product === "CHEAP" && r.brick === "BR-1B")?.units ?? 0;
  near(v1a / (v1a + v1b), 0.75, "inside an area, bricks split on UNITS");

  // national-fallback: ORPHAN's line sold nothing, so it cannot be placed.
  near(
    rows.filter((r) => r.product === "ORPHAN" && r.region === "NATIONAL").reduce((a, r) => a + r.units, 0),
    44,
    "a line with no sales of its own goes to NATIONAL rather than borrowing geography",
  );

  // conservation: every office unit is placed exactly once.
  for (const [product, expected] of [["CHEAP", 5_000], ["DEAR", 137], ["XRARE", 813], ["PEDIA", 2_435], ["ORPHAN", 44]] as const) {
    near(
      rows.filter((r) => r.product === product).reduce((a, r) => a + r.units, 0),
      expected,
      `${product}: the office units are conserved`,
    );
  }

  // ── 3. the lock's own machinery ────────────────────────────────────────────
  // The fingerprint is only worth anything if it actually moves when the code does.
  const region = readLockedRegion();
  assert.ok(region.includes("areaValue.get(b.areaCode)"), "the locked region must contain the value accumulation");
  assert.ok(region.includes("value / totalValue"), "the locked region must contain the value share");
  assert.ok(region.includes("units * share"), "the locked region must contain the units distribution");
  assert.notEqual(
    normalizeSource(region),
    normalizeSource(region.replace("value / totalValue", "units / totalUnits")),
    "the fingerprint input must change when the formula does",
  );
  assert.equal(
    normalizeSource("const a = 1; // a comment\n/* block */ const b = 2;"),
    "const a = 1; const b = 2;",
    "comments are stripped so documentation can improve without breaking the lock",
  );
  assert.ok(
    stripComments('const s = "http://x//y"; // gone').includes("http://x//y"),
    "a // inside a string is not a comment",
  );

  // ── 4. the rule as written down ────────────────────────────────────────────
  assert.equal(OFFICE_GOLDEN_RULE.lockedOn, "2026-08-11");
  const clauseIds: string[] = OFFICE_GOLDEN_RULE.clauses.map((c) => c.id);
  for (const id of [
    "office-last",
    "per-line",
    "contribution-basis-value",
    "value-is-units-times-master-price",
    "one-blended-share",
    "distribute-units-not-value",
    "value-derived-last",
    "brick-split-by-units",
    "national-fallback",
  ]) {
    assert.ok(clauseIds.includes(id), `the written rule must still declare the "${id}" clause`);
  }
}
