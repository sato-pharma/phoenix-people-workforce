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
 * `au.f_monthly_achievement` rows up to line, region and DM through one shared fold, and that fold
 * must produce the number the MONTHLY CLOSING produces for the same line and month.
 *
 * Owner ruling, 2026-09-05, asked twice and answered twice: "THE OLD CLOSING IS THE CORRECT ONE",
 * then "FOLLOW THE OLD MONTHLY CLOSING ... MUST BE 100% IDENTICAL". So achievement here is ALL of a
 * group's sales over the target it was given — `closingAchievement` in monthly-closing-matrix-cells.ts
 * — and this file pins that, having previously pinned the opposite.
 *
 * WHAT CHANGED AND WHY IT IS NOT A REGRESSION. Between 2026-08-23 and 2026-09-05 this fold divided
 * the COVERED sales (only the money on a key that carried a target), on the reasoning that a seat
 * should not be credited with revenue its target never asked for. That reasoning still holds for a
 * page that GRADES A PERSON, and it is still in force in Business Review's window arithmetic — but
 * these pages sit beside the closing and were quoting a different number for the same month:
 *
 *   Pedia    2026-02   closing 67.99%   this page read 35.71%
 *   Pedia    2026-01   closing 50.07%   this page read 35.47%
 *   Anti-inf 2026-07   closing 42.55%   this page read 29.52%   (re-measured 2026-09-05)
 *   one DM   2026-07   closing 48.50%   this page read  2.20%
 *
 * The owner chose the closing's number in every one of those rows.
 *
 * `loadMonthlyAchievement` takes ONE period, so the across-months half of the closing's rule (only
 * months that carry a target may be graded) cannot arise here. That half lives in vs-target.ts and
 * is pinned by tests/business-review-achievement-arithmetic.test.ts.
 *
 * The two formulas are arithmetically identical wherever every product carries a target, which is
 * why this file's fixtures deliberately mix covered and uncovered rows on the same key — without
 * that mix nothing here can tell the rules apart, in either direction.
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
  // 100 of sales against a target of 100 is 100%, untargeted money included — which is exactly
  // what the Closing Matrix prints for the same line and month. The covered-only reading of this
  // same fixture is 40%, and that is now the number this test exists to keep OUT.
  for (const [name, rollup] of [
    ["line", rollupAchievementByLine],
    ["DM", rollupAchievementByDm],
    ["rep", rollupAchievementByRep],
  ] as const) {
    const [total] = rollup(MIXED);
    assert.ok(total, `the ${name} rollup must produce a total`);
    assert.equal(total.achievementValue, 1, `the ${name} rollup must divide ALL sales by target — the closing's own division`);
    assert.notEqual(total.achievementValue, 0.4, `the ${name} rollup must not fall back to the covered-only numerator`);
    assert.equal(total.actualValue, 100, `the ${name} rollup must report the FULL sales value`);
    assert.equal(total.targetValue, 100, `the ${name} rollup must sum targets`);
    // Still accumulated, still shown on the card — as coverage, never again as the numerator.
    assert.equal(total.coveredActualValue, 40, `the ${name} rollup must still carry coverage beside the grade`);
  }

  // The region rollup carries clean codes alongside the same arithmetic.
  const [region] = rollupAchievementByRegion(MIXED);
  assert.equal(region.achievementValue, 1, "the region rollup must divide all sales by target");
  assert.equal(region.coveredActualValue, 40);
  assert.equal(region.lineCode, "pedia", "the region rollup must keep the clean line code");
  assert.equal(region.regionCode, "delta", "the region rollup must keep the clean region code");

  // ── 2. Coverage is still measured, in units too ────────────────────────────
  const [units] = rollupAchievementByLine(MIXED);
  assert.equal(units.coveredActualUnits, 4, "covered units must still exclude the untargeted row");
  assert.equal(units.actualUnits, 10, "the full unit figure must survive alongside it");

  // ── 3. Returns are negative sales and must not be clamped away ─────────────
  // CNS January 2026 is this shape in production: an untargeted credit note drags the full actual
  // BELOW the covered slice, so covered can legitimately exceed actual. The grade now divides the
  // actual, which means the return correctly reduces it — 470 of 1,000, not 500 of 1,000.
  const withReturns = rollupAchievementByLine([
    row({ productCode: "COVERED", actualValue: 500, targetValue: 1000, hasTarget: true }),
    row({ productCode: "RETURNED", actualValue: -30, targetValue: null, hasTarget: false }),
  ])[0];
  assert.equal(withReturns.actualValue, 470, "the full figure must absorb the return");
  assert.equal(withReturns.coveredActualValue, 500, "an uncovered return must not touch the coverage figure");
  assert.ok(withReturns.coveredActualValue > withReturns.actualValue, "covered may legitimately exceed actual — never clamp it");
  assert.equal(withReturns.achievementValue, 0.47, "the grade divides the actual, so an untargeted return lowers it");

  // ── 4. No target is null, never 0% ─────────────────────────────────────────
  // A month with sales and no target loaded (Mar–Jun 2026 across the whole company) must not
  // render as a zero. Only the NUMERATOR moved on 2026-09-05; this is untouched, and is the same
  // rule the closing follows when it prints "no target" rather than 0%.
  const noTarget = rollupAchievementByLine([row({ actualValue: 9_000, targetValue: null, hasTarget: false })])[0];
  assert.equal(noTarget.achievementValue, null, "no target must grade as null");
  assert.notEqual(noTarget.achievementValue, 0, "no target must NOT grade as 0%");
  assert.equal(noTarget.actualValue, 9_000, "the sales value must survive an ungraded month");
  assert.equal(noTarget.coveredActualValue, 0, "nothing is covered when nothing has a target");

  // ── 5. Rows with no grouping key are skipped, not folded into a phantom ────
  const noKey = rollupAchievementByDm([row({ dmHrId: null, actualValue: 999, targetValue: 999, hasTarget: true })]);
  assert.equal(noKey.length, 0, "a row with no DM must not create a keyless rollup entry");

  // ── 6. Each key is graded on its own rows ─────────────────────────────────
  // HR-A now reads 950%, and that is the intended consequence of the owner's ruling rather than an
  // oversight: 950 of sales against the 100 that was targeted is what the closing prints for that
  // shape. Asserted explicitly so nobody "fixes" it back on sight.
  const twoDms = rollupAchievementByDm([
    row({ dmHrId: "HR-A", actualValue: 50, targetValue: 100, hasTarget: true }),
    row({ dmHrId: "HR-A", actualValue: 900, targetValue: null, hasTarget: false }),
    row({ dmHrId: "HR-B", actualValue: 80, targetValue: 100, hasTarget: true }),
  ]);
  const byKey = new Map(twoDms.map((entry) => [entry.key, entry]));
  assert.equal(byKey.get("HR-A")?.achievementValue, 9.5, "950 of sales over a 100 target is 950% — the closing's arithmetic");
  assert.equal(byKey.get("HR-B")?.achievementValue, 0.8, "HR-B must be unaffected by HR-A's rows");

  // ── 7. The production shape, now agreeing with the closing ────────────────
  // Pedia, February 2026: 2,236,878 of sales, 1,174,871 of it against a target of 3,290,095. The
  // closing prints 67.99% for that month and so, now, does this page.
  const pediaFeb = rollupAchievementByLine([
    row({ period: "2026-02", productCode: "COVERED", actualValue: 1_174_871, targetValue: 3_290_095, hasTarget: true }),
    row({ period: "2026-02", productCode: "UNCOVERED", actualValue: 1_062_007, targetValue: null, hasTarget: false }),
  ])[0];
  const pct = (value: number | null) => (value == null ? null : Math.round(value * 10_000) / 100);
  assert.equal(pct(pediaFeb.achievementValue), 67.99, "Pedia February 2026 must read 67.99% — the Monthly Closing's own figure");
  assert.notEqual(pct(pediaFeb.achievementValue), 35.71, "35.71% is the covered-only reading the owner ruled against");

  // ── 8. Source guards: the rule must stay put, and stay legible ────────────
  const lib = flat(SRC("src/lib/sales/monthly-targets.ts"));
  assert.ok(
    lib.includes("total.achievementValue = total.targetValue !== 0 ? total.actualValue / total.targetValue : null;"),
    "foldAchievement must divide actualValue by targetValue",
  );
  assert.ok(
    !lib.includes("total.achievementValue = total.targetValue !== 0 ? total.coveredActualValue / total.targetValue : null;"),
    "the covered-only numerator must not come back — the owner ruled against it on 2026-09-05",
  );
  assert.ok(
    lib.includes("if (row.hasTarget) { current.coveredActualValue += row.actualValue;"),
    "coverage must still accumulate only on rows that carry a target",
  );

  // The PORTAL page still threads the coverage figure into the UI. It no longer explains the
  // percentage — Actual over Target does that now — but it is what tells a manager how much of the
  // line was targeted at all, which is the first thing asked when a percentage looks surprising.
  //
  // The ADMIN page was in this loop until 2026-09-08 and is deliberately no longer. The owner took
  // achievement off the authoring tab entirely ("I don't need to see achievement in this tab"), so
  // it has no roll-ups, no coverage figure and no LineTotal left to thread. Its half of this
  // guarantee is the assertion BELOW — that it carries none of this — rather than a check for
  // wiring the screen is not allowed to have. Removing a page from the loop without pinning the
  // reason is how a deliberate deletion becomes indistinguishable from a regression.
  for (const page of ["app/employee-portals/targets/page.tsx"]) {
    const src = flat(SRC(page));
    assert.ok(src.includes("coveredActualValue: line.coveredActualValue"), `${page} must pass the line's coverage figure`);
    // COUNTED, not merely present: each page maps TWO rollups (by region and by DM). An `includes`
    // check passes while one of them silently stops threading it. Caught exactly this way — the
    // first draft of this assertion survived deleting the DM mapping.
    const threaded = src.split("coveredActualValue: entry.coveredActualValue").length - 1;
    assert.equal(threaded, 2, `${page} must pass coverage for BOTH the region and the DM rollup`);
    assert.ok(
      /import \{[^}]*type LineTotal[^}]*\} from "@\/components\/sales\/targets-workspace"/.test(src),
      `${page} must import LineTotal from the workspace, not restate its shape`,
    );
    assert.ok(
      !/let lineTotal: \{/.test(src),
      `${page} must not declare an inline lineTotal shape that can drift from the component`,
    );
  }

  // The admin authoring tab carries NO achievement — owner, 2026-09-08. Pinned positively so the
  // removal above is a stated rule rather than a gap: a later session restoring a roll-up "for
  // convenience" puts the percentage back on the one screen he asked to be free of it.
  {
    const admin = flat(SRC("app/(admin)/sales/targets/page.tsx"));
    for (const banned of ["loadMonthlyAchievement", "rollupAchievementBy", "coveredActualValue", "achievementValue"]) {
      assert.ok(
        !admin.includes(banned),
        `the admin Targets page must not carry ${banned} — achievement belongs to Business Review and the portal tab`,
      );
    }
  }

  // (The Monthly Closing analytics dashboards' own rep rollup was pinned here too; the owner retired
  // the Sales Analytics module on 2026-09-17, so that loader is gone.)

  // The workspace: the card must now DIVIDE. Actual over Target is the Achievement printed beside
  // them, so the division hint has to show that division and not the old covered one.
  const workspace = flat(SRC("src/components/sales/targets-workspace.tsx"));
  assert.ok(
    workspace.includes("title={divisionHint(entry.actualValue, entry.targetValue)}"),
    "the rollup percentages must expose their division, and it must divide ALL sales by target",
  );
  assert.ok(
    !workspace.includes("divisionHint(entry.coveredActualValue"),
    "the division hint must not restate the retired covered-only numerator",
  );
  assert.ok(
    workspace.includes("const notGraded = total ? total.actualValue - total.coveredActualValue : 0;"),
    "the workspace must still derive the untargeted remainder — it is the coverage story the card tells",
  );
  assert.ok(
    workspace.includes("value={<CountUpNumber value={total.coveredActualValue} format={formatEgp} />}"),
    "the command band must still carry the coverage figure as a stat of its own",
  );
  assert.ok(
    workspace.includes("With a target") && workspace.includes("more has none, and still counts"),
    "the coverage stat must say plainly that untargeted money still counts, or the label reads like the old rule",
  );
  assert.ok(
    !workspace.includes("Graded sales"),
    'the "Graded sales" label must go: nothing is ungraded any more, and the word is what taught the old rule',
  );
  assert.ok(
    workspace.includes(
      "{`${formatEgpFull(notGraded)} of this line's sales sits on a product with no target this month.`}",
    ),
    "the untargeted remainder must still be stated in words as a coverage fact",
  );
  const rollups = workspace.split("<RollupList entries=").length - 1;
  assert.equal(rollups, 2, "both the region and the DM rollup must render through the one shared list");
}
