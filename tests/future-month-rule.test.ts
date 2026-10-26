import assert from "node:assert/strict";

import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { isFuturePeriod, latestNonFuturePeriod, toWeeklyCycleMonth } from "../src/lib/sales/periods.ts";
import { buildSosCoverageReport } from "../src/lib/sales/sos-coverage.ts";
import { sumTerritoryClosingTotals } from "../src/lib/sales/territory/totals.ts";
import {
  periodSpanLabel,
  territoryWindow,
  territoryWindowNote,
  TERRITORY_DEFAULT_WINDOW_MONTHS,
} from "../src/lib/sales/territory/window.ts";
import { buildPortalWeeklyExportFilename } from "../src/lib/sales/weekly/portal-weekly-export.ts";
import { selectWeeklyProductUnitsMonths } from "../src/lib/sales/weekly/portal-weekly-product-units.ts";
import type { WeeklyDashboard } from "../src/lib/sales/weekly/types.ts";

/**
 * THE FUTURE-MONTH RULE — a month after today (Cairo) is never the current or the comparison month.
 *
 * WHY THIS EXISTS. A Direct order collecting next month is booked into next month's period, so on
 * 26 Oct 2026 a November batch already existed. The order is correct; the READERS were wrong: the
 * Source of Sales dashboard opened on November (near empty), the coverage grid counted November as a
 * loaded month, the weekly screens compared November against October, and the Sales Drilldown's
 * window ended at the current UTC month instead of the latest published Monthly Closing.
 */
const TODAY = "2026-10-26";

function achievement(
  period: string,
  lineCode: string | null,
  areaCode: string,
  actualValue: number,
  regionCode: string | null = null,
  isOther = false,
): AchievementRow {
  return {
    period,
    lineCode,
    regionCode,
    areaCode,
    areaState: null,
    isOther,
    repSeatId: null,
    repHrId: null,
    dmSeatId: null,
    dmHrId: null,
    productCode: "P1",
    actualUnits: 1,
    actualValue,
    targetUnits: null,
    targetValue: null,
    achievementValue: null,
    achievementUnits: null,
    hasTarget: false,
    hasActual: true,
  };
}

export async function runFutureMonthRuleTests(): Promise<void> {
  // ── periods.ts ──────────────────────────────────────────────────────────────────────────────
  assert.equal(isFuturePeriod("2026-11", TODAY), true, "next month is in the future");
  assert.equal(isFuturePeriod("2026-11-01", TODAY), true, "a weekly cycle month (first of month) reads the same way");
  assert.equal(isFuturePeriod("2026-10", TODAY), false, "the current month has started");
  assert.equal(isFuturePeriod("2026-09", TODAY), false);
  assert.equal(isFuturePeriod("not-a-month", TODAY), false, "garbage is never called future");
  assert.equal(isFuturePeriod(null, TODAY), false);

  assert.equal(latestNonFuturePeriod(["2026-11", "2026-10", "2026-09"], TODAY), "2026-10");
  assert.equal(latestNonFuturePeriod(["2026-09", "2026-11-01", "2026-10-01"], TODAY), "2026-10-01");
  assert.equal(latestNonFuturePeriod(["2026-12", "2026-11"], TODAY), null, "every month in the future → null");
  assert.equal(latestNonFuturePeriod([], TODAY), null);

  assert.equal(toWeeklyCycleMonth("2026-10"), "2026-10-01", "the ?months=2026-10 deep link means the October cycle");
  assert.equal(toWeeklyCycleMonth(" 2026-10-01 "), "2026-10-01");

  // ── Source of Sales coverage: a future batch is not a loaded month ──────────────────────────
  const coverage = buildSosCoverageReport(
    [
      { period: "2026-09", distributorCode: "UCP", distributorName: "United", totalValue: 100 },
      { period: "2026-10", distributorCode: "UCP", distributorName: "United", totalValue: 80 },
      { period: "2026-11", distributorCode: "DIRECT", distributorName: "Direct", totalValue: 5 },
    ],
    TODAY,
  );
  assert.deepEqual(coverage.loadedPeriods, ["2026-09", "2026-10"], "November's forward-dated Direct batch is not a loaded month");
  assert.deepEqual(coverage.periods.map((entry) => entry.period), ["2026-09", "2026-10"]);
  assert.ok(!coverage.distributors.some((entry) => /direct/i.test(`${entry.name} ${entry.distributorCode}`)), "a source seen only in a future month is not a distributor on the grid");

  // ── Weekly product units: the month window never reaches past today ─────────────────────────
  assert.deepEqual(
    selectWeeklyProductUnitsMonths(["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"], 3, TODAY),
    ["2026-08-01", "2026-09-01", "2026-10-01"],
  );

  // ── Weekly export file name: "all months" names the latest STARTED month ────────────────────
  const exportData = {
    appliedFilters: { cycleMonths: [] },
    availableMonths: [{ code: "2099-01-01" }, { code: "2026-09-01" }],
  } as unknown as WeeklyDashboard;
  assert.equal(buildPortalWeeklyExportFilename(exportData), "phoenix-weekly-sales-2026-09-export.xlsx");

  // ── Sales Drilldown window: ends at the newest published closing, never the open month ───────
  const published = territoryWindow(["2026-11", "2026-09", "2026-08", "2026-07"], TERRITORY_DEFAULT_WINDOW_MONTHS, TODAY);
  assert.equal(published.basis, "published");
  assert.equal(published.latestPublishedPeriod, "2026-09", "a future published month is ignored");
  assert.deepEqual(published.periods, ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
  assert.deepEqual(published.publishedPeriods, ["2026-07", "2026-08", "2026-09"]);
  assert.equal(periodSpanLabel(published.periods), "Apr – Sep 2026");
  assert.match(territoryWindowNote(published), /Apr – Sep 2026/);
  assert.match(territoryWindowNote(published), /published Monthly Closing, Jul – Sep 2026/);

  const live = territoryWindow([], 6, TODAY);
  assert.equal(live.basis, "live");
  assert.equal(live.latestPublishedPeriod, null);
  assert.deepEqual(live.periods, ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.match(territoryWindowNote(live), /^Live figures, May – Oct 2026/);

  assert.equal(territoryWindow(["2026-09"], 99, TODAY).periods.length, TERRITORY_DEFAULT_WINDOW_MONTHS, "an out-of-range window falls back to the default");
  assert.equal(periodSpanLabel(["2025-11", "2025-12", "2026-01"]), "Nov 2025 – Jan 2026");
  assert.equal(periodSpanLabel([]), "");

  // ── Region and area totals from the closing engine (VALUE, folded areas kept) ───────────────
  // The skeleton folds areas as of today, and so do the totals: CNS folds Fayoum (GZ6) + Beni Suef
  // (UE9) from 2026-08 with no end, while Pedia separated them from 2026-09.
  const rows = [
    achievement("2026-09", "cns", "GZ6", 100),
    achievement("2026-09", "cns", "UE9", 40),
    achievement("2026-09", "cns", "D12", 60),
    achievement("2026-08", "cns", "D12", 10),
    achievement("2026-06", "cns", "D12", 999), // outside the published months
    achievement("2026-09", "pedia", "D12", 500), // another line
    achievement("2026-09", "pedia", "GZ6", 7),
    achievement("2026-09", "pedia", "UE9", 3),
  ];
  const totals = sumTerritoryClosingTotals({
    rows,
    auLineCode: "cns",
    areas: [
      { areaCode: "GZ6", areaName: "Fayoum - Beni Suef", regionCode: "UPPER" },
      { areaCode: "D12", areaName: "Mansoura", regionCode: "DELTA" },
    ],
    periods: ["2026-08", "2026-09"],
  });
  assert.equal(totals.areaValues.GZ6, 140, "CNS's Fayoum lane carries Beni Suef (UE9) too");
  assert.equal(totals.areaValues.D12, 70, "only the published months, only this line");
  assert.equal(totals.regionValues.UPPER, 140);
  assert.equal(totals.regionValues.DELTA, 70);

  const pediaTotals = sumTerritoryClosingTotals({
    rows,
    auLineCode: "pedia",
    areas: [
      { areaCode: "GZ6", areaName: "Fayoum", regionCode: "UPPER" },
      { areaCode: "UE9", areaName: "Beni Suef", regionCode: "UPPER" },
    ],
    periods: ["2026-09"],
  });
  assert.equal(pediaTotals.areaValues.GZ6, 7, "Pedia's Fayoum stands alone since September");
  assert.equal(pediaTotals.areaValues.UE9, 3);
  assert.equal(pediaTotals.regionValues.UPPER, 10, "a region sums its areas, each real code once");
  assert.deepEqual(totals.periods, ["2026-08", "2026-09"]);
  assert.equal(totals.outsideRegionsValue, null, "no Other-area figure unless asked for");

  // Every row stays on its own real area's lane, in today's geography: Pedia's August Beni Suef
  // sales stay on Beni Suef even though August's closing printed them inside "Fayoum - Beni Suef".
  const pediaAugust = sumTerritoryClosingTotals({
    rows: [achievement("2026-08", "pedia", "GZ6", 7), achievement("2026-08", "pedia", "UE9", 3)],
    auLineCode: "pedia",
    areas: [
      { areaCode: "GZ6", areaName: "Fayoum", regionCode: "UPPER" },
      { areaCode: "UE9", areaName: "Beni Suef", regionCode: "UPPER" },
    ],
    periods: ["2026-08"],
  });
  assert.equal(pediaAugust.areaValues.GZ6, 7, "August Fayoum keeps only Fayoum");
  assert.equal(pediaAugust.areaValues.UE9, 3, "August Beni Suef stays on Beni Suef's lane");
  assert.equal(pediaAugust.regionValues.UPPER, 10, "nothing moves and nothing is lost");

  // Areas without a target have no lane, but their sales are in the closing: a region or nationwide
  // viewer's region total carries them, so it equals the closing's region figure.
  const otherRows = [
    achievement("2026-09", "anti", "D31", 100, "D3"),
    achievement("2026-09", "anti", "D3-OTHER", 25, "D3", true), // an Other area in a drawn region
    achievement("2026-09", "anti", "OT1", 9, "OT", true), // an Other area in a region the tree never draws
  ];
  const otherAreas = [{ areaCode: "D31", areaName: "Tanta", regionCode: "D3" }];
  const regionView = sumTerritoryClosingTotals({
    rows: otherRows,
    auLineCode: "anti",
    areas: otherAreas,
    periods: ["2026-09"],
    includeOtherAreas: true,
  });
  assert.equal(regionView.areaValues.D31, 100, "an area's own lane never takes an Other area's sales");
  assert.equal(regionView.regionValues.D3, 125, "a region's total includes its areas without a target");
  assert.equal(regionView.regionOtherValues.D3, 25);
  assert.equal(regionView.outsideRegionsValue, null, "a region viewer never sees another region's Other areas");

  const nationwideView = sumTerritoryClosingTotals({
    rows: otherRows,
    auLineCode: "anti",
    areas: otherAreas,
    periods: ["2026-09"],
    includeOtherAreas: true,
    nationwide: true,
  });
  assert.equal(nationwideView.regionValues.D3, 125);
  assert.equal(nationwideView.outsideRegionsValue, 9, "nationwide, the Others region is counted so the line total equals the closing");

  const areaView = sumTerritoryClosingTotals({
    rows: otherRows,
    auLineCode: "anti",
    areas: otherAreas,
    periods: ["2026-09"],
  });
  assert.equal(areaView.regionValues.D3, 100, "an area-scoped viewer gets only their own areas");
  assert.equal(areaView.regionOtherValues.D3, 0);
  assert.equal(areaView.outsideRegionsValue, null);
}
