import assert from "node:assert/strict";

import JSZip from "jszip";

import { buildClosingEngineFill } from "../src/lib/sales/closing-engine-data.ts";
import { fillClosingEngine } from "../src/lib/sales/closing-engine-fill.ts";
import { EXECUTIVE_TAB_COLOURS } from "../src/lib/sales/closing-executive-look.ts";
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
//      wrong; it just under-states what is left to sell. Assertion 2.
//
//   2. SALES THAT RUN PAST THE MONTH ON THE COVER. The mirror mistake: folding in every uploaded
//      month of the quarter, so a July workbook shows August's sales in its "sold so far" column
//      while every other tab says July. Assertion 3.
//
//   3. UNITS SUMMED ACROSS PRODUCTS on the area rows — the owner's standing rule, and the one that
//      reads as a perfectly ordinary number. An area row's unit cells are null, and null so they
//      print an em dash rather than a zero, which would say "sold none". Assertion 1.
//
//   4. A MISSING TARGET TREATED AS ZERO, which turns "nobody asked this of them" into a gap equal
//      to the whole sale and an achievement of 0%. Assertion 4.
//
// The second half verifies the EMITTED WORKBOOK rather than the builder's return value, because a
// sheet can be built perfectly and still reach the reader unregistered, unlinked, grey-tabbed, or
// with its percentage column formatted as money — every one of which is invisible from the source.
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

function findRow(sheetRows: ReturnType<typeof buildClosingQuarterGapRows>, area: string, product: string) {
  const found = sheetRows.find((row) => row.areaName === area && row.productName === product);
  assert.ok(found, `no row for ${area} / ${product} — the fixture and the assertion disagree`);
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

  // ── 1. AN AREA ROW CARRIES VALUE ONLY ───────────────────────────────────────────────────────
  // Tebofortin 40mg and 80mg are different packs at different concentrations. Their unit counts do
  // not add up to a quantity, so the area row has none — and null rather than 0, because the
  // engine's money format prints null as an em dash and 0 as "0", which reads as "sold none".
  const cairoOne = findRow(rows, "Cairo 1", "All products");
  assert.equal(cairoOne.kind, "area");
  assert.equal(cairoOne.salesValue, 18_000, "the area's value is the sum of its products");
  assert.equal(cairoOne.salesUnits, null, "units are never added across products — the owner's rule");
  assert.equal(cairoOne.targetUnits, null, "and neither are target units");
  assert.equal(cairoOne.gapUnits, null, "so there is no unit gap to state either");

  const lineTotal = rows.at(-1)!;
  assert.equal(lineTotal.kind, "lineTotal");
  assert.equal(lineTotal.areaName, "All areas");
  assert.equal(lineTotal.salesUnits, null, "the line total spans products too");
  assert.equal(lineTotal.salesValue, 18_000, "and is the sum of the area rows, counted once each");

  // ── 2. THE TARGET IS THE WHOLE QUARTER, INCLUDING THE MONTH WITH NO CLOSING ──────────────────
  // Three months at 5,000 each. Summing only the two months that HAVE a matrix gives 10,000 and a
  // gap of −1,000, which reads as "already past target" on an area that is 4,000 short.
  const cairoOneProduct = findRow(rows, "Cairo 1", "Tebofortin 40mg");
  assert.equal(cairoOneProduct.targetValue, 15_000, "all three months of the quarter are targeted");
  assert.equal(cairoOneProduct.targetUnits, 300, "one product code, so its units DO sum across months");
  assert.equal(cairoOneProduct.salesValue, 11_000, "July plus August");
  assert.equal(cairoOneProduct.gapValue, 4_000, "gap is target minus sold — positive is still to sell");
  assert.equal(cairoOneProduct.gapUnits, 80, "and the same in units, because this row is one product");
  assert.equal(
    Number(cairoOneProduct.achievement!.toFixed(4)),
    Number((11_000 / 15_000).toFixed(4)),
    "achievement is sold over the WHOLE quarter's target",
  );

  // The other line's 999,999 must not have reached any of it.
  assert.ok(
    rows.every((row) => (row.targetValue ?? 0) < 100_000),
    "a target row from another line was counted — the read returns every line at once",
  );

  // ── 3. AN AREA WITH A TARGET AND NO SALES IS EXACTLY THE ROW A READER WANTS ──────────────────
  const cairoTwo = findRow(rows, "Cairo 2", "Tebofortin 40mg");
  assert.equal(cairoTwo.salesValue, 0);
  assert.equal(cairoTwo.targetValue, 1_500, "three months at 500");
  assert.equal(cairoTwo.gapValue, 1_500, "the whole quarter is still to sell");
  assert.equal(cairoTwo.achievement, 0, "sold nothing against a real target is 0%, which is true");

  // ── 4. NO TARGET IS NOT A ZERO TARGET ───────────────────────────────────────────────────────
  // Tebofortin 80mg is sold and untargeted. A zero here would state a gap of −7,000 and an
  // achievement of some number, both of which accuse or credit against something nobody asked.
  const untargeted = findRow(rows, "Cairo 1", "Tebofortin 80mg");
  assert.equal(untargeted.salesValue, 7_000);
  assert.equal(untargeted.targetValue, null, "no target row means no target, never 0");
  assert.equal(untargeted.gapValue, null, "and so there is no gap to state");
  assert.equal(untargeted.achievement, null, "and no achievement — never 0%");

  // A pair with neither a sale nor a target is not a finding and is left off entirely.
  assert.equal(
    rows.some((row) => row.areaName === "Cairo 2" && row.productName === "Tebofortin 80mg"),
    false,
    "a product with nothing sold and nothing owed puts a row of dashes on the sheet",
  );

  // ── 5. EACH MONTH'S TARGETS FOLD BY THAT MONTH'S OWN MERGE RULES ────────────────────────────
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

  // ── 6. THE SHEET ITSELF ─────────────────────────────────────────────────────────────────────
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
  assert.equal(sheet!.headers.length, 10);
  assert.equal(sheet!.headers.at(-1), "Achievement", "the filler picks the percent format off this word alone");
  assert.notEqual(sheet!.band, "Performance review", "the quarter is not part of the review's band");
  assert.match(sheet!.subtitle, /positive number is still to sell/, "the gap's sign has to be stated, not inferred");
  assert.match(sheet!.subtitle, /through Aug 2026/, "and which month the sold columns count through");

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

  // ── 7. THE EMITTED WORKBOOK ─────────────────────────────────────────────────────────────────
  // Everything above passes on a sheet that never reaches the reader. These are the four ways it
  // can be built correctly and still arrive wrong, none of which is visible from the source.
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
  assert.equal(headings.A?.text, "Area", "the tab is showing another sheet's headings");
  assert.equal(headings.J?.text, "Achievement");

  // The formats, read off the CELLS. The filler chooses them from the heading text, so a column
  // renamed for readability quietly reprints a ratio of 0.73 as "1".
  const firstDataRow = readRow(sheetXml, 5);
  assert.equal(firstDataRow.E?.style, MONEY_STYLE, "the value column must carry the engine's money format");
  assert.equal(firstDataRow.J?.style, PERCENT_STYLE, "and achievement the percentage — 0.73 prints as 1 otherwise");
  assert.equal(firstDataRow.D?.text, "", "an area row's unit cell is empty, so it prints a dash and not a zero");

  // The tab strip. An unmatched name is not an error — it is a grey tab among seventeen coloured
  // ones, which is exactly what the strip exists to prevent.
  assert.ok(
    EXECUTIVE_TAB_COLOURS.has(QUARTER_GAP_SHEET),
    "the palette does not know this tab's name — the constant and the map have drifted apart",
  );
  assert.match(sheetXml, /<sheetPr[^>]*><tabColor rgb="FF[0-9A-F]{6}"\/>/, "and the colour has to reach the sheet");

  // The contents page: its own band, and reachable from it.
  const contentsTag = (workbook.match(/<sheet\b[^>]*\/?>/g) ?? []).find((one) => one.includes('name="Contents"'));
  const contentsRel = /\br:id="([^"]*)"/.exec(contentsTag ?? "")?.[1];
  const contentsTarget = new RegExp(`Id="${contentsRel}"[^>]*Target="([^"]*)"`).exec(relationships)?.[1];
  const contents = await zip
    .file(contentsTarget!.startsWith("xl/") ? contentsTarget! : `xl/${contentsTarget}`)!
    .async("string");
  // The page prints its band headings upper-cased, so the comparison is too — matching the literal
  // would pass only by accident of casing and fail the day the page's own styling changes.
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
