// Top Achievers · Per Line — the ranking itself, pure.
//
// Owner, 2026-10-24: the card must match each rep's MONTHLY CLOSING and say which month it is.
// So a line's board is ONE published month: the latest month whose Monthly Closing is published for
// that line. Each rep's figure is his sales over his target in that month's closing rows — the same
// division the closing shows — never a running total across months.
//
// 🔴 It used to add up every month from January to the current one (unpublished and in-progress
// months included), so a rep read 174.6% on the card against 17.4% in the September closing.

import type { AchievementRow } from "@/lib/sales/monthly-targets";

export type LineAchieverRep = { areaName: string | null; displayName: string; hrId: string };

export type LineAchieverRanked = {
  achievementPercent: number;
  areaName: string | null;
  hrId: string;
  name: string;
};

const lower = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();

/** The newest period this line has a currently-published closing for, or null when it has none. */
export function latestPublishedPeriodForLine(
  lineCode: string,
  publishedKeys: ReadonlySet<string>,
): string | null {
  const prefix = `${lineCode}|`;
  let latest: string | null = null;
  for (const key of publishedKeys) {
    if (!key.startsWith(prefix)) continue;
    const period = key.slice(prefix.length);
    if (latest === null || period > latest) latest = period;
  }
  return latest;
}

/** Rank the line's reps by achievement in ONE month's closing rows. Reps without a target are skipped. */
export function rankLineAchieversForPeriod(
  rows: readonly AchievementRow[],
  period: string,
  reps: readonly LineAchieverRep[],
  perLine: number,
): LineAchieverRanked[] {
  const repByKey = new Map(reps.map((rep) => [lower(rep.hrId), rep]));
  const totals = new Map<string, { sales: number; target: number }>();
  for (const row of rows) {
    if (row.period !== period) continue;
    const key = lower(row.repHrId);
    if (!key || !repByKey.has(key)) continue;
    const total = totals.get(key) ?? { sales: 0, target: 0 };
    total.sales += row.actualValue;
    total.target += row.targetValue ?? 0;
    totals.set(key, total);
  }

  const ranked: LineAchieverRanked[] = [];
  for (const [key, total] of totals) {
    if (total.target <= 0) continue;
    const rep = repByKey.get(key);
    if (!rep) continue;
    ranked.push({
      achievementPercent: (total.sales / total.target) * 100,
      areaName: rep.areaName,
      hrId: rep.hrId,
      name: rep.displayName,
    });
  }
  return ranked.sort((a, b) => b.achievementPercent - a.achievementPercent).slice(0, perLine);
}
