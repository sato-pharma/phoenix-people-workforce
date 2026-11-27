// ─────────────────────────────────────────────────────────────────────────────
// The Super Admin / CEO overview's sales figures — read from the PUBLISHED Monthly Closing.
//
// 🔒 THE MONTHLY-CLOSING SOURCE-OF-TRUTH GOLDEN RULE (AGENTS.md §4). Every sales and target figure
// equals the published closing. This module invents no reader of its own: it takes the closing
// engine's rows through `loadVsTargetRange` — the same rows Sales vs Target, the portal's team boards
// and the manager incentive tab total — and keeps only (line, month) pairs that are published
// (`loadSalesReleaseKeys` / `isRowPublished`). Measured on production 27 Nov 2026, those rows for
// October equal the publication's frozen `snapshot_breakdown` to the piastre on every line
// (CNS 10,108,214.06 · Pedia 2,890,887.60 · Anti Infective 1,711,454.41 = 14,710,556.07).
//
// WHY THE ENGINE ROWS AND NOT THE SNAPSHOT. The snapshot (`monthly_closing_publications.
// snapshot_breakdown`) is the drift detector's BASELINE, not a reader's source: it carries area,
// product, units and value only — no target and no region — and it is built from the fact rollup,
// so it is blind to the wholesaler city split (see closing-publication-drift.ts). Nothing in the
// app reads it for figures, and a second reader of it here would be a second definition of the
// published month. The engine rows carry the target and the period-aware organogram region the
// closing itself groups by.
//
// THE THREE LOCKED RULES THIS FILE OBEYS.
//   1. VALUE ONLY. Units of different products are never added, so the result has no unit or
//      quantity field anywhere — every aggregate here is EGP.
//   2. HEAD OFFICE IS IN NO CLOSING. Only the three tracked lines (`SALES_LINES`: CNS, Pedia,
//      Anti Infective) are read; any other line — Head Office included — is dropped before a sum.
//      The loader already drops rows with no line (RY001 Royanoxicam is Head Office), and this
//      file filters again so the rule holds even if that changes.
//   3. NEVER A MONTH STILL RUNNING. A publication row for the current Cairo month should not exist
//      (publishClosing refuses it), and if one ever did this file would not show it.
//
// A MONTH PUBLISHED ON SOME LINES BUT NOT ALL. The overview ADDS the three lines together, so a
// month only one or two lines have published would carry a fraction of the company and read as a
// collapse (lines publish one at a time, minutes to days apart — July 2026 spread over four days).
//   - The headline month (`period`, `totalValue`, `byLine`, `byRegion`) is the newest month that
//     EVERY tracked line has published — the same rule as the CEO card's
//     `newestCompanyPublishedPeriod` (owner, 2026-11-04).
//   - `monthly[]` and `achievement` use the same rule per month: a month missing a line's
//     publication is LEFT OUT whole, never shown with the published lines alone. So a gap is a gap
//     in the series, not a short bar.
//
// THE YEAR OF `monthly[]` is the headline month's year, not the Cairo calendar's, so on 2 January
// the chart still shows the year whose December closing is the headline rather than going empty.
// The engine's floor (SALES_VS_TARGET_FLOOR, 2026-07) bounds it from below; publications begin
// there.
//
// ACHIEVEMENT is graded PER LINE, as the Monthly Closing grades a line (owner ruling 2026-09-26,
// the Business Review's rule): each line counts only the months in which IT carries a target
// (`gradedPeriodsOf`), its sales in those months over its target in those months; the lines are
// then summed. A month with zero target contributes neither sales nor target. `rate` is null when
// the summed target is 0 — "no target set" is not "achieved 0%".
//
// REGION NAMES are the closing's own: the engine row's region is the line's organogram (operational)
// region as of that month — so Delta (3), Upper Egypt 1 / 2 and Sharkia appear as the closing
// matrix shows them — named from `au_v_regions` through `loadOperationalRegionResolver`. They are
// deliberately NOT the geographic `code_region_code` of the area, which merges Upper Egypt and
// has no Delta (3).
// ─────────────────────────────────────────────────────────────────────────────

import type { AccessContext } from "@/lib/auth/permissions";
import { isClosingPeriodComplete } from "@/lib/sales/closing-period-gate";
import { loadOperationalRegionResolver } from "@/lib/sales/closing-organogram-regions";
import {
  SALES_LINES,
  lineName,
  regionName as fixedRegionName,
  type AchievementRow,
} from "@/lib/sales/monthly-targets";
import { isSalesPeriodReleasedCompanyWide, loadSalesReleaseKeys } from "@/lib/sales/unpublished-sales-access";
import {
  SALES_VS_TARGET_FLOOR,
  gradedPeriodsOf,
  isRowPublished,
  loadVsTargetRange,
  totalRows,
} from "@/lib/sales/vs-target";
import { resolveVsTargetBound } from "@/lib/sales/vs-target-scope";

export type PublishedClosingSales = {
  /** Newest month published on EVERY tracked line, "YYYY-MM". */
  period: string;
  /** EGP, that month, all tracked lines. */
  totalValue: number;
  /** Share 0..1 of totalValue, sorted by value, largest first. */
  byLine: Array<{ name: string; value: number; share: number }>;
  /** Sorted by value, largest first; region names as the closing shows them. */
  byRegion: Array<{ name: string; value: number; share: number }>;
  /** Every month of the headline month's year published on every tracked line, ascending. */
  monthly: Array<{ period: string; value: number; target: number }>;
  /** Over the published months that carry a target, graded per line; rate null when target 0. */
  achievement: { sales: number; target: number; rate: number | null; fromPeriod: string; toPeriod: string } | null;
};

/** The tracked lines' codes — Head Office has none and is never one of them. */
const TRACKED_LINE_CODES: ReadonlySet<string> = new Set(SALES_LINES.map((line) => line.code));

const UNASSIGNED_REGION = "Unassigned region";

/** Money to the piastre, so a sum of fractional engine cells never prints 0.000000002. */
function toPiastre(value: number): number {
  return Math.round(value * 100) / 100;
}

function periodOfKey(key: string): string {
  return key.slice(key.indexOf("|") + 1);
}

/** Months published on every tracked line and already over in Cairo, ascending. */
export function companyPublishedPeriods(publishedKeys: ReadonlySet<string>, now: Date = new Date()): string[] {
  const periods = new Set<string>();
  for (const key of publishedKeys) {
    const period = periodOfKey(key);
    if (!period || period < SALES_VS_TARGET_FLOOR) continue;
    if (!isClosingPeriodComplete(period, now)) continue;
    if (!isSalesPeriodReleasedCompanyWide(period, publishedKeys)) continue;
    periods.add(period);
  }
  return [...periods].sort();
}

function shareRows(sums: Map<string, number>, total: number): Array<{ name: string; value: number; share: number }> {
  return [...sums.entries()]
    .map(([name, value]) => ({ name, value: toPiastre(value), share: total !== 0 ? value / total : 0 }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

/**
 * The pure half: engine rows + the published (line, period) keys → the overview's figures.
 *
 * Null when no month is published on every tracked line. Rows of an untracked line (Head Office),
 * of an unpublished (line, month), or of a month not published on every line are dropped before
 * any sum.
 */
export function aggregatePublishedClosingSales(input: {
  rows: readonly AchievementRow[];
  publishedKeys: ReadonlySet<string>;
  /** Region code → the closing's display name. Falls back to the fixed table, then the code. */
  regionNameOf?: (regionCode: string) => string | undefined;
  now?: Date;
}): PublishedClosingSales | null {
  const now = input.now ?? new Date();
  const periods = companyPublishedPeriods(input.publishedKeys, now);
  const period = periods[periods.length - 1];
  if (!period) return null;

  const year = period.slice(0, 4);
  const yearPeriods = new Set(periods.filter((candidate) => candidate.startsWith(`${year}-`)));

  const rows = input.rows.filter(
    (row) =>
      row.lineCode != null
      && TRACKED_LINE_CODES.has(row.lineCode)
      && yearPeriods.has(row.period)
      && isRowPublished(row, input.publishedKeys),
  );

  // ── The headline month ──────────────────────────────────────────────────────
  const headline = rows.filter((row) => row.period === period);
  let total = 0;
  const lineSums = new Map<string, number>();
  const regionSums = new Map<string, number>();
  for (const row of headline) {
    total += row.actualValue;
    const line = lineName(row.lineCode);
    lineSums.set(line, (lineSums.get(line) ?? 0) + row.actualValue);
    const code = String(row.regionCode ?? "").trim();
    const region = code ? input.regionNameOf?.(code) || fixedRegionName(code) || code : UNASSIGNED_REGION;
    regionSums.set(region, (regionSums.get(region) ?? 0) + row.actualValue);
  }

  // ── The year, one point per fully published month ───────────────────────────
  const monthSums = new Map<string, { value: number; target: number }>();
  for (const month of yearPeriods) monthSums.set(month, { value: 0, target: 0 });
  for (const row of rows) {
    const sum = monthSums.get(row.period);
    if (!sum) continue;
    sum.value += row.actualValue;
    sum.target += row.targetValue ?? 0;
  }
  const monthly = [...monthSums.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, sum]) => ({ period: month, value: toPiastre(sum.value), target: toPiastre(sum.target) }));

  // ── Achievement, graded per line over the months that line carries a target ──
  let gradedSales = 0;
  let gradedTarget = 0;
  const gradedMonths = new Set<string>();
  for (const lineCode of TRACKED_LINE_CODES) {
    const lineRows = rows.filter((row) => row.lineCode === lineCode);
    if (lineRows.length === 0) continue;
    const graded = gradedPeriodsOf(lineRows);
    if (graded.size === 0) continue;
    const totals = totalRows(lineRows, graded);
    gradedSales += totals.gradedActualValue;
    gradedTarget += totals.targetValue;
    for (const month of graded) gradedMonths.add(month);
  }
  const graded = [...gradedMonths].sort();
  const achievement = graded.length === 0
    ? null
    : {
      sales: toPiastre(gradedSales),
      target: toPiastre(gradedTarget),
      rate: gradedTarget !== 0 ? gradedSales / gradedTarget : null,
      fromPeriod: graded[0],
      toPeriod: graded[graded.length - 1],
    };

  return {
    period,
    totalValue: toPiastre(total),
    byLine: shareRows(lineSums, total),
    byRegion: shareRows(regionSums, total),
    monthly,
    achievement,
  };
}

/**
 * The overview's sales figures from the published closing, company-wide.
 *
 * Null when nothing is published on every tracked line — and also for a viewer whose sales reach is
 * not company-wide: these are company totals, and a narrower viewer must not receive them through
 * the overview. Errors from the publication read propagate (an empty set would claim a published
 * month never was — see loadPublishedPeriodKeys); the caller decides how to degrade.
 */
export async function loadPublishedClosingSales(access: AccessContext): Promise<PublishedClosingSales | null> {
  const bound = await resolveVsTargetBound(access);
  if (bound.kind !== "company") return null;

  const publishedKeys = await loadSalesReleaseKeys();
  const periods = companyPublishedPeriods(publishedKeys);
  const period = periods[periods.length - 1];
  if (!period) return null;

  const yearStart = `${period.slice(0, 4)}-01`;
  const from = yearStart > SALES_VS_TARGET_FLOOR ? yearStart : SALES_VS_TARGET_FLOOR;
  const [rows, regions] = await Promise.all([
    loadVsTargetRange(from, period),
    loadOperationalRegionResolver(),
  ]);

  return aggregatePublishedClosingSales({ rows, publishedKeys, regionNameOf: regions.regionName });
}
