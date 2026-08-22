import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  rollupAchievementByDm,
  rollupAchievementByLine,
  rollupAchievementByRegion,
  rollupAchievementByRep,
  type AchievementRow,
} from "@/lib/sales/monthly-targets";

/**
 * The Targets pages (admin `/sales/targets` and portal `/employee-portals/targets`) both roll
 * `au.f_monthly_achievement` rows up to line, region and DM through one shared fold. That fold
 * divided the FULL sales figure by the COVERED target — crediting a seat with revenue its target
 * never asked for.
 *
 * Measured against production (ozucdzovmcqvepbozvqf) on 2026-08-23, before the fix:
 *
 *   Pedia    2026-02   read 67.99%   means 35.71%
 *   Pedia    2026-01   read 50.07%   means 35.47%
 *   Anti-inf 2026-02   read 94.30%   means 71.09%
 *   Anti-inf 2026-07   read 85.12%   means 60.41%
 *   CNS      2026-07   read 64.51%   means 59.00%
 *   one DM   2026-07   read 48.50%   means  2.20%   <- 46 points, almost all of it untargeted
 *
 * It is invisible wherever every product carries a target, because there the two formulas are
 * arithmetically identical. That is why it survived review, and it is why the fixtures below
 * deliberately mix covered and uncovered rows on the same key.
 */

const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

function row(over: Partial<AchievementRow> = {}): AchievementRow {
  return {
    period: "2026-07",
    lineCode: "pedia",
    regionCode: "delta",
    areaCode: "MNF",
    areaState: "active",
    isOther: false,
    repSeatId: "seat-rep-1",
    repHrId: "HR-REP-1",
    dmSeatId: "seat-dm-1",
    dmHrId: "HR-DM-1",
    productCode: "P1",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: true,
    ...over,
  };
}

/** A key with a target of 100 delivering 40, plus 60 of sales nobody set a target for. */
const MIXED: AchievementRow[] = [
  row({ productCode: "COVERED", actualValue: 40, actualUnits: 4, targetValue: 100, targetUnits: 10, hasTarget: true }),
  row({ productCode: "UNCOVERED", actualValue: 60, actualUnits: 6, targetValue: null, targetUnits: null, hasTarget: false }),
];

export function runTargetsRollupAchievementTests(): void {
  // ── 1. The core arithmetic, on every rollup the pages call ──────────────────
  // 40 of 100 is 40%. The broken fold read (40+60)/100 = 100% — a seat that missed its
  // target by 60% rendered as having exactly hit it.
  for (const [name, rollup] of [
    ["line", rollupAchievementByLine],
    ["DM", rollupAchievementByDm],
    ["rep", rollupAchievementByRep],
  ] as const) {
    const [total] = rollup(MIXED);
    assert.ok(total, `the ${name} rollup must produce a total`);
    assert.equal(total.achievementValue, 0.4, `the ${name} rollup must divide COVERED sales by target, not all sales`);
    assert.notEqual(total.achievementValue, 1, `the ${name} rollup must not credit untargeted sales toward the grade`);
    assert.equal(total.coveredActualValue, 40, `the ${name} rollup must carry the graded slice`);
    assert.equal(total.actualValue, 100, `the ${name} rollup must still report the FULL sales value`);
    assert.equal(total.targetValue, 100, `the ${name} rollup must sum targets`);
  }

  // The region rollup carries clean codes alongside the same corrected arithmetic.
  const [region] = rollupAchievementByRegion(MIXED);
  assert.equal(region.achievementValue, 0.4, "the region rollup must divide covered sales by target");
  assert.equal(region.coveredActualValue, 40);
  assert.equal(region.lineCode, "pedia", "the region rollup must keep the clean line code");
  assert.equal(region.regionCode, "delta", "the region rollup must keep the clean region code");

  // ── 2. Units are covered the same way ──────────────────────────────────────
  const [units] = rollupAchievementByLine(MIXED);
  assert.equal(units.coveredActualUnits, 4, "covered units must exclude the untargeted row");
  assert.equal(units.actualUnits, 10, "the full unit figure must survive alongside it");

  // ── 3. Uncovered returns make covered LARGER than actual — do not clamp ────
  // CNS January 2026 is this shape in production: an untargeted credit note drags the full
  // actual below the graded slice. A `Math.min(covered, actual)` "sanity" clamp would silently
  // understate the grade, so assert the two are independent.
  const withReturns = rollupAchievementByLine([
    row({ productCode: "COVERED", actualValue: 500, targetValue: 1000, hasTarget: true }),
    row({ productCode: "RETURNED", actualValue: -30, targetValue: null, hasTarget: false }),
  ])[0];
  assert.equal(withReturns.coveredActualValue, 500, "an uncovered return must not touch the graded slice");
  assert.equal(withReturns.actualValue, 470, "the full figure must absorb the return");
  assert.ok(withReturns.coveredActualValue > withReturns.actualValue, "covered may legitimately exceed actual");
  assert.equal(withReturns.achievementValue, 0.5, "the grade divides covered by target regardless");

  // ── 4. No target is null, never 0% ─────────────────────────────────────────
  // A month with sales and no target loaded (Mar–Jun 2026 across the whole company) must not
  // render as a zero — the owner's standing rule, and the difference between "not measured"
  // and "measured and failed".
  const noTarget = rollupAchievementByLine([row({ actualValue: 9_000, targetValue: null, hasTarget: false })])[0];
  assert.equal(noTarget.achievementValue, null, "no target must grade as null");
  assert.notEqual(noTarget.achievementValue, 0, "no target must NOT grade as 0%");
  assert.equal(noTarget.actualValue, 9_000, "the sales value must survive an ungraded month");
  assert.equal(noTarget.coveredActualValue, 0, "nothing is covered when nothing has a target");

  // ── 5. Rows with no grouping key are skipped, not folded into a phantom ────
  const noKey = rollupAchievementByDm([row({ dmHrId: null, actualValue: 999, targetValue: 999, hasTarget: true })]);
  assert.equal(noKey.length, 0, "a row with no DM must not create a keyless rollup entry");

  // ── 6. Each key is graded on its own rows ─────────────────────────────────
  const twoDms = rollupAchievementByDm([
    row({ dmHrId: "HR-A", actualValue: 50, targetValue: 100, hasTarget: true }),
    row({ dmHrId: "HR-A", actualValue: 900, targetValue: null, hasTarget: false }),
    row({ dmHrId: "HR-B", actualValue: 80, targetValue: 100, hasTarget: true }),
  ]);
  const byKey = new Map(twoDms.map((entry) => [entry.key, entry]));
  assert.equal(byKey.get("HR-A")?.achievementValue, 0.5, "900 of untargeted sales must not lift HR-A to 950%");
  assert.equal(byKey.get("HR-B")?.achievementValue, 0.8, "HR-B must be unaffected by HR-A's rows");

  // ── 7. The production shape that was actually wrong ───────────────────────
  // Pedia, February 2026: 2,236,878 of sales, 1,174,871 of it against a target of 3,290,095.
  const pediaFeb = rollupAchievementByLine([
    row({ period: "2026-02", productCode: "COVERED", actualValue: 1_174_871, targetValue: 3_290_095, hasTarget: true }),
    row({ period: "2026-02", productCode: "UNCOVERED", actualValue: 1_062_007, targetValue: null, hasTarget: false }),
  ])[0];
  const pct = (value: number | null) => (value == null ? null : Math.round(value * 10_000) / 100);
  assert.equal(pct(pediaFeb.achievementValue), 35.71, "Pedia February 2026 must grade 35.71%");
  assert.notEqual(pct(pediaFeb.achievementValue), 67.99, "67.99% is the defect this test exists to stop");

  // ── 8. Source guards: the fix must stay fixed, and stay legible ───────────
  const lib = flat(SRC("src/lib/sales/monthly-targets.ts"));
  assert.ok(
    lib.includes("total.achievementValue = total.targetValue !== 0 ? total.coveredActualValue / total.targetValue : null;"),
    "foldAchievement must divide coveredActualValue by targetValue",
  );
  assert.ok(
    !lib.includes("total.achievementValue = total.targetValue !== 0 ? total.actualValue / total.targetValue : null;"),
    "the all-sales numerator must not come back",
  );
  assert.ok(
    lib.includes("if (row.hasTarget) { current.coveredActualValue += row.actualValue;"),
    "covered must accumulate only on rows that carry a target",
  );

  // Both pages must thread the graded slice into the UI, or the card shows an Actual and a
  // Target that do not divide into the Achievement printed beside them.
  for (const page of ["app/(admin)/sales/targets/page.tsx", "app/employee-portals/targets/page.tsx"]) {
    const src = flat(SRC(page));
    assert.ok(src.includes("coveredActualValue: line.coveredActualValue"), `${page} must pass the line's graded slice`);
    // COUNTED, not merely present: each page maps TWO rollups (by region and by DM). An
    // `includes` check passes while one of them silently stops threading the graded slice,
    // which leaves that card's percentage with no way to explain itself. Caught exactly this
    // way — the first draft of this assertion survived deleting the DM mapping.
    const threaded = src.split("coveredActualValue: entry.coveredActualValue").length - 1;
    assert.equal(threaded, 2, `${page} must pass the graded slice for BOTH the region and the DM rollup`);
    // Both pages used to hand-restate the workspace's prop shapes as inline `let` annotations,
    // which went stale the instant the component gained a field — CI caught exactly that on
    // c9de5e83. Importing the component's own types makes the drift impossible instead of
    // merely fixed, so pin the import rather than trusting the next author to remember.
    assert.ok(
      /import \{[^}]*type LineTotal[^}]*\} from "@\/components\/sales\/targets-workspace"/.test(src),
      `${page} must import LineTotal from the workspace, not restate its shape`,
    );
    assert.ok(
      !/let lineTotal: \{/.test(src),
      `${page} must not declare an inline lineTotal shape that can drift from the component`,
    );
  }

  // The Monthly Closing analytics dashboards roll the SAME engine up to (period, line, rep) in
  // their own loader, and carried the identical defect. It is IO-bound so it cannot be exercised
  // here directly; pin it at source instead. Measured impact was far smaller than the Targets
  // pages (4.1 points at worst, because a rep with untargeted sales usually still holds a target
  // for that line) but the formula was equally wrong.
  const analytics = flat(SRC("src/lib/analytics/service.ts"));
  assert.ok(
    analytics.includes("b.hasTarget && b.targetValue > 0 ? round2((b.coveredSalesValue / b.targetValue) * 100) : null"),
    "the analytics rep rollup must divide COVERED sales by target",
  );
  assert.ok(
    !analytics.includes("round2((b.salesValue / b.targetValue) * 100)"),
    "the analytics rep rollup must not divide ALL sales by target",
  );
  assert.ok(
    analytics.includes("if (r.target_value != null) { bucket.coveredSalesValue += n(r.actual_value);"),
    "covered sales must accumulate only inside the branch that found a target",
  );

  const workspace = flat(SRC("src/components/sales/targets-workspace.tsx"));
  assert.ok(
    workspace.includes("props.lineTotal.coveredActualValue !== props.lineTotal.actualValue"),
    "the Line total card must show the graded figure whenever it differs from the actual",
  );
  assert.ok(workspace.includes("Graded vs target:"), "the graded figure needs a label a manager can read");
  assert.ok(
    workspace.includes("title={divisionHint(region.coveredActualValue, region.targetValue)}") &&
      workspace.includes("title={divisionHint(dm.coveredActualValue, dm.targetValue)}"),
    "the region and DM percentages must expose the division behind them",
  );
}
