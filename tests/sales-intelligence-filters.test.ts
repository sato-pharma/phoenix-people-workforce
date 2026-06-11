import assert from "node:assert/strict";

import {
  aggregateByDistributor,
  aggregateByRegion,
  applyDetailsFilters,
  applyGeoChannelFilters,
  hasProductOrLineFilter,
} from "../src/lib/sales/intelligence/derive.ts";
import type { SiDistProductRow, SiReference } from "../src/lib/sales/intelligence/loader.ts";

function reference(): SiReference {
  return {
    regionName: new Map([
      ["R1", "Cairo"],
      ["R2", "Delta"],
    ]),
    areaName: new Map([
      ["A1", "Nasr City"],
      ["A2", "Tanta"],
    ]),
    distributorName: new Map([
      ["PS", "Overseas"],
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

const sum = (rows: SiDistProductRow[]) => rows.reduce((total, row) => total + row.value, 0);

export function runSalesIntelligenceFiltersTests() {
  const rows: SiDistProductRow[] = [
    dp({ distributorCode: "PS", regionCode: "R1", areaCode: "A1", officialLine: "CNS", productCode: "CN001", value: 100 }),
    dp({ distributorCode: "PS", regionCode: "R2", areaCode: "A2", officialLine: "GI", productCode: "GI001", value: 40 }),
    dp({ distributorCode: "EG", regionCode: "R1", areaCode: "A1", officialLine: "CNS", productCode: "CN001", value: 25 }),
    dp({ distributorCode: "EG", regionCode: "R2", areaCode: "A2", officialLine: "GI", productCode: "GI002", value: 35 }),
  ];

  // ── applyDetailsFilters: narrowing only, never widening ────────────────────────────────
  assert.equal(applyDetailsFilters(rows, {}).length, 4, "empty filter set → every row");
  assert.equal(applyDetailsFilters(rows, { distributorCode: "PS" }).length, 2, "distributor narrows");
  assert.equal(applyDetailsFilters(rows, { regionCode: "R1" }).length, 2, "region narrows");
  assert.equal(applyDetailsFilters(rows, { areaCode: "A2" }).length, 2, "area narrows");
  assert.equal(applyDetailsFilters(rows, { officialLine: "CNS" }).length, 2, "line narrows");
  assert.equal(applyDetailsFilters(rows, { productCode: "CN001" }).length, 2, "product narrows");
  assert.equal(
    applyDetailsFilters(rows, { distributorCode: "PS", regionCode: "R1" }).length,
    1,
    "multiple filters AND together",
  );

  // case-insensitivity: codes upper-fold, line lower-folds (see applyDetailsFilters)
  assert.equal(applyDetailsFilters(rows, { distributorCode: "ps" }).length, 2, "distributor is case-insensitive");
  assert.equal(applyDetailsFilters(rows, { officialLine: "cns" }).length, 2, "line is case-insensitive");
  assert.equal(applyDetailsFilters(rows, { areaCode: "a1" }).length, 2, "area is case-insensitive");

  // no-widen: filtering an empty input can only yield empty; a filter never invents a row
  assert.equal(applyDetailsFilters([], { distributorCode: "PS" }).length, 0, "filtering [] yields []");
  assert.equal(
    applyDetailsFilters(rows, { distributorCode: "NOPE" }).length,
    0,
    "an out-of-set filter value yields zero rows, never a leak",
  );

  // ── restricted product cannot be resurrected by a filter ───────────────────────────────
  // Rows reach the filter already scope-stripped (no LA003/LA004). Filtering FOR a restricted
  // code therefore matches nothing — the exclusion can never be widened by the toolbar.
  assert.equal(applyDetailsFilters(rows, { productCode: "LA003" }).length, 0, "restricted code matches no scoped row");

  // ── filtered aggregates reflect the filtered slice (proves KPIs/aggregates use filtered rows) ──
  const r1 = applyDetailsFilters(rows, { regionCode: "R1" });
  assert.equal(sum(r1), 125, "R1 slice = 100 + 25");
  const dist = aggregateByDistributor(r1, reference());
  assert.equal(dist.length, 2, "R1 has two distributors");
  assert.equal(dist[0].name, "Overseas", "names, never codes");
  assert.equal(dist.find((d) => d.name === "Overseas")?.value, 100, "Overseas R1 value");
  assert.equal(dist.find((d) => d.name === "EgyDist")?.value, 25, "EgyDist R1 value");

  const ps = applyDetailsFilters(rows, { distributorCode: "PS" });
  const regions = aggregateByRegion(ps, reference());
  assert.equal(sum(ps), 140, "PS slice = 100 + 40");
  assert.deepEqual(regions.map((row) => row.name).sort(), ["Cairo", "Delta"], "region names resolved");

  // ── applyGeoChannelFilters: customer grain narrows by geo/channel, NOT by line/product ──
  assert.equal(applyGeoChannelFilters(rows, { regionCode: "R1" }).length, 2, "customer filter narrows by region");
  assert.equal(applyGeoChannelFilters(rows, { distributorCode: "EG" }).length, 2, "customer filter narrows by distributor");
  assert.equal(applyGeoChannelFilters(rows, { areaCode: "A2" }).length, 2, "customer filter narrows by area");
  assert.equal(
    applyGeoChannelFilters(rows, { officialLine: "CNS" }).length,
    4,
    "line filter is IGNORED at customer grain (a customer spans products)",
  );
  assert.equal(
    applyGeoChannelFilters(rows, { productCode: "CN001" }).length,
    4,
    "product filter is IGNORED at customer grain",
  );
  assert.equal(applyGeoChannelFilters(rows, {}).length, 4, "no geo/channel filter → all rows");

  // ── hasProductOrLineFilter drives the customer/daily limitation caption ─────────────────
  assert.equal(hasProductOrLineFilter({ regionCode: "R1" }), false, "geo-only filter → no product/line caption");
  assert.equal(hasProductOrLineFilter({ officialLine: "CNS" }), true, "line filter flagged");
  assert.equal(hasProductOrLineFilter({ productCode: "CN001" }), true, "product filter flagged");
}
