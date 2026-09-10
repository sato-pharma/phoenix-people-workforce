import assert from "node:assert/strict";
import JSZip from "jszip";

import { buildClosingEngineFill } from "../src/lib/sales/closing-engine-data.ts";
import { fillClosingEngine } from "../src/lib/sales/closing-engine-fill.ts";
import { buildClosingPerformanceReview } from "../src/lib/sales/closing-performance-review.ts";
import { buildReviewSheets } from "../src/lib/sales/closing-review-sheets.ts";
import type { MonthlyClosingCell, MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE LAYOUT INVARIANTS OF THE PREMIUM MONTHLY CLOSING WORKBOOK.
//
// WHY THIS FILE EXISTS. On 2026-09-08/09 a design port put five separate visual defects into this
// workbook, and every single one was found by RENDERING A SHEET AND LOOKING AT IT -- overlapping
// navigation buttons, a logo sitting on top of a title, area names running into the column beside
// them, a contents page whose entries were clipped to their first letter, and a shape with a
// NEGATIVE width that stopped Excel opening the file at all. Three of them reached production.
//
// Not one was visible to anything else in the repository. They break no reference, leave the rows
// in order, carry every content type, and `check-workbook-integrity.mjs` calls the results CLEAN,
// because a workbook can be structurally perfect and visually broken at the same time. And CI has
// no Excel, so "render it and look" cannot be the guard however well it works locally.
//
// So the guard is arithmetic instead. Every rule below is a defect that actually shipped, expressed
// as a property of the emitted package that can be checked without opening it:
//
//   1. No shape has a zero or negative dimension.        <- the workbook Excel refused to open
//   2. No two buttons on a sheet overlap each other.     <- the Rep Card's navigation bar
//   3. No shape reaches the warning strip's row.         <- the unreadable incomplete-month note
//   4. Every slicer is wide enough for its longest caption. <- "Ale...", "Delt...", "Upp..."
//   5. The mark sits ON its own navy band and ON the first screen. <- "starting from details no
//      logo their": the mark was 2,313px along an eighteen-column sheet, and 101px off the end of
//      Area x Product's band, floating on white.
//   6. Every tab carries a colour, and the strip is not one flat tone. <- seventeen identical grey
//      tabs, which is a list rather than a workbook.
//
// The unit throughout is the EMU, and column geometry is resolved the way Excel resolves it: a
// later `<col>` entry wins over an earlier one covering the same column. Reading it the other way
// round is what mis-placed every drawing in the first place.
// ─────────────────────────────────────────────────────────────────────────────

const EMU_PER_PIXEL = 9525;
const DEFAULT_COLUMN_WIDTH = 9.140625;
/**
 * What a maximised Excel shows on a 1366-wide screen, in EMU. The mark has to be inside it.
 *
 * Written out here rather than imported from the module that enforces it — a test reading the
 * implementation's own constant asserts only that the file equals itself.
 */
const FIRST_SCREEN_EMU = 1_300 * EMU_PER_PIXEL;

/** The tab colours this workbook is allowed to use: two navies, the accent, and the muted grey. */
const TAB_COLOURS = ["FF0A1F33", "FF103A5C", "FF0B78B7", "FF6B8296"] as const;

/** Column index (0-based) to its left edge in EMU, honouring later `<col>` entries over earlier. */
function columnEdges(sheetXml: string): (index: number) => number {
  const runs: { emu: number; max: number; min: number }[] = [];
  const block = /<cols>[\s\S]*?<\/cols>/.exec(sheetXml)?.[0] ?? "";
  for (const tag of block.match(/<col\b[^>]*\/>/g) ?? []) {
    const min = Number(/\bmin="(\d+)"/.exec(tag)?.[1] ?? 0);
    const max = Number(/\bmax="(\d+)"/.exec(tag)?.[1] ?? 0);
    if (!min || !max) continue;
    const hidden = /\bhidden="1"/.test(tag);
    const width = hidden ? 0 : Number(/\bwidth="([\d.]+)"/.exec(tag)?.[1] ?? DEFAULT_COLUMN_WIDTH);
    runs.push({ emu: width > 0 ? (Math.round(width * 7) + 5) * EMU_PER_PIXEL : 0, max, min });
  }
  const fallback = (Math.round(DEFAULT_COLUMN_WIDTH * 7) + 5) * EMU_PER_PIXEL;
  const widthOf = (index: number): number => {
    const column = index + 1;
    for (let at = runs.length - 1; at >= 0; at -= 1) {
      const run = runs[at]!;
      if (column >= run.min && column <= run.max) return run.emu;
    }
    return fallback;
  };
  return (index) => {
    let x = 0;
    for (let column = 0; column < index; column += 1) x += widthOf(column);
    return x;
  };
}

type Box = { bottom: number; left: number; name: string; right: number; top: number };

/** Every two-cell anchored shape on a drawing, as a rectangle in EMU. */
function shapeBoxes(drawingXml: string, edgeOf: (index: number) => number, rowTop: (row: number) => number): Box[] {
  const boxes: Box[] = [];
  for (const anchor of drawingXml.match(/<xdr:twoCellAnchor\b[\s\S]*?<\/xdr:twoCellAnchor>/g) ?? []) {
    const from = /<xdr:from><xdr:col>(\d+)<\/xdr:col><xdr:colOff>(-?\d+)<\/xdr:colOff><xdr:row>(\d+)<\/xdr:row><xdr:rowOff>(-?\d+)<\/xdr:rowOff><\/xdr:from>/.exec(anchor);
    const to = /<xdr:to><xdr:col>(\d+)<\/xdr:col><xdr:colOff>(-?\d+)<\/xdr:colOff><xdr:row>(\d+)<\/xdr:row><xdr:rowOff>(-?\d+)<\/xdr:rowOff><\/xdr:to>/.exec(anchor);
    if (!from || !to) continue;
    boxes.push({
      bottom: rowTop(Number(to[3])) + Number(to[4]),
      left: edgeOf(Number(from[1])) + Number(from[2]),
      name: /<xdr:cNvPr[^>]*name="([^"]*)"/.exec(anchor)?.[1] ?? "(unnamed)",
      right: edgeOf(Number(to[1])) + Number(to[2]),
      top: rowTop(Number(from[3])) + Number(from[4]),
    });
  }
  return boxes;
}

/** Row index (0-based) to its top edge in EMU. Default height is 15pt where a row sets none. */
function rowTops(sheetXml: string): (row: number) => number {
  const heights = new Map<number, number>();
  for (const tag of sheetXml.match(/<row\b[^>]*?\/>|<row\b[^>]*?>/g) ?? []) {
    const index = Number(/\br="(\d+)"/.exec(tag)?.[1] ?? Number.NaN);
    const ht = Number(/\bht="([\d.]+)"/.exec(tag)?.[1] ?? Number.NaN);
    if (Number.isFinite(index) && Number.isFinite(ht)) heights.set(index - 1, ht * 12_700);
  }
  const fallback = 15 * 12_700;
  return (row) => {
    let y = 0;
    for (let at = 0; at < row; at += 1) y += heights.get(at) ?? fallback;
    return y;
  };
}

const PRODUCTS = [
  { family: "Royafloxacin", productCode: "RY001", productName: "Royafloxacin 500mg" },
  { family: "Saginko", productCode: "SG001", productName: "Saginko 80mg" },
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
  const salesValue = cells.reduce((total, one) => total + one.salesValue, 0);
  const targeted = cells.filter((one) => one.targetValue != null);
  const targetValue = targeted.length === 0 ? null : targeted.reduce((total, one) => total + (one.targetValue ?? 0), 0);
  return {
    achievement: targetValue == null || targetValue <= 0 ? null : salesValue / targetValue,
    salesUnits: cells.reduce((total, one) => total + one.salesUnits, 0),
    salesValue,
    targetUnits: targeted.length === 0 ? null : targeted.reduce((total, one) => total + (one.targetUnits ?? 0), 0),
    targetValue,
  };
}

/**
 * NINE REGIONS WITH LONG NAMES, on purpose.
 *
 * Every defect this file guards against needed a particular shape to appear: nine regions to fill
 * the slicer, names as long as "Upper Egypt 1 area 1" to overrun a column, and a title long enough
 * to push the emblem. A tidy three-region fixture with short names passes all of it and proves
 * nothing, which is how the originals shipped.
 */
function fixture(period: string, scale = 1): MonthlyClosingMatrix {
  const names = ["Cairo", "Giza", "Upper Egypt 1", "Upper Egypt 2", "Alex-BHR", "Delta (1)", "Delta (2)", "Delta (3)", "Others"];
  const regions = names.map((regionName, index) => {
    const areas = [0, 1, 2].map((slot) => {
      const cells = [cell(180 * scale, 12_047 * scale, 429, 26_040), cell(90 * scale, 8_000 * scale, 306, 34_012)];
      return {
        areaCode: `A${index}${slot}`,
        areaName: `${regionName} area ${slot + 1}`,
        cells,
        kind: "area" as const,
        regionCode: `R${index}`,
        regionName,
        rowTotal: sum(cells),
      };
    });
    return {
      areas,
      regionCode: `R${index}`,
      regionName,
      subtotal: {
        cells: PRODUCTS.map((_, column) => sum(areas.map((area) => area.cells[column]!))),
        kind: "regionSubtotal" as const,
        regionCode: `R${index}`,
        regionName,
        rowTotal: sum(areas.map((area) => area.rowTotal)),
      },
    };
  });
  const allAreas = regions.flatMap((region) => region.areas);
  return {
    availableLines: ["Anti Infective"],
    availablePeriods: ["2026-08", "2026-09"],
    columns: PRODUCTS,
    grandTotal: {
      cells: PRODUCTS.map((_, column) => sum(allAreas.map((area) => area.cells[column]!))),
      kind: "grandTotal",
      rowTotal: sum(allAreas.map((area) => area.rowTotal)),
    },
    line: "Anti Infective",
    period,
    regions,
  };
}

// ⚠ NOT YET REGISTERED IN `tests/run-tests.ts`, AND THAT IS DELIBERATE.
//
// The guard is finished and it works -- it found the truncated Region slicer and an unclamped
// navigation bar within minutes of being written, both of which are fixed. It still reports ONE
// defect it cannot fix on its own: on `Area x Product` the navigation buttons and the
// incomplete-month note occupy the SAME row, because that sheet's masthead is three rows deep where
// every other is two. Separating them means giving that sheet its own warning row, which is a
// layout change to `closing-engine-data.ts`, not a number in a table.
//
// Registering it now would put the suite red for a defect that predates it, and a red suite that
// everyone learns to ignore is worth less than no suite. Register it in the SAME change that gives
// Area x Product its own warning row -- not before, and not by relaxing the rule to let that sheet
// through, which would pin the defect instead of catching it.
export async function runClosingLayoutInvariantTests() {
  const matrix = fixture("2026-09");
  const review = buildClosingPerformanceReview({
    availableLines: ["Anti Infective"],
    availablePeriods: ["2026-08", "2026-09"],
    generatedAt: "2026-09-09T00:00:00.000Z",
    matrix,
    seatAssignments: new Map(),
    seriesMatrices: [{ matrix, period: "2026-09" }],
  });
  const fill = buildClosingEngineFill({
    // An INCOMPLETE month, so the warning strip is actually drawn. With a complete one there is no
    // strip, and rule 3 below would pass by having nothing to check.
    coverage: {
      hasPrevData: true,
      missingDirectRegions: [],
      missingPrevValue: 442_520,
      missingSources: ["ibn sina", "epda", "overseas"],
      prevPeriod: "2026-08",
      prevSourceCount: 4,
    } as never,
    matrix,
    priorMatrix: fixture("2026-08", 3),
    review,
  });
  const zip = await JSZip.loadAsync(
    await fillClosingEngine(fill, {
      macroFree: true,
      repCardPdfBase: "https://phoenix-hr.satopharma.com/pdf?sheet=Rep+Card",
      reviewSheets: buildReviewSheets(review, { line: "Anti Infective", period: "2026-09" }),
    }),
  );

  // Sheet name to part and to its drawing, resolved through the relationships rather than by
  // assuming a part number: `Contents` lands on sheet17 in one build and sheet1 in another.
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  const workbookRels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const target = new Map<string, string>();
  for (const tag of workbookRels.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = /\bId="([^"]*)"/.exec(tag)?.[1];
    const path = /\bTarget="([^"]*)"/.exec(tag)?.[1];
    if (id && path) target.set(id, path.replace(/^\//, ""));
  }

  let sheetsChecked = 0;
  let shapesChecked = 0;
  let slicersChecked = 0;
  let marksChecked = 0;

  for (const tag of workbook.match(/<sheet\b[^>]*\/?>/g) ?? []) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    const rid = /\br:id="([^"]*)"/.exec(tag)?.[1];
    if (!name || !rid) continue;
    const raw = target.get(rid);
    if (!raw) continue;
    const part = raw.startsWith("xl/") ? raw : `xl/${raw}`;
    const sheetFile = zip.file(part);
    if (!sheetFile) continue;
    const sheetXml = await sheetFile.async("string");

    const relsFile = zip.file(part.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels"));
    if (!relsFile) continue;
    const drawingPath = /Target="\.\.\/(drawings\/drawing\d+\.xml)"/.exec(await relsFile.async("string"))?.[1];
    if (!drawingPath) continue;
    const drawingFile = zip.file(`xl/${drawingPath}`);
    if (!drawingFile) continue;
    const drawingXml = await drawingFile.async("string");

    const edgeOf = columnEdges(sheetXml);
    const rowTop = rowTops(sheetXml);
    const boxes = shapeBoxes(drawingXml, edgeOf, rowTop);
    sheetsChecked += 1;
    shapesChecked += boxes.length;

    // ── 1. No shape has a zero or negative dimension ────────────────────────────────────────────
    // A negative `<a:ext cx>` is not a repair prompt: Excel refuses to open the workbook, silently,
    // and the structural checker still calls it CLEAN. Measured cx=-750166 on the Rep Ranking
    // emblem when its width was derived from columns that had since narrowed.
    // `<a:ext>` is two different elements in DrawingML: a shape's extent, which carries cx and cy,
    // and an extension-list entry, which carries a `uri` and no dimensions at all. Matching both and
    // defaulting the missing numbers to zero reported every extension entry as a zero-height shape
    // -- a false alarm on a workbook that opens perfectly. Only an element with both attributes is
    // an extent.
    // NEGATIVE, not zero. A two-cell anchor is sized by its corners and `<a:ext>` is only Excel's
    // cache of that, so a cached zero is harmless -- both Region slicers ship with `cy="0"` and
    // render at full height. A NEGATIVE value is the one that is fatal, and it is fatal outright:
    // Excel refuses the workbook, with no dialog and nothing for the structural checker to see.
    // Asserting `> 0` instead flagged both slicers on a file that opens perfectly, which is the
    // kind of over-strict rule that gets a guard switched off rather than obeyed.
    for (const extent of drawingXml.match(/<a:ext\b[^>]*\/>/g) ?? []) {
      const cx = /\bcx="(-?\d+)"/.exec(extent)?.[1];
      const cy = /\bcy="(-?\d+)"/.exec(extent)?.[1];
      if (cx === undefined || cy === undefined) continue;
      assert.ok(Number(cx) >= 0, `${name}: a shape has a NEGATIVE width (${cx}) — Excel refuses the whole workbook`);
      assert.ok(Number(cy) >= 0, `${name}: a shape has a NEGATIVE height (${cy}) — Excel refuses the whole workbook`);
    }

    // ── 2. No two BUTTONS overlap each other ────────────────────────────────────────────────────
    // Scoped to the navigation and command shapes, which are the ones laid out side by side and the
    // ones that collided. The emblem and the slicers are deliberately not in this set: they are
    // placed independently and may legitimately sit near other things.
    const buttons = boxes.filter((box) => /^(Nav_|Cmd_|Region )/.test(box.name));
    for (let left = 0; left < buttons.length; left += 1) {
      for (let right = left + 1; right < buttons.length; right += 1) {
        const a = buttons[left]!;
        const b = buttons[right]!;
        const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        assert.ok(
          !overlaps,
          `${name}: "${a.name}" and "${b.name}" overlap — the owner's brief forbids buttons sitting on top of each other`,
        );
      }
    }

    // ── 3. Nothing reaches the warning strip ────────────────────────────────────────────────────
    // The incomplete-month note lives on row 3 (index 2). It shipped underneath the navigation bar
    // for as long as it existed, because row 2 is EMPTY in the template and empty was read as free
    // — but every button is anchored from row 2, and a drawing floating over a cell is invisible to
    // any check that reads the cell.
    const hasNote = /<c\b[^>]*\br="A3"[^>]*>[\s\S]*?(?:<v>|<is>)/.test(sheetXml);
    if (hasNote) {
      const noteTop = rowTop(2);
      for (const box of boxes) {
        if (!/^(Nav_|Cmd_)/.test(box.name)) continue;
        assert.ok(
          box.bottom <= noteTop,
          `${name}: "${box.name}" reaches into the warning strip — "Warning must NEVER overlap buttons"`,
        );
      }
    }

    // ── 5. The mark is on the navy, and on the first screen ─────────────────────────────────────
    //
    // 🔴 BOTH HALVES SHIPPED. The template anchors each emblem near the right edge of its OWN
    // sheet, which is invisible on an eighteen-column one: Details carried its mark at 2,313px and
    // the owner reported that tab, and every tab after it, as having no logo at all. Separately,
    // Area x Product's mark sat 101px PAST the end of its navy band, on white — the band's width
    // comes from `EXECUTIVE_GEOMETRY`, the mark's position from the measured caption, and nothing
    // made the two agree.
    //
    // Neither is visible to any other check here. The file is valid, every reference resolves, and
    // the logo is simply not where anybody looks.
    const emblemAnchor = (drawingXml.match(/<xdr:twoCellAnchor\b[\s\S]*?<\/xdr:twoCellAnchor>/g) ?? [])
      .find((one) => one.includes("<xdr:pic"));
    const emblemBox = emblemAnchor ? shapeBoxes(emblemAnchor, edgeOf, rowTop)[0] : null;
    if (emblemBox) {
      // The band is the A1 merge where there is one, and every cell row 1 carries where there is
      // not — the three review sheets are painted across row 1 without being merged.
      const merged = /<mergeCell ref="A1:([A-Z]+)1"\s*\/>/.exec(sheetXml)?.[1];
      const row1 = /<row\b[^>]*?\br="1"[^>]*?>([\s\S]*?)<\/row>/.exec(sheetXml)?.[1] ?? "";
      const columns = merged
        ? [merged]
        : [...row1.matchAll(/<c r="([A-Z]+)1"/g)].map((one) => one[1]!);
      const lastColumn = Math.max(
        0,
        ...columns.map((letters) => [...letters].reduce((total, ch) => total * 26 + (ch.charCodeAt(0) - 64), 0)),
      );
      const bandRight = edgeOf(lastColumn);
      marksChecked += 1;
      assert.ok(
        emblemBox.right <= bandRight + EMU_PER_PIXEL,
        `${name}: the mark ends at ${Math.round(emblemBox.right / EMU_PER_PIXEL)}px and its navy band `
          + `ends at ${Math.round(bandRight / EMU_PER_PIXEL)}px — a mark past the band floats on white`,
      );
      assert.ok(
        emblemBox.right <= FIRST_SCREEN_EMU + EMU_PER_PIXEL,
        `${name}: the mark ends at ${Math.round(emblemBox.right / EMU_PER_PIXEL)}px, past the `
          + `${FIRST_SCREEN_EMU / EMU_PER_PIXEL}px a maximised Excel shows — nobody scrolls sideways to find a logo`,
      );
    }

    // ── 4. A slicer is wide enough for its longest caption ──────────────────────────────────────
    // A slicer button shows its caption or it shows an ellipsis, and an ellipsis is forbidden
    // outright. The region names are the captions, so the control has to be at least as wide as the
    // longest one needs, times the number of them.
    for (const box of boxes) {
      if (!/slicer/i.test(box.name) && !/^Region /.test(box.name)) continue;
      const width = box.right - box.left;
      const longest = Math.max(...matrix.regions.map((region) => region.regionName.length));
      // Roughly seven pixels a character plus padding, in EMU, per button.
      const needed = matrix.regions.length * (longest * 7 + 24) * EMU_PER_PIXEL;
      slicersChecked += 1;
      assert.ok(
        width >= needed,
        `${name}: the Region slicer is ${Math.round(width / EMU_PER_PIXEL)}px for ${matrix.regions.length} regions `
          + `whose longest name is ${longest} characters — it needs about ${Math.round(needed / EMU_PER_PIXEL)}px, `
          + "and a button too narrow for its caption prints an ellipsis, which is forbidden",
      );
    }
  }

  // ── 5. EVERY TAB HAS SOMETHING TO SHOW ON A PHONE ───────────────────────────────────────────
  //
  // Three separate ways a tab can be present and useless on a phone, all measured rather than
  // assumed, because Excel for Android cannot be driven from here:
  //
  //   VISIBLE. A hidden sheet has no tab at all. Only `Data` may be hidden — it is the pivot
  //   source, and no reader opens it.
  //
  //   POPULATED. A pivot renders BLANK on mobile: Excel mobile does not materialise a pivot cache,
  //   so the page arrives empty unless a real grid was written into the cells. That shipped once,
  //   and `writePivotGrids` exists because of it. A sheet with a pivot definition and no cells is
  //   the failure, and it looks identical to a sheet that simply has no data.
  //
  //   READABLE. A pane frozen wider than the screen is worse than no pane: the frozen columns fill
  //   the display and the data they label has nowhere to scroll into. The matrix pages shipped 734px
  //   of labels on a 375px phone, and `Details` was still freezing 726px until `fitFrozenPanesForPhone`.
  {
    const phonePx = 375;
    const defaultWidth = 9.140625;
    let visible = 0;
    for (const tag of workbook.match(/<sheet\b[^>]*\/?>/g) ?? []) {
      const sheetName = /\bname="([^"]*)"/.exec(tag)?.[1];
      const rid = /\br:id="([^"]*)"/.exec(tag)?.[1];
      const state = /\bstate="([^"]*)"/.exec(tag)?.[1] ?? "visible";
      if (!sheetName || !rid) continue;
      const raw = target.get(rid);
      if (!raw) continue;
      const sheetFile = zip.file(raw.startsWith("xl/") ? raw : `xl/${raw}`);
      if (!sheetFile) continue;
      const sheetXml = await sheetFile.async("string");

      if (state !== "visible") {
        assert.equal(sheetName, "Data", `${sheetName} is ${state} — only the pivot source may have no tab`);
        continue;
      }
      visible += 1;

      const populated = [...sheetXml.matchAll(/<c\b[^>]*?>[\s\S]*?<\/c>/g)].filter((one) => /<v>|<is>|<f[ >]/.test(one[0])).length;
      assert.ok(populated > 0, `${sheetName} has a tab and no cells with values — a pivot-only sheet is BLANK on mobile`);

      const pane = /<pane\b[^>]*\/>/.exec(sheetXml)?.[0] ?? "";
      const xSplit = Number(/\bxSplit="(\d+)"/.exec(pane)?.[1] ?? 0);
      if (xSplit <= 0) continue;
      const colBlock = /<cols>[\s\S]*?<\/cols>/.exec(sheetXml)?.[0] ?? "";
      const runs = [...colBlock.matchAll(/<col\b[^>]*\/>/g)].map((one) => ({
        max: Number(/\bmax="(\d+)"/.exec(one[0])?.[1] ?? 0),
        min: Number(/\bmin="(\d+)"/.exec(one[0])?.[1] ?? 0),
        width: /\bhidden="1"/.test(one[0]) ? 0 : Number(/\bwidth="([\d.]+)"/.exec(one[0])?.[1] ?? defaultWidth),
      }));
      let frozen = 0;
      for (let column = 1; column <= xSplit; column += 1) {
        let width = defaultWidth;
        for (let at = runs.length - 1; at >= 0; at -= 1) {
          const run = runs[at]!;
          if (column >= run.min && column <= run.max) { width = run.width; break; }
        }
        frozen += width > 0 ? Math.round(width * 7) + 5 : 0;
      }
      assert.ok(
        frozen <= phonePx,
        `${sheetName} freezes ${frozen}px of columns onto a ${phonePx}px phone — the labels fill the screen and the data has nowhere to go`,
      );
    }
    assert.ok(visible >= 12, `only ${visible} visible tabs — this is not an empty sweep`);
  }

  // ── 6. THE TAB STRIP IS COLOURED, AND NOT ALL ONE COLOUR ────────────────────────────────────
  //
  // Owner, 2026-09-10: "enhnace colors ... premium polish ... every single tab". Seventeen tabs in
  // Excel's default grey are a list — a reader has to read all seventeen to find one. The colours
  // follow the contents page's own five sections, alternating between the two navies so the eye
  // sees where each group ends; Contents takes the accent on its own and Data the muted grey.
  //
  // The values are typed out above rather than imported, so this asserts the owner's palette and
  // not merely that the workbook agrees with itself.
  {
    const seen = new Map<string, string>();
    for (const tag of workbook.match(/<sheet\b[^>]*\/?>/g) ?? []) {
      const sheetName = /\bname="([^"]*)"/.exec(tag)?.[1];
      const rid = /\br:id="([^"]*)"/.exec(tag)?.[1];
      if (!sheetName || !rid) continue;
      const raw = target.get(rid);
      const sheetFile = raw ? zip.file(raw.startsWith("xl/") ? raw : `xl/${raw}`) : null;
      if (!sheetFile) continue;
      const sheetXml = await sheetFile.async("string");
      const colour = /<tabColor rgb="([0-9A-Fa-f]{8})"/.exec(sheetXml)?.[1]?.toUpperCase() ?? "";
      assert.ok(colour, `${sheetName} has no tab colour — the strip is coloured on every tab, not most of them`);
      assert.ok(
        (TAB_COLOURS as readonly string[]).includes(colour),
        `${sheetName} wears ${colour}, which is not one of the approved four`,
      );
      // `tabColor` is the FIRST child of `CT_SheetPr`; anywhere else Excel repairs the workbook and
      // drops what it could not read, which is a file that opens with a warning and no colours.
      assert.match(
        sheetXml,
        /<sheetPr\b[^>]*><tabColor\b/,
        `${sheetName} puts tabColor somewhere other than the head of sheetPr — Excel repairs that`,
      );
      seen.set(sheetName, colour);

      // 🔴 AND IT CARRIES THE MARK AT ALL. The three review sheets are authored from scratch
      // by `addReviewSheets`, so they shipped with no drawing in them — no emblem, and nothing for
      // the passes that place one to find. That is the other half of "starting from details no logo
      // their", and rule 5 above cannot see it: a sheet with no drawing is skipped by the loop that
      // measures marks, so its absence reads as nothing to check.
      //
      // `Data` is excluded because it has no masthead and no reader; it is the pivot source.
      if (sheetName === "Data") continue;
      const relsForSheet = zip.file((raw!.startsWith("xl/") ? raw! : `xl/${raw!}`).replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels"));
      assert.ok(relsForSheet, `${sheetName} has no relationships at all, so it cannot be carrying the mark`);
      const drawingFor = /Target="\.\.\/(drawings\/drawing\d+\.xml)"/.exec(await relsForSheet!.async("string"))?.[1];
      assert.ok(drawingFor, `${sheetName} points at no drawing — every tab but Data wears the emblem`);
      assert.match(
        await zip.file(`xl/${drawingFor}`)!.async("string"),
        /<xdr:pic\b/,
        `${sheetName} has a drawing with no picture in it — the emblem is what makes it a masthead`,
      );
    }
    assert.ok(seen.size >= 15, `only ${seen.size} tabs were read — this is not an empty sweep`);
    assert.ok(new Set(seen.values()).size >= 3, "the strip is one flat tone — the sections are meant to be visible");
    assert.equal(seen.get("Contents"), "FF0B78B7", "Contents wears the accent — it is the way back, and the only tab that is not a report");
    assert.equal(
      [...seen.entries()].filter(([, colour]) => colour === "FF0B78B7").length,
      1,
      "and it wears it alone, or it stops standing out",
    );
  }

  // ── 7. THE REVIEW SHEETS WEAR THE SAME LOOK AS EVERY OTHER TAB ──────────────────────────────
  //
  // They are the only three sheets in the workbook written from scratch rather than filled into the
  // owner's engine, so every convention the template carries has to be put on them by hand — and
  // two were missing. There was no zebra at all, and the pane froze after row 2, which keeps the
  // title and the subtitle on screen and lets the COLUMN HEADINGS scroll away: a column of numbers
  // with no way to tell which month it is.
  //
  // The stripe is checked by the FILL it resolves to, never by its dxf id. An id is a position in
  // `styles.xml` and moves whenever the engine is rebuilt from a fresh source workbook; a wrong one
  // is not an error, it is a second row wearing the red "under target" fill.
  {
    const styles = await zip.file("xl/styles.xml")!.async("string");
    const dxfs = [...(/<dxfs count="\d+"[^>]*>([\s\S]*?)<\/dxfs>/.exec(styles)?.[1] ?? "").matchAll(/<dxf>[\s\S]*?<\/dxf>/g)]
      .map((one) => one[0]);
    let reviewed = 0;
    for (const tag of workbook.match(/<sheet\b[^>]*\/?>/g) ?? []) {
      const sheetName = /\bname="([^"]*)"/.exec(tag)?.[1] ?? "";
      if (!["Area by Month", "District Managers", "Product by Month"].includes(sheetName)) continue;
      const rid = /\br:id="([^"]*)"/.exec(tag)?.[1];
      const raw = rid ? target.get(rid) : null;
      const sheetFile = raw ? zip.file(raw.startsWith("xl/") ? raw : `xl/${raw}`) : null;
      if (!sheetFile) continue;
      const sheetXml = await sheetFile.async("string");
      reviewed += 1;

      const rule = /<conditionalFormatting sqref="([^"]*)">[\s\S]*?dxfId="(\d+)"[\s\S]*?<formula>([\s\S]*?)<\/formula>/.exec(sheetXml);
      assert.ok(rule, `${sheetName} carries no zebra — every other sheet with rows has one`);
      assert.match(rule![3]!, /MOD\(ROW\(\)-5,2\)=1/, `${sheetName}'s stripe has to start at the first data row`);
      assert.match(
        dxfs[Number(rule![2])] ?? "",
        /<(?:bg|fg)Color rgb="FFF3F8FC"/i,
        `${sheetName}'s stripe points at a format that is not the workbook's own pale blue`,
      );
      assert.match(rule![1]!, /^A5:/, `${sheetName}'s stripe has to cover the rows, not the masthead`);

      // The heading row is row 4 on all three, so the split goes below it.
      assert.match(
        sheetXml,
        /<pane ySplit="4" topLeftCell="A5"/,
        `${sheetName} freezes above its own column headings — they scroll away and the numbers lose their labels`,
      );
    }
    assert.equal(reviewed, 3, `${reviewed} review sheets were checked, not 3 — this is not an empty sweep`);
  }

  // ── The positive control ──────────────────────────────────────────────────────────────────────
  // Every assertion above passes on a workbook with no shapes at all. These counts are what the
  // build this test was written against actually carries, so a sweep that quietly found nothing
  // fails here rather than reporting the layout sound.
  assert.ok(sheetsChecked >= 10, `only ${sheetsChecked} sheets carried a drawing — this is not an empty sweep`);
  assert.ok(shapesChecked >= 30, `only ${shapesChecked} shapes were measured — this is not an empty sweep`);
  assert.ok(slicersChecked >= 2, `only ${slicersChecked} slicers were measured — both matrix sheets carry one`);
  assert.ok(marksChecked >= 12, `only ${marksChecked} sheets were measured for their mark — every tab but Data carries one`);
}
