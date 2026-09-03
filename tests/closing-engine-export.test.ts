import assert from "node:assert/strict";

import JSZip from "jszip";

import { buildClosingEngineFill, previousPeriod } from "../src/lib/sales/closing-engine-data.ts";
import { fillClosingEngine } from "../src/lib/sales/closing-engine-fill.ts";
import {
  buildClosingPerformanceReview,
  type AreaSeatAssignment,
} from "../src/lib/sales/closing-performance-review.ts";
import { closingFileName } from "../src/lib/sales/closing-export-filename.ts";
import { CLOSING_ENGINE_TEMPLATE_MANIFEST } from "../src/lib/sales/closing-engine-template-generated.ts";
import type { MonthlySourceCoverage, SourceCoverageEntry } from "../src/lib/sales/source-coverage.ts";
import type { ClosingDetailRow } from "../src/lib/sales/monthly-closing-details.ts";
import type {
  MonthlyClosingAreaRow,
  MonthlyClosingCell,
  MonthlyClosingMatrix,
} from "../src/lib/sales/monthly-distributor-import.ts";
import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// The PREMIUM Monthly Closing export — the closing screen's second Export button.
//
// It is the owner's OWN .xlsm engine, filled: his three pivot tables, two Region slicers, the Rep
// Card's INDEX/MATCH and SUMIFS formulas, and his VBA button bar, with a month poured into the
// hidden Data sheet behind them. That is the point of it, and it is what the first attempt got
// wrong — a static rebuild renders the same numbers and loses everything that makes the workbook
// worth sending. So the first thing pinned here is that the machinery survives the fill.
//
// Then the two owner rules that a later layout change silently breaks, because a summed unit column
// and a 0% cell both look perfectly reasonable on screen:
//
//   1. Units of different products are NEVER added. Every total spanning more than one product code
//      is money, and the unit columns on such a row show a dash — not a sum, and not a zero.
//   2. A row with no target reads "no target", never 0%. Printing zero would accuse an area of
//      failing at something nobody asked of it.
//
// And three failures that leave the file perfectly valid, so nothing else in this repo can see
// them: a footnote stranded at last month's row number, colouring cut to last month's row count,
// and a print area attached to a sheet POSITION that a new sheet has since taken.
// ─────────────────────────────────────────────────────────────────────────────

const DASH = String.fromCharCode(0x2014);
const UP = String.fromCharCode(0x25b2);
const DOWN = String.fromCharCode(0x25bc);
const STAR = String.fromCharCode(0x2605);

const PRODUCTS = [
  { family: "Tebofortin", productCode: "TB001", productName: "Tebofortin 40mg" },
  { family: "Tebofortin", productCode: "TB002", productName: "Tebofortin 80mg" },
  { family: "Lacto", productCode: "LA001", productName: "Lacto Advanced" },
];

function cell(salesUnits: number, salesValue: number, targetUnits: number | null, targetValue: number | null): MonthlyClosingCell {
  return {
    achievement: targetValue == null || targetValue <= 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits,
    targetValue,
  };
}

function sum(cells: MonthlyClosingCell[]): MonthlyClosingCell {
  const salesUnits = cells.reduce((total, one) => total + one.salesUnits, 0);
  const salesValue = cells.reduce((total, one) => total + one.salesValue, 0);
  const targeted = cells.filter((one) => one.targetValue != null);
  const targetValue = targeted.length === 0 ? null : targeted.reduce((total, one) => total + (one.targetValue ?? 0), 0);
  const targetUnits = targeted.length === 0 ? null : targeted.reduce((total, one) => total + (one.targetUnits ?? 0), 0);
  return {
    achievement: targetValue == null || targetValue <= 0 ? null : salesValue / targetValue,
    salesUnits,
    salesValue,
    targetUnits,
    targetValue,
  };
}

function area(
  areaCode: string,
  areaName: string,
  regionCode: string,
  regionName: string,
  cells: MonthlyClosingCell[],
): MonthlyClosingAreaRow {
  return { areaCode, areaName, cells, kind: "area", regionCode, regionName, rowTotal: sum(cells) };
}

/**
 * A small closing that carries every shape the sheets have to handle:
 *   Cairo 1   — sells three products, all targeted. Units total 1,250; value totals 820,000. The two
 *               numbers are deliberately nothing like each other, so a row total that quietly summed
 *               units instead of money cannot pass by coincidence.
 *   Cairo 2   — sells, with NO target at all. This is the "no target" row.
 *   Qalubeya  — a second region, so the region grouping has something to group.
 */
function fixtureMatrix(period: string, scale = 1): MonthlyClosingMatrix {
  const cairo1 = area("CA1", "Cairo 1", "CA", "Cairo", [
    cell(1000 * scale, 500_000 * scale, 900, 450_000),
    cell(200 * scale, 300_000 * scale, 250, 375_000),
    cell(50 * scale, 20_000 * scale, 40, 16_000),
  ]);
  const cairo2 = area("CA2", "Cairo 2", "CA", "Cairo", [
    cell(80 * scale, 40_000 * scale, null, null),
    cell(0, 0, null, null),
    cell(10 * scale, 4_000 * scale, null, null),
  ]);
  const qalubeya = area("D11", "Qalubeya", "D1", "Delta (1)", [
    cell(300 * scale, 150_000 * scale, 400, 200_000),
    cell(0, 0, 100, 150_000),
    cell(25 * scale, 10_000 * scale, 20, 8_000),
  ]);

  const regions = [
    { areas: [cairo1, cairo2], regionCode: "CA", regionName: "Cairo" },
    { areas: [qalubeya], regionCode: "D1", regionName: "Delta (1)" },
  ].map((group) => ({
    ...group,
    subtotal: {
      cells: PRODUCTS.map((_, index) => sum(group.areas.map((one) => one.cells[index]!))),
      kind: "regionSubtotal" as const,
      regionCode: group.regionCode,
      regionName: group.regionName,
      rowTotal: sum(group.areas.map((one) => one.rowTotal)),
    },
  }));

  const allAreas = regions.flatMap((group) => group.areas);
  return {
    availableLines: ["CNS"],
    availablePeriods: ["2026-07", "2026-08"],
    columns: PRODUCTS,
    grandTotal: {
      cells: PRODUCTS.map((_, index) => sum(allAreas.map((one) => one.cells[index]!))),
      kind: "grandTotal",
      rowTotal: sum(allAreas.map((one) => one.rowTotal)),
    },
    line: "CNS",
    period,
    regions,
  };
}

const SEATS = new Map<string, AreaSeatAssignment>([
  ["cns::CA1", { managerName: "Hala Fouad", repIsVacant: false, repName: "Mostafa Kamel" }],
  ["cns::CA2", { managerName: "Hala Fouad", repIsVacant: true, repName: null }],
  ["cns::D11", { managerName: "Tarek Selim", repIsVacant: false, repName: "Nour Adel" }],
]);

/**
 * One row of a sheet, cell by cell, as the text or number Excel would show.
 *
 * The self-closing alternative comes FIRST on purpose. `<c r="I4" s="8"/>` is matched by a
 * `[^>]*>` pattern — the `/` is consumed as part of the attribute run — so the capture then runs on
 * to the NEXT cell's `</c>`, and every column letter reads one place to the left. That produced a
 * confidently wrong map of three sheets before it was noticed.
 */
function readRow(sheetXml: string, rowNumber: number): Record<string, string> {
  const row = new RegExp(`<row[^>]*r="${rowNumber}"[^>]*>([\\s\\S]*?)</row>`).exec(sheetXml);
  const out: Record<string, string> = {};
  if (!row) return out;
  for (const match of row[1]!.matchAll(/<c r="([A-Z]+)\d+"[^>]*?\/>|<c r="([A-Z]+)\d+"[^>]*?>([\s\S]*?)<\/c>/g)) {
    const column = match[1] ?? match[2]!;
    const body = match[3] ?? "";
    const text = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((one) => one[1]).join("");
    out[column] = text || /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] || "";
  }
  return out;
}

function rowNumbers(sheetXml: string): number[] {
  return [...sheetXml.matchAll(/<row\b[^>]*?r="(\d+)"/g)].map((one) => Number(one[1]));
}

export async function runClosingEngineExportTests() {
  const july = fixtureMatrix("2026-07");
  const june = fixtureMatrix("2026-06", 0.5);
  const review = buildClosingPerformanceReview({
    availableLines: ["CNS"],
    availablePeriods: ["2026-06", "2026-07"],
    generatedAt: "2026-08-30T12:00:00.000Z",
    matrix: july,
    seatAssignments: SEATS,
    seriesMatrices: [
      { matrix: june, period: "2026-06" },
      { matrix: july, period: "2026-07" },
    ],
  });

  assert.equal(previousPeriod("2026-07"), "2026-06");
  assert.equal(previousPeriod("2026-01"), "2025-12", "January's prior month is last December, not month zero");

  const fill = buildClosingEngineFill({ matrix: july, priorMatrix: june, review });
  const macroBook = await fillClosingEngine(fill, {});
  const plainBook = await fillClosingEngine(fill, { macroFree: true });

  // ── The engine itself survives the fill ─────────────────────────────────────────────────────
  // Everything here is what a static rebuild cannot carry, which is why the first attempt at this
  // export was rejected. A pivot reads its source BY TABLE NAME, so it grows with the month on its
  // own — but only while the table, the cache and the slicer that drives it are all still in the
  // file.
  const zip = await JSZip.loadAsync(macroBook);
  const parts = Object.keys(zip.files);
  assert.equal(parts.filter((name) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(name)).length, 3, "three pivot tables");
  assert.equal(parts.filter((name) => /^xl\/slicers\/slicer\d+\.xml$/.test(name)).length, 2, "both Region slicers");
  assert.equal(parts.filter((name) => /^xl\/slicerCaches\/slicerCache\d+\.xml$/.test(name)).length, 1, "the slicer cache");
  assert.ok(parts.includes("xl/vbaProject.bin"), "the .xlsm keeps the owner's macro buttons");

  // ── The package is one Excel opens without repairing it ────────────────────────────────────
  // Every assertion here is a defect that actually shipped. None of them is visible to any tool in
  // this repository: an empty shared-string table and a folder entry are both schema-VALID, the
  // Open XML SDK validator reported the same twenty pre-existing pageSetup errors before and after,
  // and LibreOffice opened every broken build without complaint. The only symptom is Excel asking
  // the owner whether it should try to recover the file, and the only reason these are pinned here
  // is that nothing else can see them.
  for (const [label, book] of [
    ["xlsm", macroBook],
    ["xlsx", plainBook],
  ] as const) {
    const opened = await JSZip.loadAsync(book);
    const entries = Object.keys(opened.files);
    const present = new Set(entries.filter((name) => !opened.files[name]!.dir));

    // A zip item ending in "/" is not a part and cannot carry a content type. Excel writes none.
    assert.deepEqual(
      entries.filter((name) => opened.files[name]!.dir),
      [],
      `${label}: an OPC package is flat — no directory entries`,
    );

    // Excel omits the shared-string part when a workbook has none; it does not ship an empty one.
    const sharedStrings = opened.file("xl/sharedStrings.xml");
    if (sharedStrings) {
      assert.match(
        await sharedStrings.async("string"),
        /<si\b/,
        `${label}: a shared-string part that holds no strings must be dropped, not shipped empty`,
      );
    }

    // …and dropping it means the override and the relationship go too. Either one left behind
    // points at a part that is not in the zip, which is its own repair prompt.
    const contentTypes = await opened.file("[Content_Types].xml")!.async("string");
    for (const match of contentTypes.matchAll(/PartName="\/([^"]+)"/g)) {
      assert.ok(present.has(match[1]!), `${label}: content type declares ${match[1]} but the part is not in the zip`);
    }
    for (const relsName of [...present].filter((name) => name.endsWith(".rels"))) {
      const base = relsName.slice(0, relsName.lastIndexOf("_rels/"));
      for (const rel of (await opened.file(relsName)!.async("string")).matchAll(/<Relationship\s[^>]*>/g)) {
        if (/TargetMode="External"/.test(rel[0])) continue;
        const target = /Target="([^"]+)"/.exec(rel[0])?.[1];
        if (!target) continue;
        const segments: string[] = [];
        for (const segment of (target.startsWith("/") ? target.slice(1) : base + target).split("/")) {
          if (segment === "..") segments.pop();
          else if (segment !== "." && segment !== "") segments.push(segment);
        }
        assert.ok(present.has(segments.join("/")), `${label}: ${relsName} points at ${segments.join("/")}, which is not in the zip`);
      }
    }
  }

  const plainParts = Object.keys((await JSZip.loadAsync(plainBook)).files);
  assert.ok(!plainParts.includes("xl/vbaProject.bin"), "the .xlsx has no macros in it");
  assert.equal(
    plainParts.filter((name) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(name)).length,
    3,
    "stripping the macros must not strip the pivots — they are what the .xlsx is for",
  );

  // ── No button may outlive the VBA it calls ──────────────────────────────────────────────────
  // Removing vbaProject.bin was not the whole strip: it left 36 shapes across 11 drawings still
  // naming a routine — macro="PhxExportPdf", macro="PhxRegionButton" and the rest — in a package
  // that no longer holds one. Excel answers a macro reference in a macro-free part with "We found
  // a problem with some content in ...", and repairs it by dropping the drawing, so the reader
  // loses the emblem and the button bar anyway after being told his file is damaged. It is
  // schema-VALID, which is why checkWorkbook below passes the broken build too.
  const drawingsOf = async (book: Buffer): Promise<Record<string, string>> => {
    const opened = await JSZip.loadAsync(book);
    const out: Record<string, string> = {};
    for (const file of opened.file(/^xl\/drawings\/drawing\d+\.xml$/)) out[file.name] = await file.async("string");
    return out;
  };
  const wiredButtons = (drawings: Record<string, string>) =>
    Object.values(drawings).reduce((n, xml) => n + (xml.match(/<xdr:sp\b[^>]*\smacro="[^"]+"/g) ?? []).length, 0);

  const macroDrawings = await drawingsOf(macroBook);
  const plainDrawings = await drawingsOf(plainBook);
  assert.ok(wiredButtons(macroDrawings) > 0, "the .xlsm is the build that KEEPS the button bar — it has the VBA");
  assert.equal(wiredButtons(plainDrawings), 0, "a macro-free .xlsx may not name a VBA routine: that IS the repair prompt");

  // The cut is per anchor, not per drawing, and these are what it must leave standing. The emblem
  // rides in its own anchor with an r:embed; the two slicers ride inside an mc:AlternateContent.
  // Cutting a drawing wholesale would take all three, and every sheet would lose its logo.
  assert.equal(
    Object.keys(plainDrawings).length,
    Object.keys(macroDrawings).length,
    "no drawing part may be removed, only anchors inside one",
  );
  for (const [name, xml] of Object.entries(plainDrawings)) {
    assert.match(xml, /r:embed="/, `${name}: the emblem picture must survive the cut`);
    assert.equal(
      (xml.match(/<mc:AlternateContent\b/g) ?? []).length,
      (macroDrawings[name].match(/<mc:AlternateContent\b/g) ?? []).length,
      `${name}: the slicers ride in mc:AlternateContent and must survive the cut`,
    );
  }

  const cacheDefinition = await zip.file("xl/pivotCache/pivotCacheDefinition1.xml")!.async("string");
  assert.match(cacheDefinition, /<worksheetSource[^>]*name="SalesData"/, "the cache reads the TABLE, not a fixed range");
  assert.ok(!/June/.test(cacheDefinition), "no month name may be baked into the cache — it is filled every month");

  // ── Every shared-item index the workbook holds must land inside the cache's pool ─────────────
  //
  // This is the repair prompt the owner hit on 2026-09-02: "We found a problem with some content",
  // on every premium export. The template build empties each `<sharedItems>` (they hold the July
  // CNS values it was cut from) and trusts `refreshOnLoad="1"` to refill them. Excel validates the
  // pivots against the cache FIRST, finds `<item x="49"/>` pointing into an empty pool, removes all
  // three PivotTable parts and calls the file damaged. Measured against Excel itself: the owner's
  // own export is refused every time, the same export with the pool refilled opens clean with all
  // three pivots. The demand is recomputed here from the produced workbook rather than imported
  // from the fill code, so this fails if either half of the pair drifts.
  const partsOf = (xml: string, tag: string): string[] =>
    xml.match(new RegExp(`<${tag}\\b[^>]*?\\/>|<${tag}\\b[^>]*?>[\\s\\S]*?<\\/${tag}>`, "g")) ?? [];

  const cacheFields = partsOf(cacheDefinition, "cacheField");
  assert.equal(cacheFields.length, 16, "the cache still declares all sixteen fields");

  const fieldNames = cacheFields.map((field) => /\bname="([^"]*)"/.exec(field)?.[1] ?? "");
  const poolOf = (field: string): number =>
    ((/<sharedItems\b[^>]*?\/>|<sharedItems\b[^>]*?>[\s\S]*?<\/sharedItems>/.exec(field)?.[0] ?? "").match(
      /<(?:s|n|d|b|e|m)\b[^>]*\/>/g,
    ) ?? []).length;

  const demand = new Map<number, { count: number; from: string }>();
  const claim = (field: number, count: number, from: string) => {
    if (field < 0 || count <= (demand.get(field)?.count ?? 0)) return;
    demand.set(field, { count, from });
  };

  let enumeratedItems = 0;
  for (const name of parts.filter((p) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(p))) {
    const xml = await zip.file(name)!.async("string");
    const block = /<pivotFields\b[^>]*>([\s\S]*?)<\/pivotFields>/.exec(xml)?.[1] ?? "";
    partsOf(block, "pivotField").forEach((field, index) => {
      for (const item of field.matchAll(/<item\b[^>]*\bx="(\d+)"/g)) {
        enumeratedItems += 1;
        claim(index, Number(item[1]) + 1, `${name} pivotField ${index}`);
      }
    });
  }
  for (const name of parts.filter((p) => /^xl\/slicerCaches\/[^/]+\.xml$/.test(p))) {
    const xml = await zip.file(name)!.async("string");
    const field = fieldNames.indexOf(/\bsourceName="([^"]*)"/.exec(xml)?.[1] ?? "");
    for (const item of xml.matchAll(/<i\b[^>]*\bx="(\d+)"/g)) claim(field, Number(item[1]) + 1, name);
  }

  // If this ever reads 0 the check below has gone vacuous — it would pass on a workbook whose
  // pivots had simply been gutted, which is the other way to stop Excel complaining and the one
  // that loses the owner's three views.
  assert.ok(enumeratedItems > 0, "the pivots must still enumerate their items — deleting them is not the fix");
  assert.ok(demand.size > 0, "at least one cache field must be indexed, or this proves nothing");

  for (const [field, { count, from }] of demand) {
    assert.ok(
      poolOf(cacheFields[field]!) >= count,
      `cache field ${field} (${fieldNames[field]}) holds ${poolOf(cacheFields[field]!)} shared items but ${from} indexes ${count} — Excel removes every PivotTable part over this and reports the file as damaged`,
    );
  }

  // The two tables must end where the data ends, or the pivots read blank rows as a category.
  const salesRows = fill.data.salesData.length;
  const tableRef = (xml: string) => /ref="([A-Z]+\d+:[A-Z]+\d+)"/.exec(xml)![1];
  assert.equal(tableRef(await zip.file("xl/tables/table1.xml")!.async("string")), `A1:N${salesRows + 1}`);
  assert.equal(tableRef(await zip.file("xl/tables/table2.xml")!.async("string")), `P1:AA${fill.data.areaBook.length + 1}`);

  for (const [label, bytes] of [["xlsm", macroBook], ["xlsx", plainBook]] as const) {
    const problems = await checkWorkbook(bytes, { quiet: true });
    assert.deepEqual(problems, [], `the ${label} must open without a repair prompt: ${problems.join("; ")}`);
  }

  // ── Owner rule 1: units of different products are never added ───────────────────────────────
  // The Rep Card's total line spans every product on the line, so its two unit columns show the
  // dash. A sum would be 1,250 for Cairo 1 — a number that means nothing, because it adds 40mg
  // tablets to 80mg tablets to a probiotic sachet.
  const repCard = await zip.file("xl/worksheets/sheet3.xml")!.async("string");
  const cardRows = rowNumbers(repCard);
  const totalRow = readRow(repCard, 17 + PRODUCTS.length);
  assert.equal(totalRow.B, "Whole area", "the total line follows the last product row");
  assert.equal(totalRow.C, DASH, "units are not summed across products");
  assert.equal(totalRow.D, DASH, "target units are not summed across products either");
  assert.match(repCard, /SUM\(E17:E19\)/, "the value total re-anchors to the real product block");

  // No presentation sheet may grow a units column at all: every one of them totals across products.
  for (const [sheet, file] of [["Overview", "sheet1"], ["Rep Ranking", "sheet2"], ["Top Achievers", "sheet4"], ["Family Performance", "sheet8"], ["Family by Month", "sheet13"]] as const) {
    const header = Object.values(readRow(await zip.file(`xl/worksheets/${file}.xml`)!.async("string"), 4));
    assert.ok(
      !header.some((label) => /unit/i.test(label)),
      `${sheet} totals across products, so it must carry no units column — found ${header.join(", ")}`,
    );
  }

  // ── Owner rule 2: an area with no target reads "no target", never 0% ────────────────────────
  const repRanking = await zip.file("xl/worksheets/sheet2.xml")!.async("string");
  const ranked = rowNumbers(repRanking).filter((row) => row >= 5).map((row) => readRow(repRanking, row));
  const cairo2 = ranked.find((row) => row.C === "Cairo 2");
  assert.ok(cairo2, "Cairo 2 is listed even though it has no target");
  assert.equal(cairo2!.G, "no target", "its target column says so in words");
  assert.equal(cairo2!.H, "no target", "and so does its achievement column — never 0");
  assert.equal(cairo2!.B, "Vacant seat", "an empty seat is named as one, not left blank");
  assert.equal(cairo2!.F, "44000", "its sales still count, and still total in money");

  const cairo1 = ranked.find((row) => row.C === "Cairo 1");
  // ── The arrow turns at TARGET ───────────────────────────────────────────────────────────────
  // Owner's decision, 2026-09-03: "fix the arrow to only show above target". It used to turn at
  // half, so 97% and 140% carried the same mark and the Watch List -- a page that holds nothing but
  // shortfalls -- printed an up arrow on every row of it. Cairo 1 sits at 97.5%: close, and short.
  assert.equal(cairo1!.I, DOWN, "97% of target is short of target, and the arrow says so");

  // Swept as a rule over every ranked row rather than asserted on one, because the bug was never a
  // single wrong cell -- it was one threshold, applied everywhere.
  for (const row of ranked) {
    const achievement = Number(row.H);
    if (!Number.isFinite(achievement)) continue;
    assert.equal(
      row.I,
      achievement >= 1 ? UP : DOWN,
      `${row.C}: at ${(achievement * 100).toFixed(1)}% the arrow must follow whether the target was MET`,
    );
  }

  // The live Rep Card's arrow is a FORMULA inside the owner's engine, not a value this code writes,
  // so it carries its own copy of the threshold and drifted the moment the constant moved. It is
  // rewritten at fill time from that same constant; this is what proves card and pages agree.
  const repCardXml = await zip.file(CLOSING_ENGINE_TEMPLATE_MANIFEST.sheets["Rep Card"]!.file)!.async("string");
  const arrowFormulas = [...repCardXml.matchAll(/<f[^>]*>(IF\(ISNUMBER\([^<]*)<\/f>/g)].map((match) => match[1]!);
  assert.ok(arrowFormulas.length > 0, "the Rep Card still carries its arrow formula");
  for (const formula of arrowFormulas) {
    assert.doesNotMatch(formula, /&gt;=0\.5/, "no arrow on the card still turns at half of target");
  }
  assert.ok(
    arrowFormulas.some((formula) => /&gt;=1,/.test(formula)),
    "the card's arrow turns at target, the same place every static sheet's does",
  );

  // ── The Rep Card is the sheet a rep is meant to be proud to share ───────────────────────────
  //
  // Owner, 2026-09-03, on the tab he had just tried to send: "the medical rep name should be
  // perfectly perfectly appearing", "never an overflow of the text under the logo", "Don't show
  // codes. Always show names", "as if he's a star". Every assertion below is one of those four,
  // and each one is invisible to every other check in this repository: a caption running under the
  // emblem, a name set in the same 10.5pt as its own label, and a tile printing D16 where a
  // district's name belongs are all perfectly valid OOXML that Excel opens without a murmur.
  const cardStyles = await zip.file("xl/styles.xml")!.async("string");
  const cardXfs = [...(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(cardStyles)?.[1] ?? "").matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((one) => one[0]);
  const cardFonts = [...(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(cardStyles)?.[1] ?? "").matchAll(/<font\b[^>]*?(?:\/>|>[\s\S]*?<\/font>)/g)].map((one) => one[0]);
  /** Point size of whatever a cell is set in, followed through the style table the way Excel does. */
  const pointsAt = (ref: string): number => {
    const style = Number(new RegExp(`<c r="${ref}"[^>]*?\\bs="(\\d+)"`).exec(repCardXml)?.[1] ?? NaN);
    const font = Number(/\bfontId="(\d+)"/.exec(cardXfs[style] ?? "")?.[1] ?? NaN);
    return Number(/<sz val="([\d.]+)"/.exec(cardFonts[font] ?? "")?.[1] ?? NaN);
  };
  const formulaAt = (ref: string): string =>
    new RegExp(`<c r="${ref}"[^>]*>\\s*<f[^>]*>([\\s\\S]*?)</f>`).exec(repCardXml)?.[1] ?? "";

  // 1. The masthead is two lines, and the second one is why the first can never reach the emblem.
  //
  // The card is eight columns and 798px wide, and the logo is anchored at 689px with 16px of slack
  // — so `clearTitleEmblem`, which answers this everywhere else by sliding the emblem right, has
  // nowhere to slide it. Splitting the caption is the only fix that holds, and it holds for a
  // longer line name than Anti Infective too.
  const masthead = readRow(repCardXml, 1).A ?? "";
  const deckLine = readRow(repCardXml, 2).A ?? "";
  assert.match(masthead, /^Rep Card\b/, "the masthead still opens with the sheet's own name");
  assert.match(masthead, /Anti Infective|CNS/, "and still says which line and month it is");
  assert.doesNotMatch(
    masthead,
    /one person, one month/,
    "the descriptive half belongs on row 2 — on row 1 it runs under the SATO PHARMA emblem",
  );
  assert.match(deckLine, /one person, one month, every product/, "and row 2 is where it went");

  // Measured, not assumed: the caption's own advance width against the emblem's own anchor, both in
  // EMU, read out of the produced file. A future caption that grows past the logo fails here rather
  // than in the owner's hands.
  const cardCols = [...(/<cols>[\s\S]*?<\/cols>/.exec(repCardXml)?.[0] ?? "").matchAll(/<col\b[^>]*?\/>/g)].map((one) => ({
    min: Number(/min="(\d+)"/.exec(one[0])?.[1]),
    max: Number(/max="(\d+)"/.exec(one[0])?.[1]),
    width: /hidden="1"/.test(one[0]) ? 0 : Number(/width="([\d.]+)"/.exec(one[0])?.[1] ?? 9.140625),
  }));
  const columnEmu = (index: number): number => {
    const run = cardCols.find((one) => index + 1 >= one.min && index + 1 <= one.max);
    const width = run ? run.width : 9.140625;
    return width > 0 ? (Math.round(width * 7) + 5) * 9525 : 0;
  };
  const cardRels = await zip.file(CLOSING_ENGINE_TEMPLATE_MANIFEST.sheets["Rep Card"]!.file.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels"))!.async("string");
  const cardDrawing = await zip.file(`xl/${/Target="\.\.\/(drawings\/drawing\d+\.xml)"/.exec(cardRels)![1]}`)!.async("string");
  // The emblem is the anchor carrying a picture; the button bar's shapes carry none.
  const emblem = [...cardDrawing.matchAll(/<xdr:(?:twoCell|oneCell)Anchor[\s\S]*?<\/xdr:(?:twoCell|oneCell)Anchor>/g)]
    .find((one) => /<xdr:pic\b/.test(one[0]));
  assert.ok(emblem, "the Rep Card still carries its emblem — the whole masthead is built around it");
  const fromCol = Number(/<xdr:from>[\s\S]*?<xdr:col>(\d+)<\/xdr:col>/.exec(emblem![0])?.[1] ?? NaN);
  const fromOff = Number(/<xdr:from>[\s\S]*?<xdr:colOff>(\d+)<\/xdr:colOff>/.exec(emblem![0])?.[1] ?? 0);
  let emblemLeft = fromOff;
  for (let index = 0; index < fromCol; index += 1) emblemLeft += columnEmu(index);
  const mastheadWidth = masthead.length * 91_500;
  assert.ok(
    mastheadWidth < emblemLeft,
    `the masthead must end before the emblem begins — it runs to ${Math.round(mastheadWidth / 9525)}px and the logo starts at ${Math.round(emblemLeft / 9525)}px`,
  );

  // 2. Names, never codes. The owner's rule, and the tile that broke it said "Area code / D16".
  const cardText = [...repCardXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((one) => one[1]!);
  for (const text of cardText) {
    assert.doesNotMatch(text, /\bcode\b/i, `no visible cell on the card may offer a code — found "${text}"`);
  }
  assert.equal(readRow(repCardXml, 9).F, "District manager", "the third tile is the manager, by name");
  assert.match(formulaAt("F10"), /AreaBook\[District manager\]/, "and it resolves his name, not his area's code");
  assert.match(formulaAt("B10"), /AreaBook\[Area\]/, "the area tile reads the area's name");
  assert.match(formulaAt("D10"), /AreaBook\[Region\]/, "and the region tile the region's");

  // The code itself has to survive out of sight, because it is the key every product row sums on.
  // Removing the tile and removing the lookup look identical on screen for exactly one second.
  assert.match(formulaAt("N2"), /AreaBook\[Area Code\]/, "$N$2 still resolves the area code — hidden, not deleted");
  assert.ok(
    [...repCardXml.matchAll(/<f[^>]*>([\s\S]*?)<\/f>/g)].filter((one) => /SUMIFS\([\s\S]*\$N\$2/.test(one[1]!)).length > 0,
    "and the product rows still key their SUMIFS on it — hiding the code must not gut the card",
  );

  // 3. The name is the hero of the card, which is a measurement, not an opinion: it is set larger
  //    than the money under it and larger than the label above it.
  assert.match(formulaAt("B8"), /AreaBook\[Medical rep\]/, "the hero line is the rep's own name");
  assert.equal(readRow(repCardXml, 7).B, "Medical rep", "with an eyebrow above it saying what it is");
  const heroPoints = pointsAt("B8");
  assert.ok(
    heroPoints > pointsAt("B13") && heroPoints > pointsAt("B7"),
    `the rep's name outsizes both the KPI figures and its own label — ${heroPoints}pt against ${pointsAt("B13")}pt and ${pointsAt("B7")}pt`,
  );

  // 4. The star is first place, and nothing else. A star on every card is not a star.
  const badge = formulaAt("F5");
  assert.match(badge, new RegExp(`AreaBook\\[Rank\\],\\$N\\$1\\)=1,"${STAR} "`), "the star is gated on rank 1");
  assert.equal(
    cardText.filter((text) => text.includes(STAR)).length,
    0,
    "and it is never a fixed piece of text — a card that always says star says nothing",
  );

  // ── The style table's declared counts are its real ones ──────────────────────────────────────
  // The card's polish appends fonts and formats to the workbook's own table. A `count` left behind
  // is how Excel is told to stop reading before the last entry: the file still opens, and the cells
  // using those entries come back unstyled — or the file is repaired and they are dropped. Neither
  // is visible to any other check here, and both land on the sheet this whole section is about.
  for (const [tag, child] of [["fonts", "font"], ["fills", "fill"], ["borders", "border"], ["cellXfs", "xf"]] as const) {
    const block = new RegExp(`<${tag} count="(\\d+)"[^>]*>([\\s\\S]*?)</${tag}>`).exec(cardStyles);
    assert.ok(block, `the workbook still declares its ${tag}`);
    const real = [...block![2]!.matchAll(new RegExp(`<${child}\\b`, "g"))].length;
    assert.equal(Number(block![1]), real, `<${tag} count> must be the number of ${tag} actually there`);
  }

  // ── No two merged regions may overlap ────────────────────────────────────────────────────────
  // The polish reshapes five rows and re-lays their merges. An overlap is the one mistake here that
  // Excel refuses outright — "We found a problem with some content" — and it is trivially made by
  // adding a merge without dropping the one it lands on.
  const mergeBlock = /<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/.exec(repCardXml)?.[0] ?? "";
  const mergeRefs = [...mergeBlock.matchAll(/<mergeCell ref="([^"]+)"/g)].map((one) => one[1]!);
  assert.equal(
    Number(/<mergeCells count="(\d+)"/.exec(mergeBlock)?.[1]),
    mergeRefs.length,
    "the merge count is the number of merges actually written",
  );
  const box = (ref: string) => {
    const [from, to] = ref.split(":");
    const at = (one: string) => {
      const parts = /^([A-Z]+)(\d+)$/.exec(one)!;
      return { column: [...parts[1]!].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0), row: Number(parts[2]) };
    };
    return { start: at(from!), end: at(to ?? from!) };
  };
  for (let i = 0; i < mergeRefs.length; i += 1) {
    for (let j = i + 1; j < mergeRefs.length; j += 1) {
      const a = box(mergeRefs[i]!);
      const b = box(mergeRefs[j]!);
      assert.ok(
        a.end.row < b.start.row || b.end.row < a.start.row ||
          a.end.column < b.start.column || b.end.column < a.start.column,
        `${mergeRefs[i]} and ${mergeRefs[j]} overlap — Excel refuses to open a sheet with two merges over one cell`,
      );
    }
  }

  // ── A month that was never uploaded is blank, not zero ───────────────────────────────────────
  // A zero here reads as a collapse in sales. The distinction is the whole reason the prior month
  // is passed separately rather than defaulted.
  const withoutPrior = await fillClosingEngine(
    buildClosingEngineFill({ matrix: july, priorMatrix: null, review }),
    { macroFree: true },
  );
  const overviewBlind = await (await JSZip.loadAsync(withoutPrior)).file("xl/worksheets/sheet1.xml")!.async("string");
  const headline = readRow(overviewBlind, 5);
  assert.equal(headline.I ?? "", "", "with no prior month the growth cell is empty, not 0");
  assert.equal(readRow(overviewBlind, 6).I, "no June figure", "and the caption says which month is missing");

  const overview = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  assert.equal(readRow(overview, 6).I, "June was 512,000", "with a prior month it names the month and the number");
  assert.equal(readRow(overview, 4).I, "Against June", "the column heading is written from the period, never hardcoded");

  // ── The footnotes follow the data, and say what is true of THIS month ────────────────────────
  // The template's notes are the ones the owner wrote under July, and three of them quote July's
  // own counts. Left alone they are a number a reader will quote about the wrong month.
  const overviewRows = rowNumbers(overview);
  const notes = overviewRows.slice(-3).map((row) => readRow(overview, row).B);
  assert.match(notes[0]!, /this is CNS only/, "the line is named from the export, not from the template");
  assert.match(notes[2]!, /^1 area carries no target/, "the count is this month's, and reads as a sentence in the singular");

  const lastData = Math.max(...overviewRows.filter((row) => !overviewRows.slice(-3).includes(row)));
  for (const row of overviewRows.slice(-3)) {
    assert.ok(
      overview.includes(`<mergeCell ref="B${row}:J${row}"/>`),
      `footnote row ${row} keeps the merge that lets it span the sheet`,
    );
    assert.ok(row > lastData, "and it sits below the data, not welded across it");
  }
  // Overview's header is eight rows deep and its own KPI band is merged across rows 4-6, so the
  // bound comes from the manifest. Below it, a merge sitting on a data row is a footnote's merge
  // that stayed at last month's row number while the footnote itself moved.
  const headerRows = CLOSING_ENGINE_TEMPLATE_MANIFEST.sheets.Overview!.headerRows;
  const merges = [...overview.matchAll(/<mergeCell ref="[A-Z]+(\d+):/g)].map((one) => Number(one[1]));
  assert.ok(
    !merges.some((row) => row > headerRows && row <= lastData),
    "no merge may be left behind on a data row — that is what a footnote moving without its merge does",
  );

  // ── The colouring is cut to the real row count ───────────────────────────────────────────────
  // The template's ranges are July's sizes. Too short and the banding stops partway down; too long
  // and it paints the footnotes. Both are invisible except by looking at the file.
  const banding = /<conditionalFormatting sqref="A5:J(\d+)"/.exec(repRanking);
  assert.ok(banding, "Rep Ranking keeps its row banding");
  assert.equal(
    Number(banding![1]),
    Math.max(...rowNumbers(repRanking)),
    "and the banding ends on the last row of data, not on the row count the template was cut for",
  );
  const cardBanding = /<conditionalFormatting sqref="B17:H(\d+)"/.exec(repCard);
  assert.equal(
    Number(cardBanding![1]),
    17 + PRODUCTS.length - 1,
    "the Rep Card's colouring stops at the last product, leaving the total line outside it",
  );
  assert.ok(Math.max(...cardRows) > 17 + PRODUCTS.length, "the card still has its footnotes below the total");

  // ── Every sheet-local name is on its own sheet ───────────────────────────────────────────────
  // `localSheetId` is a POSITION in the sheet order. Adding the thirteenth sheet renumbered
  // everything after it, and a print area left on the old number moves to a different sheet — a
  // file that is entirely valid and prints the wrong page.
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  const order = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((one) => one[1]!);
  assert.deepEqual(order, [
    "Overview",
    "Rep Ranking",
    "Rep Card",
    "Top Achievers",
    "Closing Matrix",
    "Units Matrix",
    "Area x Product",
    "Family Performance",
    "Family by Month",
    "Data",
    "Watch List",
    "Top Customers",
    "Details",
  ]);
  for (const match of workbook.matchAll(/<definedName name="([^"]*)" localSheetId="(\d+)"[^>]*>([^<]*)<\/definedName>/g)) {
    const named = /^'?([^'!]+)'?!/.exec(match[3]!);
    if (!named) continue;
    assert.equal(
      order[Number(match[2])],
      named[1],
      `${match[1]} is attached to sheet ${match[2]} but its range names ${named[1]}`,
    );
  }

  // ── Family by Month tells "did not report" apart from "sold nothing" ────────────────────────
  const byMonth = await zip.file("xl/worksheets/sheet13.xml")!.async("string");
  const monthRows = rowNumbers(byMonth).filter((row) => row >= 5).map((row) => readRow(byMonth, row));
  const tebofortin = monthRows.filter((row) => row.B === "Tebofortin");
  assert.equal(tebofortin.length, 2, "one row per month in the series");
  assert.deepEqual(tebofortin.map((row) => row.C), ["June 2026", "July 2026"], "oldest first, named not coded");
  assert.equal(tebofortin[0]!.F ?? "", "", "the first month of the series has nothing to grow against");
  assert.equal(tebofortin[1]!.F, "1", "July is double June, so growth is 100%");
  assert.equal(tebofortin[1]!.G, UP, "and the arrow beside a growth column turns at zero, not at half");

  // ── The Details sheet reconciles ITSELF against the headline ────────────────────────────────
  // These rows are the invoice lines as INVOICED; every headline in the workbook is after the
  // Office and store allocation, which credits a sale to the area that earned it and not to the
  // branch that shipped it. Over a whole line the two agree exactly — the allocation only moves
  // value between areas (measured on CNS July 2026: the seven regional gaps sum to zero). Narrow
  // the export to one region and they part company, and a reader who adds this sheet up then gets
  // a different number from the Overview has nothing telling them which to believe.
  const lineTotal = july.grandTotal.rowTotal.salesValue;
  // The same rounding the sheet itself uses, so this compares against what a reader sees.
  const formatInt = (value: number) => Math.round(value).toLocaleString("en-US");
  // Typed as the real row so a field added to ClosingDetailRow turns this red rather than letting
  // the fixture drift into a shape the loader can no longer produce.
  const detail = (value: number, index: number): ClosingDetailRow => ({
    areaCode: "CA1", areaMismatch: false, areaName: "Cairo 1", blockCode: "BL1", bonusQty: 0,
    brickId: "BR1", brickName: "Brick 1", brickUnmapped: false, clientAddress: "one street",
    clientCode: `1011${index}`, clientName: `customer ${index}`, discount: 0, distributorCode: "EP",
    effectiveUnits: 1, exclusions: [], factoryPrice: value, family: "Tebofortin", id: index,
    includedInClosing: true, invoiceDate: "2026-07-15", invoicePeriod: "2026-07",
    isConfidential: false, isDirect: false, missingClientCode: false, officialLine: "CNS",
    // The organogram pair. Equal to the geographic one here, as it is on every line and area the
    // organogram does not re-own — the case where they DIFFER is pinned in the region-basis test.
    operationalRegionCode: "CA", operationalRegionName: "Cairo",
    productCode: "TB001", productName: "Tebofortin 40mg", qty: 1, regionCode: "CA",
    regionName: "Cairo", rowNumber: index, salesValue: value, sheetAreaCode: "CA1",
    sheetAreaName: "Cairo 1", sheetRegionCode: "CA", sheetRegionName: "Cairo", sheetValue: value,
    validationState: "ok",
  });
  const detailsTitleOf = async (rows: ClosingDetailRow[]) => {
    const book = await fillClosingEngine(
      buildClosingEngineFill({ details: rows, matrix: july, priorMatrix: june, review }),
      { macroFree: true },
    );
    const sheet = await (await JSZip.loadAsync(book)).file("xl/worksheets/sheet12.xml")!.async("string");
    return readRow(sheet, 1).A ?? "";
  };

  // A filtered export, where the rows on the sheet are NOT the month the headline describes.
  const narrowed = await detailsTitleOf([detail(lineTotal / 4, 1), detail(lineTotal / 4, 2)]);
  assert.match(narrowed, /EGP as invoiced against the/, "the sheet says its own total and the headline");
  assert.ok(
    narrowed.includes(formatInt(lineTotal / 2)) && narrowed.includes(formatInt(lineTotal)),
    `both numbers appear, so neither has to be taken on trust: ${narrowed}`,
  );
  assert.match(narrowed, /credited to the areas that earned them/, "and it says WHY they differ");

  // A whole-line export, where they agree. Saying it here would be noise on every workbook.
  const whole = await detailsTitleOf([detail(lineTotal / 2, 1), detail(lineTotal / 2, 2)]);
  assert.doesNotMatch(whole, /as invoiced against/, "when the two agree the sheet stays quiet");
  assert.match(whole, /invoice lines/, "but it still says how much is on it");

  // ── A hand-apportioned customer is booked where the CLOSING books it ────────────────────────
  // An invoice row carries two areas. The FACT area is the distributor's own, and the only field a
  // human's hand-apportionment is ever written to; the RESOLVED area comes from the customer's
  // brick and says where the shop physically stands. Every closing RPC groups by the fact area, so
  // this sheet must too — reading the resolved one would print the rep who owns the shop's street
  // beside a sale the closing paid somebody else for. They agree on every row in production but a
  // hand-split customer, which is exactly why a fixture with the two set equal proves nothing.
  const twoAreas = july.regions.flatMap((region) => region.areas).slice(0, 2);
  assert.equal(twoAreas.length, 2, "July CNS has at least two areas to tell apart");
  const [home, booked] = twoAreas as [(typeof twoAreas)[number], (typeof twoAreas)[number]];
  const rebooked: ClosingDetailRow = {
    ...detail(1000, 9),
    areaCode: home.areaCode, areaName: home.areaName,
    sheetAreaCode: booked.areaCode, sheetAreaName: booked.areaName,
  };
  const rebookedBook = await fillClosingEngine(
    buildClosingEngineFill({ details: [rebooked], matrix: july, priorMatrix: june, review }),
    { macroFree: true },
  );
  const rebookedSheet = await (await JSZip.loadAsync(rebookedBook)).file("xl/worksheets/sheet12.xml")!.async("string");
  // From the manifest, never counted by hand — the Details header band is what moves when a column
  // is added, and a hardcoded row number would then read a header as data and pass on the wrong cell.
  const rebookedRow = readRow(rebookedSheet, CLOSING_ENGINE_TEMPLATE_MANIFEST.sheets.Details!.headerRows + 1);
  assert.equal(rebookedRow.B, booked.areaName, "the Area column names the area the CLOSING books the sale in, not the one the shop sits in");
  assert.notEqual(rebookedRow.C ?? "", "", "and it names a rep — an area lookup that misses goes blank, not red");
  const bookedRep = review.areas.find((area) => area.areaCode === booked.areaCode)?.repName;
  if (bookedRep) {
    assert.equal(rebookedRow.C, bookedRep, "and it is the rep the closing paid, not the one whose street the shop is on");
  }

  // ── What prints is what is on the sheet ─────────────────────────────────────────────────────
  // A print area is a defined name, and content outside it is dropped from the PDF in silence: no
  // warning, no marker, the page simply ends early. It was clamped to the last row of DATA, while
  // `fillPresentationSheet` re-lands the owner's footnotes `trailerGap` rows BELOW that. So every
  // note he wrote was on screen and on none of the five exports that carry one -- the Rep Card was
  // the only sheet that printed its own, and only because it had a trailer-aware branch nothing
  // else shared. Rendered through Excel, the five sheets went from MISSING to PRESENT on the fix.
  //
  // Pinned against the sheet's own `<dimension>` rather than a row number, because both sides are
  // computed from the month: a bigger fixture moves them together, where a hardcoded row would pin
  // this month instead of the rule.
  const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
  const definedNames = [...workbookXml.matchAll(/<definedName name="([^"]+)"[^>]*>([^<]*)<\/definedName>/g)]
    .map((match) => ({ name: match[1]!, ref: match[2]! }));
  const rangeFor = (name: string, sheetName: string): string | undefined =>
    definedNames.find((entry) => entry.name === name && entry.ref.replace(/'/g, "").startsWith(`${sheetName}!`))?.ref;
  const lastRowOf = (ref: string): number => Number(/\$(\d+)$/.exec(ref)?.[1] ?? 0);

  let footnoteSheets = 0;
  for (const [sheetName, spec] of Object.entries(CLOSING_ENGINE_TEMPLATE_MANIFEST.sheets)) {
    if (spec.kind !== "data" || !(spec.trailerRows ?? []).length) continue;
    const sheetXml = await zip.file(spec.file)!.async("string");
    const lastRow = Number(/<dimension ref="[A-Z]+\d+:[A-Z]+(\d+)"/.exec(sheetXml)?.[1] ?? 0);
    assert.ok(lastRow > 0, `${sheetName}: the sheet declares a dimension`);

    // The last row has to BE a footnote, or every assertion below passes on an empty sheet.
    const lastRowXml = new RegExp(`<row[^>]*\\br="${lastRow}"[\\s\\S]*?</row>`).exec(sheetXml)?.[0] ?? "";
    assert.match(lastRowXml, /<t[^>]*>[^<]{20,}/, `${sheetName}: the last row carries one of the owner's footnotes`);

    const printArea = rangeFor("_xlnm.Print_Area", sheetName);
    assert.ok(printArea, `${sheetName}: has a print area at all`);
    assert.equal(lastRowOf(printArea!), lastRow, `${sheetName}: the print area reaches the footnotes`);

    // `PhxPrintArea` is the range the export-to-PDF button prints, so it has to agree or the button
    // and Ctrl+P disagree about the same sheet.
    const macroArea = rangeFor("PhxPrintArea", sheetName);
    if (macroArea) assert.equal(lastRowOf(macroArea), lastRow, `${sheetName}: the export button prints them too`);

    // ...and the filter must NOT reach them. A footnote inside the AutoFilter range becomes a
    // filterable row, and disappears the moment anyone filters the sheet.
    const filter = rangeFor("_xlnm._FilterDatabase", sheetName);
    if (filter) assert.ok(lastRowOf(filter) < lastRow, `${sheetName}: the AutoFilter stops above the footnotes`);
    footnoteSheets += 1;
  }
  assert.ok(footnoteSheets >= 4, `four or more sheets carry footnotes, not ${footnoteSheets} -- this is not an empty loop`);

  // ── A pivot label reads as a word ───────────────────────────────────────────────────────────
  // The template's pivots carry a `<formats>` list pinned to CACHE-POOL INDICES -- `<x v="0"/>` is
  // "whatever the first region happens to be", so a list saved against CNS's seven regions lands on
  // whatever this month's regions are, in the wrong order. Every one of them was `labelOnly="1"`
  // pointing at the same alignment-only `<dxf>`: `horizontal="left" indent="1"`. On a MERGED and
  // WRAPPED label cell an indent eats most of the usable width, and Excel then wraps the caption one
  // glyph per line -- "Cairo" printed as a column of letters, cut off after four. They are dropped
  // rather than re-pinned: the look they carry is an indent this workbook does not want anywhere.
  const stylesXml = await zip.file("xl/styles.xml")!.async("string");
  const dxfBodies = [...(/<dxfs\b[^>]*>[\s\S]*?<\/dxfs>/.exec(stylesXml)?.[0] ?? "").matchAll(/<dxf>([\s\S]*?)<\/dxf>/g)]
    .map((match) => match[1]!);
  const alignmentOnly = (id: number): boolean =>
    dxfBodies[id] !== undefined && dxfBodies[id]!.replace(/<alignment\b[^>]*\/>/g, "").trim() === "";
  assert.ok(dxfBodies.some((_body, id) => alignmentOnly(id)), "the style itself survives -- this check has something to catch");

  for (const file of zip.file(/^xl\/pivotTables\/pivotTable\d+\.xml$/)) {
    const pivotXml = await file.async("string");
    const formats = /<formats\b[^>]*>[\s\S]*?<\/formats>/.exec(pivotXml)?.[0] ?? "";
    for (const one of formats.matchAll(/<format\b[^>]*>[\s\S]*?<\/format>|<format\b[^>]*\/>/g)) {
      const dxfId = Number(/dxfId="(\d+)"/.exec(one[0])?.[1] ?? -1);
      assert.ok(
        !(/\blabelOnly="1"/.test(one[0]) && alignmentOnly(dxfId)),
        `${file.name}: a stale label format survived and will stack a region name one letter per line`,
      );
    }
  }

  // ── The Region slicer has a button per region ───────────────────────────────────────────────
  // `columnCount` is saved with the template, so it was CNS's seven for every line. An eighth region
  // wrapped onto a second row inside a frame sized for one, which cut the frame's own bottom edge
  // through it. It is the region count or it is wrong -- there is no default that is right twice.
  const slicerFiles = zip.file(/^xl\/slicers\/slicer\d+\.xml$/);
  assert.equal(slicerFiles.length, 2, "both matrices keep their Region slicer");
  for (const file of slicerFiles) {
    const slicerXml = await file.async("string");
    assert.match(
      slicerXml,
      new RegExp(`columnCount="${july.regions.length}"`),
      `${file.name}: one column per region, so no caption wraps out of the frame`,
    );
  }

  // ── An incomplete month says so, on every tab ────────────────────────────────────────────────
  //
  // 2026-09-03, August. Fourteen of eighteen distributor files had not arrived — 84% of the month's
  // value absent — and this workbook rendered immaculately regardless: Rep Cards, ranks and a rank-1
  // star over a sixth of a month. Every number on it was arithmetically exact, which is exactly what
  // makes it dangerous, and it is the workbook built to be sent round. The closing SCREEN warns and
  // the OLD export carries a Source Coverage sheet; the premium export carried no completeness
  // surface at all. Same failure `source-coverage.ts` was written for in July, through another door.
  const coverageEntry = (name: string, prevValue: number): SourceCoverageEntry => ({
    curUnits: 0,
    curValue: 0,
    key: name.toUpperCase(),
    name,
    prevUnits: 0,
    prevValue,
    status: "missing",
  });
  const coverageOf = (missing: SourceCoverageEntry[], over = true): MonthlySourceCoverage => ({
    directRegions: [],
    hasPrevData: over,
    latestUploadAt: null,
    line: july.line ?? "CNS",
    missingDirectRegions: [],
    missingPrevValue: missing.reduce((sum, one) => sum + one.prevValue, 0),
    missingSources: missing,
    period: july.period ?? "2026-07",
    prevPeriod: "2026-06",
    prevSourceCount: 17,
    sources: missing,
  });
  const buildWith = async (coverage: MonthlySourceCoverage | null) =>
    JSZip.loadAsync(
      await fillClosingEngine(
        buildClosingEngineFill({ coverage, matrix: july, priorMatrix: june, review }),
        { macroFree: true },
      ),
    );

  const holed = await buildWith(
    coverageOf([
      coverageEntry("overseas", 45_364_844),
      coverageEntry("EGD", 4_100_000),
      coverageEntry("ramco", 2_513_761),
    ]),
  );
  const warnedOverview = await holed.file("xl/worksheets/sheet1.xml")!.async("string");
  const warnedCard = await holed.file(CLOSING_ENGINE_TEMPLATE_MANIFEST.sheets["Rep Card"]!.file)!.async("string");
  const warnedNote = readRow(warnedOverview, 2).A ?? "";

  assert.match(warnedNote, /INCOMPLETE/, "an incomplete month announces itself on its own row");
  assert.match(warnedNote, /missing 3 sources of the 17/, "it says how many are gone, against how many fed the month before");
  assert.match(warnedNote, /51,978,605 EGP/, "and the scale of the hole, so 'the number looks low' answers itself");
  assert.match(warnedNote, /understated/, "and states the consequence rather than leaving the reader to infer it");
  assert.doesNotMatch(
    readRow(warnedOverview, 1).A ?? "",
    /INCOMPLETE/,
    "row 1 stays the sheet's identity — a note appended there slides the emblem off the sheet",
  );

  // Months in words. The standing rule is human-readable everywhere, and a note that says
  // "2026-06" beside a headline that says "July 2026" reads as two different systems talking.
  assert.match(warnedNote, /June 2026/, "the month compared against is named, not keyed");
  assert.doesNotMatch(warnedNote, /2026-0\d/, "and never as a raw period key");


  // The card takes the short form, and it DISPLACES the tagline rather than joining it — the sheet
  // is 798px wide and the warning has to survive the trip, not trail off the edge behind a slogan.
  const warnedDeck = readRow(warnedCard, 2).A ?? "";
  assert.match(warnedDeck, /INCOMPLETE/, "the card says it too — it is the tab most likely to be shared alone");
  assert.doesNotMatch(warnedDeck, /one person, one month/, "and the warning takes the tagline's place, not room beside it");
  assert.doesNotMatch(
    readRow(warnedCard, 1).A ?? "",
    /INCOMPLETE/,
    "row 1 stays the card's identity — the note goes on the row that is clear of the emblem",
  );
  const deckWidth = warnedDeck.length * 91_500;
  const cardWidth = [0, 1, 2, 3, 4, 5, 6, 7].reduce((sum, index) => sum + columnEmu(index), 0);
  assert.ok(
    deckWidth < cardWidth,
    `the warning has to fit the card it is warning about — ${Math.round(deckWidth / 9525)}px against ${Math.round(cardWidth / 9525)}px`,
  );

  // The emblem stays on the sheet it belongs to.
  //
  // This is the assertion that caught the first attempt at this change. The note began life
  // appended to A1, where the caption overflows rightwards and `clearTitleEmblem` answers by
  // sliding the logo along ahead of it — which is correct until the caption is long enough to slide
  // it past the last column. It put the emblem into empty space on 8 of the 12 sheets, by as much
  // as 1783px, and Area x Product had 3px of slack before it. Nothing else in this repository can
  // see that: the file is valid, Excel opens it without a murmur, and the logo is simply gone from
  // where anyone looks.
  for (const [name, meta] of Object.entries(CLOSING_ENGINE_TEMPLATE_MANIFEST.sheets)) {
    const sheetXml = await holed.file(meta.file)?.async("string");
    if (!sheetXml) continue;
    const rels = await holed
      .file(meta.file.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels"))
      ?.async("string");
    const drawingHref = rels ? /Target="\.\.\/(drawings\/drawing\d+\.xml)"/.exec(rels)?.[1] : null;
    if (!drawingHref) continue;
    const drawing = await holed.file(`xl/${drawingHref}`)!.async("string");
    const emblem = [...drawing.matchAll(/<xdr:(?:twoCell|oneCell)Anchor[\s\S]*?<\/xdr:(?:twoCell|oneCell)Anchor>/g)]
      .map((one) => one[0])
      .find((one) => /<xdr:pic\b/.test(one));
    if (!emblem) continue;

    const runs = [...(/<cols>[\s\S]*?<\/cols>/.exec(sheetXml)?.[0] ?? "").matchAll(/<col\b[^>]*?\/>/g)].map((one) => ({
      max: Number(/max="(\d+)"/.exec(one[0])?.[1]),
      min: Number(/min="(\d+)"/.exec(one[0])?.[1]),
      width: /hidden="1"/.test(one[0]) ? 0 : Number(/width="([\d.]+)"/.exec(one[0])?.[1] ?? 9.140625),
    }));
    const widthEmu = (index: number): number => {
      const run = runs.find((one) => index + 1 >= one.min && index + 1 <= one.max);
      const width = run ? run.width : 9.140625;
      return width > 0 ? (Math.round(width * 7) + 5) * 9525 : 0;
    };
    // The used width comes from <dimension>, never from <cols> — a default min="1" max="16384" run
    // measures 1,130,760px and would certify anything at all.
    const lastLetters = /<dimension ref="[A-Z]+\d+(?::([A-Z]+)\d+)?"/.exec(sheetXml)?.[1] ?? "A";
    const lastColumn = [...lastLetters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
    let used = 0;
    for (let index = 0; index < lastColumn; index += 1) used += widthEmu(index);

    const from = /<xdr:from>[\s\S]*?<\/xdr:from>/.exec(emblem)?.[0] ?? "";
    const fromColumn = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(from)?.[1] ?? 0);
    let left = Number(/<xdr:colOff>(\d+)<\/xdr:colOff>/.exec(from)?.[1] ?? 0);
    for (let index = 0; index < fromColumn; index += 1) left += widthEmu(index);

    assert.ok(
      left <= used,
      `${name}: the emblem sits ${Math.round((left - used) / 9525)}px past the last column — the caption slid it off the sheet`,
    );

    // And while we are on a sheet that carries an emblem — every one of them is a sheet a reader
    // looks at, so every one of them carries the note. Carrying an emblem is the discriminator, not
    // "has something in A1": the Data sheet has a column header there and no reader at all.
    //
    // Area x Product is the reason this is a loop rather than a spot check. It is the single sheet
    // in the owner's template with NO row 2, and a cell aimed at a row that does not exist used to
    // be dropped in silence — the note appeared on eleven tabs and was missing, unremarked, from
    // the twelfth. A warning absent from one sheet is worse than one absent from all of them.
    assert.match(
      `${readRow(sheetXml, 2).A ?? ""}`,
      /INCOMPLETE/,
      `${name} carries the completeness note — every sheet a reader opens does, or they learn not to look`,
    );
  }

  // Silence is the other half. A workbook that certifies its own completeness on every tab teaches
  // the reader to skip the line, and then the one month that needed it is the one nobody reads.
  for (const [what, book] of [
    ["a month with nothing missing", await buildWith(coverageOf([]))],
    ["a month with no prior to compare against", await buildWith(coverageOf([coverageEntry("overseas", 1)], false))],
    ["a coverage check that could not run", await buildWith(null)],
  ] as const) {
    const quietNote = readRow(await book.file("xl/worksheets/sheet1.xml")!.async("string"), 2).A ?? "";
    const quietCard = await book.file(CLOSING_ENGINE_TEMPLATE_MANIFEST.sheets["Rep Card"]!.file)!.async("string");
    assert.doesNotMatch(quietNote, /INCOMPLETE/, `${what} says nothing in the masthead`);
    assert.doesNotMatch(readRow(quietCard, 2).A ?? "", /INCOMPLETE/, `${what} says nothing on the card either`);
    assert.match(
      readRow(quietCard, 2).A ?? "",
      /one person, one month, every product/,
      `${what} keeps the card's own tagline`,
    );
  }

  // ── The file the owner receives is named for a month, a line and a scope ─────────────────────
  assert.equal(
    closingFileName({ extension: "xlsm", kind: "premium", line: "CNS", period: "2026-07", region: "Cairo" }),
    "phoenix-monthly-closing-premium-jul-2026-cns-cairo.xlsm",
    "the month reads the way the sheets inside read it, so the file and its contents never disagree",
  );
  assert.equal(
    closingFileName({ kind: "premium", line: "CNS", period: "2026-07", region: "Cairo" }),
    "phoenix-monthly-closing-premium-jul-2026-cns-cairo.xlsx",
    "the default stays .xlsx — a macro attachment is stripped by too many mail systems to be the default",
  );
}
