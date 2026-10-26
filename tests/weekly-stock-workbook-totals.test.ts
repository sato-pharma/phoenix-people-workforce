import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  buildWeeklyStockView,
  type WeeklyStockSourceRow,
  type WeeklyStockView,
} from "../src/lib/sales/weekly/stock-dashboard.ts";
import { buildWeeklyStockWorkbook } from "../src/lib/sales/weekly/stock-workbook.ts";

// 🔴 THE WEEKLY STOCK EXPORT COUNTED ITS MONEY TWICE — found 2026-09-16.
//
// Every table tab pushed a hand-written "Total (value)" row into its DATA rows, and addPhoenixTableSheet then
// appended its own TOTAL row, whose SUM() ran over every data row, the hand-written one included. Stock value
// and average weekly sales came out doubled, weeks of cover was summed across groups, and Stock Units and Avg
// Weekly Units were added across different products. Two owner rules broke at once: units of different
// products are never added, and an export must match the screen.
//
// Judged on the EMITTED file (written, then read back), never on the rows handed to the builder.

const HEADER_ROW = 3;
const FIRST_DATA_ROW = 4;

function row(partial: Partial<WeeklyStockSourceRow>): WeeklyStockSourceRow {
  return {
    distributorCode: "PS",
    distributorName: "Overseas",
    regionCode: "CA",
    regionName: "Cairo",
    areaCode: "CA1",
    branchCode: "B1",
    branchName: "Nasr City",
    productCode: "CO001",
    productName: "Conviban 50 mg",
    line: "CNS",
    cycleMonth: "2026-09-01",
    weekNumber: 1,
    weekStart: "2026-09-06",
    netUnits: 0,
    stockUnits: 0,
    factoryPrice: 30,
    ...partial,
  };
}

// One upload week per distributor, so average weekly units are that week's own net units and every figure is
// a whole number: the sums below compare exactly, with no rounding to argue about.
const TEBOFORTIN = { productCode: "TB080", productName: "Tebofortin 80 mg", factoryPrice: 45 };
const AMOXI = { productCode: "AM500", productName: "Amoxi 500 mg", line: "Anti Infective", factoryPrice: 12 };
const MAADI = { areaCode: "CA2", branchCode: "B2", branchName: "Maadi" };
const IBN_SINA = { distributorCode: "IS", distributorName: "Ibn Sina", regionCode: "DL", regionName: "Delta" };
const TANTA = { ...IBN_SINA, areaCode: "D11", branchCode: "T1", branchName: "Tanta" };

const SOURCE_ROWS: WeeklyStockSourceRow[] = [
  row({ stockUnits: 10, netUnits: 10 }), // Nasr City · Conviban: 1 week of cover, Low stock
  row({ ...TEBOFORTIN, stockUnits: 40, netUnits: 10 }), // Nasr City · Tebofortin: 4 weeks, Healthy
  row({ ...MAADI, stockUnits: 100, netUnits: 10 }), // Maadi · Conviban: 10 weeks, Overstock
  row({ ...MAADI, ...TEBOFORTIN, stockUnits: 20, netUnits: 0 }), // Maadi · Tebofortin: No sales
  row({ ...TANTA, stockUnits: 5, netUnits: 10 }), // Tanta · Conviban: Low stock
  row({ ...TANTA, ...TEBOFORTIN, stockUnits: 0, netUnits: 10 }), // Tanta · Tebofortin: sold out, Out of stock
  row({ ...TANTA, ...AMOXI, stockUnits: 60, netUnits: 5 }), // Tanta · Amoxi: 12 weeks, Overstock
  row({ ...IBN_SINA, ...TEBOFORTIN, areaCode: null, branchCode: "K1", branchName: "Key Accounts", stockUnits: 30, netUnits: 10 }), // Area not mapped: Healthy
];

const AREA_NAMES = new Map([
  ["CA1", "Nasr City 1"],
  ["CA2", "Maadi 1"],
  ["D11", "Tanta 1"],
]);

const GROUP_SUMMED = ["Stock Value (EGP)", "Avg Weekly Sales (EGP)", "Out of Stock", "Low Stock", "Overstock", "No Sales"];
const GROUP_NEVER_SUMMED = ["Weeks of Cover", "Products"];

// Every table tab, the rows it carries, the only columns its TOTAL row may SUM (in column order), and the
// columns whose sum means nothing: units of different products, a ratio, and counts of a product or a depot
// that recurs across rows.
function tableTabs(view: WeeklyStockView) {
  return [
    {
      name: "Stock by Branch",
      dataRows: view.cells.length,
      summed: ["Stock Value (EGP)"],
      neverSummed: ["Stock Units", "Avg Weekly Units", "Weeks of Cover"],
    },
    {
      name: "By Product",
      dataRows: view.products.length,
      summed: ["Stock Value (EGP)", "Out of Stock", "Low Stock", "Overstock", "No Sales"],
      neverSummed: ["Stock Units", "Avg Weekly Units", "Weeks of Cover", "Branches"],
    },
    { name: "By Branch", dataRows: view.depots.length, summed: GROUP_SUMMED, neverSummed: GROUP_NEVER_SUMMED },
    { name: "By Area", dataRows: view.areas.length, summed: GROUP_SUMMED, neverSummed: GROUP_NEVER_SUMMED },
    { name: "By Region", dataRows: view.regions.length, summed: GROUP_SUMMED, neverSummed: GROUP_NEVER_SUMMED },
    { name: "By Distributor", dataRows: view.distributors.length, summed: GROUP_SUMMED, neverSummed: GROUP_NEVER_SUMMED },
  ];
}

function headerColumns(sheet: ExcelJS.Worksheet): Map<string, number> {
  const columns = new Map<string, number>();
  sheet.getRow(HEADER_ROW).eachCell((cell, col) => {
    if (typeof cell.value === "string") columns.set(cell.value, col);
  });
  return columns;
}

/** Every row below the header carrying a total label: addPhoenixTableSheet's "TOTAL", or a hand-written "Total (value)". */
function totalRowNumbers(sheet: ExcelJS.Worksheet): number[] {
  const rows: number[] = [];
  for (let r = FIRST_DATA_ROW; r <= sheet.rowCount; r += 1) {
    let isTotal = false;
    sheet.getRow(r).eachCell((cell) => {
      if (typeof cell.value === "string" && /^total\b/i.test(cell.value.trim())) isTotal = true;
    });
    if (isTotal) rows.push(r);
  }
  return rows;
}

export async function runWeeklyStockWorkbookTotalsTests() {
  const view = buildWeeklyStockView(SOURCE_ROWS, AREA_NAMES);

  // Positive controls: the fixture really spans several products, depots, areas, regions and distributors and
  // every status, so neither check below can pass on a workbook too thin to break it.
  assert.equal(view.cells.length, 8, "eight product-at-depot rows");
  assert.equal(view.products.length, 3, "three different products, so a unit total would add different products");
  assert.deepEqual(
    [view.depots.length, view.areas.length, view.regions.length, view.distributors.length],
    [4, 4, 2, 2],
    "four depots, four areas (one not mapped), two regions, two distributors",
  );
  const screen: Record<string, number> = {
    "Stock Value (EGP)": view.kpis.stockValue,
    "Avg Weekly Sales (EGP)": view.kpis.avgWeeklyValue,
    "Out of Stock": view.kpis.outOfStockCount,
    "Low Stock": view.kpis.lowCount,
    Overstock: view.kpis.overCount,
    "No Sales": view.kpis.noSalesCount,
  };
  // The type argument keeps `screen` indexable by any label below: without it, the assertion narrows it to
  // exactly these six keys and `screen[label]` stops typechecking.
  assert.deepEqual<Record<string, number>>(
    screen,
    { "Stock Value (EGP)": 8220, "Avg Weekly Sales (EGP)": 2310, "Out of Stock": 1, "Low Stock": 2, Overstock: 2, "No Sales": 1 },
    "the screen's tiles for this scope",
  );

  const built = buildWeeklyStockWorkbook(view, { scopeSummary: "All regions", generatedAtCairo: "16 Sep 2026, 13:00" });
  const emitted = new ExcelJS.Workbook();
  await emitted.xlsx.load(await built.xlsx.writeBuffer());

  const tabs = tableTabs(view);
  assert.deepEqual(
    emitted.worksheets.map((sheet) => sheet.name),
    [...tabs.map((tab) => tab.name), "Notes"],
    "the six table tabs, then Notes: a tab missing from the file cannot pass the checks below by being absent",
  );

  for (const tab of tabs) {
    const sheet = emitted.getWorksheet(tab.name);
    assert.ok(sheet, `${tab.name}: the tab is in the file`);
    const columnOf = headerColumns(sheet);

    // ── exactly ONE total row: addPhoenixTableSheet's own, directly under the data
    const totalRows = totalRowNumbers(sheet);
    assert.equal(
      totalRows.length,
      1,
      `${tab.name}: exactly one TOTAL row, found ${totalRows.length} (rows ${totalRows.join(", ")}). A hand-written ` +
        "total inside the data rows is summed again by the TOTAL row's SUM and counts the money twice",
    );
    const totalRowNumber = totalRows[0];
    assert.equal(totalRowNumber, FIRST_DATA_ROW + tab.dataRows, `${tab.name}: the TOTAL row sits directly under its ${tab.dataRows} data rows`);
    const totalRow = sheet.getRow(totalRowNumber);
    assert.equal(totalRow.getCell(1).value, "TOTAL", `${tab.name}: the one total is addPhoenixTableSheet's TOTAL row`);

    // ── nothing under a column whose sum means nothing
    for (const label of tab.neverSummed) {
      const col = columnOf.get(label);
      assert.ok(col, `${tab.name}: the "${label}" column is in the file`);
      const cell = totalRow.getCell(col);
      assert.equal(
        cell.formula,
        undefined,
        `${tab.name}: no formula under "${label}" in the TOTAL row. Units of different products are never added, ` +
          "and weeks of cover and counts of a recurring product or depot do not add either",
      );
      assert.ok(cell.value === null || cell.value === "", `${tab.name}: the TOTAL row leaves "${label}" empty, found ${JSON.stringify(cell.value)}`);
      // Only the SUM went, never the look: the column still reads as numbers.
      assert.equal(sheet.getRow(HEADER_ROW).getCell(col).alignment?.horizontal, "right", `${tab.name}: the "${label}" header stays right-aligned`);
      assert.equal(sheet.getRow(FIRST_DATA_ROW).getCell(col).alignment?.horizontal, "right", `${tab.name}: "${label}" values stay right-aligned`);
    }

    // ── the SUMs that remain: exactly the allowed columns, each over the data rows only, each equal to the screen
    const formulaColumns = [...columnOf.entries()]
      .filter(([, col]) => totalRow.getCell(col).formula !== undefined)
      .map(([label]) => label);
    assert.deepEqual(formulaColumns, tab.summed, `${tab.name}: the TOTAL row sums exactly these columns`);
    for (const label of tab.summed) {
      const col = columnOf.get(label);
      assert.ok(col, `${tab.name}: the "${label}" column is in the file`);
      // Annotated on purpose: the assertion below takes `letter` inside this loop, and without the annotation
      // TypeScript reads that assertion while still inferring `letter` and gives up (TS7022).
      const letter: string = sheet.getColumn(col).letter;
      assert.equal(
        totalRow.getCell(col).formula,
        `SUM(${letter}${FIRST_DATA_ROW}:${letter}${totalRowNumber - 1})`,
        `${tab.name}: the "${label}" TOTAL is a plain SUM over its own column's data rows and nothing else`,
      );
      let sum = 0;
      for (let r = FIRST_DATA_ROW; r < totalRowNumber; r += 1) {
        const value = sheet.getRow(r).getCell(col).value;
        if (typeof value === "number") sum += value;
      }
      assert.equal(
        Number(sum.toFixed(2)),
        screen[label],
        `${tab.name}: the "${label}" TOTAL evaluates to ${Number(sum.toFixed(2))}; the screen shows ${screen[label]}`,
      );
    }
  }

  const notes = emitted.getWorksheet("Notes");
  assert.ok(notes, "the Notes tab is in the file");
  assert.deepEqual(totalRowNumbers(notes), [], "Notes is text only: no numeric column, so no TOTAL row");
}
