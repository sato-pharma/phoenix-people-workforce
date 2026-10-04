import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { groupAchievementByEmployee, publishedPointsOnly } from "../src/lib/sales/employee-achievement.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { SALES_VS_TARGET_FLOOR, isValidVsTargetPeriod } from "../src/lib/sales/vs-target.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * PERF-022 (2026-10-04) — a rep's landing keycard reads its sales from the PUBLICATION floor (July
 * 2026), not the history floor (January).
 *
 * The keycard keeps only PUBLISHED months (publishedPointsOnly), and no month before
 * SALES_VS_TARGET_FLOOR can be published: loadPublishedPeriodKeys refuses a range below it and
 * loadEmployeeMonthlyAchievement clamps its publication read up to it. So January–June were read on
 * every rep's landing and then thrown away. Reading from July instead must leave every figure on the
 * card exactly as it was — that equivalence is what this file pins, plus the wiring.
 */

const SNAPSHOT = "src/lib/employee-portal/home-snapshot.ts";
const ACHIEVEMENT = "src/lib/sales/employee-achievement.ts";

function repRow(period: string, overrides: Partial<AchievementRow> = {}): AchievementRow {
  return {
    period,
    lineCode: "pedia",
    regionCode: "delta_1",
    areaCode: "D14",
    areaState: "occupied",
    isOther: false,
    repSeatId: "SEAT-PED-REP-D14",
    repHrId: "B-158",
    dmSeatId: "SEAT-PED-DM-DELTA1",
    dmHrId: "B-200",
    productCode: "LA001",
    actualUnits: 100,
    actualValue: 250_000,
    targetUnits: 120,
    targetValue: 200_000,
    achievementValue: 1.25,
    achievementUnits: 100 / 120,
    hasTarget: true,
    hasActual: true,
    ...overrides,
  };
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const next = source.slice(start + 1).search(/\n(?:export |async function |function )/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

export async function runMrKeycardSalesFloorTests() {
  // ── 1. Nothing before the floor can be published ───────────────────────────────────
  {
    assert.equal(SALES_VS_TARGET_FLOOR, "2026-07", "the publication floor is July 2026, the first published closing");
    assert.equal(isValidVsTargetPeriod("2026-06"), false, "loadPublishedPeriodKeys refuses any range starting before July");
    assert.equal(isValidVsTargetPeriod("2026-07"), true, "and accepts July itself");

    const achievement = stripComments(readFileSync(ACHIEVEMENT, "utf8"));
    assert.match(
      achievement,
      /const publishedFrom = from < SALES_VS_TARGET_FLOOR \? SALES_VS_TARGET_FLOOR : from;/,
      "loadEmployeeMonthlyAchievement must clamp its publication read to the floor — the guarantee the keycard floor rests on",
    );
  }

  // ── 2. Dropping the pre-floor months changes no published point ────────────────────
  {
    // The publication ledger as loadPublishedPeriodKeys can return it: July onwards only.
    const publishedKeys = new Set(["pedia|2026-07", "pedia|2026-08"]);
    const uploaded = new Set(["2026-01", "2026-03", "2026-06", "2026-07", "2026-08", "2026-09"]);
    const preFloor = [
      repRow("2026-01", { actualValue: 90_000, targetValue: null, achievementValue: null, hasTarget: false }),
      repRow("2026-03", { actualValue: 110_000 }),
      repRow("2026-06", { actualValue: 130_000 }),
    ];
    const postFloor = [
      repRow("2026-07", { actualValue: 180_000 }),
      repRow("2026-08", { actualValue: 260_000 }),
      repRow("2026-08", { productCode: "LA002", actualValue: 40_000, targetValue: 50_000 }),
      repRow("2026-09", { actualValue: 5_000 }),
    ];

    const fromHistoryFloor = publishedPointsOnly(
      groupAchievementByEmployee([...preFloor, ...postFloor], ["B-158"], uploaded, publishedKeys).get("B-158") ?? [],
    );
    const fromPublicationFloor = publishedPointsOnly(
      groupAchievementByEmployee(postFloor, ["B-158"], uploaded, publishedKeys).get("B-158") ?? [],
    );

    assert.deepEqual(
      fromPublicationFloor,
      fromHistoryFloor,
      "reading the keycard from July must give exactly the published points reading from January gave",
    );
    assert.deepEqual(
      fromPublicationFloor.map((point) => point.period),
      ["2026-07", "2026-08"],
      "the published points are July and August; unpublished September stays off the card",
    );
  }

  // ── 3. Wiring: the keycard reads from the publication floor ────────────────────────
  {
    const snapshot = stripComments(readFileSync(SNAPSHOT, "utf8"));
    const body = functionBody(snapshot, "async function loadMrCanonicalSales(");
    assert.match(
      body,
      /loadEmployeeMonthlyAchievement\(\[hrId\], SALES_VS_TARGET_FLOOR, currentPeriod\)/,
      "loadMrCanonicalSales must read from SALES_VS_TARGET_FLOOR — no earlier month can ever reach the card",
    );
    assert.ok(
      !/SALES_HISTORY_FLOOR/.test(body),
      "loadMrCanonicalSales must not read from the history floor — six months read and discarded on every landing",
    );
  }
}
