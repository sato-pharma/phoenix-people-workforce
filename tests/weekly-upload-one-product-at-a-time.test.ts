import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { summarizeWeekly } from "../src/lib/sales/weekly/parser.ts";
import type { WeeklyParsedRow } from "../src/lib/sales/weekly/types.ts";
import { weeklyUploadUnitScope } from "../src/lib/sales/weekly/unit-totals.ts";

// THE UPLOAD SCREEN SHOWS UNITS ONE PRODUCT AT A TIME (owner, 2026-09-19).
//
// A weekly sheet of several products left the Upload screen's four unit tiles, By branch and By region
// holding nothing but dashes: the screen shows units only, and units of different products are never
// added (owner rule, 2026-08-27), so every figure that added a branch's or a region's products was
// withheld. The owner uploaded POS's six-product "Purchasing Sales Data" sheet, found a screen of dashes,
// and raised it. Both rules stand. The fix is a product picker: the tiles, By branch and By region show
// the picked product's own units — the Upload screen's counterpart of the dashboard's Product filter —
// and a sheet of one product shows its own totals as before.

function row(overrides: Partial<WeeklyParsedRow>): WeeklyParsedRow {
  return {
    rowNumber: 2,
    weekStart: "2026-09-18",
    distributorCode: "POS",
    distributorName: "POS",
    regionCode: "D1",
    regionName: "Delta (1)",
    areaCode: null,
    branchCode: "Key Acc.W Banha",
    branchName: "Key Acc.W Banha",
    itemCode: "37804",
    productCode: "SA001",
    productName: "Saginko",
    officialLine: "CNS",
    salesQty: 0,
    returnQty: 0,
    netQty: 0,
    bonusQty: 0,
    salesValue: 0,
    stockQty: 0,
    validationState: "valid",
    validationIssues: [],
    rawRow: {},
    ...overrides,
  };
}

function units(salesQty: number, returnQty: number, price: number) {
  const netQty = salesQty - returnQty;
  return { salesQty, returnQty, netQty, salesValue: netQty * price };
}

function summarize(rows: WeeklyParsedRow[]) {
  return summarizeWeekly({
    rows,
    distributor: { code: "POS", name: "POS" },
    fileName: "Purchasing Sales Data.xlsx",
    sheetName: "Purchasing Sales Data",
    weekStart: "2026-09-18",
    blockingReasons: [],
  });
}

export async function runWeeklyUploadOneProductAtATimeTests() {
  // Two products, one branch shared by both. Banha carries 250 Saginko and 10 Satoslim.
  const rows = [
    row({ ...units(250, 0, 139), branchCode: "Key Acc.W Banha", branchName: "Key Acc.W Banha", regionCode: "D1", regionName: "Delta (1)" }),
    row({ ...units(81, 0, 139), branchCode: "Super KA Delta", branchName: "Super KA Delta", regionCode: "D2", regionName: "Delta (2)" }),
    row({
      ...units(10, 0, 254),
      productCode: "SS001",
      productName: "Satoslim",
      branchCode: "Key Acc.W Banha",
      branchName: "Key Acc.W Banha",
      regionCode: "D1",
      regionName: "Delta (1)",
    }),
    row({
      ...units(3, 1, 254),
      productCode: "SS001",
      productName: "Satoslim",
      branchCode: "Retail Kafr AlZayat2",
      branchName: "Retail Kafr AlZayat2",
      regionCode: "D1",
      regionName: "Delta (1)",
    }),
  ];
  const result = summarize(rows);

  // ── 1. The result carries each product's own By branch and By region ─────────────────────────────
  {
    assert.deepEqual(
      result.byProductGeography.map((entry) => entry.productCode),
      result.byProduct.map((entry) => entry.productCode),
      "byProductGeography follows byProduct, one entry per product",
    );
    const saginko = result.byProductGeography.find((entry) => entry.productCode === "SA001");
    assert.ok(saginko, "Saginko has its own geography");
    assert.deepEqual(
      saginko.byBranch.map((branch) => [branch.branchName, branch.netQty]),
      [["Key Acc.W Banha", 250], ["Super KA Delta", 81]],
      "Saginko's By branch holds only Saginko's units — Banha's 10 Satoslim are not added in",
    );
    assert.deepEqual(
      saginko.byRegion.map((region) => [region.regionCode, region.netQty]),
      [["D1", 250], ["D2", 81]],
      "Saginko's By region holds only Saginko's units",
    );
    const satoslim = result.byProductGeography.find((entry) => entry.productCode === "SS001");
    assert.ok(satoslim, "Satoslim has its own geography");
    assert.deepEqual(
      satoslim.byBranch.map((branch) => [branch.branchName, branch.salesQty, branch.returnQty, branch.netQty]),
      [["Key Acc.W Banha", 10, 0, 10], ["Retail Kafr AlZayat2", 3, 1, 2]],
      "Satoslim's By branch keeps its sales and returns apart",
    );
    // The sheet-wide tables are unchanged: Banha still adds both products (value is what they rank by).
    const banha = result.byBranch.find((branch) => branch.branchName === "Key Acc.W Banha");
    assert.equal(banha?.netQty, 260, "the sheet-wide By branch is built exactly as before");
  }

  // ── 2. The screen's scope: the picked product, never a sum of products ──────────────────────────
  {
    const first = weeklyUploadUnitScope(result, null);
    assert.ok(first, "a sheet of several products has a scope to show");
    assert.equal(first.productKey, "SA001", "with nothing picked, the first product — the largest by value — is shown");
    assert.equal(first.productName, "Saginko");
    assert.equal(first.totals.netQty, 331, "the tiles hold Saginko's own net units, not the sheet's 343");
    assert.deepEqual(first.byBranch.map((branch) => branch.netQty), [250, 81], "By branch is Saginko's");

    const picked = weeklyUploadUnitScope(result, "SS001");
    assert.equal(picked?.productKey, "SS001", "a pick is honoured");
    assert.equal(picked?.totals.netQty, 12, "the tiles hold Satoslim's own net units");
    assert.deepEqual(picked?.byRegion.map((region) => region.netQty), [12], "By region is Satoslim's");

    const stale = weeklyUploadUnitScope(result, "NOT-IN-THIS-FILE");
    assert.equal(stale?.productKey, "SA001", "a pick from an earlier file falls back to this file's first product");

    for (const scope of [first, picked, stale]) {
      assert.ok(scope, "every scope resolves");
      const productKeys = new Set(
        result.byProductGeography
          .filter((entry) => entry.byBranch === scope.byBranch || entry.byRegion === scope.byRegion)
          .map((entry) => entry.productCode),
      );
      assert.equal(productKeys.size, 1, "a scope's branch and region tables are ONE product's, never the sheet-wide sum");
    }
  }

  // ── 3. A sheet of one product shows its own totals, with nothing to pick ─────────────────────────
  {
    const single = summarize(rows.filter((entry) => entry.productCode === "SA001"));
    const scope = weeklyUploadUnitScope(single, "SS001");
    assert.ok(scope, "a one-product sheet has a scope");
    assert.equal(scope.productKey, null, "a one-product sheet needs no pick");
    assert.equal(scope.totals, single.totals, "its tiles are the sheet's own totals");
    assert.equal(scope.byBranch, single.byBranch, "its By branch is the sheet's own");
    assert.equal(scope.byRegion, single.byRegion, "its By region is the sheet's own");
  }

  // ── 4. No product at all keeps the dashes ────────────────────────────────────────────────────────
  assert.equal(weeklyUploadUnitScope(summarize([]), null), null, "an empty sheet has nothing to show");

  // ── 5. The wiring: the screen prints the scope, and only the scope ──────────────────────────────
  {
    const upload = readFileSync(
      fileURLToPath(new URL("../src/components/sales/weekly/weekly-upload-workspace.tsx", import.meta.url)),
      "utf8",
    );
    assert.match(
      upload,
      /const unitScope = weeklyUploadUnitScope\(result, pickedProduct\);/,
      "the Upload screen asks the shared rule which product's units to print",
    );
    assert.match(upload, /aria-label="Product whose units are shown"/, "the Upload screen offers the product picker");
    for (const figure of ["salesQty", "returnQty", "netQty", "stockQty"]) {
      assert.match(
        upload,
        new RegExp(`value=\\{scopeUnits\\(unitScope\\?\\.totals\\.${figure}\\)\\}`),
        `the ${figure} tile prints the scope's own figure`,
      );
    }
    assert.match(upload, /rows=\{\(unitScope\?\.byBranch \?\? result\.byBranch\)\.map/, "By branch reads the scope");
    assert.match(upload, /rows=\{\(unitScope\?\.byRegion \?\? result\.byRegion\)\.map/, "By region reads the scope");
  }
}
