import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PEDIA_POLICY_CLAUSES,
  PEDIA_POLICY_EXAMPLE_BASIC_SALARY,
  buildPediaPolicyExamples,
} from "../src/lib/incentives/pedia-policy-examples.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Pedia incentive policy written out with worked examples (owner, 2026-11-12: "in Pedia
 * incentive write the Pedia incentive policy with examples").
 *
 * Every example figure is produced by calculatePediaSplitIncentive, so these assertions pin what a
 * Pedia seat reads on the tab: if the rule ever moves, this goes red and the examples are re-read
 * before anyone is shown a number the rule no longer pays.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

export function runPediaPolicyExamplesTests() {
  const rows = buildPediaPolicyExamples();
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const get = (key: string) => {
    const row = byKey.get(key);
    assert.ok(row, `example "${key}" must exist`);
    return row;
  };

  assert.equal(PEDIA_POLICY_EXAMPLE_BASIC_SALARY, 10_000);
  assert.equal(rows.length, 8, "eight worked examples, one per branch of the rule");

  // ── 1. The owner's own example: 95% Sato reads 75% of a month, 91% total reads 55%. ─────────
  {
    const row = get("both-paid");
    assert.equal(row.satoCurvePercent, 75);
    assert.equal(row.totalCurvePercent, 55);
    assert.equal(row.satoHalfAmount, 7_500);
    assert.equal(row.totalHalfAmount, 5_500);
    assert.equal(row.payoutAmount, 13_000);
    assert.match(row.explanation, /7,500 \+ 5,500 = EGP 13,000/);
  }

  // ── 2. Every branch pays what the rule pays. ────────────────────────────────────────────────
  assert.equal(get("strong-semester").payoutAmount, 23_000, "120% Sato (130%) + 100% total (100%)");
  assert.equal(get("equal").satoHalfAmount, get("equal").totalHalfAmount, "equal achievements pay equal halves");
  assert.equal(get("equal").payoutAmount, 23_000, "110% both: 115% of a month twice");

  const satoOnly = get("sato-only");
  assert.equal(satoOnly.satoHalfAmount, 22_000, "150% Sato reads the 220% cap; total 85% unlocks it");
  assert.equal(satoOnly.totalHalfAmount, 0, "the total half keeps its own 90% floor");

  const totalOnly = get("total-only");
  assert.equal(totalOnly.satoHalfAmount, 0);
  assert.equal(totalOnly.satoHalfWithheld, false, "under 90% the curve itself pays nothing — nothing is withheld");
  assert.equal(totalOnly.payoutAmount, 7_500);

  const exactly80 = get("exactly-80");
  assert.equal(exactly80.satoHalfAmount, 10_000, "80% total exactly counts");
  assert.equal(exactly80.satoHalfWithheld, false);
  assert.equal(exactly80.payoutAmount, 10_000);

  const withheld = get("withheld");
  assert.equal(withheld.satoCurvePercent, 160, "the curve still reads 160% at 130% Sato");
  assert.equal(withheld.satoHalfWithheld, true, "total under 80% withholds the Sato half");
  assert.equal(withheld.payoutAmount, 0);
  assert.match(withheld.explanation, /not paid/);

  const cap = get("cap");
  assert.equal(cap.satoCurvePercent, 220);
  assert.equal(cap.totalCurvePercent, 220);
  assert.equal(cap.payoutAmount, 44_000, "the most a semester can pay: 220% of a month, twice");

  // ── 3. The written policy states the 80% rule and the Lacto Advanced rule. ──────────────────
  const policy = PEDIA_POLICY_CLAUSES.map((clause) => `${clause.title} ${clause.body}`).join("\n");
  assert.match(policy, /80% or more/);
  assert.match(policy, /80% exactly counts/);
  assert.match(policy, /Lacto Advanced 1 and Lacto Advanced 2 are never scored on their own/);
  assert.match(policy, /two months of basic salary/);

  // ── 4. The Pedia tab renders the card, and the card never types a figure of its own. ────────
  const dashboard = stripComments(read("src/components/employee-portal/employee-portal-dashboard.tsx"));
  const tabStart = dashboard.indexOf("function PediaIncentiveTab(");
  assert.ok(tabStart >= 0);
  const tabEnd = dashboard.indexOf("\nfunction ", tabStart + 1);
  assert.match(
    dashboard.slice(tabStart, tabEnd > tabStart ? tabEnd : undefined),
    /<PediaIncentivePolicyExamplesCard \/>/,
    "the Pedia tab must show the policy with examples",
  );
  const card = stripComments(read("src/components/employee-portal/pedia-incentive-policy-examples.tsx"));
  assert.match(card, /buildPediaPolicyExamples\(\)/, "the card reads the computed examples");
  assert.ok(!/\b(7,500|13,000|23,000|44,000)\b/.test(card), "the card must not hand-type an example amount");
}
