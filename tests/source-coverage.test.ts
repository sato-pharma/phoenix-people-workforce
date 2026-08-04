import assert from "node:assert/strict";

import {
  aggregateCoverage,
  classifyCoverage,
  previousPeriod,
  type CoverageFactRow,
} from "../src/lib/sales/source-coverage.ts";

function factRow(overrides: Partial<CoverageFactRow>): CoverageFactRow {
  return {
    distributorCode: "PS",
    regionCode: "",
    isDirect: false,
    productCode: "LA001",
    period: "2026-07",
    totalQty: 0,
    effectiveUnits: 0,
    directValue: 0,
    ...overrides,
  };
}

export function runSourceCoverageTests() {
  // ── previousPeriod ─────────────────────────────────────────────────────────
  assert.equal(previousPeriod("2026-07"), "2026-06");
  assert.equal(previousPeriod("2026-01"), "2025-12", "January compares against December of the year before");
  assert.equal(previousPeriod("2026-13"), null, "an impossible month is rejected, never wrapped into next year");
  assert.equal(previousPeriod("2026-7"), null, "only the canonical YYYY-MM form the batch table stores is accepted");
  assert.equal(previousPeriod(null), null);

  // ── aggregateCoverage — a July-shaped month ───────────────────────────────
  // Prev month has Overseas + Ibn Sina + Direct in two regions; current month has Overseas and
  // only ONE of the Direct regions — the exact shape of the July 2026 incident.
  const prices = new Map([["LA001", 100]]);
  const rows: CoverageFactRow[] = [
    factRow({ period: "2026-06", distributorCode: "PS", totalQty: 10, effectiveUnits: 8 }),
    factRow({ period: "2026-06", distributorCode: "IS", totalQty: 5, effectiveUnits: 5 }),
    factRow({ period: "2026-06", distributorCode: "Direct", isDirect: true, regionCode: "GZ", totalQty: 3, directValue: 300 }),
    factRow({ period: "2026-06", distributorCode: "Direct", isDirect: true, regionCode: "D2", totalQty: 2, directValue: 200 }),
    factRow({ period: "2026-07", distributorCode: "PS", totalQty: 7, effectiveUnits: 7 }),
    factRow({ period: "2026-07", distributorCode: "Direct", isDirect: true, regionCode: "GZ", totalQty: 1, directValue: 90 }),
    // Outside the compared window — must not count anywhere.
    factRow({ period: "2026-05", distributorCode: "RM", totalQty: 99, effectiveUnits: 99 }),
    // Confidential — both closing RPCs skip LA003/LA004/SS001, so coverage must too.
    factRow({ period: "2026-06", distributorCode: "PS", productCode: "LA003", totalQty: 50, effectiveUnits: 50 }),
    // A product with no factory price values at 0 but still proves the source showed up.
    factRow({ period: "2026-06", distributorCode: "MC", productCode: "XX999", totalQty: 4, effectiveUnits: 4 }),
  ];
  const aggregates = aggregateCoverage(rows, {
    period: "2026-07",
    prevPeriod: "2026-06",
    factoryPriceByProduct: prices,
  });

  assert.equal(aggregates.sourcesPrev.get("PS")?.value, 800, "distributor rows are valued effective units × factory price — the matrix RPC's own basis");
  assert.equal(aggregates.sourcesPrev.get("PS")?.units, 10, "the confidential LA003 row bumps neither units nor value — it is outside the closing headline");
  assert.equal(aggregates.sourcesPrev.get("Direct")?.value, 500, "direct rows carry their submitted value, never a factory-price recompute");
  assert.equal(aggregates.sourcesPrev.get("MC")?.value, 0, "an unpriced product contributes 0, matching the RPC's coalesce(factory_price, 0)");
  assert.equal(aggregates.sourcesPrev.get("MC")?.rows, 1, "…but its rows still count, so the source reads present rather than missing");
  assert.equal(aggregates.sourcesPrev.has("RM"), false, "a row outside the two compared months is ignored entirely");
  assert.equal(aggregates.directPrev.get("D2")?.value, 200);
  assert.equal(aggregates.directCur.has("D2"), false, "the region the Direct sheet dropped shows up only on the prev side");

  // ── classifyCoverage over the aggregates ──────────────────────────────────
  const sources = classifyCoverage(
    aggregates.sourcesPrev,
    aggregates.sourcesCur,
    (key) => (key === "PS" ? "Overseas" : key),
  );
  const sourceByKey = new Map(sources.map((entry) => [entry.key, entry]));
  assert.equal(sourceByKey.get("IS")?.status, "missing", "rows last month and none this month is exactly what 'missing' means");
  assert.equal(sourceByKey.get("PS")?.status, "present");
  assert.equal(sourceByKey.get("PS")?.name, "Overseas", "human names resolve through the lookup — a code never surfaces when a name exists");
  assert.equal(sources[0]?.key, "PS", "entries sort by last-month value, biggest first, so the largest hole leads");

  const regions = classifyCoverage(aggregates.directPrev, aggregates.directCur, (key) => key);
  const regionByKey = new Map(regions.map((entry) => [entry.key, entry]));
  assert.equal(regionByKey.get("D2")?.status, "missing", "a Direct region absent this month is reported even though the Direct file itself arrived");
  assert.equal(regionByKey.get("GZ")?.status, "present");

  // ── presence is decided on rows, not value ────────────────────────────────
  const prevCredit = new Map([["SF-T", { rows: 2, units: -21, value: -722.93 }]]);
  const curCredit = new Map([
    ["SF-T", { rows: 1, units: -3, value: -100 }],
    ["EPX", { rows: 4, units: 9, value: 90 }],
  ]);
  const creditEntries = classifyCoverage(prevCredit, curCredit, (key) => key);
  const creditByKey = new Map(creditEntries.map((entry) => [entry.key, entry]));
  assert.equal(creditByKey.get("SF-T")?.status, "present", "a credit-note-only source (negative value) still has rows and must not read as missing");
  assert.equal(creditByKey.get("SF-T")?.prevValue, -722.93, "values keep their sign and 2dp rounding");
  assert.equal(creditByKey.get("EPX")?.status, "new", "rows this month with none last month is 'new', not 'present'");
}
