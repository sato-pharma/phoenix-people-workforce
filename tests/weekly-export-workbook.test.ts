import assert from "node:assert/strict";

import JSZip from "jszip";

import { buildWeeklyExportWorkbook } from "../src/lib/sales/weekly/export-workbook.ts";
import type { WeeklyDashboard, WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

const GENERATED_AT = "2026-06-29 12:00 UTC";

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
      regionCode: r.c, regionName: r.n,
      branchCode: `B${i % 3}`, branchName: `Branch ${i % 3}`,
      cycleMonth: w.cycleMonth, weekNumber: w.weekNumber, weekStart: w.weekStart,
      salesValue: 1000 + i * 11, salesUnits: 10 + i, stockUnits: 4 + (i % 7),
    });
  }
  // Null-week row must not crash and must be invisible to "W{n}" SUMIFS.
  rows.push({ distributorCode: "IS", distributorName: "Ibn Sina", productCode: "SAG", productName: "Saginkgo", line: "Anti infective", regionCode: "D1", regionName: "Delta 1", branchCode: "B1", branchName: "Branch 1", cycleMonth: "2026-05-01", weekNumber: null, weekStart: "2026-05-18", salesValue: 500, salesUnits: 5, stockUnits: 2 });
  return rows;
}

function sampleDashboard(empty = false): WeeklyDashboard {
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
    { cycleMonth: "2026-05-01", weekNumber: 1, weekStart: "2026-05-04", salesValue: 5000, salesUnits: 50, stockUnits: 0, deltaValuePct: null },
    { cycleMonth: "2026-05-01", weekNumber: 2, weekStart: "2026-05-11", salesValue: 6000, salesUnits: 60, stockUnits: 0, deltaValuePct: 0.2 },
  ];
  return {
    weekStart: null, priorWeekStart: null, availableWeeks: [], weekGroupMembers: {},
    availableLines: ["Anti infective"], availableRegions: [], availableProducts: [], availableMonths: [], availableWeekNumbers: [],
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
}
