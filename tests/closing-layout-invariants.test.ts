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
//
// The unit throughout is the EMU, and column geometry is resolved the way Excel resolves it: a
// later `<col>` entry wins over an earlier one covering the same column. Reading it the other way
// round is what mis-placed every drawing in the first place.
// ─────────────────────────────────────────────────────────────────────────────

const EMU_PER_PIXEL = 9525;
const DEFAULT_COLUMN_WIDTH = 9.140625;

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

  // ── The positive control ──────────────────────────────────────────────────────────────────────
  // Every assertion above passes on a workbook with no shapes at all. These counts are what the
  // build this test was written against actually carries, so a sweep that quietly found nothing
  // fails here rather than reporting the layout sound.
  assert.ok(sheetsChecked >= 10, `only ${sheetsChecked} sheets carried a drawing — this is not an empty sweep`);
  assert.ok(shapesChecked >= 30, `only ${shapesChecked} shapes were measured — this is not an empty sweep`);
  assert.ok(slicersChecked >= 2, `only ${slicersChecked} slicers were measured — both matrix sheets carry one`);
}
