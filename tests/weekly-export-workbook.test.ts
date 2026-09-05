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

/** The emitted pivot cache definition, or null when the build carries no pivot. */
async function pivotCacheDefinition(buffer: Buffer): Promise<string | null> {
  const zip = await JSZip.loadAsync(buffer);
  const part = zip.file("xl/pivotCache/pivotCacheDefinition1.xml");
  return part ? await part.async("string") : null;
}

/** The emitted pivot cache records, or null when the build carries no pivot. */
async function pivotCacheRecords(buffer: Buffer): Promise<string | null> {
  const zip = await JSZip.loadAsync(buffer);
  const part = zip.file("xl/pivotCache/pivotCacheRecords1.xml");
  return part ? await part.async("string") : null;
}

/** The emitted pivot table definition, or null when the build carries no pivot. */
async function pivotTableDefinition(buffer: Buffer): Promise<string | null> {
  const zip = await JSZip.loadAsync(buffer);
  const part = zip.file("xl/pivotTables/pivotTable1.xml");
  return part ? await part.async("string") : null;
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
  // ── THE NATIVE PIVOT OPENS ON THIS MONTH'S DATA, NOT THE BUILD'S ────────────
  //
  // ExcelForge's PivotTable interface takes a sheet and a RANGE and nothing else: no refresh flag,
  // no table source. So both of these are written by rewriting the emitted cache part, and both are
  // therefore invisible in the builder's source — the only place to check them is the file.
  //
  // WHY THEY MATTER, and they are two different failures:
  //  - without `refreshOnLoad`, the pivot renders the records cached at BUILD time. A workbook
  //    rebuilt from newer data opens showing the old numbers, with nothing on screen saying so. A
  //    stale pivot is indistinguishable from a current one, which is what makes it worth a test.
  //  - a hard `A1:O{lastRow}` source is right on the day it is written and wrong the moment a row
  //    is added to Data. The table grows on its own.
  const cacheXml = await pivotCacheDefinition(interactive);
  assert.ok(cacheXml, "the interactive build carries a pivot cache");
  assert.match(
    cacheXml!,
    /refreshOnLoad="1"/,
    "the pivot must refresh when the file opens, or it renders the data cached at build time and " +
      "nothing on screen says the numbers are old",
  );
  assert.match(
    cacheXml!,
    /<worksheetSource[^>]*name="tblWeekly"/,
    "the pivot cache must be sourced from the tblWeekly TABLE, not a fixed range — a range does not " +
      "grow when a row is added to the Data sheet",
  );
  // A table-sourced cache carries neither of the range form's attributes. Leaving one behind is
  // what makes Excel repair the part, which drops the pivot silently.
  const source = /<worksheetSource[^>]*\/>/.exec(cacheXml!)?.[0] ?? "";
  assert.ok(!source.includes(" ref=") && !source.includes(" sheet="), `the table source carries no ref or sheet: ${source}`);

  // The cache's own record count still matches what it holds — the rewrite touches the source and
  // the refresh flag, and must not disturb the records.
  const declared = Number(/recordCount="(\d+)"/.exec(cacheXml!)?.[1] ?? "-1");
  const held = ((await pivotCacheRecords(interactive)) ?? "").match(/<r>/g)?.length ?? -2;
  assert.equal(declared, held, "the cache declares exactly the records it holds");

  // The non-interactive build carries no pivot at all, so the rewrite must be a clean no-op there
  // rather than something that fails or half-writes a part.
  assert.equal(await pivotCacheDefinition(plain), null, "the non-interactive build carries no pivot cache to patch");

  // …and the cache is still WHOLE, which the record count above only partly proves.
  //
  // `refreshOnLoad="1"` is NOT a licence to empty the cache. Excel validates the pivots against it
  // BEFORE it honours the refresh, so a cleared field list or a stripped <sharedItems> pool leaves
  // every <item x="n"/> in pivotTable1.xml pointing into nothing — Excel removes the view and calls
  // the workbook damaged. That is the bug that put "We found a problem with some content" on every
  // premium closing export until 2026-09-02; the long note on `restorePivotCacheSharedItems` in
  // src/lib/sales/closing-engine-fill.ts is the account of it.
  //
  // The FIELD half is the one a record count cannot see: a cache can declare its records honestly
  // and still have lost the field the pivot lays out on, and that is invisible from the sheet —
  // the pivot renders from its own stale layout until the refresh, and only then collapses. These
  // three assertions are what fire if the rewrite above is ever "simplified" into a cache wipe.
  const declaredFields = Number(/<cacheFields count="(\d+)"/.exec(cacheXml!)?.[1] ?? "-1");
  const heldFields = cacheXml!.match(/<cacheField /g)?.length ?? -2;
  assert.equal(declaredFields, heldFields, `the cache declares ${declaredFields} fields and holds ${heldFields}`);

  const laidOut = Number(/<pivotFields count="(\d+)"/.exec((await pivotTableDefinition(interactive)) ?? "")?.[1] ?? "-1");
  assert.equal(laidOut, heldFields, `the pivot lays out ${laidOut} fields and the cache holds ${heldFields}`);

  assert.match(
    cacheXml!,
    /<sharedItems[^>]*>[\s\S]*?<\/sharedItems>/,
    "the shared-item pools must still hold their values — an emptied pool orphans every <item x=..> " +
      "the pivot enumerates, and Excel drops the view rather than refreshing it",
  );
}
