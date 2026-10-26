import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { medicalRepCountLabel, repTargetGap } from "../src/lib/employee-portal/rep-target-gap.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The leaderboard's Gap column says "Achieved" only when the TARGET is met.
//
// Production, August 2026, Medical Reps Performance as the National Sales Manager: a rep at 98.7%
// (sales EGP 109,161 against target EGP 110,622) showed "Achieved" instead of her 1,461 EGP gap,
// because the column compared achievement with the 90% incentive threshold. Eligibility keeps its
// own badge; the gap is never hidden below 100%.
// ─────────────────────────────────────────────────────────────────────────────

function read(path: string) {
  return readFileSync(path, "utf8");
}

export function runRepTargetGapTests() {
  // 1. The production case: 98.7% shows its gap.
  const august = repTargetGap(109_161, 110_622);
  assert.equal(august.achieved, false, "🔴 98.7% of target is NOT Achieved — the 90% incentive line is not the target");
  assert.equal(august.gap, 1_461, "🔴 the 1,461 EGP gap is shown for a rep at 98.7%");

  // Every band between the incentive line and the target shows a gap.
  for (const pct of [90, 95, 99.9]) {
    const status = repTargetGap(pct * 1_000, 100_000);
    assert.equal(status.achieved, false, `${pct}% is not Achieved`);
    assert.ok(status.gap > 0, `${pct}% shows a gap`);
  }

  // 2. Met or beaten → Achieved, no gap.
  assert.deepEqual(repTargetGap(110_622, 110_622), { achieved: true, gap: 0 }, "exactly on target is Achieved");
  assert.deepEqual(repTargetGap(130_000, 110_622), { achieved: true, gap: 0 }, "above target is Achieved");
  // Read from the money, not a rounded percentage: 99.96% prints as 100.0% and still has a gap.
  assert.equal(repTargetGap(99_960, 100_000).achieved, false, "a few pounds short is still short");

  // 3. No target is never Achieved.
  assert.equal(repTargetGap(5_000, 0).achieved, false, "a rep with no target has nothing to achieve");
  assert.equal(repTargetGap(Number.NaN, 1_000).gap, 1_000, "a missing sales figure counts as zero sales");

  // 4. The count reads singular for one rep.
  assert.equal(medicalRepCountLabel(1), "1 medical rep");
  assert.equal(medicalRepCountLabel(0), "0 medical reps");
  assert.equal(medicalRepCountLabel(12), "12 medical reps");

  // 5. Wiring — both leaderboard branches (phone cards and desktop table) take the target-met status,
  //    and neither derives "Achieved" from the incentive threshold.
  const leaderboard = read("app/employee-portals/team-performance/team-members-breakdown.client.tsx");
  const calls = leaderboard.match(/repTargetGap\(member\.totalSales,\s*member\.totalTarget\)/g) ?? [];
  assert.equal(calls.length, 2, "🔴 the phone cards AND the desktop table both read repTargetGap");
  assert.doesNotMatch(
    leaderboard,
    /isAchieved\s*=\s*member\.achievementPercent\s*>=/,
    "🔴 the Gap column never decides Achieved from an achievement threshold",
  );

  for (const file of [
    "app/employee-portals/med-reps-performance/page.tsx",
    "app/employee-portals/team-performance/page.tsx",
  ]) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /\{(teamMemberCount|group\.members\.length)\} medical reps|\{teamMemberCount\} reps\)/,
      `🔴 ${file} counts reps through medicalRepCountLabel, so one rep reads "1 medical rep"`,
    );
    assert.match(source, /medicalRepCountLabel\(/, `${file} uses the shared count label`);
  }
}
