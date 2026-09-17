import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import type { WeeklyManagerIndex } from "../src/lib/sales/weekly/manager-attribution.ts";
import { buildNsmDsmWorkbook } from "../src/lib/sales/weekly/nsm-dsm-workbook.ts";
import {
  buildVsTargetModel,
  buildWeeklySummaryWorkbook,
  sparkline,
  type MonthTargetInput,
} from "../src/lib/sales/weekly/summary-workbook.ts";
import type { WeeklyDashboard, WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";
import {
  weeklyHoldsStockWithNoSales,
  weeklyMonthVsTargetUnitsAreOneProduct,
  weeklyProductKeysAreOne,
  weeklyZeroSalesBranches,
  type WeeklyZeroSalesSourceRow,
} from "../src/lib/sales/weekly/unit-totals.ts";

// UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED (owner rule, 2026-08-27) — the follow-ups to the admin
// Weekly Sales change, as the owner decided them on 2026-09-17:
//
//   1. THE WEEKLY SUMMARIZED REPORT. Month vs Target dashes every figure unless one product is in scope,
//      and keeps every row. The MTD and YTD by Distributor manager TOTAL rows and the Low Sales With
//      Stock section TOTAL rows keep their place and hold the sheet's own dash when the table holds
//      more than one product. The Low Sales footnote keeps its count and drops its unit sum. The TREND
//      sparklines draw sales VALUE, and rows (lines, areas, distributor columns) rank by sales VALUE.
//   2. STOCK WITH NO SALES — the admin dashboard's watchlist and the NSM/DSM export's Stock tab. A
//      branch qualifies only when NO product sold, each product checked on its own, and the dashboard
//      ranks the branches by stock VALUE at the Product Master price.
//   3. THE UPLOAD SCREEN. Every unit figure that adds products prints only for one product.
//
// Every workbook claim below is read back from the emitted file's bytes, never off the builder's input.

const JUL = "2026-07-01";
const WEEK_1 = "2026-07-04";
const WEEK_2 = "2026-07-11";

function factRow(overrides: Partial<WeeklyFactExportRow> = {}): WeeklyFactExportRow {
  return {
    distributorCode: "AA",
    distributorName: "Alpha Distribution",
    productCode: "P1",
    productName: "Alpha",
    line: "CNS",
    regionCode: "CA",
    regionName: "Cairo",
    areaCode: "CA1",
    branchCode: "BR1",
    branchName: "Branch One",
    cycleMonth: JUL,
    weekNumber: 1,
    weekStart: WEEK_1,
    batchId: "batch-1",
    family: "Alpha",
    salesValue: 100,
    salesUnits: 10,
    stockUnits: 5,
    ...overrides,
  };
}

function dashboardOf(factRows: WeeklyFactExportRow[]): WeeklyDashboard {
  return {
    weekStart: null, priorWeekStart: null, availableWeeks: [], weekGroupMembers: {},
    availableLines: ["CNS"], availableRegions: [], availableProducts: [], availableMonths: [],
    availableWeekNumbers: [], availableUploads: [], distributors: [],
    appliedFilters: {
      weekStart: null, weekStarts: [], allWeeks: true, distributorCode: null, regionCode: null,
      productCode: null, lineCode: null, productCodes: [], productFilterMode: "include",
      distributorCodes: [], distributorFilterMode: "include", regionCodes: [], regionFilterMode: "include",
      lineCodes: [], lineFilterMode: "include", cycleMonths: [], cycleMonthMode: "include",
      weekNumbers: [], weekNumberMode: "include",
    },
    kpis: { salesValue: 0, salesUnits: 0, stockUnits: 0, branchCount: 0, regionCount: 0, productCount: 0, distributorCount: 0 },
    compare: {
      salesValue: { current: 0, prior: null, pct: null },
      salesUnits: { current: 0, prior: null, pct: null },
      stockUnits: { current: 0, prior: null, pct: null },
    },
    regions: [], products: [], distributorBreakdown: [], branchBreakdown: [],
    zeroSalesBranches: [], weekComparison: [], sources: [], trend: [], factRows,
  } as unknown as WeeklyDashboard;
}

/** A filled District Manager seat on one line in Cairo. */
const DM_SEAT = (seatId: string, lineCode: string, occupantHrId: string) => ({
  seatId,
  seatTier: "DM",
  lineCode,
  regionCode: "CA",
  seatLabel: null,
  occupantHrId,
  isVacant: false,
  parentSeatId: null,
});

const EMPTY_MANAGER_INDEX: WeeklyManagerIndex = {
  ceoName: null,
  dmByLineRegion: new Map(),
  nameByHrId: new Map(),
  operationalRegionByLineArea: new Map(),
  regionNameByCode: new Map(),
  seatsById: new Map(),
};

/**
 * The month the workbook is built from. Distributor Alpha moves FEW units for a lot of money and Beta
 * MANY units for little, so the distributor columns rank differently by value than by units. Both rows
 * sell 0-5 units and hold more than 50, so each lands on Low Sales With Stock; a third holds 10 and is
 * held back below the floor.
 */
function monthRows(secondProduct: { code: string; name: string }): WeeklyFactExportRow[] {
  return [
    factRow({ distributorCode: "AA", distributorName: "Alpha Distribution", weekStart: WEEK_1, salesUnits: 1, salesValue: 9000, stockUnits: 80 }),
    factRow({
      distributorCode: "BB", distributorName: "Beta Distribution", weekStart: WEEK_2, weekNumber: 2,
      productCode: secondProduct.code, productName: secondProduct.name, family: secondProduct.name,
      areaCode: "CA2", branchCode: "BR2", branchName: "Branch Two",
      salesUnits: 4, salesValue: 100, stockUnits: 90,
    }),
    factRow({ branchCode: "BR3", branchName: "Branch Three", weekStart: WEEK_1, salesUnits: 0, salesValue: 0, stockUnits: 10 }),
  ];
}

async function buildSummary(secondProduct: { code: string; name: string }): Promise<ExcelJS.Workbook> {
  return buildSummaryOf(monthRows(secondProduct), [
    { lineLabel: "CNS", areaCode: "CA1", productCode: "P1", targetUnits: 40, targetValue: 400 },
    { lineLabel: "CNS", areaCode: "CA2", productCode: secondProduct.code, targetUnits: 60, targetValue: 600 },
  ]);
}

async function buildSummaryOf(
  rows: WeeklyFactExportRow[],
  targets: MonthTargetInput[],
  managerIndex: WeeklyManagerIndex = EMPTY_MANAGER_INDEX,
): Promise<ExcelJS.Workbook> {
  const buffer = await buildWeeklySummaryWorkbook({
    weekly: dashboardOf(rows),
    mtd: dashboardOf(rows),
    ytd: dashboardOf(rows),
    trend: dashboardOf(rows),
    managerIndex,
    areaSplit: null,
    ytdMonths: [JUL],
    periodLabel: "July 2026",
    generatedAt: "2026-07-12 10:00",
    lineFilter: [],
    masterAreas: [
      { areaCode: "CA1", areaName: "Heliopolis", regionCode: "CA" },
      { areaCode: "CA2", areaName: "Nasr City", regionCode: "CA" },
    ],
    regionNames: [{ regionCode: "CA", regionName: "Cairo" }],
    vsTarget: {
      kind: "shown",
      months: [{ period: "2026-07", monthRows: rows, targets, targetedLines: ["CNS"] }],
      dataNote: "",
    },
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

function sheetOf(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name);
  assert.ok(sheet, `the workbook must carry a "${name}" sheet`);
  return sheet!;
}

const formulaOf = (cell: ExcelJS.Cell): string | null => {
  const value = cell.value as { formula?: string; sharedFormula?: string } | null;
  return value && typeof value === "object" ? (value.formula ?? value.sharedFormula ?? null) : null;
};

const textOf = (cell: ExcelJS.Cell): string => {
  const value = cell.value as unknown;
  if (value == null) return "";
  if (typeof value === "object" && value && "richText" in value) {
    return (value as { richText: { text: string }[] }).richText.map((part) => part.text).join("");
  }
  if (typeof value === "object" && value && "result" in value) return String((value as { result: unknown }).result ?? "");
  return String(value);
};

/** Every row whose first cell reads like `label`, with its filled cells from column 2 on. */
function rowsLabelled(sheet: ExcelJS.Worksheet, label: RegExp): ExcelJS.Cell[][] {
  const out: ExcelJS.Cell[][] = [];
  sheet.eachRow((row) => {
    if (!label.test(textOf(row.getCell(1)))) return;
    const cells: ExcelJS.Cell[] = [];
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      if (column >= 2 && !cell.isMerged) cells.push(cell);
      else if (column >= 2 && cell.isMerged && cell.master.address === cell.address) cells.push(cell);
    });
    out.push(cells);
  });
  return out;
}

function allText(sheet: ExcelJS.Worksheet): string {
  const parts: string[] = [];
  sheet.eachRow((row) => row.eachCell({ includeEmpty: false }, (cell) => parts.push(textOf(cell))));
  return parts.join(" | ");
}

const DASH_FORMULA = '"–"';

export async function runWeeklyUnitsAcrossProductsFollowupsTests() {
  const two = await buildSummary({ code: "P2", name: "Beta" });
  const one = await buildSummary({ code: "P1", name: "Alpha" });

  // ── 1a. MTD and YTD by Distributor: a manager TOTAL adds every product above it ─────────────────
  for (const tab of ["MTD by Distributor", "YTD by Distributor"]) {
    const totals = rowsLabelled(sheetOf(two, tab), /— TOTAL$/);
    assert.ok(totals.length > 0, `${tab}: the manager TOTAL row must still be on the sheet — the rows stay`);
    for (const cells of totals) {
      assert.ok(cells.length >= 4, `${tab}: the TOTAL row keeps every one of its cells; got ${cells.length}`);
      for (const cell of cells) {
        assert.equal(
          formulaOf(cell),
          DASH_FORMULA,
          `${tab} ${cell.address}: two products' units are never added, so the TOTAL cell holds the sheet's ` +
            `dash formula; got ${JSON.stringify(cell.value)}`,
        );
      }
    }

    // Positive control: one product's TOTAL still adds, as a live SUM.
    const oneTotals = rowsLabelled(sheetOf(one, tab), /— TOTAL$/);
    assert.ok(oneTotals.length > 0, `${tab}: one product still gets its TOTAL row`);
    for (const cells of oneTotals) {
      for (const cell of cells) {
        assert.match(
          formulaOf(cell) ?? "",
          /^SUM\(/,
          `${tab} ${cell.address}: ONE product's units add, so its TOTAL is a live SUM; got ${JSON.stringify(cell.value)}`,
        );
      }
    }
  }

  // ── 1b. MTD by Distributor: the distributor columns rank by sales VALUE ─────────────────────────
  {
    const sheet = sheetOf(two, "MTD by Distributor");
    let alphaColumn = 0;
    let betaColumn = 0;
    sheet.eachRow((row) =>
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        const text = textOf(cell);
        if (!alphaColumn && text === "Alpha Distribution") alphaColumn = column;
        if (!betaColumn && text === "Beta Distribution") betaColumn = column;
      }),
    );
    assert.ok(alphaColumn > 0 && betaColumn > 0, "both distributors head a column");
    assert.ok(
      alphaColumn < betaColumn,
      "Alpha moved 1 unit for 9,000 and Beta 4 units for 100 — ranked by VALUE, Alpha comes first " +
        `(Alpha column ${alphaColumn}, Beta column ${betaColumn})`,
    );
  }

  // ── 1c. Low Sales With Stock: the section TOTAL, and the footnote's unit sum ────────────────────
  {
    const sheet = sheetOf(two, "Low Sales With Stock");
    const totals = rowsLabelled(sheet, /branch(es)? · \d+ products? sitting$/);
    assert.equal(totals.length, 1, "the manager's section closes with its TOTAL row");
    const unitCells = totals[0].filter((cell) => Number(cell.col) >= 5);
    assert.equal(unitCells.length, 2, "units sold and stock on hand both keep their TOTAL cell");
    for (const cell of unitCells) {
      assert.equal(
        formulaOf(cell),
        DASH_FORMULA,
        `Low Sales ${cell.address}: the section is two products, so its TOTAL is a dash; got ${JSON.stringify(cell.value)}`,
      );
    }
    const text = allText(sheet);
    assert.match(text, /A further 1 met the rule/, "the footnote still counts the rows held back below the floor");
    assert.ok(
      !/units in total/.test(text),
      "the footnote must not add the held-back rows' units — they are different products",
    );

    const oneTotals = rowsLabelled(sheetOf(one, "Low Sales With Stock"), /branch(es)? · \d+ products? sitting$/);
    assert.equal(oneTotals.length, 1, "one product still gets its section TOTAL");
    for (const cell of oneTotals[0].filter((c) => Number(c.col) >= 5)) {
      assert.match(formulaOf(cell) ?? "", /^SUM\(/, `Low Sales ${cell.address}: one product's TOTAL is a live SUM`);
    }
  }

  // ── 1d. Month vs Target: every figure a dash, every row kept ────────────────────────────────────
  {
    const sheet = sheetOf(two, "Month vs Target");
    const text = allText(sheet);
    assert.ok(!/% of the month's target/.test(text), "the masthead must not print an achievement for two products");
    assert.match(text, /Figures shown for one product at a time/, "the masthead says why");
    assert.ok(!/units sold against/.test(text), "the footnote must not add the products' units into a total");

    const areaRows = rowsLabelled(sheet, /^\s*(Heliopolis|Nasr City|Cairo|CNS — TOTAL)$/);
    assert.equal(areaRows.length, 4, "the region, both areas and the line TOTAL all keep their row");
    for (const cells of areaRows) {
      const figures = cells.filter((cell) => Number(cell.col) >= 2 && Number(cell.col) <= 5);
      assert.equal(figures.length, 4, "sales, target, achievement and gap each keep their cell");
      for (const cell of figures) {
        assert.equal(
          textOf(cell),
          "–",
          `Month vs Target ${cell.address}: two products' units are never added or divided — a dash; got ${JSON.stringify(cell.value)}`,
        );
      }
    }

    const oneSheet = sheetOf(one, "Month vs Target");
    assert.match(allText(oneSheet), /% of the month's target/, "one product still prints its achievement");
    const oneTotal = rowsLabelled(oneSheet, /^CNS — TOTAL$/)[0];
    assert.equal(oneTotal.find((cell) => Number(cell.col) === 2)?.value, 5, "one product's sales: 1 + 4 + 0 units");
    assert.equal(oneTotal.find((cell) => Number(cell.col) === 3)?.value, 100, "one product's target: 40 + 60 units");
  }

  // The tab reads the TARGETS as well as the sales: one product sold against two products' targets is
  // still two products' units.
  assert.equal(
    weeklyMonthVsTargetUnitsAreOneProduct([{ monthRows: [{ productCode: "P1", productName: "Alpha" }], targets: [{ productCode: "P1" }] }]),
    true,
  );
  assert.equal(
    weeklyMonthVsTargetUnitsAreOneProduct([
      { monthRows: [{ productCode: "P1", productName: "Alpha" }], targets: [{ productCode: "P1" }, { productCode: "P2" }] },
    ]),
    false,
    "a target over a second product makes the tab two products, whatever sold",
  );
  assert.equal(weeklyProductKeysAreOne(["p1", " P1 "]), true, "keys compare trimmed and case-blind");
  assert.equal(weeklyProductKeysAreOne([]), false, "no rows is not one product");

  // ── 1e. The TREND sparklines draw sales VALUE ───────────────────────────────────────────────────
  {
    // One branch, one area, one region, one product, so every trend on every tab draws the same series:
    // week 1 carries 9,000 of value and 1 unit, week 2 carries 100 of value and 4 units.
    const trend = await buildSummaryOf(
      [
        factRow({ weekStart: WEEK_1, salesUnits: 1, salesValue: 9000 }),
        factRow({ weekStart: WEEK_2, weekNumber: 2, salesUnits: 4, salesValue: 100 }),
      ],
      [{ lineLabel: "CNS", areaCode: "CA1", productCode: "P1", targetUnits: 40, targetValue: 400 }],
    );
    const byValue = sparkline([9000, 100]);
    const byUnits = sparkline([1, 4]);
    assert.notEqual(byValue, byUnits, "the fixture must draw a different shape by value than by units");
    for (const tab of ["Weekly by Branch", "Weekly by Manager", "Manager by Branch"]) {
      const text = allText(sheetOf(trend, tab));
      assert.ok(text.includes(byValue), `${tab}: the trend draws sales value (${byValue}); got ${text.slice(0, 400)}`);
      assert.ok(!text.includes(byUnits), `${tab}: the trend must not draw units (${byUnits})`);
    }
  }

  // ── 1g. Lines and branches rank by sales VALUE on Weekly by Branch and Manager by Branch ────────
  {
    // CNS moves 41 units for 9,100; Pedia 2 units for 20,000. Inside CNS the Money Branch sells 1 unit
    // for 9,000 and the Volume Branch 40 units for 100.
    const ranked = await buildSummaryOf(
      [
        factRow({ branchCode: "VOL", branchName: "Volume Branch", salesUnits: 40, salesValue: 100 }),
        factRow({ branchCode: "MON", branchName: "Money Branch", salesUnits: 1, salesValue: 9000 }),
        factRow({
          line: "Pedia", productCode: "P5", productName: "Pedia Product", family: "Pedia Product",
          branchCode: "PED", branchName: "Pedia Branch", salesUnits: 2, salesValue: 20_000,
        }),
      ],
      [{ lineLabel: "CNS", areaCode: "CA1", productCode: "P1", targetUnits: 40, targetValue: 400 }],
      {
        ...EMPTY_MANAGER_INDEX,
        dmByLineRegion: new Map([
          ["cns||CA", DM_SEAT("seat-cns", "cns", "HR-C")],
          ["pedia||CA", DM_SEAT("seat-pedia", "pedia", "HR-P")],
        ]),
        // Alphabetically the CNS manager comes first, so only the value ranking puts Pedia ahead.
        nameByHrId: new Map([["HR-C", "Adel CNS"], ["HR-P", "Bassem Pedia"]]),
      },
    );
    const firstRowOf = (sheet: ExcelJS.Worksheet, label: string) => {
      let found = 0;
      sheet.eachRow((row, number) => {
        if (!found && textOf(row.getCell(1)).trim() === label) found = number;
      });
      assert.ok(found > 0, `${sheet.name}: no row is labelled "${label}"`);
      return found;
    };
    const firstRowMentioning = (sheet: ExcelJS.Worksheet, text: string) => {
      let found = 0;
      sheet.eachRow((row, number) =>
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (!found && textOf(cell).includes(text)) found = number;
        }),
      );
      assert.ok(found > 0, `${sheet.name}: nothing mentions "${text}"`);
      return found;
    };
    const byManager = sheetOf(ranked, "Weekly by Manager");
    assert.ok(
      firstRowMentioning(byManager, "Bassem Pedia") < firstRowMentioning(byManager, "Adel CNS"),
      "Weekly by Manager: the Pedia manager's line sold 20,000 and the CNS manager's 9,100 — Pedia first by value",
    );
    const byBranch = sheetOf(ranked, "Weekly by Branch");
    assert.ok(
      firstRowOf(byBranch, "Pedia") < firstRowOf(byBranch, "CNS"),
      "Weekly by Branch: Pedia sold 20,000 and CNS 9,100 — the Pedia table comes first by value",
    );
    const managerByBranch = sheetOf(ranked, "Manager by Branch");
    const pedia = firstRowOf(managerByBranch, "Pedia Branch");
    const money = firstRowOf(managerByBranch, "Money Branch");
    const volume = firstRowOf(managerByBranch, "Volume Branch");
    assert.ok(
      pedia < money && money < volume,
      `Manager by Branch ranks by value — Pedia Branch (20,000), Money Branch (9,000), Volume Branch (100); ` +
        `got rows ${pedia}, ${money}, ${volume}`,
    );
  }

  // ── 1f. Month vs Target rows rank by sales VALUE ────────────────────────────────────────────────
  {
    const areaIndex = new Map([
      ["CA1", { areaName: "Heliopolis", regionCode: "CA" }],
      ["CA2", { areaName: "Nasr City", regionCode: "CA" }],
    ]);
    const regionNames = new Map([["CA", "Cairo"]]);
    const sections = buildVsTargetModel(
      [
        factRow({ areaCode: "CA1", salesUnits: 50, salesValue: 100 }),
        factRow({ areaCode: "CA2", salesUnits: 10, salesValue: 5000 }),
        factRow({ line: "Pedia", areaCode: "CA1", salesUnits: 5, salesValue: 99_999 }),
      ],
      [
        { lineLabel: "CNS", areaCode: "CA1", productCode: "P1", targetUnits: 60, targetValue: 600 },
        { lineLabel: "Pedia", areaCode: "CA1", productCode: "P1", targetUnits: 6, targetValue: 60 },
      ],
      areaIndex,
      ["CNS", "Pedia"],
      regionNames,
    );
    assert.deepEqual(
      sections.map((section) => section.label),
      ["Pedia", "CNS"],
      "two measured lines rank by sales value: Pedia sold 5 units for 99,999 and CNS 60 for 5,100",
    );
    const cns = sections.find((section) => section.label === "CNS")!;
    assert.deepEqual(
      cns.regions[0].areas.map((area) => area.label),
      ["Nasr City", "Heliopolis"],
      "Nasr City sold 10 units for 5,000 and Heliopolis 50 for 100 — by value, Nasr City leads",
    );

    const unsold = buildVsTargetModel(
      [],
      [
        { lineLabel: "CNS", areaCode: "CA1", productCode: "P1", targetUnits: 90, targetValue: 10 },
        { lineLabel: "CNS", areaCode: "CA2", productCode: "P1", targetUnits: 5, targetValue: 500 },
      ],
      areaIndex,
      ["CNS"],
      regionNames,
    );
    assert.deepEqual(
      unsold[0].regions[0].areas.map((area) => area.label),
      ["Nasr City", "Heliopolis"],
      "areas that sold nothing rank by target VALUE, never by target units",
    );
  }

  // ── 2a. Stock with no sales: each product on its own ────────────────────────────────────────────
  assert.equal(
    weeklyHoldsStockWithNoSales([{ netUnits: 5, stockUnits: 0 }, { netUnits: -5, stockUnits: 40 }]),
    false,
    "one product sold 5 and another returned 5 — the branch IS selling; added, the two cancel to zero",
  );
  assert.equal(weeklyHoldsStockWithNoSales([{ netUnits: -3, stockUnits: 12 }]), true, "returns alone are not a sale");
  assert.equal(weeklyHoldsStockWithNoSales([{ netUnits: 0, stockUnits: 0 }]), false, "no stock, nothing to chase");
  assert.equal(weeklyHoldsStockWithNoSales([{ netUnits: 0.4, stockUnits: 3 }]), true, "under half a unit has not sold");

  // ── 2b. The admin dashboard's watchlist: per product, ranked by stock VALUE ─────────────────────
  {
    const source = (overrides: Partial<WeeklyZeroSalesSourceRow>): WeeklyZeroSalesSourceRow => ({
      branchCode: "BR1",
      branchName: "Branch One",
      regionName: "Cairo",
      productCode: "P1",
      productName: "Alpha",
      salesValue: 0,
      netQty: 0,
      stockQty: 0,
      ...overrides,
    });
    const prices = new Map([["P1", 100], ["P2", 1]]);
    const list = weeklyZeroSalesBranches(
      [
        // Selling: P1 sold 5, P2 returned 5 and holds 40.
        source({ branchCode: "SELL", branchName: "Selling", productCode: "P1", netQty: 5, salesValue: 500 }),
        source({ branchCode: "SELL", branchName: "Selling", productCode: "P2", netQty: -5, stockQty: 40 }),
        // 10 units of P1 at 100 = 1,000 of stock value.
        source({ branchCode: "SMALL", branchName: "Few costly packs", productCode: "P1", stockQty: 10 }),
        // 300 units of P2 at 1 = 300 of stock value: more units, less money.
        source({ branchCode: "BIG", branchName: "Many cheap packs", productCode: "P2", stockQty: 300 }),
        // Returns only, 5 of P1 left = 500.
        source({ branchCode: "RET", branchName: "Returns only", productCode: "P1", netQty: -3, stockQty: 5 }),
        // Empty, and branchless.
        source({ branchCode: "EMPTY", branchName: "Empty" }),
        source({ branchCode: "", branchName: "", productCode: "P1", stockQty: 999 }),
        // A product with no Product Master price adds no value but still holds stock.
        source({ branchCode: "NOPRICE", branchName: "Unpriced", productCode: "P9", stockQty: 70 }),
      ],
      (productCode) => prices.get(productCode),
    );
    assert.deepEqual(
      list.map((branch) => branch.branchName),
      ["Few costly packs", "Returns only", "Many cheap packs", "Unpriced"],
      "the selling branch is gone, returns-only qualifies, and the list ranks by stock value (1,000 > 500 > 300 > 0)",
    );
    const selling = list.find((branch) => branch.branchCode === "SELL");
    assert.equal(selling, undefined, "a branch where one product's returns cancel another's sales is not on the list");
  }

  // ── 2c. The NSM/DSM export's "Stock with no sales" tab: per product ─────────────────────────────
  {
    const nsmRow = (overrides: Partial<WeeklyFactExportRow>) =>
      factRow({ distributorCode: "IS", distributorName: "Ibn Sina-Sato", areaCode: "CA1", ...overrides });
    const buffer = await buildNsmDsmWorkbook({
      areaNames: new Map([["CA1", "Heliopolis"]]),
      areaSplit: null,
      generatedAt: "2026-07-12T09:00:00.000Z",
      lineFilter: ["CNS"],
      managerIndex: EMPTY_MANAGER_INDEX,
      periodLabel: "July 2026",
      productAxis: ["P1", "P2"],
      regionFilter: [],
      regionNames: new Map([["CA", "Cairo"]]),
      rows: [
        nsmRow({ branchCode: "SELL", branchName: "Selling Depot", productCode: "P1", salesUnits: 5, salesValue: 500, stockUnits: 0 }),
        nsmRow({ branchCode: "SELL", branchName: "Selling Depot", productCode: "P2", productName: "Beta", salesUnits: -5, salesValue: -5, stockUnits: 40 }),
        nsmRow({ branchCode: "IDLE", branchName: "Idle Depot", productCode: "P1", salesUnits: 0, salesValue: 0, stockUnits: 30 }),
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const text = allText(sheetOf(workbook, "Stock")); // titled "Stock with no sales"
    assert.ok(text.includes("Idle Depot"), "a depot that sold nothing and holds stock is on the tab");
    assert.ok(
      !text.includes("Selling Depot"),
      "a depot that sold 5 of one product is selling, however many of another it took back",
    );
  }

  // ── 2d. The wiring: the dashboard's watchlist is the shared rule, not an inline sum ─────────────
  {
    const service = readFileSync(fileURLToPath(new URL("../src/lib/sales/weekly/service.ts", import.meta.url)), "utf8");
    assert.match(
      service,
      /const zeroSalesBranches = weeklyZeroSalesBranches\(weekRowsAdj, /,
      "loadWeeklyDashboard must build its Stock on hand watchlist with weeklyZeroSalesBranches",
    );
    assert.ok(!/branch\.salesUnits === 0 && branch\.stockUnits > 0/.test(service), "the old all-products sum is gone");
  }

  // ── 3. The Upload screen: unit figures that add products print only for one ─────────────────────
  {
    const upload = readFileSync(
      fileURLToPath(new URL("../src/components/sales/weekly/weekly-upload-workspace.tsx", import.meta.url)),
      "utf8",
    );
    for (const unguarded of [
      "num(batch.totalNetQty)",
      "num(batch.totalStockQty)",
      "num(t.salesQty)",
      "num(t.returnQty)",
      "num(t.stockQty)",
      "num(tw.netQty)",
      "num(tw.stockQty)",
      "num(b.netQty)",
      "num(b.stockQty)",
      "num(r.netQty)",
      "num(r.stockQty)",
      "num(branch.netQty)",
      "num(branch.stockQty)",
    ]) {
      const at = upload.indexOf(unguarded);
      if (at < 0) continue;
      // Allowed only inside a one-product guard on the same line or the line before.
      const context = upload.slice(Math.max(0, upload.lastIndexOf("\n", upload.lastIndexOf("\n", at) - 1)), at);
      assert.match(
        context,
        /unitsAreOneProduct|weeklyProductKeysAreOne|sumIsOneItem/,
        `the Upload screen prints ${unguarded} outside a one-product guard`,
      );
    }
    assert.match(
      upload,
      /const unitsAreOneProduct = weeklyProductKeysAreOne\(result\.byProduct\.map/,
      "the upload's own panel asks the shared rule whether it holds one product",
    );
  }
}
