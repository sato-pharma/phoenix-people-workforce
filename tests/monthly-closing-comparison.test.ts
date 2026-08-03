import assert from "node:assert/strict";

import {
  assembleComparison,
  avgRealizedPrice,
  buildInsights,
  buildValueGrid,
  comparisonLeavesFromRows,
  computeMix,
  coverage,
  pareto,
  productGaps,
  rollupByDistributor,
  scopeComparisonInput,
  singleDistributorAreas,
  topN,
  whiteSpaceAreas,
  whiteSpaceBricks,
  type AssembleComparisonInput,
  type ComparisonNameMaps,
  type ComparisonSourceRow,
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

  runComparisonScopeTests();
}

// ── scopeComparisonInput — the export's filter must reach the comparison sheets ───────────────
// Before this, the Comparison/Rankings/Gaps/Summary sheets always covered the whole month while
// the Matrix sheet next to them was filtered, so one workbook showed two different populations.
function runComparisonScopeTests() {
  const baseInput: AssembleComparisonInput = {
    brickRows: [
      { areaCode: "A1", brickId: "B1", distributorCode: "PS", regionCode: "CA", units: 10, value: 100 },
      { areaCode: "A3", brickId: "B3", distributorCode: "IS", regionCode: "AB", units: 7, value: 70 },
    ],
    customerRows: [
      { areaCode: "A1", brickId: "B1", clientCode: "C1", clientName: "Cairo Pharmacy", distributorCode: "PS", regionCode: "CA", units: 10, value: 100 },
      { areaCode: "A3", brickId: "B3", clientCode: "C3", clientName: "Alex Pharmacy", distributorCode: "IS", regionCode: "AB", units: 7, value: 70 },
    ],
    distProductRows: dist,
    line: "CNS",
    maps: { areaName: maps.areaName, areaRegion: new Map([["A1", "CA"], ["A2", "CA"], ["A3", "AB"]]), distributorName: maps.distributorName, regionName: maps.regionName },
    masterAreas: [
      { areaCode: "A1", areaName: "Heliopolis", regionCode: "CA" },
      { areaCode: "A2", areaName: "Nasr City", regionCode: "CA" },
      { areaCode: "A3", areaName: "Alex East", regionCode: "AB" },
    ],
    masterBricks: [
      { areaCode: "A1", brickId: "B1", brickName: "Brick 1", regionCode: "CA" },
      { areaCode: "A3", brickId: "B3", brickName: "Brick 3", regionCode: "AB" },
    ],
    period: "2026-04",
  };

  // No scope, and an all-empty scope, must both be exact pass-throughs — an unfiltered export
  // has to keep behaving precisely as it did before.
  assert.equal(scopeComparisonInput(baseInput, undefined), baseInput);
  assert.equal(scopeComparisonInput(baseInput, { areaCodes: [], regionCodes: [], search: "" }), baseInput);

  // Region filter — this is the owner's acceptance case (one region only, every sheet).
  const cairo = scopeComparisonInput(baseInput, { regionCodes: ["CA"] });
  assert.ok(cairo.distProductRows.length > 0);
  assert.ok(cairo.distProductRows.every((row) => row.regionCode === "CA"));
  assert.ok(cairo.brickRows.every((row) => row.regionCode === "CA"));
  assert.ok(cairo.customerRows.every((row) => row.regionCode === "CA"));

  // The masters narrow with the rows. This is the assertion that matters most: leaving them
  // national would report every area in the rest of the country as an unsold "white space" gap.
  assert.deepEqual(cairo.masterAreas.map((area) => area.areaCode), ["A1", "A2"]);
  assert.deepEqual(cairo.masterBricks.map((brick) => brick.brickId), ["B1"]);

  // Lower-case input still matches an upper-case code, and is trimmed.
  assert.equal(scopeComparisonInput(baseInput, { regionCodes: [" ca "] }).distProductRows.length, cairo.distProductRows.length);

  // Area filter, and a free-text search that resolves through the area NAME (not the code) —
  // the same match the closing matrix filter makes, so the two sheets keep the same areas.
  assert.ok(scopeComparisonInput(baseInput, { areaCodes: ["A3"] }).distProductRows.every((row) => row.areaCode === "A3"));
  const byName = scopeComparisonInput(baseInput, { search: "alex east" });
  assert.ok(byName.distProductRows.length > 0);
  assert.ok(byName.distProductRows.every((row) => row.areaCode === "A3"));

  // Distributor filter — the matrix cannot express this, but the comparison leaves can.
  const onlyIbnSina = scopeComparisonInput(baseInput, { distributorCodes: ["IS"] });
  assert.ok(onlyIbnSina.distProductRows.length > 0);
  assert.ok(onlyIbnSina.distProductRows.every((row) => row.distributorCode === "IS"));
  assert.ok(onlyIbnSina.customerRows.every((row) => row.distributorCode === "IS"));

  // Product narrows the product rows only — brick/customer rows carry no product code, so they
  // are deliberately left alone rather than silently emptied.
  const onlyPB = scopeComparisonInput(baseInput, { productCodes: ["P-B"] });
  assert.ok(onlyPB.distProductRows.every((row) => row.productCode === "P-B"));
  assert.equal(onlyPB.customerRows.length, baseInput.customerRows.length);

  // A filter that matches nothing yields nothing — never a silent fall back to the whole month.
  const nothing = scopeComparisonInput(baseInput, { regionCodes: ["__NO_MATCHING_AREA__"] });
  assert.equal(nothing.distProductRows.length, 0);
  assert.equal(nothing.masterAreas.length, 0);

  // The region NAME MAP is narrowed too, because productGaps enumerates it as the universe of
  // regions a product could be missing from. Left whole, a Cairo-only export would report every
  // product as "missing from Alex" — a gap outside the slice, which the reader cannot act on.
  assert.deepEqual([...cairo.maps.regionName.keys()], ["CA"]);
  assert.equal(
    assembleComparison(cairo).whiteSpace.productGaps.length,
    0,
    "no gap is invented against a region the filter excluded",
  );
  // ...while an unfiltered export still reports the real one (P-B sold in Cairo, absent in Alex).
  assert.equal(assembleComparison(baseInput).whiteSpace.productGaps.length, 1);

  // Scoping feeds assembleComparison, so the derived numbers follow too: Cairo's value is the
  // 220 from A1 (100 + 50 + 40) and A2 (30) — not the 290 national total, which is what these
  // sheets reported before regardless of the filter.
  const scoped = assembleComparison(cairo);
  assert.equal(scoped.national.value, 220);
  assert.equal(scoped.totalAreas, 2);
  assert.equal(assembleComparison(baseInput).national.value, 290);

  runLeavesFromRowsTests();
}

// ── comparisonLeavesFromRows — the row-level filtered export's comparison source ──────────────
// A distributor / Included-Excluded / free-text / product filter slices inside the closing
// aggregates, so the Comparison/Rankings/Gaps/Summary sheets (and the hidden Calc sheet the
// Matrix sheet's formulas read) are rebuilt from the exact rows the Data sheet shows.
function runLeavesFromRowsTests() {
  const sourceRow = (over: Partial<ComparisonSourceRow>): ComparisonSourceRow => ({
    areaCode: "A1", brickId: "B1", brickName: "Brick 1", clientCode: "C1", clientName: "Cairo Pharmacy",
    distributorCode: "PS", includedInClosing: true, productCode: "P-A", productName: "Product A",
    qty: 10, regionCode: "CA", salesValue: 100, ...over,
  });

  const leaves = comparisonLeavesFromRows([
    sourceRow({}),
    sourceRow({ qty: 5, salesValue: 50 }),                                  // same keys — must merge
    sourceRow({ clientCode: "C2", clientName: "Second Pharmacy", qty: 2, salesValue: 20 }),
    sourceRow({ distributorCode: "IS", qty: 4, salesValue: 40 }),
    sourceRow({ includedInClosing: false, qty: 99, salesValue: 990 }),      // excluded — never counts
    sourceRow({ brickId: "", clientCode: "", qty: 1, salesValue: 10 }),     // no brick/client keys
  ]);

  // distProduct: PS x CA x A1 x P-A merges rows 1+2+3+6 = 18 units / 180 value; IS holds 4/40.
  const ps = leaves.distProductRows.find((row) => row.distributorCode === "PS");
  const is = leaves.distProductRows.find((row) => row.distributorCode === "IS");
  assert.equal(leaves.distProductRows.length, 2);
  assert.equal(ps?.units, 18, "units mirror the RPC's sum(total_qty)");
  assert.equal(ps?.value, 180, "value mirrors the RPC's sum(effective_units x factory_price)");
  assert.equal(is?.value, 40);

  // The excluded row's 990 must appear NOWHERE — the closing RPCs never see excluded rows either.
  const allValues = [
    ...leaves.distProductRows, ...leaves.brickRows, ...leaves.customerRows,
  ].map((row) => row.value);
  assert.ok(allValues.every((value) => value < 990), "an excluded row never reaches any leaf");

  // Rows without a brick/customer key stay out of those leaves (they are absent from the RPCs
  // too) but still count in distProduct — dropping them entirely would understate the products.
  assert.ok(leaves.brickRows.every((row) => row.brickId === "B1"));
  // PS|C1, PS|C2 and IS|C1 — per distributor + client, the same grouping phx_closing_customers
  // pages by. The blank client key is not a customer.
  assert.equal(leaves.customerRows.length, 3);
  assert.ok(leaves.customerRows.every((row) => row.clientCode.trim() !== ""));

  // Feeding the leaves into the real assembly narrows every derived sheet at once: only the
  // distributors present in the rows exist, and totals are sums of exactly these rows.
  const fromRows = assembleComparison({
    ...leaves,
    line: "CNS",
    maps: {
      areaName: maps.areaName,
      areaRegion: new Map([["A1", "CA"]]),
      distributorName: maps.distributorName,
      regionName: maps.regionName,
    },
    masterAreas: [{ areaCode: "A1", areaName: "Heliopolis", regionCode: "CA" }],
    masterBricks: [{ areaCode: "A1", brickId: "B1", brickName: "Brick 1", regionCode: "CA" }],
    period: "2026-07",
  });
  assert.equal(fromRows.national.value, 220, "PS 180 + IS 40 — the filtered slice only");
  assert.deepEqual(fromRows.distributors.map((d) => d.code).sort(), ["IS", "PS"]);
}
