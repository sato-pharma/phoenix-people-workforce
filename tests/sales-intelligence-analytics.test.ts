import assert from "node:assert/strict";

import {
  aggregateByProductKeyed,
  applyDetailsFilters,
  buildDailyCurve,
  buildKpiSparks,
  computeMovers,
  computeRunRate,
  concentrationIndices,
  diffCustomerSets,
  geographicRows,
  latestCompletePeriod,
  makeDelta,
  pickDefaultPeriod,
} from "../src/lib/sales/intelligence/derive.ts";
import type { SiDailyRow, SiDistProductRow, SiReference } from "../src/lib/sales/intelligence/loader.ts";
import type { SiMonthCompleteness } from "../src/lib/sales/intelligence/types.ts";
import { daysInPeriod, shiftPeriod } from "../src/lib/sales/periods.ts";

function reference(): SiReference {
  return {
    regionName: new Map([["R1", "Cairo"]]),
    areaName: new Map(),
    distributorName: new Map([
      ["PS", "Pharma Source"],
      ["EG", "EgyDist"],
    ]),
    brickName: new Map(),
    regionCodesByCanonicalName: new Map(),
  };
}

function dp(partial: Partial<SiDistProductRow>): SiDistProductRow {
  return {
    distributorCode: "PS",
    officialLine: "CNS",
    regionCode: "R1",
    areaCode: "A1",
    productCode: "CN001",
    productName: "Brainol",
    units: 10,
    value: 100,
    ...partial,
  };
}

const approx = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} ≈ ${expected}`);

export function runSalesIntelligenceAnalyticsTests() {
  // ── period math ──────────────────────────────────────────────────────────────────────
  assert.equal(shiftPeriod("2026-01", 1), "2025-12", "MoM wraps the year");
  assert.equal(shiftPeriod("2026-04", 12), "2025-04", "YoY shifts a year");
  assert.equal(shiftPeriod("garbage", 1), null);
  assert.equal(daysInPeriod("2026-04"), 30);
  assert.equal(daysInPeriod("2026-02"), 28);
  assert.equal(daysInPeriod("2024-02"), 29, "leap year");

  // ── makeDelta: baselines are facts, never invented ──────────────────────────────────
  approx(makeDelta(112, 100).pct ?? NaN, 0.12, "MoM +12%");
  assert.equal(makeDelta(112, null).pct, null, "missing baseline → null pct");
  assert.equal(makeDelta(112, 0).pct, null, "zero baseline → null pct");

  // ── movers: stable-code joins, new/lost, null-safe ──────────────────────────────────
  const current = aggregateByProductKeyed([
    dp({ productCode: "CN001", productName: "Brainol", value: 150 }),
    dp({ productCode: "CN002", productName: "Calmex", value: 50 }),
    dp({ productCode: "CN003", productName: "Newlaunch", value: 30 }),
  ]);
  const prior = aggregateByProductKeyed([
    dp({ productCode: "CN001", productName: "Brainol (old name)", value: 100 }), // renamed — code joins anyway
    dp({ productCode: "CN002", productName: "Calmex", value: 80 }),
    dp({ productCode: "CN009", productName: "Gonex", value: 40 }),
  ]);
  const movers = computeMovers(current, prior, 5);
  assert.equal(movers.gainers[0]?.key, "CN001", "Brainol is the top gainer despite the rename");
  approx(movers.gainers[0]?.deltaValue ?? NaN, 50, "gainer delta");
  approx(movers.gainers[0]?.deltaPct ?? NaN, 0.5, "gainer pct");
  assert.equal(movers.decliners[0]?.key, "CN002", "Calmex declined");
  assert.equal(movers.entrants[0]?.key, "CN003", "new entrant flagged");
  assert.equal(movers.entrants[0]?.priorValue, null, "entrant has no fake 0-baseline");
  assert.equal(movers.lost[0]?.key, "CN009", "lost product flagged from prior");
  const noBaseline = computeMovers(current, null);
  assert.equal(noBaseline.gainers.length + noBaseline.decliners.length + noBaseline.entrants.length + noBaseline.lost.length, 0, "no baseline → empty mover sets");

  // ── daily curve: zero-fill, cumulative, undated bucket ──────────────────────────────
  const dailyRows: SiDailyRow[] = [
    { invoiceDate: "2026-04-01", distributorCode: "PS", units: 5, value: 100, customerCount: 3 },
    { invoiceDate: "2026-04-01", distributorCode: "EG", units: 2, value: 50, customerCount: 2 },
    { invoiceDate: "2026-04-03", distributorCode: "PS", units: 4, value: 80, customerCount: 2 },
    { invoiceDate: null, distributorCode: "PS", units: 1, value: 20, customerCount: 1 },
  ];
  const curve = buildDailyCurve(dailyRows, "2026-04");
  assert.equal(curve.points.length, 30, "April zero-fills 30 days");
  approx(curve.points[0].value, 150, "day 1 sums across distributors");
  assert.equal(curve.points[0].customers, 5, "day 1 customer touches sum per distributor");
  approx(curve.points[1].value, 0, "day 2 zero-filled");
  approx(curve.points[2].cumulativeValue, 230, "cumulative MTD");
  approx(curve.undatedValue, 20, "undated bucket reported");
  approx(curve.datedValueShare, 230 / 250, "dated share honest");
  const monthTotal = curve.points[curve.points.length - 1].cumulativeValue + curve.undatedValue;
  approx(monthTotal, 250, "days + undated reconcile to the month total");

  // ── run-rate: gated, reliability flagged ─────────────────────────────────────────────
  const completeRate = computeRunRate(curve, { value: 250, units: 12 }, { monthComplete: true, isCurrentCalendarMonth: false });
  assert.equal(completeRate, null, "a finished complete month never projects");
  const projecting = computeRunRate(curve, { value: 250, units: 12 }, { monthComplete: false, isCurrentCalendarMonth: false });
  assert.ok(projecting, "incomplete month projects");
  assert.equal(projecting?.daysElapsed, 3, "elapsed = last traded day");
  approx(projecting?.projectedValue ?? NaN, (250 / 3) * 30, "projection = daily avg × month days");
  assert.equal(projecting?.reliable, false, "only 2 traded days + share <0.8 thresholds apply (traded days < 5)");

  // ── concentration ───────────────────────────────────────────────────────────────────
  const monopoly = concentrationIndices([{ value: 100 }]);
  assert.equal(monopoly.hhi, 10000);
  assert.equal(monopoly.band, "high");
  const spread = concentrationIndices(Array.from({ length: 10 }, () => ({ value: 10 })));
  assert.equal(spread.hhi, 1000);
  assert.equal(spread.band, "low");

  // ── customer churn ──────────────────────────────────────────────────────────────────
  const ref = reference();
  const cust = (clientCode: string, distributorCode: string, value: number) => ({
    clientCode, clientName: `Pharmacy ${clientCode}`, distributorCode,
    regionCode: "R1", areaCode: "A1", brickId: "B1", units: 1, value,
  });
  const churn = diffCustomerSets(
    [cust("C1", "PS", 100), cust("c2 ", "PS", 50), cust("C4", "EG", 30)],
    [cust("C1", "PS", 90), cust("C2", "PS", 60), cust("C3", "PS", 40)],
    ref,
  );
  assert.equal(churn.newCount, 1, "C4 is new");
  assert.equal(churn.lostCount, 1, "C3 is lost");
  assert.equal(churn.retainedCount, 2, "C1 + C2 retained (key normalization absorbs case/space)");
  approx(churn.retentionRate ?? NaN, 2 / 3, "retention rate");
  assert.equal(churn.topLost[0]?.name, "Pharmacy C3");
  const noPrior = diffCustomerSets([cust("C1", "PS", 100)], null, ref);
  assert.equal(noPrior.retentionRate, null, "no baseline → null retention");

  // ── KPI sparks carry completeness ───────────────────────────────────────────────────
  const sparks = buildKpiSparks(
    [
      { period: "2026-04", units: 100, value: 1000, customerCount: 50, productCount: 10, areaCount: 20 },
      { period: "2026-05", units: 40, value: 400, customerCount: 20, productCount: 8, areaCount: 12 },
    ],
    new Map([
      ["2026-04", { period: "2026-04", expected: [], uploaded: [], missing: [], complete: true }],
      ["2026-05", { period: "2026-05", expected: [], uploaded: [], missing: ["EG"], complete: false }],
    ]),
  );
  assert.equal(sparks[0].monthComplete, true);
  assert.equal(sparks[1].monthComplete, false, "incomplete month flagged in sparks (amber bars)");
  approx(sparks[0].avgPrice, 10, "avg realized price derived");

  // ── geographicRows: the whole Direct (company) channel is non-geographic ─────────────
  const geo = geographicRows([
    dp({ regionCode: "R1", value: 100 }),
    dp({ regionCode: "NATIONAL", value: 500 }), // Direct's synthetic national region
    dp({ regionCode: "national", value: 30 }), // case-insensitive
    dp({ regionCode: "", value: 7 }), // blank is not a region
    dp({ regionCode: "CA", distributorCode: "DIRECT", value: 999 }), // Direct even with a real region
    dp({ regionCode: "GZ", areaCode: "DIRECT", value: 50 }), // synthetic DIRECT area bucket
  ]);
  assert.equal(geo.length, 1, "only the real field-region, non-Direct row survives");
  assert.equal(geo[0].regionCode, "R1", "NATIONAL/blank/Direct dropped from geography");

  // ── applyDetailsFilters: AND across dimensions, empty = match-all ────────────────────
  const filterRows = [
    dp({ distributorCode: "PS", regionCode: "R1", officialLine: "CNS", productCode: "CN001" }),
    dp({ distributorCode: "EG", regionCode: "R1", officialLine: "CNS", productCode: "CN002" }),
    dp({ distributorCode: "PS", regionCode: "R2", officialLine: "Pedia", productCode: "PD001" }),
  ];
  assert.equal(applyDetailsFilters(filterRows, {}).length, 3, "no filters → all rows");
  assert.equal(applyDetailsFilters(filterRows, { distributorCode: "ps" }).length, 2, "distributor filter is case-insensitive");
  assert.equal(applyDetailsFilters(filterRows, { distributorCode: "PS", regionCode: "R2" }).length, 1, "filters AND together");
  assert.equal(applyDetailsFilters(filterRows, { officialLine: "cns" }).length, 2, "line matches by display text, case-insensitive");
  assert.equal(applyDetailsFilters(filterRows, { productCode: "CN002" }).length, 1, "product filter narrows to one");

  // ── default period = latest COMPLETE month (the May-empty-dashboard fix) ─────────────
  const completeness = new Map<string, SiMonthCompleteness>([
    ["2026-03", { period: "2026-03", expected: ["PS", "EG"], uploaded: ["PS", "EG"], missing: [], complete: true }],
    ["2026-04", { period: "2026-04", expected: ["PS", "EG"], uploaded: ["PS", "EG"], missing: [], complete: true }],
    ["2026-05", { period: "2026-05", expected: ["PS", "EG"], uploaded: ["PS"], missing: ["EG"], complete: false }],
  ]);
  const periods = ["2026-05", "2026-03", "2026-04"]; // any order
  assert.equal(latestCompletePeriod(periods, completeness), "2026-04", "newest complete month, not partial May");
  assert.equal(pickDefaultPeriod(periods, completeness), "2026-04", "default lands on the latest complete month");
  const allPartial = new Map<string, SiMonthCompleteness>([
    ["2026-05", { period: "2026-05", expected: ["PS", "EG"], uploaded: ["PS"], missing: ["EG"], complete: false }],
  ]);
  assert.equal(latestCompletePeriod(["2026-05"], allPartial), null, "none complete → null");
  assert.equal(pickDefaultPeriod(["2026-05"], allPartial), "2026-05", "fallback to newest when none complete");
  assert.equal(pickDefaultPeriod([], new Map()), null, "no periods → null");

  // When NO month is complete (the real-world ratcheting case), land on the RICHEST month — the
  // one with the most distributors uploaded — not the freshest thin partial.
  const noneComplete = new Map<string, SiMonthCompleteness>([
    ["2026-03", { period: "2026-03", expected: ["PS", "EG", "IS"], uploaded: ["PS"], missing: ["EG", "IS"], complete: false }],
    ["2026-04", { period: "2026-04", expected: ["PS", "EG", "IS"], uploaded: ["PS", "EG", "IS"], missing: [], complete: false }],
    ["2026-05", { period: "2026-05", expected: ["PS", "EG", "IS"], uploaded: ["PS"], missing: ["EG", "IS"], complete: false }],
  ]);
  assert.equal(
    pickDefaultPeriod(["2026-05", "2026-04", "2026-03"], noneComplete),
    "2026-04",
    "none complete → richest month (most distributors), not the thin newest",
  );
}
