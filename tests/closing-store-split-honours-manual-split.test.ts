import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { prepareClosingStoreSplit } from "../src/lib/sales/closing-store-split-export.ts";
import { assembleComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import {
  buildFilterOptions,
  summarize,
  type ClosingDetailRow,
  type ClosingDetailsResult,
} from "../src/lib/sales/monthly-closing-details.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import {
  filterMonthlyClosingMatrix,
  type MonthlyClosingCell,
  type MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";
import {
  customersAlreadySplitAcrossAreas,
  detailStoreSplitByCustomer,
  splitStoreSalesAcrossCityAreas,
} from "../src/lib/sales/store-sales-city-split.ts";
import { applyStoreSplitToMatrix } from "../src/lib/sales/store-split-matrix.ts";

// A customer a human already apportioned by hand must survive the EXPORT, not just the detector.
//
// THE OWNER'S RULE (2026-08-06). Client 441164 ريونيون للتجارةوالاستثمار returned its whole June
// purchase in July — -400 units / -34,380.00 across RO001 and SA001 — and the owner ruled that
// return splits evenly between Dakahlia 2 (D22) and Port Said - Damietta (D26). The even city share
// is an ESTIMATE for a wholesaler nobody has apportioned; once a human has said where the sales go,
// that answer wins.
//
// THE BUG THIS PINS, and it is NOT the one the first fix aimed at. `customersAlreadySplitAcrossAreas`
// shipped reading `row.areaCode`. That field is the RESOLVED area: loadMonthlyClosingDetails sets it
// from the row's BRICK's master area and only falls back to the sheet's own area when the brick is
// unmapped. The hand-split was applied to the FACT rows, not to the brick — all four of 441164's
// July rows still carry brick B186-1, whose master area is Dakahlia 1. So the resolved view of that
// customer was a single area, the exemption never fired, and the city rule re-split the whole
// -34,380.00 three ways across Dakahlia 1, 2 and 3: a third of a return handed to Dakahlia 3, which
// had nothing to do with it, and Port Said dropped entirely because it is a different city. The fix
// was live, the migration was applied, and the downloaded workbook was unchanged — which is exactly
// what a detector reading the wrong field looks like from the outside.
//
// Worse than a wrong area: the money is double-counted. phx_monthly_closing_matrix books these rows
// by their FACT area (verified live 2026-08-06 — D22 and D26 carry the negatives, D21 does not), so
// the split subtracted -34,380.00 from an area that never held it and conjured a positive SA001 cell
// in Dakahlia 1 out of nothing.
//
// WHAT IS ASSERTED. The real fixture shape — resolved area D21, fact areas D22 and D26 — driven
// through prepareClosingStoreSplit → applyStoreSplitToMatrix → buildMonthlyClosingWorkbook, then the
// produced file is read back. 441164 must not move, a genuine wholesaler beside it must still split
// normally, and the Total sheet must still tie.

const PERIOD = "2026-07";
const LINE = "Anti Infective";
// Dakahlia is D21 + D22 + D23 in the master city map; D26 is Port Said - Damietta, a DIFFERENT city
// of one area — which is why the city rule could never reach it and the return's Port Said half
// simply vanished.
const DAKAHLIA = ["D21", "D22", "D23"] as const;
const AREA_NAMES: Record<string, string> = {
  D21: "Dakahlia 1",
  D22: "Dakahlia 2",
  D23: "Dakahlia 3",
  D26: "Port Said - Damietta",
};
const PRODUCTS = [
  { family: "Anti Infective", productCode: "RO001", productName: "Royafloxacin" },
  { family: "Anti Infective", productCode: "SA001", productName: "Sanofur" },
];

// The real customer. `للتجارة` is one of the six store keywords (customer-channel.ts), so this name
// really does classify as a wholesaler — the fixture exercises the classification rather than
// assuming it, and a test using an invented name would pass for the wrong reason.
const REUNION_CODE = "441164";
const REUNION_NAME = "ريونيون للتجارةوالاستثمار";
const WHOLESALER_NAME = "مخزن المنصورة";
const PHARMACY_NAME = "صيدلية النور";

type RowSpec = {
  id: number;
  /** Brick/master-resolved area — what `areaCode` carries after loadMonthlyClosingDetails. */
  resolvedArea: string;
  /** The area the source fact row itself carries — where a hand-split is actually written. */
  factArea: string;
  clientCode: string;
  clientName: string;
  productCode: string;
  qty: number;
  salesValue: number;
};

function detailRow(spec: RowSpec): ClosingDetailRow {
  const product = PRODUCTS.find((entry) => entry.productCode === spec.productCode)!;
  return {
    areaCode: spec.resolvedArea,
    // True on the 441164 rows and honestly so: the sheet says one area and the brick says another.
    // That flag is the closing's existing "these two disagree" signal, and it is exactly the
    // condition under which the resolved area cannot answer "did a human split this".
    areaMismatch: spec.factArea.toUpperCase() !== spec.resolvedArea.toUpperCase(),
    areaName: AREA_NAMES[spec.resolvedArea] ?? spec.resolvedArea,
    blockCode: "",
    bonusQty: 0,
    // The one brick, deliberately: the hand-split never re-pointed it, which is the whole defect.
    brickId: spec.clientCode === REUNION_CODE ? "B186-1" : `B-${spec.resolvedArea}`,
    brickName: spec.clientCode === REUNION_CODE ? "المنصورة" : `${spec.resolvedArea} brick`,
    brickUnmapped: false,
    clientAddress: "",
    clientCode: spec.clientCode,
    clientName: spec.clientName,
    discount: 0,
    distributorCode: "IS-S",
    effectiveUnits: spec.qty,
    exclusions: [],
    factoryPrice: spec.salesValue / spec.qty,
    family: product.family,
    id: spec.id,
    includedInClosing: true,
    invoiceDate: `${PERIOD}-15`,
    invoicePeriod: PERIOD,
    isConfidential: false,
    isDirect: false,
    missingClientCode: false,
    officialLine: LINE,
    productCode: spec.productCode,
    productName: product.productName,
    qty: spec.qty,
    regionCode: "D2",
    regionName: "Delta 2",
    rowNumber: spec.id,
    salesValue: spec.salesValue,
    sheetAreaCode: spec.factArea,
    sheetAreaName: AREA_NAMES[spec.factArea] ?? spec.factArea,
    sheetRegionCode: "D2",
    sheetRegionName: "Delta 2",
    sheetValue: spec.salesValue,
    validationState: "valid",
  };
}

// The four live rows, to the piastre: batch 332747f9 rows 722 / 918 → D22, new rows 953 / 954 → D26,
// each -100 units, all four still on brick B186-1 (master area D21).
const REUNION_ROWS: ClosingDetailRow[] = [
  { factArea: "D22", productCode: "SA001", salesValue: -11_115 },
  { factArea: "D22", productCode: "RO001", salesValue: -6_075 },
  { factArea: "D26", productCode: "RO001", salesValue: -6_075 },
  { factArea: "D26", productCode: "SA001", salesValue: -11_115 },
].map((spec, index) => detailRow({
  clientCode: REUNION_CODE,
  clientName: REUNION_NAME,
  factArea: spec.factArea,
  id: 900 + index,
  productCode: spec.productCode,
  qty: -100,
  // The brick's master area, NOT the fact area — this is the line the defect lived on.
  resolvedArea: "D21",
  salesValue: spec.salesValue,
}));

// A genuine wholesaler in the same city, nobody has apportioned: it MUST still split three ways.
// Without it a passing test could mean "the split was disabled", which is not the fix.
const WHOLESALER_ROW = detailRow({
  clientCode: "W900",
  clientName: WHOLESALER_NAME,
  factArea: "D21",
  id: 800,
  productCode: "RO001",
  qty: 300,
  resolvedArea: "D21",
  salesValue: 90_000,
});

// One pharmacy per area so every area carries a number of its own to compare against.
const PHARMACY_ROWS: ClosingDetailRow[] = ["D21", "D22", "D23", "D26"].map((area, index) => detailRow({
  clientCode: `P${area}`,
  clientName: PHARMACY_NAME,
  factArea: area,
  id: 700 + index,
  productCode: "RO001",
  qty: 100,
  resolvedArea: area,
  salesValue: 10_000,
}));

const MONTH_ROWS: ClosingDetailRow[] = [WHOLESALER_ROW, ...PHARMACY_ROWS, ...REUNION_ROWS];

/** Totals straight off the fixture, so the expected figures below cannot drift from the rows. */
const REUNION_QTY = REUNION_ROWS.reduce((sum, row) => sum + row.qty, 0);
const REUNION_VALUE = REUNION_ROWS.reduce((sum, row) => sum + row.salesValue, 0);

function detailsFor(rows: ClosingDetailRow[]): ClosingDetailsResult {
  return {
    availableLines: [LINE],
    availablePeriods: [PERIOD],
    canRevealConfidential: false,
    confidentialIncluded: false,
    filteredRowCount: rows.length,
    line: LINE,
    options: buildFilterOptions(rows),
    outOfScope: false,
    page: 1,
    pageSize: Math.max(1, rows.length),
    period: PERIOD,
    reconciliation: {
      areaMismatches: summarize(rows, (row) => row.areaMismatch),
      excludedConfidential: summarize(rows, (row) => row.isConfidential),
      excludedDirect: summarize(rows, (row) => row.isDirect),
      includedInClosing: summarize(rows, (row) => row.includedInClosing),
      missingClientCode: summarize(rows, (row) => row.missingClientCode),
      unmappedBricks: summarize(rows, (row) => row.brickUnmapped),
    },
    rows,
    totals: summarize(rows, () => true),
  };
}

function cell(salesUnits: number, salesValue: number): MonthlyClosingCell {
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

/**
 * The area × product matrix the closing RPC would return.
 *
 * Built from each row's FACT area, because that is what phx_monthly_closing_matrix does — verified
 * against live production on this very customer (D22 and D26 carry the negatives; D21 does not).
 * Modelling it from the resolved area instead would hide the defect: the whole failure is that the
 * split subtracts a customer's money from an area the matrix never credited it to.
 */
function fullMatrix(): MonthlyClosingMatrix {
  const areas = ["D21", "D22", "D23", "D26"].map((code) => {
    const own = MONTH_ROWS.filter((row) => row.sheetAreaCode === code);
    const cells = PRODUCTS.map((product) => {
      const forProduct = own.filter((row) => row.productCode === product.productCode);
      return cell(
        forProduct.reduce((sum, row) => sum + row.qty, 0),
        forProduct.reduce((sum, row) => sum + row.salesValue, 0),
      );
    });
    return {
      areaCode: code,
      areaName: AREA_NAMES[code],
      cells,
      kind: "area" as const,
      regionCode: "D2",
      regionName: "Delta 2",
      rowTotal: cell(
        cells.reduce((sum, entry) => sum + entry.salesUnits, 0),
        cells.reduce((sum, entry) => sum + entry.salesValue, 0),
      ),
    };
  });
  const grandCells = PRODUCTS.map((_product, index) => cell(
    areas.reduce((sum, area) => sum + area.cells[index]!.salesUnits, 0),
    areas.reduce((sum, area) => sum + area.cells[index]!.salesValue, 0),
  ));
  const grand = cell(
    grandCells.reduce((sum, entry) => sum + entry.salesUnits, 0),
    grandCells.reduce((sum, entry) => sum + entry.salesValue, 0),
  );
  return {
    availableLines: [LINE],
    availablePeriods: [PERIOD],
    columns: PRODUCTS,
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: grand },
    line: LINE,
    period: PERIOD,
    regions: [{
      areas,
      regionCode: "D2",
      regionName: "Delta 2",
      subtotal: { cells: grandCells, kind: "regionSubtotal", regionCode: "D2", regionName: "Delta 2", rowTotal: grand },
    }],
  } as unknown as MonthlyClosingMatrix;
}

function comparisonFor(rows: ClosingDetailRow[]) {
  const areaCodes = [...new Set(rows.map((row) => row.areaCode))];
  return assembleComparison({
    brickRows: rows.map((row) => ({
      areaCode: row.areaCode, brickId: row.brickId, distributorCode: "IS-S",
      regionCode: "D2", units: row.qty, value: row.salesValue,
    })),
    customerRows: rows.map((row) => ({
      areaCode: row.areaCode, brickId: row.brickId, clientCode: row.clientCode, clientName: row.clientName,
      distributorCode: "IS-S", regionCode: "D2", units: row.qty, value: row.salesValue,
    })),
    distProductRows: rows.map((row) => ({
      areaCode: row.areaCode, distributorCode: "IS-S", productCode: row.productCode, productName: row.productName,
      regionCode: "D2", units: row.qty, value: row.salesValue,
    })),
    line: LINE,
    maps: {
      areaName: new Map(Object.entries(AREA_NAMES)),
      areaRegion: new Map(Object.keys(AREA_NAMES).map((code) => [code, "D2"])),
      distributorName: new Map([["IS-S", "Ibn Sina"]]),
      regionName: new Map([["D2", "Delta 2"]]),
    },
    masterAreas: areaCodes.map((code) => ({ areaCode: code, areaName: AREA_NAMES[code] ?? code, regionCode: "D2" })),
    masterBricks: [...new Set(rows.map((row) => row.brickId))].map((brickId) => ({
      areaCode: rows.find((row) => row.brickId === brickId)!.areaCode,
      brickId,
      brickName: brickId,
      regionCode: "D2",
    })),
    period: PERIOD,
  });
}

/** What the export route does, through the same domain functions it calls. */
async function exportWorkbook(areaCodes: string[]) {
  const matrix = areaCodes.length > 0
    ? filterMonthlyClosingMatrix(fullMatrix(), { areaCodes })
    : fullMatrix();
  const scopedAreaCodes = areaCodes.length > 0
    ? matrix.regions.flatMap((region) => region.areas.map((area) => area.areaCode))
    : [];
  const monthRows = detailsFor(MONTH_ROWS);
  const { details, net } = prepareClosingStoreSplit(monthRows, scopedAreaCodes);
  const { applied, matrix: workbookMatrix } = applyStoreSplitToMatrix(matrix, net);
  const buffer = await buildMonthlyClosingWorkbook(workbookMatrix, comparisonFor(details.rows), details, {
    filterNote: areaCodes.length > 0 ? `Filtered export — Area: ${areaCodes.join(", ")}.` : undefined,
    storeSplitApplied: applied,
    storeSplitRows: monthRows.rows,
    storeSplitScopeAreaCodes: scopedAreaCodes,
  });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  return { applied, book, matrix: workbookMatrix };
}

/** One area's value for one product on the produced matrix. */
function areaProductValue(matrix: MonthlyClosingMatrix, areaCode: string, productCode: string): number | undefined {
  const index = PRODUCTS.findIndex((product) => product.productCode === productCode);
  return matrix.regions
    .flatMap((region) => region.areas)
    .find((area) => area.areaCode === areaCode)
    ?.cells[index]?.salesValue;
}

function areaTotalValue(matrix: MonthlyClosingMatrix, areaCode: string): number | undefined {
  return matrix.regions
    .flatMap((region) => region.areas)
    .find((area) => area.areaCode === areaCode)
    ?.rowTotal.salesValue;
}

/** Every client code the Store Split Detail sheet claims was redistributed. */
function splitDetailClientCodes(book: ExcelJS.Workbook): Set<string> {
  const sheet = book.getWorksheet("Store Split Detail");
  assert.ok(sheet, "the workbook has a Store Split Detail sheet");
  const codes = new Set<string>();
  sheet.eachRow((row) => {
    row.eachCell((entry) => {
      const value = String(entry.value ?? "").trim();
      if (value === REUNION_CODE || value === "W900") codes.add(value);
    });
  });
  return codes;
}

/** Data rows + direct + store split − headline, off the produced file. Must be zero. */
function reconciliationGap(book: ExcelJS.Workbook): number {
  const sheet = book.getWorksheet("Total");
  assert.ok(sheet, "the workbook has a Total sheet");
  const numeric = (value: unknown): number => {
    if (typeof value === "number") return value;
    if (value && typeof value === "object" && "result" in value) {
      return Number((value as { result?: unknown }).result ?? 0) || 0;
    }
    return Number(value ?? 0) || 0;
  };
  const rowStartingWith = (prefix: string): number => {
    let found = 0;
    sheet.eachRow((row) => {
      if (String(row.getCell(1).value ?? "").startsWith(prefix)) found = numeric(row.getCell(3).value);
    });
    return found;
  };
  return rowStartingWith("Data sheet —")
    + rowStartingWith("+ Direct orders")
    + rowStartingWith("Store split")
    - rowStartingWith("Closing Matrix grand total");
}

export async function runClosingStoreSplitHonoursManualSplitTests() {
  // ── The detector reads the ORIGINAL allocation, not the brick-resolved one ──
  //
  // Every one of these four rows carries areaCode D21. A detector reading that field sees one area
  // and exempts nobody, which is precisely why the shipped fix changed no exported number.
  assert.deepEqual(
    [...new Set(REUNION_ROWS.map((row) => row.areaCode))],
    ["D21"],
    "the fixture reproduces the live shape: brick B186-1 resolves all four rows to Dakahlia 1",
  );
  assert.deepEqual(
    [...new Set(REUNION_ROWS.map((row) => row.sheetAreaCode))].sort(),
    ["D22", "D26"],
    "and the hand-split lives on the fact rows, which is the only place it was ever written",
  );
  const exempt = customersAlreadySplitAcrossAreas(MONTH_ROWS);
  assert.ok(
    exempt.has(REUNION_CODE),
    "441164 was apportioned across two areas by hand, so the city rule must not touch it",
  );
  assert.equal(exempt.has("W900"), false, "a wholesaler nobody apportioned is still fair game");

  // ── The split itself: 441164 passes through byte-for-byte, the wholesaler still splits ──
  const split = splitStoreSalesAcrossCityAreas(MONTH_ROWS);
  const reunionOut = split.rows.filter((row) => row.clientCode === REUNION_CODE);
  assert.equal(reunionOut.length, REUNION_ROWS.length, "441164 keeps its four rows — none is fanned out");
  assert.deepEqual(
    [...new Set(reunionOut.map((row) => row.sheetAreaCode))].sort(),
    ["D22", "D26"],
    "and they stay on Dakahlia 2 and Port Said - Damietta, never redistributed to D21/D22/D23",
  );
  // THE OWNER'S TWO NUMBERS, straight off the rows the export will write.
  assert.equal(
    reunionOut.reduce((sum, row) => sum + row.qty, 0),
    REUNION_QTY,
    "the return is still -400 units in total",
  );
  assert.equal(REUNION_QTY, -400, "and the fixture really is the owner's -400");
  assert.equal(
    Number(reunionOut.reduce((sum, row) => sum + row.salesValue, 0).toFixed(2)),
    REUNION_VALUE,
    "the return is still -34,380.00 in total",
  );
  assert.equal(REUNION_VALUE, -34_380, "and the fixture really is the owner's -34,380.00");
  // Per fact area: half each, exactly as the owner ruled.
  for (const area of ["D22", "D26"]) {
    const forArea = reunionOut.filter((row) => row.sheetAreaCode === area);
    assert.equal(
      Number(forArea.reduce((sum, row) => sum + row.salesValue, 0).toFixed(2)),
      -17_190,
      `${AREA_NAMES[area]} keeps its half of the return`,
    );
    assert.equal(forArea.reduce((sum, row) => sum + row.qty, 0), -200, `${AREA_NAMES[area]} keeps -200 units`);
  }
  // No movement may mention 441164's money at all: every movement is the wholesaler's 90,000.
  const movedOut = split.movements.reduce((sum, movement) => sum + movement.outValue, 0);
  assert.equal(Number(movedOut.toFixed(2)), 90_000, "only the un-apportioned wholesaler's sale moves");
  assert.equal(split.splitRowCount, 1, "exactly one row was redistributed — the wholesaler's");

  // Conservation, the invariant the whole rule rests on.
  assert.equal(
    Number(split.rows.reduce((sum, row) => sum + row.salesValue, 0).toFixed(2)),
    Number(MONTH_ROWS.reduce((sum, row) => sum + row.salesValue, 0).toFixed(2)),
    "the split never creates or destroys value",
  );
  assert.equal(
    Number(split.rows.reduce((sum, row) => sum + row.qty, 0).toFixed(6)),
    Number(MONTH_ROWS.reduce((sum, row) => sum + row.qty, 0).toFixed(6)),
    "nor units",
  );

  // ── The Store Split Detail sheet must describe the SAME operation as the matrix ──
  const detail = detailStoreSplitByCustomer(MONTH_ROWS);
  assert.equal(
    detail.some((entry) => entry.clientCode === REUNION_CODE),
    false,
    "the detail sheet must not report a split the matrix did not perform",
  );
  assert.ok(detail.some((entry) => entry.clientCode === "W900"), "but it still reports the real one");

  // ── The real export, unfiltered ──
  const whole = await exportWorkbook([]);
  // THE HEADLINE ASSERTION. Before the fix Dakahlia 1 carried 48,100.00 of RO001 — its own 100,000
  // less the wholesaler's 60,000 AND less 441164's phantom -12,150 redistribution.
  assert.equal(
    areaProductValue(whole.matrix, "D21", "RO001"),
    40_000,
    "Dakahlia 1 loses only the wholesaler's two thirds — 441164's return was never its money to lose",
  );
  // The purest tell: D21 sold no SA001 at all, so the split must not conjure a cell there. Before
  // the fix this read +14,820.00 — a positive number invented out of somebody else's return.
  assert.equal(
    areaProductValue(whole.matrix, "D21", "SA001"),
    0,
    "and no SA001 appears in Dakahlia 1, which never sold any",
  );
  assert.equal(
    areaProductValue(whole.matrix, "D23", "RO001"),
    40_000,
    "Dakahlia 3 receives its share of the wholesaler and NOT a third of a return it had no part in",
  );
  assert.equal(
    areaProductValue(whole.matrix, "D23", "SA001"),
    0,
    "Dakahlia 3 gets none of the SA001 return either",
  );
  // Port Said is a one-area city, so nothing may move in or out of it.
  assert.equal(
    areaTotalValue(whole.matrix, "D26"),
    3_925 - 11_115,
    "Port Said - Damietta keeps its half of the return in full — a different city, untouched",
  );
  assert.equal(
    areaProductValue(whole.matrix, "D22", "SA001"),
    -11_115,
    "Dakahlia 2 keeps its half of the SA001 return exactly as the owner allocated it",
  );
  // The wholesaler still splits: this is what stops the fix degenerating into "disable the rule".
  assert.equal(
    areaProductValue(whole.matrix, "D22", "RO001"),
    33_925,
    "Dakahlia 2 still receives its 30,000 third of the genuine wholesaler on top of its own rows",
  );
  assert.deepEqual(whole.applied, { qty: 0, value: 0 }, "an unfiltered export has nothing crossing its edge");
  assert.equal(reconciliationGap(whole.book), 0, "and the Total sheet still reproduces the headline exactly");
  assert.deepEqual(
    [...splitDetailClientCodes(whole.book)],
    ["W900"],
    "the produced FILE names the wholesaler as split and never 441164",
  );

  // The grand total cannot move: every share stays inside one city and one product.
  assert.equal(
    Number(whole.matrix.grandTotal.rowTotal.salesValue.toFixed(2)),
    Number(MONTH_ROWS.reduce((sum, row) => sum + row.salesValue, 0).toFixed(2)),
    "no sales value is created or lost by the export",
  );

  // ── Place narrowing must select rows by the area the CLOSING books them against ──
  //
  // The SECOND half of the same root cause, and it is not about the split at all. The Closing Matrix
  // groups by the fact area; the detail rows carry the brick-resolved one. Narrowing on the resolved
  // area put all -34,380.00 on the Data sheet of a Dakahlia 1 workbook whose Matrix holds none of it,
  // and left it OFF a Dakahlia 2 workbook whose Matrix holds half — the Total sheet's Difference row
  // broke in both directions. These three figures are exactly what the Matrix carries per area.
  for (const [area, expected] of [["D21", 0], ["D22", -17_190], ["D26", -17_190]] as const) {
    const narrowed = prepareClosingStoreSplit(detailsFor(MONTH_ROWS), [area]).details.rows
      .filter((row) => row.clientCode === REUNION_CODE);
    assert.equal(
      Number(narrowed.reduce((sum, row) => sum + row.salesValue, 0).toFixed(2)),
      expected,
      `a workbook narrowed to ${AREA_NAMES[area]} carries exactly the 441164 money its Closing Matrix does`,
    );
  }

  // ── Filtered exports must reach the same conclusion ──
  //
  // The exemption is computed from the WHOLE month inside prepareClosingStoreSplit. Were it ever
  // computed from the narrowed rows, filtering to Dakahlia 2 would hide the Port Said half, 441164
  // would look single-area again, and the filtered workbook would re-split it while the unfiltered
  // one did not — one customer, two different answers in two downloads of the same month.
  for (const area of DAKAHLIA) {
    const filtered = await exportWorkbook([area]);
    assert.equal(
      reconciliationGap(filtered.book),
      0,
      `a workbook filtered to ${AREA_NAMES[area]} still ties to its own headline`,
    );
    assert.equal(
      splitDetailClientCodes(filtered.book).has(REUNION_CODE),
      false,
      `filtering to ${AREA_NAMES[area]} must not make 441164 look un-apportioned`,
    );
    assert.equal(
      areaProductValue(filtered.matrix, area, "RO001"),
      areaProductValue(whole.matrix, area, "RO001"),
      `${AREA_NAMES[area]} carries the SAME RO001 number filtered as unfiltered`,
    );
    assert.equal(
      areaProductValue(filtered.matrix, area, "SA001"),
      areaProductValue(whole.matrix, area, "SA001"),
      `${AREA_NAMES[area]} carries the SAME SA001 number filtered as unfiltered`,
    );
  }

  // ── A caller with no fact area behaves exactly as before ──
  //
  // summariseStoreSplitByArea and the store-split unit tests hand over rows that carry no
  // sheetAreaCode at all. Those must fall back to the resolved area rather than silently detecting
  // nothing, or the exemption would evaporate for every caller outside the closing export.
  const withoutFactArea = MONTH_ROWS.map(({ sheetAreaCode: _sheetAreaCode, ...row }) => row);
  assert.equal(
    customersAlreadySplitAcrossAreas(withoutFactArea).has(REUNION_CODE),
    false,
    "with no fact area there is nothing to detect, and the resolved view honestly shows one area",
  );
  const spreadOnResolved = MONTH_ROWS.map((row, index) => (
    row.clientCode === REUNION_CODE ? { ...row, areaCode: index % 2 === 0 ? "D21" : "D22" } : row
  ));
  assert.ok(
    customersAlreadySplitAcrossAreas(spreadOnResolved).has(REUNION_CODE),
    "a customer spread across areas by BRICK resolution stays exempt — the union keeps every "
      + "exemption the resolved-area check already granted",
  );
}
