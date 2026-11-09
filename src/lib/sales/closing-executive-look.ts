import type JSZip from "jszip";

import { CLOSING_ENGINE_EMBLEM_ON_DARK_PNG_BASE64 } from "./closing-engine-emblem-on-dark";
import { CLOSING_MATRIX_NO_OFFICE_SHEET } from "./closing-matrix-without-office";

/**
 * The Monthly Closing workbook's approved executive geometry.
 *
 * WHERE THIS CAME FROM. The owner approved a redesign of the premium closing workbook on
 * 2026-09-08 and asked for it to become the standing visual identity of the file: "reproduce and
 * maintain this exact design language". That reference workbook cannot be opened by Excel -- it is
 * written by a .NET OOXML writer that puts its pivot cache outside `xl/`, and Excel refuses it
 * outright, repair mode included -- so it could not be rendered or handed on as-is. Its DESIGN,
 * though, is exact and fully readable from the package, which is where every number below was
 * measured from rather than eyeballed off a screenshot. Four sheets were screenshotted; all
 * seventeen are specified here.
 *
 * WHY GEOMETRY IS A LAYER OF ITS OWN. Almost everything that reads as "premium" in that reference
 * is spacing, not colour: a 44pt title band against our 34, a 30pt warning strip against our 6.95,
 * 24pt KPI rows against our 16.5. The 6.95 is why the incomplete-data warning renders UNDER the
 * navigation buttons in the shipping workbook -- the strip is seven points tall and the buttons are
 * thirty -- which is the first thing the owner's brief forbids ("Warning must NEVER overlap
 * buttons"). Fixing the heights fixes that defect and most of the density at once, without touching
 * a single style index.
 *
 * HEAD PLUS BODY, NEVER A ROW LIST. `head` is the design block at the top of a sheet: title,
 * navigation, warning, KPI band, table header. `body` is the one repeated height everything below
 * it uses. Pinning the tail row by row would freeze September's row COUNT into the design, so a
 * month with more areas would simply stop being styled partway down -- the same class of bug as the
 * conditional-formatting ranges this module sits beside. Head plus body survives any month.
 *
 * COLUMNS ARE A MAP, NOT A LIST. The reference's own `<cols>` carries overlapping entries -- it
 * declares 4-5 at 15.71 and then 4 at 16 and 5 at 17 -- which contradict each other read as a list
 * and resolve cleanly walked in order, later winning, which is what Excel does with them.
 */
/**
 * ⚠ ROW 3 IS A GUTTER WHEREVER IT IS EMPTY — owner, 2026-09-10: "row 3 in every tab needs to be
 * narrower". It held 34pt on the two matrices and 26-30pt elsewhere while carrying nothing, which
 * reads as a gap under the command row rather than as air. It is 8pt now on the eleven sheets where
 * it is blank.
 *
 * 🔴 FOUR SHEETS KEEP A TALLER ROW 3, AND SHRINKING THEM WOULD CLIP REAL CONTENT. Contents
 * carries the month and line beneath its masthead. District Managers, Area by Month and Product by
 * Month are authored by `addReviewSheets`, which puts the "Contents" back-link on row 3 — those
 * three write their own heights, so the numbers here must agree with that author or the table is
 * describing a sheet it does not control.
 *
 * ⚠ NOTHING MAY BE PUT ON ROW 3 TO FILL IT. Row 3 is the WARNING strip: `paintExecutiveBands`
 * paints any row 3 that carries text in the amber incomplete-month fill, whatever that text says.
 * The Rep Card's tagline was moved here once and came out looking like a warning about nothing.
 * The completeness note that used to live there was removed by the owner on 2026-09-09, which is
 * why every one of these rows is empty and why 8pt is the right height for it.
 */
export const EXECUTIVE_GEOMETRY: Record<string, { body: number | null; cols: Record<number, number>; head: Record<number, number> }> = {
  "Area by Month": {
    body: 20,
    cols: { 1: 28, 2: 18, 3: 15, 4: 15, 5: 15, 6: 22 },
    head: { 1: 34, 2: 25, 3: 18, 4: 26 },
  },
  "Area x Product": {
    body: 18,
    // ⚠ COLUMNS 7 TO 10 CARRY NO DATA AND ARE HERE ON PURPOSE. The band's width and the A1
    // merge both come from the largest key in this map, and a merged cell CANNOT overflow: with the
    // map stopping at F the sheet's caption was cut at 744px and the emblem sat 101px past the end
    // of its own navy. Six columns is the SHEET; ten is the MASTHEAD it needs — measured on Anti
    // Infective, whose name is the longest of the three lines and takes the caption to 933px with
    // the mark on the end of it. Pedia and CNS are shorter and sit inside the same band.
    cols: { 1: 20, 2: 24, 3: 26, 4: 16, 5: 16, 6: 12, 7: 12, 8: 12, 9: 12, 10: 12 },
    head: { 1: 34, 2: 34, 3: 8, 4: 26, 5: 27, 6: 8, 7: 23 },
  },
  "Closing Matrix": {
    body: 18,
    cols: { 1: 22, 2: 18, 3: 13, 4: 14, 5: 11, 6: 13, 7: 14, 8: 11, 9: 13, 10: 14, 11: 11, 12: 13, 13: 14, 14: 11, 15: 13, 16: 14, 17: 11 },
    head: { 1: 34, 2: 34, 3: 8, 4: 26, 5: 27, 6: 8, 7: 22, 8: 22, 9: 22 },
  },
  // CONTENTS IS DELIBERATELY ABSENT, and this is the entry that must not come back.
  //
  // The reference's contents page is a THREE-column layout: a narrow rail at 2.2, the page name at
  // 22, the description at 36. Ours is a TWO-column page that `addIndexSheet` authors itself -- the
  // name at 28 and the description at 96 -- so the reference's widths do not describe it, they
  // destroy it. Applied, column A shrank to 2.2 and every page name was clipped to its first
  // letter: a contents page reading "O", "R", "T", "C" down the side, with every description cut
  // off mid-word. It shipped that way in the first geometry PR and was live until this was removed.
  //
  // Porting the reference's contents layout means rebuilding the page on three columns, which is a
  // change to `addIndexSheet` and to the tests that pin its banner -- not a row of numbers in a
  // table. Until someone does that, this page keeps the geometry it was built with.
  Details: {
    body: 20,
    cols: { 1: 16, 2: 16, 3: 18, 4: 18, 5: 18, 6: 16, 7: 16, 8: 16, 9: 16, 10: 16, 11: 16, 12: 16, 13: 16, 14: 16, 15: 16, 16: 16, 17: 16, 18: 16 },
    head: { 1: 34, 2: 36, 3: 8, 4: 26 },
  },
  "District Managers": {
    body: 20,
    cols: { 1: 30, 2: 18, 3: 9, 4: 16, 5: 16, 6: 14 },
    head: { 1: 34, 2: 24, 3: 18, 4: 26 },
  },
  "Family by Month": {
    // 18.95 is the reference's own body height here; the extractor could not infer it because the
    // sheet is short enough that its trailing run is the two 27pt footnote rows.
    body: 18.95,
    cols: { 1: 3, 2: 22, 3: 18, 4: 16, 5: 18, 6: 20, 7: 4, 8: 17 },
    head: { 1: 34, 2: 36, 3: 8, 4: 21.95 },
  },
  "Family Performance": {
    body: 18.95,
    cols: { 1: 3, 2: 22, 3: 11, 4: 16, 5: 16, 6: 14, 7: 4, 8: 14 },
    head: { 1: 34, 2: 36, 3: 8, 4: 21.95 },
  },
  // ⚠ THIS ENTRY IS THE TAB'S MASTHEAD, NOT ITS LAYOUT. Like the three review sheets above it, the
  // quarter gap is authored by `addReviewSheets` AFTER `applyExecutiveGeometry` has run, so nothing
  // here ever sets one of its rows or columns — `addReviewSheets` writes both. What it IS read for
  // is `paintExecutiveBands`, which draws the navy title band to the width of the LAST column named
  // here and hands the sheet to `applyOnDarkEmblem` for the white mark. Stop this map at nine and
  // the band stops at nine, with the mark sitting past the end of its own colour and two bare white
  // columns beside it. The numbers below are the ones the author actually writes, so the table
  // describes the sheet rather than a sheet it does not control.
  "Gap to Quarter Target": {
    body: 20,
    cols: { 1: 26, 2: 18, 3: 22, 4: 16, 5: 13, 6: 15, 7: 13, 8: 15, 9: 13, 10: 15, 11: 12 },
    head: { 1: 33.95, 2: 18, 3: 18, 4: 21.95 },
  },
  "Product by Month": {
    body: 20,
    cols: { 1: 24, 2: 22, 3: 16, 4: 16, 5: 16, 6: 22 },
    head: { 1: 34, 2: 25, 3: 18, 4: 26 },
  },
  "Rep Card": {
    body: 19,
    cols: { 1: 3, 2: 24, 3: 13, 4: 14, 5: 16, 6: 16, 7: 14, 8: 4, 9: 3, 10: 3, 11: 3, 12: 3, 13: 3, 14: 2 },
    head: {
      1: 42, 2: 36, 3: 8, 4: 28, 5: 28, 6: 6.95, 7: 14.1, 8: 30, 9: 14.1, 10: 18, 11: 9, 12: 17.1,
      13: 27, 14: 15.95, 15: 9.95, 16: 28, 17: 16.5, 18: 16.5, 19: 21,
    },
  },
  "Rep Ranking": {
    body: 22,
    cols: { 1: 5, 2: 25, 3: 25, 4: 18, 5: 24, 6: 16, 7: 16, 8: 14, 9: 4, 10: 16 },
    head: { 1: 42, 2: 36, 3: 8, 4: 28 },
  },
  "Top Achievers": {
    // 23 is the ranking block's height. The trailing 19s are two footnote rows, so the extractor's
    // "longest run at the tail" rule picked those; hand-set to the block the sheet is actually made
    // of, which is what a longer or shorter top-ten has to keep.
    body: 23,
    cols: { 1: 3, 2: 5, 3: 24, 4: 25, 5: 18, 6: 16, 7: 16, 8: 14, 9: 4 },
    head: { 1: 42, 2: 36, 3: 8, 4: 26, 5: 26, 6: 26, 7: 9.95, 8: 28 },
  },
  "Top Customers": {
    body: 19,
    cols: { 1: 5, 2: 30, 3: 22, 4: 16, 5: 16, 6: 14, 7: 14, 8: 14 },
    head: { 1: 34, 2: 36, 3: 8, 4: 26 },
  },
  // 🔴 A MATRIX'S `cols` MUST REACH ITS LAST COLUMN, and the title band is why.
  //
  // `paintExecutiveBands` takes the band's width from `Math.max` of these keys, and the masthead's
  // A1 merge follows it. Units Matrix stopped at 8 while the sheet runs to N, and Closing Matrix at
  // 11 while it runs to Q — so the navy band ended mid-page and the title was cut off inside its own
  // merge, which cannot overflow. Owner, 2026-09-10, pointing at column N.
  //
  // The trailing columns are the repeating Units / Target Units / Ach triple, one per product. The
  // Ach column was inheriting the template's 8 and clipping both its heading and its percentage.
  "Units Matrix": {
    body: 18,
    cols: { 1: 22, 2: 18, 3: 13, 4: 14, 5: 11, 6: 13, 7: 14, 8: 11, 9: 13, 10: 14, 11: 11, 12: 13, 13: 14, 14: 11 },
    head: { 1: 34, 2: 34, 3: 8, 4: 26, 5: 27, 6: 8, 7: 22, 8: 22, 9: 22 },
  },
  "Watch List": {
    body: 19,
    cols: { 1: 18, 2: 22, 3: 22, 4: 18, 5: 16, 6: 16, 7: 14, 8: 14, 9: 14, 10: 14, 11: 14, 12: 14 },
    head: { 1: 34, 2: 36, 3: 8, 4: 26 },
  },
  Overview: {
    body: 20,
    cols: { 1: 3.5, 2: 25, 3: 9, 4: 16, 5: 17, 6: 14, 7: 4, 8: 16, 9: 15, 10: 12 },
    head: {
      1: 44, 2: 37, 3: 8, 4: 24, 5: 24, 6: 24, 7: 8, 8: 28, 9: 24, 10: 24, 11: 24, 12: 24, 13: 24,
      14: 24, 15: 24, 16: 24, 17: 24,
    },
  },
};

/**
 * The `Data` sheet is deliberately absent from the table above. It is `veryHidden`, no reader ever
 * opens it, and every pivot and Rep Card formula reads it by table name -- so restyling it buys
 * nothing and risks the one sheet whose geometry the engine's own machinery depends on.
 */

const COL_BLOCK = /<cols\b[^>]*>[\s\S]*?<\/cols>/;
const SHEET_DATA_OPEN = /<sheetData\b[^>]*>/;

/**
 * Sheet name to worksheet part, read from the package rather than from the manifest.
 *
 * The manifest knows the template's own sixteen sheets, but `Contents` and the Performance Review
 * tabs are authored during the fill and are not in it. Resolving through `workbook.xml` and its
 * relationships covers all of them and stays correct if part numbering ever shifts -- which it
 * does: `Contents` lands on `sheet17.xml` in one build and `sheet1.xml` in another, and reading a
 * sheet by assuming its part number is a mistake that has already produced a confidently wrong
 * answer about this workbook.
 *
 * Attribute order is not fixed in OOXML, so Id and Target are read independently of each other.
 */
export async function resolveSheetParts(zip: JSZip): Promise<Map<string, string>> {
  const workbookFile = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookFile || !relsFile) return new Map();
  const workbook = await workbookFile.async("string");
  const rels = await relsFile.async("string");

  const target = new Map<string, string>();
  for (const tag of rels.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = /\bId="([^"]*)"/.exec(tag)?.[1];
    const path = /\bTarget="([^"]*)"/.exec(tag)?.[1];
    if (id && path) target.set(id, path.replace(/^\//, ""));
  }

  const parts = new Map<string, string>();
  for (const tag of workbook.match(/<sheet\b[^>]*\/?>/g) ?? []) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    const rid = /\br:id="([^"]*)"/.exec(tag)?.[1];
    if (!name || !rid) continue;
    const path = target.get(rid);
    if (!path) continue;
    // `&amp;` is decoded LAST: first, a name that literally reads `&quot;` (stored `&amp;quot;`)
    // would be decoded twice into a bare `"`.
    parts.set(
      name.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
      path.startsWith("xl/") ? path : `xl/${path}`,
    );
  }
  return parts;
}

/**
 * Widen the columns named, by APPENDING overrides rather than rebuilding the block.
 *
 * The first version replaced `<cols>` outright with a clean run built from the reference's widths.
 * It produced a workbook Excel refused to open at all - not a repair prompt, a flat refusal - and
 * the integrity checker called it CLEAN, because the block it wrote was perfectly well-formed and
 * broke no reference. Bisecting sheet by sheet put it on `Rep Ranking`, whose template block
 * carries `style="2"` on every entry and a catch-all `min="11" max="16384"` covering the rest of
 * the sheet. Rebuilding dropped both.
 *
 * So this keeps every original entry untouched and adds one narrow override per column, copying the
 * `style` of whichever entry covers it. That is exactly the shape the owner's approved reference
 * uses - it declares 4-5 at 15.71 and then 4 at 16 and 5 at 17 later in the same block - so a
 * later, narrower entry winning is a form Excel demonstrably accepts.
 *
 * The general lesson, which cost four builds: in a package this fussy, EDIT what is there. Do not
 * rebuild it from what you believe it should contain, because what you did not know it carried is
 * precisely what you will drop.
 */
function colOverrides(existing: string, widths: Record<number, number>): string {
  const entries = Object.entries(widths)
    .map(([index, width]) => ({ index: Number(index), width }))
    .sort((left, right) => left.index - right.index);
  if (!entries.length) return "";

  const covering = (xml: string, column: number): string | null => {
    for (const tag of xml.match(/<col\b[^>]*\/>/g) ?? []) {
      const min = Number(/\bmin="(\d+)"/.exec(tag)?.[1] ?? Number.NaN);
      const max = Number(/\bmax="(\d+)"/.exec(tag)?.[1] ?? Number.NaN);
      if (Number.isFinite(min) && Number.isFinite(max) && column >= min && column <= max) {
        return /\bstyle="(\d+)"/.exec(tag)?.[1] ?? null;
      }
    }
    return null;
  };

  // NEVER NARROWER THAN THE TEMPLATE HAD IT.
  //
  // The reference's widths were measured against the reference's own data, and ours is not the
  // same data: "Upper Egypt 1 area 1" does not fit the 18 characters its Watch List allows, so the
  // area names ran into the region column beside them. The same shrink clipped two mastheads and
  // pushed the Rep Card's helper values into view. All of it is one mistake -- treating a width
  // copied from another workbook as an instruction rather than as an intention.
  //
  // So the reference sets a FLOOR, never a ceiling: a column may grow to the approved width and
  // never shrink below what the sheet was already built with. The look gets its proportions and
  // nothing that fitted before stops fitting, which is the half a fixed number cannot promise.
  const currentWidth = (column: number): number | null => {
    for (const tag of existing.match(/<col\b[^>]*\/>/g) ?? []) {
      const min = Number(/\bmin="(\d+)"/.exec(tag)?.[1] ?? Number.NaN);
      const max = Number(/\bmax="(\d+)"/.exec(tag)?.[1] ?? Number.NaN);
      if (!Number.isFinite(min) || !Number.isFinite(max) || column < min || column > max) continue;
      const width = Number(/\bwidth="([\d.]+)"/.exec(tag)?.[1] ?? Number.NaN);
      if (Number.isFinite(width)) return width;
    }
    return null;
  };

  return entries
    .map((entry) => {
      const style = covering(existing, entry.index);
      const already = currentWidth(entry.index);
      const width = already === null ? entry.width : Math.max(entry.width, already);
      return `<col min="${entry.index}" max="${entry.index}" width="${width}"${
        style === null ? "" : ` style="${style}"`
      } customWidth="1"/>`;
    })
    .join("");
}

/**
 * Set one row's height, whichever way the row is spelled.
 *
 * `ht` alone is not enough: a row carrying `customHeight="1"` and a stale `ht` keeps the stale one,
 * and a row with neither attribute is auto-height and ignores an `ht` that is not marked custom. So
 * both attributes are written, and any existing pair is replaced rather than appended -- a
 * duplicated attribute is a repair prompt of exactly the kind this workbook has already shipped.
 */
function setRowHeight(rowXml: string, height: number): string {
  const open = /^<row\b[^>]*?(\/?)>/.exec(rowXml);
  if (!open) return rowXml;
  let tag = open[0]
    .replace(/\s+ht="[^"]*"/g, "")
    .replace(/\s+customHeight="[^"]*"/g, "")
    .replace(/\/?>$/, "");
  tag += ` ht="${height}" customHeight="1"${open[1] ? "/>" : ">"}`;
  return tag + rowXml.slice(open[0].length);
}

/**
 * Apply the approved geometry to the sheets named, in place.
 *
 * ORDER MATTERS AND IT IS NOT OBVIOUS. Every drawing on these sheets is anchored in EMUs computed
 * from the column widths -- the emblem, the owner's region buttons, the navigation bar. Change a
 * width after those have been placed and each one slides sideways by the difference, silently. So
 * this runs BEFORE `fitRegionControls` and the emblem passes, never after. The one deliberate
 * exception is `Contents`, which does not exist until `addIndexSheet` has authored it; it is passed
 * separately, once, after that.
 *
 * `sizeMatrixColumns` runs later still and widens the matrix label column to fit the longest real
 * area name. That is a measured fix for names being cut off, and it must keep the last word: this
 * sets the reference's baseline, and that pass refines it.
 */
export async function applyExecutiveGeometry(zip: JSZip, sheetParts: Map<string, string>, only?: string[]): Promise<string[]> {
  const applied: string[] = [];
  for (const [sheetName, part] of sheetParts) {
    if (only && !only.includes(sheetName)) continue;
    const geometry = EXECUTIVE_GEOMETRY[sheetName];
    if (!geometry) continue;
    const file = zip.file(part);
    if (!file) continue;
    let xml = await file.async("string");

    // THE TWO SLICER SHEETS KEEP THEIR OWN COLUMN WIDTHS.
    //
    // `sizeMatrixColumns` already owns them, and it earns that: it measures the longest real area
    // name rather than copying a number from another workbook. Setting widths here as well put two
    // passes on the same columns, and the Region slicer -- which is sized from those widths while
    // they are still in flux -- came out 415pt wide against the 750pt it should be, with every
    // region button truncated to "Ale...", "Delt...", "Upp...". Measured in Excel, on a build whose
    // FINAL column widths were identical to the good one: the damage was done by what the widths
    // were partway through, not by what they ended as, which is the kind of fault that cannot be
    // seen in the finished file at all.
    //
    // An ellipsis on a button is also forbidden outright by the owner's standing rule, so this is
    // not a matter of taste. Row heights still apply here; only the columns are left alone.
    if (!SLICER_SHEETS.has(sheetName)) {
      const block = COL_BLOCK.exec(xml);
      const overrides = colOverrides(block?.[0] ?? "", geometry.cols);
      if (overrides) {
        xml = block
          ? xml.replace(COL_BLOCK, block[0].replace(/<\/cols>$/, `${overrides}</cols>`))
          : xml.replace(SHEET_DATA_OPEN, (match) => `<cols>${overrides}</cols>${match}`);
      }
    }

    // A HEAD ROW THAT DOES NOT EXIST STILL NEEDS ITS HEIGHT.
    //
    // Rewriting only the rows already present looks complete and is not: `Area x Product` is the one
    // sheet in the owner's template with NO row 2 element at all. Its height therefore stayed at
    // Excel's default 15pt while everything else -- the navigation clamp above all -- computed
    // against the 34pt this table specifies. The buttons were clamped to 34pt inside a 15pt row and
    // hung 19pt past it, straight into the warning strip on the one sheet nobody had rendered.
    //
    // The same sheet caught `fillHeaderCells` out in exactly this way once before: a cell aimed at a
    // row that does not exist was dropped in silence, and the completeness note went missing from
    // one tab of twelve. An absent row is not an empty row; it is a row whose properties nothing can
    // set.
    const present = new Set(
      [...xml.matchAll(/<row\b[^>]*?\br="(\d+)"/g)].map((match) => Number(match[1])),
    );
    const missing = Object.keys(geometry.head)
      .map(Number)
      .filter((row) => Number.isFinite(row) && !present.has(row))
      .sort((left, right) => left - right);
    for (const row of missing) {
      const height = geometry.head[row]!;
      const fresh = `<row r="${row}" ht="${height}" customHeight="1"/>`;
      // Rows must ascend inside `<sheetData>`; Excel repairs a sheet whose rows descend. Insert
      // before the first row that follows it, or at the end of the block when there is none.
      const after = [...present].filter((candidate) => candidate > row).sort((left, right) => left - right)[0];
      // ONLY A GAP, NEVER AN EXTENSION. A head row with nothing after it is not a hole in the
      // masthead, it is a row the sheet simply does not reach -- a short month whose Overview ends
      // at row 14 has no rows 15 to 17, and creating them appends three empty rows BELOW the
      // footnotes. That silently moved the footnotes out of "the last three rows", which is how
      // every reader of this sheet finds them, and turned a green suite red on an assertion about
      // wording that had not changed. Fill gaps between real rows; never push past the last one.
      if (after === undefined) continue;
      xml = xml.replace(new RegExp(`<row\\b[^>]*?\\br="${after}"`), (match) => `${fresh}${match}`);
      present.add(row);
    }

    xml = xml.replace(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g, (row) => {
      const number = Number(/^<row\b[^>]*\br="(\d+)"/.exec(row)?.[1] ?? Number.NaN);
      if (!Number.isFinite(number)) return row;
      const height = geometry.head[number] ?? geometry.body;
      return height == null ? row : setRowHeight(row, height);
    });

    zip.file(part, xml);
    applied.push(sheetName);
  }
  return applied;
}

/**
 * The approved palette, in the owner's own words.
 *
 * TAKEN FROM THE BRIEF, NOT FROM THE FILE. He wrote these values out by name on 2026-09-08 ("Use
 * approximately this palette", then fifteen labelled hexes), and that is a better source than the
 * reference workbook for one plain reason: the workbook cannot be opened by Excel, so no rendering
 * of it can be checked, and reading its fills back out of the package by hand went wrong three
 * times in a row here -- once on prefixed elements, once on relationship attribute order, and once
 * on a self-closing `<row/>` whose slash was swallowed by an attribute run, which relabelled every
 * row after an empty one. Each was caught only by a positive control. His written palette has none
 * of those failure modes.
 *
 * The geometry above is different and stays measured: heights and widths were read from the package
 * and then CONFIRMED by rendering the result through Excel, which is a check the colours could not
 * have had.
 */
export const EXECUTIVE_PALETTE = {
  /** Deep navy. The title band, and the rules that separate the bands. */
  primaryNavy: "FF0A1F33",
  /** Table headers and the second-level bands. */
  secondaryNavy: "FF103A5C",
  /** Links, KPI figures, the accent on a header row. */
  corporateBlue: "FF0B78B7",
  /** KPI panel ground. */
  lightBlue: "FFE8F2F8",
  /** Page ground under a band; the zebra's lighter half. */
  veryLight: "FFF3F8FC",
  /** Body type. */
  mainText: "FF16324A",
  /** Captions under a KPI, footnotes. */
  mutedText: "FF6B8296",
  /**
   * The one deliberately loud colour, and it is spent on exactly one control: the Rep Card's Export
   * PDF. Owner, 2026-09-09 -- "make it appearing as a button but different catchy color". It is his
   * own accent cyan rather than an invented colour, so it belongs to the approved palette while
   * still reading as the one thing on the sheet that is not navy.
   */
  accentCyan: "FF00A6D6",
  /** The incomplete-month strip. */
  warningFill: "FFFFF3D6",
  warningText: "FF8A5A00",
  white: "FFFFFFFF",
} as const;

const EMU_PER_POINT = 12_700;
/** The contents sheet's name, kept here so the band painter can leave its cover alone. */
const INDEX_SHEET_NAME = "Contents";
/** The two sheets carrying a Region slicer, whose columns `sizeMatrixColumns` already owns. */
const SLICER_SHEETS = new Set(["Closing Matrix", "Units Matrix"]);

/**
 * The tab strip, coloured by the CONTENTS PAGE'S OWN SECTIONS.
 *
 * Owner, 2026-09-10: "enhnace colors ... premium polish ... every single tab". Seventeen identical
 * grey tabs are a list; the reader has to read all seventeen to find the one they want, and the
 * contents page's five headings — Start here, By area, By product family, Behind the numbers,
 * Performance review — are the grouping he already asked for on the page itself.
 *
 * TWO TONES, ALTERNATING BY SECTION, not five colours. A strip carrying five hues is a chart, and
 * the sections are not categories that mean anything to each other — they are reading order. What
 * the strip has to show is WHERE ONE GROUP ENDS, and alternating the two navies does that with the
 * eye rather than with a legend. Contents takes the accent blue on its own: it is the way back, and
 * it is the only tab that is not a report. Data takes the muted grey, because it is the only tab
 * with no reader.
 *
 * ⚠ `accentCyan` IS DELIBERATELY NOT USED HERE. It is spent on exactly one control in this
 * workbook — the Rep Card's Export PDF — and a tab wearing it would stop that button being the one
 * loud thing on the page. Every colour below is one of the approved seven.
 */
export const EXECUTIVE_TAB_COLOURS: ReadonlyMap<string, string> = new Map([
  [INDEX_SHEET_NAME, EXECUTIVE_PALETTE.corporateBlue],
  // Start here
  ["Overview", EXECUTIVE_PALETTE.primaryNavy],
  ["Rep Ranking", EXECUTIVE_PALETTE.primaryNavy],
  ["Rep Card", EXECUTIVE_PALETTE.primaryNavy],
  ["Top Achievers", EXECUTIVE_PALETTE.primaryNavy],
  // By area
  ["Closing Matrix", EXECUTIVE_PALETTE.secondaryNavy],
  // The Office-free twin sits in the same section and takes the same navy, so the tab strip shows
  // the two matrices as one block rather than implying a different kind of page (owner, 2026-10-05).
  [CLOSING_MATRIX_NO_OFFICE_SHEET, EXECUTIVE_PALETTE.secondaryNavy],
  ["Units Matrix", EXECUTIVE_PALETTE.secondaryNavy],
  ["Area x Product", EXECUTIVE_PALETTE.secondaryNavy],
  // By product family
  ["Family Performance", EXECUTIVE_PALETTE.primaryNavy],
  ["Family by Month", EXECUTIVE_PALETTE.primaryNavy],
  // Behind the numbers
  ["Watch List", EXECUTIVE_PALETTE.secondaryNavy],
  ["Top Customers", EXECUTIVE_PALETTE.secondaryNavy],
  ["Details", EXECUTIVE_PALETTE.secondaryNavy],
  // Performance review
  ["District Managers", EXECUTIVE_PALETTE.primaryNavy],
  ["Area by Month", EXECUTIVE_PALETTE.primaryNavy],
  ["Product by Month", EXECUTIVE_PALETTE.primaryNavy],
  // Against the quarter — the last section, so it takes the alternate navy and the strip still
  // shows where the review ends.
  ["Gap to Quarter Target", EXECUTIVE_PALETTE.secondaryNavy],
  // The engine's own working sheet.
  ["Data", EXECUTIVE_PALETTE.mutedText],
]);

/**
 * Colour the tab strip.
 *
 * `tabColor` is the FIRST child of `CT_SheetPr`, and `sheetPr` the first child of the worksheet —
 * put anywhere else it is a schema violation, which Excel answers by repairing the workbook and
 * dropping whatever it could not read. Every sheet in this package already carries a `sheetPr`, in
 * both the paired and the self-closing form, so both are handled rather than assumed.
 *
 * A sheet that already carries a colour is left alone: the owner setting one by hand in a template
 * outranks this table.
 */
export async function applyTabColours(zip: JSZip, sheetParts: Map<string, string>): Promise<string[]> {
  const coloured: string[] = [];
  for (const [sheetName, part] of sheetParts) {
    const argb = EXECUTIVE_TAB_COLOURS.get(sheetName);
    const file = argb ? zip.file(part) : null;
    if (!argb || !file) continue;
    const xml = await file.async("string");
    if (/<tabColor\b/.test(xml)) continue;
    const tab = `<tabColor rgb="${argb}"/>`;

    // The self-closing form FIRST: `<sheetPr[^>]*>` matches it too, and would then leave the slash
    // inside the tag with an orphan `</sheetPr>` after it.
    const empty = /<sheetPr\b([^>]*?)\/>/.exec(xml);
    const paired = /<sheetPr\b[^>]*>/.exec(xml);
    const out = empty
      ? xml.replace(empty[0], `<sheetPr${empty[1]}>${tab}</sheetPr>`)
      : paired
        ? xml.replace(paired[0], `${paired[0]}${tab}`)
        : xml.replace(/<worksheet\b[^>]*>/, (open) => `${open}<sheetPr>${tab}</sheetPr>`);
    if (out === xml) continue;
    zip.file(part, out);
    coloured.push(sheetName);
  }
  return coloured;
}

/**
 * Keep the navigation band inside its own row.
 *
 * The owner's brief is explicit that the incomplete-data warning must never sit under the buttons,
 * and raising the warning row does NOT achieve it: measured on his own September export, every
 * button is anchored from row 2 at +53,975 EMU TO ROW 3 at +6,350, so it reaches into the warning
 * strip by construction and no row height can clear it. That anchor is inherited from the template,
 * where row 3 was a 7pt rule and the overhang was invisible; the warning strip is a later feature
 * that landed underneath buttons that were already there.
 *
 * A `twoCellAnchor` also RESIZES with its rows, so making row 2 taller stretches the button rather
 * than moving it - the overhang follows. The end has to be moved, not the row.
 *
 * Every band member is clamped to the same place, so they stay identical in height to each other,
 * which is the other half of the brief ("same height, same corner radius, same internal padding").
 * The change is about 0.4pt per button: from 53,975 into row 2 through 6,350 into row 3, to 53,975
 * through the end of row 2. Nothing else in the drawing is touched - not the emblem, which lives in
 * row 1, and not the slicers, which ride inside an mc:AlternateContent of their own.
 */
/**
 * The approved palette, applied by SUBSTITUTION.
 *
 * Every colour on the left is one the template already uses, and every colour on the right is the
 * owner's approved value for the same role. Swapping them in `styles.xml` moves every cell that
 * uses one at once, without touching a single style index, cell or row -- so a KPI panel, a table
 * header and a zebra stripe all change together and nothing can fall out of step with anything
 * else.
 *
 * WHY NOT RESTYLE THE CELLS. The alternative is to work out which cells are headers, which are
 * grounds and which are stripes, and point each at a new style. That means re-deriving a layout the
 * template already encodes, on twelve sheets, and getting it wrong somewhere no render happens to
 * cover. The template has already decided which cells share a role -- they share a fill -- and this
 * inherits that decision rather than re-making it.
 *
 * The pairs are ROLE-FOR-ROLE, not nearest-neighbour: `085080` is the table header everywhere it
 * appears, so it becomes the approved header navy, not the approved accent blue that happens to be
 * closer to it numerically.
 */
const PALETTE_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  // Deep navy: mastheads and the darkest bands.
  ["FF042C46", EXECUTIVE_PALETTE.primaryNavy],
  // Table headers and total bars.
  ["FF085080", EXECUTIVE_PALETTE.secondaryNavy],
  // The accent used for links, KPI figures and the arrow marks.
  ["FF0868A8", EXECUTIVE_PALETTE.corporateBlue],
  // KPI panel ground.
  ["FFE8EFF8", EXECUTIVE_PALETTE.lightBlue],
  // Page ground under a band, and the lighter half of a zebra.
  ["FFF5F9FC", EXECUTIVE_PALETTE.veryLight],
  // Body type and captions.
  ["FF0F1E2B", EXECUTIVE_PALETTE.mainText],
  ["FF7A93A3", EXECUTIVE_PALETTE.mutedText],
];

/**
 * The zebra's background, in every spelling the package can be carrying it.
 *
 * `applyExecutivePalette` swaps the template's own colours for the approved ones, and it runs LATE
 * — after the review sheets are authored. So a pass that has to FIND the stripe cannot look for the
 * approved value alone: before the swap the package still says what the owner's source workbook
 * said. Derived from the substitution table rather than typed out twice, so the two cannot drift.
 */
export const EXECUTIVE_ZEBRA_FILLS: readonly string[] = [
  EXECUTIVE_PALETTE.veryLight,
  ...PALETTE_SUBSTITUTIONS.filter(([, to]) => to === EXECUTIVE_PALETTE.veryLight).map(([from]) => from),
];

/**
 * Repaint the workbook in the approved palette.
 *
 * Confined to `styles.xml` on purpose. The same eight-digit strings appear in drawings, in theme
 * parts and inside slicer definitions, where they mean a shape's own fill or a theme slot rather
 * than a cell's, and a blanket search-and-replace across the package would repaint the owner's
 * button bar and his slicer chrome as a side effect of restyling a table header.
 */
export async function applyExecutivePalette(zip: JSZip): Promise<number> {
  const stylesFile = zip.file("xl/styles.xml");
  if (!stylesFile) return 0;
  let styles = await stylesFile.async("string");
  let changed = 0;
  for (const [from, to] of PALETTE_SUBSTITUTIONS) {
    if (from === to) continue;
    const pattern = new RegExp(`(rgb=")${from}(")`, "gi");
    styles = styles.replace(pattern, (_match, open: string, close: string) => {
      changed += 1;
      return `${open}${to}${close}`;
    });
  }
  if (changed) zip.file("xl/styles.xml", styles);
  return changed;
}

/** A phone, in CSS pixels — the narrow case the owner's golden rule is written against. */
const PHONE_PX = 375;

/**
 * Never freeze more columns than a phone can show.
 *
 * A frozen pane wider than the screen is worse than no pane: the frozen columns fill the display and
 * the data they were meant to label has nowhere left to scroll into. The matrix pages shipped
 * exactly this once -- 734px of labels on a 375px phone -- and `Details` still does it, freezing
 * three columns totalling 726px because its third is 58 characters wide.
 *
 * The SPLIT is reduced rather than the columns narrowed. Those widths are what stop names being cut
 * off on a desktop, which is a rule of its own; a phone loses a frozen column, it does not lose the
 * column, which is still there when scrolled to.
 *
 * `topLeftCell` moves with the split. Left where it was, the unfrozen pane points at a column inside
 * the frozen one and Excel scrolls the sheet to a position the reader never chose.
 */
export async function fitFrozenPanesForPhone(zip: JSZip, sheetParts: Map<string, string>): Promise<string[]> {
  const narrowed: string[] = [];
  for (const [sheetName, part] of sheetParts) {
    const file = zip.file(part);
    if (!file) continue;
    const xml = await file.async("string");
    const pane = /<pane\b[^>]*\/>/.exec(xml)?.[0];
    if (!pane) continue;
    const xSplit = Number(/\bxSplit="(\d+)"/.exec(pane)?.[1] ?? 0);
    if (xSplit <= 1) continue;

    const block = /<cols>[\s\S]*?<\/cols>/.exec(xml)?.[0] ?? "";
    const runs = [...block.matchAll(/<col\b[^>]*\/>/g)].map((match) => ({
      max: Number(/\bmax="(\d+)"/.exec(match[0])?.[1] ?? 0),
      min: Number(/\bmin="(\d+)"/.exec(match[0])?.[1] ?? 0),
      width: /\bhidden="1"/.test(match[0]) ? 0 : Number(/\bwidth="([\d.]+)"/.exec(match[0])?.[1] ?? 9.140625),
    }));
    // Later entries win, exactly as Excel resolves them and as `columnWidthReader` now does.
    const pixels = (column: number): number => {
      for (let at = runs.length - 1; at >= 0; at -= 1) {
        const run = runs[at]!;
        if (column >= run.min && column <= run.max) return run.width > 0 ? Math.round(run.width * 7) + 5 : 0;
      }
      return Math.round(9.140625 * 7) + 5;
    };

    let split = xSplit;
    let width = 0;
    for (let column = 1; column <= split; column += 1) width += pixels(column);
    while (split > 1 && width > PHONE_PX) {
      width -= pixels(split);
      split -= 1;
    }
    if (split === xSplit) continue;

    const letters = (column: number): string => {
      let out = "";
      for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
      return out;
    };
    const topLeftRow = /\btopLeftCell="[A-Z]+(\d+)"/.exec(pane)?.[1] ?? "1";
    const fitted = pane
      .replace(/\bxSplit="\d+"/, `xSplit="${split}"`)
      .replace(/\btopLeftCell="[A-Z]+\d+"/, `topLeftCell="${letters(split + 1)}${topLeftRow}"`);
    zip.file(part, xml.replace(pane, fitted));
    narrowed.push(`${sheetName} ${xSplit}->${split}`);
  }
  return narrowed;
}

/** Append one element to a counted block in styles.xml, returning its index. */
function appendCounted(styles: string, block: "fills" | "fonts" | "cellXfs", child: string): { index: number; xml: string } {
  const open = styles.indexOf(`<${block}`);
  const close = styles.indexOf(`</${block}>`);
  if (open < 0 || close < 0) return { index: -1, xml: styles };
  const body = styles.slice(styles.indexOf(">", open) + 1, close);
  const tag = block === "cellXfs" ? "xf" : block.slice(0, -1);
  const index = (body.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
  // The count attribute is restated from what is actually there. Excel repairs a workbook whose
  // declared count disagrees with the children it finds, and this block has had that defect before.
  return {
    index,
    xml: `${styles.slice(0, open)}<${block} count="${index + 1}">${body}${child}</${block}>${styles.slice(close + block.length + 3)}`,
  };
}

/**
 * The style that makes the Rep Card's Export PDF read as a button rather than as a line of text.
 *
 * IT HAS TO BE A CELL, NOT A SHAPE. The link's URL carries whichever rep the dropdown is set to,
 * appended by the formula when the sheet recalculates, and a drawing cannot read a dropdown -- a
 * shape here would send every reader to the same rep's PDF. So the control is a cell that LOOKS
 * like a button: a filled block, white bold type, centred both ways, on a row tall enough to give
 * the caption air.
 *
 * Returns the cellXf index, or -1 if styles.xml could not be read, in which case the caller leaves
 * the cell's existing style alone rather than pointing it at an index that does not exist.
 */
export async function ensureAccentButtonStyle(zip: JSZip): Promise<number> {
  const stylesFile = zip.file("xl/styles.xml");
  if (!stylesFile) return -1;
  let styles = await stylesFile.async("string");

  const fill = appendCounted(
    styles,
    "fills",
    `<fill><patternFill patternType="solid"><fgColor rgb="${EXECUTIVE_PALETTE.accentCyan}"/><bgColor indexed="64"/></patternFill></fill>`,
  );
  styles = fill.xml;
  const font = appendCounted(
    styles,
    "fonts",
    `<font><sz val="10"/><color rgb="${EXECUTIVE_PALETTE.white}"/><name val="Segoe UI"/><family val="2"/><b/></font>`,
  );
  styles = font.xml;
  if (fill.index < 0 || font.index < 0) return -1;

  const xf = appendCounted(
    styles,
    "cellXfs",
    `<xf numFmtId="0" fontId="${font.index}" fillId="${fill.index}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1">`
      + `<alignment horizontal="center" vertical="center"/></xf>`,
  );
  if (xf.index < 0) return -1;
  zip.file("xl/styles.xml", xf.xml);
  return xf.index;
}

/**
 * Paint the title band and the incomplete-month strip.
 *
 * These are the two bands the owner's screenshots make unambiguous, and the two that carry most of
 * the difference between the approved look and what shipped: a navy title band with white type, and
 * an amber warning strip. Everything else on these sheets already has a fill of its own.
 *
 * ONE STYLE PER BAND, REUSED. Each band gets a single new `cellXf` and every cell in it points at
 * that one index, rather than cloning each cell's existing style. Cloning would preserve per-cell
 * font sizes, but a band is a band: the reference paints its title row in one weight and one colour
 * across the whole width, and cloning would have carried through the muted grey of the "built on"
 * caption that shares row 1.
 *
 * The strip is painted ONLY where there is something to warn about. A month with nothing missing has
 * no note, and an amber band across an empty row would read as a warning with the text lost.
 */
/**
 * `widthOverrides` is for APPENDED tabs whose column count is not knowable here.
 *
 * Every sheet in `EXECUTIVE_GEOMETRY` has a fixed shape, so the band's width can be a number in a
 * table. A matrix-shaped tab does not: it carries one block per product, so CNS's fourteen and a
 * reader's filtered three are different sheets. Pinning the widest in the table would paint a band
 * forty columns past the end of a filtered grid, and pinning the narrowest would cut the masthead
 * off inside its own merge — which is the exact defect the owner pointed at in September
 * ("Units Matrix stopped at 8 while the sheet runs to N").
 *
 * So the AUTHOR of such a tab says how wide it is, in columns, and the table stays the authority
 * for every sheet whose shape it actually describes: an entry here is consulted only where
 * `EXECUTIVE_GEOMETRY` has none, so nothing already in the table can be overridden from outside.
 */
export async function paintExecutiveBands(
  zip: JSZip,
  sheetParts: Map<string, string>,
  widthOverrides: ReadonlyMap<string, number> = new Map(),
): Promise<string[]> {
  const stylesFile = zip.file("xl/styles.xml");
  if (!stylesFile) return [];
  let styles = await stylesFile.async("string");

  const solid = (argb: string) => `<fill><patternFill patternType="solid"><fgColor rgb="${argb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const font = (argb: string, size: number, bold: boolean) =>
    `<font><sz val="${size}"/><color rgb="${argb}"/><name val="Segoe UI"/><family val="2"/>${bold ? "<b/>" : ""}</font>`;

  const titleFill = appendCounted(styles, "fills", solid(EXECUTIVE_PALETTE.primaryNavy));
  styles = titleFill.xml;
  const warnFill = appendCounted(styles, "fills", solid(EXECUTIVE_PALETTE.warningFill));
  styles = warnFill.xml;
  const titleFont = appendCounted(styles, "fonts", font(EXECUTIVE_PALETTE.white, 13, true));
  styles = titleFont.xml;
  const warnFont = appendCounted(styles, "fonts", font(EXECUTIVE_PALETTE.warningText, 9, true));
  styles = warnFont.xml;
  if ([titleFill, warnFill, titleFont, warnFont].some((one) => one.index < 0)) return [];

  const xf = (fillId: number, fontId: number) =>
    `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>`;
  const titleXf = appendCounted(styles, "cellXfs", xf(titleFill.index, titleFont.index));
  styles = titleXf.xml;
  const warnXf = appendCounted(styles, "cellXfs", xf(warnFill.index, warnFont.index));
  styles = warnXf.xml;
  if (titleXf.index < 0 || warnXf.index < 0) return [];

  zip.file("xl/styles.xml", styles);

  const painted: string[] = [];
  for (const [sheetName, part] of sheetParts) {
    // Contents is excluded on purpose. It is a COVER, not a sheet with a masthead: `addIndexSheet`
    // already builds it a banner three rows deep, in one fill, with its type reversed out — and
    // `closing-engine-export.test.ts` pins exactly that ("a band needs room above and below its
    // type"). Painting a one-row title band over the top of it broke the cover into a navy strip
    // above a differently-coloured banner, which is the "two blue blocks a few points apart" the
    // same test was written to stop.
    if (sheetName === INDEX_SHEET_NAME) continue;
    const geometry = EXECUTIVE_GEOMETRY[sheetName];
    const override = geometry ? undefined : widthOverrides.get(sheetName);
    if (!geometry && override === undefined) continue;
    const file = zip.file(part);
    if (!file) continue;
    let xml = await file.async("string");

    const width = geometry
      ? Math.max(...Object.keys(geometry.cols).map(Number), 1)
      : Math.max(override ?? 1, 1);
    const letters = (column: number): string => {
      let out = "";
      for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
      return out;
    };

    let touched = false;
    for (const [row, styleIndex] of [[1, titleXf.index], [3, warnXf.index]] as const) {
      // Self-closing branch FIRST: `[^>]*(?:\/>|>)` consumes the slash of an empty row and then
      // captures the NEXT row's body, which silently paints the wrong row.
      const pattern = new RegExp(`<row\\b([^>]*?\\br="${row}"[^>]*?)\\/>|<row\\b([^>]*?\\br="${row}"[^>]*?)>([\\s\\S]*?)<\\/row>`);
      const match = pattern.exec(xml);
      if (!match) continue;
      const attrs = match[1] ?? match[2] ?? "";
      const body = match[3] ?? "";

      // Only warn where there is a warning, and the test is the A CELL specifically. Asking whether
      // the ROW has any content at all is not the same question: the Rep Card carries the short
      // form of the note on row 2 by design, and its row 3 holds styled-but-empty cells, so the
      // looser test painted a full-width amber band there with nothing written on it -- a warning
      // whose text had gone missing, which is worse than no warning at all.
      if (row === 3 && !/<c\b[^>]*\br="A3"[^>]*>[\s\S]*?(?:<v>|<is>)/.test(body)) continue;

      // Keep each existing cell EXACTLY as it is and swap only its `s`. Rebuilding a cell from its
      // inner XML means re-deciding its `t`, and a value cell re-emitted without its type reads as
      // a number: the warning text would come back as a broken formula rather than a sentence.
      const existing = new Map<string, string>();
      for (const cell of body.matchAll(/<c\b[^>]*?\/>|<c\b[^>]*?>[\s\S]*?<\/c>/g)) {
        const ref = /\br="([A-Z]+\d+)"/.exec(cell[0])?.[1];
        if (ref) existing.set(ref, cell[0]);
      }

      // `r` STAYS FIRST. Attribute order is free in OOXML but not free in practice: readers in this
      // repository match `<c r="..."` with the reference first, so prepending `s` made the warning
      // cell invisible to them — the text was present in the file and read back as an empty string,
      // and the only symptom was a pinning test failing on a sheet that rendered perfectly.
      const restyle = (cell: string): string =>
        /\bs="\d+"/.test(cell)
          ? cell.replace(/\bs="\d+"/, `s="${styleIndex}"`)
          : cell.replace(/^(<c\b[^>]*?)(\/?)>/, `$1 s="${styleIndex}"$2>`);

      const cells: string[] = [];
      for (let column = 1; column <= width; column += 1) {
        const ref = `${letters(column)}${row}`;
        const cell = existing.get(ref);
        cells.push(cell ? restyle(cell) : `<c r="${ref}" s="${styleIndex}"/>`);
      }
      xml = xml.replace(pattern, `<row${attrs}>${cells.join("")}</row>`);
      touched = true;

      // THE TITLE'S MERGE HAS TO REACH THE END OF THE BAND.
      //
      // A merged cell cannot overflow: its text stops at the merge boundary, full stop. Both matrix
      // sheets merge A1 across a handful of columns, so their mastheads were cut mid-sentence --
      // "Closing Matrix   September 2026" and nothing after it -- while every sheet that leaves A1
      // unmerged printed its whole title by overflowing across the empty cells beside it. That is
      // why the same defect appeared on some sheets and not others, and why it survived a band that
      // is otherwise the full width of the page.
      //
      // The existing merge is REWRITTEN, never added to. A second merge over the same cells is what
      // makes Excel discard every merge on the sheet, which is the defect this whole run began
      // with; widening the one that is already there cannot collide with itself.
      if (row === 1) {
        xml = xml.replace(
          /<mergeCell ref="A1:([A-Z]+)1"\s*\/>/,
          `<mergeCell ref="A1:${letters(width)}1"/>`,
        );
      }
    }

    if (touched) {
      zip.file(part, xml);
      painted.push(sheetName);
    }
  }
  return painted;
}

/**
 * Put the ON-DARK lockup on every sheet whose masthead is now navy.
 *
 * The template's emblem is the on-LIGHT mark: its "SATO" is set in BLACK. That is correct on the
 * white mastheads the workbook used to have, and it disappears entirely against the navy title band
 * -- the reader is left with the word "PHARMA" floating over a dark rectangle. `addIndexEmblem` hit
 * exactly this on the contents cover and answered it the same way; painting the band across the
 * other sheets extends the problem to all of them, so it extends the answer too.
 *
 * The two files differ only in that one fill, so this repoints the RELATIONSHIP rather than moving,
 * resizing or re-anchoring anything. Nothing about the emblem's placement changes -- which matters,
 * because the placement maths on this sheet has already produced a shape with a negative width once
 * tonight, and the least it can be asked to do here is nothing at all.
 *
 * Sheets are named by the caller, so only the ones that actually got a navy band are touched: a
 * sheet still on a white masthead keeps the black-SATO mark that is right for it.
 */
/**
 * NOT NAMED `useOnDarkEmblem`. Any function whose name begins with "use" is a React Hook to
 * `react-hooks/rules-of-hooks`, which then fails the lint job for calling it outside a component --
 * in a workbook builder that has never rendered anything. The rule is right about the convention
 * and wrong about this file, and renaming is cheaper than an eslint-disable that outlives the
 * reason for it.
 */
export async function applyOnDarkEmblem(zip: JSZip, sheetParts: Map<string, string>, sheets: string[]): Promise<string[]> {
  if (!sheets.length) return [];
  const emblemPart = "xl/media/phx-emblem-on-dark.png";
  if (!zip.file(emblemPart)) {
    zip.file(emblemPart, Buffer.from(CLOSING_ENGINE_EMBLEM_ON_DARK_PNG_BASE64, "base64"));
  }

  const swapped: string[] = [];
  for (const sheetName of sheets) {
    const part = sheetParts.get(sheetName);
    if (!part) continue;
    const relsPath = part.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels");
    const relsFile = zip.file(relsPath);
    if (!relsFile) continue;
    const drawing = /Target="\.\.\/(drawings\/drawing\d+\.xml)"/.exec(await relsFile.async("string"))?.[1];
    if (!drawing) continue;

    const drawingFile = zip.file(`xl/${drawing}`);
    const drawingRelsFile = zip.file(`xl/drawings/_rels/${drawing.replace(/^drawings\//, "")}.rels`);
    if (!drawingFile || !drawingRelsFile) continue;

    // The picture's own r:embed, so a drawing carrying other relationships - a slicer's, a
    // hyperlink's - is not repointed at an image by accident.
    const drawingXml = await drawingFile.async("string");
    const embed = /<xdr:pic\b[\s\S]*?<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(drawingXml)?.[1];
    if (!embed) continue;

    const rels = await drawingRelsFile.async("string");
    const retargeted = rels.replace(/<Relationship\b[^>]*\/>/g, (tag) =>
      new RegExp(`\\bId="${embed}"`).test(tag) && /relationships\/image/.test(tag)
        ? tag.replace(/\bTarget="[^"]*"/, 'Target="../media/phx-emblem-on-dark.png"')
        : tag,
    );
    if (retargeted === rels) continue;
    zip.file(drawingRelsFile.name, retargeted);
    swapped.push(sheetName);
  }
  return swapped;
}

export async function fitNavigationBand(zip: JSZip, sheetParts: Map<string, string>): Promise<string[]> {
  const fitted: string[] = [];
  for (const [sheetName, part] of sheetParts) {
    const geometry = EXECUTIVE_GEOMETRY[sheetName];
    if (!geometry) continue;

    const relsFile = zip.file(part.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels"));
    if (!relsFile) continue;
    const rels = await relsFile.async("string");
    const drawing = /Target="\.\.\/(drawings\/drawing\d+\.xml)"/.exec(rels)?.[1];
    if (!drawing) continue;
    const drawingFile = zip.file(`xl/${drawing}`);
    if (!drawingFile) continue;

    let changed = false;
    const xml = (await drawingFile.async("string")).replace(
      /<xdr:twoCellAnchor\b[\s\S]*?<\/xdr:twoCellAnchor>/g,
      (anchor) => {
        // A BAND MEMBER IS NAMED, not located. The first version identified one by requiring it to
        // START in row 2, which is true on most sheets and false on Area x Product, whose masthead
        // is three rows deep -- so its buttons were never clamped and reached the warning strip
        // exactly as before. The emblem is excluded by name for the same reason: it is placed
        // independently and must keep its own anchor.
        const shapeName = /<xdr:cNvPr[^>]*name="([^"]*)"/.exec(anchor)?.[1] ?? "";
        if (!/^(Nav_|Cmd_)/.test(shapeName)) return anchor;

        const fromRow = Number(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(anchor)?.[1] ?? Number.NaN);
        const toRow = Number(/<xdr:to>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(anchor)?.[1] ?? Number.NaN);
        if (!Number.isFinite(fromRow) || !(toRow > fromRow)) return anchor;

        // End at the bottom of the row it starts in, whichever row that is. Heights are 1-based in
        // the geometry table and anchors are 0-based.
        const ownRowHeight = geometry?.head[fromRow + 1];
        if (!ownRowHeight) return anchor;
        changed = true;
        return anchor.replace(
          /(<xdr:to>[\s\S]*?<xdr:row>)\d+(<\/xdr:row><xdr:rowOff>)\d+(<\/xdr:rowOff>)/,
          `$1${fromRow}$2${Math.round(ownRowHeight * EMU_PER_POINT)}$3`,
        );
      },
    );
    if (changed) {
      zip.file(`xl/${drawing}`, xml);
      fitted.push(sheetName);
    }
  }
  return fitted;
}
