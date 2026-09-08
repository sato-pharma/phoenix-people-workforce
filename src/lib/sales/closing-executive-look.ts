import type JSZip from "jszip";

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
export const EXECUTIVE_GEOMETRY: Record<string, { body: number | null; cols: Record<number, number>; head: Record<number, number> }> = {
  "Area by Month": {
    body: 20,
    cols: { 1: 28, 2: 18, 3: 15, 4: 15, 5: 15, 6: 22 },
    head: { 1: 34, 2: 25, 3: 22, 4: 26 },
  },
  "Area x Product": {
    body: 18,
    cols: { 1: 20, 2: 24, 3: 16, 4: 16, 5: 16, 6: 14 },
    head: { 1: 34, 2: 34, 3: 34, 4: 26, 5: 27, 6: 8, 7: 23 },
  },
  "Closing Matrix": {
    body: 18,
    cols: { 1: 22, 2: 16, 3: 16, 4: 14, 5: 14, 6: 14, 7: 14, 8: 14, 9: 14, 10: 14, 11: 14 },
    head: { 1: 34, 2: 34, 3: 34, 4: 26, 5: 27, 6: 8, 7: 22, 8: 22, 9: 22 },
  },
  Contents: {
    body: null,
    cols: { 1: 2.2, 2: 22, 3: 36, 4: 14, 5: 14, 6: 14, 7: 14, 8: 14 },
    head: {
      1: 10, 2: 26, 3: 26, 4: 26, 5: 8, 6: 22, 7: 28, 8: 28, 9: 28, 10: 28, 11: 8, 12: 22, 13: 28,
      14: 28, 15: 28, 16: 8, 17: 22, 18: 28, 19: 28, 20: 8, 21: 22, 22: 28, 23: 28, 24: 28, 25: 8,
      26: 22, 27: 28, 28: 28, 29: 28, 30: 8, 31: 28,
    },
  },
  Details: {
    body: 20,
    cols: { 1: 16, 2: 16, 3: 18, 4: 18, 5: 18, 6: 16, 7: 16, 8: 16, 9: 16, 10: 16, 11: 16, 12: 16, 13: 16, 14: 16, 15: 16, 16: 16, 17: 16, 18: 16 },
    head: { 1: 34, 2: 36, 3: 27, 4: 26 },
  },
  "District Managers": {
    body: 20,
    cols: { 1: 30, 2: 18, 3: 9, 4: 16, 5: 16, 6: 14 },
    head: { 1: 34, 2: 24, 3: 22, 4: 26 },
  },
  "Family by Month": {
    // 18.95 is the reference's own body height here; the extractor could not infer it because the
    // sheet is short enough that its trailing run is the two 27pt footnote rows.
    body: 18.95,
    cols: { 1: 3, 2: 22, 3: 18, 4: 16, 5: 18, 6: 20, 7: 4, 8: 17 },
    head: { 1: 34, 2: 36, 3: 26, 4: 21.95 },
  },
  "Family Performance": {
    body: 18.95,
    cols: { 1: 3, 2: 22, 3: 11, 4: 16, 5: 16, 6: 14, 7: 4, 8: 14 },
    head: { 1: 34, 2: 36, 3: 26, 4: 21.95 },
  },
  "Product by Month": {
    body: 20,
    cols: { 1: 24, 2: 22, 3: 16, 4: 16, 5: 16, 6: 22 },
    head: { 1: 34, 2: 25, 3: 22, 4: 26 },
  },
  "Rep Card": {
    body: 19,
    cols: { 1: 3, 2: 24, 3: 13, 4: 14, 5: 16, 6: 16, 7: 14, 8: 4, 9: 3, 10: 3, 11: 3, 12: 3, 13: 3, 14: 2 },
    head: {
      1: 42, 2: 36, 3: 26, 4: 28, 5: 28, 6: 6.95, 7: 14.1, 8: 30, 9: 14.1, 10: 18, 11: 9, 12: 17.1,
      13: 27, 14: 15.95, 15: 9.95, 16: 28, 17: 16.5, 18: 16.5, 19: 21,
    },
  },
  "Rep Ranking": {
    body: 22,
    cols: { 1: 5, 2: 25, 3: 25, 4: 18, 5: 24, 6: 16, 7: 16, 8: 14, 9: 4, 10: 16 },
    head: { 1: 42, 2: 36, 3: 30, 4: 28 },
  },
  "Top Achievers": {
    // 23 is the ranking block's height. The trailing 19s are two footnote rows, so the extractor's
    // "longest run at the tail" rule picked those; hand-set to the block the sheet is actually made
    // of, which is what a longer or shorter top-ten has to keep.
    body: 23,
    cols: { 1: 3, 2: 5, 3: 24, 4: 25, 5: 18, 6: 16, 7: 16, 8: 14, 9: 4 },
    head: { 1: 42, 2: 36, 3: 30, 4: 26, 5: 26, 6: 26, 7: 9.95, 8: 28 },
  },
  "Top Customers": {
    body: 19,
    cols: { 1: 5, 2: 30, 3: 22, 4: 16, 5: 16, 6: 14, 7: 14, 8: 14 },
    head: { 1: 34, 2: 36, 3: 27, 4: 26 },
  },
  "Units Matrix": {
    body: 18,
    cols: { 1: 22, 2: 16, 3: 14, 4: 14, 5: 14, 6: 14, 7: 14, 8: 14 },
    head: { 1: 34, 2: 34, 3: 34, 4: 26, 5: 27, 6: 8, 7: 22, 8: 22, 9: 22 },
  },
  "Watch List": {
    body: 19,
    cols: { 1: 18, 2: 22, 3: 22, 4: 18, 5: 16, 6: 16, 7: 14, 8: 14, 9: 14, 10: 14, 11: 14, 12: 14 },
    head: { 1: 34, 2: 36, 3: 27, 4: 26 },
  },
  Overview: {
    body: 20,
    cols: { 1: 3.5, 2: 25, 3: 9, 4: 16, 5: 17, 6: 14, 7: 4, 8: 16, 9: 15, 10: 12 },
    head: {
      1: 44, 2: 37, 3: 30, 4: 24, 5: 24, 6: 24, 7: 8, 8: 28, 9: 24, 10: 24, 11: 24, 12: 24, 13: 24,
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
    parts.set(
      name.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"'),
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

  return entries
    .map((entry) => {
      const style = covering(existing, entry.index);
      return `<col min="${entry.index}" max="${entry.index}" width="${entry.width}"${
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

    {
      const block = COL_BLOCK.exec(xml);
      const overrides = colOverrides(block?.[0] ?? "", geometry.cols);
      if (overrides) {
        xml = block
          ? xml.replace(COL_BLOCK, block[0].replace(/<\/cols>$/, `${overrides}</cols>`))
          : xml.replace(SHEET_DATA_OPEN, (match) => `<cols>${overrides}</cols>${match}`);
      }
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

const EMU_PER_POINT = 12_700;
const NAV_ROW = 2;

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
export async function fitNavigationBand(zip: JSZip, sheetParts: Map<string, string>): Promise<string[]> {
  const fitted: string[] = [];
  for (const [sheetName, part] of sheetParts) {
    const geometry = EXECUTIVE_GEOMETRY[sheetName];
    const navHeight = geometry?.head[NAV_ROW];
    if (!navHeight) continue;

    const relsFile = zip.file(part.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels"));
    if (!relsFile) continue;
    const rels = await relsFile.async("string");
    const drawing = /Target="\.\.\/(drawings\/drawing\d+\.xml)"/.exec(rels)?.[1];
    if (!drawing) continue;
    const drawingFile = zip.file(`xl/${drawing}`);
    if (!drawingFile) continue;

    const bottom = Math.round(navHeight * EMU_PER_POINT);
    let changed = false;
    const xml = (await drawingFile.async("string")).replace(
      /<xdr:twoCellAnchor\b[\s\S]*?<\/xdr:twoCellAnchor>/g,
      (anchor) => {
        // 0-based, so the navigation row is index 1. Only a shape that STARTS there is a band
        // member; the emblem starts in row 0 and must keep its own anchor exactly as it is.
        const fromRow = Number(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(anchor)?.[1] ?? Number.NaN);
        const toRow = Number(/<xdr:to>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(anchor)?.[1] ?? Number.NaN);
        if (fromRow !== NAV_ROW - 1 || !(toRow > fromRow)) return anchor;
        changed = true;
        return anchor.replace(
          /(<xdr:to>[\s\S]*?<xdr:row>)\d+(<\/xdr:row><xdr:rowOff>)\d+(<\/xdr:rowOff>)/,
          `$1${fromRow}$2${bottom}$3`,
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
