import assert from "node:assert/strict";

import { sumClosingRowTotal } from "@/lib/sales/monthly-closing-matrix-cells";
import { rollupAchievementByLine, type AchievementRow } from "@/lib/sales/monthly-targets";
import { totalRows } from "@/lib/sales/vs-target";
import type { MonthlyClosingCell } from "@/lib/sales/monthly-distributor-import";

/**
 * THE THREE SURFACES MUST PRINT ONE NUMBER.
 *
 * Owner ruling, 2026-09-05: "FOLLOW THE OLD MONTHLY CLOSING ... MUST BE 100% IDENTICAL". Three
 * separate modules compute an achievement percentage for the same month from the same underlying
 * facts, and each has its own fold:
 *
 *   1. the Monthly Closing        `closingAchievement`  (monthly-closing-matrix-cells.ts)
 *   2. the Targets pages          `foldAchievement`     (monthly-targets.ts)
 *   3. Sales vs Target / Business Review  `sealTotals`  (vs-target.ts)
 *
 * Every previous disagreement between these screens was one of those three drifting from another
 * while each looked correct in isolation, so matching FORMULAS by eye is what has already failed
 * twice. This file asserts the OUTPUTS are equal instead, over shapes chosen to break them apart.
 *
 * WHY A SWEEP AND NOT ONE CASE. The rules coincide exactly whenever every product carries a target
 * — which is most fixtures, and is why the divergence survived review on both occasions. The cases
 * below therefore vary the one dimension that separates them: how much untargeted money sits
 * beside the targeted money, including none at all and including a negative (a return).
 *
 * SCOPE. This is the INSIDE-a-month rule. The across-months half (a month carrying no target is
 * excluded from the numerator) has no closing equivalent to compare against here, because the
 * closing covers one month; it is pinned in tests/sales-vs-target.test.ts against the old export's
 * own "ALL MONTHS" formula.
 */

const PERIOD = "2026-08";

function closingCell(salesValue: number, targetValue: number | null): MonthlyClosingCell {
  return {
    achievement: targetValue == null || targetValue <= 0 ? null : salesValue / targetValue,
    salesUnits: 0,
    salesValue,
    targetUnits: null,
    targetValue,
  };
}

function achievementRow(salesValue: number, targetValue: number | null): AchievementRow {
  return {
    period: PERIOD,
    lineCode: "pedia",
    regionCode: "delta",
    areaCode: "MNF",
    areaState: "active",
    isOther: false,
    repSeatId: "seat-1",
    repHrId: "HR-1",
    dmSeatId: "seat-dm-1",
    dmHrId: "HR-DM-1",
    productCode: "P",
    actualUnits: 0,
    actualValue: salesValue,
    targetUnits: null,
    targetValue,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: targetValue != null && targetValue > 0,
    hasActual: true,
  };
}

/** One month's facts as (sales, target) pairs — target null means "nobody set one". */
type Facts = ReadonlyArray<readonly [number, number | null]>;

const CASES: ReadonlyArray<{ name: string; facts: Facts; expect: number | null }> = [
  {
    name: "every product targeted — the shape where all rules agree anyway",
    facts: [[400, 500], [600, 500]],
    expect: 1,
  },
  {
    name: "the MIXED shape — targeted and untargeted money on the same line",
    facts: [[400, 1_000], [600, null]],
    expect: 1,
  },
  {
    name: "mostly untargeted — the reading the two rules disagree on most violently",
    facts: [[50, 100], [900, null]],
    expect: 9.5,
  },
  {
    name: "an untargeted RETURN lowers the grade rather than being ignored",
    facts: [[500, 1_000], [-30, null]],
    expect: 0.47,
  },
  {
    name: "no target anywhere is null, never 0%",
    facts: [[9_000, null]],
    expect: null,
  },
  {
    name: "Anti Infective August 2026, as production actually holds it",
    facts: [[449_969.15, 1_502_621.98], [27_529.8, null]],
    expect: 477_498.95 / 1_502_621.98,
  },
];

const near = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.abs(a - b) < 1e-9;

export function runClosingAndTargetsAgreeTests(): void {
  for (const { name, facts, expect } of CASES) {
    // 1 — the Monthly Closing's own arithmetic, over its own cell type.
    const closing = sumClosingRowTotal(facts.map(([sales, target]) => closingCell(sales, target))).achievement;

    // 2 — the Targets pages' fold.
    const targets = rollupAchievementByLine(facts.map(([sales, target]) => achievementRow(sales, target)))[0]
      ?.achievementValue ?? null;

    // 3 — Sales vs Target / Business Review, one month so the window rule is a no-op.
    const vsTarget = totalRows(facts.map(([sales, target]) => achievementRow(sales, target))).achievementValue;

    assert.ok(near(closing, expect), `${name}: the CLOSING must read ${expect}, got ${closing}`);
    assert.ok(
      near(targets, closing),
      `${name}: the Targets pages read ${targets} where the closing reads ${closing}. `
        + `These are the same month and the same money — owner ruling 2026-09-05, they must be identical.`,
    );
    assert.ok(
      near(vsTarget, closing),
      `${name}: Sales vs Target reads ${vsTarget} where the closing reads ${closing}. `
        + `Same month, same money — they must be identical.`,
    );
  }

  // The sweep above would pass vacuously if every case happened to have no untargeted money, so
  // prove the fixtures actually exercise the dimension that separates the rules: at least one case
  // must grade DIFFERENTLY under the retired covered-actual rule.
  const separating = CASES.filter(({ facts }) => {
    const target = facts.reduce((sum, [, t]) => sum + (t ?? 0), 0);
    if (target === 0) return false;
    const all = facts.reduce((sum, [s]) => sum + s, 0);
    const covered = facts.reduce((sum, [s, t]) => sum + (t != null && t > 0 ? s : 0), 0);
    return Math.abs(all - covered) > 1e-9;
  });
  assert.ok(
    separating.length >= 4,
    `at least four cases must carry untargeted money, or this file cannot tell the two rules apart `
      + `and would pass under either. Found ${separating.length}.`,
  );
}
