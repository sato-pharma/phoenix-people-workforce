import assert from "node:assert/strict";

import { measurePediaAchievement } from "../src/lib/incentives/pedia-achievement.ts";
import {
  PEDIA_SATO_HALF_MIN_TOTAL_PERCENT,
  PEDIA_SPLIT_FIRST_SEMESTER,
  calculatePediaSplitIncentive,
  pediaSatoHalfUnlocked,
  isPediaLine,
  isPediaSatoProductCode,
  isPediaSplitSemester,
  pediaSplitApplies,
} from "../src/lib/incentives/pedia-split.ts";
import { calculateIncentive2026 } from "../src/lib/incentives/scheme-2026.ts";
import { semesterLabel } from "../src/lib/incentives/semester.ts";

/**
 * The Pedia split incentive — the owner's rule of 2026-09-23, pinned.
 *
 * On Pedia, from Semester 2 2026, the semester incentive is paid as two halves: one month of basic
 * scored on SATO achievement (Guamusin + Ivyronc) and one month scored on TOTAL. This file pins the
 * three things that a future session could plausibly get wrong, each of which moves real money:
 *
 *   1. IT IS A SUM, NOT A GATE. The rule was first modelled as "both groups over 90% pays in full,
 *      one of them pays half" and the owner rejected that model in his own words. The two rows that
 *      separate the models are here with his own numbers.
 *   2. IT REDUCES TO TODAY'S RULE. Equal achievements must pay exactly what the single calculation
 *      pays — otherwise this is a new scheme rather than a split numerator, and every other line
 *      would be at risk from any shared code.
 *   3. THE OWNER-LOCKED CURVE IS NOT REIMPLEMENTED. Every figure below is produced by calling
 *      src/lib/incentives/scheme-2026.ts twice. The reduction test is what proves there is no
 *      second copy of the payout arithmetic to drift.
 *
 * The worked example throughout is the one he was shown and accepted: base salary 15,000, so basic
 * is 10,500 and the semester incentive is 21,000 — one month per half.
 */
export function runPediaSplitIncentiveTests() {
  const BASE = { baseSalary: 15_000 };
  const SEMESTER_INCENTIVE = 21_000; // 15,000 x 70% x 2 months

  // ── The salary basis is the one he was shown ──────────────────────────────────────────────────
  {
    const reference = calculateIncentive2026({ ...BASE, achievementPercent: 100 });
    assert.equal(reference.basicSalary, 10_500, "basic is 70% of base — the locked policy rate");
    assert.equal(
      reference.semesterTargetIncentive,
      SEMESTER_INCENTIVE,
      "two months of basic; each half of the split is worth one of them",
    );
  }

  // ── 1. THE OWNER'S OWN WORKED EXAMPLE ─────────────────────────────────────────────────────────
  // His words, 2026-09-23: "if ex sat ach is 95% and tot is 91% then incentive should be 75% of
  // month for sato and 55% of month for tot". 95% reads 75 on the curve, 91% reads 55.
  {
    const split = calculatePediaSplitIncentive({
      ...BASE,
      satoAchievementPercent: 95,
      totalAchievementPercent: 91,
    });
    assert.equal(split.satoHalfAmount, 7_875, "75% of one month of basic (10,500)");
    assert.equal(split.totalHalfAmount, 5_775, "55% of one month of basic");
    assert.equal(split.payoutAmount, 13_650, "the two halves added — the figure he confirmed");
    assert.equal(
      split.satoHalfAmount + split.totalHalfAmount,
      split.payoutAmount,
      "the two figures on screen must add to the one underneath them, exactly",
    );

    // THE GATE MODEL IS THE WRONG ANSWER, and this is the row that tells them apart: a gate reading
    // "Sato over 90 but the line only just over" would have paid a single half of the whole
    // incentive — 5,775 — instead of 13,650. If this assertion ever has to be relaxed, the rule has
    // been changed back to something the owner explicitly refused.
    assert.notEqual(split.payoutAmount, 5_775, "a 2x2 gate pays 5,775 here; the owner's rule pays 13,650");
  }

  // ── 2. "50% of the 50%" — Sato earns, the line does not ───────────────────────────────────────
  // Sato exactly at the 90% threshold reads 50 on the curve, so its half is 50% of one month. The
  // line below 90% earns nothing at all. This is the case he described before the split model was
  // settled, and the split reproduces it.
  {
    const split = calculatePediaSplitIncentive({
      ...BASE,
      satoAchievementPercent: 90,
      totalAchievementPercent: 80,
    });
    assert.equal(split.satoHalfAmount, 5_250, "50% of one month of basic");
    assert.equal(split.totalHalfAmount, 0, "below the 90% floor the total half earns nothing");
    assert.equal(split.payoutAmount, 5_250);
  }

  // ── 3. Both below the floor pays NOTHING ──────────────────────────────────────────────────────
  // His scenario 9: "scenario 9 is zero payout". Neither half unlocks, so there is no payout at all
  // — the 90% floor is not softened by the split.
  {
    const split = calculatePediaSplitIncentive({
      ...BASE,
      satoAchievementPercent: 89.9,
      totalAchievementPercent: 89.9,
    });
    assert.equal(split.satoHalfAmount, 0);
    assert.equal(split.totalHalfAmount, 0);
    assert.equal(split.payoutAmount, 0, "the split never pays through the floor");
  }

  // ── 4. The ceiling is unchanged ───────────────────────────────────────────────────────────────
  // Achievement caps at 150 and payout at 220%, inside each half. Both halves maxed is 220% of the
  // semester incentive and not a piastre more — the split must not raise the ceiling.
  {
    const split = calculatePediaSplitIncentive({
      ...BASE,
      satoAchievementPercent: 400,
      totalAchievementPercent: 400,
    });
    assert.equal(split.payoutAmount, 46_200, "220% of 21,000 — the same ceiling the single rule has");
    assert.equal(split.payoutPercentage, 220);
  }

  // ── 5. IT REDUCES EXACTLY TO TODAY'S RULE ─────────────────────────────────────────────────────
  // Equal achievements must pay what the single calculation pays, everywhere on the curve including
  // both cap regions and the discontinuity at 90. This is the property that makes the split safe:
  // it is the existing scheme with the numerator split, not a second scheme beside it.
  for (const achievement of [0, 50, 89, 89.9, 90, 90.1, 95, 99, 100, 100.1, 110, 120, 120.1, 133, 150, 200]) {
    const single = calculateIncentive2026({ ...BASE, achievementPercent: achievement });
    const split = calculatePediaSplitIncentive({
      ...BASE,
      satoAchievementPercent: achievement,
      totalAchievementPercent: achievement,
    });
    assert.equal(
      split.payoutAmount,
      single.payoutAmount,
      `at ${achievement}% the split must pay exactly what the single rule pays — it is the same curve read twice`,
    );
  }

  // The split is SYMMETRIC while the total is at 80% or more: which half is the strong one cannot
  // change the money. Under 80% it is not, by design — section 10 below.
  {
    const forward = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: 130, totalAchievementPercent: 92 });
    const reversed = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: 92, totalAchievementPercent: 130 });
    assert.equal(forward.payoutAmount, reversed.payoutAmount);
  }

  // ── 6. WHO AND WHEN ───────────────────────────────────────────────────────────────────────────
  {
    assert.equal(isPediaLine("Pedia"), true);
    assert.equal(isPediaLine("pedia"), true);
    assert.equal(isPediaLine("Pediatrics"), true);
    assert.equal(isPediaLine("CNS"), false);
    assert.equal(isPediaLine("Anti Infective"), false);
    assert.equal(isPediaLine(null), false, "an unresolved line is NOT Pedia — it falls back to the single rule");

    assert.equal(PEDIA_SPLIT_FIRST_SEMESTER, "2026-S2");
    assert.equal(isPediaSplitSemester("2026-S1"), false, "Semester 1 2026 is closed and is never restated");
    assert.equal(isPediaSplitSemester("2026-S2"), true);
    assert.equal(isPediaSplitSemester("2027-S1"), true, "it is a floor, not a single semester");
    assert.equal(isPediaSplitSemester(null), false);

    // ALL PEDIA SEATS (owner) — there is deliberately no role in this predicate at all.
    assert.equal(pediaSplitApplies({ line: "Pedia", semester: "2026-S2" }), true);
    assert.equal(pediaSplitApplies({ line: "Pedia", semester: "2026-S1" }), false);
    assert.equal(pediaSplitApplies({ line: "CNS", semester: "2026-S2" }), false);
  }

  // ── 7. The Sato group is keyed on CODES, not names ────────────────────────────────────────────
  {
    assert.equal(isPediaSatoProductCode("GU001"), true, "Guamusin");
    assert.equal(isPediaSatoProductCode("IV001"), true, "Ivyronc");
    assert.equal(isPediaSatoProductCode("gu001"), true, "casing must not decide a payout");
    assert.equal(isPediaSatoProductCode(" IV001 "), true);
    assert.equal(isPediaSatoProductCode("LA001"), false, "Lacto Advanced 1 is outsource");
    assert.equal(isPediaSatoProductCode("LA002"), false, "Lacto Advanced 2 is outsource");
    assert.equal(isPediaSatoProductCode("Guamusin"), false, "the display NAME is not a key — names are editable");
    assert.equal(isPediaSatoProductCode(null), false);
  }

  // ── 8. Measuring the two achievements ─────────────────────────────────────────────────────────
  const WINDOW = ["2026-07", "2026-08"];
  const row = (
    period: string,
    productCode: string,
    salesValue: number,
    targetValue: number,
    territory = "Cairo 1",
  ) => ({ hrId: "B-311", territory, period, productCode, salesValue, targetValue });

  {
    // Sato 950 / 1,000 = 95%. Total 1,910 / 2,000 = 95.5%.
    const measurement = measurePediaAchievement({
      rows: [
        row("2026-07", "GU001", 500, 500),
        row("2026-07", "IV001", 450, 500),
        row("2026-07", "LA001", 700, 600),
        row("2026-07", "LA002", 260, 400),
      ],
      windowPeriods: WINDOW,
    });
    assert.equal(measurement.satoSales, 950);
    assert.equal(measurement.satoTarget, 1_000);
    assert.equal(measurement.satoAchievementPercent, 95);
    assert.equal(measurement.totalSales, 1_910);
    assert.equal(measurement.totalTarget, 2_000);
    assert.equal(measurement.totalAchievementPercent, 95.5);
  }

  // OUTSOURCE IS NEVER SCORED ON ITS OWN. Moving Lacto sales changes the TOTAL and leaves the Sato
  // reading untouched — the single property the owner was most explicit about ("i dont care about
  // outsource achievemnt").
  {
    const sato = [row("2026-07", "GU001", 500, 500), row("2026-07", "IV001", 450, 500)];
    const weak = measurePediaAchievement({
      rows: [...sato, row("2026-07", "LA001", 100, 1_000)],
      windowPeriods: WINDOW,
    });
    const strong = measurePediaAchievement({
      rows: [...sato, row("2026-07", "LA001", 2_000, 1_000)],
      windowPeriods: WINDOW,
    });
    assert.equal(weak.satoAchievementPercent, strong.satoAchievementPercent, "outsource cannot move the Sato half");
    assert.ok(strong.totalAchievementPercent > weak.totalAchievementPercent, "it moves the total half, and only that");
  }

  // A period outside the semester window belongs to a payout already made and must be dropped, not
  // clamped in.
  {
    const measurement = measurePediaAchievement({
      rows: [row("2026-07", "GU001", 100, 100), row("2026-06", "GU001", 9_999, 1)],
      windowPeriods: WINDOW,
    });
    assert.equal(measurement.satoSales, 100, "June belongs to a closed semester");
    assert.equal(measurement.satoTarget, 100);
  }

  // THE TARGET IS DE-DUPLICATED PER (rep, area, period, product) and the SALES ARE NOT — the same
  // asymmetry buildPortalSalesDashboardMetrics has, so the total measured here can never disagree
  // with the semester figure shown beside it. Two rows on one key: both sales counted, the target
  // counted once at its MAX.
  {
    const measurement = measurePediaAchievement({
      rows: [row("2026-07", "GU001", 300, 500), row("2026-07", "GU001", 200, 500)],
      windowPeriods: WINDOW,
    });
    assert.equal(measurement.satoSales, 500, "every row's money is real and is summed");
    assert.equal(measurement.satoTarget, 500, "the echoed target is counted ONCE, not doubled");
    assert.equal(measurement.satoAchievementPercent, 100);
  }

  // A DIFFERENT AREA IS A DIFFERENT KEY, so a rep carrying two territories keeps both targets.
  {
    const measurement = measurePediaAchievement({
      rows: [row("2026-07", "GU001", 300, 500), row("2026-07", "GU001", 200, 500, "Giza 2")],
      windowPeriods: WINDOW,
    });
    assert.equal(measurement.satoTarget, 1_000, "two areas are two targets, not one echoed twice");
  }

  // NO SATO TARGET IS NOT 0% — the caller must be able to tell them apart, exactly as it already
  // can for the total. A month carrying sales and no target loaded yet is the live shape here.
  {
    const measurement = measurePediaAchievement({
      rows: [row("2026-07", "GU001", 5_000, 0)],
      windowPeriods: WINDOW,
    });
    assert.equal(measurement.satoTarget, 0, "the caller reads this before rendering a percentage");
    assert.equal(measurement.satoAchievementPercent, 0, "0 rather than Infinity or NaN");
  }

  {
    const empty = measurePediaAchievement({ rows: [], windowPeriods: WINDOW });
    assert.equal(empty.satoAchievementPercent, 0);
    assert.equal(empty.totalAchievementPercent, 0);
    assert.equal(empty.satoTarget, 0);
  }

  // ── 9. The wording: Semester, never H ─────────────────────────────────────────────────────────
  // Owner, 2026-09-23: "call it semester 1 and 2 and s1 and s2 not h1 and h2". The key keeps its
  // `2026-S2` shape; what a person reads is spelled out.
  {
    assert.equal(semesterLabel("2026-S2"), "Semester 2 2026");
    assert.equal(semesterLabel("2026-S1"), "Semester 1 2026");
    assert.doesNotMatch(semesterLabel("2026-S2"), /\bH2\b/, "never 'H2 2026'");
  }

  // ── 10. THE SATO HALF NEEDS THE TOTAL AT 80% (owner, 2026-11-08, Dr Anwar's rule) ─────────────
  // "no incentive for any one achieve on sato products and his or her total achievement less than
  // 80% either MR or DM". Semester 2 2026 onward, Pedia only. The three seats it caught on the
  // July–September 2026 closing are the first three cases, with their real achievements.
  {
    assert.equal(PEDIA_SATO_HALF_MIN_TOTAL_PERCENT, 80);
    assert.equal(pediaSatoHalfUnlocked(80), true, "80% exactly passes — 'less than 80%' gets nothing");
    assert.equal(pediaSatoHalfUnlocked(79.99), false);
    assert.equal(pediaSatoHalfUnlocked(Number.NaN), false, "an unreadable total never unlocks money");

    // A rep at Sato 224.4% / total 79.5% — the case the rule was written for.
    const capped = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: 224.4, totalAchievementPercent: 79.5 });
    assert.equal(capped.satoHalfAmount, 0, "Sato over 200% pays nothing with the total under 80%");
    assert.equal(capped.satoHalfWithheld, true, "and the tab is told why");
    assert.equal(capped.totalHalfAmount, 0);
    assert.equal(capped.payoutAmount, 0);
    assert.equal(capped.sato.payoutAmount, 46_200, "the locked curve still reads 220% — only the half is withheld");

    // A rep at Sato 126.6% / total 65.2%, and a District Manager at Sato 90.2% / total 49.4%.
    for (const [sato, total] of [[126.6, 65.2], [90.2, 49.4]] as const) {
      const split = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: sato, totalAchievementPercent: total });
      assert.equal(split.satoHalfAmount, 0, `Sato ${sato}% with total ${total}% pays nothing`);
      assert.equal(split.satoHalfWithheld, true);
      assert.equal(split.payoutAmount, 0);
    }

    // The boundary, from both sides.
    const atFloor = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: 100, totalAchievementPercent: 80 });
    assert.equal(atFloor.satoHalfAmount, 10_500, "total exactly 80%: the Sato half pays its full month at 100%");
    assert.equal(atFloor.satoHalfWithheld, false);
    const underFloor = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: 100, totalAchievementPercent: 79.99 });
    assert.equal(underFloor.satoHalfAmount, 0);

    // Total between 80 and 90: Sato half only. Total over 90 with Sato under: total half only.
    const satoOnly = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: 100, totalAchievementPercent: 85 });
    assert.equal(satoOnly.payoutAmount, 10_500, "Sato half paid, total half under its own 90% floor");
    const totalOnly = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: 60, totalAchievementPercent: 95 });
    assert.equal(totalOnly.satoHalfAmount, 0);
    assert.equal(totalOnly.satoHalfWithheld, false, "the curve paid nothing here, so nothing was withheld");
    assert.equal(totalOnly.totalHalfAmount, 7_875, "the total half is untouched by the new rule");

    // His own correction: 75% Sato and 85% total pays nothing — neither half reaches 90%.
    const neither = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: 75, totalAchievementPercent: 85 });
    assert.equal(neither.payoutAmount, 0);
    assert.equal(neither.satoHalfWithheld, false);

    // Not symmetric under 80%, by design: the strong Sato cannot carry a weak line.
    const strongSato = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: 130, totalAchievementPercent: 70 });
    const strongTotal = calculatePediaSplitIncentive({ ...BASE, satoAchievementPercent: 70, totalAchievementPercent: 130 });
    assert.equal(strongSato.payoutAmount, 0);
    assert.ok(strongTotal.payoutAmount > 0, "a strong line still pays its own half");
  }
}
