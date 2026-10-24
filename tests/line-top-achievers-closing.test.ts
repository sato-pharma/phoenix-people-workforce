import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  latestPublishedPeriodForLine,
  rankLineAchieversForPeriod,
} from "../src/lib/employee-portal/line-top-achievers.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";

function row(period: string, repHrId: string, actualValue: number, targetValue: number | null): AchievementRow {
  return { period, repHrId, actualValue, targetValue } as unknown as AchievementRow;
}

export function runLineTopAchieversClosingTests() {
  const reps = [
    { areaName: "Cairo", displayName: "Alpha", hrId: "A-1" },
    { areaName: "Giza", displayName: "Bravo", hrId: "A-2" },
    { areaName: "Tanta", displayName: "Charlie", hrId: "A-3" },
  ];
  const rows = [
    // September: Alpha 50%, Bravo 120% (two product rows), Charlie has no target.
    row("2026-09", "a-1", 50, 100),
    row("2026-09", "a-2", 100, 50),
    row("2026-09", "a-2", 20, 50),
    row("2026-09", "a-3", 40, null),
    // August and October rows must never leak into the September board.
    row("2026-08", "a-1", 900, 100),
    row("2026-10", "a-1", 900, 100),
  ];

  const board = rankLineAchieversForPeriod(rows, "2026-09", reps, 3);
  assert.deepEqual(board.map((entry) => entry.name), ["Bravo", "Alpha"], "ranked by the one month's closing figure");
  assert.equal(board[0].achievementPercent, 120);
  assert.equal(board[1].achievementPercent, 50, "no other month is added into a rep's figure");
  assert.equal(rankLineAchieversForPeriod(rows, "2026-09", reps, 1).length, 1);

  // The latest published month PER LINE: an unpublished month never wins.
  const published = new Set(["cns|2026-07", "cns|2026-09", "pedia|2026-08", "ai|2026-10x"]);
  assert.equal(latestPublishedPeriodForLine("cns", published), "2026-09");
  assert.equal(latestPublishedPeriodForLine("pedia", published), "2026-08");
  assert.equal(latestPublishedPeriodForLine("anti_infective", published), null);

  // The service reads published months only and hands the card the month.
  const service = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  assert.match(service, /loadPublishedPeriodKeys\(SALES_VS_TARGET_FLOOR, current\)/);
  assert.match(service, /periodLabel: periodLabel\(period\)/);
  const card = readFileSync("src/components/employee-portal/line-top-achievers-card.tsx", "utf8");
  assert.match(card, /group\.periodLabel/);
}
