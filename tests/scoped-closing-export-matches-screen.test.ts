import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  buildMainStoresRows,
  isMainStoresRow,
  MAIN_STORES_LABEL,
} from "../src/lib/sales/closing-main-stores.ts";
import { MASKED_SOURCE_LABEL } from "../src/lib/sales/closing-source-mask.ts";
import {
  assembleComparison,
  comparisonLeavesFromRows,
  type ComparisonSourceRow,
  type MonthlyClosingComparison,
} from "../src/lib/sales/monthly-closing-comparison.ts";
import type { ClosingDetailRow, ClosingDetailsResult, ClosingDetailsTotals } from "../src/lib/sales/monthly-closing-details.ts";
import { buildPortalClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import { buildMonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";
import type { SplitRegions, StoreSplitRow } from "../src/lib/sales/store-sales-city-split.ts";

/**
 * Owner, 2026-09-16, choosing "Fix every scoped file now": a scoped viewer's Export XLSX must total what
 * their Monthly Closing screen totals — District, Regional and National Managers, Product Managers and
 * Medical Reps alike.
 *
 * He was shown the gap on a Medical Rep's file: Kafr El-Sheikh 1, August, 23,007 EGP in the file beside
 * 82,981 on the screen. The scoped export read the rows AS INVOICED (revealed) and then dropped El Qema,
 * so every sheet rebuilt from those rows lacked the area's share of the city split and all of Main
 * Stores. Every other scoped file had the same gap. What this file holds in place:
 *
 *   1. a Main Stores row names no warehouse. It used to carry the brick, block, invoice date, sheet row
 *      and discount of whichever El Qema line it was copied from — the Details tab prints the brick on
 *      every row and the file prints all of them — although a share pooled from every warehouse has
 *      no one brick or invoice behind it;
 *   2. the comparison files Main Stores under the unnamed "—", so the per-distributor grids carry its
 *      money instead of losing it between a blank code the column list skips and a nameless rollup row;
 *   3. the route reads the viewer's own Details rows, never the rows as invoiced (a source pin: the
 *      route itself needs a database);
 *   4. the workbook adds up the value ON each row, so a Main Stores row, which has no factory price,
 *      reaches its Closing Matrix and Total, the Difference stays zero, and the Data sheet no longer
 *      calls these rows invoice lines.
 */

const round = (value: number) => Number(value.toFixed(6));
const near = (actual: number, expected: number) => Math.abs(actual - expected) < 0.005;

/** Line endings normalised, so a CRLF checkout matches the same substrings CI's LF checkout does. */
function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

/** Pedia's organogram as August holds it — the fixture qema-warehouse-split.test.ts splits against. */
const PEDIA_OTHERS: ReadonlySet<string> = new Set([
  "CA5", "D17", "UE8", "OT1", "OT2", "OT4", "OT5", "OT6", "OT7", "OT8", "OT9", "OT10",
]);
const PEDIA_REGIONS: SplitRegions = {
  areasByRegion: new Map<string, ReadonlySet<string>>([
    ["AB", new Set(["AB1", "AB2", "AB3", "AB4", "AB5", "D16"])],
    ["CA", new Set(["CA1", "CA2", "CA3", "CA4", "CA6"])],
    ["D1", new Set(["D11", "D12", "D13", "D14", "D15"])],
    ["D2", new Set(["D21", "D22", "D23", "D24", "D25", "D26"])],
    ["GZ", new Set(["GZ1", "GZ2", "GZ3", "GZ4", "GZ5", "GZ6", "GZ7", "UE9"])],
    ["OT", PEDIA_OTHERS],
    ["UE", new Set(["UE1", "UE2", "UE3", "UE4", "UE5", "UE6", "UE7"])],
  ]),
  others: PEDIA_OTHERS,
};

type WarehouseLine = StoreSplitRow & {
  areaMismatch: boolean;
  blockCode: string;
  brickId: string;
  brickName: string;
  brickUnmapped: boolean;
  clientAddress: string;
  discount: number;
  factoryPrice: number | null;
  invoiceDate: string | null;
  rowNumber: number | null;
};

/** One of El Qema's warehouse lines, carrying every field that points back at that one warehouse. */
const WAREHOUSE_LINE: WarehouseLine = {
  areaCode: "D11",
  areaMismatch: true,
  blockCode: "B208",
  brickId: "B208-1",
  brickName: "بنها 1",
  brickUnmapped: true,
  clientAddress: "طريق بنها الزراعي",
  clientCode: "QM-9001",
  clientName: "مخزن القليوبية للأدوية",
  discount: 0.05,
  distributorCode: "QM",
  factoryPrice: 270,
  includedInClosing: true,
  invoiceDate: "2026-09-03",
  isDirect: false,
  officialLine: "Pedia",
  productCode: "LA001",
  qty: 600,
  rowNumber: 17,
  salesValue: 162_000,
};

function runMainStoresNamesNoWarehouseTests(): WarehouseLine[] {
  const mainStores = buildMainStoresRows([WAREHOUSE_LINE], {
    areaNameOf: (areaCode) => ({ areaName: `Area ${areaCode}`, regionCode: "R", regionName: "Region" }),
    line: "Pedia",
    period: "2026-09",
    regions: PEDIA_REGIONS,
  });
  assert.ok(mainStores.length > 1, "control: El Qema's warehouse line is shared out as Main Stores rows over the areas in play");
  // Within a fraction of a piastre: the shares are thirds and tiers of the line, so their float sum
  // lands a few millionths off (161,999.999996 here), never on the whole number.
  const sharesTotal = mainStores.reduce((sum, share) => sum + share.salesValue, 0);
  assert.ok(
    near(sharesTotal, 162_000),
    `control: and the shares add back to the warehouse line's value (${sharesTotal} against 162,000), so every row below is real money`,
  );

  for (const share of mainStores) {
    const where = `the Main Stores row for ${share.areaCode}`;
    assert.ok(isMainStoresRow(share), `${where} is recognisable as Main Stores`);
    assert.equal(
      share.brickId,
      "",
      `${where} names no brick — it printed the warehouse's own, which the Details tab shows on every row and the file's Data sheet prints`,
    );
    assert.equal(share.brickName, "", `${where} names no brick — not by name either`);
    assert.equal(share.blockCode, "", `${where} names no block`);
    assert.equal(share.invoiceDate, null, `${where} has no invoice date — a pooled share has no one invoice behind it`);
    assert.equal(share.rowNumber, null, `${where} points at no row of El Qema's sheet`);
    assert.equal(share.discount, 0, `${where} carries no discount off El Qema's invoice`);
    assert.equal(share.areaMismatch, false, `${where} carries no area-mismatch flag — that flag describes the warehouse's brick`);
    assert.equal(share.brickUnmapped, false, `${where} carries no unmapped-brick flag — that flag describes the warehouse's brick`);
    assert.equal(share.clientAddress, "", `${where} has no address`);
    assert.equal(share.factoryPrice, null, `${where} has no factory price — a share is not a priced transaction`);
  }

  // Whatever field is added later, none may repeat what identifies the warehouse.
  const traces = new Set<unknown>([
    "QM",
    WAREHOUSE_LINE.clientCode,
    WAREHOUSE_LINE.clientName,
    WAREHOUSE_LINE.clientAddress,
    WAREHOUSE_LINE.brickId,
    WAREHOUSE_LINE.brickName,
    WAREHOUSE_LINE.blockCode,
    WAREHOUSE_LINE.invoiceDate,
  ]);
  for (const share of mainStores) {
    for (const [field, value] of Object.entries(share)) {
      assert.ok(
        !traces.has(value),
        `the Main Stores row for ${share.areaCode} carries "${String(value)}" in ${field}, copied off El Qema's own invoice line`,
      );
    }
  }
  return mainStores;
}

const COMPARISON_MAPS = {
  areaName: new Map([["D11", "Area D11"], ["D12", "Area D12"]]),
  areaRegion: new Map([["D11", "D1"], ["D12", "D1"]]),
  distributorName: new Map([["PS", "Pharmacy Distributor"], ["IS", "Store Distributor"]]),
  regionName: new Map([["D1", "Delta (1)"]]),
};

/** The same assembly `loadMonthlyClosingComparisonFromRows` runs, minus the masters it reads from the database. */
function comparisonFor(rows: ComparisonSourceRow[]): MonthlyClosingComparison {
  return assembleComparison({
    ...comparisonLeavesFromRows(rows),
    line: "Pedia",
    maps: COMPARISON_MAPS,
    masterAreas: [
      { areaCode: "D11", areaName: "Area D11", regionCode: "D1" },
      { areaCode: "D12", areaName: "Area D12", regionCode: "D1" },
    ],
    masterBricks: [{ areaCode: "D11", brickId: "B-D11", brickName: "Brick D11", regionCode: "D1" }],
    period: "2026-09",
  });
}

function runMainStoresFiledUnderDashTests(mainStores: WarehouseLine[]) {
  // A real share, straight out of the builder above, beside a pharmacy's line in the same area.
  const share = mainStores[0];
  assert.ok(share, "control: the builder above produced a Main Stores share");

  const rows: ComparisonSourceRow[] = [
    {
      areaCode: share.areaCode, sheetAreaCode: share.areaCode, brickId: "B-D11", brickName: "Brick D11", clientCode: "C1",
      clientName: "Pharmacy One", distributorCode: "PS", includedInClosing: true, productCode: "LA001",
      productName: "Lacto Advanced 1", qty: 10, regionCode: "D1", salesValue: 2_700,
    },
    {
      areaCode: share.areaCode, sheetAreaCode: share.sheetAreaCode, brickId: share.brickId, brickName: share.brickName,
      clientCode: share.clientCode, clientName: share.clientName, distributorCode: share.distributorCode ?? "",
      includedInClosing: share.includedInClosing, productCode: share.productCode, productName: "Lacto Advanced 1",
      qty: share.qty, regionCode: "D1", salesValue: share.salesValue,
    },
  ];

  const leaves = comparisonLeavesFromRows(rows);
  const dashLeaf = leaves.distProductRows.find((leaf) => leaf.distributorCode === MASKED_SOURCE_LABEL);
  assert.ok(
    dashLeaf,
    "the comparison files Main Stores under the unnamed \"—\", where El Qema's money goes for every reader who may not see its name",
  );
  assert.equal(dashLeaf.value, round(share.salesValue), "with all of its value");
  assert.ok(
    leaves.distProductRows.every((leaf) => leaf.distributorCode.trim() !== ""),
    "and no leaf is left with a blank distributor",
  );
  assert.deepEqual(leaves.brickRows.map((leaf) => leaf.brickId), ["B-D11"], "Main Stores has no brick, so it never reaches the brick rankings");
  assert.deepEqual(leaves.customerRows.map((leaf) => leaf.clientCode), ["C1"], "nor a client code, so it never reaches the customer rankings");

  const comparison = comparisonFor(rows);
  assert.ok(
    comparison.distributors.some((distributor) => distributor.code === MASKED_SOURCE_LABEL),
    "the Distributor Comparison sheet has a \"—\" column for it",
  );
  for (const grid of [comparison.areaByDistributor, comparison.productByDistributor, comparison.regionByDistributor]) {
    for (const gridRow of grid) {
      const listed = comparison.distributors.reduce((sum, distributor) => sum + (gridRow.byDistributor[distributor.code] ?? 0), 0);
      assert.ok(
        near(listed, gridRow.total),
        `the distributor columns of "${gridRow.label}" add up to ${listed} against its total of ${gridRow.total} — `
          + "Main Stores' money must sit in a column, not only in the total",
      );
    }
  }
  assert.ok(
    comparison.byDistributor.every((entry) => entry.distributorCode.trim() !== ""),
    "and the distributor rollup has no nameless row",
  );
}

function runRouteReadsTheDetailsTabTests() {
  const route = readSource("../app/api/sales/monthly-closing/export/route.ts");
  const scopedStart = route.indexOf("// Every other scoped sales role");
  assert.ok(scopedStart > 0, "control: the export route still has its scoped branch");
  const callStart = route.indexOf("loadMonthlyClosingDetails({", scopedStart);
  const callEnd = route.indexOf("});", callStart);
  assert.ok(callStart > scopedStart && callEnd > callStart, "control: the scoped branch reads its rows with loadMonthlyClosingDetails");
  const scopedRead = route.slice(callStart, callEnd);
  assert.ok(scopedRead.includes("unpaged: true,"), "control: that read is the export's own unpaged one");
  assert.ok(
    !scopedRead.includes("revealSource"),
    "every scoped viewer's file is built from their own Details rows, never the rows as invoiced — revealed, the file lost "
      + "its area's city-split shares and all of Main Stores (a rep's 23,007 EGP beside a screen of 82,981)",
  );

  // The pin can see the flag where it is really written: the full-workbook branch, which runs the split itself, reveals.
  const fullStart = route.indexOf("loadMonthlyClosingDetails({");
  assert.ok(fullStart >= 0 && fullStart < scopedStart, "control: the full-workbook branch reads its rows above the scoped one");
  assert.ok(
    route.slice(fullStart, route.indexOf("});", fullStart)).includes("revealSource: true,"),
    "control: the full-workbook branch still reveals, so the check above reads the flag in its real spelling",
  );
}

const PRODUCT = { family: "Lacto Advanced", productCode: "LA001", productName: "Lacto Advanced 1" };

function detailRow(
  fields: Partial<ClosingDetailRow> & Pick<ClosingDetailRow, "areaCode" | "clientName" | "distributorCode" | "qty" | "salesValue">,
): ClosingDetailRow {
  return {
    id: 0,
    rowNumber: null,
    invoicePeriod: "2026-09",
    invoiceDate: null,
    officialLine: "Pedia",
    sheetAreaCode: fields.areaCode,
    sheetAreaName: `Area ${fields.areaCode}`,
    sheetRegionCode: "D1",
    sheetRegionName: "Delta (1)",
    blockCode: "",
    brickId: "",
    brickName: "",
    areaName: `Area ${fields.areaCode}`,
    regionCode: "D1",
    regionName: "Delta (1)",
    operationalRegionCode: "D1",
    operationalRegionName: "Delta (1)",
    areaMismatch: false,
    brickUnmapped: false,
    clientCode: "",
    clientAddress: "",
    ...PRODUCT,
    factoryPrice: 270,
    bonusQty: 0,
    discount: 0,
    effectiveUnits: fields.qty,
    sheetValue: fields.salesValue,
    isDirect: false,
    isConfidential: false,
    evenSplitApplied: false,
    missingClientCode: false,
    validationState: "validated",
    includedInClosing: true,
    exclusions: [],
    ...fields,
  };
}

function totalsOf(rows: ClosingDetailRow[]): ClosingDetailsTotals {
  return {
    effectiveUnits: round(rows.reduce((sum, row) => sum + row.effectiveUnits, 0)),
    rows: rows.length,
    salesValue: round(rows.reduce((sum, row) => sum + row.salesValue, 0)),
    units: round(rows.reduce((sum, row) => sum + row.qty, 0)),
  };
}

function numberIn(cell: ExcelJS.Cell): number {
  const value = cell.value;
  if (typeof value === "number") return value;
  // A formula's cached answer is read off the cell, never off `cell.value`: ExcelJS builds that copy
  // keeping only truthy keys, so a Difference of exactly 0 comes back as `{ formula }` with no result.
  if (value && typeof value === "object" && "formula" in value) return Number(cell.result);
  return Number.NaN;
}

function rowLabelled(sheet: ExcelJS.Worksheet, label: string): ExcelJS.Row | undefined {
  let found: ExcelJS.Row | undefined;
  sheet.eachRow((row) => {
    if (!found && String(row.getCell(1).value ?? "").trim() === label) found = row;
  });
  return found;
}

async function runWorkbookAddsUpTheRowsTests() {
  // What a District Manager's Details tab hands the export for two areas: a pharmacy's line, the area's
  // Main Stores share (no factory price, a value no whole number of units × 270 makes), and a
  // wholesaler's city-split share credited to the second area.
  const rows = [
    detailRow({ areaCode: "D11", brickId: "B-D11", brickName: "Brick D11", clientCode: "C1", clientName: "Pharmacy One", distributorCode: "PS", qty: 10, salesValue: 2_700 }),
    detailRow({ areaCode: "D11", clientName: MAIN_STORES_LABEL, distributorCode: "", factoryPrice: null as unknown as number, qty: 4, salesValue: 1_234.56 }),
    detailRow({ areaCode: "D12", brickId: "B-D11", brickName: "Brick D11", clientCode: "W1", clientName: "Wholesaler One", distributorCode: "IS", qty: 2.5, salesValue: 675 }),
  ];
  // The viewer's screen: the same money, cell for cell.
  const screen = buildMonthlyClosingMatrix({
    areas: [
      { areaCode: "D11", areaName: "Area D11", regionCode: "D1", regionName: "Delta (1)" },
      { areaCode: "D12", areaName: "Area D12", regionCode: "D1", regionName: "Delta (1)" },
    ],
    availableLines: ["Pedia"],
    availablePeriods: ["2026-09"],
    cells: [
      { areaCode: "D11", productCode: "LA001", salesUnits: 14, salesValue: 3_934.56 },
      { areaCode: "D12", productCode: "LA001", salesUnits: 2.5, salesValue: 675 },
    ],
    line: "Pedia",
    period: "2026-09",
    products: [{ ...PRODUCT, factoryPrice: 270, familyCode: "LA", line: "Pedia", source: "" }],
  });
  const none = totalsOf([]);
  const details: ClosingDetailsResult = {
    availableLines: ["Pedia"],
    availablePeriods: ["2026-09"],
    canRevealConfidential: false,
    confidentialIncluded: false,
    filteredRowCount: rows.length,
    line: "Pedia",
    options: { areas: [], distributors: [], products: [], regions: [] },
    outOfScope: false,
    page: 1,
    pageSize: rows.length,
    period: "2026-09",
    reconciliation: {
      areaMismatches: none,
      closingHeadline: totalsOf(rows),
      excludedConfidential: none,
      excludedDirect: none,
      includedInClosing: totalsOf(rows),
      missingClientCode: none,
      unmappedBricks: none,
    },
    rows,
    totals: totalsOf(rows),
  };

  const buffer = await buildPortalClosingWorkbook(screen, comparisonFor(rows), details, null);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const data = workbook.getWorksheet("Data");
  assert.ok(data, "control: the scoped file has its Data sheet");
  const subtitle = String(data.getCell(2, 1).value ?? "");
  assert.ok(
    subtitle.startsWith("Data — every row of your closing, as your Details tab shows it"),
    `the Data sheet says what it holds, the viewer's own Details rows; it reads "${subtitle}"`,
  );
  assert.ok(!/invoice line/i.test(subtitle), "and no longer calls Main Stores and the credited shares invoice lines");

  const column = new Map<string, number>();
  data.getRow(5).eachCell((cell, index) => column.set(String(cell.value ?? ""), index));
  const clientColumn = column.get("Client Name");
  const valueColumn = column.get("Sales Value");
  assert.ok(clientColumn && valueColumn, "control: the Data sheet still has its Client Name and Sales Value columns");
  const mainStoresLines: number[] = [];
  data.eachRow((row, index) => {
    if (index > 5 && String(row.getCell(clientColumn).value ?? "") === MAIN_STORES_LABEL) {
      mainStoresLines.push(numberIn(row.getCell(valueColumn)));
    }
  });
  assert.deepEqual(mainStoresLines, [1_234.56], "the Data sheet lists the Main Stores row with its value");

  const total = workbook.getWorksheet("Total");
  assert.ok(total, "control: the scoped file has its Total sheet");
  const grand = rowLabelled(total, "Closing Matrix grand total");
  assert.ok(grand, "control: the Total sheet names the Closing Matrix grand total");
  const screenValue = screen.grandTotal.rowTotal.salesValue;
  assert.ok(
    near(numberIn(grand.getCell(3)), screenValue),
    `the file's Closing Matrix totals ${numberIn(grand.getCell(3))}, the screen ${screenValue}: a Main Stores row has no factory `
      + "price, so its money reaches the file only because the matrix adds up the value on the row",
  );
  const difference = rowLabelled(total, "Difference");
  assert.ok(difference, "control: the Total sheet has its Difference line");
  assert.ok(
    near(numberIn(difference.getCell(3)), 0),
    `and the Difference is ${numberIn(difference.getCell(3))}, not zero: some Data row is missing from the file's matrix`,
  );
}

export async function runScopedClosingExportMatchesScreenTests() {
  const mainStores = runMainStoresNamesNoWarehouseTests();
  runMainStoresFiledUnderDashTests(mainStores);
  runRouteReadsTheDetailsTabTests();
  await runWorkbookAddsUpTheRowsTests();
}
