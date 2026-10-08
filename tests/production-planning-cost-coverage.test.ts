import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { costCoverage } from "../src/lib/production-planning/costing.ts";
import { PP, PP_EN } from "../src/lib/production-planning/strings.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Production Planner — a cost total that means nothing must not look like zero.
 *
 * Measured on production 2026-10-09 while capturing the fit fixture: of 12 materials, **10 are on
 * the buy list and all 10 are unpriced**, so `plan.totals.costUsd` and `costEgp` are both `"0.00"`.
 * The Cost tab rendered those as its two bold figures, with "Materials with no price: 10 — the total
 * leaves out every material with no price" as an 11px grey footnote two lines below. Everything was
 * technically disclosed and the number the eye lands on still read *this costs nothing* when it
 * meant *nothing here is priced*. AGENTS.md §7 is explicit: when a source is unavailable the UI says
 * so rather than showing a misleading zero.
 *
 * ── The denominator is the whole defect ──────────────────────────────────────────────────────────
 *
 * 🔴 `totalCosts` increments `unpricedMaterials` **only** for lines where `contributesToBuyList` is
 * true. A factory-supplied material and one with no composition are skipped entirely — neither
 * priced nor counted unpriced. So the honest denominator is `toBuyCount`, never `materials`:
 * dividing by 12 would print **"2 of 12 priced"** where the truth is **"0 of 10"** — a figure wrong
 * in the reassuring direction, which is exactly the class of defect this module keeps producing.
 * That is why the arithmetic is a pure function and this test RUNS it rather than reading the JSX.
 */

const WORKSPACE = "src/components/production-planning/production-planning-workspace.tsx";

/** Comments blanked in place by the sanctioned stripper — the JSX's own prose names "0.00". */
const sourceOf = (path: string) => stripComments(readFileSync(path, "utf8"));

export function runProductionPlanningCostCoverageTests() {
  // ── The real production shape, the one this was built for ───────────────────────────────────────

  const live = costCoverage({ toBuyCount: 10, unpricedMaterials: 10 });
  assert.deepEqual(
    live,
    { priced: 0, onBuyList: 10, partial: true, none: true },
    "🔴 production 2026-10-09: 10 on the buy list, 10 unpriced — the total is meaningless, not zero",
  );

  // 🔴 The trap, stated as an assertion: the 12 materials are NOT the denominator.
  const wrong = costCoverage({ toBuyCount: 12, unpricedMaterials: 10 });
  assert.equal(wrong.priced, 2, "with 12 as the count, two look priced");
  assert.equal(live.priced, 0, "with the real buy-list count, none are");
  assert.notEqual(
    wrong.priced,
    live.priced,
    "🔴 the two differ, which is why the caller must pass toBuyCount — `materials` would have " +
      'printed "2 of 12 priced" on a plan where nothing at all is priced',
  );

  // ── Partly priced: the figure stays, and is labelled ───────────────────────────────────────────

  const partly = costCoverage({ toBuyCount: 10, unpricedMaterials: 3 });
  assert.deepEqual(partly, { priced: 7, onBuyList: 10, partial: true, none: false });
  assert.equal(partly.none, false, "a partial total is still a real figure — it is not replaced by words");

  // ── Fully priced: no notice at all ─────────────────────────────────────────────────────────────

  const whole = costCoverage({ toBuyCount: 10, unpricedMaterials: 0 });
  assert.deepEqual(whole, { priced: 10, onBuyList: 10, partial: false, none: false });

  // ── An EMPTY buy list is not "no prices" ───────────────────────────────────────────────────────
  //
  // Every material already sitting at the factory is a real and correct plan. Calling that "no
  // prices entered" would invent a problem, and a zero IS the right answer when there is nothing
  // to buy.
  const nothingToBuy = costCoverage({ toBuyCount: 0, unpricedMaterials: 0 });
  assert.deepEqual(
    nothingToBuy,
    { priced: 0, onBuyList: 0, partial: false, none: false },
    "🔴 an empty buy list shows a plain 0.00 — there is nothing to price, so nothing to warn about",
  );

  // ── Nonsense in, nothing misleading out ────────────────────────────────────────────────────────
  //
  // These cannot arise from `totalCosts`, which derives both from one loop. They are pinned because
  // the function is exported and the next caller may not be that loop.
  assert.deepEqual(
    costCoverage({ toBuyCount: 5, unpricedMaterials: 9 }),
    { priced: 0, onBuyList: 5, partial: true, none: true },
    "more unpriced than on the list clamps to zero priced, never to a NEGATIVE count",
  );
  assert.deepEqual(costCoverage({ toBuyCount: -3, unpricedMaterials: -1 }), {
    priced: 0,
    onBuyList: 0,
    partial: false,
    none: false,
  });

  // ── The screen uses it, and stops printing a bold zero ─────────────────────────────────────────

  const workspace = sourceOf(WORKSPACE);
  assert.match(
    workspace,
    /import \{ costCoverage \} from "@\/lib\/production-planning\/costing"/,
    "the coverage comes from the module's own kernel, not from arithmetic retyped in the JSX",
  );
  assert.match(
    workspace,
    /const coverage = costCoverage\(plan\.totals\)/,
    "🔴 and it is handed `plan.totals` whole, so the toBuyCount field is the one that is read — " +
      "picking fields by hand at the call site is how the wrong denominator gets back in",
  );

  // Both currency figures must be behind the same guard; one left bold is the defect half-fixed.
  const usd = workspace.indexOf("t.currencyUsd");
  const egp = workspace.indexOf("t.currencyEgp");
  assert.ok(usd >= 0 && egp >= 0, "both currency labels should be present");
  for (const [label, at] of [["USD", usd], ["EGP", egp]] as const) {
    const block = workspace.slice(at, at + 420);
    assert.match(
      block,
      /coverage\.none \? \([\s\S]*?t\.costNoPrices/,
      `🔴 the ${label} figure is replaced by words when nothing on the buy list is priced`,
    );
    assert.match(block, /formatNumberLatin\(plan\.totals\.cost(Usd|Egp)\)/, `and still shows the real ${label} figure otherwise`);
  }

  assert.match(
    workspace,
    /\{coverage\.partial \? \(/,
    "the partial notice is driven by the coverage, not by `unpricedMaterials > 0` retyped",
  );
  assert.match(
    workspace,
    /t\.costPartialTotal/,
    "🔴 and a partial total says so at a weight that can be read — the old grey 11px footnote is " +
      "what let a bold 0.00 stand unchallenged",
  );

  // The existing footnotes stay. This change adds emphasis; it must not remove disclosure.
  assert.match(workspace, /t\.costUnpriced/, "the unpriced count footnote is kept");
  assert.match(workspace, /t\.costNotWholeNotice/, "and the notice that the total is not whole");
  assert.match(workspace, /t\.costIncomplete/, "and the underivable-currency footnote");

  // ── Both catalogues, no Arabic left in the English half ────────────────────────────────────────

  for (const key of ["costNoPrices", "costPartialTotal", "costPricedOnBuyList"] as const) {
    assert.ok(PP[key] && PP[key].length > 0, `${key} is missing from the Arabic catalogue`);
    assert.ok(PP_EN[key] && PP_EN[key].length > 0, `${key} is missing from the English catalogue`);
    assert.ok(!/[؀-ۿ]/.test(PP_EN[key]), `🔴 ${key} leaves an Arabic word in an English page`);
  }
  // The replacement must not itself read as a number.
  assert.ok(!/\d/.test(PP_EN.costNoPrices), "🔴 the words that replace the figure must contain no digit");
  assert.ok(!/\d/.test(PP.costNoPrices), "in either language");

  console.log("  production planning — a structural zero is not a cost: OK");
}
