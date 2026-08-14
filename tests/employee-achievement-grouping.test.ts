import assert from "node:assert/strict";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import {
  achievementPercentOf,
  groupAchievementByEmployee,
  summarizeAchievement,
  uploadedPointsOnly,
} from "../src/lib/sales/employee-achievement.ts";

// Spread-merged, NOT `??`-defaulted: `repHrId: null` is a case this fixture has to be able
// to express (an unoccupied seat), and `??` would silently substitute the default for it.
function row(overrides: Partial<AchievementRow> & { period: string }): AchievementRow {
  const merged: AchievementRow = {
    lineCode: "cns",
    regionCode: "AB",
    areaCode: "D16",
    areaState: "occupied",
    isOther: false,
    repSeatId: "SEAT-CNS-REP-D16",
    repHrId: "b-158",
    dmSeatId: "SEAT-CNS-DM-AB",
    dmHrId: "b-119",
    productCode: "TE003",
    actualUnits: 0,
    actualValue: 0,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: false,
    ...overrides,
  };
  return {
    ...merged,
    hasTarget: "hasTarget" in overrides ? merged.hasTarget : merged.targetValue != null,
    hasActual: "hasActual" in overrides ? merged.hasActual : merged.actualValue !== 0,
  };
}

export function runEmployeeAchievementGroupingTests() {
  // ── The casing trap ────────────────────────────────────────────────────────
  // The attribution engine keys reps lower-cased; the portal and analytics compare
  // upper-cased. A mismatch returns an EMPTY result, which reads exactly like "this rep
  // sold nothing" — so it must be absorbed here and nowhere else.
  const cased = groupAchievementByEmployee(
    [row({ period: "2026-07", repHrId: "b-158", actualValue: 1_000, targetValue: 500 })],
    ["B-158"],
    new Set(["2026-07"]),
  );
  assert.equal(
    cased.get("B-158")?.[0]?.actualValue,
    1_000,
    "an upper-cased request must match the engine's lower-cased rep_hr_id, or the rep silently reads as zero",
  );
  assert.deepEqual(
    [...cased.keys()],
    ["B-158"],
    "the map is keyed by the CALLER's own string, so no caller has to guess the engine's casing",
  );

  // ── Missing target is null, never 0 ────────────────────────────────────────
  // au.monthly_targets starts 2026-07, so every H1 row legitimately has actuals and no
  // target. Rendering that as 0% tells a rep who sold well that they achieved nothing.
  const untargeted = groupAchievementByEmployee(
    [row({ period: "2026-03", actualValue: 49_962, targetValue: null })],
    ["B-158"],
    new Set(["2026-03"]),
  );
  const marchPoint = untargeted.get("B-158")?.[0];
  assert.equal(marchPoint?.actualValue, 49_962, "the actual is real even with no target beside it");
  assert.equal(
    marchPoint?.achievementValue,
    null,
    "no target means achievement is null — 'no target set' and 'achieved nothing' are different facts",
  );
  assert.equal(marchPoint?.hasTarget, false, "hasTarget reports the absence rather than hiding it");
  assert.equal(
    marchPoint?.uncoveredActualValue,
    49_962,
    "untargeted actual is reported beside the %, never folded into it",
  );

  // ── A requested employee with no rows is present-and-empty, not absent ─────
  const missing = groupAchievementByEmployee([], ["B-999"], new Set());
  assert.ok(
    missing.has("B-999"),
    "an absent key would make 'no sales data' indistinguishable from 'we never asked'",
  );
  assert.deepEqual(missing.get("B-999"), [], "and the empty case is an empty series, not undefined");

  // ── The August trap ────────────────────────────────────────────────────────
  // 2026-08-10: ONE direct order (1,309.50 EGP) against a 17,508,935 EGP target. If a
  // cumulative window trusts has_actual instead of the distributor upload ledger, every
  // rep reads ~0% on the screen the field force opens daily.
  const withStrayAugust = groupAchievementByEmployee(
    [
      row({ period: "2026-07", actualValue: 1_000_000, targetValue: 1_000_000 }),
      row({ period: "2026-08", actualValue: 1_309.5, targetValue: 17_508_935 }),
    ],
    ["B-158"],
    new Set(["2026-07"]), // August's distributor upload has NOT landed
  );
  const points = withStrayAugust.get("B-158") ?? [];
  assert.deepEqual(
    points.map((point) => point.period),
    ["2026-07", "2026-08"],
    "points stay in ascending period order so a caller never has to re-sort",
  );
  assert.equal(points[1]?.uploaded, false, "August carries a direct order but no distributor upload");

  const uploaded = uploadedPointsOnly(points);
  assert.equal(uploaded.length, 1, "only the month whose distributor upload landed survives");
  assert.equal(
    achievementPercentOf(summarizeAchievement(uploaded)),
    100,
    "July alone reads 100% — this is the number the rep must see",
  );
  const naive = achievementPercentOf(summarizeAchievement(points)) ?? 0;
  assert.ok(
    naive < 6,
    `summing the unuploaded month collapses the same rep to ${naive.toFixed(1)}% — the regression this guard exists to catch`,
  );

  // ── Achievement is re-derived from sums, never averaged across months ──────
  // Averaging a 10% month with a 400% month yields 205%; the like-for-like figure is 45.5%.
  const lumpy = summarizeAchievement([
    { period: "2026-07", actualValue: 100, actualUnits: 0, targetValue: 1_000, targetUnits: 0, coveredActualValue: 100, uncoveredActualValue: 0, achievementValue: 0.1, hasTarget: true, uploaded: true },
    { period: "2026-08", actualValue: 400, actualUnits: 0, targetValue: 100, targetUnits: 0, coveredActualValue: 400, uncoveredActualValue: 0, achievementValue: 4, hasTarget: true, uploaded: true },
  ]);
  assert.equal(
    lumpy.achievementValue,
    500 / 1_100,
    "the window ratio is covered ÷ target over the sums, not the mean of the monthly ratios",
  );
  assert.equal(lumpy.months, 2, "months counts the periods that actually contributed, for the 'N of 6' notice");

  // A window with no target at all stays null all the way out to the percent.
  const targetless = summarizeAchievement([
    { period: "2026-03", actualValue: 500, actualUnits: 0, targetValue: 0, targetUnits: 0, coveredActualValue: 0, uncoveredActualValue: 500, achievementValue: null, hasTarget: false, uploaded: true },
  ]);
  assert.equal(targetless.achievementValue, null, "a zero target divides to null, never 0 and never Infinity");
  assert.equal(
    achievementPercentOf(targetless),
    null,
    "the incentive scheme must be handed a null it can decide about, not a fabricated 0%",
  );

  // ── Grain ─────────────────────────────────────────────────────────────────
  // A manager's own surface totals their team, so the DM grain keys on dm_hr_id.
  const byDm = groupAchievementByEmployee(
    [
      row({ period: "2026-07", repHrId: "b-158", dmHrId: "b-119", actualValue: 600, targetValue: 500 }),
      row({ period: "2026-07", repHrId: "b-144", dmHrId: "b-119", actualValue: 400, targetValue: 500 }),
    ],
    ["B-119"],
    new Set(["2026-07"]),
    "dm",
  );
  assert.equal(
    byDm.get("B-119")?.[0]?.actualValue,
    1_000,
    "the DM grain sums both reps' rows into one point for the manager",
  );
  assert.equal(
    byDm.get("B-119")?.[0]?.achievementValue,
    1_000 / 1_000,
    "and the team's achievement divides the summed actual by the summed target",
  );

  // A row the engine could not attribute to anyone belongs to the area, not to a person.
  const unattributed = groupAchievementByEmployee(
    [row({ period: "2026-07", repHrId: null, actualValue: 5_000, targetValue: 1_000 })],
    ["B-158"],
    new Set(["2026-07"]),
  );
  assert.deepEqual(
    unattributed.get("B-158"),
    [],
    "an unoccupied-seat row must never be credited to whoever happened to be asked about",
  );
}
