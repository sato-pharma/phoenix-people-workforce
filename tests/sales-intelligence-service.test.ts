import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripRestrictedRows } from "../src/lib/sales/access-scope.ts";
import {
  aggregateByDistributor,
  aggregateByLine,
  aggregateByProduct,
  aggregateByRegion,
  aggregateCustomers,
  computeMonthCompleteness,
  sumTotals,
} from "../src/lib/sales/intelligence/derive.ts";
import type { SiDistProductRow, SiReference } from "../src/lib/sales/intelligence/loader.ts";

function reference(): SiReference {
  return {
    regionName: new Map([
      ["R1", "Cairo"],
      ["R2", "Giza"],
    ]),
    areaName: new Map([
      ["A1", "Nasr City"],
      ["A2", "Dokki"],
    ]),
    distributorName: new Map([
      ["PS", "Pharma Source"],
      ["EG", "EgyDist"],
    ]),
    brickName: new Map(),
    regionCodesByCanonicalName: new Map(),
  };
}

function row(partial: Partial<SiDistProductRow>): SiDistProductRow {
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

export function runSalesIntelligenceServiceTests() {
  const ref = reference();

  // ── Restricted products never reach an aggregate (loader strips before derive) ───────
  const rawRows = [
    row({ productCode: "CN001", productName: "Brainol", value: 100 }),
    row({ productCode: "LA003", productName: "Lacto Basic 1", officialLine: "Head Office", value: 999 }),
    row({ productCode: "LA004", productName: "Lacto Basic 2", officialLine: "Head Office", value: 999 }),
  ];
  const scoped = stripRestrictedRows(rawRows, ["LA003", "LA004"]);
  const products = aggregateByProduct(scoped);
  assert.equal(products.length, 1, "only the non-restricted product survives");
  assert.equal(products[0].name, "Brainol");
  assert.ok(
    !products.some((product) => /lacto basic/i.test(product.name)),
    "Lacto Basic must never appear in product aggregates",
  );

  // ── Totals + shares ──────────────────────────────────────────────────────────────
  const rows = [
    row({ distributorCode: "PS", regionCode: "R1", productCode: "CN001", productName: "Brainol", value: 600, units: 60 }),
    row({ distributorCode: "EG", regionCode: "R2", productCode: "CN002", productName: "Calmex", value: 400, units: 40 }),
  ];
  const totals = sumTotals(rows);
  approx(totals.value, 1000, "total value");
  approx(totals.units, 100, "total units");

  const byProduct = aggregateByProduct(rows);
  approx(byProduct[0].share, 0.6, "top product share");
  approx(byProduct[0].cumulativeShare, 0.6, "cumulative after first");
  approx(byProduct[1].cumulativeShare, 1, "cumulative reaches 1");
  approx(byProduct.reduce((sum, product) => sum + product.share, 0), 1, "product shares sum to 1");

  const byRegion = aggregateByRegion(rows, ref);
  assert.equal(byRegion[0].name, "Cairo", "regions resolved BY NAME");
  approx(byRegion.reduce((sum, region) => sum + region.share, 0), 1, "region shares sum to 1");

  const byLine = aggregateByLine(rows);
  assert.equal(byLine[0].name, "CNS");

  const byDistributor = aggregateByDistributor(rows, ref);
  assert.equal(byDistributor[0].name, "Pharma Source", "distributors resolved BY NAME");
  assert.ok(byDistributor[0].productMix.length >= 1, "distributor carries a product mix");

  const customers = aggregateCustomers(
    [
      { clientCode: "C1", clientName: "Pharmacy One", distributorCode: "PS", regionCode: "R1", areaCode: "A1", brickId: "B1", units: 5, value: 800 },
      { clientCode: "C2", clientName: "Pharmacy Two", distributorCode: "EG", regionCode: "R2", areaCode: "A2", brickId: "B2", units: 5, value: 200 },
    ],
    ref,
  );
  assert.equal(customers.customerCount, 2);
  assert.equal(customers.customers[0].name, "Pharmacy One");
  approx(customers.top10Share, 1, "top-10 share is 1 when only 2 customers exist");

  // ── Month completeness (the live April-vs-May scenario) ────────────────────────────
  const batches = [
    ...["Direct", "EG", "EP-S", "IS", "IS-S", "PS", "RM", "SF"].map((d) => ({ period: "2026-04", distributorCode: d })),
    ...["Direct", "PS"].map((d) => ({ period: "2026-05", distributorCode: d })),
  ];
  const active = ["Direct", "EG", "EP-S", "IS", "IS-S", "PS", "RM", "SF"];
  const completeness = computeMonthCompleteness(batches, active);
  assert.equal(completeness.get("2026-04")?.complete, true, "earliest month is complete");
  assert.equal(completeness.get("2026-05")?.complete, false, "May is incomplete");
  assert.equal(completeness.get("2026-05")?.missing.length, 6, "May is missing 6 distributors");
  assert.ok(completeness.get("2026-05")?.missing.includes("EG"), "EG flagged missing in May");

  // Inactive distributors are not 'expected' even if they appeared historically.
  const withRetired = computeMonthCompleteness(
    [{ period: "2026-04", distributorCode: "OLD" }, { period: "2026-05", distributorCode: "PS" }],
    ["PS"],
  );
  assert.equal(withRetired.get("2026-05")?.complete, true, "a retired (inactive) distributor is not expected");

  // ── Structural guards: every route goes through the scope-resolving wrapper ─────────
  const routes = ["summary", "trend", "products", "geography", "distributors", "customers"];
  for (const route of routes) {
    const source = readFileSync(
      new URL(`../app/api/sales/intelligence/${route}/route.ts`, import.meta.url),
      "utf8",
    );
    assert.match(source, /handleSiRequest/, `${route} route must use handleSiRequest`);
  }
  const requestSource = readFileSync(
    new URL("../src/lib/sales/intelligence/request.ts", import.meta.url),
    "utf8",
  );
  assert.match(requestSource, /resolveSalesAccessScope/, "request helper must resolve sales scope");
  assert.match(requestSource, /assertPermission\(access, "sales"/, "request helper must enforce sales permission");
}
