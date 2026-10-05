import assert from "node:assert/strict";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { buildClosingEngineFill } from "../src/lib/sales/closing-engine-data.ts";
import { fillClosingEngine } from "../src/lib/sales/closing-engine-fill.ts";
import { EXECUTIVE_TAB_COLOURS } from "../src/lib/sales/closing-executive-look.ts";
import {
  CLOSING_MATRIX_NO_OFFICE_BAND,
  CLOSING_MATRIX_NO_OFFICE_SHEET,
  matrixWithoutOffice,
} from "../src/lib/sales/closing-matrix-without-office.ts";
import { buildClosingNoOfficeSheet } from "../src/lib/sales/closing-no-office-sheet.ts";
import { relabelConsolidatedWorkbook } from "../src/lib/sales/closing-consolidated.ts";
import { buildClosingPerformanceReview } from "../src/lib/sales/closing-performance-review.ts";
import { buildMonthlyClosingWorkbook } from "../src/lib/sales/monthly-closing-export.ts";
import type { ClosingExportData, MonthlyClosingComparison } from "../src/lib/sales/monthly-closing-comparison.ts";
import type {
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLOSING MATRIX (NO OFFICE) — the tab the owner asked for on 2026-10-05, in both workbooks.
//
// "Only in CNS ... you will add another tab, which will follow the closing matrix. Will be exactly
// as the closing matrix, but without the office ... in the premium and in the normal xlsx monthly
// closing."
//
// Office is 41% of the CNS closing (42,838 of 105,152 units, July 2026) and it is the company's own
// stock, spread over the areas by the value-share golden rule rather than sold to anybody. Every way
// of taking it out again produces a plausible grid rather than an error, which is what this file is
// for:
//
//   1. TARGETS REDUCED WITH THE SALES. The tempting symmetry, and it destroys the sheet's only
//      reason to exist: scale the target down by the same share and the achievement comes out
//      IDENTICAL to the closing's, so the tab answers nothing while looking right.
//
//   2. SUBTOTALS COPIED INSTEAD OF RE-DERIVED. Subtract from the area rows and carry the region
//      subtotal through, and every bar on the sheet still carries its Office money — a block whose
//      total is larger than the rows under it add to.
//
//      Its mirror is the COMPANY total: the matrix's bottom line is the grand total plus Direct –
//      National, so re-deriving the grand total and keeping the old company total leaves the two
//      bottom rows disagreeing by exactly the Office share.
//
//   3. THE OFFICE GRID READ POSITIONALLY. It is built by running the matrix builder over the
//      Office-only cells, so a month whose Office file carries fewer products than the line has
//      columns comes back SHORTER — and subtracting by column index then takes one product's Office
//      units out of another product's sales.
//
//   4. AN OFFICE GRID THAT WAS NEVER NARROWED THE SAME WAY. Under a row-level filter the normal
//      export deliberately passes the WHOLE month's Office grid, because the Office aggregate
//      carries no customer and no distributor for such a filter to match. Subtracting that from a
//      narrowed matrix prints NEGATIVE sales.
//
// The last two sections verify the EMITTED WORKBOOKS rather than the builders' return values,
// because the tab can be built perfectly and still arrive in the wrong place, grey-tabbed, missing
// from the contents page, with a percentage column formatted as money, or — the one that reaches
// paper — with every print area attached to the wrong sheet because a tab was inserted mid-strip.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const RISPADEX: MonthlyClosingColumn = { family: "CNS", productCode: "RX001", productName: "Rispadex" };
const TEBO: MonthlyClosingColumn = { family: "CNS", productCode: "TB001", productName: "Tebofortin" };

function cell(salesUnits: number, salesValue: number, targetValue: number | null = null): MonthlyClosingCell {
  return {
    achievement: targetValue === null || targetValue === 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits: targetValue === null ? null : targetValue / 100,
    targetValue,
  };
}

function sum(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  const targets = cells.filter((one) => one.targetValue !== null);
  return cell(
    cells.reduce((total, one) => total + one.salesUnits, 0),
    cells.reduce((total, one) => total + one.salesValue, 0),
    targets.length === 0 ? null : targets.reduce((total, one) => total + (one.targetValue ?? 0), 0),
  );
}

function areaRow(
  regionCode: string,
  regionName: string,
  areaCode: string,
  areaName: string,
  cells: MonthlyClosingCell[],
) {
  return {
    areaCode,
    areaName,
    cells,
    kind: "area" as const,
    regionCode,
    regionName,
    rowTotal: sum(cells),
  };
}

/**
 * A two-region, two-product CNS month with a national Direct row — the shape every bottom row of the
 * Closing Matrix exists on, so the re-derivation of each one is actually exercised.
 */
function buildCnsMatrix(): MonthlyClosingMatrix {
  const cairo = areaRow("CA", "Cairo", "CA1", "Cairo 1", [cell(100, 50_000, 40_000), cell(60, 18_000, 20_000)]);
  const giza = areaRow("CA", "Cairo", "GZ1", "Giza 1", [cell(40, 20_000, 25_000), cell(20, 6_000, null)]);
  const delta = areaRow("D1", "Delta (1)", "D11", "Tanta", [cell(30, 15_000, 10_000), cell(10, 3_000, 5_000)]);

  const cairoSubtotal = [sum([cairo.cells[0]!, giza.cells[0]!]), sum([cairo.cells[1]!, giza.cells[1]!])];
  const deltaSubtotal = [delta.cells[0]!, delta.cells[1]!];
  const grandCells = [sum([cairoSubtotal[0]!, deltaSubtotal[0]!]), sum([cairoSubtotal[1]!, deltaSubtotal[1]!])];
  const directCells = [cell(5, 2_500), cell(0, 0)];
  const companyCells = [sum([grandCells[0]!, directCells[0]!]), sum([grandCells[1]!, directCells[1]!])];

  return {
    availableLines: ["CNS"],
    availablePeriods: ["2026-09"],
    columns: [RISPADEX, TEBO],
    companyTotal: { cells: companyCells, kind: "grandTotal", rowTotal: sum(companyCells) },
    directNational: {
      cells: directCells,
      kind: "regionSubtotal",
      regionCode: "NATIONAL",
      regionName: "Direct – National",
      rowTotal: sum(directCells),
    },
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: sum(grandCells) },
    line: "CNS",
    period: "2026-09",
    regions: [
      {
        areas: [cairo, giza],
        regionCode: "CA",
        regionName: "Cairo",
        subtotal: { cells: cairoSubtotal, kind: "regionSubtotal", regionCode: "CA", regionName: "Cairo", rowTotal: sum(cairoSubtotal) },
      },
      {
        areas: [delta],
        regionCode: "D1",
        regionName: "Delta (1)",
        subtotal: { cells: deltaSubtotal, kind: "regionSubtotal", regionCode: "D1", regionName: "Delta (1)", rowTotal: sum(deltaSubtotal) },
      },
    ],
  };
}

/**
 * The Office slice of that month — and DELIBERATELY only one product, in the opposite order to the
 * matrix's columns. That is the shape a real Office file produces whenever it carries fewer products
 * than the line has, and it is what catches a positional read: `TB001` is the matrix's SECOND
 * column and the Office grid's FIRST.
 */
function buildOfficeSlice(): MonthlyClosingMatrix {
  const cairo = areaRow("CA", "Cairo", "CA1", "Cairo 1", [cell(20, 6_000)]);
  const giza = areaRow("CA", "Cairo", "GZ1", "Giza 1", [cell(5, 1_500)]);
  const delta = areaRow("D1", "Delta (1)", "D11", "Tanta", [cell(4, 1_200)]);
  const cairoSubtotal = [sum([cairo.cells[0]!, giza.cells[0]!])];
  const grandCells = [sum([cairoSubtotal[0]!, delta.cells[0]!])];
  return {
    availableLines: ["CNS"],
    availablePeriods: ["2026-09"],
    columns: [TEBO],
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: sum(grandCells) },
    line: "CNS",
    period: "2026-09",
    regions: [
      {
        areas: [cairo, giza],
        regionCode: "CA",
        regionName: "Cairo",
        subtotal: { cells: cairoSubtotal, kind: "regionSubtotal", regionCode: "CA", regionName: "Cairo", rowTotal: sum(cairoSubtotal) },
      },
      {
        areas: [delta],
        regionCode: "D1",
        regionName: "Delta (1)",
        subtotal: { cells: [delta.cells[0]!], kind: "regionSubtotal", regionCode: "D1", regionName: "Delta (1)", rowTotal: sum([delta.cells[0]!]) },
      },
    ],
  };
}

function buildComparison(): MonthlyClosingComparison {
  const distProduct: ClosingExportData["distProduct"] = [
    { areaCode: "CA1", areaName: "Cairo 1", distributorCode: "IS-S", distributorName: "Ibn Sina", productCode: "RX001", productName: "Rispadex", regionCode: "CA", regionName: "Cairo", units: 100, value: 50_000 },
    { areaCode: "GZ1", areaName: "Giza 1", distributorCode: "IS-S", distributorName: "Ibn Sina", productCode: "RX001", productName: "Rispadex", regionCode: "CA", regionName: "Cairo", units: 40, value: 20_000 },
    { areaCode: "D11", areaName: "Tanta", distributorCode: "IS-S", distributorName: "Ibn Sina", productCode: "RX001", productName: "Rispadex", regionCode: "D1", regionName: "Delta (1)", units: 30, value: 15_000 },
  ];
  return {
    areaByDistributor: [],
    avgPrice: [],
    byDistributor: [],
    coverage: [],
    data: {
      areaByDist: [],
      bricks: [],
      customers: [],
      distProduct,
      masterAreas: [
        { areaCode: "CA1", areaName: "Cairo 1", regionName: "Cairo" },
        { areaCode: "GZ1", areaName: "Giza 1", regionName: "Cairo" },
        { areaCode: "D11", areaName: "Tanta", regionName: "Delta (1)" },
      ],
      masterBricks: [],
      productByDist: [],
    },
    distributors: [{ code: "IS-S", name: "Ibn Sina" }],
    insights: [],
    line: "CNS",
    mix: { distributor: [], product: [], region: [] },
    national: { areaCount: 3, customerCount: 0, productCount: 2, units: 260, value: 112_000 },
    pareto: { customers: { rows: [], share: 0, topValue: 0, total: 0 } },
    period: "2026-09",
    productByDistributor: [],
    rankings: { areas: [], bricks: [], customers: [], products: [], regions: [] },
    regionByDistributor: [],
    totalAreas: 3,
    totalBricks: 0,
    whiteSpace: { productGaps: [], singleDistributorAreas: [], zeroSalesAreas: [], zeroSalesBricks: [] },
  };
}

/** One cell of a worksheet part, by reference, with the style index it carries. */
function readRow(sheetXml: string, rowNumber: number): Record<string, { style: string; text: string }> {
  const row = new RegExp(`<row[^>]*r="${rowNumber}"[^>]*>([\\s\\S]*?)</row>`).exec(sheetXml);
  const out: Record<string, { style: string; text: string }> = {};
  if (!row) return out;
  // The self-closing alternative FIRST: a `[^>]*>` pattern eats the slash and runs on to the next
  // cell's `</c>`, which reads every column one place to the left.
  for (const match of row[1]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)\/>|<c r="([A-Z]+)\d+"([^>]*?)>([\s\S]*?)<\/c>/g)) {
    const column = match[1] ?? match[3]!;
    const attrs = match[2] ?? match[4] ?? "";
    const body = match[5] ?? "";
    const text = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((one) => one[1]).join("");
    out[column] = {
      style: /\bs="(\d+)"/.exec(attrs)?.[1] ?? "",
      text: text || /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] || "",
    };
  }
  return out;
}

export async function runClosingMatrixNoOfficeTests() {
  const matrix = buildCnsMatrix();
  const office = buildOfficeSlice();
  const reduced = matrixWithoutOffice(matrix, office);

  // ── 1. THE CELLS, AND THE PRODUCT CODE THE OFFICE WAS MATCHED ON ────────────────────────────
  const cairo = reduced.regions[0]!.areas[0]!;
  assert.equal(cairo.cells[0]!.salesUnits, 100, "Rispadex carries no Office in this month and must be untouched");
  assert.equal(cairo.cells[0]!.salesValue, 50_000);
  assert.equal(
    cairo.cells[1]!.salesUnits,
    40,
    "Tebofortin's 60 units less its 20 of Office — read positionally the 20 come off Rispadex and this stays 60",
  );
  assert.equal(cairo.cells[1]!.salesValue, 12_000);

  // ── 2. TARGETS STAY, ACHIEVEMENT FALLS ──────────────────────────────────────────────────────
  assert.equal(cairo.cells[1]!.targetValue, 20_000, "the target is what the area was given, Office or no Office");
  assert.equal(cairo.cells[1]!.targetUnits, 200);
  assert.equal(cairo.cells[1]!.achievement, 0.6, "12,000 of 20,000 — the real money over the whole target");
  assert.ok(
    (cairo.cells[1]!.achievement ?? 0) < (matrix.regions[0]!.areas[0]!.cells[1]!.achievement ?? 0),
    "an Office-free achievement that is not LOWER means the target was scaled down with the sales",
  );
  assert.equal(
    reduced.regions[0]!.areas[1]!.cells[1]!.achievement,
    null,
    "an untargeted cell stays unscored — a null target must never become a zero",
  );

  // ── 3. EVERY TOTAL RE-DERIVED FROM THE ROWS THAT SURVIVED ───────────────────────────────────
  assert.equal(reduced.regions[0]!.subtotal.cells[1]!.salesValue, 16_500, "Cairo's Tebofortin: 24,000 less 7,500 of Office");
  assert.equal(reduced.regions[0]!.subtotal.rowTotal.salesValue, 86_500);
  assert.equal(
    reduced.grandTotal.rowTotal.salesValue,
    matrix.grandTotal.rowTotal.salesValue - office.grandTotal.rowTotal.salesValue,
    "the grand total must be the closing's less the whole Office grid, to the piastre",
  );
  assert.equal(
    reduced.grandTotal.cells[1]!.salesUnits,
    90 - 29,
    "and per product in units, where units are legal because the column is one product code",
  );

  // Direct carries no Office, so the Direct row is identical and the company total has to move with
  // the grand total it contains — not stay where the closing left it.
  assert.deepEqual(reduced.directNational!.cells, matrix.directNational!.cells, "Direct – National must not move");
  assert.equal(
    reduced.companyTotal!.rowTotal.salesValue,
    reduced.grandTotal.rowTotal.salesValue + reduced.directNational!.rowTotal.salesValue,
    "the bottom line must equal grand total + Direct, or the last two rows of the sheet disagree",
  );
  assert.ok(
    reduced.companyTotal!.rowTotal.salesValue < matrix.companyTotal!.rowTotal.salesValue,
    "a company total unchanged by the subtraction is the old one carried through",
  );

  // ── 4. NOTHING TO TAKE OUT ──────────────────────────────────────────────────────────────────
  assert.equal(matrixWithoutOffice(matrix, null), matrix, "no Office grid, no change — not an empty grid");

  // ── 5. THE NORMAL WORKBOOK ──────────────────────────────────────────────────────────────────
  const openWorkbook = async (buffer: Buffer) => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0]);
    return book;
  };

  const withTab = await openWorkbook(
    await buildMonthlyClosingWorkbook(matrix, buildComparison(), undefined, {
      office,
      officeNarrowedWithMatrix: true,
    }),
  );
  const names = withTab.worksheets.map((one) => one.name);
  assert.equal(
    names.indexOf(CLOSING_MATRIX_NO_OFFICE_SHEET),
    names.indexOf("Closing Matrix") + 1,
    "the owner asked for the tab that FOLLOWS the closing matrix — anywhere else and the two cannot be read against each other",
  );

  const twin = withTab.getWorksheet(CLOSING_MATRIX_NO_OFFICE_SHEET)!;
  const matrixSheet = withTab.getWorksheet("Closing Matrix")!;
  // The master grid carries "of wh. Office" (8 metrics a product); the twin must not (7), because
  // the whole sheet is the non-Office half and a column of zeroes would be the one figure on it
  // that says nothing.
  const metricRow = (sheet: ExcelJS.Worksheet) =>
    [3, 4, 5, 6, 7, 8, 9, 10].map((column) => String(sheet.getRow(5).getCell(column).value ?? ""));
  assert.ok(metricRow(matrixSheet).includes("of wh. Office"), "the Closing Matrix itself must keep its Office column");
  assert.ok(
    !metricRow(twin).includes("of wh. Office"),
    "the twin must not carry an Office column — it has no Office in it at all",
  );
  assert.ok(
    String(twin.getRow(1).getCell(1).value ?? "").includes("Monthly Closing"),
    "row 1 is the workbook masthead, exactly as on the Closing Matrix beside it",
  );
  assert.ok(
    String(twin.getRow(2).getCell(1).value ?? "").includes(CLOSING_MATRIX_NO_OFFICE_SHEET),
    "the band has to name the tab, or a forwarded screenshot reads as the published closing",
  );

  // Layout with TWO products and no Office column: 1-2 name the row, the Rispadex block is 3-9,
  // Tebofortin 10-16, the Grand Total opens at 17.
  // Collected into an ARRAY rather than a `let … | null`: TypeScript cannot see that a callback ran,
  // so it narrows such a variable to `null` after the loop and `assert.ok` then narrows it to
  // `never` — the whole helper typechecks as unusable while reading perfectly (4 errors, 2026-10-05).
  const findRow = (sheet: ExcelJS.Worksheet, text: string): ExcelJS.Row => {
    const matches: ExcelJS.Row[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (matches.length === 0 && String(row.getCell(2).value ?? "") === text) matches.push(row);
    });
    const found = matches[0];
    assert.ok(found, `the twin must carry a row for "${text}"`);
    return found;
  };
  const cairoRow = findRow(twin, "Cairo 1");
  assert.equal(cairoRow.getCell(10).value, 40, "Tebofortin units on the sheet must be the reduced ones");
  assert.equal(cairoRow.getCell(11).value, 12_000);
  assert.equal(cairoRow.getCell(13).value, 20_000, "and its target must be the whole target");
  assert.equal(cairoRow.getCell(14).value, 0.6);

  // No cell on it may reach the hidden Calc sheet, for exactly the reason the Closing Matrix beside
  // it may not: that sheet holds invoice lines keyed by GEOGRAPHIC region, so any SUMIFS over it
  // recalculates past the organogram grouping, the store split and now the Office subtraction.
  const foreign: string[] = [];
  twin.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (one) => {
      const value = one.value;
      if (typeof value === "object" && value !== null && "formula" in value && String(value.formula).includes("!")) {
        foreign.push(`${one.address}: =${String(value.formula)}`);
      }
    });
  });
  assert.deepEqual(foreign, [], "a cross-sheet formula is a number this workbook can recalculate away from the screen");

  // ── 6. THE TWO WAYS THE NORMAL WORKBOOK MUST NOT CARRY IT ───────────────────────────────────
  const rowLevel = await openWorkbook(
    await buildMonthlyClosingWorkbook(matrix, buildComparison(), undefined, { office }),
  );
  assert.equal(
    rowLevel.getWorksheet(CLOSING_MATRIX_NO_OFFICE_SHEET),
    undefined,
    "without a comparable Office grid the tab must be ABSENT — subtracting the whole month's Office"
      + " from a row-level-filtered matrix prints negative sales",
  );

  const pedia = await openWorkbook(
    await buildMonthlyClosingWorkbook(
      { ...matrix, line: "Pedia" },
      { ...buildComparison(), line: "Pedia" },
      undefined,
      { office, officeNarrowedWithMatrix: true },
    ),
  );
  assert.equal(
    pedia.getWorksheet(CLOSING_MATRIX_NO_OFFICE_SHEET),
    undefined,
    "Office is a CNS-only channel, so no other line may gain a tab that would copy the grid beside it",
  );

  // ── 7. THE PREMIUM TAB, AS A SHEET SPECIFICATION ────────────────────────────────────────────
  assert.equal(buildClosingNoOfficeSheet(matrix, null), null, "no Office grid, no premium tab");
  assert.equal(
    buildClosingNoOfficeSheet({ ...matrix, line: "Pedia" }, office),
    null,
    "and no tab on a line that has no Office channel",
  );

  const sheetSpec = buildClosingNoOfficeSheet(matrix, office, { filterNote: "Filtered export — Cairo only." })!;
  assert.ok(sheetSpec, "the premium tab must be built for a CNS month with an Office slice");
  assert.equal(sheetSpec.name, CLOSING_MATRIX_NO_OFFICE_SHEET);
  assert.equal(sheetSpec.after, "Closing Matrix", "the owner asked for the tab that follows the closing matrix");
  assert.equal(sheetSpec.band, CLOSING_MATRIX_NO_OFFICE_BAND);
  assert.equal(sheetSpec.headers.length, 2 + 2 * 3 + 3, "Region, Area, three columns a product, and the Grand Total triple");
  assert.equal(sheetSpec.headers.length, sheetSpec.widths.length, "a heading with no width inherits the template's and clips");
  assert.deepEqual(
    sheetSpec.headers.slice(2, 5),
    ["Rispadex Sales", "Rispadex Target", "Rispadex Ach"],
    "the premium matrix's own three data fields, named per product",
  );
  assert.ok(
    sheetSpec.headers.every((heading) => !/units/i.test(heading)),
    "no units anywhere: a Grand Total column spans every product code, and units are never added across products",
  );
  assert.equal(sheetSpec.grouped, true, "the areas fold under their region bar");
  assert.deepEqual(
    sheetSpec.rowKinds,
    ["group", "detail", "detail", "group", "detail", "total", "total", "total"],
    "the bars have to be declared, or the filler dresses and folds the wrong rows",
  );
  assert.match(sheetSpec.subtitle, /Targets are NOT reduced/, "the sheet has to say why its achievement is lower");
  assert.match(sheetSpec.subtitle, /Cairo only/, "a filtered workbook's twin must say what slice it covers");

  // ── 8. THE EMITTED PREMIUM WORKBOOK ─────────────────────────────────────────────────────────
  const review = buildClosingPerformanceReview({
    availableLines: ["CNS"],
    availablePeriods: ["2026-09"],
    generatedAt: "2026-10-01T09:00:00.000Z",
    matrix,
    seatAssignments: new Map(),
    seriesMatrices: [{ matrix, period: "2026-09" }],
  });
  const premium = await fillClosingEngine(buildClosingEngineFill({ matrix, review }), {
    reviewSheets: [sheetSpec],
  });
  const zip = await JSZip.loadAsync(premium);
  const workbookXml = await zip.file("xl/workbook.xml")!.async("string");

  const tags = workbookXml.match(/<sheet\b[^>]*\/>/g) ?? [];
  const nameOf = (tag: string) => /\bname="([^"]*)"/.exec(tag)?.[1] ?? "";
  const order = tags.map(nameOf);
  assert.equal(
    order.indexOf(CLOSING_MATRIX_NO_OFFICE_SHEET),
    order.indexOf("Closing Matrix") + 1,
    "the premium tab must sit immediately after the Closing Matrix in the tab strip",
  );

  // 🔴 THE ONE THAT REACHES PAPER. `localSheetId` is a POSITION in the list above, so inserting a
  // tab mid-strip re-attaches every print area, print title and filter range from that point on to
  // the sheet BEFORE it. Nothing about it is visible in any sheet — it surfaces as the wrong rows
  // printing. Every defined name that names its own sheet in its value must still point at it.
  const definedNames = [...workbookXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)];
  let checked = 0;
  for (const [, attrs, value] of definedNames) {
    const localSheetId = /\blocalSheetId="(\d+)"/.exec(attrs!)?.[1];
    if (!localSheetId) continue;
    const referenced = /^'?([^'!]+)'?!/.exec(value!.trim())?.[1];
    if (!referenced) continue;
    assert.equal(
      order[Number(localSheetId)],
      referenced,
      `"${value}" is attached to "${order[Number(localSheetId)]}" — the defined names were not shifted with the inserted tab`,
    );
    checked += 1;
  }
  assert.ok(checked >= 10, `only ${checked} defined names carried a sheet reference — the check proved nothing`);

  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const tag = tags.find((one) => nameOf(one) === CLOSING_MATRIX_NO_OFFICE_SHEET)!;
  const relId = /\br:id="([^"]*)"/.exec(tag)?.[1];
  const target = new RegExp(`Id="${relId}"[^>]*Target="([^"]*)"`).exec(rels)?.[1] ?? "";
  assert.ok(target, "the tab has no relationship in the workbook — nothing to read it from");
  const sheetXml = await zip.file(target.startsWith("xl/") ? target : `xl/${target}`)!.async("string");

  const headings = readRow(sheetXml, 4);
  assert.equal(headings.A?.text, "Region", "the tab is showing another sheet's headings");
  assert.equal(headings.E?.text, "Rispadex Ach");

  const detail = readRow(sheetXml, 6);
  assert.equal(detail.B?.text, "Cairo 1");
  assert.notEqual(detail.E?.style, detail.C?.style, "an achievement column formatted as money prints 0.6 as 1");
  assert.equal(
    detail.E?.style,
    detail.H?.style,
    "every per-product achievement column has to take the same percentage format",
  );
  assert.equal(detail.D?.style, detail.C?.style, "sales and target are both money");

  // The masthead: `addReviewSheets` writes A1 alone and `paintExecutiveBands` fills the row out to
  // the width of the table. A matrix-shaped tab has no entry in EXECUTIVE_GEOMETRY — its width
  // depends on the month — so this is also what proves the width override reached the painter.
  const masthead = readRow(sheetXml, 1);
  assert.equal(
    Object.keys(masthead).length,
    sheetSpec.headers.length,
    "row 1 was never painted out to the width of the sheet — the tab shipped on a bare white masthead",
  );
  assert.equal(
    new Set(Object.values(masthead).map((one) => one.style)).size,
    1,
    "and the band is one fill from end to end, or it reads as a navy block beside a white one",
  );

  assert.ok(
    EXECUTIVE_TAB_COLOURS.has(CLOSING_MATRIX_NO_OFFICE_SHEET),
    "the palette does not know this tab's name — it ships grey among eighteen coloured ones",
  );
  assert.match(sheetXml, /<sheetPr[^>]*><tabColor rgb="FF[0-9A-F]{6}"\/>/, "and the colour has to reach the sheet");

  // The contents page. The tab's band already exists on it, so folding in is the correct behaviour
  // and printing the heading TWICE is the defect.
  const contentsTag = tags.find((one) => nameOf(one) === "Contents")!;
  const contentsRel = /\br:id="([^"]*)"/.exec(contentsTag)?.[1];
  const contentsTarget = new RegExp(`Id="${contentsRel}"[^>]*Target="([^"]*)"`).exec(rels)?.[1] ?? "";
  assert.ok(contentsTarget, "the contents page has no relationship in the workbook");
  const contents = await zip
    .file(contentsTarget.startsWith("xl/") ? contentsTarget : `xl/${contentsTarget}`)!
    .async("string");
  assert.ok(
    contents.includes(`HYPERLINK(&quot;#'${CLOSING_MATRIX_NO_OFFICE_SHEET}'!A1&quot;`)
      || contents.includes(`HYPERLINK("#'${CLOSING_MATRIX_NO_OFFICE_SHEET}'!A1"`),
    "the tab must be reachable from the contents page",
  );
  const bandHits = contents.toUpperCase().split(CLOSING_MATRIX_NO_OFFICE_BAND.toUpperCase()).length - 1;
  assert.equal(
    bandHits,
    1,
    "the band heading is printed twice — an appended tab naming an existing band must fold INTO it",
  );

  // ── 9. THE CONSOLIDATED WORKBOOKS ───────────────────────────────────────────────────────────
  // Owner, 2026-10-05: "add the no-office tab to the consolidated closing export too." A span is
  // where a correctly built twin can still arrive mislabelled, in two different ways.
  //
  // The NORMAL consolidated workbook is written for the latest month and then relabelled in the zip,
  // one literal at a time — so the twin is only covered if its band carries that exact literal. A
  // band reading "Month: 2026-09" over three added months is the whole workbook's known failure
  // mode, and it is why the relabel exists at all.
  const consolidatedBuffer = await buildMonthlyClosingWorkbook(matrix, buildComparison(), undefined, {
    office,
    officeNarrowedWithMatrix: true,
  });
  const relabelled = await relabelConsolidatedWorkbook(consolidatedBuffer, {
    latestPeriod: "2026-09",
    periods: ["2026-08", "2026-09"],
  });
  const spanBook = await openWorkbook(relabelled);
  const spanTwin = spanBook.getWorksheet(CLOSING_MATRIX_NO_OFFICE_SHEET)!;
  assert.ok(spanTwin, "the consolidated workbook must carry the twin — its filter has no row-level field at all");
  const spanBand = String(spanTwin.getRow(2).getCell(1).value ?? "");
  assert.match(spanBand, /Months: /, "the twin's band must be relabelled for the span with every other sheet");
  assert.ok(
    !spanBand.includes("Month: 2026-09"),
    "a span workbook whose twin still says one month invites the sum to be read as that month",
  );
  const spanRow = findRow(spanTwin, "Cairo 1");
  assert.equal(spanRow.getCell(11).value, 12_000, "and relabelling must not move a figure on it");

  // The PREMIUM consolidated passes the span itself, because `mergeMonthlyClosingMatrices` keeps the
  // LATEST month in `period` — so without the label this grid would be headed "Sep 2026" while every
  // figure on it is the sum of the span.
  const spanSpec = buildClosingNoOfficeSheet(matrix, office, { periodLabel: "Jul-Sep 2026" })!;
  assert.match(spanSpec.title, /Jul-Sep 2026/, "the premium twin must head the span it actually sums");
  // Compared against the UNLABELLED build rather than against a month string: "Jul-Sep 2026"
  // CONTAINS "Sep 2026", so a substring check here can never fail and would pin nothing.
  const monthSpec = buildClosingNoOfficeSheet(matrix, office)!;
  assert.notEqual(
    spanSpec.title,
    monthSpec.title,
    "the span label changed nothing — the premium twin would be headed the merged matrix's latest month",
  );
  assert.match(monthSpec.title, /2026/, "and a single-month workbook still heads itself with its own month");
}
