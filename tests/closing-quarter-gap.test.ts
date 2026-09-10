import assert from "node:assert/strict";

import JSZip from "jszip";

import { buildClosingEngineFill } from "../src/lib/sales/closing-engine-data.ts";
import { fillClosingEngine } from "../src/lib/sales/closing-engine-fill.ts";
import { EXECUTIVE_GEOMETRY, EXECUTIVE_TAB_COLOURS } from "../src/lib/sales/closing-executive-look.ts";
import { buildClosingPerformanceReview } from "../src/lib/sales/closing-performance-review.ts";
import {
  buildClosingQuarterGapRows,
  closingQuarterGapMonths,
  closingQuarterLabel,
  foldQuarterTargets,
} from "../src/lib/sales/closing-quarter-gap.ts";
import {
  QUARTER_GAP_BAND,
  QUARTER_GAP_SHEET,
  QUARTER_GAP_WIDTHS,
  buildQuarterGapSheet,
} from "../src/lib/sales/closing-quarter-gap-sheet.ts";
import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingColumn,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GAP TO QUARTER TARGET — the premium workbook's quarter tab.
//
// The workbook is a MONTH; the targets are a QUARTER. That mismatch is the whole sheet, and it is
// also where every way of getting it wrong produces a plausible number rather than an error:
//
//   1. A QUARTER TARGET THAT ONLY COUNTS THE CLOSED MONTHS. The obvious simplification is to sum
//      the target cells already sitting on the merged quarter matrix — one source instead of two,
//      and correct-looking. But an unclosed month has NO matrix, so its target silently becomes
//      zero and the gap comes out short by a third of a quarter. Nothing about the sheet looks
//      wrong; it just under-states what is left to sell.
//
//   2. SALES THAT RUN PAST THE MONTH ON THE COVER. The mirror mistake: folding in every uploaded
//      month of the quarter, so a July workbook shows August's sales in its "sold so far" column
//      while every other tab says July.
//
//   3. THE GROUPING TURNED BACK ROUND. The sheet is grouped BY PRODUCT (owner, 2026-09-10), and
//      that is what makes its unit columns legal: a block is one product code from its bar to its
//      last area, so the units are the same pack counted over areas and months. Group by area
//      instead and the summary row spans seventeen concentrations, which is not a quantity. The
//      line total is the only row that spans products and the only one with no units.
//
//   4. A MISSING TARGET TREATED AS ZERO, which turns "nobody asked this of them" into a gap equal
//      to the whole sale and an achievement of 0%.
//
// The second half verifies the EMITTED WORKBOOK rather than the builder's return value, because a
// sheet can be built perfectly and still reach the reader unregistered, unlinked, grey-tabbed, on a
// bare white masthead, with its bars striped over, or with its percentage column formatted as
// money — every one of which is invisible from the source.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const COLUMNS: MonthlyClosingColumn[] = [
  { family: "Tebofortin", productCode: "TB001", productName: "Tebofortin 40mg" },
  { family: "Tebofortin", productCode: "TB002", productName: "Tebofortin 80mg" },
];

/** The engine's own number formats: s43 is `#,##0;-#,##0;"—"`, s44 is `0.0%`. */
const MONEY_STYLE = "43";
const PERCENT_STYLE = "44";

function cell(salesUnits: number, salesValue: number): MonthlyClosingCell {
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

function total(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  let salesUnits = 0;
  let salesValue = 0;
  for (const entry of cells) {
    salesUnits += entry.salesUnits;
    salesValue += entry.salesValue;
  }
  return { achievement: null, salesUnits, salesValue, targetUnits: null, targetValue: null };
}

function areaRow(
  regionCode: string,
  regionName: string,
  areaCode: string,
  areaName: string,
  cells: MonthlyClosingCell[],
): MonthlyClosingAreaRow {
  return { areaCode, areaName, cells, kind: "area", regionCode, regionName, rowTotal: total(cells) };
}

/**
 * Two areas on one region. Cairo 2 sells NOTHING all quarter and still carries a target — the row a
 * reader of this sheet is looking for, and the one an "only rows with sales" shortcut would drop.
 */
function quarterMatrix(period: string, areas: MonthlyClosingAreaRow[]): MonthlyClosingMatrix {
  const grandCells = COLUMNS.map((_column, index) => total(areas.map((row) => row.cells[index]!)));
  return {
    availableLines: ["CNS"],
    availablePeriods: ["2026-07", "2026-08", "2026-09"],
    columns: COLUMNS,
    grandTotal: { cells: grandCells, kind: "grandTotal", rowTotal: total(grandCells) },
    line: "CNS",
    period,
    regions: [
      {
        areas,
        regionCode: "CA",
        regionName: "Cairo",
        subtotal: {
          cells: COLUMNS.map((_column, index) => total(areas.map((row) => row.cells[index]!))),
          kind: "regionSubtotal",
          regionCode: "CA",
          regionName: "Cairo",
          rowTotal: total(grandCells),
        },
      },
    ],
  };
}

/** One month's rows as `loadMonthlyTargets` hands them back. */
function targetRow(areaCode: string, productCode: string, units: number, value: number) {
  return { areaCode, lineCode: "cns", productCode, targetUnits: units, targetValue: value };
}

function findRow(
  sheetRows: ReturnType<typeof buildClosingQuarterGapRows>,
  product: string,
  area: string,
) {
  const found = sheetRows.find((row) => row.productName === product && row.areaName === area);
  assert.ok(found, `no row for ${product} / ${area} — the fixture and the assertion disagree`);
  return found!;
}

/** One row of a sheet part, cell by cell, as `{ column: { style, text } }`. */
function readRow(sheetXml: string, rowNumber: number): Record<string, { style: string; text: string }> {
  const row = new RegExp(`<row[^>]*r="${rowNumber}"[^>]*>([\\s\\S]*?)</row>`).exec(sheetXml);
  const out: Record<string, { style: string; text: string }> = {};
  if (!row) return out;
  // The self-closing alternative FIRST: a `[^>]*>` pattern eats the slash and then runs on to the
  // next cell's `</c>`, which reads every column one place to the left.
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

/** The `<row>` open tag, so its outline level can be read. */
function rowTag(sheetXml: string, rowNumber: number): string {
  return new RegExp(`<row\\b[^>]*?\\br="${rowNumber}"[^>]*?>`).exec(sheetXml)?.[0] ?? "";
}

export async function runClosingQuarterGapTests() {
  assert.equal(closingQuarterLabel("2026-08"), "Q3 2026");
  assert.equal(closingQuarterLabel("2026-01"), "Q1 2026", "January opens the first quarter, not the fourth");

  // ── 0. THE TWO MONTH LISTS ARE DIFFERENT LISTS ──────────────────────────────────────────────
  // Everything else on this sheet rests on it. One list runs the target and one runs the sold
  // columns, and collapsing them to one is the simplification that looks like tidying up.
  const august2026 = closingQuarterGapMonths("2026-08");
  assert.deepEqual(
    august2026.months,
    ["2026-07", "2026-08", "2026-09"],
    "the target spans the whole CALENDAR quarter, September included — that is the figure the sheet is for",
  );
  assert.deepEqual(
    august2026.salesMonths,
    ["2026-07", "2026-08"],
    "sold stops at the month on the cover — a July workbook must never show August's sales",
  );
  assert.deepEqual(
    closingQuarterGapMonths("2026-07").salesMonths,
    ["2026-07"],
    "the first month of a quarter counts itself and nothing else",
  );
  assert.deepEqual(
    closingQuarterGapMonths("2026-12").months,
    ["2026-10", "2026-11", "2026-12"],
    "December closes Q4 — a rolling three months back would be a span matching no plan and no payout",
  );

  // ── The fixture ─────────────────────────────────────────────────────────────────────────────
  // Q3 2026, read as at AUGUST. July and August are closed; September is not, and carries a target
  // only. Cairo 1 sells both products; Cairo 2 sells nothing and is targeted on one.
  const july = quarterMatrix("2026-07", [
    areaRow("CA", "Cairo", "CA1", "Cairo 1", [cell(100, 5_000), cell(40, 3_000)]),
    areaRow("CA", "Cairo", "CA2", "Cairo 2", [cell(0, 0), cell(0, 0)]),
  ]);
  const august = quarterMatrix("2026-08", [
    areaRow("CA", "Cairo", "CA1", "Cairo 1", [cell(120, 6_000), cell(60, 4_000)]),
    areaRow("CA", "Cairo", "CA2", "Cairo 2", [cell(0, 0), cell(0, 0)]),
  ]);
  // What the loader hands the builder: July and August folded, September absent from the sales side.
  const quarterToDate = quarterMatrix("2026-08", [
    areaRow("CA", "Cairo", "CA1", "Cairo 1", [cell(220, 11_000), cell(100, 7_000)]),
    areaRow("CA", "Cairo", "CA2", "Cairo 2", [cell(0, 0), cell(0, 0)]),
  ]);

  const targets = foldQuarterTargets(
    [
      { period: "2026-07", rows: [targetRow("CA1", "TB001", 100, 5_000), targetRow("CA2", "TB001", 10, 500)] },
      { period: "2026-08", rows: [targetRow("CA1", "TB001", 100, 5_000), targetRow("CA2", "TB001", 10, 500)] },
      // September: no closing, target only. This month is the whole point of the sheet.
      { period: "2026-09", rows: [targetRow("CA1", "TB001", 100, 5_000), targetRow("CA2", "TB001", 10, 500)] },
      // Another line's rows arrive in the same read and must not be counted.
      { period: "2026-08", rows: [{ ...targetRow("CA1", "TB001", 999, 999_999), lineCode: "pedia" }] },
    ],
    "cns",
  );

  const rows = buildClosingQuarterGapRows(quarterToDate, targets);

  // ── 1. THE SHEET IS GROUPED BY PRODUCT, BAR THEN AREAS ──────────────────────────────────────
  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.productName}:${row.areaName}`),
    [
      "product:Tebofortin 40mg:All areas",
      "area:Tebofortin 40mg:Cairo 1",
      "area:Tebofortin 40mg:Cairo 2",
      "product:Tebofortin 80mg:All areas",
      "area:Tebofortin 80mg:Cairo 1",
      "lineTotal:All products:All areas",
    ],
    "a product opens its own block and its areas follow it — grouping by area instead makes every summary row span concentrations",
  );

  // ── 2. UNITS ARE REAL ON EVERY ROW BUT THE LAST ─────────────────────────────────────────────
  // A block is one product code, so its units are the same pack counted over areas and months. The
  // line total is the one row that spans products, and its unit cells are blank rather than 0 —
  // the engine's money format prints null as an em dash and 0 as "0", which reads as "sold none".
  const product40 = findRow(rows, "Tebofortin 40mg", "All areas");
  assert.equal(product40.kind, "product");
  assert.equal(product40.salesUnits, 220, "one product code summed over its areas IS a quantity");
  assert.equal(product40.targetUnits, 330, "and so is its target — Cairo 1's 300 plus Cairo 2's 30");
  assert.equal(product40.gapUnits, 110, "so the bar can state a unit gap");
  assert.equal(product40.family, "Tebofortin", "the bar carries the family the closing groups it under");

  const lineTotal = rows.at(-1)!;
  assert.equal(lineTotal.kind, "lineTotal");
  assert.equal(lineTotal.salesUnits, null, "the line total spans products — units are never added across them");
  assert.equal(lineTotal.targetUnits, null, "and neither are target units");
  assert.equal(lineTotal.gapUnits, null, "so there is no unit gap to state either");
  assert.equal(lineTotal.salesValue, 18_000, "value spans concentrations safely, and is each block counted once");
  assert.equal(lineTotal.gapValue, -1_500, "a negative gap is a line already past its quarter target");

  // ── 3. THE TARGET IS THE WHOLE QUARTER, INCLUDING THE MONTH WITH NO CLOSING ──────────────────
  // Three months at 5,000 each. Summing only the two months that HAVE a matrix gives 10,000 and a
  // gap of −1,000, which reads as "already past target" on an area that is 4,000 short.
  const cairoOne = findRow(rows, "Tebofortin 40mg", "Cairo 1");
  assert.equal(cairoOne.targetValue, 15_000, "all three months of the quarter are targeted");
  assert.equal(cairoOne.targetUnits, 300, "in units too");
  assert.equal(cairoOne.salesValue, 11_000, "July plus August");
  assert.equal(cairoOne.gapValue, 4_000, "gap is target minus sold — positive is still to sell");
  assert.equal(cairoOne.gapUnits, 80);
  assert.equal(
    Number(cairoOne.achievement!.toFixed(4)),
    Number((11_000 / 15_000).toFixed(4)),
    "achievement is sold over the WHOLE quarter's target",
  );

  // The other line's 999,999 must not have reached any of it.
  assert.ok(
    rows.every((row) => (row.targetValue ?? 0) < 100_000),
    "a target row from another line was counted — the read returns every line at once",
  );

  // ── 4. AN AREA WITH A TARGET AND NO SALES IS EXACTLY THE ROW A READER WANTS ──────────────────
  const cairoTwo = findRow(rows, "Tebofortin 40mg", "Cairo 2");
  assert.equal(cairoTwo.salesValue, 0);
  assert.equal(cairoTwo.targetValue, 1_500, "three months at 500");
  assert.equal(cairoTwo.gapValue, 1_500, "the whole quarter is still to sell");
  assert.equal(cairoTwo.achievement, 0, "sold nothing against a real target is 0%, which is true");

  // ── 5. NO TARGET IS NOT A ZERO TARGET ───────────────────────────────────────────────────────
  // Tebofortin 80mg is sold and untargeted. A zero here would state a gap of −7,000 and an
  // achievement of some number, both of which accuse or credit against something nobody asked.
  const untargeted = findRow(rows, "Tebofortin 80mg", "Cairo 1");
  assert.equal(untargeted.salesValue, 7_000);
  assert.equal(untargeted.targetValue, null, "no target row means no target, never 0");
  assert.equal(untargeted.gapValue, null, "and so there is no gap to state");
  assert.equal(untargeted.achievement, null, "and no achievement — never 0%");

  // A pair with neither a sale nor a target is not a finding and is left off entirely.
  assert.equal(
    rows.some((row) => row.productName === "Tebofortin 80mg" && row.areaName === "Cairo 2"),
    false,
    "a product with nothing sold and nothing owed in an area puts a row of dashes on the sheet",
  );

  // ── 6. EACH MONTH'S TARGETS FOLD BY THAT MONTH'S OWN MERGE RULES ────────────────────────────
  // Pedia folds Fayoum (GZ6) and Beni Suef (UE9) into one row UP TO August and separates them from
  // September. Folding the whole quarter by one month's rules either invents a merged row September
  // does not have, or splits an August one that was published merged.
  const pediaFold = foldQuarterTargets(
    [
      { period: "2026-08", rows: [{ ...targetRow("UE9", "TB001", 10, 1_000), lineCode: "pedia" }] },
      { period: "2026-09", rows: [{ ...targetRow("UE9", "TB001", 10, 1_000), lineCode: "pedia" }] },
    ],
    "pedia",
  );
  assert.equal(
    pediaFold.get("GZ6 TB001")?.targetValue,
    1_000,
    "August's Beni Suef target belongs on the merged Fayoum - Beni Suef row",
  );
  assert.equal(
    pediaFold.get("UE9 TB001")?.targetValue,
    1_000,
    "and September's stays on Beni Suef's own row, which the closing shows separately from then",
  );

  // ── 7. THE SHEET ITSELF ─────────────────────────────────────────────────────────────────────
  const sheet = buildQuarterGapSheet(
    {
      months: ["2026-07", "2026-08", "2026-09"],
      monthsCounted: ["2026-07", "2026-08"],
      monthsMissing: [],
      quarterLabel: "Q3 2026",
      rows,
      through: "2026-08",
    },
    { line: "CNS", period: "2026-08" },
  );
  assert.ok(sheet, "the tab must be built when there are rows for it");
  assert.equal(sheet!.name, QUARTER_GAP_SHEET);
  assert.equal(sheet!.headers.length, 11);
  assert.equal(sheet!.headers[0], "Product", "product is the outer grouping, so it leads");
  assert.equal(sheet!.headers.at(-1), "Achievement", "the filler picks the percent format off this word alone");
  assert.equal(sheet!.grouped, true, "the areas fold under their product bar");
  assert.deepEqual(
    sheet!.rowKinds,
    ["group", "detail", "detail", "group", "detail", "total"],
    "the bars have to be declared, or the filler dresses and folds the wrong rows",
  );
  assert.notEqual(sheet!.band, "Performance review", "the quarter is not part of the review's band");
  assert.match(sheet!.subtitle, /positive number is still to sell/, "the gap's sign has to be stated, not inferred");
  assert.match(sheet!.subtitle, /through Aug 2026/, "and which month the sold columns count through");

  // The masthead band is drawn to the width of the LAST column named in the geometry table. A table
  // that stops short of the sheet paints a band that stops short, with the mark past the end of its
  // own colour — so the two lists are the same list.
  const geometry = EXECUTIVE_GEOMETRY[QUARTER_GAP_SHEET];
  assert.ok(geometry, "the tab has no geometry entry, so it gets no navy masthead and no white mark");
  assert.deepEqual(
    Object.keys(geometry!.cols).map((key) => geometry!.cols[Number(key)]),
    QUARTER_GAP_WIDTHS,
    "the geometry table and the sheet's own widths have drifted apart",
  );

  assert.equal(
    buildQuarterGapSheet(null, { line: "CNS", period: "2026-08" }),
    null,
    "no quarter, no tab — a promised page holding nothing reads as a number that failed to load",
  );

  const missingMonth = buildQuarterGapSheet(
    {
      months: ["2026-07", "2026-08", "2026-09"],
      monthsCounted: ["2026-08"],
      monthsMissing: ["2026-07"],
      quarterLabel: "Q3 2026",
      rows,
      through: "2026-08",
    },
    { line: "CNS", period: "2026-08" },
  );
  assert.match(
    missingMonth!.subtitle,
    /Jul 2026 has no closing yet/,
    "a quarter to date short a month must say so — the sold column is otherwise silently low",
  );

  // ── 8. THE EMITTED WORKBOOK ─────────────────────────────────────────────────────────────────
  // Everything above passes on a sheet that never reaches the reader. These are the ways it can be
  // built correctly and still arrive wrong, none of which is visible from the source.
  const review = buildClosingPerformanceReview({
    availableLines: ["CNS"],
    availablePeriods: ["2026-07", "2026-08"],
    generatedAt: "2026-09-01T09:00:00.000Z",
    matrix: august,
    seatAssignments: new Map(),
    seriesMatrices: [
      { matrix: july, period: "2026-07" },
      { matrix: august, period: "2026-08" },
    ],
  });
  const book = await fillClosingEngine(
    buildClosingEngineFill({ matrix: august, priorMatrix: july, review }),
    { reviewSheets: [sheet!] },
  );
  const zip = await JSZip.loadAsync(book);
  const workbook = await zip.file("xl/workbook.xml")!.async("string");

  const tag = (workbook.match(/<sheet\b[^>]*\/?>/g) ?? []).find((one) =>
    one.includes(`name="${QUARTER_GAP_SHEET}"`),
  );
  assert.ok(tag, "the tab is not registered in the workbook — it was built and never reached the file");

  const relationships = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const relId = /\br:id="([^"]*)"/.exec(tag!)?.[1];
  const target = new RegExp(`Id="${relId}"[^>]*Target="([^"]*)"`).exec(relationships)?.[1];
  const part = target ? zip.file(target.startsWith("xl/") ? target : `xl/${target}`) : null;
  assert.ok(part, "the tab's relationship resolves to no part");
  const sheetXml = await part!.async("string");

  const headings = readRow(sheetXml, 4);
  assert.equal(headings.A?.text, "Product", "the tab is showing another sheet's headings");
  assert.equal(headings.K?.text, "Achievement");

  // THE MASTHEAD. `addReviewSheets` writes A1 alone; `paintExecutiveBands` is what fills the row out
  // to the full width in the approved navy. One cell on row 1 means the tab shipped on bare white
  // while every sibling wore the band.
  const masthead = readRow(sheetXml, 1);
  assert.equal(
    Object.keys(masthead).length,
    QUARTER_GAP_WIDTHS.length,
    "row 1 was never painted out to the width of the sheet — the tab is on a bare white masthead",
  );
  assert.equal(
    new Set(Object.values(masthead).map((one) => one.style)).size,
    1,
    "and the band is one fill from end to end, or it reads as a navy block beside a white one",
  );

  // THE BARS AND THE ROWS UNDER THEM. Row 5 is the first product bar, row 6 the first area under it.
  const bar = readRow(sheetXml, 5);
  const detail = readRow(sheetXml, 6);
  assert.equal(bar.A?.text, "Tebofortin 40mg");
  assert.equal(detail.C?.text, "Cairo 1");
  assert.equal(detail.F?.style, MONEY_STYLE, "a detail row's value column must carry the engine's money format");
  assert.equal(detail.K?.style, PERCENT_STYLE, "and achievement the percentage — 0.73 prints as 1 otherwise");
  assert.notEqual(
    bar.F?.style,
    detail.F?.style,
    "the product bar is dressed exactly like the rows it summarises — the blocks do not read as blocks",
  );
  assert.notEqual(
    bar.K?.style,
    bar.A?.style,
    "the bar's achievement is on its text format, so a ratio prints as 0.67 instead of 66.7%",
  );

  // THE FOLD. Areas carry the outline level; the bar above them stays at level 0, which is what
  // makes it the summary rather than part of what it summarises.
  assert.match(rowTag(sheetXml, 6), /outlineLevel="1"/, "the area rows do not fold under their product");
  assert.doesNotMatch(rowTag(sheetXml, 5), /outlineLevel=/, "the bar folded itself away with its own areas");
  assert.match(
    sheetXml,
    /<outlinePr[^>]*summaryBelow="0"/,
    "without this every minus sign in the margin collapses the block AFTER the one it points at",
  );

  // THE ZEBRA. A conditional format beats a cell's own fill, so a range covering the bars paints
  // every second one pale blue.
  const stripe = /<conditionalFormatting sqref="([^"]*)">/.exec(sheetXml)?.[1] ?? "";
  assert.ok(stripe, "the tab carries no zebra — every other sheet with rows has one");
  assert.deepEqual(
    stripe.split(" "),
    ["A6:K7", "A9:K9"],
    "the stripe has to skip the bars and the total, or the blocks stop reading as blocks",
  );

  // The tab strip. An unmatched name is not an error — it is a grey tab among eighteen coloured
  // ones, which is exactly what the strip exists to prevent.
  assert.ok(
    EXECUTIVE_TAB_COLOURS.has(QUARTER_GAP_SHEET),
    "the palette does not know this tab's name — the constant and the map have drifted apart",
  );
  assert.match(sheetXml, /<sheetPr[^>]*><tabColor rgb="FF[0-9A-F]{6}"\/>/, "and the colour has to reach the sheet");

  // The contents page: its own band, and reachable from it. The page prints its band headings
  // upper-cased, so the comparison is too.
  const contentsTag = (workbook.match(/<sheet\b[^>]*\/?>/g) ?? []).find((one) => one.includes('name="Contents"'));
  const contentsRel = /\br:id="([^"]*)"/.exec(contentsTag ?? "")?.[1];
  const contentsTarget = new RegExp(`Id="${contentsRel}"[^>]*Target="([^"]*)"`).exec(relationships)?.[1];
  const contents = await zip
    .file(contentsTarget!.startsWith("xl/") ? contentsTarget! : `xl/${contentsTarget}`)!
    .async("string");
  assert.ok(
    contents.toUpperCase().includes(QUARTER_GAP_BAND.toUpperCase()),
    "the contents page must carry the quarter's own heading",
  );
  assert.ok(
    contents.includes(`HYPERLINK(&quot;#'${QUARTER_GAP_SHEET}'!A1&quot;`)
      || contents.includes(`HYPERLINK("#'${QUARTER_GAP_SHEET}'!A1"`),
    "and the tab must be reachable from it",
  );
}
