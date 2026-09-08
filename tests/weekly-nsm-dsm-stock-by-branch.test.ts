import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { buildNsmDsmWorkbook } from "../src/lib/sales/weekly/nsm-dsm-workbook.ts";
import type { WeeklyManagerIndex } from "../src/lib/sales/weekly/manager-attribution.ts";
import type { WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

// The "Stock by branch" sheet — what every branch is holding, per product, sectioned by region and
// then by area. Owner request, 2026-09-08: the existing "Stock" tab is titled "Stock with no sales"
// and answers a different question (branches that sold nothing and still hold stock), so this is a
// new sheet beside it and that one is untouched.
//
// The four rules below are the ones a reader cannot check for themselves and a later change could
// silently break. Each is a claim about honesty, not about layout.

const SHEET = "Stock by branch";
const NO_AREA = "Region level (no single area)";

const MANAGER_INDEX: WeeklyManagerIndex = {
  ceoName: "The CEO",
  dmByLineRegion: new Map(),
  nameByHrId: new Map(),
  operationalRegionByLineArea: new Map(),
  regionNameByCode: new Map([["GC", "Greater Cairo"], ["DL", "Delta"]]),
  seatsById: new Map(),
};

function row(overrides: Partial<WeeklyFactExportRow> = {}): WeeklyFactExportRow {
  return {
    areaCode: "C11",
    batchId: "b1",
    branchCode: "BR1",
    branchName: "Cairo Depot",
    cycleMonth: "2026-08",
    distributorCode: "IS",
    distributorName: "Ibn Sina-Sato",
    family: "Tebofortin",
    line: "CNS",
    productCode: "TEB80",
    productName: "Tebofortin 80mg",
    regionCode: "GC",
    regionName: "Greater Cairo",
    salesUnits: 100,
    salesValue: 30_000, // 300 EGP a unit, so stock value is readable by hand
    stockUnits: 0,
    weekNumber: 1,
    weekStart: "2026-08-02",
    ...overrides,
  };
}

/**
 * An area-split index that REALLY splits: a branch carrying no area of its own, on a region that
 * maps to two areas, is divided 50/50 by `splitWeeklyRowsByBranch`. Measured: 500 stock units
 * become 250 and 250 across C11 and C12.
 *
 * The whole point of the "not apportioned" assertion is to fail when this sheet reads the SPLIT
 * rows, and with `areaSplit: null` it CANNOT — split and raw are then literally the same array, so
 * the assertion passes on the right code and the wrong code alike. It was written that way first
 * and measured GREEN against the bug it exists to catch.
 */
const SPLITTING_INDEX = {
  areaByBrick: new Map<string, string>(),
  areaNames: new Map([["C11", "Cairo 1"], ["C12", "Cairo 2"]]),
  areasByLineGovernorate: new Map<string, string[]>(),
  areasByLineRegion: new Map([["cns||GC", ["C11", "C12"]]]),
  governorateNames: new Map<string, string>(),
} as unknown as Parameters<typeof buildNsmDsmWorkbook>[0]["areaSplit"];

async function build(
  rows: WeeklyFactExportRow[],
  areaSplit: Parameters<typeof buildNsmDsmWorkbook>[0]["areaSplit"] = null,
): Promise<ExcelJS.Worksheet> {
  const buffer = await buildNsmDsmWorkbook({
    areaNames: new Map([["C11", "Cairo 1"], ["C12", "Cairo 2"], ["D21", "Gharbia 2"]]),
    areaSplit,
    generatedAt: "2026-09-08T09:00:00.000Z",
    lineFilter: ["CNS"],
    managerIndex: MANAGER_INDEX,
    periodLabel: "August 2026",
    productAxis: ["TEB80", "TEB120"],
    regionFilter: [],
    regionNames: new Map([["GC", "Greater Cairo"], ["DL", "Delta"]]),
    rows,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet(SHEET);
  assert.ok(sheet, `the workbook must carry a "${SHEET}" sheet`);
  return sheet!;
}

/** Every row as [label, distributor, ...numbers], with the outline level that nests it. */
function readRows(sheet: ExcelJS.Worksheet): { level: number; label: string; cells: (string | number)[] }[] {
  const out: { level: number; label: string; cells: (string | number)[] }[] = [];
  sheet.eachRow((line, number) => {
    if (number < 7) return; // masthead, product band and header
    const cells: (string | number)[] = [];
    line.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell.value;
      cells.push(typeof value === "number" ? value : String(value ?? ""));
    });
    if (cells.length === 0) return;
    out.push({ cells, label: String(cells[0] ?? ""), level: line.outlineLevel ?? 0 });
  });
  return out;
}

export async function runWeeklyNsmDsmStockByBranchTests() {
  // ── 1. a distributor that reports NO stock is not on the sheet at all ───────
  //
  // Measured on production 2026-09-08: POS Purchasing Sales (107 branches) and Direct (Company) (6)
  // send no stock column at all. Printing them as zero would say "this branch is empty" where the
  // truth is "nobody told us" — the one lie a stock sheet must not tell.
  const withSilent = await build([
    row({ stockUnits: 40 }),
    row({ branchName: "POS Pharmacy", distributorName: "POS Purchasing Sales", stockUnits: 0 }),
  ]);
  const silentText = readRows(withSilent).map((line) => line.cells.join(" ")).join(" | ");
  assert.ok(
    !silentText.includes("POS Pharmacy"),
    "a distributor that reports no stock anywhere must be absent — printing its branches at zero " +
      "reads as EMPTY when the truth is NOT REPORTED",
  );
  // ...and the strip says which distributors the sheet IS built from, so the absence is legible.
  const strip = String(withSilent.getCell(1, 1).value ?? "");
  assert.match(strip, /Ibn Sina-Sato/, "the masthead names the distributors that do report stock");

  // ── 2. a genuinely EMPTY branch of a REPORTING distributor is kept ──────────
  //
  // That is a real reading: 65 of overseas' 186 branches hold stock, and the empty ones are exactly
  // what a manager is looking for. Dropping them would answer a different question.
  const withEmpty = await build([
    row({ branchName: "Holding Depot", stockUnits: 40 }),
    row({ branchCode: "BR2", branchName: "Empty Depot", stockUnits: 0 }),
  ]);
  const emptyRows = readRows(withEmpty);
  assert.ok(
    emptyRows.some((line) => line.label === "Empty Depot"),
    "a branch of a reporting distributor that holds nothing must still be listed — its zero is a " +
      "measurement, not a gap",
  );

  // ── 3. a branch with no area is bucketed, and that bucket sorts LAST ────────
  const withChain = await build([
    row({ areaCode: "C11", branchCode: "A", branchName: "Cairo 1 Depot", stockUnits: 10 }),
    row({ areaCode: "C12", branchCode: "B", branchName: "Cairo 2 Depot", stockUnits: 10 }),
    // A key account serving the whole region: no single area, and the biggest holder of the three.
    row({ areaCode: null, branchCode: "C", branchName: "Big Chain", stockUnits: 500 }),
  ]);
  const chainRows = readRows(withChain);
  const areaHeadings = chainRows.filter((line) => line.level === 1).map((line) => line.label);
  assert.ok(areaHeadings.includes(NO_AREA), `a branch with no area lands under "${NO_AREA}"`);
  assert.equal(
    areaHeadings[areaHeadings.length - 1],
    NO_AREA,
    "the no-area bucket sorts LAST in its region even when it holds the most — it is the key " +
      "accounts and wholesale depots, the least useful thing to open a region on",
  );

  // ── 4. THE ONE THAT MATTERS: stock is never apportioned across areas ───────
  //
  // splitWeeklyRowsByBranch divides stockUnits pro rata across the areas a depot serves. That is
  // right for SALES (those sales really did happen in those territories) and a fabrication for
  // STOCK, because a pack sits in ONE building. This sheet therefore reads the RAW rows.
  //
  // The fixture makes the splitter actually FIRE: a branch with no area of its own, on a region
  // that maps to two areas, is divided 50/50. The split rows then say 250 + 250 in two places and
  // the raw rows say 500 in one, so only the correct code can pass.
  const split = await build(
    [row({ areaCode: null, branchCode: "CHN", branchName: "Big Chain", stockUnits: 500 })],
    SPLITTING_INDEX,
  );
  const branchRows = readRows(split).filter((line) => line.level === 2);
  const appearances = branchRows.filter((line) => line.label === "Big Chain");
  assert.equal(
    appearances.length,
    1,
    "a branch appears exactly ONCE - reading the split rows would list it once per area it serves, " +
      `got ${appearances.length}`,
  );
  assert.ok(
    appearances[0].cells.includes(500),
    `and carries its WHOLE stock: 500, never the apportioned 250; got ${appearances[0].cells.join(", ")}`,
  );
  // The sibling sheets still see the split - the raw-row read is local to this sheet, never a
  // global opt-out that would quietly change how sales are attributed.
  assert.ok(
    split.workbook.getWorksheet("By area"),
    "the area sheet is still built, so the split remains in force everywhere else",
  );

  // ── 5. every level adds up, in units per product and in money ──────────────
  const full = await build([
    row({ areaCode: "C11", branchCode: "A", branchName: "Cairo 1 Depot", productCode: "TEB80", stockUnits: 10 }),
    row({ areaCode: "C12", branchCode: "B", branchName: "Cairo 2 Depot", productCode: "TEB80", stockUnits: 20 }),
    row({
      areaCode: "D21", branchCode: "C", branchName: "Gharbia Depot", productCode: "TEB80",
      regionCode: "DL", regionName: "Delta", stockUnits: 70,
    }),
  ]);
  const lines = readRows(full);
  const total = lines.find((line) => line.label === "Total stock on hand");
  assert.ok(total, "the sheet closes with a total row");
  assert.ok(
    total!.cells.includes(100),
    `TEB80 totals 10 + 20 + 70 = 100 units across every region; got ${total!.cells.join(", ")}`,
  );
  // 100 units at the 300 EGP a unit this scope sold TEB80 for.
  assert.ok(
    total!.cells.includes(30_000),
    `and 30,000 EGP of stock value; got ${total!.cells.join(", ")}`,
  );
  // Each region's own band adds only its own branches.
  const regionBands = lines.filter((line) => line.level === 0 && line.label !== "Total stock on hand");
  const cairo = regionBands.find((line) => line.label === "Greater Cairo");
  const delta = regionBands.find((line) => line.label === "Delta");
  assert.ok(cairo && delta, "both regions get their own band");
  assert.ok(cairo!.cells.includes(30), `Greater Cairo holds 10 + 20 = 30; got ${cairo!.cells.join(", ")}`);
  assert.ok(delta!.cells.includes(70), `Delta holds 70; got ${delta!.cells.join(", ")}`);

  // ── 6. the section headings are merged, not written into the Distributor column ──
  const bandRow = full.getRow(7);
  assert.ok(
    full.getCell(bandRow.number, 2).isMerged,
    "a region band spans the Branch and Distributor columns — unmerged, the region name would read " +
      "as the name of a distributor",
  );

  // ── 7. the nesting a reader collapses ──────────────────────────────────────
  assert.deepEqual(
    [...new Set(lines.map((line) => line.level))].sort(),
    [0, 1, 2],
    "region (0) / area (1) / branch (2) — the outline levels that let a manager collapse the sheet " +
      "to region totals and open only the territory he is chasing",
  );
}
