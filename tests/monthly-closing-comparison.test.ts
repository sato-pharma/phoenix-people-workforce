import assert from "node:assert/strict";

import {
  avgRealizedPrice,
  buildInsights,
  buildValueGrid,
  computeMix,
  coverage,
  pareto,
  productGaps,
  rollupByDistributor,
  singleDistributorAreas,
  topN,
  whiteSpaceAreas,
  whiteSpaceBricks,
  type ComparisonNameMaps,
  type DistProductRow,
} from "../src/lib/sales/monthly-closing-comparison.ts";

const maps: ComparisonNameMaps = {
  areaName: new Map([["A1", "Heliopolis"], ["A2", "Nasr City"], ["A3", "Alex East"], ["A4", "Down Town"]]),
  distributorName: new Map([["PS", "overseas"], ["IS", "Ibn sina"]]),
  regionName: new Map([["CA", "Cairo"], ["AB", "Alex"]]),
};

const dist: DistProductRow[] = [
  { areaCode: "A1", distributorCode: "PS", productCode: "P-A", productName: "Product A", regionCode: "CA", units: 10, value: 100 },
  { areaCode: "A1", distributorCode: "PS", productCode: "P-B", productName: "Product B", regionCode: "CA", units: 5, value: 50 },
  { areaCode: "A1", distributorCode: "IS", productCode: "P-A", productName: "Product A", regionCode: "CA", units: 4, value: 40 },
  { areaCode: "A3", distributorCode: "IS", productCode: "P-A", productName: "Product A", regionCode: "AB", units: 7, value: 70 },
  { areaCode: "A2", distributorCode: "PS", productCode: "P-A", productName: "Product A", regionCode: "CA", units: 3, value: 30 },
];

export function runMonthlyClosingComparisonTests() {
  // rollupByDistributor — value, units, counts, share, no double counting.
  const rollup = rollupByDistributor({ brickRows: [], customerRows: [], distProductRows: dist, maps });
  const ps = rollup.find((r) => r.distributorCode === "PS");
  const is = rollup.find((r) => r.distributorCode === "IS");
  assert.equal(rollup[0]?.distributorCode, "PS"); // sorted by value desc
  assert.equal(ps?.value, 180);
  assert.equal(ps?.units, 18);
  assert.equal(ps?.productCount, 2);
  assert.equal(ps?.areaCount, 2);
  assert.equal(is?.value, 110);
  assert.equal(Number((ps!.valueShare + is!.valueShare).toFixed(6)), 1); // shares sum to 1

  // computeMix — shares sum to 1; zero-total safe.
  const mix = computeMix([{ label: "P-A", value: 240 }, { label: "P-B", value: 50 }]);
  assert.equal(Number(mix.reduce((s, m) => s + m.share, 0).toFixed(6)), 1);
  assert.equal(computeMix([]).length, 0);
  assert.equal(computeMix([{ label: "z", value: 0 }])[0]?.share, 0);

  // buildValueGrid — leader is argmax; totals correct.
  const grid = buildValueGrid(
    dist.map((r) => ({ distributorCode: r.distributorCode, key: r.productCode, label: r.productName, value: r.value })),
    ["PS", "IS"],
    maps,
  );
  const pa = grid.find((g) => g.key === "P-A");
  assert.equal(pa?.total, 240);
  assert.equal(pa?.byDistributor.PS, 130);
  assert.equal(pa?.byDistributor.IS, 110);
  assert.equal(pa?.leader?.distributorCode, "PS");

  // topN — order, rank, share, cap.
  const ranked = topN([
    { key: "P-A", label: "Product A", units: 24, value: 240 },
    { key: "P-B", label: "Product B", units: 5, value: 50 },
  ], 1);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.rank, 1);
  assert.equal(ranked[0]?.key, "P-A");

  // pareto — top-N share.
  const par = pareto([{ label: "c1", value: 80 }, { label: "c2", value: 15 }, { label: "c3", value: 5 }], 1);
  assert.equal(par.total, 100);
  assert.equal(par.topValue, 80);
  assert.equal(par.share, 0.8);

  // white-space — master minus sold.
  const zeroAreas = whiteSpaceAreas(
    [
      { areaCode: "A1", areaName: "Heliopolis", regionCode: "CA" },
      { areaCode: "A2", areaName: "Nasr City", regionCode: "CA" },
      { areaCode: "A3", areaName: "Alex East", regionCode: "AB" },
      { areaCode: "A4", areaName: "Down Town", regionCode: "CA" },
    ],
    new Set(["A1", "A2", "A3"]),
    maps,
  );
  assert.equal(zeroAreas.length, 1);
  assert.equal(zeroAreas[0]?.areaCode, "A4");

  const zeroBricks = whiteSpaceBricks(
    [{ areaCode: "A1", brickId: "B-1", brickName: "Brick One", regionCode: "CA" }, { areaCode: "A1", brickId: "B-2", brickName: "Brick Two", regionCode: "CA" }],
    new Set(["B-1"]),
    maps,
  );
  assert.equal(zeroBricks.length, 1);
  assert.equal(zeroBricks[0]?.brickId, "B-2");

  // single-distributor areas — A2 (PS only) and A3 (IS only); A1 has both.
  const single = singleDistributorAreas(dist, { ...maps, areaRegion: new Map([["A1", "CA"], ["A2", "CA"], ["A3", "AB"]]) });
  assert.equal(single.length, 2);
  assert.ok(single.every((s) => s.areaCode !== "A1"));

  // product gaps — P-B sold only in CA, missing AB.
  const gaps = productGaps(dist, ["CA", "AB"], maps);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.productCode, "P-B");
  assert.deepEqual(gaps[0]?.missingRegions, ["Alex"]);

  // avg realized price — value / units (here all 10).
  const avg = avgRealizedPrice(dist, maps);
  assert.ok(avg.every((row) => row.avgPrice === 10));

  // coverage — reach vs master totals.
  const cov = coverage(rollup, 4, 10);
  assert.equal(cov.find((c) => c.distributorName === "overseas")?.areasReached, 2);

  // insights — deterministic, non-empty for this data.
  const insights = buildInsights({
    areaByDistributor: [], avgPrice: [], byDistributor: rollup, coverage: cov,
    data: { areaByDist: [], bricks: [], customers: [], distProduct: [], masterAreas: [], masterBricks: [], productByDist: [] },
    distributors: [], line: "CNS",
    mix: { distributor: [], product: [], region: [] },
    national: { areaCount: 3, customerCount: 0, productCount: 2, units: 29, value: 290 },
    pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
    period: "2026-04", productByDistributor: [],
    rankings: { areas: [], bricks: [], customers: [], products: topN([{ key: "P-A", label: "Product A", units: 24, value: 240 }], 10), regions: [] },
    regionByDistributor: [], totalAreas: 4, totalBricks: 10,
    whiteSpace: { productGaps: gaps, singleDistributorAreas: single, zeroSalesAreas: zeroAreas, zeroSalesBricks: zeroBricks },
  });
  assert.ok(insights.length > 0);
  assert.ok(insights.some((b) => b.text.includes("leads")));
}
