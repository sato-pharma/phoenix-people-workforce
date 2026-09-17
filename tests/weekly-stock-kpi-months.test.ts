import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { latestStockOnly } from "../src/lib/sales/weekly/latest-stock.ts";
import type { StockSnapshotRow } from "../src/lib/sales/weekly/latest-stock.ts";
import { latestCycleMonthStockOnly } from "../src/lib/sales/weekly/summary-workbook.ts";
import type { WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

// 🔴 A SCOPE SPANNING MONTHS ADDED ONE MONTH-END STOCK SNAPSHOT PER MONTH — found 2026-09-17.
//
// Before the weekly engine sums stock — the Stock Units tiles, the compare delta, the rankings' stock
// columns, the zero-sales branches, and the factRows the BI and NSM/DSM books total — it keeps stock on
// one week and zeroes the rest, because stock is a snapshot, not a flow. It kept that week per
// (distributor, cycle month): right for one month, wrong for any scope spanning months (a multi-month or
// exclude month filter, a week-number filter, the all-weeks default), which added a month-end per month.
// On production Ibn Sina-Sato's August + September read 23,936 stock units when 11,071 were on hand, and
// Ivyronc there 8,638 instead of 4,097. The owner chose each distributor's LATEST week in scope (latest
// cycle month, then that month's latest week) for screens and exports alike, and one-month views stay
// exactly as they were.

const AUG = "2026-08-01";
const SEP = "2026-09-01";

type Row = StockSnapshotRow & { productCode: string; weekNumber: number | null; salesValue: number; netQty: number };

function row(overrides: Partial<Row>): Row {
  return {
    distributorCode: "SATO",
    productCode: "IVY",
    cycleMonth: SEP,
    weekNumber: 2,
    weekStart: "2026-09-12",
    salesValue: 1000,
    netQty: 10,
    stockQty: 0,
    ...overrides,
  };
}

const stockOf = (rows: readonly Row[], pick: (row: Row) => boolean = () => true) =>
  rows.filter(pick).reduce((sum, r) => sum + r.stockQty, 0);

// Shaped on the production case: two products, one mid-August sheet, the August month-end, and September.
const SATO: Row[] = [
  row({ productCode: "IVY", cycleMonth: AUG, weekNumber: 2, weekStart: "2026-08-15", stockQty: 5210, salesValue: 2000, netQty: 20 }),
  row({ productCode: "ROYA", cycleMonth: AUG, weekNumber: 2, weekStart: "2026-08-15", stockQty: 9050, salesValue: 1500, netQty: 15 }),
  row({ productCode: "IVY", cycleMonth: AUG, weekNumber: 4, weekStart: "2026-08-29", stockQty: 4541, salesValue: 2200, netQty: 22 }),
  row({ productCode: "ROYA", cycleMonth: AUG, weekNumber: 4, weekStart: "2026-08-29", stockQty: 8324, salesValue: 1700, netQty: 17 }),
  row({ productCode: "IVY", cycleMonth: SEP, weekNumber: 2, weekStart: "2026-09-12", stockQty: 4097, salesValue: 2100, netQty: 21 }),
  row({ productCode: "ROYA", cycleMonth: SEP, weekNumber: 2, weekStart: "2026-09-12", stockQty: 6974, salesValue: 1600, netQty: 16 }),
];

// A second distributor whose latest upload is a month behind.
const BEHIND: Row[] = [
  row({ distributorCode: "BEHIND", cycleMonth: AUG, weekNumber: 2, weekStart: "2026-08-15", stockQty: 300 }),
  row({ distributorCode: "BEHIND", cycleMonth: AUG, weekNumber: 3, weekStart: "2026-08-22", stockQty: 250 }),
];

// The rule before 2026-09-17, kept here ONLY to prove that a one-month scope reads what it read before.
function perMonthRule(rows: readonly Row[]): Row[] {
  const latest = new Map<string, string>();
  for (const r of rows) {
    if (!r.cycleMonth) continue;
    const key = `${r.distributorCode}||${r.cycleMonth}`;
    const current = latest.get(key);
    if (!current || r.weekStart > current) latest.set(key, r.weekStart);
  }
  return rows.map((r) =>
    !r.cycleMonth || r.weekStart === latest.get(`${r.distributorCode}||${r.cycleMonth}`) ? r : { ...r, stockQty: 0 },
  );
}

function exportRow(r: Row): WeeklyFactExportRow {
  return {
    distributorCode: r.distributorCode,
    distributorName: r.distributorCode,
    productCode: r.productCode,
    productName: r.productCode,
    line: "Anti Infective",
    regionCode: "CA",
    regionName: "Cairo",
    areaCode: "CA1",
    branchCode: "BR1",
    branchName: "Branch One",
    cycleMonth: r.cycleMonth,
    weekNumber: r.weekNumber,
    weekStart: r.weekStart,
    batchId: `${r.distributorCode}-${r.weekStart}`,
    family: r.productCode,
    salesValue: r.salesValue,
    salesUnits: r.netQty,
    stockUnits: r.stockQty,
  };
}

export function runWeeklyStockKpiMonthsTests() {
  // 1) THE HEADLINE — two months in scope read the stock on hand at the latest week, not two month-ends.
  {
    assert.equal(stockOf(perMonthRule(SATO)), 23936, "fixture: the rule before the fix added both month-ends");
    const kept = latestStockOnly(SATO);
    assert.equal(
      stockOf(kept),
      11071,
      "August + September must read the stock on hand at the distributor's latest week (12 September), not 12,865 + 11,071 = 23,936",
    );
    assert.equal(
      stockOf(kept, (r) => r.productCode === "IVY"),
      4097,
      "one product over both months reads its latest week (4,097), not 4,541 + 4,097 — the portal's one-product Stock Units tile",
    );
  }

  // 2) A one-month scope cannot move: the distributor's latest week IS that month's latest week.
  {
    for (const month of [AUG, SEP]) {
      const scope = [...SATO, ...BEHIND].filter((r) => r.cycleMonth === month);
      assert.deepEqual(latestStockOnly(scope), perMonthRule(scope), `${month} alone must read exactly what it read before the fix`);
    }
    assert.equal(stockOf(latestStockOnly(SATO.filter((r) => r.cycleMonth === AUG))), 12865, "August alone is its month-end, 29 August");
    assert.equal(stockOf(latestStockOnly(SATO.filter((r) => r.cycleMonth === SEP))), 11071, "September alone is 12 September");
  }

  // 3) The other ways a scope spans months: excluding a month, and a week-number filter.
  {
    assert.equal(
      stockOf(latestStockOnly(SATO.filter((r) => r.cycleMonth !== SEP))),
      12865,
      "every month except September reads August's latest week",
    );
    const week4 = [
      ...SATO.filter((r) => r.weekNumber === 4),
      row({ productCode: "IVY", cycleMonth: SEP, weekNumber: 4, weekStart: "2026-09-26", stockQty: 3900 }),
    ];
    assert.equal(stockOf(latestStockOnly(week4)), 3900, "week 4 of every month reads September's week 4 only, never August's as well");
  }

  // 4) The latest week is resolved PER DISTRIBUTOR, and the company figure adds distributors, not months.
  {
    const kept = latestStockOnly([...SATO, ...BEHIND]);
    assert.equal(stockOf(kept, (r) => r.distributorCode === "SATO"), 11071, "each distributor keeps its own latest week");
    assert.equal(
      stockOf(kept, (r) => r.distributorCode === "BEHIND"),
      250,
      "a distributor a month behind keeps its own latest week (22 August); another distributor's newer month never zeroes it",
    );
    assert.equal(stockOf(kept), 11321, "the company total is one snapshot per distributor");
  }

  // 5) Month first, then week — the Summarized Report's order — even when an older month's sheet is dated later.
  {
    const lateAugustSheet = [
      row({ cycleMonth: AUG, weekNumber: 4, weekStart: "2026-09-03", stockQty: 700 }),
      row({ cycleMonth: SEP, weekNumber: 1, weekStart: "2026-09-02", stockQty: 650 }),
    ];
    assert.equal(stockOf(latestStockOnly(lateAugustSheet)), 650, "the latest cycle month decides first, then its latest week");
  }

  // 6) Untagged rows (no cycle month) no longer keep stock on every week.
  {
    const kept = latestStockOnly([
      row({ distributorCode: "LEGACY", cycleMonth: "", weekNumber: null, weekStart: "2026-06-06", stockQty: 80 }),
      row({ distributorCode: "LEGACY", cycleMonth: "", weekNumber: null, weekStart: "2026-06-13", stockQty: 70 }),
      row({ distributorCode: "MIXED", cycleMonth: "", weekNumber: null, weekStart: "2026-09-20", stockQty: 40 }),
      row({ distributorCode: "MIXED", cycleMonth: SEP, weekNumber: 2, weekStart: "2026-09-12", stockQty: 55 }),
    ]);
    assert.equal(stockOf(kept, (r) => r.distributorCode === "LEGACY"), 70, "an untagged distributor keeps only its latest week");
    assert.equal(
      stockOf(kept, (r) => r.distributorCode === "MIXED"),
      55,
      "an untagged row ranks below every tagged month, so it never adds to a distributor's tagged snapshot",
    );
  }

  // 7) Only stock changes. Sales value and units, every other field, row count and order pass through.
  {
    const input = [...SATO, ...BEHIND];
    const before = JSON.stringify(input);
    const kept = latestStockOnly(input);
    assert.equal(JSON.stringify(input), before, "the input rows are never mutated");
    assert.equal(kept.length, input.length, "no row is dropped");
    kept.forEach((r, i) => {
      assert.deepEqual({ ...r, stockQty: 0 }, { ...input[i], stockQty: 0 }, `row ${i}: every field but stock is untouched, in order`);
    });
    const totals = (rows: readonly Row[]) => rows.reduce((acc, r) => [acc[0] + r.salesValue, acc[1] + r.netQty], [0, 0]);
    assert.deepEqual(totals(kept), totals(input), "sales value and sales units still add every week of every month");
  }

  // 8) One rule, not two: the Summarized Report's year-to-date guard changes nothing over the engine's rows.
  //    (Tagged rows only — that guard drops untagged stock outright, and production carries no untagged rows.)
  {
    const engineRows = latestStockOnly([...SATO, ...BEHIND]).map(exportRow);
    assert.deepEqual(
      latestCycleMonthStockOnly(engineRows).map((r) => r.stockUnits),
      engineRows.map((r) => r.stockUnits),
      "latestCycleMonthStockOnly must be a no-op over the engine's reduced rows",
    );
  }

  // 9) The engine applies this rule to every stock total it hands out — tiles, compare delta, and exports.
  {
    const service = readFileSync(fileURLToPath(new URL("../src/lib/sales/weekly/service.ts", import.meta.url)), "utf8");
    assert.match(
      service,
      /import \{ latestStockOnly \} from "@\/lib\/sales\/weekly\/latest-stock";/,
      "the weekly engine takes its stock rule from latest-stock.ts",
    );
    assert.doesNotMatch(service, /const latestStockOnly\s*=/, "and keeps no local copy that could drift back to one week per month");
    assert.match(service, /const weekRowsAdj = latestStockOnly\(weekRows\);/, "the tiles, rankings and zero-sales branches read reduced rows");
    assert.match(service, /const priorRowsAdj = latestStockOnly\(priorRows\);/, "so does the prior week behind the compare delta");
    assert.match(service, /const grainWeekRowsAdj = grainLifted\s*\?\s*latestStockOnly\(/, "and the lifted row grain of the managers' exports");
    assert.match(
      service,
      /stockUnits: Number\(sum\(weekRowsAdj, \(row\) => row\.stockQty\)\.toFixed\(2\)\)/,
      "the Stock Units tile sums the reduced rows",
    );
    assert.match(
      service,
      /stockUnits: delta\(sum\(weekRowsAdj, \(row\) => row\.stockQty\), !timeFilterActive && priorCanonical \? sum\(priorRowsAdj, \(row\) => row\.stockQty\) : null\)/,
      "the compare delta reads reduced rows on both sides",
    );
    assert.match(
      service,
      /factRows: filters\?\.includeFactRows\s*\?\s*grainWeekRowsAdj\.map/,
      "the BI and NSM/DSM books' factRows are the reduced rows, so each export keeps matching its screen",
    );
  }
}
