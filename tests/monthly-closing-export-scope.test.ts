import assert from "node:assert/strict";

import {
  assembleComparison,
  scopeComparisonInput,
  scopeRegionNames,
  type BrickRow,
  type CustomerRow,
  type DistProductRow,
} from "../src/lib/sales/monthly-closing-comparison.ts";

// The Monthly Closing workbook must contain ONLY the slice the reader filtered on screen. Before
// this, exactly one of its ten sheets honoured the filter (the Closing Matrix); Distributor
// Comparison, Rankings & Mix, Gaps & White-Space, Summary & Insights, the Data/Total audit pair
// and the hidden Calc block every live formula references were all company-wide — so an export
// filtered to Delta (1) still listed Alex-BHR bricks and customers.
//
// scopeComparisonInput narrows the LEAF rows and the masters before assembly, which is the only
// place that makes shares, ranks and coverage denominators come out right. These tests pin that,
// plus the fail-closed rule that a filter matching nothing exports nothing.

const AREA_NAMES = new Map([["D15", "Gharbia 2"], ["D16", "Kafr El-Sheikh 1"], ["AB1", "Alexandria 1"]]);
const AREA_REGION = new Map([["D15", "D1"], ["D16", "D1"], ["AB1", "AB"]]);
const REGION_NAMES = new Map([["D1", "Delta (1)"], ["AB", "Alex-BHR"]]);
const DISTRIBUTOR_NAMES = new Map([["PS", "Pharma Serve"], ["IS", "Ibn Sina"]]);

const distProductRows: DistProductRow[] = [
  { areaCode: "D15", distributorCode: "PS", productCode: "P1", productName: "Royafloxacin", regionCode: "D1", units: 10, value: 1000 },
  { areaCode: "D15", distributorCode: "PS", productCode: "P2", productName: "Saginko", regionCode: "D1", units: 5, value: 500 },
  { areaCode: "D16", distributorCode: "IS", productCode: "P1", productName: "Royafloxacin", regionCode: "D1", units: 3, value: 300 },
  { areaCode: "AB1", distributorCode: "PS", productCode: "P1", productName: "Royafloxacin", regionCode: "AB", units: 20, value: 2000 },
  { areaCode: "AB1", distributorCode: "IS", productCode: "P2", productName: "Saginko", regionCode: "AB", units: 7, value: 700 },
];

const brickRows: BrickRow[] = [
  { areaCode: "D15", brickId: "B-D15-1", distributorCode: "PS", regionCode: "D1", units: 15, value: 1500 },
  { areaCode: "D16", brickId: "B-D16-1", distributorCode: "IS", regionCode: "D1", units: 3, value: 300 },
  { areaCode: "AB1", brickId: "B-AB1-1", distributorCode: "PS", regionCode: "AB", units: 27, value: 2700 },
];

const customerRows: CustomerRow[] = [
  { areaCode: "D15", brickId: "B-D15-1", clientCode: "C1", clientName: "Delta Pharmacy", distributorCode: "PS", regionCode: "D1", units: 15, value: 1500 },
  { areaCode: "D16", brickId: "B-D16-1", clientCode: "C2", clientName: "Kafr Pharmacy", distributorCode: "IS", regionCode: "D1", units: 3, value: 300 },
  { areaCode: "AB1", brickId: "B-AB1-1", clientCode: "C3", clientName: "Alex Pharmacy", distributorCode: "PS", regionCode: "AB", units: 27, value: 2700 },
];

const masterAreas = [
  { areaCode: "D15", areaName: "Gharbia 2", regionCode: "D1" },
  { areaCode: "D16", areaName: "Kafr El-Sheikh 1", regionCode: "D1" },
  { areaCode: "AB1", areaName: "Alexandria 1", regionCode: "AB" },
];

const masterBricks = [
  { areaCode: "D15", brickId: "B-D15-1", brickName: "Mahalla", regionCode: "D1" },
  { areaCode: "D15", brickId: "B-D15-2", brickName: "Samannoud", regionCode: "D1" },
  { areaCode: "D16", brickId: "B-D16-1", brickName: "Kafr El-Sheikh", regionCode: "D1" },
  { areaCode: "AB1", brickId: "B-AB1-1", brickName: "Sidi Gaber", regionCode: "AB" },
  { areaCode: "AB1", brickId: "B-AB1-2", brickName: "Smouha", regionCode: "AB" },
];

// A whole AssembleComparisonInput: scopeComparisonInput reads the name maps to match a search
// term, so the leaf rows alone are not enough.
function input() {
  return {
    brickRows,
    customerRows,
    distProductRows,
    line: "Anti Infective",
    maps: {
      areaName: AREA_NAMES,
      areaRegion: AREA_REGION,
      distributorName: DISTRIBUTOR_NAMES,
      regionName: REGION_NAMES,
    },
    masterAreas,
    masterBricks,
    period: "2026-07",
  };
}

// Mirrors loadMonthlyClosingComparison: scope the leaf rows and masters, then narrow the region
// name map the same way the loader does before handing both to assembleComparison.
function assembleScoped(scope: Parameters<typeof scopeComparisonInput>[1]) {
  const scoped = scopeComparisonInput(input(), scope);
  return assembleComparison({
    ...scoped,
    maps: {
      ...scoped.maps,
      regionName: scopeRegionNames(scoped.maps.regionName, scoped.masterAreas, scope),
    },
  });
}

export function runMonthlyClosingExportScopeTests() {
  // ── No filter → the input is passed through untouched (the unfiltered export is unchanged) ──
  const unscoped = scopeComparisonInput(input(), undefined);
  assert.equal(unscoped.distProductRows.length, 5, "no scope keeps every distributor-product row");
  assert.equal(unscoped.brickRows.length, 3, "no scope keeps every brick row");
  assert.equal(unscoped.masterBricks.length, 5, "no scope keeps the whole brick master");

  // ── Region filter (the reported case: filter Delta (1), export, still see Alex-BHR) ──
  const d1 = scopeComparisonInput(input(), { regionCodes: ["D1"], areaCodes: ["D15", "D16"] });
  assert.deepEqual(
    [...new Set(d1.distProductRows.map((row) => row.regionCode))],
    ["D1"],
    "distributor-product rows are limited to the filtered region",
  );
  assert.deepEqual(
    d1.brickRows.map((row) => row.brickId),
    ["B-D15-1", "B-D16-1"],
    "brick rows drop every brick outside the filtered areas",
  );
  assert.deepEqual(
    d1.customerRows.map((row) => row.clientCode),
    ["C1", "C2"],
    "customer rows drop customers outside the filtered areas",
  );
  assert.deepEqual(
    d1.masterAreas.map((area) => area.areaCode),
    ["D15", "D16"],
    "the area master narrows too, so coverage % is out of the filtered areas",
  );
  assert.deepEqual(
    d1.masterBricks.map((brick) => brick.brickId),
    ["B-D15-1", "B-D15-2", "B-D16-1"],
    "the brick master narrows, so white-space is not the whole country",
  );

  // ── Single area ──
  const oneArea = scopeComparisonInput(input(), { regionCodes: ["D1"], areaCodes: ["D15"] });
  assert.deepEqual(oneArea.brickRows.map((row) => row.brickId), ["B-D15-1"], "one area keeps only its bricks");
  assert.equal(oneArea.distProductRows.length, 2, "one area keeps only its two product rows");

  // ── Fail closed: a filter that matched no area must export nothing, never everything ──
  // An empty list means "this dimension is not filtered", so the export route never passes one for
  // a narrowing filter — it stands in a code no area can carry. Both halves of that contract are
  // pinned here, because getting either wrong hands back the whole company.
  const matchedNothing = scopeComparisonInput(input(), { areaCodes: ["__NO_MATCHING_AREA__"] });
  assert.equal(matchedNothing.distProductRows.length, 0, "the no-match sentinel matches nothing, not everything");
  assert.equal(matchedNothing.brickRows.length, 0, "the no-match sentinel drops every brick row");
  assert.equal(matchedNothing.masterAreas.length, 0, "the no-match sentinel drops the whole area master");

  const notFiltered = scopeComparisonInput(input(), { areaCodes: [] });
  assert.equal(notFiltered.distProductRows.length, 5, "an empty list reads as 'area not filtered', per the route's contract");

  // ── Product filter narrows what carries a product; brick/customer rollups have no product ──
  const p1 = scopeComparisonInput(input(), { productCodes: ["P1"] });
  assert.deepEqual(
    [...new Set(p1.distProductRows.map((row) => row.productCode))],
    ["P1"],
    "a product filter narrows the distributor-product rows",
  );
  assert.equal(
    p1.brickRows.length,
    3,
    "brick rows are per line with no product dimension — the workbook says so rather than pretending",
  );
  assert.equal(p1.customerRows.length, 3, "customer rows likewise carry no product dimension");
  assert.equal(p1.masterAreas.length, 3, "a product-only filter must not narrow geography");

  // ── End to end: nothing from outside the filter survives anywhere in the assembled comparison ──
  const filtered = assembleScoped({ regionCodes: ["D1"], areaCodes: ["D15", "D16"] });
  const serialized = JSON.stringify(filtered);
  assert.ok(!serialized.includes("B-AB1-1"), "no out-of-scope brick id anywhere in the comparison");
  assert.ok(!serialized.includes("Alex Pharmacy"), "no out-of-scope customer anywhere in the comparison");
  assert.ok(!serialized.includes("Alexandria 1"), "no out-of-scope area name anywhere in the comparison");

  // The hidden Calc block — the source every live workbook formula points at.
  assert.deepEqual(
    filtered.data.bricks.map((brick) => brick.brickId),
    ["B-D15-1", "B-D16-1"],
    "the Calc brick block only holds filtered bricks",
  );
  assert.deepEqual(
    filtered.data.masterBricks.map((brick) => brick.brickId),
    ["B-D15-1", "B-D15-2", "B-D16-1"],
    "the Calc brick master only holds filtered bricks",
  );
  assert.equal(filtered.data.distProduct.length, 3, "the Calc fact block only holds filtered sales rows");

  // Totals, ranks and coverage denominators are recomputed over the slice, not the company.
  assert.equal(filtered.national.value, 1800, "national value = 1000 + 500 + 300, not the company's 4500");
  assert.equal(filtered.national.areaCount, 2, "two areas sold in the filtered slice");
  assert.equal(filtered.totalAreas, 2, "coverage denominator is the filtered area master");
  assert.equal(filtered.totalBricks, 3, "coverage denominator is the filtered brick master");
  assert.deepEqual(
    filtered.whiteSpace.zeroSalesBricks.map((brick) => brick.brickId),
    ["B-D15-2"],
    "white-space lists only unsold bricks inside the filter",
  );
  assert.deepEqual(
    filtered.rankings.regions.map((row) => row.key),
    ["D1"],
    "region ranking covers the filtered region only",
  );
  // Product Gaps names the regions a product is missing from. Unnarrowed, a Delta-only export
  // would name Alex-BHR as a gap for every product — a region the reader filtered out.
  assert.deepEqual(
    scopeRegionNames(REGION_NAMES, [{ regionCode: "D1" }], { areaCodes: ["D15"] }),
    new Map([["D1", "Delta (1)"]]),
    "the region denominator narrows to the filtered regions",
  );
  assert.equal(
    scopeRegionNames(REGION_NAMES, [{ regionCode: "D1" }], undefined),
    REGION_NAMES,
    "no geography filter leaves the region map exactly as it was",
  );
  assert.ok(
    filtered.whiteSpace.productGaps.every((gap) => !gap.missingRegions.includes("Alex-BHR")),
    "product gaps never name a region outside the filter",
  );

  const psShare = filtered.byDistributor.find((row) => row.distributorCode === "PS");
  assert.ok(psShare, "the filtered slice still rolls up by distributor");
  assert.equal(psShare.value, 1500, "distributor value is the filtered value (1000 + 500)");
  assert.equal(
    Number(psShare.valueShare.toFixed(4)),
    Number((1500 / 1800).toFixed(4)),
    "distributor share is out of the filtered total, not the company total",
  );

  // ── An unfiltered assembly still sees everything (the fix narrows nothing on its own) ──
  const whole = assembleScoped(undefined);
  assert.equal(whole.national.value, 4500, "unfiltered export still totals the whole company");
  assert.equal(whole.totalBricks, 5, "unfiltered export still uses the whole brick master");
}
