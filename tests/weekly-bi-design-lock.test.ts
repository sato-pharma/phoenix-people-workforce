import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import JSZip from "jszip";

import { buildWeeklyExportWorkbook } from "../src/lib/sales/weekly/export-workbook.ts";
import { GENERATED_AT, sampleDashboard } from "./weekly-export-workbook.test.ts";

// 🔒 THE WEEKLY BI EXPORT'S DESIGN IS LOCKED. Owner instruction, 2026-09-08: *"leave the weekly BI
// export as it is, put lock, never change its design."*
//
// He said it having just watched two PRs restyle the NSM/DSM book out from under him — #3242 moved
// four weekly workbooks onto the house identity and #3303 painted a header band on one of them,
// neither of which asked. This is the workbook he is keeping, and the lock is what stops the same
// thing happening to it.
//
// WHAT IS LOCKED. `src/lib/sales/weekly/export-workbook.ts` and `src/lib/sales/weekly/export-kit.ts`
// — the kit is imported by that builder and by NOTHING else, so freezing it freezes this workbook
// and no other module. The surface below is the DESIGN: which sheets exist, in what order, which are
// hidden, every column width, row height, merge, freeze pane, autofilter and conditional format, the
// style index on every cell, the whole style table, and the chart inventory.
//
// WHAT IS NOT LOCKED, deliberately. Cell VALUES and FORMULAS are excluded from the per-sheet
// fingerprint. A corrected number, a fixed formula or a re-worded label is not a design change and
// must not need the owner's sign-off; the style table and the layout are what he is protecting.
// (The pivot's own mechanics — `refreshOnLoad`, the `tblWeekly` table source, cache integrity — are
// pinned separately and for a different reason in `weekly-export-workbook.test.ts`, which is about
// the workbook opening on current data, not about how it looks.)
//
// HOW TO CHANGE IT, IF HE EVER ASKS. Re-pinning the digests below is the deliberate act, and it
// needs him to have said so about this workbook in the live conversation. Do NOT re-pin to make a
// red suite green — that is the one move this test exists to catch, and a session that reaches for
// it has already lost the thread. New capability ships BESIDE this workbook, the way every new
// closing feature ships beside the frozen monthly closing export.
//
// SAME SHAPE AS ITS TWO NEIGHBOURS, and the three are easy to confuse:
//   - the NSM/DSM book is EXEMPT from the house identity (beige) — `weekly-nsm-dsm-beige-look.test.ts`
//   - this book WEARS the house identity, and is frozen as it stands — here
//   - the Weekly Summarized Report's layout and scope are locked, its ink is not
//
// A digest below that no longer matches names the sheet that moved, so a failure says WHAT changed
// rather than only THAT something did.

/**
 * The design surface of one worksheet part, with data removed.
 *
 * Values, inline strings and formulas are stripped; everything structural is kept — including the
 * `s=` style index on every cell, which is how a re-styled column shows up here even though no
 * width moved.
 */
function sheetDesign(xml: string): string {
  return xml
    .replace(/<v>[\s\S]*?<\/v>/g, "<v/>")
    .replace(/<is>[\s\S]*?<\/is>/g, "<is/>")
    .replace(/<f[^>]*>[\s\S]*?<\/f>/g, "<f/>")
    .replace(/<f[^>]*\/>/g, "<f/>");
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Ordered sheet names with their visibility, straight out of `xl/workbook.xml`. */
function sheetIndex(workbookXml: string): { name: string; state: string }[] {
  return [...workbookXml.matchAll(/<sheet\b[^>]*\/>/g)].map((match) => {
    const tag = match[0];
    return {
      name: /name="([^"]*)"/.exec(tag)?.[1] ?? "?",
      state: /state="([^"]*)"/.exec(tag)?.[1] ?? "visible",
    };
  });
}

type Fingerprint = {
  charts: string;
  sheets: { name: string; state: string; design: string }[];
  styles: string;
};

async function fingerprint(buffer: Buffer): Promise<Fingerprint> {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const index = sheetIndex(workbookXml);

  // The sheet PARTS are numbered in the order the builder added them, which is the order
  // `xl/workbook.xml` lists them — so sheetN.xml lines up with index[N-1].
  const sheets: Fingerprint["sheets"] = [];
  for (let position = 0; position < index.length; position += 1) {
    const part = await zip.file(`xl/worksheets/sheet${position + 1}.xml`)?.async("string");
    sheets.push({
      design: part ? digest(sheetDesign(part)) : "MISSING",
      name: index[position].name,
      state: index[position].state,
    });
  }

  // Every chart part, by the series types it declares — a bar that became a line shows up here.
  const chartNames = Object.keys(zip.files).filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name)).sort();
  const chartShapes: string[] = [];
  for (const name of chartNames) {
    const xml = (await zip.files[name].async("string")) ?? "";
    const kinds = [...new Set([...xml.matchAll(/<c:(\w+Chart)>/g)].map((match) => match[1]))].sort();
    chartShapes.push(`${name.replace("xl/charts/", "")}:${kinds.join("+")}`);
  }

  return {
    charts: `${chartNames.length} charts | ${chartShapes.join(" ")}`,
    sheets,
    styles: digest((await zip.file("xl/styles.xml")?.async("string")) ?? ""),
  };
}

// ── THE PIN ─────────────────────────────────────────────────────────────────────
//
// Captured 2026-09-08 from the interactive build on `sampleDashboard()` — the same fixed fixture
// `runWeeklyExportTests` uses, so no data change can move these.

const EXPECTED_STYLES = "041d311471e67b89";
const EXPECTED_CHARTS =
  "5 charts | chart1.xml:barChart chart2.xml:barChart chart3.xml:barChart chart4.xml:lineChart chart5.xml:barChart";
const EXPECTED_SHEETS: { name: string; state: string; design: string }[] = [
  { design: "8486e4fbea264c6c", name: "Dashboard", state: "visible" },
  { design: "9a47619ca8b3d4a7", name: "Data", state: "hidden" },
  { design: "5ed2b4c5c6817633", name: "CoverageHelper", state: "hidden" },
  { design: "79c4b5772cc6c8d4", name: "By Region", state: "visible" },
  { design: "e4976ff2318a79da", name: "By Product", state: "visible" },
  { design: "d99aa33f68abe1e9", name: "By Distributor", state: "visible" },
  { design: "f45ab8479d129401", name: "By Branch", state: "visible" },
  { design: "05d1c2afd0ba96c0", name: "Region Drill", state: "visible" },
  { design: "720939738ec3f044", name: "By Line", state: "visible" },
  { design: "c01c183470c84066", name: "Region x Product", state: "visible" },
  { design: "b987fc2a8f0cebb5", name: "Region x Week", state: "visible" },
  { design: "457e00a360ca062a", name: "Zero-Sales Gaps", state: "visible" },
  { design: "7f1adb1380f3b5d9", name: "Distributor x Product", state: "visible" },
  { design: "96ac1898831be1cd", name: "Pareto", state: "visible" },
  { design: "0ea9492e428d636c", name: "Region Pareto", state: "visible" },
  { design: "5cf4165e1f2ce29e", name: "Growth Contribution", state: "visible" },
  { design: "cdb35307846ffd93", name: "Sell-Through &amp; Cover", state: "visible" },
  { design: "fedfa04dd08cae20", name: "Outliers", state: "visible" },
  { design: "87c6c405dacc0170", name: "Branch Coverage", state: "visible" },
  { design: "e7cdbf7e602c7074", name: "Waterfall", state: "visible" },
  { design: "1f7c982e46ec13f7", name: "Week Comparison", state: "visible" },
  { design: "4ab2759f5b23f4e1", name: "Pivot - Dist x Product", state: "visible" },
  { design: "cc21daedc69eaf06", name: "Report Sources", state: "visible" },
];

export async function runWeeklyBiDesignLockTests() {
  const interactive = await buildWeeklyExportWorkbook(sampleDashboard(), GENERATED_AT, { interactive: true });
  const actual = await fingerprint(interactive as Buffer);

  // A positive control FIRST. Every comparison below is satisfied by a workbook that lost its
  // styling altogether if the expectation were empty, so prove there is a real book to judge.
  assert.ok(actual.sheets.length > 20, `the fixture must build the full workbook; got ${actual.sheets.length} sheets`);
  assert.ok(EXPECTED_SHEETS.length > 20, "the pin itself must be populated — an empty pin locks nothing");

  // ── the sheet set: which sheets, in what order, and which are hidden ─────────
  assert.deepEqual(
    actual.sheets.map((sheet) => `${sheet.name} [${sheet.state}]`),
    EXPECTED_SHEETS.map((sheet) => `${sheet.name} [${sheet.state}]`),
    "the weekly BI workbook's sheet set is LOCKED by owner instruction (2026-09-08). A sheet was " +
      "added, removed, renamed, reordered or changed visibility. New capability ships BESIDE this " +
      "workbook, not inside it — do not re-pin this list to make the suite green.",
  );

  // ── the style table: the whole design vocabulary in one part ─────────────────
  assert.equal(
    actual.styles,
    EXPECTED_STYLES,
    "the weekly BI workbook's STYLE TABLE changed — a colour, font, border, fill or number format " +
      "moved. Its design is LOCKED by owner instruction (2026-09-08). This is the assertion a " +
      "house-identity or polish sweep trips; that sweep is what the lock exists to stop.",
  );

  // ── per sheet: widths, heights, merges, panes, filters, conditional formats,
  //    and the style index on every cell ──────────────────────────────────────
  const moved = actual.sheets
    .filter((sheet, position) => EXPECTED_SHEETS[position]?.design !== sheet.design)
    .map((sheet) => sheet.name);
  assert.deepEqual(
    moved,
    [],
    `the LAYOUT of these sheets changed: ${moved.join(", ")}. Column widths, row heights, merges, ` +
      "freeze panes, autofilters, conditional formats and per-cell styling are all locked by owner " +
      "instruction (2026-09-08). Cell values and formulas are NOT — if you only changed a number or " +
      "a formula, this assertion should not have fired, so read what actually moved.",
  );

  // ── the charts ───────────────────────────────────────────────────────────────
  assert.equal(
    actual.charts,
    EXPECTED_CHARTS,
    "the weekly BI workbook's CHARTS changed — one was added, removed, or its series type moved. " +
      "Locked by owner instruction (2026-09-08).",
  );
}
