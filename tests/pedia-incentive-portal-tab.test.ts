import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { calculatePediaSplitIncentive } from "../src/lib/incentives/pedia-split.ts";
import { calculateIncentive2026 } from "../src/lib/incentives/scheme-2026.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The portal Incentive tab for a Pedia seat — the rule it states must be the rule it pays.
 *
 * THE DEFECT THIS PINS (owner, 2026-09-24): the Pedia split landed in the domain layer and in the
 * "Your Pedia Incentive" card, but the rest of the tab kept speaking the single-figure rule. The
 * Simulate Achievement card was the part that actually lied — ONE slider, scored with
 * calculateIncentive2026, paying the WHOLE semester incentive off ONE achievement. A Pedia seat has
 * been paid on two since Semester 2 2026, so at 95% the card promised two months of basic where the
 * rule pays one month at 95% plus one month at the line total, and nothing on it said which of the
 * rep's two achievements the slider was. The KPI strip and the payout curve had the same hole.
 *
 * Every assertion below is about a number a Pedia seat reads on his own screen and is paid from, or
 * about the routing that decides which of the two tabs he sees. The gate is `sales.pediaSplit`,
 * which the service sets for a Pedia seat in a split semester and for nobody else — role-free on
 * purpose, so a rep, a District Manager, a Regional Manager and the National Sales Manager all read
 * the same tab (src/lib/incentives/pedia-split.ts).
 */

/** Strip comments, so a rule quoted in prose can never satisfy an assertion about the code. */
function code(source: string): string {
  return stripComments(source);
}

/** One top-level function's body: from its declaration to the next one. */
function block(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in the incentive tab`);
  const next = source.indexOf("\nfunction ", start + 1);
  return next > start ? source.slice(start, next) : source.slice(start);
}

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

export function runPediaIncentivePortalTabTests() {
  const dashboard = code(read("src/components/employee-portal/employee-portal-dashboard.tsx"));

  // ── 1. A PEDIA SEAT IS ROUTED TO THE TWO-ACHIEVEMENT TAB ────────────────────────────────────
  // Without this branch the split card sits on a tab whose every other panel contradicts it.
  {
    const tab = block(dashboard, "EmployeePortalIncentivePage");
    assert.match(
      tab,
      /if \(data\.sales\.pediaSplit\) \{\s*return <PediaIncentiveTab data=\{data\} \/>;/,
      "a seat with a Pedia split must render the Pedia tab, not the single-figure one",
    );
    // The gate is the service's own answer. A role test here would be a second, weaker copy of it,
    // and would put two rules on one line the first time it disagreed.
    assert.ok(
      !/role\s*===\s*"Medical Rep"/.test(block(dashboard, "PediaIncentiveTab")),
      "the Pedia tab must not test the viewer's role — all Pedia seats are scored the same way",
    );
  }

  // ── 2. THE SIMULATOR IS SCORED ON THE SPLIT, NOT THE SINGLE FIGURE ──────────────────────────
  // This is the defect itself. `calculateIncentive2026` inside the Pedia simulator is precisely the
  // wrong answer — it pays two months of basic off one achievement.
  {
    const simulator = block(dashboard, "PediaIncentiveSimulatorCard");
    assert.match(
      simulator,
      /calculatePediaSplitIncentive\(\{/,
      "the Pedia simulator must score through the split rule",
    );
    assert.ok(
      !/calculateIncentive2026\(/.test(simulator),
      "the Pedia simulator must NOT read the single-figure calculation — that is the misleading rule",
    );
    assert.match(
      simulator,
      /satoAchievementPercent: simSato/,
      "the Sato slider must feed the Sato half",
    );
    assert.match(
      simulator,
      /totalAchievementPercent: simTotal/,
      "the total slider must feed the total half",
    );

    // TWO sliders, each naming its products. One slider is how the old card could not say which
    // achievement it was simulating.
    const satoSlider = /accent="orange"[\s\S]*?products="Guamusin · Ivyronc"/;
    const totalSlider = /accent="sky"[\s\S]*?products="All four Pedia products"/;
    assert.match(simulator, satoSlider, "a Sato slider, labelled with its two products by name");
    assert.match(simulator, totalSlider, "a total slider, labelled with the whole line");

    // Both halves and their sum are on the card: the rep must be able to check the arithmetic.
    assert.match(simulator, /simulated\.satoHalfAmount/, "the Sato half amount is shown");
    assert.match(simulator, /simulated\.totalHalfAmount/, "the total half amount is shown");
    assert.match(simulator, /simulated\.payoutAmount/, "the two halves added is shown");
  }

  // ── 3. THE SIMULATED FIGURES ARE THE OWNER'S OWN WORKED EXAMPLE ─────────────────────────────
  // The card calls this function with the two slider values, so what it renders at 95/91 is what
  // this returns. His words, 2026-09-23: "if ex sat ach is 95% and tot is 91% then incentive should
  // be 75% of month for sato and 55% of month for tot".
  {
    const simulated = calculatePediaSplitIncentive({
      baseSalary: 15_000,
      satoAchievementPercent: 95,
      totalAchievementPercent: 91,
    });
    assert.equal(simulated.satoHalfAmount, 7_875, "75% of one month of basic");
    assert.equal(simulated.totalHalfAmount, 5_775, "55% of one month of basic");
    assert.equal(simulated.payoutAmount, 13_650, "the sum the card puts under the two halves");
    assert.equal(
      simulated.satoHalfAmount + simulated.totalHalfAmount,
      simulated.payoutAmount,
      "the two figures on screen must add to the one underneath them",
    );

    // What the OLD card would have shown a rep dragging one slider to 95%: the whole incentive at
    // 95%, which is 7,875 more than the rule pays him. That gap is the reason for this rebuild.
    const singleFigure = calculateIncentive2026({ baseSalary: 15_000, achievementPercent: 95 });
    assert.equal(singleFigure.payoutAmount, 15_750, "the single-figure rule pays two months at 95%");
    assert.notEqual(
      singleFigure.payoutAmount,
      simulated.payoutAmount,
      "the two rules genuinely disagree — the old simulator was not a harmless label",
    );
  }

  // ── 4. BOTH ACHIEVEMENTS ARE STATED, AND NEITHER IS INVENTED ────────────────────────────────
  {
    const kpis = block(dashboard, "PediaIncentiveKpiCards");
    assert.match(kpis, /label: "Sato Achievement"/, "the Sato achievement is named on the strip");
    assert.match(kpis, /label: "Total Achievement"/, "the total achievement is named beside it");

    // A missing target is not an achievement of zero — the same rule the rest of the tab follows.
    assert.match(kpis, /const hasSatoTarget = split\.satoTarget > 0;/, "read the Sato target first");
    assert.match(
      kpis,
      /hasSatoTarget \? `\$\{split\.satoAchievementPercent\.toFixed\(1\)\}%` : "No target yet"/,
      "no Sato target must render 'No target yet', never '0.0%'",
    );
    assert.match(
      kpis,
      /hasTotalTarget \? `\$\{data\.sales\.overviewAchievementPercent\.toFixed\(1\)\}%` : "No target yet"/,
      "the same rule for the total",
    );
  }

  // ── 5. THE CURVE MARKS BOTH ACHIEVEMENTS, AND ONLY THE ONES THAT EXIST ──────────────────────
  {
    const tab = block(dashboard, "PediaIncentiveTab");
    assert.match(tab, /label: `Sato: \$\{/, "the curve carries a Sato marker");
    assert.match(tab, /label: `Total: \$\{/, "and a total marker");
    assert.match(
      tab,
      /if \(\(split\?\.satoTarget \?\? 0\) > 0\) \{/,
      "a marker is only drawn where a target exists — a line at 0% is a claim about performance",
    );
    assert.match(
      tab,
      /if \(data\.sales\.incentiveSemesterTarget > 0\) \{/,
      "the same gate for the total marker",
    );

    // The chart itself is not copied for Pedia: one implementation, markers passed in.
    const chart = block(dashboard, "IncentivePayoutCurveChart");
    assert.match(chart, /resolvedMarkers\.map\(/, "the chart renders whatever markers it is given");
    assert.match(
      chart,
      /markers \?\?\s*\(hasSemesterTarget/,
      "every other line keeps its single default marker",
    );
  }

  // ── 6. EVERY OTHER LINE IS UNTOUCHED ────────────────────────────────────────────────────────
  // The split reduces to the single figure when the two achievements agree, but no other line
  // should be reading the split card or the two-slider simulator at all.
  {
    const standardTab = block(dashboard, "EmployeePortalIncentivePage");
    assert.ok(
      !/<PediaSplitIncentiveCard/.test(standardTab),
      "the single-figure tab must not render the Pedia card — a Pedia seat never reaches it",
    );
    assert.match(
      standardTab,
      /<IncentiveSimulatorCard/,
      "every other line keeps the single-achievement simulator",
    );

    const simulator = block(dashboard, "IncentiveSimulatorCard");
    assert.match(
      simulator,
      /calculateIncentive2026\(\{/,
      "and that simulator keeps scoring on the single figure, which is what those lines are paid",
    );
  }
}
