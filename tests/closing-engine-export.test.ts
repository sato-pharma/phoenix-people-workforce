import assert from "node:assert/strict";

import JSZip from "jszip";

import { buildClosingEngineFill, previousPeriod } from "../src/lib/sales/closing-engine-data.ts";
import { fillClosingEngine } from "../src/lib/sales/closing-engine-fill.ts";
import {
  buildClosingPerformanceReview,
  type AreaSeatAssignment,
} from "../src/lib/sales/closing-performance-review.ts";
import { closingFileName } from "../src/lib/sales/closing-export-filename.ts";
import {
  CLOSING_PDF_SHEETS,
  buildClosingSheetHtml,
  isClosingPdfSheet,
  readSheetChrome,
} from "../src/lib/sales/closing-report-pdf.ts";
import {
  CLOSING_ENGINE_TEMPLATE_MANIFEST,
  closingEngineTemplateBytes,
} from "../src/lib/sales/closing-engine-template-generated.ts";
import { PIVOT_GRID_SPECS } from "../src/lib/sales/closing-pivot-grid.ts";
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

/**
 * The same closing with a chosen number of REGIONS — one area each.
 *
 * Overview writes one row per region, so this is the only knob that decides where that sheet's
 * footnotes land, and it is the dimension `fixtureMatrix` above holds fixed at two. A line with
 * nine regions puts them one row below the template's own, which is the shape that broke the
 * owner's September Anti Infective export while August's eight left them exactly where they were.
 */
function regionsMatrix(period: string, regionCount: number, scale = 1): MonthlyClosingMatrix {
  const regions = Array.from({ length: regionCount }, (_, index) => {
    const code = `R${index + 1}`;
    const only = area(`${code}A`, `Area ${index + 1}`, code, `Region ${index + 1}`, [
      cell(1000 * scale, 500_000 * scale, 900, 450_000),
      cell(200 * scale, 300_000 * scale, 250, 375_000),
      cell(50 * scale, 20_000 * scale, 40, 16_000),
    ]);
    return {
      areas: [only],
      regionCode: code,
      regionName: `Region ${index + 1}`,
      subtotal: {
        cells: only.cells.map((one) => sum([one])),
        kind: "regionSubtotal" as const,
        regionCode: code,
        regionName: `Region ${index + 1}`,
        rowTotal: sum([only.rowTotal]),
      },
    };
  });
  const allAreas = regions.flatMap((group) => group.areas);
  return {
    availableLines: ["CNS"],
    availablePeriods: ["2026-08", "2026-09"],
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
  const reviewBook = await fillClosingEngine(fill, {
    macroFree: true,
    reviewSheets: [
      {
        headers: ["District manager", "Region", "Areas", "Sales value", "Target value", "Achievement"],
        name: "District Managers",
        rows: [["Dina Fadel", "Delta (1)", 4, 120000, 150000, 0.8]],
        subtitle: "rolled up by manager",
        title: "District Managers   Jul 2026   CNS",
        what: "Every district manager's areas rolled into one row.",
        widths: [30, 18, 9, 16, 16, 14],
      },
      // 🔴 A SHEET THAT NAMES ITS OWN COLUMN FORMATS — the invoice-grain Rows tab (owner,
      // 2026-10-13). `reviewColumnStyle` reads the HEADING and falls back to money, which rounds to
      // whole pounds and prints an em dash for zero. An Office allocation row carries 0.442381
      // units by the golden rule, so a units column left to that fallback would show a real sale as
      // nothing at all. `columnFormats` is how such a column says otherwise.
      {
        band: "The counted rows",
        columnFormats: [null, "plain", "money"],
        headers: ["Product", "Units", "Value EGP"],
        name: "Rows",
        rows: [["Royafloxacin 500 mg", 0.442381, 15.676877]],
        subtitle: "every counted row, at invoice grain",
        title: "Every counted row   Jul 2026   CNS",
        what: "Every row the closing counted, at invoice grain.",
        widths: [26, 9, 13],
      },
    ],
  });
  const linkedBook = await fillClosingEngine(fill, {
    macroFree: true,
    pdfLink: (sheet) =>
      isClosingPdfSheet(sheet) ? `https://phoenix-hr.satopharma.com/pdf?sheet=${encodeURIComponent(sheet)}` : null,
  });

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

  // ── NOT PROTECTED: no sheet of any build carries protection, nor the workbook ─────────────────
  // Owner, 2026-10-26: "make the exported monthly closing xlsx all its types download non protected".
  for (const [label, book] of [
    ["xlsm", macroBook],
    ["xlsx", plainBook],
    ["xlsx with review tabs", reviewBook],
  ] as const) {
    const opened = await JSZip.loadAsync(book);
    const sheetParts = Object.keys(opened.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
    assert.ok(sheetParts.length >= 12, `${label}: the engine's sheets are all there`);
    for (const part of sheetParts) {
      const xml = await opened.file(part)!.async("string");
      assert.ok(!xml.includes("<sheetProtection"), `${label}: ${part} must not be sheet-protected`);
    }
    const workbookXml = await opened.file("xl/workbook.xml")!.async("string");
    assert.ok(!workbookXml.includes("<workbookProtection"), `${label}: the workbook must not be protected`);
  }

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
        // A fragment target — `#'Sheet'!A1` — names a place in the DOCUMENT, not a part in the
        // package, and carries no TargetMode because it never leaves the file. The navigation bar
        // is built from these, and resolving one as a path looks for a part called
        // `xl/drawings/#'Overview'!A1` and correctly fails to find it.
        if (target.startsWith("#")) continue;
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

  // ── The emblem is a screen mark and must not reach the paper ────────────────────────────────
  //
  // Owner's instruction, 2026-09-05. Asserted on the EMITTED workbook rather than on the source,
  // because the flag lives on the anchor and there is a second writer to that same part:
  // `clearTitleEmblem` moves the emblem for a long line name, and a build where it moved is the
  // one that would silently lose the attribute. Both builds are checked — the .xlsm's macro sets
  // `PrintObject = False` only in memory, so the saved package is what decides the printed page
  // when the button has not been pressed.
  //
  // Anchor-scoped, never a bare count of the attribute: `fPrintsWithSheet="0"` appearing SOMEWHERE
  // in a drawing says nothing about which shape carries it, and the slicers deliberately keep
  // printing. A file-wide match would pass with the flag on the wrong element.
  const anchorsOf = (xml: string) =>
    xml.match(/<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>[\s\S]*?<\/xdr:\1>/g) ?? [];
  let emblemsChecked = 0;
  let slicersChecked = 0;
  for (const [label, drawings] of [["xlsm", macroDrawings], ["xlsx", plainDrawings]] as const) {
    for (const [name, xml] of Object.entries(drawings)) {
      for (const anchor of anchorsOf(xml)) {
        const clientData = /<xdr:clientData\b[^>]*\/>|<xdr:clientData\b[^>]*>[\s\S]*?<\/xdr:clientData>/.exec(anchor)?.[0] ?? "";
        if (anchor.includes("<xdr:pic")) {
          emblemsChecked += 1;
          assert.match(
            clientData,
            /fPrintsWithSheet="0"/,
            `${label} ${name}: the emblem prints onto the page — the owner asked for it off the paper`,
          );
        } else if (anchor.includes("<mc:AlternateContent")) {
          slicersChecked += 1;
          assert.ok(
            !/fPrintsWithSheet="0"/.test(clientData),
            `${label} ${name}: a slicer must KEEP printing — it says which regions the sheet covers`,
          );
        }
      }
    }
  }
  // A loop that matched nothing would pass every assertion above it. These are the counts measured
  // on the owner's August Anti-Infective export: 13 emblems and 2 slicers, in each of the two builds.
  //
  // Twelve of the thirteen are the owner's own, one per sheet that carries a masthead. The
  // thirteenth is the contents page's, added 2026-09-07 — it reuses the same `xl/media/image1.png`
  // rather than embedding a second copy, so the count of PICTURES rose while the count of IMAGES in
  // the package did not.
  assert.equal(emblemsChecked, 26, "both builds must have been walked — 13 emblem anchors in each");
  assert.equal(slicersChecked, 4, "both builds must have been walked — 2 slicer anchors in each");

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

  // 1. The masthead is ONE line, and every row under it is silent.
  //
  // The card is eight columns and 798px wide, and the logo is anchored at 689px with 16px of slack
  // — so `clearTitleEmblem`, which answers a long caption everywhere else by sliding the emblem
  // right, has nowhere to slide it here. The caption is therefore the sheet's name, its month and
  // its line, and nothing else.
  //
  // 🔴 THE TAGLINE IS GONE, owner 2026-09-10: "in rep card in row 2 their is irrelevnt txt
  // behind the buttons". "one person, one month, every product" was written to A2, which is the
  // command row on every sheet in this workbook, so the navigation shapes painted over it and it
  // had never been readable on any export.
  //
  // ⚠ ROW 3 IS ASSERTED WITH IT, and that pairing is the point. Moving the line down a row
  // is the obvious repair and it is wrong: row 3 is the WARNING strip, and `paintExecutiveBands`
  // paints any row 3 carrying text in the amber incomplete-month fill. It shipped that way for one
  // build. Pinning both rows closes both routes.
  const masthead = readRow(repCardXml, 1).A ?? "";
  assert.match(masthead, /^Rep Card\b/, "the masthead still opens with the sheet's own name");
  assert.match(masthead, /Anti Infective|CNS/, "and still says which line and month it is");
  for (const row of [2, 3]) {
    assert.equal(
      (readRow(repCardXml, row).A ?? "").trim(),
      "",
      `row ${row} says nothing — row 2 prints behind the buttons and row 3 is the warning strip`,
    );
  }
  assert.doesNotMatch(masthead, /one person, one month/, "and the tagline is not back on row 1 either");

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

  // ── …and they do not pile onto each other when the block barely moves ────────────────────────
  //
  // Everything above passes at two regions, because two regions move the footnotes six rows UP and
  // a block moving up can never land on a row it has not already left. The failure is the other
  // direction, and only just: the footnotes sit at 18/19/20 in the owner's template, so a line with
  // NINE regions puts them at 19/20/21 — each one's new row is the next one's old row. The mover
  // used to rewrite the sheet once per row, so every rewrite was still on the page for the next
  // pattern to match again, and all three merges cascaded onto B21:J21.
  //
  // Excel does not repair that record. It discards EVERY merge on the sheet and names the part:
  // "Removed Records: Merge cells from /xl/worksheets/sheet1.xml part". Measured on the owner's own
  // September Anti Infective export, 2026-09-08 — nine regions. August had eight, which moves the
  // block nowhere at all, and Pedia has seven, which moves it up; both opened cleanly, which is why
  // this looked like a fix that kept coming undone rather than a shape nobody had exported yet.
  //
  // The region count is the whole test. Nothing else in this file varies it, and no other input
  // reaches it: not the month, not the line, not the filter.
  const trailerShifts: number[] = [];
  for (const regionCount of [8, 9, 10, 11]) {
    const wide = regionsMatrix("2026-09", regionCount);
    const wideBook = await fillClosingEngine(
      buildClosingEngineFill({
        matrix: wide,
        priorMatrix: regionsMatrix("2026-08", regionCount, 0.5),
        review: buildClosingPerformanceReview({
          availableLines: ["CNS"],
          availablePeriods: ["2026-08", "2026-09"],
          generatedAt: "2026-09-08T12:00:00.000Z",
          matrix: wide,
          seatAssignments: new Map(),
          seriesMatrices: [{ matrix: wide, period: "2026-09" }],
        }),
      }),
      { macroFree: true },
    );
    const wideSheet = await (await JSZip.loadAsync(wideBook)).file("xl/worksheets/sheet1.xml")!.async("string");
    const refs = [...wideSheet.matchAll(/<mergeCell ref="([^"]+)"/g)].map((one) => one[1]!);
    const label = `${regionCount} regions`;

    assert.equal(
      new Set(refs).size,
      refs.length,
      `${label}: two merges landed on the same range — Excel answers that by dropping every merge on the sheet`,
    );
    assert.equal(
      Number(/<mergeCells count="(\d+)"/.exec(wideSheet)![1]),
      refs.length,
      `${label}: the declared merge count is what the sheet actually carries`,
    );

    const wideRows = rowNumbers(wideSheet);
    const trailer = wideRows.slice(-3);
    for (const row of trailer) {
      assert.ok(
        wideSheet.includes(`<mergeCell ref="B${row}:J${row}"/>`),
        `${label}: footnote row ${row} keeps its own strip across the sheet`,
      );
    }
    trailerShifts.push(trailer[0]! - CLOSING_ENGINE_TEMPLATE_MANIFEST.sheets.Overview!.trailerRows![0]!);
  }
  // The control. A loop whose every build happened to leave the footnotes where the template put
  // them would pass all of the above and prove nothing, so the shifts that actually occurred are
  // asserted: one of them has to be the +1 that broke, and one the +2 that breaks the same way.
  assert.deepEqual(
    trailerShifts,
    [0, 1, 2, 3],
    "the loop has to walk the footnotes from where the template left them through the shift that collapsed them",
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
    // The contents page, added 2026-09-05, sits FIRST — and adding it in front is precisely the
    // renumbering this block warns about: every localSheetId after it had to move with it.
    "Contents",
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
  ], "the workbook's sheet list changed: a sheet added at the FRONT renumbers every localSheetId, and every page here is one a reader is promised");
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
    evenSplitApplied: false, isConfidential: false, isDirect: false, missingClientCode: false, officialLine: "CNS",
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

  /** Every string on the contents page, which is the sheet carrying the cover's own wordmark. */
  const contentsTextOf = async (rows: ClosingDetailRow[]) => {
    const zipped = await JSZip.loadAsync(
      await fillClosingEngine(
        buildClosingEngineFill({ details: rows, matrix: july, priorMatrix: june, review }),
        { macroFree: true },
      ),
    );
    for (const file of zipped.file(/^xl\/worksheets\/sheet\d+\.xml$/)) {
      const xml = await file.async("string");
      if (!xml.includes("MONTHLY CLOSING")) continue;
      return [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((one) => one[1]!).join(" ");
    }
    return "";
  };

  // A filtered export, where the rows on the sheet are NOT the month the headline describes.
  const narrowed = await detailsTitleOf([detail(lineTotal / 4, 1), detail(lineTotal / 4, 2)]);
  assert.match(narrowed, /EGP as invoiced against the/, "the sheet says its own total and the headline");
  assert.ok(
    narrowed.includes(formatInt(lineTotal / 2)) && narrowed.includes(formatInt(lineTotal)),
    `both numbers appear, so neither has to be taken on trust: ${narrowed}`,
  );
  // 🔴 THE REASON IS ON THE CONTENTS PAGE, NOT IN THE MASTHEAD. Owner, 2026-09-10: "starting
  // from details no logo their". The 150-character clause that used to finish this caption took it
  // to 285 characters, and `clearTitleEmblem` answers a caption that long by sliding the emblem
  // clear of it — 2,313px along an eighteen-column sheet, where nobody was ever going to see it.
  // The figures stay here, where someone adding up a column needs them; the explanation moved to
  // the line that names this sheet on the contents page, which is read on the way in.
  assert.doesNotMatch(
    narrowed,
    /credited to the areas that earned them/,
    "the caption keeps its figures and gives up its paragraph — the paragraph is what hid the emblem",
  );
  assert.match(
    await contentsTextOf([detail(lineTotal / 4, 1), detail(lineTotal / 4, 2)]),
    /credited where they were earned/,
    "and the contents page is where it says WHY the two totals differ",
  );

  // Measured, because the length is the whole point. The emblem's own ceiling is 1,300px, so a
  // caption that runs past about 1,150 leaves it nowhere to sit that is both clear of the words and
  // on the first screen. A future caption that grows fails here rather than in the owner's hands.
  assert.ok(
    narrowed.length * 91_500 < 11_000_000,
    `the Details caption has to leave the emblem somewhere to sit — ${Math.round((narrowed.length * 91_500) / 9525)}px of a 1,300px screen`,
  );

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
    directModuleSourced: false,
    directRegions: [],
    hasPrevData: over,
    latestUploadAt: null,
    line: july.line ?? "CNS",
    missingDirectRegions: [],
    missingPrevValue: missing.reduce((sum, one) => sum + one.prevValue, 0),
    missingSources: missing,
    period: july.period ?? "2026-07",
    quietPrevValue: 0,
    quietSources: [],
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
  // ROW 3. The note used to be written to row 2, which is empty in the template and therefore read
  // as free — but every navigation button is a drawing anchored from row 2, so the buttons painted
  // straight over it and the warning was unreadable on the owner's own September export. Empty is
  // not free when a drawing floats above it, and no assertion here could see that, because the cell
  // held exactly the text it was supposed to hold.
  // THE COMPLETENESS NOTE IS GONE FROM EVERY TAB. Owner, 2026-09-09: "REMOVE AND DO NOT SHOW THIS
  // LINE IN ANY TAB." It used to announce a month missing distributor feeds, on its own row, on
  // every sheet; the assertions that required it are now assertions that it is absent.
  //
  // What that costs is recorded in `closing-engine-data.ts` beside the removal: a month with three
  // of its four sources missing now reads as a real collapse rather than an incomplete month, and
  // nothing on the page tells the two apart. He was told and asked for it anyway. Do NOT reinstate
  // the line on the reasoning that its absence looks like a defect.
  const warnedNote = readRow(warnedOverview, 3).A ?? "";

  assert.doesNotMatch(warnedNote, /INCOMPLETE/, "no sheet announces an incomplete month any more");
  assert.doesNotMatch(readRow(warnedOverview, 1).A ?? "", /INCOMPLETE/, "and not in the masthead either");
  assert.doesNotMatch(warnedNote, /understated/, "nor the consequence the note used to state");

  // 🔴 THE CARD'S ROWS 2 AND 3 ARE BOTH SILENT. Owner, 2026-09-10: "in rep card in row 2 their
  // is irrelevnt txt behind the buttons" — the tagline "one person, one month, every product",
  // written under a navigation bar that painted straight over it.
  //
  // Row 3 is pinned with it because row 3 is the WARNING strip, and moving the line down a row is
  // the obvious fix that puts it back on screen wearing the amber incomplete-month fill. Both rows
  // are asserted so neither route reopens.
  for (const row of [2, 3]) {
    assert.equal(
      (readRow(warnedCard, row).A ?? "").trim(),
      "",
      `the Rep Card says nothing on row ${row} — the owner removed the tagline, and row 3 is the warning strip`,
    );
  }
  assert.match(
    readRow(warnedCard, 1).A ?? "",
    /^Rep Card/,
    "the card still names itself in its masthead",
  );

  // The card is the one sheet most likely to be sent on its own, so a filtered export has to say so
  // ON it. That note used to ride on the tagline line; with the tagline gone it moves to A1.
  const cardWidth = [0, 1, 2, 3, 4, 5, 6, 7].reduce((sum, index) => sum + columnEmu(index), 0);
  assert.ok(
    (readRow(warnedCard, 1).A ?? "").length * 91_500 < cardWidth,
    `the card's masthead has to fit the card — ${Math.round(((readRow(warnedCard, 1).A ?? "").length * 91_500) / 9525)}px against ${Math.round(cardWidth / 9525)}px`,
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
    // Row 3 everywhere except the Rep Card, which keeps the SHORT form on its own deck line at row
    // 2 — that row is spoken for on that sheet and displacing the tagline is deliberate, asserted a
    // few dozen lines above. Every other sheet moved to row 3 when the note came out from under the
    // navigation buttons.
    // Clear on EVERY sheet, not just the ones anybody thought to check. The note was written by a
    // loop over all of them, so its removal is verified the same way.
    for (const row of [1, 2, 3]) {
      assert.doesNotMatch(
        `${readRow(sheetXml, row).A ?? ""}`,
        /INCOMPLETE/,
        `${name} still shows the completeness note on row ${row} — the owner removed it from every tab`,
      );
    }
  }

  // Silence is the other half. A workbook that certifies its own completeness on every tab teaches
  // the reader to skip the line, and then the one month that needed it is the one nobody reads.
  for (const [what, book] of [
    ["a month with nothing missing", await buildWith(coverageOf([]))],
    ["a month with no prior to compare against", await buildWith(coverageOf([coverageEntry("overseas", 1)], false))],
    ["a coverage check that could not run", await buildWith(null)],
  ] as const) {
    const quietNote = readRow(await book.file("xl/worksheets/sheet1.xml")!.async("string"), 3).A ?? "";
    const quietCard = await book.file(CLOSING_ENGINE_TEMPLATE_MANIFEST.sheets["Rep Card"]!.file)!.async("string");
    assert.doesNotMatch(quietNote, /INCOMPLETE/, `${what} says nothing in the masthead`);
    assert.equal((readRow(quietCard, 2).A ?? "").trim(), "", `${what} leaves the card's button row empty`);
    assert.equal((readRow(quietCard, 3).A ?? "").trim(), "", `${what} leaves the card's warning row empty`);
  }

  // ── The file the owner receives is named for a month, a line and a scope ─────────────────────
  assert.equal(
    closingFileName({ extension: "xlsm", kind: "premium", line: "CNS", period: "2026-07", region: "Cairo" }),
    "cairo-monthly-closing-premium-jul-2026.xlsm",
    "the month reads the way the sheets inside read it, so the file and its contents never disagree",
  );
  assert.equal(
    closingFileName({ kind: "premium", line: "CNS", period: "2026-07", region: "Cairo" }),
    "cairo-monthly-closing-premium-jul-2026.xlsx",
    "the default stays .xlsx — a macro attachment is stripped by too many mail systems to be the default",
  );

  // ── Export PDF, as the one control a .xlsx is allowed to carry ──────────────────────────────
  //
  // The format forbids a VBA part, so `PhxExportPdf` cannot exist in this build and no Excel feature
  // substitutes for it. A hyperlink can, and this is that button: the owner's own shape, with its
  // macro swapped for a destination. Asserted on the EMITTED package, because every way this fails
  // is a package-level fault Excel reports as "we found a problem with some content" — a dangling
  // relationship id, a hyperlink rel that is not external, a `macro=` left behind.
  const linkedZip = await JSZip.loadAsync(linkedBook);
  const linkedSheets: string[] = [];
  let danglingMacros = 0;
  for (const file of linkedZip.file(/^xl\/drawings\/drawing\d+\.xml$/)) {
    const xml = await file.async("string");
    danglingMacros += (xml.match(/macro="[^"]+"/g) ?? []).length;

    const relsName = file.name.replace(/drawings\/(drawing\d+)\.xml$/, "drawings/_rels/$1.xml.rels");
    const rels = (await linkedZip.file(relsName)?.async("string")) ?? "";
    for (const hit of xml.match(/<a:hlinkClick[^>]*r:id="rId\d+"/g) ?? []) {
      const id = /r:id="(rId\d+)"/.exec(hit)![1];
      const rel = new RegExp(`<Relationship Id="${id}"[^>]*>`).exec(rels)?.[0];
      assert.ok(rel, `${file.name}: the button points at ${id}, which is not in ${relsName}`);
      assert.match(rel!, /relationships\/hyperlink/, `${id} must be a hyperlink relationship`);
      // The drawings now carry two kinds of hyperlink and they must NOT be judged alike: the PDF
      // button leaves the package and has to say so, while a navigation jump stays inside it and
      // Excel refuses to follow one marked External. The nav bar is asserted separately below.
      if (/Target="#/.test(rel!)) continue;
      assert.match(rel!, /TargetMode="External"/, `${id} points off the package and must say so`);
      linkedSheets.push(decodeURIComponent(/sheet=([^"&]*)/.exec(rel!)?.[1] ?? "?"));
    }
  }
  assert.equal(
    danglingMacros,
    0,
    "a linked build may still name no VBA routine — re-pointing the button must also strip macro=",
  );
  assert.deepEqual(
    [...linkedSheets].sort(),
    [...CLOSING_PDF_SHEETS].sort(),
    "every renderable page gets a button, and only those — a pivot page's button is dropped, never left dead",
  );

  // The .xlsm is untouched by all of it: its macro works, so it keeps the macro.
  const macroDrawingXml = await Promise.all(
    (await JSZip.loadAsync(macroBook)).file(/^xl\/drawings\/drawing\d+\.xml$/).map((f) => f.async("string")),
  );
  assert.equal(
    macroDrawingXml.reduce((n, xml) => n + (xml.match(/<a:hlinkClick/g) ?? []).length, 0),
    0,
    "the .xlsm must not gain a hyperlink — PhxExportPdf still runs there",
  );
  assert.ok(
    macroDrawingXml.some((xml) => /macro="PhxExportPdf"/.test(xml)),
    "the .xlsm must still hold the owner's Export PDF button",
  );

  // ── The PDF document itself ─────────────────────────────────────────────────────────────────
  //
  // On the EMITTED HTML, never on the module's source: the three defects that shipped in one night
  // on this repo's other document work were all template-literal faults invisible in the source —
  // an escaped slash that reached the browser unescaped, a quoted font family that closed a `style`
  // attribute. Chromium is not launched here; CI's runner is not the app container.
  const chrome = await readSheetChrome("Rep Ranking");
  assert.ok(chrome.headers.includes("Medical rep"), "headings come from the owner's template, not from this file");
  assert.ok(chrome.landscape, "Rep Ranking is landscape in his own page setup, and the PDF must follow it");

  const html = buildClosingSheetHtml(
    { fill, line: "CNS", period: "2026-07", sheet: "Rep Ranking" },
    chrome,
  );
  assert.ok(!/text-overflow/.test(html), "no ellipsis, ever — a shortened customer name reads as a different one");
  assert.match(html, /border-radius: 0 !important/, "square edges: the owner's rule, and tokens.css defaults to 4px");
  assert.match(html, /<thead>/, "the heading row repeats on every page of a long table");
  // Checked with the embedded mark taken out first. It is a base64 PNG, and a base64 blob contains
  // every letter sequence eventually — this very logo carries a literal "NaN" inside it, which
  // failed this assertion on a document that was perfectly correct.
  const withoutImages = (page: string) => page.replace(/src="data:[^"]*"/g, 'src="…"');
  assert.ok(
    !/undefined|NaN|\[object Object\]/.test(withoutImages(html)),
    "no value may reach the page as a JavaScript artefact",
  );

  // A proportion prints as a percentage. The fill hands over a bare ratio and the workbook's own
  // percent format lives in a cell style this renderer never sees, so `0.83` printed as `0.83` is
  // the silent failure here — not wrong, just unreadable.
  const proportions = buildClosingSheetHtml(
    {
      fill: { ...fill, sheets: { "Rep Ranking": { rows: [[1, "A rep", "Area", "Region", "A manager", 1000, 800, 1.25]] } } },
      line: "CNS",
      period: "2026-07",
      sheet: "Rep Ranking",
    },
    chrome,
  );
  assert.match(proportions, />125%</, "an achievement of 1.25 prints as 125%, the way the sheet shows it");
  assert.match(proportions, />1,000</, "money keeps its thousands separators");

  assert.ok(!isClosingPdfSheet("Closing Matrix"), "a pivot page has no rows in the file and cannot be rendered");
  assert.ok(!isClosingPdfSheet("Data"), "the hidden source block is not a page");

  // ── Every sheet owns its OWN part ────────────────────────────────────────────────────────────
  //
  // THIS ONE SILENTLY DESTROYED A SHEET. The contents page hard-coded `sheet14.xml`, which was free
  // while it was the only sheet being added; once the review sheets were added first they took that
  // name and the contents page overwrote one of them. Two <sheet> entries pointed at one part, and
  // District Managers showed the contents page. Every relationship resolved, so the package
  // integrity check passed it — the only symptom is a tab showing another tab's content.
  {
    const opened = await JSZip.loadAsync(reviewBook);
    const workbook = await opened.file("xl/workbook.xml")!.async("string");
    const wbRels = await opened.file("xl/_rels/workbook.xml.rels")!.async("string");
    const target = Object.fromEntries(
      [...wbRels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    const owned = new Map<string, string>();
    for (const m of workbook.matchAll(/<sheet name="([^"]+)"[^>]*?r:id="(rId\d+)"/g)) {
      const part = target[m[2]];
      assert.ok(part, `${m[1]}: ${m[2]} does not resolve to a part`);
      const already = owned.get(part!);
      assert.ok(!already, `${already} and ${m[1]} both point at ${part} — one has overwritten the other`);
      owned.set(part!, m[1]);
    }

    // And the review's own sheets carry their own headings, not another sheet's.
    const partOf = (name: string) => {
      const hit = /<sheet name="SHEET"[^>]*?r:id="(rId\d+)"/.source.replace("SHEET", name);
      const m = new RegExp(hit).exec(workbook);
      return m ? `xl/${target[m[1]]}` : null;
    };
    const managers = partOf("District Managers");
    assert.ok(managers, "the review's District Managers sheet must be registered");
    const sheet = await opened.file(managers!)!.async("string");
    const headers = [...(/<row r="4"[^>]*>([\s\S]*?)<\/row>/.exec(sheet)?.[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
    assert.deepEqual(
      headers,
      ["District manager", "Region", "Areas", "Sales value", "Target value", "Achievement"],
      "District Managers is showing another sheet's headings",
    );
    // Value columns must carry the engine's own money format, or they print as bare digits.
    assert.match(sheet, /s="43"/, "money columns take the engine's #,##0 format");

    // 🔴 A NAMED `plain` COLUMN ESCAPES THAT MONEY FORMAT, and the emitted cell is where that is
    // visible: the units cell must carry the body style, not s43, or 0.442381 prints as an em dash
    // on a row that really sold something.
    const rowsPart = partOf("Rows");
    assert.ok(rowsPart, "a sheet that names its own column formats is registered like any other");
    const rowsSheetXml = await opened.file(rowsPart!)!.async("string");
    const dataRow = /<row r="5"[^>]*>([\s\S]*?)<\/row>/.exec(rowsSheetXml)?.[1] ?? "";
    const styleOf = (column: string): string | null =>
      new RegExp(`<c r="${column}5" s="(\\d+)"`).exec(dataRow)?.[1] ?? null;
    assert.equal(styleOf("B"), "9", "the units column takes the engine's BODY style — the general format");
    assert.equal(styleOf("C"), "43", "and the value column beside it still takes the money format");
    assert.ok(
      dataRow.includes("<v>0.442381</v>"),
      "the fractional units reach the file exactly — the Office allocation's own spread, unrounded",
    );

    // The review's sheets get their OWN contents band. Neither side of the merge that introduced
    // this had a test for it: the bands came from one branch and the review sheets from the other,
    // so the join between them is the part nothing was watching.
    const contentsPart = partOf("Contents");
    assert.ok(contentsPart, "the contents page must be registered in the review build too");
    const contentsSheet = await opened.file(contentsPart!)!.async("string");
    // Matched case-insensitively on purpose: the band's CASE is a presentation choice — it is set in
    // small caps so a section reads as a section — and pinning the literal string would make a
    // styling change look like a lost band. What must hold is that the band is there and that a
    // review sheet is listed under it.
    const bandAt = contentsSheet.toLowerCase().indexOf(">performance review</t>");
    assert.ok(bandAt >= 0, "the review's sheets must appear under their own contents band");
    assert.ok(
      contentsSheet.slice(bandAt).includes("District Managers"),
      "and the band must be followed by the review's own pages, not stand empty",
    );
    assert.ok(
      /HYPERLINK\("#'District Managers'!A1"/.test(contentsSheet),
      "District Managers must be reachable from the contents page",
    );

    // And the band goes away with its sheets. A heading standing over nothing is the failure mode
    // of appending a band unconditionally, and it only shows on the build that omits the review.
    const plainOpened = await JSZip.loadAsync(plainBook);
    const plainWorkbook = await plainOpened.file("xl/workbook.xml")!.async("string");
    const plainRels = await plainOpened.file("xl/_rels/workbook.xml.rels")!.async("string");
    const plainRid = /<sheet name="Contents"[^>]*?r:id="(rId\d+)"/.exec(plainWorkbook)![1];
    const plainTarget = new RegExp(`Id="${plainRid}"[^>]*?Target="([^"]+)"`).exec(plainRels)![1];
    const plainContents = await plainOpened.file(`xl/${plainTarget}`)!.async("string");
    assert.ok(
      !plainContents.includes(">Performance review</t>"),
      "a build with no review sheets must not carry an empty Performance review band",
    );
  }


  // ── The contents page ───────────────────────────────────────────────────────────────────────
  //
  // A whole SHEET added to the package, which is the most repair-prone thing this file does: a
  // worksheet part needs its content-type override, its workbook relationship AND its <sheet> entry,
  // and Excel repairs the workbook if any one of the three is missing. All three are asserted, on
  // the emitted package, for both builds — a contents page carries no macro and no shape, so the
  // .xlsm reader must not get a worse front page than the .xlsx reader.
  for (const [label, book] of [["xlsm", macroBook], ["xlsx", plainBook]] as const) {
    const opened = await JSZip.loadAsync(book);
    const workbook = await opened.file("xl/workbook.xml")!.async("string");
    const types = await opened.file("[Content_Types].xml")!.async("string");
    const wbRels = await opened.file("xl/_rels/workbook.xml.rels")!.async("string");

    const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(names[0], "Contents", `${label}: the contents page must be the FIRST tab — that is what makes it page one`);

    const entry = /<sheet name="Contents"[^>]*r:id="(rId\d+)"[^>]*\/>/.exec(workbook);
    assert.ok(entry, `${label}: the contents sheet needs a <sheet> entry`);
    const target = new RegExp(`Id="${entry![1]}"[^>]*Target="([^"]+)"`).exec(wbRels);
    assert.ok(target, `${label}: ${entry![1]} must resolve in the workbook relationships`);
    const part = `xl/${target![1]}`;
    assert.ok(opened.file(part), `${label}: the relationship points at ${part}, which is not in the zip`);
    assert.ok(
      types.includes(`PartName="/${part}"`),
      `${label}: a worksheet part with no content-type override is a repair prompt`,
    );

    // Sheet ids must stay unique, or Excel rebuilds them and the workbook is "repaired".
    const ids = [...workbook.matchAll(/sheetId="(\d+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${label}: duplicate sheetId — Excel repairs that`);

    // Every jump must land on a tab that is actually there. A contents page promising a page the
    // workbook does not carry is worse than one that is short.
    const sheet = await opened.file(part)!.async("string");
    const jumps = [...sheet.matchAll(/HYPERLINK\("#'([^']+)'!A1"/g)].map((m) => m[1]);
    assert.ok(jumps.length >= 10, `${label}: expected a row per page, got ${jumps.length}`);
    for (const jump of jumps) {
      assert.ok(names.includes(jump), `${label}: contents offers "${jump}", which is not a tab in this workbook`);
    }
    assert.ok(!jumps.includes("Data"), `${label}: Data is veryHidden and is not a page anybody navigates to`);
    assert.equal(new Set(jumps).size, jumps.length, `${label}: a page is listed twice`);

    // ── The bands ─────────────────────────────────────────────────────────────────────────────
    //
    // Twelve undifferentiated rows are a list; the bands are what make the page a map. They are
    // asserted on the EMITTED sheet rather than on the source table, because the thing that breaks
    // is not the table — it is the XML around it.
    // Case-insensitive on purpose: the bands are set in small caps so a section reads as a section,
    // and the CASE is a presentation choice. Pinning the literal string would report a styling change
    // as a lost band. That the band is present, and named, is the invariant.
    const lower = sheet.toLowerCase();
    for (const band of ["Start here", "By area", "By product family", "Behind the numbers"]) {
      assert.ok(lower.includes(`>${band.toLowerCase()}</t>`), `${label}: the contents page lost its "${band}" band`);
    }

    // A band spans both columns, so every one adds a merge. A hard-coded count is a repair prompt:
    // Excel rebuilds a workbook whose declared mergeCells count disagrees with the refs it finds,
    // and the reader sees "we found a problem with some content" instead of the front page.
    const declaredMerges = Number(/<mergeCells count="(\d+)"/.exec(sheet)![1]);
    const actualMerges = [...sheet.matchAll(/<mergeCell ref="/g)].length;
    assert.equal(
      declaredMerges,
      actualMerges,
      `${label}: mergeCells declares ${declaredMerges} but the sheet carries ${actualMerges} — Excel repairs that`,
    );

    // ── The polish: a coloured header and a zebra that holds ──────────────────────────────────
    //
    // Owner, 2026-09-07: the contents page in the house look — a coloured header and a zebra table.
    //
    // ASSERTED BY RESOLVING EVERY INDEX, never by matching one. An index is precisely what was
    // wrong before: the page named cellXfs 77, 79 and 81 while the template ships 77 of them
    // (0..76), and those three resolved only because the style writer had already appended six
    // entries. It rendered by luck, and any code appending a cellXf earlier would have re-pointed
    // all three at something else with no error. The first assertion below is the one that would
    // have caught it.
    const stylesXml = await opened.file("xl/styles.xml")!.async("string");
    /**
     * Top-level <child> elements of <tag>, by scan — one greedy regex cannot match both
     * `<xf .../>` and `<xf ...>…</xf>`, and getting that wrong silently swallows the rest and
     * reports perfectly valid indices as out of range.
     */
    const listOf = (tag: string, child: string): string[] => {
      const open = stylesXml.indexOf(`<${tag}`);
      if (open < 0) return [];
      const body = stylesXml.slice(stylesXml.indexOf(">", open) + 1, stylesXml.indexOf(`</${tag}>`));
      const out: string[] = [];
      let cursor = 0;
      for (;;) {
        const at = body.indexOf(`<${child}`, cursor);
        if (at < 0) break;
        const gt = body.indexOf(">", at);
        if (body[gt - 1] === "/") { out.push(body.slice(at, gt + 1)); cursor = gt + 1; continue; }
        const close = body.indexOf(`</${child}>`, gt);
        out.push(body.slice(at, close + child.length + 3));
        cursor = close + 1;
      }
      return out;
    };
    const xfs = listOf("cellXfs", "xf");
    const fillList = listOf("fills", "fill");
    const fontList = listOf("fonts", "font");
    const borderList = listOf("borders", "border");
    const idOf = (xf: string, name: string) => Number((new RegExp(`${name}="(\\d+)"`).exec(xf) ?? [, "0"])[1]);
    const fillOf = (style: string) => {
      const fill = fillList[idOf(xfs[Number(style)] ?? "", "fillId")] ?? "";
      return (/fgColor rgb="([0-9A-Fa-f]+)"/.exec(fill) ?? [, "none"])[1];
    };
    const fontOf = (style: string) => fontList[idOf(xfs[Number(style)] ?? "", "fontId")] ?? "";

    // 1) Nothing on this page may point past the end of the style table.
    const usedStyles = [...sheet.matchAll(/<c r="[A-Z]+\d+" s="(\d+)"/g)].map((m) => Number(m[1]));
    assert.ok(usedStyles.length > 0, `${label}: the contents page carries no styled cells at all`);
    const outOfRange = [...new Set(usedStyles)].filter((index) => index >= xfs.length);
    assert.deepEqual(
      outOfRange,
      [],
      `${label}: the contents page names cellXf ${outOfRange.join(", ")} but the workbook has `
        + `${xfs.length} (0..${xfs.length - 1}) — a style index into a list nobody controls`,
    );

    // 2) THE LOOK IS CLONED FROM A SIBLING, not invented for this page.
    //
    // The masthead and the column band must be the very same formats the Overview uses, so the
    // front page cannot drift into a look of its own — which is what it had, and what the owner
    // rejected. Asserted as "this index is also used over there", because that is the only claim
    // that stays true when the ids move, and they DO move: Rep Ranking's masthead was s30 in one
    // build of this workbook and s58 in the next.
    const overviewPart = (() => {
      const tag = [...workbook.matchAll(/<sheet [^>]*\/>/g)].map((m) => m[0])
        .find((one) => /name="Overview"/.test(one));
      const rel = tag ? /r:id="(rId\d+)"/.exec(tag)?.[1] : undefined;
      const target = rel ? new RegExp(`Id="${rel}"[^>]*Target="([^"]+)"`).exec(wbRels)?.[1] : undefined;
      return target ? `xl/${target.replace(/^\//, "")}` : null;
    })();
    assert.ok(overviewPart && opened.file(overviewPart), `${label}: the Overview sheet must be resolvable`);

    const titleStyle = /<row r="1"[^>]*>(?:(?!<\/row>)[\s\S])*?<c r="A1" s="(\d+)"/.exec(sheet)?.[1];
    assert.ok(titleStyle, `${label}: the contents page must carry a masthead on row 1`);

    // THE COVER BANNER. The contents page is the cover, so unlike its siblings it opens with a band
    // rather than a line of type: a deep fill running edge to edge with the month reversed out of
    // it. Owner's choice, 2026-09-07.
    const bannerFill = fillOf(titleStyle!);
    assert.notEqual(bannerFill, "none", `${label}: the cover must open with a filled banner`);

    // Edge to edge: both columns of the band carry the same fill. A band covering only the second
    // column reads as a rectangle floating beside the page, not as a masthead — that was the first
    // attempt at this and it was rejected on sight.
    const bannerRows: string[] = [];
    for (const [, index, body] of sheet.matchAll(/<row r="(\d+)"[^>]*>((?:(?!<\/row>)[\s\S])*?)<\/row>/g)) {
      const cells = [...body.matchAll(/<c r="([A-Z]+)\d+" s="(\d+)"/g)];
      if (cells.length === 0 || fillOf(cells[0][2]) !== bannerFill) break;
      assert.ok(
        cells.length >= 2 && cells.every((cell) => fillOf(cell[2]) === bannerFill),
        `${label}: banner row ${index} does not carry the band across both columns`,
      );
      bannerRows.push(index);
    }
    assert.ok(
      bannerRows.length >= 3,
      `${label}: the banner is ${bannerRows.length} row(s) — a band needs room above and below its `
        + "type, or the words sit hard against its edges",
    );

    // The month is reversed OUT of the band: white type on that fill, or it is unreadable.
    const bannerType = [...sheet.matchAll(/<row r="\d+"[^>]*>((?:(?!<\/row>)[\s\S])*?)<\/row>/g)]
      .slice(0, bannerRows.length)
      .flatMap(([, body]) => [...body.matchAll(/<c r="[A-Z]+\d+" s="(\d+)"[^>]*t="inlineStr"/g)])
      .map((m) => m[1]);
    assert.ok(bannerType.length >= 1, `${label}: the banner carries no type at all`);
    for (const style of bannerType) {
      assert.match(
        fontOf(style),
        /FFFFFF/i,
        `${label}: banner type is not reversed out — it must be white on the band`,
      );
    }

    // 3) NO SECOND BAR. The banner IS the header. A "Page / What it holds" bar under it put two blue
    //    blocks a few points apart, which read as one confused double-header and was the main thing
    //    making the page look like a spreadsheet rather than a cover.
    assert.ok(
      !/<t[^>]*>What it holds<\/t>/.test(sheet),
      `${label}: there is a second header bar under the banner — one blue block on this page, not two`,
    );

    // 4) AIR. Every row below the banner is at least 20pt. The first version used the data sheets'
    //    16.5, which is right for a dense table and cramped for a page whose whole job is to be read
    //    once and navigated from.
    // `\bht=` and NOT `[^>]*ht=`: the latter is greedy, runs on to the `ht="1"` inside
    // `customHeight="1"`, and reports every row in the sheet as one point high.
    const bodyHeights = [...sheet.matchAll(/<row r="(\d+)"[^>]*?\bht="([0-9.]+)"/g)]
      .filter((row) => Number(row[1]) > bannerRows.length)
      .map((row) => Number(row[2]));
    assert.ok(bodyHeights.length > 0, `${label}: no rows below the banner`);
    const cramped = bodyHeights.filter((height) => height < 20);
    assert.equal(
      cramped.length,
      0,
      `${label}: ${cramped.length} row(s) under 20pt — the page reads as a list, not a contents page`,
    );

    // 5) NO ZEBRA, and every row ruled. The stripe was #F5F9FC on white: invisible at reading size,
    //    so it put a style in the file and nothing on the page. The rule does the separating.
    const entryRows = [...sheet.matchAll(
      /<row r="\d+"[^>]*>((?:(?!<\/row>)[\s\S])*?<f>HYPERLINK(?:(?!<\/row>)[\s\S])*?)<\/row>/g,
    )].map((m) => m[1]);
    assert.ok(entryRows.length >= 10, `${label}: expected a row per page, got ${entryRows.length}`);
    for (const row of entryRows) {
      for (const cell of row.matchAll(/<c r="([A-Z]+)\d+" s="(\d+)"/g)) {
        assert.equal(
          fillOf(cell[2]),
          "none",
          `${label}: entry column ${cell[1]} is filled — the zebra came out for being invisible`,
        );
        const border = borderList[idOf(xfs[Number(cell[2])] ?? "", "borderId")] ?? "";
        assert.match(
          border,
          /<bottom[^>]*style="[a-z]+"/,
          `${label}: entry column ${cell[1]} carries no rule under it`,
        );
      }
    }

    // 6) The emblem. It must be ON the page, wired the way Excel needs it, and it must REUSE the
    //    picture already in the package rather than adding a second copy of the same mark.
    assert.match(
      sheet,
      /<drawing r:id="[^"]+"\/><\/worksheet>\s*$/,
      `${label}: the contents page needs its <drawing>, and it is the LAST child of a worksheet — `
        + "anywhere else is a schema violation, and Excel answers those by repairing the workbook",
    );
    const sheetRelsPart = `xl/worksheets/_rels/${part.split("/").pop()}.rels`;
    assert.ok(opened.file(sheetRelsPart), `${label}: the contents sheet has a drawing but no ${sheetRelsPart}`);
    const sheetRels = await opened.file(sheetRelsPart)!.async("string");
    const drawingTarget = /Type="[^"]*\/drawing"[^>]*Target="([^"]+)"/.exec(sheetRels)?.[1]
      ?? /Target="([^"]+)"[^>]*Type="[^"]*\/drawing"/.exec(sheetRels)?.[1];
    assert.ok(drawingTarget, `${label}: the sheet relationship must point at a drawing`);
    const drawingPart = `xl/${drawingTarget!.replace(/^\.\.\//, "")}`;
    assert.ok(opened.file(drawingPart), `${label}: ${drawingPart} is referenced but not in the zip`);
    assert.ok(
      types.includes(`PartName="/${drawingPart}"`),
      `${label}: a drawing part with no content-type override is a repair prompt`,
    );

    const drawingXml = await opened.file(drawingPart)!.async("string");
    assert.match(drawingXml, /<xdr:pic\b/, `${label}: the contents drawing carries no picture`);
    assert.match(
      drawingXml,
      /fPrintsWithSheet="0"/,
      `${label}: the contents emblem must stay off the paper, like the emblem on every other sheet`,
    );
    const drawingRels = await opened
      .file(`xl/drawings/_rels/${drawingPart.split("/").pop()}.rels`)!
      .async("string");
    const imageTarget = /Target="([^"]+)"/.exec(drawingRels)?.[1];
    assert.ok(
      imageTarget && opened.file(`xl/${imageTarget.replace(/^\.\.\//, "")}`),
      `${label}: the emblem points at ${imageTarget}, which is not in the package`,
    );
    const media = Object.keys(opened.files).filter((name) => /^xl\/media\/[^/]+$/.test(name));
    // TWO images, and no more: the template's on-light mark that every other sheet uses, plus the
    // on-dark lockup this banner needs. They differ in ONE path fill — "SATO" in black against
    // white — and that one fill is the whole reason for the second file: the black wordmark
    // disappears on the band and the masthead reads "PHARMA".
    assert.equal(
      media.length,
      2,
      `${label}: expected the on-light mark and the on-dark one, found ${media.length}: `
        + media.join(", "),
    );
    assert.match(
      imageTarget!,
      /phx-emblem-on-dark\.png$/,
      `${label}: the banner points at ${imageTarget} — on the dark band it must use the WHITE-SATO `
        + "lockup, or half the wordmark vanishes",
    );

    // 7) BESIDE THE TITLE. The mark goes in the first column, on the masthead row, and the title
    //    indents past it. Both halves are asserted because they are one arrangement held from two
    //    ends: drop the indent and the logo lands on the first word — a defect nothing but a render
    //    would ever show, which is exactly how this page went wrong three times.
    assert.match(
      drawingXml,
      /<xdr:col>0<\/xdr:col>/,
      `${label}: the emblem must sit in the first column, beside the title — not out in a far corner`,
    );
    // INSIDE THE BANNER, on a row of it. The mark is centred on the band, so it lands on whichever
    // row that centre falls in — pinning row 0 would pin the arithmetic, not the requirement.
    const emblemRow = Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(drawingXml)?.[1] ?? NaN);
    assert.ok(
      Number.isFinite(emblemRow) && emblemRow < bannerRows.length,
      `${label}: the emblem is anchored to row ${emblemRow}, outside the ${bannerRows.length}-row `
        + "banner — it belongs on the band",
    );

    // AND NO WHITE TILE BEHIND IT. An earlier version put the on-LIGHT mark on the band and had to
    // draw a white rectangle under it so the black "SATO" would show. That rectangle read as a
    // sticker pasted on the banner, and getting its z-order wrong showed a blank white tile instead
    // of a logo. The on-dark lockup removes the need for it entirely — so if a shape ever comes
    // back, the wrong mark is being used again.
    // `<xdr:sp[\s>]` and not `<xdr:sp`: the shorter form also matches `<xdr:spPr>`, which EVERY
    // picture carries, so it would fail on a drawing that has no shape in it at all.
    assert.ok(
      !/<xdr:sp[\s>]/.test(drawingXml),
      `${label}: the banner has a shape behind the mark — with the on-dark lockup nothing needs to `
        + "sit under it, and a white tile there is the old on-light workaround coming back",
    );

    // AND IT IS THE COVER'S MARK, not the corner one. The siblings' emblem only has to be present;
    // this one carries the cover, and at their size it read as an afterthought dropped into a lot of
    // empty colour. Compared against a SIBLING'S OWN ext rather than a number typed in here, so the
    // claim stays true if the owner ever replaces the artwork.
    // ANCHORED TO THE CELLS. A twoCellAnchor is defined by two corners, so the mark belongs to the
    // banner's cells: it moves and resizes with them and cannot be dragged loose. `editAs="twoCell"`
    // is the part that makes it SIZE with them.
    assert.match(
      drawingXml,
      /<xdr:twoCellAnchor editAs="twoCell">/,
      `${label}: the emblem is not bound to its cells — it floats over them and can drift`,
    );
    assert.match(drawingXml, /<xdr:to>/, `${label}: a twoCellAnchor needs its second corner`);
    // A twoCellAnchor takes its size from the corners; an <xdr:ext> left over from the one-cell form
    // is a schema violation, and Excel answers those by repairing the workbook.
    assert.ok(
      !/<xdr:ext\b/.test(drawingXml),
      `${label}: a stale <xdr:ext> is left on a twoCellAnchor — Excel will offer to repair the file`,
    );

    const coverWidth = Number(/<a:ext\b[^>]*cx="(\d+)"/.exec(drawingXml)?.[1] ?? 0);
    let cornerWidth = 0;
    for (const name of Object.keys(opened.files).filter((one) => /^xl\/drawings\/drawing\d+\.xml$/.test(one))) {
      if (name === drawingPart) continue;
      const xml = await opened.file(name)!.async("string");
      const anchor = (xml.match(/<xdr:(twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:\1>/g) ?? [])
        .find((one) => one.includes("<xdr:pic"));
      const ext = anchor ? /<a:ext\b[^>]*cx="(\d+)"/.exec(anchor)?.[1] : null;
      if (ext) { cornerWidth = Number(ext); break; }
    }
    assert.ok(cornerWidth > 0, `${label}: no sibling emblem to compare the cover's mark against`);
    assert.ok(
      coverWidth > cornerWidth * 1.3,
      `${label}: the cover's mark is ${coverWidth} against the siblings' ${cornerWidth} — on the `
        + "banner it has to carry the page, not sit in it",
    );

    // Same class of defect: a dimension that stops short of the rows actually written.
    const declaredLastRow = Number(/<dimension ref="A1:B(\d+)"/.exec(sheet)![1]);
    const writtenLastRow = Math.max(...[...sheet.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])));
    assert.equal(
      declaredLastRow,
      writtenLastRow,
      `${label}: the contents dimension ends at row ${declaredLastRow} but row ${writtenLastRow} is written`,
    );

    // The closing note explains why three of the tabs listed above open empty until Excel
    // recalculates — without it, a pivot page reads as a broken export.
    assert.ok(
      /pivot tables/.test(sheet),
      `${label}: the contents page must say the matrix pages are pivots Excel builds on open`,
    );
  }


  // ── The Rep Card's Export PDF is a FORMULA, and it must read the right cell ─────────────────
  //
  // Every other Export PDF is a shape with a fixed hyperlink. The Rep Card cannot be: it draws
  // whichever rep its dropdown is set to, and a shape's link is written once at export. Only
  // `=HYPERLINK()` re-evaluates, which is what makes this possible in a .xlsx at all.
  //
  // THE BUG THIS PINS actually happened: the first version referenced `$B$2` on the assumption that
  // it held the resolved area code. `B2` is EMPTY. The formula fell straight to its own guard for
  // every rep, which on screen is indistinguishable from "nothing is selected" — a defect no amount
  // of reading the formula back would show, because the formula was well formed and Excel accepted
  // it. The index lives in `N1`.
  const repCardBook = await fillClosingEngine(fill, {
    macroFree: true,
    repCardPdfBase: "https://phoenix-hr.satopharma.com/pdf?sheet=Rep+Card&line=CNS&period=2026-07",
  });
  {
    const opened = await JSZip.loadAsync(repCardBook);
    const spec = (CLOSING_ENGINE_TEMPLATE_MANIFEST as unknown as { sheets: Record<string, { file: string }> }).sheets["Rep Card"];
    const sheet = await opened.file(spec.file)!.async("string");
    const cell = /<c r="F4"[^>]*>[\s\S]*?<\/c>/.exec(sheet)?.[0];
    assert.ok(cell, "the Rep Card needs its Export PDF cell — a shape cannot read the dropdown");

    const formula = (/<f[^>]*>([\s\S]*?)<\/f>/.exec(cell!) ?? [])[1] ?? "";
    assert.match(formula, /HYPERLINK\(/, "it has to be a HYPERLINK formula, not literal text");
    assert.match(formula, /\$N\$1/, "the selection is resolved through N1, the sheet's own MATCH index");
    assert.match(
      formula,
      /INDEX\(AreaBook\[Area Code\],\$N\$1\)/,
      "the area code is resolved here rather than read from a cell that may hold nothing",
    );
    assert.ok(
      !/\$B\$2/.test(formula),
      "B2 is EMPTY on this sheet — pointing at it sends every rep down the guard branch",
    );
    // `&` is both the formula's concatenation operator and an XML entity. Left unescaped it is a
    // workbook Excel offers to repair; escaped twice it reaches Excel as a literal `&amp;`.
    assert.ok(
      !/&(?!amp;|quot;|lt;|gt;|apos;)/.test(formula),
      "a raw & in the emitted XML is exactly the repair prompt this export exists to avoid",
    );
    // AND THIS ONE ACTUALLY HAPPENED. The formula was built with a replacement STRING, where `$1`
    // means capture group one -- so `$N$1` spliced the matched B4 cell into the middle of the
    // formula and shipped a workbook Excel has to repair. Well formed, accepted by every check that
    // read the formula rather than the emitted XML, and invisible until the bytes were read back.
    assert.ok(
      !/<c\s|<is>|<\/c>/.test(formula),
      `markup leaked into the formula -- a replacement string ate $1: ${formula.slice(0, 120)}`,
    );
    assert.match(formula, /\$N\$1\)/, "the INDEX must still close on $N$1, not on a mangled reference");

    // Excel is strict about cell order within a row and repairs a sheet whose cells descend.
    const row4 = /<row\b[^>]*\br="4"[^>]*>([\s\S]*?)<\/row>/.exec(sheet)?.[1] ?? "";
    const order = [...row4.matchAll(/<c r="([A-Z]+)4"/g)].map((m) => m[1]);
    assert.deepEqual(order, [...order].sort(), `row 4 cells must ascend, got ${order.join(",")}`);
  }
  {
    // The .xlsm keeps its macro and must not gain the formula: two Export PDFs on one sheet is a
    // worse answer than either alone.
    const opened = await JSZip.loadAsync(macroBook);
    const spec = (CLOSING_ENGINE_TEMPLATE_MANIFEST as unknown as { sheets: Record<string, { file: string }> }).sheets["Rep Card"];
    const sheet = await opened.file(spec.file)!.async("string");
    assert.ok(!/HYPERLINK\(/.test(sheet), "the .xlsm's Rep Card keeps PhxExportPdf and gains no formula link");
  }


  // ── The navigation bar: the owner's idea, in the owner's own button design ──────────────────
  //
  // Taken from a macro-free workbook of his own — 25 shapes, 0 macros, 17 hyperlinks, every one an
  // in-document jump. Asserted on the EMITTED package because all four ways this fails are package
  // faults Excel reports as "we found a problem with some content": a dangling relationship id, a
  // jump marked TargetMode="External" (which Excel refuses to follow), a live macro= surviving the
  // strip, and a button laid out past the sheet's own right edge.
  const navZip = await JSZip.loadAsync(linkedBook);
  const navRels = async (drawing: string) =>
    (await navZip.file(drawing.replace("drawings/", "drawings/_rels/") + ".rels")!.async("string"));

  // Which sheet each drawing belongs to. Needed for the self-link check below, and the reason that
  // check is worth the mapping: a bar offering the page you are already on is the one defect that
  // looks completely correct in the XML — every relationship resolves, every target is well formed.
  const navSheetOf = new Map<string, string>();
  {
    const workbook = await navZip.file("xl/workbook.xml")!.async("string");
    const workbookRels = await navZip.file("xl/_rels/workbook.xml.rels")!.async("string");
    const target = Object.fromEntries(
      [...workbookRels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    for (const sheet of workbook.matchAll(/<sheet name="([^"]+)"[^>]*r:id="(rId\d+)"/g)) {
      const path = `xl/${(target[sheet[2]] ?? "").replace(/^\/?(xl\/)?/, "")}`;
      const rels = navZip.file(path.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels"));
      if (!rels) continue;
      const drawing = /Target="\.\.\/(drawings\/drawing\d+\.xml)"/.exec(await rels.async("string"))?.[1];
      if (drawing) navSheetOf.set(`xl/${drawing}`, sheet[1]);
    }
  }

  let navTotal = 0;
  let selfLinks = 0;
  let printingNav = 0;
  const jumpTargets = new Set<string>();
  for (const file of navZip.file(/^xl\/drawings\/drawing\d+\.xml$/)) {
    const xml = await file.async("string");
    const rels = await navRels(file.name);
    for (const anchor of xml.match(/<xdr:twoCellAnchor\b[^>]*>[\s\S]*?<\/xdr:twoCellAnchor>/g) ?? []) {
      const id = /<a:hlinkClick[^>]*r:id="(rId\d+)"/.exec(anchor)?.[1];
      if (!id) continue;
      const rel = new RegExp(`<Relationship Id="${id}"[^>]*>`).exec(rels);
      assert.ok(rel, `${file.name}: hyperlink ${id} has no relationship — that IS the repair prompt`);
      const target = /Target="([^"]*)"/.exec(rel![0])![1];
      if (!target.startsWith("#")) continue;

      navTotal += 1;
      jumpTargets.add(target);
      if (`#'${navSheetOf.get(file.name) ?? ""}'!A1` === target) selfLinks += 1;
      assert.ok(
        !/TargetMode="External"/.test(rel![0]),
        `${file.name}: an in-document jump must NOT be External — Excel refuses to follow one that is`,
      );
      // A control is not content: the bar must not print, which it inherits by being a clone of a
      // button rather than a shape authored here.
      const clientData = /<xdr:clientData\b[^>]*\/>/.exec(anchor)?.[0] ?? "";
      if (!/fPrintsWithSheet="0"/.test(clientData)) printingNav += 1;
    }
  }
  assert.ok(navTotal >= 30, `every sheet should carry a bar; only ${navTotal} jump buttons were emitted`);
  assert.equal(printingNav, 0, "the navigation bar is a control and must stay off the printed page");
  // POSITIVE CONTROL for the check above. An empty map makes every comparison miss, so `selfLinks`
  // would read 0 for a workbook where every button linked to its own sheet -- the assertion would
  // pass by measuring nothing, which is exactly how this block failed review the first time.
  assert.ok(navSheetOf.size >= 10, `the drawing->sheet map is empty (${navSheetOf.size}); the self-link check would measure nothing`);
  assert.equal(selfLinks, 0, "a sheet never links to itself");
  for (const target of jumpTargets) {
    assert.match(target, /^#'[^']+'!A1$/, `a jump target must be #'Sheet'!A1, not ${target}`);
  }


  // ── The three matrix pages have to be READABLE WHERE A PIVOT IS NOT ─────────────────────────
  //
  // `Closing Matrix`, `Units Matrix` and `Area x Product` are pivot tables, and a pivot table stores
  // no cells of its own: Excel materialises the grid from the pivot cache on open. The template
  // ships that cache empty (its contents were one line's real areas and rep names) and sets
  // `refreshOnLoad="1"` to have Excel rebuild it. Desktop Excel does. **Excel for iOS/Android and
  // WPS Office cannot refresh a pivot table at all**, so all three pages were permanently blank on a
  // phone — 2, 2 and 6 cells, their title row and nothing else — with the numbers behind them
  // unreachable, because the `Data` sheet that feeds them is `veryHidden`.
  //
  // So the grid is written into the cells too. Desktop is unaffected: the refresh redraws over it.
  //
  // EVERYTHING HERE IS ASSERTED ON THE EMITTED PACKAGE, and it has to be, because this is the one
  // change in this file whose mistakes CANNOT be seen in Excel: the desktop refresh overwrites the
  // range on open, so a wrong layout, a wrong number or a stray row shows up only on a phone.
  // ── The grid specs must still describe the owner's actual pivots ────────────────────────────
  //
  // `PIVOT_GRID_SPECS` is a written-down copy of what `xl/pivotTables/*.xml` declare. The template
  // is the owner's file and he re-saves it, and if he ever changes a pivot's shape the desktop would
  // simply refresh to the new one while the phone kept showing the old layout — a divergence with no
  // error anywhere. So the copy is checked against the template itself.
  {
    const template = await JSZip.loadAsync(closingEngineTemplateBytes());
    const sheetOfPivot: Record<string, string> = {
      "pivotTable1.xml": "Closing Matrix",
      "pivotTable2.xml": "Units Matrix",
      "pivotTable3.xml": "Area x Product",
    };
    for (const [file, sheetName] of Object.entries(sheetOfPivot)) {
      const xml = await template.file(`xl/pivotTables/${file}`)!.async("string");
      const definition = /<pivotTableDefinition\b([^>]*)>/.exec(xml)![1]!;
      const spec = PIVOT_GRID_SPECS[sheetName]!;

      const axis = (tag: string): number[] => {
        const block = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? "";
        return [...block.matchAll(/<field x="(-?\d+)"\s*\/>/g)].map((m) => Number(m[1]));
      };
      assert.deepEqual(
        axis("rowFields"),
        spec.rowFields,
        `${sheetName}: the pivot groups its rows by different fields than the grid does`,
      );
      assert.deepEqual(
        axis("colFields").filter((one) => one >= 0),
        spec.columnField === null ? [] : [spec.columnField],
        `${sheetName}: the pivot spreads a different field across its columns than the grid does`,
      );
      // Names are trimmed on both sides: pivotTable3 calls its calculated field "Ach " with a
      // trailing space, which is invisible in every viewer and would fail an exact comparison.
      assert.deepEqual(
        [...(/<dataFields[^>]*>([\s\S]*?)<\/dataFields>/.exec(xml)?.[1] ?? "").matchAll(/<dataField\b([^>]*)\/>/g)]
          .map((m) => (/name="([^"]*)"/.exec(m[1]!)?.[1] ?? "").trim()),
        spec.measures.map((one) => one.label.trim()),
        `${sheetName}: the pivot measures something the grid does not`,
      );
      // The two flags that carry owner rules: no grand-total ROW on Area x Product, and no
      // total COLUMN on the Units Matrix, which is what stops units being added across products.
      assert.equal(
        !/rowGrandTotals="0"/.test(definition),
        spec.rowTotals,
        `${sheetName}: rowGrandTotals disagrees between the pivot and the grid`,
      );
      assert.equal(
        !/colGrandTotals="0"/.test(definition),
        spec.columnTotals,
        `${sheetName}: colGrandTotals disagrees between the pivot and the grid — on the Units Matrix this is the units rule`,
      );
    }
  }

  for (const [label, book] of [["xlsm", macroBook], ["xlsx", plainBook]] as const) {
    const opened = await JSZip.loadAsync(book);
    const workbook = await opened.file("xl/workbook.xml")!.async("string");
    const wbRels = await opened.file("xl/_rels/workbook.xml.rels")!.async("string");
    const target = Object.fromEntries(
      [...wbRels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    const partOf = (name: string): string | null => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = new RegExp(`<sheet name="${escaped}"[^>]*r:id="(rId\\d+)"`).exec(workbook);
      return m && target[m[1]] ? `xl/${target[m[1]]}` : null;
    };

    // The owner asked for no extra tab: the existing pages carry the numbers themselves.
    assert.equal(partOf("Matrix (Mobile)"), null, `${label}: no extra tab — the three matrix pages answer for themselves`);

    for (const sheetName of ["Closing Matrix", "Units Matrix", "Area x Product"]) {
      const part = partOf(sheetName);
      assert.ok(part, `${label}: ${sheetName} must be in the package`);
      const sheet = await opened.file(part!)!.async("string");

      // A ROW MUST BE READ WITH THE SELF-CLOSING FORM FIRST. An empty row is `<row r="2" .../>`, and
      // a pattern that only knows the paired form matches its opening tag then runs on to the NEXT
      // row's `</row>` — reporting a later row's content under an earlier row's number. That is
      // exactly what made the first reading of this grid claim the header had landed on row 2.
      const rowsByNumber = new Map<number, string>();
      for (const match of sheet.matchAll(/<row\b[^>]*?\/>|<row\b[^>]*?>[\s\S]*?<\/row>/g)) {
        const number = Number(/<row\b[^>]*?\br="(\d+)"/.exec(match[0])?.[1] ?? 0);
        if (number) rowsByNumber.set(number, match[0]);
      }
      const cellsOf = (rowNumber: number): Record<string, string> => {
        const out: Record<string, string> = {};
        const row = rowsByNumber.get(rowNumber) ?? "";
        for (const c of row.matchAll(/<c r="([A-Z]+)\d+"[^>]*?\/>|<c r="([A-Z]+)\d+"[^>]*?>([\s\S]*?)<\/c>/g)) {
          const column = c[1] ?? c[2]!;
          const body = c[3] ?? "";
          out[column] =
            [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")
            || (/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
        }
        return out;
      };

      // The pivot's OWN geometry decides where the grid starts and how many header rows precede the
      // data. It is read from the pivot part rather than assumed here, because the template is the
      // owner's and he re-saves it — and a shifted header is invisible on a desktop.
      const sheetRels = await opened.file(part!.replace("worksheets/", "worksheets/_rels/") + ".rels")!.async("string");
      const pivotPart = /Target="\.\.\/(pivotTables\/pivotTable\d+\.xml)"/.exec(sheetRels)![1];
      const pivotXml = await opened.file(`xl/${pivotPart}`)!.async("string");
      const location = /<location\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*firstDataRow="(\d+)"/.exec(pivotXml);
      assert.ok(location, `${label}: ${sheetName} lost its pivot location`);
      const firstRow = Number(location![2]);
      const firstDataRow = firstRow + Number(location![5]);

      assert.ok(
        (sheet.match(/<c[ >]/g) ?? []).length > 30,
        `${label}: ${sheetName} still carries almost no cells — this is the blank-on-a-phone defect`,
      );

      // THE ANTI-STRAY GUARANTEE, and the reason this assertion matters more than it looks. The
      // stored `location` is the range the desktop refresh redraws into. A grid written LARGER than
      // it would leave our rows stranded on the desktop below a working pivot — a worse defect than
      // the one being fixed, and the one the owner would see first. So the declared extent has to be
      // exactly what was written.
      const lastWrittenRow = Math.max(...[...rowsByNumber.keys()]);
      assert.equal(
        Number(location![4]),
        lastWrittenRow,
        `${label}: ${sheetName} declares its pivot ending at row ${location![4]} but the grid runs to ${lastWrittenRow}`,
      );

      // The grid must start exactly at the pivot's own first row, never above it: rows 1 and 2 are
      // the title and the completeness note, and overwriting those loses the month and the caveat.
      assert.ok(rowsByNumber.has(firstRow), `${label}: ${sheetName} has no row at the pivot's own first row`);
      assert.match(cellsOf(1).A ?? "", /^\S/, `${label}: ${sheetName} must keep its title on row 1`);

      // ── THE FROZEN BLOCK MUST BE NARROWER THAN A PHONE ──────────────────────────────────────
      //
      // Both matrices freeze at `xSplit="2"`, pinning Region and Area on screen. The template gave
      // column B — an AREA NAME, "Cairo 1" — a width of 86.71 characters, so the pinned block came
      // to 734px against a 375px phone: TWICE THE SCREEN. Scrolling right then never reaches a
      // number, because the frozen columns never let go. Writing the grid into the cells fixed
      // nothing a reader could see while that held.
      //
      // Measured in pixels, with Excel's own conversion — px = round(width * 7) + 5, the same one
      // the Rep Card's emblem check uses — because character units hide the problem completely.
      const runs = [...(/<cols>[\s\S]*?<\/cols>/.exec(sheet)?.[0] ?? "").matchAll(/<col\b[^>]*?\/>/g)].map((one) => ({
        max: Number(/max="(\d+)"/.exec(one[0])?.[1] ?? 0),
        min: Number(/min="(\d+)"/.exec(one[0])?.[1] ?? 0),
        width: Number(/width="([\d.]+)"/.exec(one[0])?.[1] ?? 9.140625),
      }));
      const xSplit = Number(/<pane\b[^>]*xSplit="(\d+)"/.exec(sheet)?.[1] ?? 0);
      let frozenPx = 0;
      for (let column = 1; column <= xSplit; column += 1) {
        const run = runs.find((one) => column >= one.min && column <= one.max);
        frozenPx += Math.round((run ? run.width : 9.140625) * 7) + 5;
      }
      assert.ok(
        frozenPx < 375,
        `${label}: ${sheetName} pins ${frozenPx}px of frozen columns on a 375px phone — the data behind them is unreachable`,
      );

      // ── A ROW LABEL MUST WRAP, BECAUSE THE REAL NAMES DO NOT FIT ────────────────────────────
      //
      // Production carries "Dokki - Mohandseen - Bolak" (26 characters) and "Imbaba - Imbaba
      // Centers" (23). The area column is followed by a NUMBER, and a text cell only overflows into
      // an EMPTY neighbour — so at any width under 26 those names are silently CUT OFF. Widening to
      // fit takes the frozen block past the width of the screen, which is the defect above. So they
      // wrap, and the format that does it is asserted on the emitted package rather than assumed.
      const labelStyles = new Set(
        [...(rowsByNumber.get(firstDataRow) ?? "").matchAll(/<c r="[AB]\d+" s="(\d+)"[^>]*t="inlineStr"/g)].map((one) => one[1]!),
      );
      assert.ok(labelStyles.size > 0, `${label}: ${sheetName} has no row labels on its first data row`);
      const cellXfs = stylesXml.slice(stylesXml.indexOf(">", stylesXml.indexOf("<cellXfs")) + 1, stylesXml.indexOf("</cellXfs>"));
      const xfs = [...cellXfs.matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*?>[\s\S]*?<\/xf>/g)].map((one) => one[0]);
      for (const index of labelStyles) {
        assert.match(
          xfs[Number(index)] ?? "",
          /wrapText="1"/,
          `${label}: ${sheetName} row labels use format ${index}, which does not wrap — a long area name is cut off`,
        );
      }

      // NO ASSERTION HERE ON <cellXfs count>. One was written and then removed deliberately: the
      // count is only ever produced by `appendCellXf`, which recomputes it from the <xf> elements
      // actually present, so a disagreement cannot arise while that stays the single writer. Two
      // attempts to break it both came back green — the second because a LATER appendCellXf call,
      // in addIndexSheet, repaired the corruption downstream before the workbook was written.
      // An assertion that cannot fail is false confidence rather than coverage.
    }

    // ── The numbers, against the rest of the workbook ─────────────────────────────────────────
    //
    // The grand-total row is checked against the OVERVIEW rather than against the fixture, which is
    // the stronger test: the two are computed by different code down different paths, so agreement
    // means the grid is a true second view of the month rather than a plausible one.
    const matrix = await opened.file(partOf("Closing Matrix")!)!.async("string");
    const overview = await opened.file(partOf("Overview")!)!.async("string");
    const overviewCells = /<row r="5"[^>]*>([\s\S]*?)<\/row>/.exec(overview)?.[1] ?? "";
    const overviewSales = Number(/<c r="B5"[^>]*><v>([\d.]+)<\/v>/.exec(overviewCells)?.[1] ?? -1);
    const overviewTarget = Number(/<c r="D5"[^>]*><v>([\d.]+)<\/v>/.exec(overviewCells)?.[1] ?? -1);
    assert.ok(overviewSales > 0, "the Overview must carry the month's sales value for this to compare against");

    const grand = /<row\b[^>]*?>(?:(?!<\/row>)[\s\S])*?Grand Total[\s\S]*?<\/row>/.exec(matrix)?.[0] ?? "";
    assert.ok(grand, `${label}: the Closing Matrix needs its Grand Total row — rowGrandTotals is on`);
    const grandNumbers = [...grand.matchAll(/<v>([\d.]+)<\/v>/g)].map((m) => Number(m[1]));
    assert.ok(
      grandNumbers.includes(overviewSales),
      `${label}: the matrix grand total does not carry the Overview's sales value (${overviewSales})`,
    );
    assert.ok(
      grandNumbers.includes(overviewTarget),
      `${label}: the matrix grand total does not carry the Overview's target value (${overviewTarget})`,
    );

    // NO TARGET IS WORDS, NEVER A ZERO — the owner's rule, and the live pivot says it a way that a
    // phone cannot: its `Ach` field returns -1 and conditional formatting hides it. Cairo 2 sells
    // with no target at all, so its target and achievement cells must say so.
    assert.ok(
      /Cairo 2/.test(matrix) && /no target/.test(matrix),
      `${label}: an area with no target must read "no target", never be scored 0`,
    );
    assert.ok(
      !/<c r="[A-Z]+11"[^>]*>-1</.test(matrix),
      `${label}: -1 is the live pivot's hidden sentinel for "no target" and must never be printed as a number`,
    );

    // ── UNITS OF DIFFERENT PRODUCTS ARE NEVER ADDED ───────────────────────────────────────────
    //
    // The Units Matrix is where that rule is easiest to break, and it is safe here structurally
    // rather than by memory: every unit column belongs to ONE product, so a column total sums one
    // product code across areas. What must never appear is a total column ACROSS products — and the
    // pivot itself says so by carrying `colGrandTotals="0"`, which is why the spec reads that flag
    // instead of setting it by hand.
    const units = await opened.file(partOf("Units Matrix")!)!.async("string");
    assert.ok(
      !/Total Units/.test(units),
      `${label}: a "Total Units" column would add different products together — colGrandTotals is off for exactly this reason`,
    );
    // Cairo 1's three products hold 1,000 + 200 + 50 units. That sum must appear nowhere.
    assert.ok(
      ![...units.matchAll(/<v>([\d.]+)<\/v>/g)].map((m) => Number(m[1])).includes(1250),
      `${label}: 1,250 is Cairo 1's units summed across three products`,
    );
    // But summing ONE product across areas is legitimate and must still happen: Tebofortin 40mg is
    // 1,000 in Cairo 1 and 80 in Cairo 2, so the Cairo subtotal is 1,080.
    assert.ok(
      [...units.matchAll(/<v>([\d.]+)<\/v>/g)].map((m) => Number(m[1])).includes(1080),
      `${label}: one product summed across areas is legitimate and the region subtotal must show it`,
    );

    // ── The engine is untouched ───────────────────────────────────────────────────────────────
    //
    // The entire point of writing cells rather than rebuilding these sheets: the pivots, the
    // slicers and the macro bar all survive, so the desktop keeps its Region slicer and its fold.
    const parts = Object.keys(opened.files);
    assert.equal(parts.filter((name) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(name)).length, 3, `${label}: three pivot tables`);
    assert.equal(parts.filter((name) => /^xl\/slicers\/slicer\d+\.xml$/.test(name)).length, 2, `${label}: both Region slicers`);
    const cacheRecords = await opened.file("xl/pivotCache/pivotCacheRecords1.xml")!.async("string");
    assert.equal(
      (cacheRecords.match(/<r>/g) ?? []).length,
      0,
      `${label}: the cache still ships empty and is still rebuilt on open — the desktop path is unchanged`,
    );
    const cacheDefinition = await opened.file("xl/pivotCache/pivotCacheDefinition1.xml")!.async("string");
    assert.match(
      cacheDefinition,
      /refreshOnLoad="1"/,
      `${label}: without this the desktop would show OUR grid frozen, instead of a live pivot`,
    );

    // ── Every formula ships with no cached value ──────────────────────────────────────────────
    //
    // The Rep Card is 35 of them and the contents page 12 more, and there is no `xl/calcChain.xml`.
    // Desktop Excel builds a chain and calculates regardless, which is why this went unnoticed; a
    // reader that does not shows those cells blank.
    //
    // The COUNT is asserted as well as the attribute: the first version of this matched `<calcPr`
    // with a mangled escape, found nothing, and fell to its own fallback branch — appending a SECOND
    // <calcPr> after </extLst>, a schema violation and exactly the repair prompt this export has
    // already been through once.
    assert.equal(
      (workbook.match(/<calcPr/g) ?? []).length,
      1,
      `${label}: a workbook carries exactly one <calcPr>; two is a package Excel offers to repair`,
    );
    assert.match(
      workbook,
      /<calcPr[^>]*fullCalcOnLoad="1"/,
      `${label}: without this the Rep Card and the contents links are blank wherever the reader does not calculate`,
    );
  }

}
