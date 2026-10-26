// Region and area totals at a glance for the Sales Drilldown — read from the CLOSING ENGINE.
//
// Pure: no IO. The pharmacy figures inside an area come from the uploaded sheets (the closing has
// no pharmacy grain), but the totals a manager reads on a region or area header are sales figures
// in their own right, so by the Monthly Closing golden rule they come through the closing engine
// and cover only months with a published closing (see territory/window.ts).

import { expandAreaCodeForLine } from "@/lib/sales/closing-area-merges";
import type { AchievementRow } from "@/lib/sales/monthly-targets";

import type { TerritoryAreaNode, TerritoryClosingTotals } from "./types";

/**
 * Sum the closing engine's `actualValue` (VALUE — never units, which only add up inside one
 * product) per skeleton area for one line, then per region.
 *
 * LANES. The skeleton folds a line's merged areas as of today (CNS shows Fayoum (GZ6) + Beni Suef
 * (UE9) as one "Fayoum - Beni Suef" lane keyed GZ6, and Qena 1 + Qena 2 as one Qena lane), so a
 * lane's total reads every real code via expandAreaCodeForLine with the same "as of today" rule.
 * Every row stays on the lane of its OWN real area code: the tree is today's geography, so Pedia's
 * Beni Suef sales stay on Beni Suef's lane even for August, when the closing printed them inside a
 * "Fayoum - Beni Suef" row. Nothing moves between areas and nothing is lost. A real area code is
 * counted once per region.
 *
 * OTHER AREAS. An area without a target has no lane (the skeleton drops it), but its sales are in
 * the closing — September 2026 alone held 784,926 EGP of CNS in the Others region. With
 * `includeOtherAreas` (a region or nationwide viewer) they are added to the row's own region when
 * the tree draws that region, and — for a nationwide viewer — to `outsideRegionsValue` otherwise, so
 * the overall figure equals the line's published closing. An area-scoped viewer gets only their own
 * areas.
 */
export function sumTerritoryClosingTotals(input: {
  rows: readonly AchievementRow[];
  auLineCode: string;
  areas: readonly TerritoryAreaNode[];
  periods: readonly string[];
  includeOtherAreas?: boolean;
  nationwide?: boolean;
}): TerritoryClosingTotals {
  const periodSet = new Set(input.periods);
  const laneCodes = new Set<string>();
  const laneRealCodes = new Map<string, string[]>();
  const realCodesByRegion = new Map<string, Set<string>>();
  for (const area of input.areas) {
    const areaKey = area.areaCode.trim().toUpperCase();
    const regionKey = area.regionCode.trim().toUpperCase();
    const realCodes = expandAreaCodeForLine(input.auLineCode, areaKey);
    laneRealCodes.set(areaKey, realCodes);
    const regionCodes = realCodesByRegion.get(regionKey) ?? new Set<string>();
    for (const code of realCodes) {
      regionCodes.add(code);
      laneCodes.add(code);
    }
    realCodesByRegion.set(regionKey, regionCodes);
  }

  const valueByRealArea = new Map<string, number>();
  const otherByRegion = new Map<string, number>();
  let outside = 0;
  for (const row of input.rows) {
    if (row.lineCode !== input.auLineCode || !row.areaCode || !periodSet.has(row.period)) continue;
    const value = Number.isFinite(row.actualValue) ? row.actualValue : 0;
    const key = row.areaCode.trim().toUpperCase();
    if (laneCodes.has(key)) {
      valueByRealArea.set(key, (valueByRealArea.get(key) ?? 0) + value);
      continue;
    }
    if (!input.includeOtherAreas) continue;
    const regionKey = (row.regionCode ?? "").trim().toUpperCase();
    if (regionKey && realCodesByRegion.has(regionKey)) {
      otherByRegion.set(regionKey, (otherByRegion.get(regionKey) ?? 0) + value);
    } else if (input.nationwide) {
      outside += value;
    }
  }

  const areaValues: Record<string, number> = {};
  for (const [areaKey, realCodes] of laneRealCodes) {
    areaValues[areaKey] = realCodes.reduce((sum, code) => sum + (valueByRealArea.get(code) ?? 0), 0);
  }

  const regionValues: Record<string, number> = {};
  const regionOtherValues: Record<string, number> = {};
  for (const [regionKey, codes] of realCodesByRegion) {
    const other = otherByRegion.get(regionKey) ?? 0;
    regionOtherValues[regionKey] = other;
    regionValues[regionKey] = [...codes].reduce((sum, code) => sum + (valueByRealArea.get(code) ?? 0), 0) + other;
  }

  return {
    periods: [...input.periods],
    areaValues,
    regionValues,
    regionOtherValues,
    outsideRegionsValue: input.nationwide && input.includeOtherAreas ? outside : null,
  };
}
