import assert from "node:assert/strict";

import JSZip from "jszip";

import { HOUSE_DOCUMENT_STANDARD, HOUSE_XLSX_COLORS } from "../src/lib/export/house-xlsx-palette.ts";
import { buildWeeklyExportWorkbook } from "../src/lib/sales/weekly/export-workbook.ts";
import { WEEKLY_TRACKED_SCOPE_NOTE } from "../src/lib/sales/weekly/tracked-lines.ts";
import type { WeeklyDashboard, WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

export const GENERATED_AT = "2026-06-29 12:00 UTC";

function isXlsx(buffer: Buffer): boolean {
  // .xlsx is a zip → first two bytes are 'P' 'K' (0x50 0x4B)
  return buffer.length > 100 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

async function sheetCount(buffer: Buffer): Promise<number> {
  const zip = await JSZip.loadAsync(buffer);
  const wbXml = await zip.file("xl/workbook.xml")?.async("string");
  return (wbXml?.match(/<sheet\b/g) ?? []).length;
}

/** Detects the XML-illegal control bytes a stray name could smuggle into the package. */
const CTRL = (() => { let s = ""; for (let i = 0; i <= 0x1f; i += 1) { if (i === 9 || i === 10 || i === 13) continue; s += String.fromCharCode(i); } return new RegExp(`[${s}]`); })();
async function hasControlBytes(buffer: Buffer): Promise<boolean> {
  const zip = await JSZip.loadAsync(buffer);
  for (const name of Object.keys(zip.files)) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const x = await zip.files[name].async("string");
    if (CTRL.test(x)) return true;
  }
  return false;
}

function factRows(): WeeklyFactExportRow[] {
  const rows: WeeklyFactExportRow[] = [];
  const weeks = [
    { cycleMonth: "2026-05-01", weekNumber: 1, weekStart: "2026-05-04" },
    { cycleMonth: "2026-05-01", weekNumber: 2, weekStart: "2026-05-11" },
  ];
  const regions = [{ c: "D1", n: "Delta 1" }, { c: "D2", n: "Delta 2" }];
  // A product name carrying punctuation + a control byte — cleanText must neutralise both.
  const products = [
    { c: "SAG", n: "Saginkgo", line: "Anti infective" },
    { c: "ROY", n: `Royafloxacin, "500mg" & co` + String.fromCharCode(7), line: "" },
  ];
  let i = 0;
  for (const w of weeks) for (const r of regions) for (const p of products) {
    i += 1;
    if (r.c === "D2" && p.c === "SAG") continue; // a real zero-sales gap
    rows.push({
      distributorCode: "IS", distributorName: "Ibn Sina",
      productCode: p.c, productName: p.n, line: p.line,
      regionCode: r.c, regionName: r.n, areaCode: null,
      branchCode: `B${i % 3}`, branchName: `Branch ${i % 3}`,
      cycleMonth: w.cycleMonth, weekNumber: w.weekNumber, weekStart: w.weekStart,
      batchId: `batch-${w.weekNumber}`, family: p.c === "SAG" ? "Saginko" : "Royafloxacin",
      salesValue: 1000 + i * 11, salesUnits: 10 + i, stockUnits: 4 + (i % 7),
    });
  }
  // Null-week row must not crash and must be invisible to "W{n}" SUMIFS.
  rows.push({ distributorCode: "IS", distributorName: "Ibn Sina", productCode: "SAG", productName: "Saginkgo", line: "Anti infective", regionCode: "D1", regionName: "Delta 1", areaCode: null, branchCode: "B1", branchName: "Branch 1", cycleMonth: "2026-05-01", weekNumber: null, weekStart: "2026-05-18", batchId: "batch-untagged", family: "Saginko", salesValue: 500, salesUnits: 5, stockUnits: 2 });
  return rows;
}

export function sampleDashboard(empty = false): WeeklyDashboard {
  const rows = empty ? [] : factRows();
  const regions = empty ? [] : [{ code: "D1", name: "Delta 1" }, { code: "D2", name: "Delta 2" }].map((r) => ({ ...r, salesValue: 0, salesUnits: 0, stockUnits: 0, share: 0 }));
  const products = empty ? [] : [{ code: "SAG", name: "Saginkgo" }, { code: "ROY", name: `Royafloxacin, "500mg" & co` }].map((p) => ({ ...p, salesValue: 0, salesUnits: 0, stockUnits: 0, share: 0 }));
  const dists = empty ? [] : [{ code: "IS", name: "Ibn Sina" }].map((d) => ({ ...d, salesValue: 0, salesUnits: 0, stockUnits: 0, share: 0 }));
  const branches = empty ? [] : [{ code: "B1", name: "Branch 1", regionName: "Delta 1" }].map((b) => ({ ...b, salesValue: 0, salesUnits: 0, stockUnits: 0, share: 0 }));
  const trend = empty ? [] : [
    { weekStart: "2026-05-04", weekNumber: 1, cycleMonth: "2026-05-01", salesValue: 5000, salesUnits: 50, stockUnits: 0, byDistributor: [] },
    { weekStart: "2026-05-11", weekNumber: 2, cycleMonth: "2026-05-01", salesValue: 6000, salesUnits: 60, stockUnits: 0, byDistributor: [] },
  ];
  const weekComparison = empty ? [] : [
    { cycleMonth: "2026-05-01", weekNumber: 1, weekStart: "2026-05-04", salesValue: 5000, salesUnits: 50, stockUnits: 0, deltaValuePct: null, spansGap: false },
    { cycleMonth: "2026-05-01", weekNumber: 2, weekStart: "2026-05-11", salesValue: 6000, salesUnits: 60, stockUnits: 0, deltaValuePct: 0.2, spansGap: false },
  ];
  return {
    weekStart: null, priorWeekStart: null, availableWeeks: [], weekGroupMembers: {},
    trackedScope: { active: true, note: WEEKLY_TRACKED_SCOPE_NOTE },
    availableLines: ["Anti infective"], availableRegions: [], availableProducts: [], availableMonths: [], availableWeekNumbers: [],
    availableUploads: [],
    distributors: dists.map((d) => ({ code: d.code, name: d.name })),
    appliedFilters: {
      weekStart: null, weekStarts: [], allWeeks: true,
      distributorCode: null, regionCode: null, productCode: null, lineCode: null,
      productCodes: [], productFilterMode: "include", distributorCodes: [], distributorFilterMode: "include",
      regionCodes: [], regionFilterMode: "include", lineCodes: [], lineFilterMode: "include",
      cycleMonths: [], cycleMonthMode: "include", weekNumbers: [], weekNumberMode: "include",
    },
    kpis: { salesValue: 0, salesUnits: 0, stockUnits: 0, branchCount: branches.length, regionCount: regions.length, productCount: products.length, distributorCount: dists.length },
    compare: { salesValue: { current: 0, prior: null, pct: null }, salesUnits: { current: 0, prior: null, pct: null }, stockUnits: { current: 0, prior: null, pct: null } },
    regions, products, distributorBreakdown: dists, branchBreakdown: branches,
    zeroSalesBranches: [], weekComparison,
    sources: empty ? [] : [{ distributorCode: "IS", distributorName: "Ibn Sina", cycleMonth: "2026-05-01", weekNumber: 1, weekStart: "2026-05-04", fileName: "ibnsina.xlsx" }],
    trend,
    factRows: rows,
  };
}

/**
 * Every SOLID fill in the emitted package's style table, and every font family it names.
 *
 * Read from `styles.xml` rather than by walking cells: ExcelForge writes one style entry per
 * distinct look, so this is the whole vocabulary of the workbook in a dozen entries rather than
 * hundreds of thousands of cell lookups — and a fill that exists in the table but is applied to
 * nothing is still a fill somebody meant to use.
 */
async function styleVocabulary(buffer: Buffer): Promise<{ fills: string[]; fonts: string[] }> {
  const zip = await JSZip.loadAsync(buffer);
  const styles = (await zip.file("xl/styles.xml")?.async("string")) ?? "";
  const fills = [...styles.matchAll(/<patternFill patternType="solid"><fgColor rgb="([0-9A-Fa-f]{8})"/g)]
    .map((match) => match[1].toUpperCase());
  const fonts = [...new Set([...styles.matchAll(/<name val="([^"]+)"\/>/g)].map((match) => match[1]))];
  return { fills, fonts };
}

/** Every string the workbook renders, shared strings and inline strings alike. */
async function allText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  let text = "";
  for (const name of Object.keys(zip.files)) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    text += await zip.files[name].async("string");
  }
  return text;
}

export async function runWeeklyExportTests() {
  // Interactive build: valid xlsx, 23 sheets (incl. the native pivot), no control bytes.
  const interactive = await buildWeeklyExportWorkbook(sampleDashboard(), GENERATED_AT, { interactive: true });
  assert.ok(isXlsx(interactive), "interactive workbook must be a valid .xlsx (zip) buffer");
  assert.equal(await sheetCount(interactive), 23, "interactive workbook should have 23 sheets");
  assert.equal(await hasControlBytes(interactive), false, "workbook must contain no XML-illegal control bytes");

  // Non-interactive build: the native pivot sheet is dropped → 22 sheets.
  const plain = await buildWeeklyExportWorkbook(sampleDashboard(), GENERATED_AT, { interactive: false });
  assert.ok(isXlsx(plain), "non-interactive workbook must be a valid .xlsx (zip) buffer");
  assert.equal(await sheetCount(plain), 22, "non-interactive workbook should drop the pivot (22 sheets)");

  // Empty dashboard: still a valid, openable workbook (waterfall + week-comparison self-skip).
  const blank = await buildWeeklyExportWorkbook(sampleDashboard(true), GENERATED_AT, { interactive: true });
  assert.ok(isXlsx(blank), "empty-data workbook must still be a valid .xlsx (zip) buffer");
  assert.equal(await hasControlBytes(blank), false, "empty workbook must contain no control bytes");
  // ── THE HOUSE IDENTITY, ASSERTED ON THE EMITTED PACKAGE ─────────────────────
  //
  // This workbook used to be orange and slate: a filled slate band per sheet header, a slate band per
  // region group, six KPI tiles on filled slate, a warm-orange zebra and orange gridlines. Under
  // SATO-DIS-2026-01 v1.0 colour is carried by lines and type, and the CHROME may hold only two
  // fills — the Brand Blue masthead rule and the 6% zebra row.
  //
  // The conditional formats are deliberately NOT chrome and keep their fills: a colour scale IS the
  // analysis on a matrix sheet, and there is no type-only form of a heatmap. Those are re-pointed
  // into the palette where they read MAGNITUDE and keep a signal colour where they read a VERDICT,
  // which is why the allowed set below is the two chrome fills plus exactly three verdict marks.
  const vocabulary = await styleVocabulary(interactive);
  const allowedFills = new Set([
    HOUSE_XLSX_COLORS.blue, // the masthead rule — and the low-outlier mark, which shares it
    HOUSE_XLSX_COLORS.tint, // the zebra row: the format's one permitted chrome fill
    HOUSE_XLSX_COLORS.flag, // the alarm mark on a zero cell
    "FF9A5B08", // the at-target mark
  ]);
  const strayFills = [...new Set(vocabulary.fills)].filter((argb) => !allowedFills.has(argb));
  assert.deepEqual(
    strayFills,
    [],
    "the ink rule: colour is carried by lines and type, never by filled area. This workbook's style " +
      "table may hold only the Brand Blue rule, the zebra, and the two data-driven verdict marks. " +
      `Found: ${strayFills.join(", ")}`,
  );

  // ...and the two that must be PRESENT, so the assertion above cannot pass on a workbook that lost
  // its styling altogether — which is what a broken builder would also look like.
  assert.ok(vocabulary.fills.includes(HOUSE_XLSX_COLORS.blue), "every sheet carries the Brand Blue masthead rule");
  assert.ok(vocabulary.fills.includes(HOUSE_XLSX_COLORS.tint), "the zebra row is in use");

  // Every font this builder sets is the house face. `Calibri` survives at style index 0 only, which
  // is ExcelForge's mandatory OOXML default for an unstyled cell and is not ours to change — the
  // library exposes no default-font setting, so asserting its absence would be asserting a fiction.
  const setFonts = vocabulary.fonts.filter((name) => name !== "Calibri");
  assert.deepEqual(
    [...setFonts].sort(),
    ["Aptos", "Aptos Display"],
    `every font this builder sets is the house face; found ${vocabulary.fonts.join(", ")}`,
  );

  // A company document wears the COMPANY's identity, never the app's.
  const text = await allText(interactive);
  assert.ok(
    !/phoenix/i.test(text),
    "the weekly BI workbook must not print the app's name anywhere — it is a Sato Pharma document",
  );
  assert.ok(text.includes(HOUSE_DOCUMENT_STANDARD), `the workbook carries its document standard, ${HOUSE_DOCUMENT_STANDARD}`);
}

// ── The native pivot's cache: refreshes on open, and reads the table ──────────────────────────
//
// ASSERTED ON THE EMITTED PACKAGE, because the source cannot answer either question. ExcelForge's
// `PivotTable` input carries no refresh setting and no table-source option at all, so both of these
// are written by `hardenPivotCaches` into the zip after `buildBase64()` — reading
// `export-workbook.ts` tells you only that the call happens, never that the bytes came out right.
//
// What each defect looked like before the fix (both shipped on `main`, both reported by
// `node scripts/check-workbook-integrity.mjs`):
//
//   <pivotCacheDefinition ... recordCount="7">                      <- opens showing BUILD-TIME data
//     <cacheSource type="worksheet"><worksheetSource ref="A1:O8" sheet="Data"/></cacheSource>
//                                                                   <- pinned to 7 rows for ever
//
// The stale half is the one a reader is hurt by: a cross-tab rebuilt from a cache frozen at build
// time looks exactly like a live one, with nothing on screen saying otherwise.
export async function runWeeklyPivotCacheTests() {
  const interactive = await buildWeeklyExportWorkbook(sampleDashboard(), GENERATED_AT, { interactive: true });
  const zip = await JSZip.loadAsync(interactive);

  const cacheDef = await zip.file("xl/pivotCache/pivotCacheDefinition1.xml")?.async("string");
  assert.ok(cacheDef, "the interactive build must carry a pivot cache definition");

  // 1. Refresh on open.
  assert.match(
    cacheDef,
    /<pivotCacheDefinition[^>]*\srefreshOnLoad="1"/,
    "the pivot cache must be set to refresh on load, or the pivot opens showing whatever was cached " +
      "at build time — a stale cross-tab that looks exactly like a live one",
  );
  assert.equal(
    (cacheDef.match(/refreshOnLoad=/g) ?? []).length,
    1,
    "refreshOnLoad is written once, never doubled onto a tag that already carries it",
  );

  // 2. The source is the Data sheet's own Table, by NAME — that is what makes it grow with the rows.
  const source = (cacheDef.match(/<worksheetSource\b[^>]*\/>/) ?? [])[0] ?? "";
  const tableXml = (await zip.file("xl/tables/table1.xml")?.async("string")) ?? "";
  const tableName = (tableXml.match(/\sname="([^"]*)"/) ?? [])[1];
  assert.equal(tableName, "tblWeekly", "the Data sheet's Excel Table is the one the pivot must read");
  assert.equal(
    source,
    '<worksheetSource name="tblWeekly"/>',
    "the pivot cache must name the Data table rather than the fixed range the file happened to be " +
      `built with — a raw ref never grows with the data. Found: ${source}`,
  );

  // 3. …and the cache is still WHOLE. `refreshOnLoad="1"` is not a licence to empty it: Excel
  //    validates the pivots against the cache BEFORE it honours the refresh, so a cleared record
  //    set or a stripped <sharedItems> pool leaves every <item x="n"/> in pivotTable1.xml pointing
  //    into nothing — Excel then removes the view and calls the workbook damaged. That is the bug
  //    that prompted "We found a problem with some content" on every premium closing export until
  //    2026-09-02 (see restorePivotCacheSharedItems in src/lib/sales/closing-engine-fill.ts). This
  //    is the assertion that fires if someone ever "simplifies" the hardening into a cache wipe.
  const records = (await zip.file("xl/pivotCache/pivotCacheRecords1.xml")?.async("string")) ?? "";
  const declaredRecords = Number((cacheDef.match(/recordCount="(\d+)"/) ?? [])[1] ?? 0);
  const heldRecords = (records.match(/<r>/g) ?? []).length;
  assert.ok(heldRecords > 0, "the pivot cache must still hold its records — an emptied cache is removed by Excel");
  assert.equal(declaredRecords, heldRecords, `cache declares ${declaredRecords} records but holds ${heldRecords}`);

  const declaredFields = Number((cacheDef.match(/<cacheFields count="(\d+)"/) ?? [])[1] ?? 0);
  const heldFields = (cacheDef.match(/<cacheField\b/g) ?? []).length;
  assert.equal(declaredFields, heldFields, `cache declares ${declaredFields} fields but holds ${heldFields}`);

  const pivotXml = (await zip.file("xl/pivotTables/pivotTable1.xml")?.async("string")) ?? "";
  const laidOut = Number((pivotXml.match(/<pivotFields count="(\d+)"/) ?? [])[1] ?? 0);
  assert.equal(laidOut, heldFields, `the pivot lays out ${laidOut} fields but the cache holds ${heldFields}`);
  assert.ok(
    /<sharedItems[^>]*>[\s\S]*?<\/sharedItems>/.test(cacheDef),
    "the shared-items pools must still be populated — an emptied pool orphans every <item x=..> the pivot enumerates",
  );

  // 4. The non-interactive build has no pivot at all, so nothing above can apply to it. It is
  //    returned as the very bytes ExcelForge produced and must stay a valid, pivot-free workbook.
  const plain = await buildWeeklyExportWorkbook(sampleDashboard(), GENERATED_AT, { interactive: false });
  const plainZip = await JSZip.loadAsync(plain);
  assert.equal(
    Object.keys(plainZip.files).filter((n) => n.startsWith("xl/pivotCache/")).length,
    0,
    "the non-interactive build carries no pivot cache",
  );
}
