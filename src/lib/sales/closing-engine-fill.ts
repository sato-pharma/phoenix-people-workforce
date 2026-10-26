import JSZip from "jszip";

import type { ReviewSheet, ReviewSheetRowKind } from "./closing-review-sheets";
import {
  CLOSING_ENGINE_TEMPLATE_MANIFEST,
  closingEngineTemplateBytes,
} from "./closing-engine-template-generated";
import { ACHIEVEMENT_ARROW_AT } from "./closing-engine-data";
import { CLOSING_ENGINE_EMBLEM_ON_DARK_PNG_BASE64 } from "./closing-engine-emblem-on-dark";
import { applyExecutiveGeometry, applyExecutivePalette, applyOnDarkEmblem, applyTabColours, ensureAccentButtonStyle, EXECUTIVE_GEOMETRY, EXECUTIVE_ZEBRA_FILLS, fitFrozenPanesForPhone, fitNavigationBand, paintExecutiveBands, resolveSheetParts } from "./closing-executive-look";
import { unprotectEngineWorkbook } from "./closing-workbook-lock";
import { PIVOT_GRID_SPECS, buildPivotGrid, type GridCellKind } from "./closing-pivot-grid";

/**
 * Pours one month of a closing into the owner's own `.xlsm` engine.
 *
 * The engine is not rebuilt here and must never be. It arrives as a template holding two Excel
 * Tables (`SalesData`, `AreaBook`), three pivot tables whose cache reads `SalesData` **by name**,
 * two Region slicers, the Rep Card's `INDEX`/`MATCH` and `SUMIFS` formulas, and the VBA button
 * bar. All this module does is write rows into it and correct the references that carry a row
 * count. Every other part of the zip is passed through untouched, which is the only reason the
 * machinery survives — a round trip through a spreadsheet library silently destroys all of it.
 *
 * Styling is never invented either. Each sheet in the template keeps one stripped data row as a
 * style stamp; every row written here is a clone of that stamp with values dropped in, so the
 * result carries the owner's own formatting rather than an approximation of it.
 */

export type EngineValue = string | number | null;

/**
 * A number format named explicitly, for a column whose HEADING cannot imply it.
 *
 * `reviewColumnStyle` decides a column's format from its heading and falls back to money, which is
 * right for every sheet built from aggregates. An invoice-grain sheet carries columns that are
 * numbers but not money — units that are legitimately fractional, a row id, a unit price with
 * decimals — and the money format rounds them to whole pounds and prints an em dash for zero. Those
 * columns name their format instead of hoping a heading implies it.
 *
 * `plain` is the engine's own body style: the general format, which prints a number exactly as it
 * is. Pinned by `tests/closing-rows-sheet.test.ts`.
 */
export type ReviewColumnFormat = "money" | "percent" | "growth" | "plain";

export type EngineSheetFill = {
  /** Absolute writes into the header block — titles, KPI figures, captions. */
  cells?: Record<string, EngineValue>;
  /**
   * Replacement text for the sheet's footnote rows, in order, one string per row.
   *
   * Addressed by position rather than by cell reference because the footnotes move: they sit under
   * the data, so their row numbers depend on how many rows the month has. Omit to keep the wording
   * the owner wrote; supply a line whenever it states a figure, which would otherwise still be
   * July's.
   */
  notes?: string[];
  /** Data rows, in sheet order. Each is positional against the sheet's stamp columns. */
  rows?: EngineValue[][];
};

/**
 * The `Data` sheet carries three independent blocks side by side, each a different length:
 * `SalesData` in A:N, `AreaBook` in P:AA, and the Rep Card's `PickList` in AC. They are supplied
 * separately because nothing lines them up row for row — and note the offset: SalesData and
 * AreaBook have a header row, so their first record is row 2, while PickList has none and starts
 * at AC1.
 */
export type EngineDataSheet = {
  salesData: EngineValue[][];
  areaBook: EngineValue[][];
  pickList: string[];
};

export type ClosingEngineFill = {
  /** Presentational sheets, by name. A sheet left out keeps the template's empty state. */
  sheets: Record<string, EngineSheetFill>;
  /** The source every pivot, slicer and Rep Card formula reads. */
  data: EngineDataSheet;
  /** The Rep Card's product block, plus the count its rank caption reads. */
  repCard?: { products: string[]; targetedAreaCount: number };
};

type SheetSpec = {
  file: string;
  kind: "data" | "pivot" | "formula";
  headerRows: number | null;
  firstDataRow?: number | null;
  productStampRow?: number | null;
  trailerRows?: number[];
  /** Rows between the last data row and the first footnote, as the owner spaced them. */
  trailerGap?: number;
  dataCols?: string | null;
  stampCells?: Array<{ col: string; s: number }>;
  rowAttrs?: string;
};

const MANIFEST = CLOSING_ENGINE_TEMPLATE_MANIFEST as unknown as { sheets: Record<string, SheetSpec> };

const DATA_SHEET = "Data";
const SHARED_STRINGS_PART = "xl/sharedStrings.xml";
const REP_CARD = "Rep Card";

/**
 * What Excel writes in a data field's `baseItem` to mean "none". It occupies the same attribute as
 * a real shared-item index, so it has to be excluded by value or it reads as a demand for a pool of
 * a million items.
 */
const NO_BASE_ITEM = 1_048_832;

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Drop the control characters XML 1.0 cannot represent. Customer and product names reach this
 * module from distributor files, so a stray control byte is a real possibility — and it would make
 * Excel reject the entire workbook rather than just that one cell.
 */
function xmlSafe(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // Tab, newline and carriage return are the only control characters XML 1.0 allows.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    out += ch;
  }
  return out;
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** One `<c>` element. Numbers go in bare; text becomes an inline string so no shared table is needed. */
function cellXml(ref: string, style: number, value: EngineValue): string {
  const s = style ? ` s="${style}"` : "";
  if (value === null || value === undefined || value === "") return `<c r="${ref}"${s}/>`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `<c r="${ref}"${s}/>`;
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  const text = xmlSafe(String(value));
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t${preserve}>${xmlEscape(text)}</t></is></c>`;
}

type SplitSheet = { head: string; rows: Array<{ r: number; xml: string }>; tail: string };

function splitSheet(xml: string): SplitSheet {
  const openTag = "<sheetData>";
  const start = xml.indexOf(openTag);
  if (start < 0) {
    const empty = xml.indexOf("<sheetData/>");
    return {
      head: `${xml.slice(0, empty)}<sheetData>`,
      rows: [],
      tail: `</sheetData>${xml.slice(empty + "<sheetData/>".length)}`,
    };
  }
  const end = xml.indexOf("</sheetData>");
  const rows: Array<{ r: number; xml: string }> = [];
  for (const m of xml.slice(start + openTag.length, end).matchAll(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
    rows.push({ r: Number(/\br="(\d+)"/.exec(m[0])?.[1] ?? 0), xml: m[0] });
  }
  return { head: xml.slice(0, start + openTag.length), rows, tail: xml.slice(end) };
}

/**
 * Write a value into a row, keeping the cell's existing style — and CREATING the cell, in column
 * order, when the template has no cell there at all. The insert half is not a nicety: the Rep
 * Card's rank caption reads `$N$3`, and row 3 of the template has no N cell, so a
 * replace-only write would silently do nothing and the card would read "Rank 1 of 0".
 */
function writeIntoRow(rowXml: string, ref: string, value: EngineValue): string {
  const pattern = new RegExp(`<c\\b[^>]*?r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  const found = pattern.exec(rowXml);
  if (found) {
    const style = Number(/\bs="(\d+)"/.exec(found[0])?.[1] ?? 0);
    return rowXml.replace(found[0], cellXml(ref, style, value));
  }

  const column = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  const target = columnIndex(column);
  const fresh = cellXml(ref, 0, value);

  // A row with no children at all is written self-closing; give it a body first.
  const selfClosing = new RegExp(`^<row\\b([^>]*)/>$`).exec(rowXml.trim());
  if (selfClosing) return `<row${selfClosing[1]}>${fresh}</row>`;

  const cells = [...rowXml.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)].map((m) => m[0]);
  const successor = cells.find((cell) => {
    const cellColumn = /r="([A-Z]+)\d+"/.exec(cell)?.[1];
    return cellColumn ? columnIndex(cellColumn) > target : false;
  });
  if (successor) return rowXml.replace(successor, `${fresh}${successor}`);
  return rowXml.replace(/<\/row>$/, `${fresh}</row>`);
}

function setRowNumber(rowXml: string, rowNumber: number): string {
  return rowXml.replace(/<row\b([^>]*?)\br="\d+"/, `<row$1r="${rowNumber}"`);
}

function applyCells(rowXml: string, rowNumber: number, cells: Record<string, EngineValue>): string {
  let xml = rowXml;
  for (const [ref, value] of Object.entries(cells)) {
    if (Number(/\d+$/.exec(ref)?.[0]) !== rowNumber) continue;
    xml = writeIntoRow(xml, ref, value);
  }
  return xml;
}

function setDimension(sheetXml: string, lastRow: number): string {
  return sheetXml.replace(
    /<dimension ref="([A-Z]+)(\d+):([A-Z]+)\d+"\/>/,
    (_m, firstCol: string, firstRow: string, lastCol: string) =>
      `<dimension ref="${firstCol}${firstRow}:${lastCol}${lastRow}"/>`,
  );
}

/**
 * Build the data rows for a sheet by cloning its style stamp once per record.
 *
 * Each record is positional against the stamp's own columns, which do NOT always begin at A —
 * Overview, Top Achievers and Family Performance all start at B. So a record longer than the stamp
 * is refused rather than truncated: a silently dropped column puts every value after it under the
 * wrong heading, and the result then reads as a real number while being someone else's.
 */
function stampRows(spec: SheetSpec, sheetName: string, firstRow: number, records: EngineValue[][]): string[] {
  const stampCells = spec.stampCells ?? [];
  if (stampCells.length === 0) return [];

  const width = stampCells.length;
  const overlong = records.findIndex((values) => values.length > width);
  if (overlong >= 0) {
    throw new Error(
      `closing engine: ${sheetName} row ${overlong + 1} carries ${records[overlong]!.length} values but the sheet ` +
        `holds ${width}, in columns ${stampCells[0]!.col}:${stampCells[width - 1]!.col}`,
    );
  }

  const rowAttrs = spec.rowAttrs ? ` ${spec.rowAttrs}` : "";
  const spans = ` spans="${columnIndex(stampCells[0]!.col)}:${columnIndex(stampCells[stampCells.length - 1]!.col)}"`;
  return records.map((values, offset) => {
    const rowNumber = firstRow + offset;
    const cells = stampCells
      .map((cell, index) => cellXml(`${cell.col}${rowNumber}`, cell.s, values[index] ?? null))
      .join("");
    return `<row r="${rowNumber}"${spans}${rowAttrs}>${cells}</row>`;
  });
}

export type FillOptions = {
  /**
   * Emit a macro-free `.xlsx`. Everything that makes the engine an engine — the tables, all three
   * pivots, both slicers, the Rep Card — works without macros; the VBA is 36 buttons across 11
   * drawings (not two — the count was wrong here while they were shipping broken), and Excel refuses
   * to run those in any file that arrived from a browser or an inbox anyway. So the file people are
   * sent should not be macro-enabled: it gains them nothing and costs deliverability. The buttons go
   * with it — see `dropMacroButtons`.
   */
  macroFree?: boolean;
  /**
   * Where each sheet's Export PDF button should point, in the macro-free build. Return null for a
   * sheet that has no PDF page and its button is dropped with the rest.
   *
   * A function rather than a base URL because the link carries the selection — line, month and the
   * filter this particular export was narrowed to — and only the route knows those.
   */
  pdfLink?: (sheet: string) => string | null;
  /**
   * The Rep Card's PDF URL, up to but not including `&area=`. It is separate from `pdfLink` because
   * the Rep Card's link is a FORMULA that appends the dropdown's own selection at recalculation
   * time, which a shape's fixed hyperlink cannot do.
   */
  repCardPdfBase?: string;
  /**
   * The Performance Review's sheets, appended to the workbook. Built by `closing-review-sheets.ts`
   * so the knowledge of what the review holds stays in the domain and this file stays a filler.
   */
  reviewSheets?: ReviewSheet[];
};

export async function fillClosingEngine(fill: ClosingEngineFill, options: FillOptions = {}): Promise<Buffer> {
  const zip = await JSZip.loadAsync(closingEngineTemplateBytes());

  await fillDataSheet(zip, fill.data);

  for (const [sheetName, spec] of Object.entries(MANIFEST.sheets)) {
    if (sheetName === DATA_SHEET) continue;
    const content = fill.sheets[sheetName];
    if (!content) continue;
    // A pivot sheet has no rows to write -- Excel materialises the grid itself on load -- but it
    // still has a TITLE, and the loop used to skip those sheets whole. Three pages therefore
    // shipped with a blank A1 for as long as this route has existed: Closing Matrix, Units Matrix
    // and Area x Product opened with a logo, a rule and no heading, while every sibling named its
    // month and line. The data layer has always supplied the text.
    // The Rep Card is deliberately not here: it is a formula sheet with a product block of its
    // own and `fillRepCard` below owns every cell on it, header cells included.
    if (spec.kind === "data") await fillPresentationSheet(zip, sheetName, spec, content);
    else if (spec.kind === "pivot") await fillHeaderCells(zip, spec, content);
  }

  await fillRepCard(zip, fill);
  // After the card is filled, never before: it rewrites whole rows, and the filler would then be
  // stamping products and moving footnotes around a layout it had not been told about.
  await polishRepCard(zip, fill);

  // The approved executive geometry, and it has to land HERE: after every writer that authors rows,
  // and before every reader that measures columns. Each drawing on these sheets -- the emblem, the
  // owner's region buttons, the navigation bar -- is anchored in EMUs derived from the column
  // widths, so a width changed after they are placed slides every one of them sideways by the
  // difference, with nothing to show for it but a logo no longer sitting over its own title.
  await applyExecutiveGeometry(zip, await resolveSheetParts(zip));

  await updateReferences(zip, fill);
  await fitRegionControls(zip, fill);
  await sizeMatrixColumns(zip, fill);
  // AFTER the columns are final, and that ordering is the whole point. A slicer is a two-cell
  // anchor: Excel sizes it from its two CORNERS, resolved against the column widths as they stand
  // when the file is opened. Sizing it inside `fitRegionControls` -- one line above
  // `sizeMatrixColumns` -- computed those corners against widths that were about to change, so the
  // control came out narrower than its captions needed and every region button printed an
  // ellipsis: "Ale...", "Delt...", "Upp...". Measured 653px where nine regions with a thirteen
  // character name need about 1,035.
  //
  // Nothing in the finished file shows this. The columns and the corners are both perfectly
  // reasonable; they simply were not computed against each other.
  {
    const regions = distinctColumn(fill.data.salesData, 0);
    if (regions.length) await widenRegionSlicers(zip, regions);
  }
  await sizePivotAchievementFormats(zip, fill);
  await orderPivotItems(zip, fill);
  await dropStaleLabelFormats(zip);
  // AFTER every other pass over these three sheets, and before the emblem work, which touches only
  // drawings. This one owns everything from the pivot's own first row down, so anything that writes
  // into that range has to have run already.
  await writePivotGrids(zip, fill);
  await clearTitleEmblem(zip, fill);
  await hideEmblemFromPrint(zip);
  const reviewAdded = options.reviewSheets ? await addReviewSheets(zip, options.reviewSheets) : [];
  // The mark on the three sheets that were authored without a drawing to put it in. After they
  // exist and before the palette work, which walks the drawings it finds.
  await addReviewEmblems(zip, reviewAdded);
  await addIndexSheet(zip, fill, reviewAdded);
  // Contents does not exist until the line above has authored it, so it gets its own pass. Scoped
  // to that one sheet on purpose: a second blanket pass here would run AFTER `sizeMatrixColumns`
  // and undo the widening that keeps real area names from being cut off.
  await applyExecutiveGeometry(zip, await resolveSheetParts(zip), [INDEX_SHEET]);
  await openOnFirstSheet(zip);
  await recalculateOnOpen(zip);
  await restorePivotCacheSharedItems(zip, fill);
  await dropDeadSharedStrings(zip);
  // Before both of the below, and for the same reason: the owner's buttons are still here, and the
  // navigation bar is built by CLONING one of them. It also re-lays the command row, so it has to
  // run before the Export PDF button is re-pointed at its final position.
  if (options.macroFree) await addSheetNavigation(zip);
  // BEFORE the strip, which is what makes this possible at all: the owner's own Export PDF buttons
  // are still in the package here, and re-pointing one keeps his styling, caption and position
  // instead of authoring a new shape that would only approximate them.
  if (options.macroFree && options.pdfLink) await linkPdfButtons(zip, options.pdfLink);
  if (options.macroFree && options.repCardPdfBase) await addRepCardPdfLink(zip, options.repCardPdfBase);
  if (options.macroFree) await stripMacros(zip);

  // LAST of the drawing passes, and it has to be: the navigation bar, the re-pointed Export PDF
  // button and the Rep Card's link are all authored above, and a shape clamped before it exists is
  // a shape still hanging over the warning strip. Both builds need it -- the .xlsm carries the
  // owner's own buttons, which have the same overhang the clones inherited from them.
  // The palette first: it SUBSTITUTES colours the template already uses, so it must run before the
  // band painter adds styles of its own -- those are authored in the approved colours already and
  // would be swapped a second time by a map that does not expect them.
  await applyExecutivePalette(zip);

  const finalParts = await resolveSheetParts(zip);
  // An appended tab's own column count, for the ones `EXECUTIVE_GEOMETRY` cannot describe because
  // their width depends on the month (a block per product). Taken from the widths the author
  // actually wrote, so the navy band ends exactly where the table does; the table still wins for
  // every sheet it has an entry for, the review's three and the quarter gap included.
  const banded = await paintExecutiveBands(
    zip,
    finalParts,
    new Map(reviewAdded.map((sheet): [string, number] => [sheet.name, sheet.headers.length])),
  );
  // Only the sheets that actually got a navy masthead. A sheet still on white keeps the black-SATO
  // mark, which is the correct one for it.
  await applyOnDarkEmblem(zip, finalParts, banded);
  await fitNavigationBand(zip, finalParts);
  // The tab strip, last of the look passes and independent of every other: it writes one element
  // into each sheet's `sheetPr` and touches nothing a reader of columns, rows or drawings needs.
  await applyTabColours(zip, finalParts);
  // LAST of the layout passes: it measures the columns as they finally stand, and every earlier pass
  // is still free to change them. A pane frozen wider than a phone hides the data it labels.
  await fitFrozenPanesForPhone(zip, finalParts);

  // NO PROTECTION, after every pass that touches a sheet (owner, 2026-10-26: "all its types download
  // non protected"). Any sheet or workbook protection the template carries is stripped, so every
  // tab opens for editing. See closing-workbook-lock.ts.
  await unprotectEngineWorkbook(zip, { sheetParts: await resolveSheetParts(zip) });

  // Directory entries must not reach the file, and this has to be the LAST thing done to the zip.
  // An OPC package is a flat set of parts: an item whose name ends in "/" is not a part at all and
  // cannot have a content type, because [Content_Types].xml maps by extension and a folder has
  // none. Excel writes none of them. The template carries five -- `xl/`, `xl/worksheets/`,
  // `xl/pivotCache/`, `xl/tables/`, `xl/_rels/` -- measured present the instant it is loaded and
  // before anything is written, because `JSZip.defaults.createFolders` is true and every
  // `zip.file()` call materialises a folder object for each parent segment. So the template build
  // put them in its own output, and every write below would put them back: hence last, after the
  // final `zip.file()`, not near the load.
  //
  // NEVER `zip.remove()` here: JSZip treats a folder as a subtree and removing one deletes every
  // part beneath it. That produced a 700-byte "workbook" containing nothing at all. Drop the entry
  // itself and leave the children alone -- which is measured sufficient on its own; `generateAsync`
  // has no `createFolders` of its own to set, and passing one is a no-op the types reject.
  //
  // This is a real packaging defect and worth keeping fixed, but it was NOT the repair prompt the
  // owner hit -- a build with zero directory entries still prompted. `dropDeadSharedStrings` is
  // what fixed that. Do not read this block as the cure for a future one.
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name]?.dir) delete zip.files[name];
  }

  const out = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return Buffer.from(out);
}

async function fillPresentationSheet(zip: JSZip, sheetName: string, spec: SheetSpec, content: EngineSheetFill): Promise<void> {
  const file = zip.file(spec.file);
  if (!file) throw new Error(`closing engine template is missing ${spec.file}`);
  const { head, rows, tail } = splitSheet(await file.async("string"));

  const headerLimit = spec.headerRows ?? 0;
  const firstDataRow = spec.firstDataRow ?? headerLimit + 1;
  const cells = content.cells ?? {};

  const header = rows.filter((row) => row.r <= headerLimit).map((row) => applyCells(row.xml, row.r, cells));

  const records = content.rows ?? [];
  const body = records.length
    ? stampRows(spec, sheetName, firstDataRow, records)
    : rows.filter((row) => row.r === firstDataRow).map((row) => row.xml);

  const lastRow = firstDataRow + Math.max(records.length - 1, 0);

  // The owner's footnotes, moved down to sit under however many rows this month actually has.
  //
  // Their merged cells move with them. Left where July put them, a merge like B18:J18 would land in
  // the middle of a longer month's data and visually swallow that row across the whole sheet — and
  // a footnote carrying a count ("15 areas carry no target") would be quietly describing a month
  // that is not the one on screen, which is why `notes` replaces the whole line rather than trying
  // to patch a number inside it. A sheet that supplies no note keeps the owner's own wording.
  const trailerNumbers = spec.trailerRows ?? [];
  const notes = content.notes ?? [];
  const gap = spec.trailerGap ?? 2;
  const moved = new Map<number, number>();
  const trailer = rows
    .filter((row) => trailerNumbers.includes(row.r))
    .map((row, index) => {
      const target = lastRow + gap + index;
      moved.set(row.r, target);
      let xml = row.xml;
      const note = notes[index];
      const firstRef = /<c r="([A-Z]+\d+)"/.exec(xml)?.[1];
      if (note !== undefined && firstRef) xml = writeIntoRow(xml, firstRef, note);
      return renumberRow(xml, row.r, target);
    });

  let sheetXml = `${head}${header.join("")}${body.join("")}${trailer.join("")}${tail}`;
  sheetXml = moveMerges(sheetXml, moved);
  sheetXml = resizeConditionalFormatting(sheetXml, firstDataRow, lastRow);

  zip.file(spec.file, setDimension(sheetXml, moved.size ? lastRow + gap + moved.size - 1 : lastRow));
}

/**
 * Write the header cells of a sheet this module does not otherwise own.
 *
 * The pivot and formula sheets build their own bodies -- a pivot from its cache on load, the Rep
 * Card from its INDEX/MATCH -- so nothing here may touch a row count, a dimension, a merge or a
 * conditional format. It writes the absolute cells it was given and leaves the rest of the part
 * exactly as the owner built it.
 *
 * It will create a row the template never wrote, but ONLY one a cell was actually aimed at. It used
 * to skip those in silence, which is how the completeness note went missing from exactly one tab:
 * Area x Product is the single sheet in the owner's template with no row 2, so the note aimed there
 * was dropped with no error while the other eleven carried it. A warning that is absent from one
 * sheet is worse than one absent from all of them — the reader learns it is not there to look for.
 * A created row is empty and sits inside the sheet's existing dimension, so no row count, merge or
 * conditional format moves.
 */
async function fillHeaderCells(zip: JSZip, spec: SheetSpec, content: EngineSheetFill): Promise<void> {
  const cells = content.cells;
  if (!cells || Object.keys(cells).length === 0) return;
  const file = zip.file(spec.file);
  if (!file) throw new Error(`closing engine template is missing ${spec.file}`);
  const { head, rows, tail } = splitSheet(await file.async("string"));
  const written = rows.map((row) => ({ r: row.r, xml: applyCells(row.xml, row.r, cells) }));

  const have = new Set(rows.map((row) => row.r));
  const wanted = new Set(
    Object.keys(cells)
      .map((ref) => Number(/^[A-Z]+(\d+)$/.exec(ref)?.[1] ?? Number.NaN))
      .filter((row) => Number.isFinite(row) && row > 0 && !have.has(row)),
  );
  for (const row of wanted) written.push({ r: row, xml: applyCells(`<row r="${row}"/>`, row, cells) });
  written.sort((left, right) => left.r - right.r);

  zip.file(spec.file, `${head}${written.map((row) => row.xml).join("")}${tail}`);
}

/**
 * Follow a moved row with its merge.
 *
 * A footnote is one merged strip across the sheet, and the merge is stored separately from the
 * row. Move the row without the merge and two things break at once: the footnote clips at one
 * column width instead of spanning the sheet, and the abandoned merge lands on whatever row now
 * occupies its old number — in a long month, a real data row, silently welded into one cell.
 *
 * ONE PASS, never a replacement per row. The version this replaces walked `moved` and ran a global
 * string replace for each entry, so every rewrite it had already made was still on the page for the
 * next one to match again. When the trailer block slides by LESS than its own height — a shift of
 * one or two rows — each footnote's new row number is the next footnote's OLD one, and the three
 * merges cascade onto a single range:
 *
 *     {18→19, 19→20, 20→21}   B18 becomes B19, both B19s become B20, all three become B21
 *
 * Excel answers repeated merge records with "We found a problem with some content", repairs the
 * file by discarding EVERY merge on that sheet, and names the part in its recovery log:
 * "Removed Records: Merge cells from /xl/worksheets/sheet1.xml part". Measured on the owner's
 * September Anti Infective export (2026-09-08): nine region rows put the trailer at 19/20/21
 * against the template's 18/19/20, a shift of exactly one. August's eight rows moved the block
 * nowhere at all and Pedia's seven moved it UP, which is why every earlier export opened cleanly —
 * the defect is a function of how many regions the line has, not of any change made to the code.
 *
 * Mapping the whole list at once removes the cascade by construction: a merge is read from the
 * ORIGINAL text, so a row number that is both somebody's source and somebody else's target can only
 * be applied once. Exact repeats are then dropped and the count restated, which also cleans up a
 * template that shipped one twice.
 */
function moveMerges(sheetXml: string, moved: Map<number, number>): string {
  const block = /<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/.exec(sheetXml);
  if (!block) return sheetXml;

  // Rewriting the block means owning every entry in it. If any one of them is spelled in a form this
  // does not read — a paired tag, a ref this pattern misses — the whole block is left exactly as it
  // was: a merge silently dropped is a worse failure than a merge left on the wrong row, and it is
  // the kind that shows up as a mangled page rather than as an error.
  const total = (block[0].match(/<mergeCell\b/g) ?? []).length;

  const seen = new Set<string>();
  const refs: string[] = [];
  let read = 0;
  for (const merge of block[0].matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*\/>/g)) {
    const [, firstCol, firstRow, lastCol, lastRow] = merge;
    read += 1;
    // A footnote's strip is one row, which is the only shape that travels with a moved row. A merge
    // spanning several rows is part of the sheet's furniture and stays where the owner put it.
    const target = firstRow === lastRow ? moved.get(Number(firstRow)) : undefined;
    const ref =
      target === undefined ? `${firstCol}${firstRow}:${lastCol}${lastRow}` : `${firstCol}${target}:${lastCol}${target}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }

  if (read !== total || refs.length === 0) return sheetXml;

  const rebuilt = `<mergeCells count="${refs.length}">${refs
    .map((ref) => `<mergeCell ref="${ref}"/>`)
    .join("")}</mergeCells>`;
  return `${sheetXml.slice(0, block.index)}${rebuilt}${sheetXml.slice(block.index + block[0].length)}`;
}

/**
 * Resize every conditional-formatting range that starts on the first data row to end on the last.
 *
 * The template's ranges are the sizes July needed — `A5:J54` on Rep Ranking, `B5:H9` on Family
 * Performance. They are what paints the row banding and the green/amber achievement cells, so a
 * month with more rows than July would simply stop being striped and stop being coloured partway
 * down, with no error anywhere. It has to shrink as well as grow: a range left longer than the data
 * reaches past it and colours the footnotes, and on the Rep Card it would reach the total row, which
 * the owner deliberately kept outside the banding. The rules themselves are written relative to the
 * first row of their own range, so resizing the range is all that is needed — the formulas follow.
 */
function resizeConditionalFormatting(sheetXml: string, firstDataRow: number, lastRow: number): string {
  if (lastRow < firstDataRow) return sheetXml;
  return sheetXml.replace(
    /<conditionalFormatting sqref="([^"]*)"/g,
    (match, sqref: string) => {
      const widened = sqref.replace(
        /(\$?[A-Z]{1,3}\$?)(\d+):(\$?[A-Z]{1,3}\$?)(\d+)/g,
        (range, firstCol: string, from: string, lastCol: string, to: string) =>
          Number(from) === firstDataRow && Number(to) >= firstDataRow
            ? `${firstCol}${from}:${lastCol}${lastRow}`
            : range,
      );
      return `<conditionalFormatting sqref="${widened}"`;
    },
  );
}

/**
 * The `Data` sheet is the one every pivot, slicer and Rep Card formula reads. Its three blocks are
 * written into one grid: SalesData and AreaBook from row 2 (both have a header row), PickList from
 * row 1 — so AC1 is a real entry and lands in the header row, not in the data block.
 */
async function fillDataSheet(zip: JSZip, data: EngineDataSheet): Promise<void> {
  const spec = MANIFEST.sheets[DATA_SHEET];
  if (!spec) return;
  const file = zip.file(spec.file);
  if (!file) throw new Error("closing engine template is missing the Data sheet");
  const { head, rows, tail } = splitSheet(await file.async("string"));

  const stampCells = spec.stampCells ?? [];
  const salesCols = stampCells.filter((cell) => columnIndex(cell.col) <= columnIndex("N"));
  const areaCols = stampCells.filter(
    (cell) => columnIndex(cell.col) >= columnIndex("P") && columnIndex(cell.col) <= columnIndex("AA"),
  );

  const bodyRowCount = Math.max(data.salesData.length, data.areaBook.length, Math.max(data.pickList.length - 1, 0));
  const records: EngineValue[][] = [];
  for (let index = 0; index < bodyRowCount; index += 1) {
    const row: EngineValue[] = [];
    const sales = data.salesData[index];
    const area = data.areaBook[index];
    for (let c = 0; c < salesCols.length; c += 1) row.push(sales?.[c] ?? null);
    for (let c = 0; c < areaCols.length; c += 1) row.push(area?.[c] ?? null);
    // PickList is offset by one: its first entry is AC1, up in the header row.
    row.push(data.pickList[index + 1] ?? null);
    records.push(row);
  }

  const header = rows
    .filter((row) => row.r <= (spec.headerRows ?? 1))
    .map((row) => applyCells(row.xml, row.r, { AC1: data.pickList[0] ?? null }));
  const body = stampRows(spec, DATA_SHEET, spec.firstDataRow ?? 2, records);
  const lastRow = (spec.firstDataRow ?? 2) + Math.max(records.length - 1, 0);
  zip.file(spec.file, setDimension(`${head}${header.join("")}${body.join("")}${tail}`, lastRow));
}

/**
 * The Rep Card is a live card, not a table: `B5` is the PickList dropdown, `N1` MATCHes it into
 * AreaBook, and each product row SUMIFS over SalesData keyed on its own `$B` cell. The product
 * block is therefore grown by cloning the stamp row and renumbering the formulas it carries.
 */
async function fillRepCard(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
  const spec = MANIFEST.sheets[REP_CARD];
  if (!spec) return;
  const file = zip.file(spec.file);
  if (!file) return;

  const { head, rows, tail } = splitSheet(await file.async("string"));
  const headerLimit = spec.headerRows ?? 16;
  const stampRow = spec.productStampRow ?? 17;
  const trailer = spec.trailerRows ?? [];
  const firstTrailer = trailer.length ? Math.min(...trailer) : stampRow + 1;

  const products = fill.repCard?.products ?? [];
  const cells = { ...(fill.sheets[REP_CARD]?.cells ?? {}) };
  // N3 backs the "Rank n of N" caption; the template's formula reads it rather than hardcoding a
  // count, which is what made the original workbook say "of 35" for every month.
  cells.N3 = fill.repCard?.targetedAreaCount ?? null;

  const header = rows.filter((row) => row.r <= headerLimit).map((row) => applyCells(row.xml, row.r, cells));
  const stamp = rows.find((row) => row.r === stampRow);
  const lastProductRow = stampRow + Math.max(products.length - 1, 0);

  const productRows: string[] = [];
  if (stamp && products.length) {
    products.forEach((product, offset) => {
      const rowNumber = stampRow + offset;
      let xml = renumberRow(stamp.xml, stampRow, rowNumber);
      xml = writeIntoRow(xml, `B${rowNumber}`, product);
      productRows.push(xml);
    });
  }

  const shift = products.length ? lastProductRow + 1 - firstTrailer : 0;
  const moved = new Map<number, number>();
  const trailerRows = rows
    .filter((row) => trailer.includes(row.r))
    .map((row) => {
      moved.set(row.r, row.r + shift);
      // The totals span the product block — restate it before the row itself moves.
      const respanned = row.xml.replace(
        /(SUM\([A-Z]+)\d+(:[A-Z]+)\d+(\))/g,
        (_m, open: string, mid: string, close: string) => `${open}${stampRow}${mid}${lastProductRow}${close}`,
      );
      return renumberRow(respanned, row.r, row.r + shift);
    });

  const lastRow = trailer.length ? Math.max(...trailer) + shift : lastProductRow;
  let sheetXml = `${head}${header.join("")}${productRows.join("")}${trailerRows.join("")}${tail}`;
  sheetXml = moveMerges(sheetXml, moved);
  // The card's banding and achievement colours are cut to the product block, never to the total row
  // underneath it — which is exactly where they would reach if the block stayed at July's fifteen
  // rows while the total moved up to row 20.
  sheetXml = resizeConditionalFormatting(sheetXml, stampRow, lastProductRow);

  // The Rep Card's arrow is a FORMULA the owner's engine carries -- `IF(ISNUMBER(G17),IF(G17>=0.5,
  // "up","down"),"")` -- so it does not go through `arrowFor` like every static sheet does, and the
  // two thresholds sat apart the moment one of them moved. Rewritten from the same constant, matched
  // on the shape of the formula rather than on the glyphs inside it, so the card follows the pages.
  sheetXml = sheetXml.replace(
    /(IF\(ISNUMBER\((\$?[A-Z]{1,3}\$?\d+)\),IF\(\2&gt;=)[\d.]+/g,
    (_match, head: string) => `${head}${ACHIEVEMENT_ARROW_AT}`,
  );

  zip.file(spec.file, setDimension(sheetXml, lastRow));
}

/**
 * Move one row, taking its cell references and its own relative formula references with it.
 * A shared formula cannot survive being cloned as a member — each copy is given its own text.
 */
function renumberRow(rowXml: string, fromRow: number, toRow: number): string {
  let xml = rowXml.replace(/<f t="shared"[^>]*si="\d+"\s*\/>/g, "");
  xml = xml.replace(/<f t="shared"[^>]*?>([\s\S]*?)<\/f>/g, (_m, body: string) => `<f>${body}</f>`);
  if (fromRow !== toRow) {
    xml = xml.replace(
      new RegExp(`(\\$?[A-Z]{1,3}\\$?)${fromRow}(?![0-9])`, "g"),
      (_m, prefix: string) => `${prefix}${toRow}`,
    );
    xml = setRowNumber(xml, toRow);
  }
  return xml;
}

/**
 * Every reference that carries a row count. The pivots are deliberately absent: their cache names
 * `SalesData`, so growing the table is all they need, and `refreshOnLoad` makes Excel rebuild them
 * when the file opens.
 */
async function updateReferences(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
  const salesRows = fill.data.salesData.length;
  const areaBookRows = fill.data.areaBook.length;
  const pickListRows = fill.data.pickList.length;

  for (const [path, rowCount, firstCol, lastCol] of [
    ["xl/tables/table1.xml", salesRows, "A", "N"],
    ["xl/tables/table2.xml", areaBookRows, "P", "AA"],
  ] as const) {
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async("string");
    // A table always needs at least one data row, even when the month is empty.
    const end = Math.max(rowCount + 1, 2);
    zip.file(path, xml.replace(/ref="[A-Z]+1:[A-Z]+\d+"/g, `ref="${firstCol}1:${lastCol}${end}"`));
  }

  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) return;
  let workbook = await workbookFile.async("string");

  // Two different last rows, because two different questions are being asked. The filter range wants
  // the last row of DATA -- a footnote inside it becomes a filterable row and disappears the moment
  // anyone filters. The print range wants the last row of CONTENT, footnotes included.
  const lastRowFor: Record<string, number> = {};
  const lastPrintRowFor: Record<string, number> = {};
  for (const [sheetName, spec] of Object.entries(MANIFEST.sheets)) {
    if (spec.kind === "formula") continue;
    const first = spec.firstDataRow ?? (spec.headerRows ?? 0) + 1;
    const written =
      sheetName === DATA_SHEET
        ? Math.max(salesRows, areaBookRows, Math.max(pickListRows - 1, 0))
        : fill.sheets[sheetName]?.rows?.length ?? 0;
    const lastData = written > 0 ? first + written - 1 : first;
    lastRowFor[sheetName] = lastData;
    // `fillPresentationSheet` re-lands the trailer rows at `lastData + trailerGap + index`, and
    // `setDimension` is told about them. This has to use the same arithmetic or the two disagree.
    const trailer = spec.trailerRows ?? [];
    lastPrintRowFor[sheetName] = trailer.length
      ? lastData + (spec.trailerGap ?? 2) + trailer.length - 1
      : lastData;
  }

  const repSpec = MANIFEST.sheets[REP_CARD];
  if (repSpec) {
    const trailer = repSpec.trailerRows ?? [];
    const stampRow = repSpec.productStampRow ?? 17;
    const products = fill.repCard?.products.length ?? 0;
    const firstTrailer = trailer.length ? Math.min(...trailer) : stampRow + 1;
    const shift = products ? stampRow + products - firstTrailer : 0;
    lastRowFor[REP_CARD] = (trailer.length ? Math.max(...trailer) : stampRow) + shift;
    lastPrintRowFor[REP_CARD] = lastRowFor[REP_CARD]!;
  }

  const clampTo =
    (rows: Record<string, number>) =>
    (_match: string, open: string, ref: string, close: string): string => {
      const parsed = /^('?)([^'!]+)\1!(\$[A-Z]+\$\d+):(\$[A-Z]+)\$(\d+)$/.exec(ref);
      if (!parsed) return `${open}${ref}${close}`;
      const [, quote, sheetName, first, lastColRef] = parsed;
      const last = rows[sheetName!];
      if (!last) return `${open}${ref}${close}`;
      return `${open}${quote}${sheetName}${quote}!${first}:${lastColRef}$${last}${close}`;
    };

  workbook = workbook.replace(
    /(<definedName name="_xlnm\._FilterDatabase"[^>]*>)([^<]*)(<\/definedName>)/g,
    clampTo(lastRowFor),
  );
  workbook = workbook.replace(
    /(<definedName name="_xlnm\.Print_Area"[^>]*>)([^<]*)(<\/definedName>)/g,
    clampTo(lastPrintRowFor),
  );
  workbook = workbook.replace(
    /(<definedName name="PhxPrintArea"[^>]*>)([^<]*)(<\/definedName>)/g,
    clampTo(lastPrintRowFor),
  );
  workbook = workbook.replace(
    /(<definedName name="PickList">)([^<]*)(<\/definedName>)/,
    (_m, open: string, _ref: string, close: string) =>
      `${open}Data!$AC$1:$AC$${Math.max(pickListRows, 1)}${close}`,
  );
  zip.file("xl/workbook.xml", workbook);
}

/**
 * Drop the shared-string table when nothing is left in it.
 *
 * THIS IS THE REPAIR PROMPT. The owner's engine carries 20,138 shared strings; the template build
 * strips every one of them, because this file writes text as inline strings instead. What it left
 * behind was `<sst count="0" uniqueCount="0"/>` -- a part still declared in `[Content_Types].xml`,
 * still related from the workbook, holding nothing, referenced by no cell. Excel answers that with
 * "We found a problem with some content in ...", repairs the workbook and rebuilds the part.
 *
 * An empty `<sst>` is schema-VALID, which is the whole reason this survived every check that was
 * run against it: the Open XML SDK validator reported the same twenty pre-existing pageSetup errors
 * for this file as for the owner's untouched one, and LibreOffice opened it without a murmur. The
 * only thing that saw it was diffing the package against a workbook Excel itself had written.
 *
 * Excel simply omits the part when a workbook has no strings, so that is what this does -- part,
 * content type and relationship together, since any one left behind is its own repair prompt.
 * Guarded on the table actually being empty: a template that keeps its strings keeps its part.
 */
async function dropDeadSharedStrings(zip: JSZip): Promise<void> {
  const file = zip.file(SHARED_STRINGS_PART);
  if (!file) return;

  const sst = await file.async("string");
  // Both spellings: a table with entries opens each one `<si>`, an empty one self-closes the root.
  if (/<si\b/.test(sst)) return;

  zip.remove(SHARED_STRINGS_PART);

  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    const ct = await ctFile.async("string");
    zip.file("[Content_Types].xml", ct.replace(/<Override PartName="\/xl\/sharedStrings\.xml"[^>]*\/>/g, ""));
  }

  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (relsFile) {
    const rels = await relsFile.async("string");
    zip.file("xl/_rels/workbook.xml.rels", rels.replace(/<Relationship\b[^>]*sharedStrings\.xml[^>]*\/>/g, ""));
  }
}

/**
 * Excel's own geometry, in the two units the file format mixes.
 *
 * A column width is a count of "0" characters in the workbook's standard font; a drawing anchor is
 * an offset in EMU inside a named column. Anything that has to move a shape — a slicer wide enough
 * for its buttons, a row of region buttons rebuilt for a line whose regions are not the ones the
 * template was cut from — has to convert between the two.
 */
const EMU_PER_PIXEL = 9525;
const DEFAULT_COLUMN_WIDTH = 9.140625;

/** EMU width of one column, 0-based, read off the sheet's own `<cols>` runs. */
function columnWidthReader(sheetXml: string): (index: number) => number {
  const runs: Array<{ emu: number; max: number; min: number }> = [];
  const block = /<cols>[\s\S]*?<\/cols>/.exec(sheetXml)?.[0] ?? "";
  for (const match of block.matchAll(/<col\b[^>]*?\/>/g)) {
    const min = Number(/\bmin="(\d+)"/.exec(match[0])?.[1] ?? 0);
    const max = Number(/\bmax="(\d+)"/.exec(match[0])?.[1] ?? 0);
    if (!min || !max) continue;
    const width = /\bhidden="1"/.test(match[0])
      ? 0
      : Number(/\bwidth="([\d.]+)"/.exec(match[0])?.[1] ?? DEFAULT_COLUMN_WIDTH);
    runs.push({ emu: width > 0 ? (Math.round(width * 7) + 5) * EMU_PER_PIXEL : 0, max, min });
  }
  const fallback = (Math.round(DEFAULT_COLUMN_WIDTH * 7) + 5) * EMU_PER_PIXEL;
  return (index) => {
    const column = index + 1;
    // LAST match, not first. `<cols>` may carry overlapping entries -- the owner's approved
    // reference does, and `applyExecutiveGeometry` appends narrow overrides on top of the template's
    // runs rather than rebuilding the block, because rebuilding dropped attributes Excel needed.
    // Excel resolves an overlap by letting the LATER entry win, so a reader that stops at the first
    // one measures a width the sheet no longer uses.
    //
    // Nothing about that failure looks like a width problem. Every drawing here is anchored in EMUs
    // computed from this function, so the whole navigation bar gets laid out against stale columns
    // and the buttons land on top of each other. Measured on the Rep Card, whose columns moved most;
    // Overview's barely moved and rendered perfectly, which is how it would have shipped.
    for (let at = runs.length - 1; at >= 0; at -= 1) {
      const run = runs[at]!;
      if (column >= run.min && column <= run.max) return run.emu;
    }
    return fallback;
  };
}

/** Which column an absolute x lands in, and how far into it — the shape an anchor wants. */
function locateColumn(widthOf: (index: number) => number, x: number): { col: number; colOff: number } {
  let left = 0;
  for (let col = 0; col < 16_384; col += 1) {
    const width = widthOf(col);
    if (width > 0 && x < left + width) return { col, colOff: Math.max(0, Math.round(x - left)) };
    left += width;
  }
  return { col: 16_383, colOff: 0 };
}

/** The absolute x an `<xdr:from>` or `<xdr:to>` block resolves to. */
function anchorX(widthOf: (index: number) => number, anchor: string): number {
  const col = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(anchor)?.[1] ?? 0);
  const off = Number(/<xdr:colOff>(-?\d+)<\/xdr:colOff>/.exec(anchor)?.[1] ?? 0);
  let left = 0;
  for (let index = 0; index < col; index += 1) left += widthOf(index);
  return left + off;
}

function writeAnchorX(anchor: string, at: { col: number; colOff: number }): string {
  return anchor
    .replace(/<xdr:col>\d+<\/xdr:col>/, `<xdr:col>${at.col}</xdr:col>`)
    .replace(/<xdr:colOff>-?\d+<\/xdr:colOff>/, `<xdr:colOff>${at.colOff}</xdr:colOff>`);
}

/** Move a whole two-cell anchor to a new x and width, keeping both row edges untouched. */
function moveAnchor(widthOf: (index: number) => number, block: string, x: number, width: number): string {
  const from = /<xdr:from>[\s\S]*?<\/xdr:from>/.exec(block)?.[0];
  const to = /<xdr:to>[\s\S]*?<\/xdr:to>/.exec(block)?.[0];
  if (!from || !to) return block;
  let out = block
    .replace(from, writeAnchorX(from, locateColumn(widthOf, x)))
    .replace(to, writeAnchorX(to, locateColumn(widthOf, x + width)));
  // `<a:off>`/`<a:ext>` is Excel's cached position. It is not what places a two-cell anchor, but a
  // stale one shows for an instant before the first redraw and prints wrong from a file nobody has
  // opened interactively, so it is kept in step.
  out = out.replace(/<a:off x="-?\d+" y="(-?\d+)"\/>/g, (_m, y: string) => `<a:off x="${Math.round(x)}" y="${y}"/>`);
  out = out.replace(
    /<a:ext cx="\d+" cy="(\d+)"\/>/g,
    (_m, cy: string) => `<a:ext cx="${Math.round(width)}" cy="${cy}"/>`,
  );
  return out;
}

/** Distinct values of one SalesData column, in the order the table first shows them. */
function distinctColumn(rows: EngineValue[][], index: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const value = row[index];
    if (value == null) continue;
    const text = String(value).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** The Area x Product sheet, the one page whose Region buttons are shapes rather than a slicer. */
const AREA_PRODUCT_SHEET = "Area x Product";
/** The two pivot sheets carrying a Region slicer. */
const SLICER_SHEETS = ["Closing Matrix", "Units Matrix"];
/** How many region columns the template's slicers were laid out for. */
const SLICER_TEMPLATE_COLUMNS = 7;
/** Gap between two buttons on the command row — the template's own spacing, 76200 EMU. */
const BUTTON_GAP = 76_200;
/** Fitted to the template's seven buttons: intercept, and EMU per unit of caption width. */
const BUTTON_BASE = 340_000;
const BUTTON_PER_UNIT = 74_500;

/**
 * Fit the Region controls to the line being exported.
 *
 * The template was cut from a CNS workbook, so every Region control in it is captioned and sized
 * for CNS's seven regions — and the region list is the one thing about this file that is not the
 * same from one line to the next. Anti Infective has more: it splits Upper Egypt into 1 and 2.
 *
 * Two separate things broke on that line, and neither of them looked broken.
 *
 *  - **The BUTTONS** on Area x Product are shapes whose CAPTION is the entire contract with the
 *    macro: `PhxRegionButton` reads the shape's own `TextFrame2.TextRange.Text` and asks the pivot
 *    for a PivotItem of exactly that name. A button reading "Upper Egypt" on a line whose regions
 *    are "Upper Egypt 1" and "Upper Egypt 2" therefore matches nothing and answers a click with
 *    "not on this tab" — and the two regions it was meant to open have no button at all. Seven
 *    hard-coded captions from another line is not a cosmetic defect; it is a dead control.
 *  - **The SLICERS** on the two matrices carry `columnCount="7"` in a frame one button-row high.
 *    An eighth region is not dropped — it is laid out on a second row the frame is too short to
 *    show. Invisible and unreachable, and the page reads as a line that has seven regions.
 *
 * Both are rebuilt from the regions actually present in the Data sheet being written beside them.
 */
async function fitRegionControls(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
  const regions = distinctColumn(fill.data.salesData, 0);
  if (!regions.length) return;
  await rebuildRegionButtons(zip, regions);
  // `widenRegionSlicers` is NOT called here. It has to run after `sizeMatrixColumns`; see the note
  // on the call site in `fillClosingEngine`.
}

/** A shape name has to be a plain identifier, and unique inside its drawing. */
function shapeName(region: string, taken: Set<string>): string {
  const base = `Rgn_${region.replace(/[^0-9A-Za-z]+/g, "")}`;
  let name = base === "Rgn_" ? "Rgn_Region" : base;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${base}${suffix}`;
    suffix += 1;
  }
  taken.add(name);
  return name;
}

/** Characters that are visibly narrower than a lower-case "o" in the button font. */
const NARROW_GLYPHS = " ().,-!ilj|:;";
/** Characters that are visibly wider. */
const WIDE_GLYPHS = "mwMW";

/** Rough advance width of a caption, in units where a lower-case "o" is 1. */
function captionUnits(caption: string): number {
  let units = 0;
  for (const ch of caption) {
    if (NARROW_GLYPHS.includes(ch) || ch === "'") units += 0.45;
    else if (WIDE_GLYPHS.includes(ch)) units += 1.5;
    else if (ch >= "A" && ch <= "Z") units += 1.15;
    else units += 1;
  }
  return units;
}

/**
 * How wide a button has to be to hold its caption.
 *
 * A caption the template already carries keeps the width the owner gave it — those seven are
 * measured, not modelled, and most regions on most lines are among them. Anything new is estimated
 * from a least-squares fit over those same seven (largest residual 5%), then given 6% on top: the
 * shapes are `wrap="none"`, so a button a little wide is a gap and a button a little narrow lets
 * its own caption hang over the rounded edge.
 */
function buttonWidth(caption: string, measured: Map<string, number>): number {
  const known = measured.get(caption);
  if (known) return known;
  return Math.round((BUTTON_BASE + BUTTON_PER_UNIT * captionUnits(caption)) * 1.06);
}

/** The row an `<xdr:from>` or `<xdr:to>` block sits on. */
function anchorRow(anchor: string): number {
  return Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(anchor)?.[1] ?? -1);
}

const ANCHOR_FROM = /<xdr:from>[\s\S]*?<\/xdr:from>/;
const ANCHOR_TO = /<xdr:to>[\s\S]*?<\/xdr:to>/;
const TWO_CELL_ANCHOR = /<xdr:twoCellAnchor\b[\s\S]*?<\/xdr:twoCellAnchor>/g;
/** The `<a:extLst>` that carries a shape's creationId, and nothing else. */
const CREATION_ID = /<a:extLst><a:ext uri="\{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236\}">[\s\S]*?<\/a:extLst>/;

/** The drawing part a sheet points at, with the sheet XML that gives its column geometry. */
async function sheetDrawing(
  zip: JSZip,
  sheetName: string,
): Promise<{ name: string; sheetXml: string; xml: string } | null> {
  const spec = MANIFEST.sheets[sheetName];
  if (!spec) return null;
  const sheetFile = zip.file(spec.file);
  const relsFile = zip.file(spec.file.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels"));
  if (!sheetFile || !relsFile) return null;
  const target = /Target="\.\.\/(drawings\/drawing\d+\.xml)"/.exec(await relsFile.async("string"))?.[1];
  if (!target) return null;
  const drawingFile = zip.file(`xl/${target}`);
  if (!drawingFile) return null;
  return { name: `xl/${target}`, sheetXml: await sheetFile.async("string"), xml: await drawingFile.async("string") };
}

/**
 * Replace the template's seven region buttons with one per region this month actually has.
 *
 * The first of them is used as the stamp, so every clone inherits the owner's own fill, shadow,
 * font, corner radius and `macro=` wiring — nothing about the look is restated here, which is what
 * keeps a restyle of the template from having to be repeated in this file.
 */
async function rebuildRegionButtons(zip: JSZip, regions: string[]): Promise<void> {
  const drawing = await sheetDrawing(zip, AREA_PRODUCT_SHEET);
  if (!drawing) return;

  const anchors = drawing.xml.match(TWO_CELL_ANCHOR) ?? [];
  const isRegion = (block: string) => /macro="PhxRegionButton"/.test(block);
  const buttons = anchors.filter(isRegion);
  const stamp = buttons[0];
  if (!stamp) return;

  const widthOf = columnWidthReader(drawing.sheetXml);
  const edge = (block: string, part: RegExp) => anchorX(widthOf, part.exec(block)?.[0] ?? "");
  const measured = new Map<string, number>();
  for (const block of buttons) {
    const caption = /<a:t>([\s\S]*?)<\/a:t>/.exec(block)?.[1];
    if (!caption) continue;
    // A measured width is only usable if it is POSITIVE. Both edges are resolved through the column
    // table, so a button whose two anchors land either side of a column whose width changed can
    // measure as zero or negative -- and that width goes straight into `<a:ext cx>`, which Excel
    // refuses outright: the workbook stops opening at all, with no repair prompt and nothing in the
    // integrity check to see, because the XML is perfectly well-formed. Measured cx=-750166 on the
    // Rep Ranking drawing. Dropping the bad measurement lets `buttonWidth` fall back to its caption
    // estimate, which is what it does for a caption it has never seen.
    const span = edge(block, ANCHOR_TO) - edge(block, ANCHOR_FROM);
    if (span > 0) measured.set(caption, span);
  }
  const startX = Math.min(...buttons.map((block) => edge(block, ANCHOR_FROM)));
  const endX = Math.max(...buttons.map((block) => edge(block, ANCHOR_TO)));
  // The band the buttons live on. Judged by row rather than by name, so that a command added to the
  // bar later is carried along without this function having to be told it exists — and so that the
  // emblem, which sits on row 0 well to the right of these buttons, is left exactly where it is.
  const band = anchorRow(ANCHOR_FROM.exec(stamp)?.[0] ?? "");

  // Ids stay unique across the whole drawing, so start above every id already in it.
  let nextId = Math.max(0, ...[...drawing.xml.matchAll(/<xdr:cNvPr id="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  const taken = new Set<string>();

  let x = startX;
  const rebuilt = regions.map((region) => {
    const width = buttonWidth(region, measured);
    // The creationId is Excel's own identity for a shape, and several shapes claiming one identity
    // is a conflict it has to resolve on load — so a clone carries none and Excel assigns its own.
    const block = stamp
      .replace(CREATION_ID, "")
      .replace(
        /<xdr:cNvPr id="\d+" name="[^"]*"/,
        `<xdr:cNvPr id="${nextId}" name="${xmlEscape(shapeName(region, taken))}"`,
      )
      .replace(/<a:t>[\s\S]*?<\/a:t>/, `<a:t>${xmlEscape(xmlSafe(region))}</a:t>`);
    nextId += 1;
    const placed = moveAnchor(widthOf, block, x, width);
    x += width + BUTTON_GAP;
    return placed;
  });

  const shift = x - BUTTON_GAP - endX;
  let out = drawing.xml;
  for (const block of anchors) {
    if (isRegion(block)) {
      out = out.replace(block, block === stamp ? rebuilt.join("") : "");
      continue;
    }
    const from = ANCHOR_FROM.exec(block)?.[0];
    const to = ANCHOR_TO.exec(block)?.[0];
    if (!from || !to || anchorRow(from) !== band) continue;
    const left = anchorX(widthOf, from);
    if (left < startX) continue;
    out = out.replace(block, moveAnchor(widthOf, block, left + shift, anchorX(widthOf, to) - left));
  }
  zip.file(drawing.name, out);
}

/**
 * Give the two Region slicers a column per region, and a frame wide enough to show them.
 *
 * One button keeps the width the owner gave it and the frame grows to hold however many there are.
 * Widening rather than squeezing is the point: "Upper Egypt 2" does not fit in a seventh of the CNS
 * frame, and a slicer button that clips its own region name is this same defect in a different
 * costume.
 */
async function widenRegionSlicers(zip: JSZip, regions: string[]): Promise<void> {
  for (const file of zip.file(/^xl\/slicers\/slicer\d+\.xml$/)) {
    const xml = await file.async("string");
    zip.file(file.name, xml.replace(/\bcolumnCount="\d+"/g, `columnCount="${regions.length}"`));
  }

  // A slicer button shows its caption or it shows an ellipsis, and an ellipsis is not something
  // this workbook is allowed to print. So a column is never narrower than the longest region name
  // the month has — and never narrower than the width the owner gave it either, because a short
  // month should not shrink the control.
  const needed = Math.max(...regions.map((region) => BUTTON_BASE + BUTTON_PER_UNIT * captionUnits(region)));

  for (const sheetName of SLICER_SHEETS) {
    const drawing = await sheetDrawing(zip, sheetName);
    if (!drawing) continue;
    const block = (drawing.xml.match(TWO_CELL_ANCHOR) ?? []).find((candidate) =>
      /graphicData uri="[^"]*\/slicer"/.test(candidate),
    );
    if (!block) continue;
    const from = ANCHOR_FROM.exec(block)?.[0];
    const to = ANCHOR_TO.exec(block)?.[0];
    if (!from || !to) continue;
    const widthOf = columnWidthReader(drawing.sheetXml);
    const left = anchorX(widthOf, from);
    const perColumn = Math.max((anchorX(widthOf, to) - left) / SLICER_TEMPLATE_COLUMNS, needed);
    zip.file(drawing.name, drawing.xml.replace(block, moveAnchor(widthOf, block, left, perColumn * regions.length)));
  }
}

/** The pivot table definition a sheet hosts, or "" when it hosts none. */
async function pivotPartFor(zip: JSZip, spec: SheetSpec): Promise<{ name: string; xml: string } | null> {
  const rels = zip.file(spec.file.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels"));
  if (!rels) return null;
  const target = /Target="\.\.\/(pivotTables\/pivotTable\d+\.xml)"/.exec(await rels.async("string"))?.[1];
  const file = target ? zip.file(`xl/${target}`) : null;
  return file ? { name: `xl/${target}`, xml: await file.async("string") } : null;
}

/** 1-based column number to its A1 letters — 1 is A, 27 is AA, 50 is AX. */
function columnLetters(column: number): string {
  let out = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  }
  return out;
}

/**
 * Column widths for the three matrix pages, in Excel's character units.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * A NUMBER TOO NARROW FOR ITS COLUMN RENDERS AS `#####`, which is the same complaint this whole
 * change exists to answer — data that is present and not readable. So every width here is set from
 * the longest thing the column actually holds, never from how much room is wanted:
 *
 *   region  16   holds "<Region> Total" as well as the region — "Delta (1) Total" is 15 characters,
 *                and column A CLIPS rather than overflowing, because column B beside it is filled.
 *   area    20   area names, and "<Area> Total" on Area x Product.
 *   product 24   the longest product name on any line, with room for a concentration suffix.
 *   money   11   "-12,345,678" is 11. The em dash a zero prints as is one.
 *   percent  8   "1234.5%" is 7.
 *
 * `grandMoney` is deliberately LEFT WIDE at the template's own 17.71. Its heading is "Total Sales
 * Value", which does not fit in the width "Sales Value" fits in — the two most-read columns on the
 * page once shipped saying "Total Sales Val" and "Total Target V", and narrowing this would put
 * that back.
 */
const MATRIX_WIDTH = {
  area: 20,
  // Area x Product is only six columns, so its total width is set almost entirely by its three
  // label columns — and A SHEET CANNOT BE NARROWER THAN ITS OWN CAPTION. A1 runs right until it
  // meets the emblem and `clearTitleEmblem` slides the emblem clear of it; cut these to the
  // matrices widths and the caption slides the logo 61px PAST THE LAST COLUMN, where it floats
  // over nothing. Measured, and caught by the emblem check in the export tests.
  areaProductArea: 24,
  areaProductRegion: 18,
  grandMoney: 17.7109375,
  grandPercent: 10,
  money: 11,
  percent: 8,
  // "Tebofortin Retard 480mg" is 23 characters and real names run longer; a clipped product name
  // is the ellipsis the owner has banned.
  product: 30,
  // Holds "<Region> Total" as well as the region itself, and the longest of those in production is
  // "Upper Egypt Total" at 17 characters — measured, not guessed.
  region: 18,
} as const;

/**
 * A copy of the engine's body-row format with wrapping turned on, added to `styles.xml` once.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY WRAP RATHER THAN WIDEN. Real area names are longer than they look: production carries
 * "Dokki - Mohandseen - Bolak" (26 characters) and "Imbaba - Imbaba Centers" (23). The area column is
 * followed by a NUMBER, and a text cell only overflows into an EMPTY neighbour — so at any width
 * under 26 those names are silently CUT OFF, which is lost text on the page the owner reads.
 *
 * Widening to fit is the obvious answer and it is the wrong one: 26 characters takes the frozen block
 * from 262px to 325px against a 375px phone, leaving 50px for data and undoing the reason the columns
 * were re-cut at all. Wrapping keeps the block at 276px AND shows the whole name — which is also the
 * house rule for fitting: wrap, never shrink and never truncate.
 *
 * The rows carry no `ht`, so Excel auto-fits the wrapped line. Idempotent: the xf is appended only
 * when an identical one is not already present, so a re-run cannot grow `styles.xml` unboundedly.
 */
async function ensureWrappedLabelStyle(zip: JSZip): Promise<string | null> {
  const file = zip.file("xl/styles.xml");
  if (!file) return null;
  const xml = await file.async("string");

  // Built from the engine's own body row (xf 9) rather than authored: same font, same vertical
  // centring, wrapping added. A style is a font AND an alignment AND a border, and inventing one
  // here would give these three pages a look the owner's template does not own.
  const wrapped =
    '<xf numFmtId="0" fontId="11" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">'
    + '<alignment vertical="center" wrapText="1"/></xf>';

  const body = xml.slice(xml.indexOf(">", xml.indexOf("<cellXfs")) + 1, xml.indexOf("</cellXfs>"));
  const existing = [...body.matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*?>[\s\S]*?<\/xf>/g)].map((one) => one[0]);
  const already = existing.indexOf(wrapped);
  if (already >= 0) return String(already);

  const added = appendCellXf(xml, wrapped);
  zip.file("xl/styles.xml", added.xml);
  return String(added.index);
}

/**
 * Re-cut every column on the three matrix pages to what it actually holds.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FROZEN PANE WAS WIDER THAN A PHONE. The template gives column B — the AREA name, "Cairo 1" —
 * a width of 86.71 characters, about 610px, and both matrices freeze at `xSplit="2"`, so columns A
 * and B are pinned on screen. That is 734px of frozen label on a 375px phone: the pinned block alone
 * is twice the screen, so scrolling right never reaches a number. Re-cut to 16 and 20 it is 262px,
 * which leaves room for the data to arrive beside it.
 *
 * The rest is arithmetic and it is worth stating plainly, because it bounds what this can achieve: a
 * line with 24 products spends 24 x 3 columns on the products alone. At the widths above that is
 * about 5,400px, and no honest re-sizing brings a matrix of that shape onto a 375px screen. What it
 * does is make the page usable — labels pinned and visible, numbers reachable by scrolling — rather
 * than fit it. `Area x Product` is the page that genuinely fits, and it holds the same figures.
 *
 * The grand-total block exists only where the pivot asks for it: the Units Matrix sets
 * `colGrandTotals="0"` and has none, which is also the flag that stops units being totalled across
 * products. It is read from the pivot rather than assumed here.
 */
async function sizeMatrixColumns(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
  const products = distinctColumn(fill.data.salesData, 5).length;
  if (!products) return;

  for (const sheetName of [...SLICER_SHEETS, AREA_PRODUCT_SHEET]) {
    const spec = MANIFEST.sheets[sheetName];
    const file = spec ? zip.file(spec.file) : null;
    if (!spec || !file) continue;
    const xml = await file.async("string");
    const cols = /<cols>[\s\S]*?<\/cols>/.exec(xml)?.[0];
    if (!cols) continue;

    // The template's own run for the value columns carries the style these pages are drawn in, so
    // it is re-cut rather than replaced — a hand-written <col> would lose `style="2"` and leave a
    // band of default-formatted columns across the sheet.
    const stamp = /<col\b[^>]*\bmin="3"[^>]*\/>/.exec(cols)?.[0];
    if (!stamp) continue;
    const style = /\bstyle="(\d+)"/.exec(stamp)?.[1];
    const column = (index: number, width: number): string =>
      `<col min="${index}" max="${index}" width="${width}"${style ? ` style="${style}"` : ""} customWidth="1"/>`;

    const widths: number[] = [];
    if (sheetName === AREA_PRODUCT_SHEET) {
      // Three row-label columns — Region, Area, Product — then one column per measure.
      widths.push(MATRIX_WIDTH.areaProductRegion, MATRIX_WIDTH.areaProductArea, MATRIX_WIDTH.product);
      widths.push(MATRIX_WIDTH.money, MATRIX_WIDTH.money, MATRIX_WIDTH.percent);
    } else {
      widths.push(MATRIX_WIDTH.region, MATRIX_WIDTH.area);
      for (let index = 0; index < products; index += 1) {
        widths.push(MATRIX_WIDTH.money, MATRIX_WIDTH.money, MATRIX_WIDTH.percent);
      }
      const hasTotals = !/\bcolGrandTotals="0"/.test((await pivotPartFor(zip, spec))?.xml ?? "");
      if (hasTotals) widths.push(MATRIX_WIDTH.grandMoney, MATRIX_WIDTH.grandMoney, MATRIX_WIDTH.grandPercent);
    }

    // Adjacent columns of the same width are emitted as one run, which is what Excel writes and
    // what keeps a 24-product line from carrying 75 separate <col> elements.
    const runs: string[] = [];
    let start = 1;
    for (let index = 0; index < widths.length; index += 1) {
      const next = widths[index + 1];
      if (next === widths[index]) continue;
      const width = widths[index]!;
      runs.push(
        start === index + 1
          ? column(start, width)
          : `<col min="${start}" max="${index + 1}" width="${width}"${style ? ` style="${style}"` : ""} customWidth="1"/>`,
      );
      start = index + 2;
    }

    // EVERYTHING PAST THE LAST USED COLUMN KEEPS WHAT THE TEMPLATE GAVE IT. The template's runs
    // reach well beyond the widest month it was cut for, and dropping them would leave a bare
    // default-width, style-less band across every sheet narrower than the template — which is a
    // visible defect on the page rather than a tidy-up.
    // A run that STRADDLES the boundary is re-cut, never dropped: the template's value run is
    // `min="3" max="50"`, so a month using 14 columns would otherwise leave 15..50 with no run at
    // all. Filtering on `min` alone is the mistake that produces the bare band.
    const tail = [...cols.matchAll(/<col\b[^>]*?\/>/g)]
      .map((one) => one[0])
      .map((one) => {
        const min = Number(/\bmin="(\d+)"/.exec(one)?.[1] ?? 0);
        const max = Number(/\bmax="(\d+)"/.exec(one)?.[1] ?? 0);
        if (max <= widths.length) return "";
        return min > widths.length ? one : one.replace(/\bmin="\d+"/, `min="${widths.length + 1}"`);
      })
      .join("");

    zip.file(spec.file, xml.replace(cols, `<cols>${runs.join("")}${tail}</cols>`));
  }
}

/**
 * Re-cut the achievement colouring on the three pivot sheets to the month that is actually in the
 * file. The template's band is frozen to July CNS — `E10:E17 H10:H17 … AX10:AX17` — and neither
 * half of that survives a different line.
 *
 * The COLUMNS over-reach, and that is not harmless. `AND(E10>=0,E10<0.5)` is TRUE of an EMPTY
 * cell, because a blank coerces to zero — so on any line carrying fewer products than CNS's
 * fifteen, every achievement column past the last real one is painted amber down the whole band:
 * a solid block of "under half of target" sitting over nothing at all. Anti Infective has twelve,
 * so it shipped with four such columns.
 *
 * The ROWS under-reach. Eight of them cover the pivot only while it is collapsed to region level,
 * which is how the template was saved. Both matrices carry a region slicer and Area x Product
 * carries an "Expand all" button, so one click puts every area row below the eighth outside the
 * rule and the colour simply stops. The band is sized for the fully expanded pivot instead.
 *
 * Extending the rows is only safe once the blank guard is in — the two defects have to be fixed
 * together or the second one multiplies the first down the whole sheet.
 *
 * Everything here is read off the pivot itself rather than assumed: where its data starts, how
 * many data fields repeat per column group, and whether it asks for a grand total. A rule set
 * whose first range does not start on the pivot's own first data row is left alone, so this can
 * never quietly rewrite some other sheet's formatting.
 */
async function sizePivotAchievementFormats(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
  const regions = distinctColumn(fill.data.salesData, 0).length;
  const areas = distinctColumn(fill.data.salesData, 1).length;
  const products = distinctColumn(fill.data.salesData, 5).length;
  if (!areas || !products) return;

  for (const sheetName of [...SLICER_SHEETS, AREA_PRODUCT_SHEET]) {
    const spec = MANIFEST.sheets[sheetName];
    const file = spec ? zip.file(spec.file) : null;
    if (!spec || !file) continue;
    const pivot = (await pivotPartFor(zip, spec))?.xml ?? "";
    const location = /<location\b[^>]*\/>/.exec(pivot)?.[0];
    if (!location) continue;

    const topRow = Number(/ref="[A-Z]+(\d+):/.exec(location)?.[1] ?? 0);
    const firstDataRow = Number(/\bfirstDataRow="(\d+)"/.exec(location)?.[1] ?? 0);
    const firstDataCol = Number(/\bfirstDataCol="(\d+)"/.exec(location)?.[1] ?? 0);
    const dataFields = Number(/<dataFields\b[^>]*\bcount="(\d+)"/.exec(pivot)?.[1] ?? 0);
    if (!topRow || !dataFields) continue;

    // A pivot with a real column field repeats its data fields once per product; one with only the
    // values placeholder (`<field x="-2"/>`) has a single group. The grand total is one more.
    const grouped = /<colFields\b[^>]*>[\s\S]*?<field x="(?!-2)\d+"\/>/.test(pivot);
    const groups = (grouped ? products : 1) + (grouped && !/\bcolGrandTotals="0"/.test(pivot) ? 1 : 0);

    const startRow = topRow + firstDataRow;
    const startCol = firstDataCol + 1;
    const columns = Array.from({ length: groups }, (_, g) => startCol + g * dataFields + (dataFields - 1));

    // Every row the pivot can show once it is fully opened: one per area-and-product line where
    // the product is a row field, one per area, one per region subtotal, and the grand total.
    const rowSpan = (grouped ? 0 : fill.data.salesData.length) + areas + regions + 2;
    const lastRow = startRow + rowSpan - 1;
    const sqref = columns.map((column) => {
      const letters = columnLetters(column);
      return `${letters}${startRow}:${letters}${lastRow}`;
    }).join(" ");
    const anchor = `${columnLetters(columns[0] ?? startCol)}${startRow}`;

    const xml = await file.async("string");
    const rebuilt = xml.replace(
      /<conditionalFormatting\b[^>]*\bsqref="([^"]*)"[^>]*>([\s\S]*?)<\/conditionalFormatting>/g,
      (block, ranges: string, rules: string) => {
        if (!new RegExp(`^[A-Z]+${startRow}:`).test(ranges)) return block;
        const rewritten = rules
          .replace(/<formula>[^<]*&gt;=1<\/formula>/, `<formula>AND(${anchor}&lt;&gt;"",${anchor}&gt;=1)</formula>`)
          .replace(
            /<formula>AND\([^<]*&lt;0\.5\)<\/formula>/,
            `<formula>AND(${anchor}&lt;&gt;"",${anchor}&gt;=0,${anchor}&lt;0.5)</formula>`,
          );
        return block.replace(`sqref="${ranges}"`, `sqref="${sqref}"`).replace(rules, rewritten);
      },
    );
    if (rebuilt !== xml) zip.file(spec.file, rebuilt);
  }
}

/** Row fields that open collapsed, by sheet. Anything not listed here opens expanded. */
const PIVOT_COLLAPSED: Record<string, number[]> = { [AREA_PRODUCT_SHEET]: [0, 1] };

/**
 * Put the pivots' regions, areas and products in the order every other sheet in the file uses,
 * and give all three the same opening state.
 *
 * A pivot field stores its own item order — `<item x="12"/><item x="7"/>…` — and Excel honours it
 * across a refresh, because a hand-sorted axis is a thing a user meant. The template's order is
 * July CNS's, and an index there points at whatever the pool now holds, so on another line it is
 * simply a shuffle: Area x Product opened with Zithrolide, Cefodox, Cefodox, Ceftrix, Levoxin,
 * Amoclan, Ceftrix — families scattered — while the Rep Card beside it listed the same twelve
 * products family by family. Written in ascending order the pivot follows the pool, and the pool
 * is the Data table, and the Data table is the matrix: one order across the whole workbook.
 *
 * The same list carries `sd`, the expand state. Seven of the template's items say `sd="0"` and an
 * eighth region has no entry at all, so a line with more regions than CNS opened with exactly one
 * of them expanded and the rest shut — which is what "Delta (2)" alone showing its areas was.
 *
 * Trimming both lists to the month's real counts is also what stops the shared-item pools being
 * padded: `restorePivotCacheSharedItems` sizes them from the highest index referenced here, so a
 * fifty-item list against twenty real areas is what invented "Area 21". It must therefore run
 * AFTER this.
 */
async function orderPivotItems(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
  for (const sheetName of [...SLICER_SHEETS, AREA_PRODUCT_SHEET]) {
    const spec = MANIFEST.sheets[sheetName];
    const part = spec ? await pivotPartFor(zip, spec) : null;
    if (!part) continue;
    const block = /<pivotFields\b[^>]*>[\s\S]*?<\/pivotFields>/.exec(part.xml)?.[0];
    if (!block) continue;

    const collapsed = new Set(PIVOT_COLLAPSED[sheetName] ?? []);
    let ordinal = -1;
    // A `<pivotField>` sits at the ordinal of the cache field it renders, and the cache reads the
    // Data table, so that ordinal is also the SalesData column this field's values come from.
    const rebuilt = block.replace(
      /<pivotField\b[^>]*?\/>|<pivotField\b[^>]*?>[\s\S]*?<\/pivotField>/g,
      (field) => {
        ordinal += 1;
        const items = /<items\b[^>]*>[\s\S]*?<\/items>/.exec(field)?.[0];
        const count = items ? distinctColumn(fill.data.salesData, ordinal).length : 0;
        if (!items || !count) return field;
        const shut = collapsed.has(ordinal) ? ' sd="0"' : "";
        const list = Array.from({ length: count }, (_, index) => `<item${shut} x="${index}"/>`).join("");
        return field.replace(items, `<items count="${count + 1}">${list}<item t="default"${shut}/></items>`);
      },
    );
    if (rebuilt !== block) zip.file(part.name, part.xml.replace(block, rebuilt));
  }

  // The region slicer indexes the same pool and is selected item by item, so it needs the same
  // treatment: left at the template's seven, a line with more regions cannot select the extras,
  // and a line with fewer keeps buttons for regions that do not exist. `showItemsWithNoData` means
  // a slicer never forgets an item, so a phantom there survives every refresh.
  const cacheFile = zip.file(/^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/)[0];
  const names = cacheFile
    ? [...(await cacheFile.async("string")).matchAll(/<cacheField\b[^>]*?\bname="([^"]*)"/g)].map((m) => m[1])
    : [];
  for (const file of zip.file(/^xl\/slicerCaches\/[^/]+\.xml$/)) {
    const xml = await file.async("string");
    const source = /\bsourceName="([^"]*)"/.exec(xml)?.[1];
    const field = source === undefined ? -1 : names.indexOf(source);
    const items = /<items\b[^>]*>[\s\S]*?<\/items>/.exec(xml)?.[0];
    const count = field < 0 ? 0 : distinctColumn(fill.data.salesData, field).length;
    if (!items || !count) continue;
    const list = Array.from({ length: count }, (_, index) => `<i x="${index}" s="1"/>`).join("");
    zip.file(file.name, xml.replace(items, `<items count="${count}">${list}</items>`));
  }
}

/**
 * Drop the label formats the template saved against CNS's seven regions.
 *
 * `<formats>` inside a pivot definition is a list of look-overrides pinned to positions in the
 * cache pool — `<x v="0"/>` means "whatever the first region happens to be". Every one this
 * template carries is `labelOnly="1"` and points at the same
 * `<dxf><alignment horizontal="left" indent="1"/></dxf>`, so between them they do exactly one
 * thing: indent the row labels by one.
 *
 * On a merged label cell that indent is not cosmetic. Expanding a region makes Excel merge its
 * name down its area rows, and a merged cell that is both wrapped and indented keeps almost none
 * of its width: "Cairo" came out as C-a-i-r stacked one letter to a line and cut off after four,
 * because Cairo has four areas. The one region that read as a word was "Others" — the eighth, and
 * the template has no eighth index to pin a format to.
 *
 * They are dropped rather than re-pinned to this month's regions: re-pinning would spread the
 * defect evenly instead of removing it, and the pivot style already carries the look. Only
 * alignment-only formats go. One carrying a font, fill, border or number format is a real
 * instruction about what a value looks like, and is left exactly where it is.
 */
async function dropStaleLabelFormats(zip: JSZip): Promise<void> {
  const styles = zip.file("xl/styles.xml");
  if (!styles) return;
  const block = /<dxfs\b[^>]*>[\s\S]*?<\/dxfs>/.exec(await styles.async("string"))?.[0] ?? "";
  const dxfs = [...block.matchAll(/<dxf>([\s\S]*?)<\/dxf>/g)].map((match) => match[1]);
  const alignmentOnly = (id: number): boolean => {
    const body = dxfs[id];
    return body !== undefined && body.replace(/<alignment\b[^>]*\/>/g, "").trim() === "";
  };

  for (const file of zip.file(/^xl\/pivotTables\/pivotTable\d+\.xml$/)) {
    const xml = await file.async("string");
    const formats = /<formats\b[^>]*>[\s\S]*?<\/formats>/.exec(xml)?.[0];
    if (!formats) continue;
    const each = [...formats.matchAll(/<format\b[^>]*>[\s\S]*?<\/format>|<format\b[^>]*\/>/g)]
      .map((match) => match[0]);
    const kept = each.filter(
      (one) => !(/\blabelOnly="1"/.test(one) && alignmentOnly(Number(/dxfId="(\d+)"/.exec(one)?.[1] ?? -1))),
    );
    if (kept.length === each.length) continue;
    zip.file(file.name, xml.replace(formats, kept.length ? `<formats count="${kept.length}">${kept.join("")}</formats>` : ""));
  }
}

/** The name, one point larger than the KPI numbers under it — which is the whole point. */
const REP_CARD_HERO_PT = 20;
/** The rank, up from the 10.5pt it shared with every ordinary caption on the sheet. */
const REP_CARD_BADGE_PT = 12;
const REP_CARD_DECK_PT = 10.5;
const REP_CARD_INK = "FF0F1E2B";
const REP_CARD_MUTED = "FF7A93A3";
const REP_CARD_BRAND = "FF0868A8";
/** Marks first place, and only first place. */
const REP_CARD_STAR = "★";
const REP_CARD_ROW_HEIGHT = { deck: 18, eyebrow: 14.1, hero: 30, tileLabel: 14.1, tileValue: 18 };

/**
 * ⚠ `deck` IS NO LONGER PLACED ON A CELL, and it is kept anyway. The Rep Card's tagline was
 * removed on 2026-09-10 and nothing writes this format now; dropping it would renumber `hero` and
 * `badge`, which are derived from this list's own length, for no gain a reader can see. It costs
 * one unused font and one unused cellXf in the emitted package.
 */
type RepCardStyles = { headline: number; plain: number; deck: number; hero: number; badge: number };

/**
 * Add the five formats the card needs, cloned from the ones the template already uses on it.
 *
 * Cloning rather than naming ids matters: the ids are whatever position the owner's source workbook
 * happened to put them in, and they move whenever the engine is rebuilt from a fresh one. A wrong id
 * is not an error — it is a differently coloured cell that nobody notices until it is printed.
 */
async function addRepCardStyles(zip: JSZip, sheetXml: string): Promise<RepCardStyles | null> {
  const file = zip.file("xl/styles.xml");
  if (!file) return null;
  const xml = await file.async("string");

  const fontCount = Number(/<fonts count="(\d+)"/.exec(xml)?.[1] ?? NaN);
  const cellXfs = /<cellXfs count="\d+"[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!Number.isFinite(fontCount) || !cellXfs) return null;
  const xfs = [...cellXfs[1]!.matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*?>[\s\S]*?<\/xf>/g)].map((one) => one[0]);
  if (!xfs.length) return null;

  const styleOf = (ref: string) =>
    Number(new RegExp(`<c r="${ref}"[^>]*?\\bs="(\\d+)"`).exec(sheetXml)?.[1] ?? NaN);
  // A1 is the caption, B1 a blank carrying the masthead's rule, B8 a tile value, F5 the rank,
  // B5 the picker — whose rule the rank has to pick up if row 5 is to read as one band.
  const base = [styleOf("A1"), styleOf("B1"), styleOf("B8"), styleOf("F5"), styleOf("B5")];
  if (base.some((one) => !Number.isFinite(one) || !xfs[one])) return null;
  const [titleXf, plainXf, valueXf, badgeXf, pickerXf] = base as [number, number, number, number, number];
  const pickerRule = Number(/\bborderId="(\d+)"/.exec(xfs[pickerXf]!)?.[1] ?? NaN);

  const swap = (xf: string, patch: { fontId?: number; borderId?: number }) => {
    let out = xf;
    if (patch.fontId !== undefined) out = out.replace(/\bfontId="\d+"/, `fontId="${patch.fontId}"`);
    if (patch.borderId !== undefined) {
      out = out.replace(/\bborderId="\d+"/, `borderId="${patch.borderId}"`);
      // Without `applyBorder`, a cellXf's borderId is free to be ignored in favour of the style it
      // derives from — so a rule set here would simply not be drawn, with nothing to see anywhere.
      if (!/\bapplyBorder="1"/.test(out)) out = out.replace(/\bxfId="(\d+)"/, `xfId="$1" applyBorder="1"`);
    }
    return out;
  };

  const fonts = [
    `<font><sz val="${REP_CARD_DECK_PT}"/><color rgb="${REP_CARD_MUTED}"/><name val="Segoe UI"/><family val="2"/></font>`,
    `<font><b/><sz val="${REP_CARD_HERO_PT}"/><color rgb="${REP_CARD_INK}"/><name val="Segoe UI"/><family val="2"/></font>`,
    `<font><b/><sz val="${REP_CARD_BADGE_PT}"/><color rgb="${REP_CARD_BRAND}"/><name val="Segoe UI"/><family val="2"/></font>`,
  ];
  // The blue rule under the masthead moves down with the caption: row 1 gives it up, row 2 takes it.
  const added = [
    swap(xfs[titleXf]!, { borderId: 0 }),
    swap(xfs[plainXf]!, { borderId: 0 }),
    swap(xfs[plainXf]!, { fontId: fontCount }),
    swap(xfs[valueXf]!, { fontId: fontCount + 1 }),
    // The rank takes the picker's rule so row 5 reads as one band across the card. It stays
    // unfilled: the tint is what marks the half of the row you can actually click.
    swap(xfs[badgeXf]!, {
      fontId: fontCount + 2,
      ...(Number.isFinite(pickerRule) ? { borderId: pickerRule } : {}),
    }),
  ];

  zip.file(
    "xl/styles.xml",
    xml
      .replace(/<fonts count="\d+"/, `<fonts count="${fontCount + fonts.length}"`)
      .replace("</fonts>", `${fonts.join("")}</fonts>`)
      .replace(/<cellXfs count="\d+"/, `<cellXfs count="${xfs.length + added.length}"`)
      .replace("</cellXfs>", `${added.join("")}</cellXfs>`),
  );

  return {
    headline: xfs.length,
    plain: xfs.length + 1,
    deck: xfs.length + 2,
    hero: xfs.length + 3,
    badge: xfs.length + 4,
  };
}

/**
 * Make the Rep Card the sheet a rep would want to send someone.
 *
 * It is the only sheet in the workbook that is about a person rather than a number, and the only one
 * anybody outside the company is likely to be shown. Three things were wrong with it as that.
 *
 * The caption ran the full width in one eighty-character line and stopped 25pt short of the
 * wordmark. Every other sheet solves that by sliding the emblem right — `clearTitleEmblem` below —
 * but this sheet is eight columns wide, 798px, and the emblem already sits at 689px with 16px of
 * slack. There is nowhere for it to go, so here the caption is what gives: it splits across the two
 * masthead rows the template already reserves, and the blue rule moves down to sit under both.
 *
 * One of the three tiles printed `D16`. The owner's standing rule is names, never codes, and a card
 * meant to be shared is the last place to break it. The tile now names the district manager, and the
 * full-width strip that used to carry the manager moves up to carry the REP, at 20pt — larger than
 * the KPI numbers beneath it, and above everything that merely describes them. First place gets a
 * star on the rank. Every value on the card is now a name or a number; none of them is a code.
 *
 * Nothing here is new machinery. The strip, the tiles, their merges and their formats all exist in
 * the owner's engine; what changes is which of them says what, and how loudly.
 *
 * `$N$2` is deliberately untouched. It holds the same area code the tile was showing — and it is
 * also the key every one of the card's product rows SUMIFS on. Hiding the code from the reader is
 * the ask; taking it off the sheet would empty the card.
 */
async function polishRepCard(zip: JSZip, _fill: ClosingEngineFill): Promise<void> {
  const spec = MANIFEST.sheets[REP_CARD];
  const file = spec ? zip.file(spec.file) : null;
  if (!spec || !file) return;

  const sheetXml = await file.async("string");
  const styles = await addRepCardStyles(zip, sheetXml);
  if (!styles) return;

  const { head, rows, tail } = splitSheet(sheetXml);
  const rowAt = (n: number) => rows.find((row) => row.r === n)?.xml ?? "";
  const cellAt = (rowXml: string, ref: string) =>
    new RegExp(`<c\\b[^>]*?r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(rowXml)?.[0] ?? "";
  const styleAt = (ref: string) =>
    Number(new RegExp(`<c r="${ref}"[^>]*?\\bs="(\\d+)"`).exec(sheetXml)?.[1] ?? NaN);

  const label = styleAt("B7"); // 8.5pt grey on the tint — the tile captions
  const value = styleAt("B8"); // 10.5pt bold navy — the tile values
  const ruled = styleAt("B1"); // a blank carrying the masthead's blue rule
  if (![label, value, ruled].every((one) => Number.isFinite(one) && one > 0)) return;

  const blanks = (row: number, from: string, to: string, style: number) => {
    let out = "";
    for (let column = columnIndex(from); column <= columnIndex(to); column += 1) {
      out += `<c r="${columnLetters(column)}${row}" s="${style}"/>`;
    }
    return out;
  };
  // Formulas go in as written. The ones built here carry no `&`, `<` or `>`; the rank formula is
  // lifted from the sheet already escaped, and escaping it a second time would double its `&amp;`.
  const formula = (ref: string, style: number, body: string) =>
    `<c r="${ref}" s="${style}"><f>${body}</f></c>`;
  const caption = (ref: string, style: number, text: string) =>
    `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${xmlEscape(text)}</t></is></c>`;
  const open = (row: number, height: number) =>
    `<row r="${row}" spans="1:14" ht="${height}" customHeight="1" x14ac:dyDescent="0.25">`;
  const lookUp = (column: string) => `IF($N$1=0,"",INDEX(AreaBook[${column}],$N$1))`;

  const written = new Map<number, string>();

  // 1 — the caption keeps its place and gives up the rule under it.
  written.set(
    1,
    rowAt(1)
      .replace(/(<c r="A1"[^>]*?)\bs="\d+"/, `$1s="${styles.headline}"`)
      .replace(/(<c r="[B-H]1"[^>]*?)\bs="\d+"/g, `$1s="${styles.plain}"`),
  );

  // 2 — the rule alone. The tagline that used to sit here was removed by the owner on 2026-09-10
  // ("irrelevnt txt behind the buttons"); see closing-engine-data.ts for why it did not move down a
  // row instead. `$N$2` stays — it is the area code every product row on the card SUMIFS on.
  written.set(
    2,
    `${open(2, REP_CARD_ROW_HEIGHT.deck)}${blanks(2, "A", "H", ruled)}`
      + `${cellAt(rowAt(2), "N2")}</row>`,
  );

  // 4 — the picker's caption. It read "Medical rep or area", which now sits three rows above a band
  // captioned "Medical rep"; the imperative is what the dropdown's own prompt already says.
  written.set(
    4,
    rowAt(4).replace(/(<c r="B4"[^>]*><is><t[^>]*>)[\s\S]*?(<\/t>)/, `$1Pick a rep or an area$2`),
  );

  // 5 — the rank reads as an award rather than a caption, and first place is marked as one. The
  // owner's own wording for the unranked case is kept by patching his formula, never retyping it.
  // F5:H5 also picks up the picker's rule, so the row is one band edge to edge rather than a
  // tinted box that stops two thirds of the way across with the rank floating past its edge.
  const rank = /<f[^>]*>([\s\S]*?)<\/f>/.exec(cellAt(rowAt(5), "F5"))?.[1] ?? "";
  let row5 = rowAt(5).replace(/(<c r="[GH]5"[^>]*?)\bs="\d+"/g, `$1s="${styles.badge}"`);
  if (rank.includes('"Rank "')) {
    row5 = row5.replace(
      new RegExp(`<c\\b[^>]*?r="F5"[^>]*?(?:/>|>[\\s\\S]*?</c>)`),
      formula(
        "F5",
        styles.badge,
        rank.replace(
          '"Rank "',
          () => `IF(INDEX(AreaBook[Rank],$N$1)=1,"${REP_CARD_STAR} ","")&amp;"Rank "`,
        ),
      ),
    );
  }
  written.set(5, row5);

  // 7/8 — the rep, full width, above everything that describes them.
  written.set(
    7,
    `${open(7, REP_CARD_ROW_HEIGHT.eyebrow)}${caption("B7", label, "Medical rep")}`
      + `${blanks(7, "C", "H", label)}</row>`,
  );
  written.set(
    8,
    `${open(8, REP_CARD_ROW_HEIGHT.hero)}${formula("B8", styles.hero, lookUp("Medical rep"))}`
      + `${blanks(8, "C", "H", value)}</row>`,
  );

  // 9/10 — the three tiles that describe them. Every one of them is a name.
  written.set(
    9,
    `${open(9, REP_CARD_ROW_HEIGHT.tileLabel)}${caption("B9", label, "Area")}<c r="C9" s="${label}"/>`
      + `${caption("D9", label, "Region")}<c r="E9" s="${label}"/>`
      + `${caption("F9", label, "District manager")}${blanks(9, "G", "H", label)}</row>`,
  );
  written.set(
    10,
    `${open(10, REP_CARD_ROW_HEIGHT.tileValue)}${formula("B10", value, lookUp("Area"))}`
      + `<c r="C10" s="${value}"/>${formula("D10", value, lookUp("Region"))}<c r="E10" s="${value}"/>`
      + `${formula("F10", value, lookUp("District manager"))}${blanks(10, "G", "H", value)}</row>`,
  );

  let out = `${head}${rows.map((row) => written.get(row.r) ?? row.xml).join("")}${tail}`;

  // The bands swapped shape as well as content: rows 7 and 8 are one merge each now, rows 9 and 10
  // are three. Only the rows whose SHAPE changed are re-merged — rows 1, 4 and 5 were patched in
  // place and keep the merges they have, and so does everything the filler has already moved.
  const reshaped = new Set([2, 7, 8, 9, 10]);
  const block = /<mergeCells[^>]*>[\s\S]*?<\/mergeCells>/.exec(out);
  if (block) {
    const kept = [...block[0].matchAll(/<mergeCell ref="([^"]*)"\s*\/>/g)]
      .filter((one) => !reshaped.has(Number(/\d+/.exec(one[1] ?? "")?.[0] ?? 0)))
      .map((one) => one[0]);
    const fresh = ["A2:H2", "B7:H7", "B8:H8", "B9:C9", "D9:E9", "F9:H9", "B10:C10", "D10:E10", "F10:H10"]
      .map((ref) => `<mergeCell ref="${ref}"/>`);
    out = out.replace(
      block[0],
      `<mergeCells count="${kept.length + fresh.length}">${kept.join("")}${fresh.join("")}</mergeCells>`,
    );
  }

  zip.file(spec.file, out);
}

/** Advance-width units of the title font, in EMU. Fitted to the sheets whose titles do fit. */
const TITLE_EMU_PER_UNIT = 91_500;
/** Clear air demanded between the end of the title and the emblem. */
const TITLE_GAP = 150_000;
/**
 * How far from column A the emblem may sit and still be seen, in EMU — 1,300px.
 *
 * 🔴 THIS IS WHY "STARTING FROM DETAILS NO LOGO THEIR". The mark was ON the Details sheet the
 * whole time, 2,313px along it, because the template anchors each emblem near the right edge of its
 * own sheet and Details is eighteen columns and 3,628px wide. Nobody scrolls a sheet of invoice
 * lines sideways to look at a logo, so on the widest tabs it had simply stopped existing.
 *
 * 1,300px is what a maximised Excel shows on a 1366-wide screen, so the mark is on the first screen
 * of both the sizes this workbook is read at. It is a CEILING, never a target: a sheet narrower
 * than that keeps the corner the owner's own template gave it.
 */
const EMBLEM_FIRST_SCREEN = 12_382_500;
const ANY_ANCHOR = /<xdr:(twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:\1>/g;

/**
 * Move the emblem clear of the title.
 *
 * Every sheet's title is one long string in A1 that overflows to the right, and the emblem sits
 * where the template put it — which is where it cleared "CNS". "Anti Infective" is eleven
 * characters longer, and the same title on the same sheet then runs under the logo: the Closing
 * Matrix shipped reading "sales value against t" with the rest behind the wordmark, and Area x
 * Product lost "at a time". Nothing about the sheet is wrong; the line name simply grew.
 *
 * So the emblem is placed against the measured title rather than left at a fixed column.
 *
 * ⚠ IT MOVES BOTH WAYS, since 2026-09-10, and the second direction is a different fault with
 * the same symptom. The template anchors each emblem near the right edge of its OWN sheet, which is
 * fine on a nine-column page and invisible on an eighteen-column one: Details carried its mark at
 * 2,313px, past the edge of any screen anyone reads it on, and the owner reported the sheet as
 * having no logo at all. `EMBLEM_FIRST_SCREEN` is the ceiling that brings it back. A sheet that
 * already sits inside that ceiling keeps the corner the owner arranged.
 */
async function clearTitleEmblem(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
  for (const [sheetName, content] of Object.entries(fill.sheets)) {
    const title = String(content.cells?.A1 ?? "");
    const found = title ? await sheetDrawing(zip, sheetName) : null;
    if (!found) continue;

    // The logo is a picture on every sheet that carries one; it is named "Emblem" on ten of them
    // and "Picture 1" on the two cloned from Family Performance, so the picture is what to match.
    const emblem = (found.xml.match(ANY_ANCHOR) ?? []).find((block) => block.includes("<xdr:pic"));
    const from = emblem ? ANCHOR_FROM.exec(emblem)?.[0] : null;
    if (!emblem || !from) continue;

    const widthOf = columnWidthReader(found.sheetXml);
    const left = anchorX(widthOf, from);
    const needed = Math.round(captionUnits(title) * TITLE_EMU_PER_UNIT) + TITLE_GAP;

    const to = ANCHOR_TO.exec(emblem)?.[0];
    // A one-cell anchor carries its own size and only the corner moves; a two-cell one is defined
    // by both corners, so it has to travel as a whole or the logo stretches.
    //
    // THE WIDTH MUST BE POSITIVE, and it is not always. Both corners are resolved through the
    // column table, so an emblem whose anchor spans columns that have since narrowed can measure as
    // zero or negative -- and that number goes straight into `<a:ext cx>`. Excel does not repair a
    // shape with a negative width, it REFUSES THE WORKBOOK: no dialog, no recovery log, and nothing
    // for the integrity check to see, because the XML is perfectly well formed. Measured
    // cx=-750166 on the Rep Ranking emblem.
    //
    // A logo left where the template put it is a cosmetic imperfection on one sheet. A workbook
    // that will not open is the whole file. So an unusable measurement means DO NOT MOVE IT.
    //
    // BUT THE MEASUREMENT ITSELF WAS THE FAULT. Taking the width as the distance between the two
    // corners resolves both through the column table, so the answer is only as stable as the
    // columns -- and this workbook now sets several of them to two and three characters. Skipping
    // the move kept the file openable and left the logo sitting ON TOP of the title, on exactly the
    // sheet whose title is longest. `<a:ext cx>` is the shape's own cached size, not derived from
    // the grid at all, so it survives any column change; the corner span is kept only as a fallback
    // for a shape that carries no ext.
    const cached = Number(/<a:ext\b[^>]*\bcx="(\d+)"/.exec(emblem)?.[1] ?? Number.NaN);
    const span = Number.isFinite(cached) && cached > 0 ? cached : to ? anchorX(widthOf, to) - left : 0;
    if (to && span <= 0) continue;

    // WHERE IT GOES. Right of the title if the title has reached it; back onto the first screen if
    // the template parked it past the edge of one and the title leaves room. Both directions, and
    // the cap yields to the title rather than the other way round — a logo sitting on top of the
    // month and the line is worse than a logo one screen along.
    //
    // THE BAND IS THE OTHER CEILING. The masthead is a filled navy strip as wide as the sheet's own
    // geometry, and a mark past the end of it floats on white — measured 101px off the end of Area
    // x Product. `EXECUTIVE_GEOMETRY` is what decides that width, so it is what decides this.
    const band = EXECUTIVE_GEOMETRY[sheetName];
    let bandWidth = 0;
    if (band) {
      const last = Math.max(...Object.keys(band.cols).map(Number), 1);
      for (let index = 0; index < last; index += 1) bandWidth += widthOf(index);
    }
    const ceiling = bandWidth > 0 ? Math.min(EMBLEM_FIRST_SCREEN, bandWidth) : EMBLEM_FIRST_SCREEN;
    const room = ceiling - span;
    const target = left < needed ? needed : left > room && room >= needed ? room : left;
    if (target === left) continue;

    const moved = to
      ? moveAnchor(widthOf, emblem, target, span)
      : emblem.replace(from, writeAnchorX(from, locateColumn(widthOf, target)));
    zip.file(found.name, found.xml.replace(emblem, moved));
  }
}

/**
 * The `<xdr:clientData>` that closes an anchor — the empty form or the paired one, either of which
 * may already carry attributes. `CT_AnchorClientData` has no child elements, only `fLocksWithSheet`
 * and `fPrintsWithSheet`, so collapsing the paired form to an empty tag loses nothing.
 */
const CLIENT_DATA = /<xdr:clientData\b([^>]*?)\/>|<xdr:clientData\b([^>]*?)>[\s\S]*?<\/xdr:clientData>/;

/**
 * Rewrite one `<xdr:clientData>` so its shape does not print, keeping whatever else it carried.
 * `fLocksWithSheet` travels on this same element, and dropping it would unlock every picture on
 * the sheet — so the existing attributes are preserved and only this one is replaced.
 */
function clientDataWithoutPrinting(_match: string, selfClosing?: string, paired?: string): string {
  const kept = (selfClosing ?? paired ?? "").replace(/\s*fPrintsWithSheet="[^"]*"/g, "").trim();
  return `<xdr:clientData${kept ? ` ${kept}` : ""} fPrintsWithSheet="0"/>`;
}

/**
 * Keep the emblem off the PRINTED page. Owner's instruction, 2026-09-05.
 *
 * The logo is a screen mark here: every sheet's own A1 title already names the company, the month
 * and the line, so on paper the emblem is a second masthead competing with the one the sheet
 * carries. `PhxExportPdf` has always walked every shape and turned printing off before it renders,
 * which is why the PDFs the button produces do not show it.
 *
 * BOTH BUILDS, not only the macro-free one. `PrintObject = False` set by the macro is in-memory
 * and dies with the workbook unless it is saved, and the flag as SAVED in the owner's own engine
 * says the pictures DO print — measured 2026-09-05 on his August Anti-Infective export: 38 buttons
 * off, 12 pictures on, 2 slicers on. So the .xlsm's printed page depended on the macro having run,
 * for that sheet, in that session. Written into the package it is ordinary stored state, and the
 * two formats then print the same page whether or not anything ran.
 *
 * PICTURES ONLY. The two slicers keep printing: the owner asked for the emblem, and a slicer is
 * what tells a reader which regions the sheet in their hand actually covers.
 *
 * Runs AFTER `clearTitleEmblem`, which rewrites these same anchors — the flag is the last word on
 * them either way, but reading the moved anchor is what keeps the two from fighting over one part.
 */
async function hideEmblemFromPrint(zip: JSZip): Promise<void> {
  for (const file of zip.file(/^xl\/drawings\/drawing\d+\.xml$/)) {
    const xml = await file.async("string");
    const printless = xml.replace(DRAWING_ANCHOR, (anchor) =>
      anchor.includes("<xdr:pic") ? anchor.replace(CLIENT_DATA, clientDataWithoutPrinting) : anchor,
    );
    if (printless !== xml) zip.file(file.name, printless);
  }
}

/**
 * Give the pivot cache back the shared items its own pivot tables still point at.
 *
 * THIS is the repair prompt the owner hit — "We found a problem with some content", every premium
 * export, `.xlsm` and `.xlsx` alike. Excel's recovery log names the cause exactly:
 *
 *     Removed Part: /xl/pivotTables/pivotTable1.xml part. (PivotTable view)   ...and 2 and 3
 *
 * The template build empties every `<sharedItems>` in the cache, because they hold the values of
 * the real July CNS workbook it was cut from and shipping one line's areas and reps inside another
 * line's export is a leak. It sets `refreshOnLoad="1"` and trusts the refresh to repopulate them.
 * It does not: `xl/pivotTables/*.xml` are left exactly as Excel wrote them, still enumerating that
 * month's values — `<item x="0"/>` … `<item x="49"/>` — and **Excel validates the pivot against
 * the cache BEFORE it honours `refreshOnLoad`**. Every index points into an empty pool, so all
 * three views are removed and the file is declared damaged. A cache and its pivots are one unit;
 * emptying either half alone is what breaks it.
 *
 * Deleting the enumerations instead does not work — measured, three ways: strip `<items>`, strip
 * `<rowItems>`/`<colItems>` too, strip the `<formats>` as well, and Excel still refuses the file.
 * So the pool is refilled rather than the references removed.
 *
 * The values written are THIS month's own, taken from the `SalesData` rows being written into the
 * same file — never the template's, which belong to another line and must not leak.
 *
 * An earlier version invented labels instead ("Region 1" … "Region 7"), on the argument that
 * `refreshOnLoad="1"` would replace them before anyone saw one. It replaces them in the GRID, but
 * not in the Region slicer: that cache is `crossFilter="showItemsWithNoData"`, so it keeps every
 * item it has ever been given, and one invented label survived the refresh as a greyed button —
 * which then pushed a real region out of the one visible row. A pool seeded with real values
 * cannot leave an orphan, because it holds nothing the refresh does not also find.
 *
 * A field with MORE real values than its pool is deep enough for is truncated rather than grown:
 * the pivot's own `<items>` enumerate a fixed count, and a pool longer than that count is the
 * other half of the mismatch this function exists to avoid. The refresh adds the rest. A short
 * pool is still padded with labels, so a blocked refresh shows something visibly unfinished rather
 * than something plausible and wrong.
 *
 * Idempotent by construction: only a self-closing `<sharedItems/>` — the emptied form — is
 * rewritten, so a template that already carries a populated pool is left untouched.
 */
async function restorePivotCacheSharedItems(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
  const cacheFiles = zip.file(/^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/);
  if (!cacheFiles.length) return;

  // Highest item index each cache field is referenced by, +1 — i.e. how deep the pool must be.
  const depth = new Map<number, number>();
  const need = (field: number, count: number): void => {
    if (!Number.isInteger(field) || field < 0 || count <= 0) return;
    depth.set(field, Math.max(depth.get(field) ?? 0, count));
  };

  for (const file of zip.file(/^xl\/pivotTables\/pivotTable\d+\.xml$/)) {
    const xml = await file.async("string");

    // A `<pivotField>` sits at the ordinal of the cache field it renders, so its position in the
    // list IS the field index. Both spellings have to be matched: a field with no items of its
    // own is self-closing, and a greedy pair pattern alone would swallow every one that is.
    const block = /<pivotFields\b[^>]*>([\s\S]*?)<\/pivotFields>/.exec(xml)?.[1] ?? "";
    const fields = block.match(/<pivotField\b[^>]*?\/>|<pivotField\b[^>]*?>[\s\S]*?<\/pivotField>/g) ?? [];
    fields.forEach((field, index) => {
      for (const item of field.matchAll(/<item\b[^>]*\bx="(\d+)"/g)) need(index, Number(item[1]) + 1);
    });

    // `baseItem` is the item a "% difference from" data field measures against — a shared-item
    // index like any other. Excel writes 1048832 for "no base item", which is a sentinel and not
    // an index: read literally it would demand a pool of a million entries.
    for (const df of xml.matchAll(/<dataField\b[^>]*?\/>/g)) {
      const baseField = Number(/\bbaseField="(-?\d+)"/.exec(df[0])?.[1] ?? -1);
      const baseItem = Number(/\bbaseItem="(\d+)"/.exec(df[0])?.[1] ?? -1);
      if (baseItem >= 0 && baseItem < NO_BASE_ITEM) need(baseField, baseItem + 1);
    }
  }

  for (const cacheFile of cacheFiles) {
    const xml = await cacheFile.async("string");
    const names = [...xml.matchAll(/<cacheField\b[^>]*?\bname="([^"]*)"/g)].map((m) => m[1]);

    // A slicer indexes the same pool: `Slicer_Region` lists `<i x="0"/>`…`<i x="6"/>` against the
    // cache field named by its `sourceName`. Left short, the slicer part is removed too.
    for (const file of zip.file(/^xl\/slicerCaches\/[^/]+\.xml$/)) {
      const slicer = await file.async("string");
      const source = /\bsourceName="([^"]*)"/.exec(slicer)?.[1];
      const field = source === undefined ? -1 : names.indexOf(source);
      if (field < 0) continue;
      for (const item of slicer.matchAll(/<i\b[^>]*\bx="(\d+)"/g)) need(field, Number(item[1]) + 1);
    }

    // The emptied fields appear in cache-field order, so counting them off as they are replaced is
    // what maps each one back to its index. That ordinal is also the SalesData COLUMN: the cache
    // reads the table, so cache field n and table column n are the same thing, and the fields past
    // the table's last column are calculated ones that carry no pool at all.
    let index = -1;
    const filled = xml.replace(/<sharedItems\s*\/>/g, () => {
      index += 1;
      const count = depth.get(index);
      if (!count) return "<sharedItems/>";
      const label = names[index] ?? `Field ${index + 1}`;
      const real = distinctColumn(fill.data.salesData, index).slice(0, count);
      const items = Array.from(
        { length: count },
        (_, n) => `<s v="${xmlEscape(real[n] ?? `${label} ${n + 1}`).replace(/"/g, "&quot;")}"/>`,
      ).join("");
      return `<sharedItems count="${count}">${items}</sharedItems>`;
    });

    if (filled !== xml) zip.file(cacheFile.name, filled);
  }
}

/**
 * Turn the workbook into a plain `.xlsx`. The VBA part, its content type and its relationship all
 * have to go together — a relationship pointing at a part that is not in the zip is itself a
 * repair prompt, which is the failure this function exists to avoid.
 *
 * The `bin` default extension STAYS: printerSettings parts are also `.bin`, and dropping it would
 * orphan every one of them.
 */
async function stripMacros(zip: JSZip): Promise<void> {
  zip.remove("xl/vbaProject.bin");

  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    const ct = await ctFile.async("string");
    zip.file(
      "[Content_Types].xml",
      ct
        .replace(/<Override PartName="\/xl\/vbaProject\.bin"[^>]*\/>/g, "")
        .replace(
          "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        ),
    );
  }

  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (relsFile) {
    const rels = await relsFile.async("string");
    zip.file("xl/_rels/workbook.xml.rels", rels.replace(/<Relationship\b[^>]*vbaProject\.bin[^>]*\/>/g, ""));
  }

  const workbookFile = zip.file("xl/workbook.xml");
  if (workbookFile) {
    const workbook = await workbookFile.async("string");
    // workbookPr/@codeName ties the workbook to the VBA project that is no longer here.
    zip.file("xl/workbook.xml", workbook.replace(/\s+codeName="[^"]*"/g, ""));
  }

  await dropMacroButtons(zip);
}

/**
 * One whole drawing anchor. Anchors never nest, so the first closing tag is this one's — and the
 * backreference keeps `oneCellAnchor` from being closed by a `twoCellAnchor`'s tag.
 */
const DRAWING_ANCHOR = /<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>[\s\S]*?<\/xdr:\1>/g;

/** A shape wired to a VBA routine. `macro=""` is the ordinary empty form and is not one. */
const WIRED_TO_A_MACRO = /<xdr:sp\b[^>]*\smacro="[^"]+"/;

/**
 * Take the buttons out with the VBA they call.
 *
 * THIS IS THE REPAIR PROMPT, the second time. Removing `vbaProject.bin` left 36 shapes across 11
 * drawings still carrying `macro="PhxRefresh"`, `macro="PhxExportPdf"`, `macro="PhxRegionButton"`
 * and the rest — the name of a routine in a project that is no longer in the package. Excel answers
 * a macro reference in a macro-free part with "We found a problem with some content in ...", and on
 * repair drops the drawing: the reader loses the emblem and the whole button bar anyway, having
 * first been told his file is damaged. It is what Excel itself does on Save As .xlsx, which is why
 * a workbook that made this trip through Excel never shows the defect.
 *
 * Nothing that works is lost. The buttons were shortcuts to things Excel does natively — Data ▸
 * Refresh All (and the pivot cache is `refreshOnLoad` regardless), the pivot's own ± expand and
 * collapse, a slicer's clear-filter ×, Ctrl+P ▸ PDF — and in the macro-free build they had been
 * inert since the day it shipped. Only the `.xlsm` is a working button bar, and this never runs
 * for it.
 *
 * Removal is by whole anchor, not by blanking the attribute: a button that still looks like a
 * button and does nothing is the worse failure, and it is the one a reader reports. The emblem
 * picture rides in its own anchor with an `r:embed`, carries no macro, and stays — which is the
 * reason this cuts per anchor rather than per drawing.
 */
async function dropMacroButtons(zip: JSZip): Promise<void> {
  for (const file of zip.file(/^xl\/drawings\/drawing\d+\.xml$/)) {
    const drawing = await file.async("string");
    const stripped = drawing.replace(DRAWING_ANCHOR, (anchor) =>
      WIRED_TO_A_MACRO.test(anchor) ? "" : anchor,
    );
    if (stripped !== drawing) zip.file(file.name, stripped);
  }
}

/**
 * Where the navigation bar can take a reader, in the order the buttons appear.
 *
 * FOUR, not thirteen, and the reason is measured rather than chosen. The command row sits on row 1
 * of every sheet, and the room left to its right before the print area ends is 351 px on Overview —
 * the narrowest, because Overview is the one portrait page — against 3,124 px on Details. A button
 * is about 105 px. So a bar that fits Overview fits everywhere, and a bar sized for Details would
 * hang off the side of Overview, which is the one thing the owner's fits-the-page rule forbids.
 *
 * Each sheet drops itself from the list and then takes as many of the rest as its own free space
 * allows, so a narrow sheet loses the last button rather than overflowing.
 */
const NAV_DESTINATIONS = ["Overview", "Closing Matrix", "Rep Ranking", "Details"] as const;

/** The Export PDF button, the one shape a macro-free build can keep by giving it somewhere to go. */
const EXPORT_PDF_BUTTON = /macro="PhxExportPdf"/;
/** `<xdr:cNvPr …>` — self-closing or paired. The hyperlink is its FIRST child in either form. */
const NON_VISUAL_PROPS = /<xdr:cNvPr\b[^>]*?\/>|<xdr:cNvPr\b[^>]*?>/;

/**
 * Give the Export PDF button a destination instead of a macro.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE ONE THING A `.xlsx` CAN DO. The format forbids a VBA part, so `PhxExportPdf` cannot exist in
 * this build and no Excel feature substitutes for it: Power Query loads data and cannot write a
 * file, Office Scripts has no PDF API and needs a Microsoft 365 tenant this company does not have,
 * and an Excel 4.0 macro sheet is barred from `.xlsx` for exactly the reason VBA is. A HYPERLINK is
 * allowed, so the button stops running code and starts opening a URL — the server renders the page
 * and hands the reader the PDF.
 *
 * THE OWNER'S OWN SHAPE, re-pointed. The template still holds his button here, before `stripMacros`
 * runs, so this keeps its caption, fill, font, size and position rather than authoring a new one
 * that would only look approximately right. `macro=` comes off in the same pass, which is what stops
 * `dropMacroButtons` from removing it two steps later — the two are ordered, not independent.
 *
 * A SHEET WITH NO PDF PAGE KEEPS NOTHING. `pdfLink` returns null for the three pivot sheets and the
 * Rep Card, whose button is then dropped with the others. A button that looks like a button and does
 * nothing is the failure this whole path exists to avoid, and it is the one a reader reports.
 */
async function linkPdfButtons(zip: JSZip, pdfLink: (sheet: string) => string | null): Promise<void> {
  for (const sheetName of Object.keys(MANIFEST.sheets)) {
    const url = pdfLink(sheetName);
    if (!url) continue;

    const found = await sheetDrawing(zip, sheetName);
    if (!found) continue;
    const button = (found.xml.match(DRAWING_ANCHOR) ?? []).find((anchor) => EXPORT_PDF_BUTTON.test(anchor));
    if (!button) continue;

    const relsName = found.name.replace(/drawings\/(drawing\d+)\.xml$/, "drawings/_rels/$1.xml.rels");
    const relsFile = zip.file(relsName);
    if (!relsFile) continue;
    const rels = await relsFile.async("string");

    // Next free id, read from the part rather than assumed. The emblem already holds rId1 on every
    // drawing, and a collision would repoint the picture at this URL — Excel then reports the file
    // as damaged rather than showing a wrong image.
    const used = [...rels.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]));
    const relId = `rId${Math.max(0, ...used) + 1}`;

    zip.file(
      relsName,
      rels.replace(
        "</Relationships>",
        `<Relationship Id="${relId}"`
          + ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"`
          + ` Target="${xmlEscape(url).replace(/"/g, "&quot;")}" TargetMode="External"/></Relationships>`,
      ),
    );

    const linked = button
      .replace(/\smacro="[^"]*"/, "")
      // `<a:hlinkClick>` is the first child of `cNvPr` in the schema, ahead of `hlinkHover` and
      // `extLst` — and the template's button carries an `extLst` creationId, so appending instead
      // would put the two in the wrong order and make the part invalid.
      .replace(NON_VISUAL_PROPS, (props) =>
        props.endsWith("/>")
          ? `${props.slice(0, -2)}><a:hlinkClick xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relId}"/></xdr:cNvPr>`
          : `${props}<a:hlinkClick xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relId}"/>`,
      );

    zip.file(found.name, found.xml.replace(button, linked));
  }
}

/** `#'Sheet name'!A1`, with an apostrophe in a sheet name doubled the way Excel escapes it. */
function sheetJumpTarget(sheet: string): string {
  return `#'${sheet.replace(/'/g, "''")}'!A1`;
}

/**
 * The right-hand edge a sheet's content may reach, from its own `<dimension>`.
 *
 * Read rather than carried as a second copy of each sheet's width in this file — a copy that would
 * be wrong the first time the owner adds a column.
 */
function contentRightEdge(sheetXml: string, widthOf: (index: number) => number): number {
  const ref = /<dimension\s+ref="[A-Z]+\d+:([A-Z]+)\d+"/.exec(sheetXml)?.[1];
  if (!ref) return Number.POSITIVE_INFINITY;
  let last = 0;
  for (const character of ref) last = last * 26 + (character.charCodeAt(0) - 64);
  let edge = 0;
  for (let index = 0; index < last; index += 1) edge += widthOf(index);
  return edge;
}

/** A unique shape name for a navigation button, in the template's own naming style. */
function navShapeName(destination: string, taken: Set<string>): string {
  const base = `Nav_${destination.replace(/[^0-9A-Za-z]+/g, "")}`;
  let name = base === "Nav_" ? "Nav_Sheet" : base;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${base}${suffix}`;
    suffix += 1;
  }
  taken.add(name);
  return name;
}

/**
 * Put a navigation bar on every sheet, in the owner's own button design.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE IDEA IS HIS, from a workbook of his own he pointed at: `Additions and deletions._8.xlsx`, a
 * genuine macro-free `.xlsx` — no `vbaProject.bin`, not macro-enabled — whose 25 shapes carry 0
 * macros and 17 hyperlinks. Its buttons say "Additions data sheet", "Interface", and they work.
 * They work because every one is a JUMP: a relationship with `Target="#'Sheet'!A1"` and NO
 * `TargetMode`, which is the form Excel itself writes and the form copied here. Marking such a link
 * External is what turns a working button into one Excel refuses to follow.
 *
 * That file has no pivot tables and no slicers, which is why its buttons are enough for it. It never
 * needed Expand, Collapse, Refresh or Reset — there is nothing in it to expand or refresh. Those
 * four stay impossible in a `.xlsx` and are not attempted: a hyperlink goes somewhere, it does not
 * run an Excel command. Their work is already reachable natively — the pivots keep their own `+`/`−`
 * and each slicer its clear-filter `×`.
 *
 * THE DESIGN IS HIS TOO, and not by imitation — each button is a CLONE of a real button already on
 * that sheet, so the fill, font, corner, shadow, height and row are the template's own values and
 * are never restated here. A restyle of the template carries into this bar with no change to this
 * function. Only the caption and the link are replaced.
 *
 * Cloning also inherits `fPrintsWithSheet="0"`, so the bar stays off the paper. A control is not
 * content, and a printed page of numbers should not carry a row of dead buttons.
 *
 * ORDER MATCHES THE TEMPLATE: commands first, Export PDF last, which is how the owner laid out
 * Overview's five. Export PDF is moved to sit after the new bar rather than left where it was, so
 * the row reads left to right with no gap where the dropped commands used to be.
 */
async function addSheetNavigation(zip: JSZip): Promise<void> {
  for (const sheetName of Object.keys(MANIFEST.sheets)) {
    if (sheetName === DATA_SHEET) continue;

    const found = await sheetDrawing(zip, sheetName);
    if (!found) continue;

    const anchors = found.xml.match(TWO_CELL_ANCHOR) ?? [];
    const buttons = anchors.filter((block) => /macro="[^"]+"/.test(block));
    if (buttons.length === 0) continue;

    const widthOf = columnWidthReader(found.sheetXml);
    const edge = (block: string, part: RegExp) => anchorX(widthOf, part.exec(block)?.[0] ?? "");

    // The command row, judged by the row its buttons sit on rather than by name — the emblem sits on
    // row 0 well to the right and must not be swept into this.
    const band = anchorRow(ANCHOR_FROM.exec(buttons[0] ?? "")?.[0] ?? "");
    const onBand = buttons.filter((block) => anchorRow(ANCHOR_FROM.exec(block)?.[0] ?? "") === band);
    if (onBand.length === 0) continue;

    const exportButton = onBand.find((block) => EXPORT_PDF_BUTTON.test(block)) ?? null;
    // Prefer a command button as the stamp: it is the shape being replaced, so its width already
    // suits a caption of this kind. Export PDF is the fallback on a sheet carrying only that one.
    const stamp = onBand.find((block) => !EXPORT_PDF_BUTTON.test(block)) ?? exportButton;
    if (!stamp) continue;

    const measured = new Map<string, number>();
    for (const block of onBand) {
      const caption = /<a:t>([\s\S]*?)<\/a:t>/.exec(block)?.[1];
      if (caption) measured.set(caption, edge(block, ANCHOR_TO) - edge(block, ANCHOR_FROM));
    }

    const startX = Math.min(...onBand.map((block) => edge(block, ANCHOR_FROM)));
    const limit = contentRightEdge(found.sheetXml, widthOf);
    const exportWidth = exportButton ? edge(exportButton, ANCHOR_TO) - edge(exportButton, ANCHOR_FROM) : 0;

    // Fit as many as the sheet can actually hold, measured against its own right edge rather than
    // assumed. Overview is the binding case — one portrait page, 351 px of clear room — against
    // 3,124 px on Details. A bar sized for Details would hang off the side of Overview, which is
    // precisely what the owner's fits-the-page rule forbids.
    const budget = limit - startX - (exportButton ? exportWidth + BUTTON_GAP : 0);
    const chosen: string[] = [];
    let used = 0;
    for (const destination of NAV_DESTINATIONS) {
      if (destination === sheetName) continue;
      const width = buttonWidth(destination, measured) + (chosen.length > 0 ? BUTTON_GAP : 0);
      if (used + width > budget) break;
      chosen.push(destination);
      used += width;
    }
    if (chosen.length === 0) continue;

    const relsName = found.name.replace(/drawings\/(drawing\d+)\.xml$/, "drawings/_rels/$1.xml.rels");
    const relsFile = zip.file(relsName);
    if (!relsFile) continue;
    let rels = await relsFile.async("string");
    let nextRel = Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]))) + 1;
    let nextId = Math.max(0, ...[...found.xml.matchAll(/<xdr:cNvPr id="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
    const taken = new Set<string>();

    let x = startX;
    const bar = chosen.map((destination) => {
      const relId = `rId${nextRel}`;
      rels = rels.replace(
        "</Relationships>",
        `<Relationship Id="${relId}"`
          + ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"`
          + ` Target="${xmlEscape(sheetJumpTarget(destination)).replace(/"/g, "&quot;")}"/></Relationships>`,
      );
      nextRel += 1;

      const width = buttonWidth(destination, measured);
      const block = stamp
        // Several shapes claiming one creationId is a conflict Excel resolves on load.
        .replace(CREATION_ID, "")
        // Emptied, not removed: `macro=""` is what Excel itself writes on a linked shape, and
        // `dropMacroButtons` matches a NON-empty one, so this is also what keeps the bar alive
        // through the strip two steps later.
        .replace(/\smacro="[^"]*"/, ' macro=""')
        .replace(
          /<xdr:cNvPr id="\d+" name="[^"]*"/,
          `<xdr:cNvPr id="${nextId}" name="${xmlEscape(navShapeName(destination, taken))}"`,
        )
        .replace(NON_VISUAL_PROPS, (props) =>
          props.endsWith("/>")
            ? `${props.slice(0, -2)}><a:hlinkClick xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relId}"/></xdr:cNvPr>`
            : `${props}<a:hlinkClick xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relId}"/>`,
        )
        .replace(/<a:t>[\s\S]*?<\/a:t>/, `<a:t>${xmlEscape(xmlSafe(destination))}</a:t>`);
      nextId += 1;

      const placed = moveAnchor(widthOf, block, x, width);
      x += width + BUTTON_GAP;
      return placed;
    });

    // Every command button goes; the bar and the moved Export PDF take the row. Done as two passes
    // so the anchor a button is replaced BY is never one this loop then searches for again.
    let out = found.xml;
    for (const block of onBand) {
      if (block === exportButton) continue;
      out = out.replace(block, "");
    }
    out = exportButton
      ? out.replace(exportButton, bar.join("") + moveAnchor(widthOf, exportButton, x, exportWidth))
      : out.replace("</xdr:wsDr>", `${bar.join("")}</xdr:wsDr>`);

    zip.file(found.name, out);
    zip.file(relsName, rels);
  }
}

/**
 * Open the workbook on its first sheet.
 *
 * The owner asked for this, and the reason it was worth asking is measured: the template ships
 * `activeTab="6"` with `tabSelected="1"` on Area x Product, because that is the sheet the workbook
 * happened to be saved on. Every export therefore opened on a pivot page — and on the one sheet
 * whose title collided with the logo, which is how he saw the defect the moment he opened it.
 *
 * BOTH HALVES OR NEITHER. `activeTab` alone is not enough: Excel reads each sheet's own
 * `tabSelected`, and leaving it set on a second sheet opens the two as a GROUP, where an edit on one
 * is silently written to the other. That is a worse failure than the wrong tab.
 */
async function openOnFirstSheet(zip: JSZip): Promise<void> {
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) return;
  const workbook = await workbookFile.async("string");

  // The workbook's OWN order, not the manifest's: the contents page is added ahead of everything and
  // is not in the manifest at all, so a manifest-ordered answer would select the wrong tab.
  const first = unescapeSheetName(/<sheet name="([^"]+)"/.exec(workbook)?.[1] ?? "");
  if (!first) return;

  zip.file(
    "xl/workbook.xml",
    workbook.replace(/(<workbookView\b[^>]*?)\s*activeTab="\d+"/, "$1").replace(/<workbookView\b/, '<workbookView activeTab="0"'),
  );

  // Resolved from the workbook and its relationships, not from the manifest: sheets are added at
  // fill time now, and a list built from the manifest cannot see them.
  const workbookRels = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const relTarget = Object.fromEntries(
    [...workbookRels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
  const parts = [...workbook.matchAll(/<sheet name="([^"]+)"[^>]*?r:id="(rId\d+)"/g)]
    .map((m) => ({ file: `xl/${(relTarget[m[2]] ?? "").replace(/^\/?(xl\/)?/, "")}`, name: unescapeSheetName(m[1]) }))
    .filter((entry) => entry.file !== "xl/");
  for (const { file: partName, name: sheetName } of parts) {
    const file = zip.file(partName);
    if (!file) continue;
    const xml = await file.async("string");
    const selected = sheetName === first;
    const next = xml.replace(/<sheetView\b[^>]*>/, (tag) => {
      const bare = tag.replace(/\s*tabSelected="[^"]*"/, "");
      return selected ? bare.replace(/<sheetView\b/, '<sheetView tabSelected="1"') : bare;
    });
    if (next !== xml) zip.file(partName, next);
  }
}

/**
 * Ask every reader to calculate the formulas on open.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY FORMULA IN THIS WORKBOOK SHIPS WITHOUT A CACHED VALUE. The Rep Card is 35 of them, the
 * contents page 12 more, and the template carries no `xl/calcChain.xml` — measured on the emitted
 * file, `<f>…</f>` with no `<v>` beside it, every one. Desktop Excel builds a chain and calculates
 * regardless, which is why this went unnoticed; a reader that does not will show those cells blank.
 *
 * One attribute fixes it for all of them, and it costs nothing on desktop: the pivot cache is
 * already `refreshOnLoad="1"`, so the workbook was always going to be marked dirty on open — this
 * adds no save prompt that was not there.
 *
 * Written LAST, after every other rewrite of `xl/workbook.xml`, because each of those reads the
 * part and writes it back whole; run earlier, the next one would drop the attribute again.
 */
async function recalculateOnOpen(zip: JSZip): Promise<void> {
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) return;
  const workbook = await workbookFile.async("string");
  if (/<calcPr\b[^>]*fullCalcOnLoad="1"/.test(workbook)) return;

  // A template with no <calcPr> at all is not this one, but a bare replace would then silently do
  // nothing — so the element is added rather than assumed. It belongs after <sheets>, which is
  // where Excel writes it and where the schema's sequence puts it.
  const next = /<calcPr\b/.test(workbook)
    ? workbook.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"')
    : workbook.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>');
  zip.file("xl/workbook.xml", next);
}


/**
 * The Rep Card's Export PDF, as a FORMULA rather than a shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS ONE IS DIFFERENT. Every other Export PDF on this workbook is a shape carrying a fixed
 * hyperlink, which is fine because every other sheet renders the same page every time. The Rep Card
 * does not: it draws whichever rep the dropdown in `B5` is set to, and a shape's hyperlink is written
 * once at export and can never see that. `=HYPERLINK()` is a formula, so it rebuilds its URL every
 * time the sheet recalculates — pick a different rep and the link follows. No macro, and the only
 * mechanism in a `.xlsx` that can do this at all.
 *
 * `$N$1` is the sheet's own lookup index — `IFERROR(MATCH($B$5, AreaBook[Label], 0), 0)` off the
 * dropdown — and the area code is resolved from it here rather than read out of another cell. That
 * is deliberate: the first attempt pointed at `$B$2` on the assumption it held the resolved code,
 * and `B2` is EMPTY. The link then fell back to its own guard on every rep, which looks exactly like
 * "nothing is selected" and is why this is verified by opening the workbook rather than by reading
 * the formula back. `N1` is zero when nothing matches, which is the guard's real condition.
 *
 * PLACED IN A CELL, NOT DRAWN. It sits at F4, on the label row beside "Pick a rep or an area" and
 * directly above the rank block, in the row's own style. A shape would look more like the other
 * buttons and would not work; this works.
 */
async function addRepCardPdfLink(zip: JSZip, base: string): Promise<void> {
  const spec = MANIFEST.sheets[REP_CARD];
  const file = spec ? zip.file(spec.file) : null;
  if (!file) return;

  const xml = await file.async("string");
  // The row the dropdown's own label sits on, and the style that label uses — so the link matches
  // the sheet rather than introducing a look this file would have to keep in step with a restyle.
  const row = /<row\b[^>]*\br="4"[^>]*>[\s\S]*?<\/row>/.exec(xml)?.[0];
  if (!row) return;

  // F4 may already be PRESENT AND EMPTY — the template styles cells it never fills, and the first
  // version read "the cell exists" as "the cell is taken" and silently wrote nothing. Its own test
  // caught that. An empty cell is filled in place; one carrying anything is left alone.
  const existing = /<c r="F4"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/.exec(row);
  if (existing && (existing[1] ?? "").trim() !== "") return;

  // A BUTTON, IN THE ONE LOUD COLOUR ON THE SHEET. Owner, 2026-09-09: "Rep Card EXPORT PDF make it
  // appearing as a button but different catchy color." It stays a CELL because the link has to
  // follow the dropdown -- a drawing cannot read one, and a shape here would send every reader to
  // whichever rep happened to be selected when the file was built. So the cell is dressed as a
  // button instead: accent cyan, white bold type, centred.
  //
  // The captions are short for the same reason. A filled block cannot let its text overflow into
  // the next cell the way an unfilled one does, so a long caption would be cut off at the fill's
  // edge -- and the owner's standing rule forbids truncating text. Both branches fit.
  const accent = await ensureAccentButtonStyle(zip);
  const style =
    accent >= 0
      ? String(accent)
      : (/<c r="F4"[^>]*\bs="(\d+)"/.exec(row)?.[1] ?? /<c r="B4"[^>]*\bs="(\d+)"/.exec(row)?.[1]);

  // `&` is the formula's own concatenation operator AND an XML entity, so it is escaped once here
  // and Excel sees a single `&`. Getting this wrong yields a workbook Excel offers to repair.
  const formula = xmlEscape(
    `IF($N$1=0,"PICK A REP FIRST",`
      + `HYPERLINK("${base}&area="&INDEX(AreaBook[Area Code],$N$1),"EXPORT PDF  ↗"))`,
  );
  const cell = `<c r="F4"${style ? ` s="${style}"` : ""}><f>${formula}</f></c>`;

  // Replace the empty cell where there is one; otherwise insert after B4 so the cells stay in
  // column order — Excel is strict about that and repairs a sheet whose cells descend.
  // REPLACER FUNCTIONS, NOT REPLACEMENT STRINGS, and this is load-bearing rather than style. The
  // formula contains `$N$1`, and in a replacement string `$1` means CAPTURE GROUP ONE — so the
  // string form spliced the matched B4 cell into the middle of the formula and produced a workbook
  // Excel has to repair. It was invisible until the emitted XML was read back, and the version
  // before this survived only by accident: `$B$2` has no group two, so it stayed literal.
  const withCell = existing
    ? row.replace(existing[0], () => cell)
    : row.replace(/<c r="B4"[^>]*(?:\/>|>[\s\S]*?<\/c>)/, (match) => `${match}${cell}`);
  if (withCell === row) return;

  zip.file(spec!.file, xml.replace(row, withCell));
}

/**
 * What each page holds, in the owner's own vocabulary.
 *
 * A SET OF THE ONES THAT GET A ROW, never a list of the ones that do not — a sheet added to the
 * engine later is simply absent from the contents until somebody writes a line for it, rather than
 * appearing with a blank description. `Data` is deliberately not here: it is `veryHidden`, it is the
 * source block the pivots and the Rep Card read, and it is not a page anybody navigates to.
 *
 * GROUPED, because twelve undifferentiated rows are a list and a reader arriving with a question —
 * "where do I see product families?" — has to read all twelve to answer it. The four bands are the
 * questions the workbook actually answers, and they are in TAB ORDER: a contents page that sorts
 * its own way disagrees with the tab strip underneath it, and then the reader has to hold two
 * orders in their head. Every band is a heading the owner would say out loud, not a taxonomy.
 */
const INDEX_SECTIONS: ReadonlyArray<{ band: string; entries: ReadonlyArray<{ sheet: string; what: string }> }> = [
  {
    band: "Start here",
    entries: [
      { sheet: "Overview", what: "The month at a glance — sales, target and achievement for every region, and how many areas reached their target." },
      { sheet: "Rep Ranking", what: "Every area ranked by achievement against its own target, with its medical rep and district manager." },
      { sheet: "Rep Card", what: "One rep at a time, picked from the dropdown — their month, every product, and an Export PDF for that card." },
      { sheet: "Top Achievers", what: "The ten highest against their own target." },
    ],
  },
  {
    band: "By area",
    entries: [
      { sheet: "Closing Matrix", what: "Sales value against target, per area, with each region foldable and the Region slicer above it." },
      { sheet: "Units Matrix", what: "Units against target — never summed across products, because each has its own target." },
      { sheet: "Area x Product", what: "Value against target, opened one region at a time." },
    ],
  },
  {
    band: "By product family",
    entries: [
      { sheet: "Family Performance", what: "Each product family by value, and its share of the line." },
      { sheet: "Family by Month", what: "The families month by month, oldest first, as the series fills forward." },
    ],
  },
  {
    band: "Behind the numbers",
    entries: [
      { sheet: "Watch List", what: "Every area and product still short of target, largest shortfall first." },
      { sheet: "Top Customers", what: "Every named customer, largest first, with each one's share and the running share." },
      // The second half used to run along the Details masthead itself, where it made the caption
      // 285 characters and pushed the emblem 2,313px down the sheet. It reads better here anyway:
      // it is the thing to know BEFORE opening a sheet of invoice lines, not after.
      { sheet: "Details", what: "Every invoice row behind the month, as invoiced — Office and store sales are credited where they were earned." },
    ],
  },
];

/**
 * The closing line, set under the table.
 *
 * It answers the one question the page otherwise invites: three of the tabs listed above hold no
 * rows in the file at all — measured on the emitted workbook, 2, 2 and 6 cells, which is their
 * title and nothing more. Excel materialises the grid from the pivot cache when the file opens, so
 * a reader who gets there first sees an empty page and concludes the export is broken.
 *
 * IT USED TO SAY THIS WAS A MATTER OF RECALCULATION, which reads as a state that passes. On a phone
 * it never passes: Excel for iOS/Android and WPS Office open a PivotTable read-only from the records
 * it already carries, and this cache ships empty by design. `writePivotGrids` now writes the grid
 * into the cells so the pages are readable there — but the Region slicer and the fold are live pivot
 * controls and cannot follow, so the line says what a phone reader does and does not get.
 *
 * It is merged across A:B — 122 character widths — so it CLIPS rather than overflowing. Keep it
 * short enough to read whole; `runClosingEngineExportTests` pins the length.
 */
const INDEX_FOOTNOTE =
  "The three matrix pages are pivot tables: on a phone they open flat, without the Region slicer or the fold.";

/** The band an appended sheet is listed under when it names none of its own. */
const DEFAULT_APPENDED_BAND = "Performance review";

type IndexEntry = { after?: string; sheet: string; what: string };
type IndexSection = { band: string; entries: ReadonlyArray<IndexEntry> };

/** Group the appended sheets into contents-page sections, in the order their bands first appear. */
function appendedSections(sheets: ReviewSheet[]): IndexSection[] {
  const bands = new Map<string, IndexEntry[]>();
  for (const sheet of sheets) {
    const band = sheet.band ?? DEFAULT_APPENDED_BAND;
    if (!bands.has(band)) bands.set(band, []);
    bands.get(band)?.push({ ...(sheet.after ? { after: sheet.after } : {}), sheet: sheet.name, what: sheet.what });
  }
  return [...bands.entries()].map(([band, entries]) => ({ band, entries }));
}

/**
 * Fold the appended sections into the literal ones, so a band is never printed twice.
 *
 * An appended sheet that names a band the page ALREADY has belongs inside it: the contents page is
 * in tab order on purpose (a page that sorts its own way disagrees with the tab strip under it and
 * the reader then holds two orders in their head), and a tab inserted next to the Closing Matrix
 * has to be listed next to it too. Where that sheet also names an `after`, it lands directly under
 * that row; otherwise it goes to the end of its band. A band the page does not have is appended
 * whole, exactly as before — which is every sheet this mechanism was built for.
 */
function mergeIndexSections(
  literal: ReadonlyArray<IndexSection>,
  appended: ReadonlyArray<IndexSection>,
): IndexSection[] {
  const byBand = new Map(
    appended.map((section): [string, ReadonlyArray<IndexEntry>] => [section.band, section.entries]),
  );
  const merged: IndexSection[] = literal.map((section) => {
    const extra = byBand.get(section.band);
    if (!extra) return section;
    byBand.delete(section.band);
    const entries: IndexEntry[] = [...section.entries];
    for (const entry of extra) {
      const at = entry.after ? entries.findIndex((one) => one.sheet === entry.after) : -1;
      if (at < 0) entries.push(entry);
      else entries.splice(at + 1, 0, entry);
    }
    return { ...section, entries };
  });
  // Whatever named a band of its own, in the order those bands first appeared.
  for (const section of appended) {
    if (byBand.has(section.band)) merged.push(section);
  }
  return merged;
}

/**
 * The next free `xl/worksheets/sheetN.xml`, read from the package.
 *
 * A CONSTANT HERE COST A WHOLE SHEET. The contents page used to hard-code `sheet14.xml`, which was
 * free when it was the only sheet being added. Once the review sheets were added first they took
 * that name, and the contents page then OVERWROTE one of them — two `<sheet>` entries pointing at
 * one part, District Managers replaced by the contents page. Structurally valid, so the package
 * integrity check passed it; the only symptom is a tab showing another tab's contents.
 */
function nextWorksheetPart(zip: JSZip): string {
  const used = Object.keys(zip.files)
    .map((name) => Number(/^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name)?.[1] ?? 0));
  return `xl/worksheets/sheet${Math.max(0, ...used) + 1}.xml`;
}

const INDEX_SHEET = "Contents";

/**
 * How much larger the cover's mark is than the one the working sheets carry.
 *
 * Theirs sits in the corner of a table and only has to be present. This one is the mark ON the
 * cover, beside a 22pt title in a 66pt band, and at the siblings' size it read as an afterthought
 * dropped into a lot of empty colour. The band's height is set from this, so the two cannot drift
 * apart: change the scale and the band grows with it.
 */
const INDEX_MARK_SCALE = 1.7;
/** Clear air between a right-aligned mark and the end of its band, in EMU — 8px, the siblings'. */
const EMBLEM_EDGE_GAP = 76_200;


/**
 * Add the contents page, and put it first.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE OWNER ASKED FOR THIS as "page one": every tab as something you can press, with a line beside it
 * saying what that tab holds. Thirteen sheets is more than a tab strip communicates, and the tab
 * strip does not say what any of them contains.
 *
 * WRITTEN AS CELLS, NOT SHAPES, and that is a deliberate difference from the navigation bar. The bar
 * clones a real button because it sits on a crowded command row where it has to match the buttons
 * beside it. This page has no such row and needs a NAME AND A DESCRIPTION side by side — which is a
 * table, and a table of thirteen floating shapes with thirteen text boxes beside them would be worse
 * to read and far more fragile. `HYPERLINK("#'Sheet'!A1", …)` jumps exactly as a shape's link does.
 *
 * STYLES ARE BORROWED, never authored. Every style index used here already exists in the template's
 * `styles.xml` — the title, the subtitle, the blue table header and the body row are the ones the
 * other sheets use. Adding entries to `styles.xml` would mean this file owning a look that the
 * owner's own template should own.
 *
 * BOTH BUILDS. The contents page carries no macro and no shape, so nothing about it depends on which
 * extension the workbook has, and a reader opening the `.xlsm` should not get a worse front page
 * than one opening the `.xlsx`.
 */
async function addIndexSheet(zip: JSZip, fill: ClosingEngineFill, extra: ReviewSheet[] = []): Promise<void> {
  const workbookFile = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  const typesFile = zip.file("[Content_Types].xml");
  if (!workbookFile || !relsFile || !typesFile) return;

  const workbook = await workbookFile.async("string");
  if (workbook.includes(`<sheet name="${INDEX_SHEET}"`)) return;

  const indexPart = nextWorksheetPart(zip);
  const rels = await relsFile.async("string");
  const nextRel = Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  const nextSheetId = Math.max(0, ...[...workbook.matchAll(/sheetId="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  const relId = `rId${nextRel}`;

  // Only the pages this workbook actually carries. A filtered export drops no sheets today, but a
  // contents page that promises a tab which is not there is worse than one that is short.
  const present = new Set(
    [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => unescapeSheetName(m[1])),
  );
  // The appended sheets are built at export time from the month's own data, so they cannot sit in
  // the literal above. One that names a band of its OWN gets it rather than being added to "Behind
  // the numbers" — it answers a different question, and when it is not included its heading
  // disappears with it instead of standing over nothing. One that names a band the page already
  // has is folded INTO it, under the row it follows, so the page stays in tab order; printing the
  // same heading twice is what reads as a broken page. A sheet that names no band is the review's.
  const sections = mergeIndexSections(INDEX_SECTIONS, appendedSections(extra))
    .map((section) => ({ ...section, entries: section.entries.filter((entry) => present.has(entry.sheet)) }))
    .filter((section) => section.entries.length > 0);
  if (sections.length === 0) return;

  // The look is cloned off the Overview, never named by index. See resolveIndexStyles.
  const own = await resolveIndexStyles(zip);
  const s: IndexPalette = own ?? {
    band: "0", bannerBlank: "0", bannerFoot: "0", bannerSub: "0", bannerTitle: "0", body: "0", foot: "0",
    header: "0", link: "0", title: "0", titlePt: "13", titleTail: "0",
  };

  const line = String(fill.sheets.Overview?.cells?.A1 ?? "").trim();
  const rows: string[] = [];
  // Collected as the rows are written rather than counted afterwards: every band adds one, so a
  // hard-coded `count` is a repair prompt waiting for the next section.
  const merges: string[] = [];
  let rowNumber = 1;

  const inline = (ref: string, style: string, value: string) =>
    `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(xmlSafe(value))}</t></is></c>`;

  // ── THE SKELETON IS THE SIBLINGS' ─────────────────────────────────────────────────────────────
  //
  // Rep Ranking, Watch List and the Overview are all built the same way, and this page is now built
  // that way too rather than to a look of its own: the masthead on row 1 at 33.95 with the rule
  // carried across it, the blue column band on row 2 at the same height, two spacer rows, and the
  // table from row 5 at 16.5 — the height every data row in this workbook uses. The pane freezes at
  // row 4 exactly as theirs do, so the band stays put while the list scrolls.
  // Tall enough for the bigger title AND the emblem beside it: the mark is 330200 EMU (26pt) and
  // wants clear air above and below, which 33.95 does not give once the type grows.
  // THE BUILD STAMP COMES OFF THE TITLE. The sibling sheets carry
  // "… Anti Infective   ·   built 7 September 2026" as one string, which is right on a working
  // sheet; on the cover at this size it is what pushed the headline onto a second line and left the
  // emblem beside a wrapped edge. The month keeps the headline, the stamp moves to the footnote —
  // still on the page, still answerable, no longer competing with the title.
  const separator = line.lastIndexOf("·");
  const stamp = separator > 0 ? line.slice(separator + 1).trim() : "";
  const headline = (separator > 0 ? line.slice(0, separator) : line).trim();

  // The sheets write their caption as one run separated by wide gaps —
  // "Monthly Closing   August 2026   Anti Infective". The banner sets the first part as the
  // headline and the rest as the line under it, which is the only split that survives a line whose
  // parts change from month to month.
  const captionParts = headline.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
  const bannerHead = (captionParts[0] ?? "Monthly Closing").toUpperCase();
  const bannerSub = captionParts.slice(1).join("   ·   ");

  // THE BANNER: four rows, so the type has air above and below it inside the band rather than
  // sitting hard against its edges. Column A stays WHITE across all four — that panel is what the
  // mark stands on; see resolveIndexStyles for why it cannot sit on the band itself.
  // Sized around the mark rather than guessed: the emblem is INDEX_MARK_SCALE times the siblings'
  // ~26pt, so the band has to clear that with air above and below or the logo touches its edges.
  const bannerRowsPt = [10, 32, 22, 10];
  const bannerText = [null, { style: s.bannerTitle, value: bannerHead },
    { style: s.bannerSub, value: bannerSub }, null];
  const lastBannerRow = bannerRowsPt.length - 1;
  bannerRowsPt.forEach((heightPt, index) => {
    const cell = bannerText[index];
    rows.push(
      `<row r="${rowNumber}" ht="${heightPt}" customHeight="1">`
        // BOTH columns take the band, so it runs edge to edge. The mark does not sit on a white
        // COLUMN — that read as a pale rectangle floating beside a blue one rather than as one
        // masthead. It sits on a white CHIP drawn inside the band, which is what addIndexEmblem
        // puts there.
        + `<c r="A${rowNumber}" s="${index === lastBannerRow ? s.bannerFoot : s.bannerBlank}"/>`
        + (cell && cell.value
          ? inline(`B${rowNumber}`, cell.style, cell.value)
          : `<c r="B${rowNumber}" s="${index === lastBannerRow ? s.bannerFoot : s.bannerBlank}"/>`)
        + "</row>",
    );
    rowNumber += 1;
  });

  // A thin breath between the band and the table, so the two are not welded together.
  rowNumber += 1;


  // NO ZEBRA. It was #F5F9FC on white — at reading size it is invisible, so it was adding a style
  // to the file and nothing to the page. The rules under each row do the separating.
  for (const [sectionIndex, section] of sections.entries()) {
    // A blank row above every section but the first. Air is what turns a list into a contents page,
    // and it is the one thing the cramped version was missing most.
    if (sectionIndex > 0) rowNumber += 1;
    merges.push(`A${rowNumber}:B${rowNumber}`);
    rows.push(
      `<row r="${rowNumber}" ht="30" customHeight="1">`
        + inline(`A${rowNumber}`, s.band, section.band.toUpperCase())
        + `<c r="B${rowNumber}" s="${s.band}"/>`
        + "</row>",
    );
    rowNumber += 1;

    for (const entry of section.entries) {
      // The jump is the same form Excel writes for a shape's in-document link, spelled as a formula
      // so the cell itself is the control. `#` and the quoted sheet name are both required.
      const jump = xmlEscape(`HYPERLINK("#'${entry.sheet.replace(/'/g, "''")}'!A1","${entry.sheet}")`);
      rows.push(
        `<row r="${rowNumber}" ht="24" customHeight="1">`
          + `<c r="A${rowNumber}" s="${s.link}"><f>${jump}</f></c>`
          + inline(`B${rowNumber}`, s.body, entry.what)
          + "</row>",
      );
      rowNumber += 1;
    }
  }

  // The footnote, one blank row below the last band.
  rowNumber += 1;
  merges.push(`A${rowNumber}:B${rowNumber}`);
  rows.push(
    `<row r="${rowNumber}" ht="20" customHeight="1">`
      + inline(`A${rowNumber}`, s.foot, stamp ? `${INDEX_FOOTNOTE}   ·   ${stamp}` : INDEX_FOOTNOTE)
      + "</row>",
  );

  const lastRow = rowNumber;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:B${lastRow}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A3" sqref="A3"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="96" customWidth="1"/></cols><sheetData>${rows.join("")}</sheetData><mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells><pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="1"/></worksheet>`;

  // The emblem, beside the title. Done before the part is written so the sheet lands with its
  // <drawing> already in place.
  zip.file(
    indexPart,
    await addSheetEmblem(zip, indexPart, sheetXml, { columnIndex: 0, rowHeightsPt: bannerRowsPt }),
  );

  zip.file(
    "[Content_Types].xml",
    (await zip.file("[Content_Types].xml")!.async("string")).replace(
      "</Types>",
      `<Override PartName="/${indexPart}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
  );

  zip.file(
    "xl/_rels/workbook.xml.rels",
    rels.replace(
      "</Relationships>",
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${indexPart.replace("xl/", "")}"/></Relationships>`,
    ),
  );

  // FIRST in the list, because the tab order is this list's order — that is what makes it page one.
  //
  // AND EVERY DEFINED NAME MOVES WITH IT. `localSheetId` is a POSITIONAL index into this same list,
  // not a name, so inserting a sheet at the front silently re-attaches every print area, print title
  // and filter range to the sheet before it — the Overview's print area becomes the contents page's,
  // and so on down. Nothing about that is visible in the sheets themselves; it surfaces as the wrong
  // rows printing, which is the sort of defect that reaches paper before anybody notices. The
  // package integrity check catches it, and this is the fix it demanded.
  const shifted = workbook.replace(
    /<definedName\b([^>]*?)\blocalSheetId="(\d+)"/g,
    (_match, before: string, id: string) => `<definedName${before}localSheetId="${Number(id) + 1}"`,
  );

  zip.file(
    "xl/workbook.xml",
    shifted.replace(
      "<sheets>",
      () => `<sheets><sheet name="${INDEX_SHEET}" sheetId="${nextSheetId}" r:id="${relId}"/>`,
    ),
  );
}


/** Sheet names reach `workbook.xml` XML-escaped; the comparisons here do not. */
function unescapeSheetName(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Number formats taken from the engine's own catalogue, not invented.
 *
 * s43 is `#,##0;-#,##0;"—"` — thousands separated, and an em dash where a zero would otherwise read
 * as "sold nothing". s44 is `0.0%`. s46 is `+0.0%;-0.0%;0.0%`, which signs a growth figure so a fall
 * is unmistakable. Using the engine's own styles is what keeps these sheets looking like the ones
 * beside them through any restyle of the template.
 */
const REVIEW_STYLE = { header: "8", money: "43", percent: "44", growth: "46", text: "9", title: "77", subtitle: "79", link: "81" } as const;

/**
 * Which format a column takes, decided by its HEADING.
 *
 * The heading is the only thing that travels with the value — the row arrives as bare numbers, and a
 * ratio printed as `0.86` where the sheet beside it says `86.3%` is unreadable rather than wrong,
 * which is the harder kind of defect to notice.
 */
function reviewColumnStyle(heading: string): string {
  const name = heading.trim().toLowerCase();
  if (name.startsWith("against the month before")) return REVIEW_STYLE.growth;
  if (name.startsWith("achievement") || name.startsWith("share")) return REVIEW_STYLE.percent;
  // A matrix-shaped tab repeats its achievement column once per product, so the heading cannot
  // START with the word — it has to name the product first ("Rispadex Ach"). Matching the END as
  // well is what lets such a sheet exist; without it every one of those columns silently takes the
  // money format and prints a ratio of 0.863 as "1". Kept to the exact words the two spellings
  // above already reserve, so no heading changes meaning that did not before.
  if (name.endsWith(" ach") || name.endsWith(" achievement")) return REVIEW_STYLE.percent;
  return REVIEW_STYLE.money;
}

/**
 * Write the Performance Review's sheets into the workbook.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * APPENDED, NEVER INSERTED. These go on the END of the sheet list, and that is not a cosmetic
 * choice: `localSheetId` on a defined name is a POSITION in that list, so a sheet added at the FRONT
 * silently re-attaches every print area and print title to its neighbour. The contents page pays
 * that cost deliberately and shifts them; these do not have to, so they do not.
 *
 * Each sheet opens with a link back to the contents page. They carry no drawing, so they get no
 * navigation bar — the bar is built by cloning a button that exists on a sheet, and there is none
 * here to clone. One link back is the honest substitute.
 */
/**
 * The index of the workbook's own zebra stripe, found by its FILL and never by its position.
 *
 * Every striped sheet in the template points at a `<dxf>` holding one thing: a background in the
 * palest blue of the approved palette. That is the stripe. Reading it back rather than naming an
 * index is the same rule `addRepCardStyles` and the contents page already follow — an index is
 * wherever the owner's source workbook happened to put it, and it moves when the engine is rebuilt.
 *
 * Returns null when the template carries no such dxf, in which case the sheet ships unstriped. A
 * missing stripe is a plainer sheet; a wrong dxf id is a sheet wearing a red "under target" fill on
 * every second row.
 */
async function zebraDxf(zip: JSZip): Promise<number | null> {
  const xml = await zip.file("xl/styles.xml")?.async("string");
  const block = xml ? /<dxfs count="\d+"[^>]*>([\s\S]*?)<\/dxfs>/.exec(xml)?.[1] : null;
  if (!block) return null;
  const all = [...block.matchAll(/<dxf>[\s\S]*?<\/dxf>/g)].map((one) => one[0]);
  const wanted = new RegExp(`<(?:bg|fg)Color rgb="(?:${EXECUTIVE_ZEBRA_FILLS.join("|")})"`, "i");
  const at = all.findIndex((one) => wanted.test(one) && !/<font\b/.test(one) && !/<border\b/.test(one));
  return at >= 0 ? at : null;
}

/**
 * Put the workbook's mark on the sheets that were built without one.
 *
 * `addReviewSheets` authors its three sheets from scratch, so they carry no drawing at all — no
 * emblem, and nothing for `clearTitleEmblem` or `applyOnDarkEmblem` to find. Every sheet that came
 * out of the owner's own engine has the mark in its masthead; these three simply never did, which
 * is the second half of "starting from details no logo their".
 *
 * `addSheetEmblem` does the work, right-aligned against the end of the last column, on the one row
 * the band occupies. It is the same call the contents page makes, with a different corner.
 */
async function addReviewEmblems(zip: JSZip, sheets: ReviewSheet[]): Promise<string[]> {
  if (sheets.length === 0) return [];
  const parts = await resolveSheetParts(zip);
  const done: string[] = [];
  for (const sheet of sheets) {
    const part = parts.get(sheet.name);
    const file = part ? zip.file(part) : null;
    if (!part || !file) continue;
    const sheetXml = await file.async("string");
    if (/<drawing\b/.test(sheetXml)) continue;
    const placed = await addSheetEmblem(zip, part, sheetXml, {
      align: "right",
      columnIndex: sheet.headers.length - 1,
      rowHeightsPt: [REVIEW_BAND_PT],
      scale: 1,
    });
    if (placed === sheetXml) continue;
    zip.file(part, placed);
    done.push(sheet.name);
  }
  return done;
}

/** The height of the review sheets' own masthead row, in points. Written by `addReviewSheets`. */
const REVIEW_BAND_PT = 33.95;

/**
 * The bar style for a `group` or `total` row, in the three formats a row needs.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FONT, THE FILL AND THE BORDER ARE THE OWNER'S — only the COMBINATION is written here. Every
 * id below is read off `REVIEW_STYLE.header`, the blue column band the template already draws, so a
 * bar wears the same blue as the headings above it and follows any restyle of the template for
 * free. `applyExecutivePalette` substitutes colours by rgb VALUE later, so these move with it too.
 *
 * The combination cannot be borrowed, and that is the whole reason this exists: the header xf
 * carries `numFmtId="0"`, so a value cell pointed at it prints 10595778 with no separators and a
 * ratio prints 0.28. The three formats here are the header's font, fill and border with the money
 * and percentage formats read off `REVIEW_STYLE.money` and `REVIEW_STYLE.percent` — the same two
 * the detail rows use, so a bar and the rows under it read as one column of numbers.
 *
 * Null when the template's own styles cannot be found, in which case the bars fall back to the
 * ordinary detail styling: a flatter sheet, never a broken one.
 */
type ReviewBarStyles = { money: string; percent: string; text: string };

async function addReviewBarStyles(zip: JSZip): Promise<ReviewBarStyles | null> {
  const file = zip.file("xl/styles.xml");
  if (!file) return null;
  let xml = await file.async("string");

  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1];
  if (!block) return null;
  const all = [...block.matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*?>[\s\S]*?<\/xf>/g)].map((one) => one[0]);
  const header = all[Number(REVIEW_STYLE.header)];
  const money = all[Number(REVIEW_STYLE.money)];
  const percent = all[Number(REVIEW_STYLE.percent)];
  if (!header || !money || !percent) return null;

  const attr = (xf: string, name: string): string => new RegExp(`\\b${name}="([^"]*)"`).exec(xf)?.[1] ?? "0";
  const fontId = attr(header, "fontId");
  const fillId = attr(header, "fillId");
  const borderId = attr(header, "borderId");

  const bar = (numFmtId: string, horizontal: string) =>
    `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"`
    + ` applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">`
    + `<alignment horizontal="${horizontal}" vertical="center"/></xf>`;

  const written: string[] = [];
  for (const [numFmtId, horizontal] of [
    ["0", "left"],
    [attr(money, "numFmtId"), "right"],
    [attr(percent, "numFmtId"), "right"],
  ] as const) {
    const added = appendCellXf(xml, bar(numFmtId, horizontal));
    if (added.index <= 0) return null;
    xml = added.xml;
    written.push(String(added.index));
  }

  zip.file("xl/styles.xml", xml);
  return { money: written[1]!, percent: written[2]!, text: written[0]! };
}

/**
 * The rows a zebra stripe may cover, as contiguous `A5:K9`-style ranges.
 *
 * A bar carries its own solid fill, and a conditional format BEATS a cell's own fill — so a stripe
 * whose range runs over the bars paints every second one pale blue and the sheet's blocks stop
 * reading as blocks. Excel takes a space-separated list of ranges in one `sqref`, so the stripe is
 * pointed at the detail rows only rather than at everything between the first and the last.
 *
 * Returns an empty list when nothing is striped, and the caller then writes no rule at all: an
 * empty `sqref` is a schema violation, and Excel answers one by offering to repair the file.
 */
function stripeRanges(kinds: ReviewSheetRowKind[], firstRow: number, lastColumn: string): string[] {
  const ranges: string[] = [];
  let start: number | null = null;
  kinds.forEach((kind, index) => {
    const row = firstRow + index;
    if (kind === "detail") {
      if (start === null) start = row;
      return;
    }
    if (start !== null) ranges.push(`A${start}:${lastColumn}${row - 1}`);
    start = null;
  });
  if (start !== null) ranges.push(`A${start}:${lastColumn}${firstRow + kinds.length - 1}`);
  return ranges;
}

/**
 * Put a `<sheet>` element immediately after the named one, and move every defined name with it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * `localSheetId` IS A POSITION IN THIS LIST, NOT A NAME. Inserting a tab at position N therefore
 * re-attaches every print area, print title and filter range from N onwards to the sheet BEFORE it:
 * Family Performance's print area becomes the new tab's, Family by Month's becomes Family
 * Performance's, and so on to the end of the strip. Nothing about it is visible in any sheet — it
 * surfaces as the wrong rows printing, which reaches paper before anybody notices. `addIndexSheet`
 * carries the same shift for the contents page and the long note there is the account of it.
 *
 * Ids strictly BELOW the insertion point are left alone, which is the whole difference from the
 * contents page: that one goes to the front, so every id moves. Here only the tail does.
 *
 * An unknown name appends instead, unshifted. A template whose sheet was renamed then ships a tab
 * at the end of the strip rather than failing the whole export over a position.
 */
function insertSheetAfter(workbook: string, afterName: string, entry: string): string {
  const sheetTags = [...workbook.matchAll(/<sheet\b[^>]*\/>/g)];
  const index = sheetTags.findIndex(
    (tag) => unescapeSheetName(/\bname="([^"]*)"/.exec(tag[0])?.[1] ?? "") === afterName,
  );
  if (index < 0) return workbook.replace("</sheets>", () => `${entry}</sheets>`);

  const insertAt = index + 1;
  const shifted = workbook.replace(
    /<definedName\b([^>]*?)\blocalSheetId="(\d+)"/g,
    (_match, before: string, id: string) => {
      const current = Number(id);
      return `<definedName${before}localSheetId="${current >= insertAt ? current + 1 : current}"`;
    },
  );

  // Anchored on the matched TAG rather than on its offset: the shift above rewrites the string, so
  // every offset measured before it is stale by however many digits changed. The tag text itself is
  // untouched by that rewrite and is unique — it carries its own `r:id`.
  const anchor = sheetTags[index]![0];
  return shifted.replace(anchor, () => `${anchor}${entry}`);
}

async function addReviewSheets(zip: JSZip, sheets: ReviewSheet[]): Promise<ReviewSheet[]> {
  if (sheets.length === 0) return [];

  const workbookFile = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  const typesFile = zip.file("[Content_Types].xml");
  if (!workbookFile || !relsFile || !typesFile) return [];

  let workbook = await workbookFile.async("string");
  let rels = await relsFile.async("string");
  let types = await typesFile.async("string");

  // Next free part number, read from the package rather than assumed — the template numbers its
  // worksheets by file name and the contents page has already taken one.
  let nextPart = Number(/sheet(\d+)\.xml$/.exec(nextWorksheetPart(zip))?.[1] ?? 1);
  const zebra = await zebraDxf(zip);
  // Once for the whole run, not once per sheet: each call appends to `styles.xml`, so asking per
  // sheet would write three identical formats and leave two of them referenced by nothing.
  const bar = sheets.some((sheet) => (sheet.rowKinds ?? []).some((kind) => kind !== "detail"))
    ? await addReviewBarStyles(zip)
    : null;
  let nextRel = Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  let nextSheetId = Math.max(0, ...[...workbook.matchAll(/sheetId="(\d+)"/g)].map((m) => Number(m[1]))) + 1;

  const existing = new Set(
    [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => unescapeSheetName(m[1])),
  );
  const written: ReviewSheet[] = [];

  for (const sheet of sheets) {
    // A name the engine already uses would put two identically named tabs in one file, and Excel
    // would not open it. The review's Rep Ranking and Family Performance are exactly this case.
    if (existing.has(sheet.name)) continue;

    const part = `xl/worksheets/sheet${nextPart}.xml`;
    const relId = `rId${nextRel}`;
    const columns = sheet.headers.length;

    const inline = (ref: string, style: string, value: string) =>
      `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(xmlSafe(value))}</t></is></c>`;

    const rows: string[] = [];
    rows.push(`<row r="1" ht="33.95" customHeight="1">${inline("A1", REVIEW_STYLE.title, sheet.title)}</row>`);
    rows.push(`<row r="2" ht="18" customHeight="1">${inline("A2", REVIEW_STYLE.subtitle, sheet.subtitle)}</row>`);
    rows.push(
      `<row r="3" ht="18" customHeight="1">`
        + `<c r="A3" s="${REVIEW_STYLE.link}"><f>${xmlEscape(`HYPERLINK("#'${INDEX_SHEET}'!A1","◂ Contents")`)}</f></c>`
        + "</row>",
    );

    rows.push(
      `<row r="4" ht="21.95" customHeight="1">`
        + sheet.headers.map((heading, index) => inline(`${columnLetters(index + 1)}4`, REVIEW_STYLE.header, heading)).join("")
        + "</row>",
    );

    // What each row IS. A sheet that says nothing is all detail, which is the review's own three.
    const kinds: ReviewSheetRowKind[] = sheet.rows.map((_row, index) => sheet.rowKinds?.[index] ?? "detail");
    const hasBars = bar !== null && kinds.some((kind) => kind !== "detail");
    // Only where there is something to fold. `outlineLevel` on every row of a sheet with no bars
    // gives the reader a fold control that collapses the whole table into nothing.
    const folds = hasBars && sheet.grouped === true;

    sheet.rows.forEach((record, index) => {
      const rowNumber = 5 + index;
      const kind = kinds[index]!;
      const isBar = hasBars && kind !== "detail";
      const cells = sheet.headers.map((heading, column) => {
        const ref = `${columnLetters(column + 1)}${rowNumber}`;
        const value = record[column] ?? null;
        const plain = isBar ? bar!.text : REVIEW_STYLE.text;
        if (value === null || value === "") return `<c r="${ref}" s="${plain}"/>`;
        if (typeof value === "number") {
          if (!Number.isFinite(value)) return `<c r="${ref}" s="${plain}"/>`;
          // A bar's numbers keep the DETAIL row's format and take only the bar's font, fill and
          // border. Pointing them at the bar's text style instead prints 10595778 unseparated and a
          // ratio as 0.28, directly under a column of figures that are formatted properly.
          const named = sheet.columnFormats?.[column] ?? null;
          const numeric = named === null ? reviewColumnStyle(heading) : REVIEW_STYLE[named === "plain" ? "text" : named];
          const barNumeric = numeric === REVIEW_STYLE.percent ? bar?.percent : bar?.money;
          return `<c r="${ref}" s="${isBar ? barNumeric ?? numeric : numeric}"><v>${value}</v></c>`;
        }
        return inline(ref, plain, String(value));
      });
      // The margin's fold controls belong to the DETAIL rows; the bar above them stays at level 0,
      // which is what makes it the summary rather than part of what it summarises.
      const outline = folds && kind === "detail" ? ' outlineLevel="1"' : "";
      rows.push(`<row r="${rowNumber}"${outline}>${cells.join("")}</row>`);
    });

    const lastRow = 4 + sheet.rows.length;
    const cols = sheet.headers
      .map((_heading, index) => `<col min="${index + 1}" max="${index + 1}" width="${sheet.widths[index] ?? 16}" customWidth="1"/>`)
      .join("");

    // 🔴 THE ZEBRA, AND THE FREEZE UNDER THE HEADER — the two things every other sheet in this
    // workbook has and these three did not. Owner, 2026-09-10: "zebra tabled borders premium polish
    // ... every single tab".
    //
    // The stripe is the workbook's OWN, found by its fill rather than by an index: `zebraDxf` looks
    // for the palest solid the template already carries. A dxf id is a position, and positions move
    // whenever the engine is rebuilt from a fresh source workbook — a wrong one is not an error,
    // it is a differently coloured row nobody notices.
    //
    // The pane used to split after row 2, which froze the title and the subtitle and let the COLUMN
    // HEADINGS scroll away. On a fifty-row rollup that means reading a column of numbers with no
    // idea which month it is. Row 4 is the heading row on all three, so the split goes below it —
    // which is where every sibling in the template puts it.
    //
    // ⚠ A BAR IS NEVER STRIPED. A conditional format wins over a cell's own fill, so a range that
    // ran from the first row to the last would paint every second bar pale blue and the blocks stop
    // reading as blocks. `stripeRanges` hands back the detail runs only, space-separated, which is
    // one `sqref` as far as Excel is concerned.
    const striped = hasBars
      ? stripeRanges(kinds, 5, columnLetters(columns))
      : [`A5:${columnLetters(columns)}${Math.max(lastRow, 5)}`];
    const stripe = zebra === null || striped.length === 0
      ? ""
      : `<conditionalFormatting sqref="${striped.join(" ")}">`
        + `<cfRule type="expression" dxfId="${zebra}" priority="1"><formula>MOD(ROW()-5,2)=1</formula></cfRule>`
        + "</conditionalFormatting>";

    // THE ORDER INSIDE `sheetPr` IS FIXED BY THE SCHEMA — tabColor, then outlinePr, then
    // pageSetUpPr — and `applyTabColours` inserts its `tabColor` immediately after the open tag
    // later on, which lands it in front of both of these. Emitting `outlinePr` after `pageSetUpPr`
    // here is a schema violation, and Excel answers one by offering to repair the file.
    //
    // `summaryBelow="0"` is the load-bearing attribute: Excel's default puts a block's summary row
    // BELOW its detail, and the bars here sit above. Left at the default, every minus sign in the
    // margin points at the block after the one it collapses.
    const outlinePr = folds ? `<outlinePr summaryBelow="0" summaryRight="0"/>` : "";
    const outlineLevel = folds ? ` outlineLevelRow="1"` : "";

    zip.file(
      part,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr>${outlinePr}<pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${columnLetters(columns)}${lastRow}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"${outlineLevel}/><cols>${cols}</cols><sheetData>${rows.join("")}</sheetData>${stripe}<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`,
    );

    types = types.replace(
      "</Types>",
      `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    );
    rels = rels.replace(
      "</Relationships>",
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${nextPart}.xml"/></Relationships>`,
    );
    const entry = `<sheet name="${xmlEscape(sheet.name)}" sheetId="${nextSheetId}" r:id="${relId}"/>`;
    workbook = sheet.after
      ? insertSheetAfter(workbook, sheet.after, entry)
      : workbook.replace("</sheets>", () => `${entry}</sheets>`);

    existing.add(sheet.name);
    written.push(sheet);
    nextPart += 1;
    nextRel += 1;
    nextSheetId += 1;
  }

  if (written.length === 0) return [];
  zip.file("xl/workbook.xml", workbook);
  zip.file("xl/_rels/workbook.xml.rels", rels);
  zip.file("[Content_Types].xml", types);
  return written;
}

/**
 * Add a cell format to `styles.xml` and return its index.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * BORROWING AN INDEX WAS NOT ENOUGH, and the contents page is where that showed. `s81` was picked
 * for its font — bold 12pt in the brand blue — and it carries two other things: `horizontal="right"`
 * and a MEDIUM blue bottom border. So every page name on the contents page sat hard against the
 * description beside it with a stray rule under it, which reads as a broken table rather than a list
 * of links. A style is a font AND an alignment AND a border, and taking one for a third of it takes
 * the other two as well.
 *
 * So the fonts, fills and borders the owner drew are still reused by id — nothing new is invented —
 * but the COMBINATION is written here, which is the part a catalogue lookup cannot supply.
 *
 * `count` is rewritten from the number of `<xf>` elements actually present. Excel repairs a workbook
 * whose declared count disagrees with its contents, which is the same failure the contents page's
 * `mergeCells` already had once.
 */
function appendCellXf(stylesXml: string, xf: string): { index: number; xml: string } {
  const open = stylesXml.indexOf("<cellXfs");
  const close = stylesXml.indexOf("</cellXfs>");
  if (open < 0 || close < 0) return { index: 0, xml: stylesXml };

  const body = stylesXml.slice(stylesXml.indexOf(">", open) + 1, close);
  const index = (body.match(/<xf\b/g) ?? []).length;
  const rebuilt =
    stylesXml.slice(0, open)
    + `<cellXfs count="${index + 1}">${body}${xf}`
    + stylesXml.slice(close);
  return { index, xml: rebuilt };
}

/**
 * Put the workbook's OWN emblem on the contents page, top right, as every sibling carries it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE PICTURE IS NOT SHIPPED, IT IS REUSED. `xl/media/image1.png` is already in the package — the
 * logo every other sheet anchors in its masthead row — so this adds a drawing that points at that
 * same part rather than embedding a second copy of the mark. One image in the zip, one mark in the
 * workbook, and nothing to keep in step when the owner replaces it.
 *
 * The `<xdr:pic>` is cloned from whichever sheet already carries one, so the fill, the aspect lock
 * and the print behaviour come from his own drawing rather than from a block written here. Only
 * three things are replaced: the shape id and name, which must be unique inside their own drawing,
 * and the relationship id, which is local to the new part.
 *
 * WHERE IT SITS. Right-aligned against the end of the last column, on row 1, with the same 50800
 * EMU drop the siblings use — the top-right corner of the sheet, which is where every one of them
 * puts it. The x is computed from THIS page's own column widths rather than copied, because the
 * contents page is two wide columns and the sheets it was cloned from are ten narrow ones; copying
 * the anchor would land the mark somewhere out past the edge of the page.
 *
 * A worksheet's `<drawing>` is the LAST child in `CT_Worksheet`'s sequence, after `pageSetup` — put
 * anywhere else it is a schema violation, and Excel answers a schema violation by repairing the
 * workbook and dropping what it could not read.
 *
 * Every step is optional by construction: no media, no source picture, no room for it, and the page
 * is returned exactly as it came in. A contents page with no logo is a small loss; a contents page
 * Excel refuses to open is not.
 */
async function addSheetEmblem(
  zip: JSZip,
  indexPart: string,
  sheetXml: string,
  masthead: { align?: "centre" | "right"; columnIndex: number; rowHeightsPt: number[]; scale?: number },
): Promise<string> {
  const drawingNames = Object.keys(zip.files)
    .filter((name) => /^xl\/drawings\/drawing\d+\.xml$/.test(name))
    .sort();

  // Only the <xdr:pic> STRUCTURE is borrowed from a sheet that already carries one — its fill, its
  // aspect lock, its print behaviour. The image it points at is replaced below.
  let picture: string | null = null;
  for (const name of drawingNames) {
    const xml = await zip.file(name)!.async("string");
    const block = (xml.match(ANY_ANCHOR) ?? []).find((one) => one.includes("<xdr:pic"));
    const pic = block ? /<xdr:pic\b[\s\S]*?<\/xdr:pic>/.exec(block)?.[0] : null;
    if (!pic) continue;
    const embed = /r:embed="(rId\d+)"/.exec(pic)?.[1];
    const relsXml = await zip.file(`xl/drawings/_rels/${name.split("/").pop()}.rels`)?.async("string");
    const target = embed && relsXml
      ? new RegExp(`Id="${embed}"[^>]*Target="([^"]+)"`).exec(relsXml)?.[1]
      : null;
    if (!target) continue;
    const resolved = `xl/${target.replace(/^\.\.\//, "")}`;
    if (!zip.file(resolved)) continue;
    picture = pic;
    break;
  }
  if (!picture) return sheetXml;

  // THE ON-DARK MARK, not the one already in the zip.
  //
  // The template's own emblem is the on-LIGHT lockup: its "SATO" is set in BLACK, which is right on
  // the white mastheads its siblings use and disappears completely on this page's banner, leaving
  // the word "PHARMA" alone. The two files are identical but for that one fill, so the banner gets
  // its own copy of the white-SATO lockup and the mark needs no white tile behind it.
  const emblemPart = "xl/media/phx-emblem-on-dark.png";
  if (!zip.file(emblemPart)) {
    zip.file(emblemPart, Buffer.from(CLOSING_ENGINE_EMBLEM_ON_DARK_PNG_BASE64, "base64"));
  }
  const image = "../media/phx-emblem-on-dark.png";

  const size = /<a:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(picture);
  if (!size) return sheetXml;

  // BIGGER THAN THE SIBLINGS'. Their emblem sits in the corner of a working sheet and only has to
  // be present; this one is the mark ON the cover and has to carry it. Scaled from the template's
  // own dimensions rather than typed in, so the aspect ratio is the owner's and cannot drift.
  const scale = masthead.scale ?? INDEX_MARK_SCALE;
  const width = Math.round(Number(size[1]) * scale);
  const height = Math.round(Number(size[2]) * scale);

  // BESIDE THE TITLE — the mark FIRST, then the words, the way a letterhead reads.
  //
  // It is deliberately NOT placed after the caption. That was tried: this page's title is the whole
  // "Monthly Closing   August 2026   Anti Infective   ·   built 7 September 2026", which at the
  // masthead's size measures wider than this sheet's own two columns, so the mark had nowhere left
  // to sit and was dropped entirely — the page came out with no logo at all. Putting it first makes
  // the placement independent of how long a given month's title happens to be.
  //
  // It is CENTRED ON THE WHITE PANEL at the left of the banner — the only ground this mark is
  // legible on, and a panel that exists for the mark alone, so an off-centre placement in it would
  // read as a mistake in a way an off-centre mark in a wide masthead does not.
  //
  // OR RIGHT-ALIGNED AGAINST THE END OF THE BAND, which is what every sheet out of the owner's own
  // engine does and what the three review sheets asked for. The corner is computed from the sheet's
  // own columns rather than copied from a sibling: these sheets are five and six columns wide where
  // the ones the anchor would be copied from are ten and eighteen.
  const widthOf = columnWidthReader(sheetXml);
  let at: { col: number; colOff: number };
  if (masthead.align === "right") {
    let bandWidth = 0;
    for (let index = 0; index <= masthead.columnIndex; index += 1) bandWidth += widthOf(index);
    const x = bandWidth - width - EMBLEM_EDGE_GAP;
    if (x <= 0) return sheetXml;
    at = locateColumn(widthOf, x);
  } else {
    const panelWidth = widthOf(masthead.columnIndex);
    if (width >= panelWidth) return sheetXml;
    at = { col: masthead.columnIndex, colOff: Math.round((panelWidth - width) / 2) };
  }
  // The far corner as a (column, offset) pair rather than one column with an offset that runs past
  // its own width. Same absolute position either way; this form is the one the schema describes,
  // and it is the one that survives a right-aligned mark whose end falls in the next column.
  let absoluteLeft = 0;
  for (let index = 0; index < at.col; index += 1) absoluteLeft += widthOf(index);
  const far = locateColumn(widthOf, absoluteLeft + at.colOff + width);

  // The vertical centre of the WHOLE band, resolved back to the row it lands in. A rowOff is an
  // offset INTO its own row, so one offset measured from the top of the band would overflow the
  // first row and Excel would place the mark somewhere of its own choosing.
  //
  /** An absolute y, as the (row, rowOff) pair an anchor wants. */
  const locateRow = (y: number) => {
    let left = Math.max(0, y);
    let row = 0;
    for (const pt of masthead.rowHeightsPt) {
      const rowEmu = pt * 12_700;
      if (left < rowEmu) break;
      left -= rowEmu;
      row += 1;
    }
    return { row, rowOff: Math.round(left) };
  };

  const bandEmu = masthead.rowHeightsPt.reduce((total, pt) => total + pt * 12_700, 0);
  const top = Math.max(0, Math.round((bandEmu - height) / 2));
  const from = locateRow(top);
  const to = locateRow(top + height);
  const anchorRow = from.row;
  const drop = from.rowOff;

  const part = `xl/drawings/drawing${
    Math.max(0, ...drawingNames.map((name) => Number(/drawing(\d+)\.xml$/.exec(name)?.[1] ?? 0))) + 1
  }.xml`;

  // ANCHORED TO THE CELLS, not floating over them.
  //
  // A `twoCellAnchor` is defined by two CORNERS rather than by a corner and a size, so the mark
  // belongs to the block of cells it sits in: it moves when rows or columns move, resizes when they
  // resize, and cannot be dragged loose from the banner. `editAs="twoCell"` is what makes it size
  // with them — `oneCell` would move it and keep its size, `absolute` would pin it to the page and
  // let the banner slide out from under it.
  //
  // A oneCellAnchor carries an <xdr:ext>; a twoCellAnchor must NOT — its size comes from the
  // corners, and leaving a stale ext there is a schema violation Excel answers by repairing the
  // file. The picture's own <a:ext> inside spPr is restated instead, so the shape and the anchor
  // agree on how big it is.
  const sized = picture
    .replace(/<xdr:cNvPr\b[^>]*?(\/>|>[\s\S]*?<\/xdr:cNvPr>)/, '<xdr:cNvPr id="2" name="Emblem"/>')
    .replace(/r:embed="rId\d+"/, 'r:embed="rId1"')
    .replace(/<a:off\b[^>]*\/>/, '<a:off x="0" y="0"/>')
    .replace(/<a:ext\b[^>]*\/>/, `<a:ext cx="${width}" cy="${height}"/>`);

  const anchor =
    '<xdr:twoCellAnchor editAs="twoCell">'
    + `<xdr:from><xdr:col>${at.col}</xdr:col><xdr:colOff>${at.colOff}</xdr:colOff>`
    + `<xdr:row>${anchorRow}</xdr:row><xdr:rowOff>${drop}</xdr:rowOff></xdr:from>`
    + `<xdr:to><xdr:col>${far.col}</xdr:col><xdr:colOff>${far.colOff}</xdr:colOff>`
    + `<xdr:row>${to.row}</xdr:row><xdr:rowOff>${to.rowOff}</xdr:rowOff></xdr:to>`
    + sized
    // Not printed, matching the emblem on every other sheet.
    + '<xdr:clientData fPrintsWithSheet="0"/>'
    + "</xdr:twoCellAnchor>";

  zip.file(
    part,
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"'
      + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `${anchor}</xdr:wsDr>`,
  );
  zip.file(
    `xl/drawings/_rels/${part.split("/").pop()}.rels`,
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${image}"/>`
      + "</Relationships>",
  );
  zip.file(
    `xl/worksheets/_rels/${indexPart.split("/").pop()}.rels`,
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${part.split("/").pop()}"/>`
      + "</Relationships>",
  );

  const typesXml = await zip.file("[Content_Types].xml")!.async("string");
  if (!typesXml.includes(`PartName="/${part}"`)) {
    zip.file(
      "[Content_Types].xml",
      typesXml.replace(
        "</Types>",
        `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`,
      ),
    );
  }

  return sheetXml.replace("</worksheet>", '<drawing r:id="rId1"/></worksheet>');
}

/**
 * The contents page's formats, CLONED from the sheets it sits in front of.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE NAMES A STYLE INDEX, and that is the whole point. `addRepCardStyles` already spells
 * out why, and this page is the proof: it used to carry `INDEX_STYLE = { title: "77", subtitle:
 * "79", link: "81", ... }` while the template ships 77 cellXfs — valid indices 0..76. Those three
 * resolved to anything at all only because the style writer had appended six entries first, so
 * "title" was in fact the appended link format. It rendered by luck. An id is whatever position the
 * owner's source workbook happened to put it in, and it moves whenever the engine is rebuilt from a
 * fresh one; a wrong id is not an error, it is a differently coloured cell nobody notices.
 *
 * So the look is READ OFF THE OVERVIEW SHEET — the one page that is always present — and the page
 * is painted with the very formats its siblings use:
 *
 *   title      the Overview's own A1 masthead, and B1's blank that carries the rule across
 *   header     the first bold-white-on-solid style the Overview uses: its blue column band
 *   body       the first plain unfilled style below that band: its data row
 *
 * Everything else is one of those with a single attribute swapped, exactly as addRepCardStyles
 * does it. The zebra takes the palest solid fill the workbook already owns rather than inventing a
 * colour; the link and the band take the brand-blue and the muted greys the template already
 * defines, found by their COLOUR rather than by their position.
 */
type IndexPalette = Record<
  "band" | "bannerBlank" | "bannerFoot" | "bannerSub" | "bannerTitle" | "body" | "foot" | "header"
  | "link" | "title" | "titlePt" | "titleTail",
  string
>;

/** Top-level `<child>` elements of `<tag>`, by scan: one regex cannot match `<xf/>` and `<xf>…</xf>`. */
function styleList(xml: string, tag: string, child: string): string[] {
  const open = xml.indexOf(`<${tag}`);
  if (open < 0) return [];
  const body = xml.slice(xml.indexOf(">", open) + 1, xml.indexOf(`</${tag}>`));
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
}

async function resolveIndexStyles(zip: JSZip): Promise<IndexPalette | null> {
  const stylesFile = zip.file("xl/styles.xml");
  const overviewPart = MANIFEST.sheets.Overview?.file;
  const overviewFile = overviewPart ? zip.file(overviewPart) : null;
  if (!stylesFile || !overviewFile) return null;

  let xml = await stylesFile.async("string");
  const overview = await overviewFile.async("string");

  const xfs = styleList(xml, "cellXfs", "xf");
  const fills = styleList(xml, "fills", "fill");
  const fonts = styleList(xml, "fonts", "font");
  const borders = styleList(xml, "borders", "border");
  if (xfs.length === 0) return null;

  // `\\b` and `\\d`, not `\b` and `\d`: inside a template literal a lone `\b` is a BACKSPACE
  // character and `\d` is just the letter d, so the pattern silently becomes one that can never
  // match. It fails as a clean "not found" rather than as an error — every style resolved to 0 and
  // the page came out unstyled with nothing to see anywhere.
  const idIn = (xf: string | undefined, name: string) =>
    Number(new RegExp(`\\b${name}="(\\d+)"`).exec(xf ?? "")?.[1] ?? 0);
  const fontOf = (xf: string | undefined) => fonts[idIn(xf, "fontId")] ?? "";
  const fillOf = (xf: string | undefined) => fills[idIn(xf, "fillId")] ?? "";
  const styleAt = (ref: string) =>
    new RegExp(`<c r="${ref}"[^>]*?\\bs="(\\d+)"`).exec(overview)?.[1];

  // Document order, so "the first one below the band" means what it says.
  const usedOnOverview = [...overview.matchAll(/<c r="[A-Z]+\d+"[^>]*?\bs="(\d+)"/g)].map((m) => Number(m[1]));

  const isBanner = (index: number) => {
    const xf = xfs[index];
    if (!xf) return false;
    return /patternType="solid"/.test(fillOf(xf)) && fontOf(xf).includes("<b/>") && /FFFFFF/i.test(fontOf(xf));
  };
  const isPlainRow = (index: number) => {
    const xf = xfs[index];
    if (!xf) return false;
    return !/patternType="solid"/.test(fillOf(xf)) && !fontOf(xf).includes("<b/>");
  };

  const bannerAt = usedOnOverview.findIndex(isBanner);
  const header = bannerAt >= 0 ? usedOnOverview[bannerAt] : undefined;
  const body = usedOnOverview.slice(bannerAt >= 0 ? bannerAt + 1 : 0).find(isPlainRow);
  const title = Number(styleAt("A1") ?? NaN);
  const titleTail = Number(styleAt("B1") ?? NaN);
  if (header === undefined || body === undefined || !Number.isFinite(title)) return null;

  // The palest solid fill the workbook already owns, white excepted — the section bands stand on
  // it, without inventing a colour that would disagree with every panel on every other sheet.
  let tintFill = -1;
  let palest = -1;
  fills.forEach((fill, index) => {
    const rgb = /fgColor rgb="FF([0-9A-Fa-f]{6})"/.exec(fill)?.[1];
    if (!rgb || rgb.toUpperCase() === "FFFFFF") return;
    const value = parseInt(rgb, 16);
    const luma = ((value >> 16) & 255) * 0.299 + ((value >> 8) & 255) * 0.587 + (value & 255) * 0.114;
    if (luma > palest) { palest = luma; tintFill = index; }
  });

  const sizeOf = (font: string) => Number(/sz val="([0-9.]+)"/.exec(font)?.[1] ?? NaN);
  const bodySize = sizeOf(fontOf(xfs[body]));

  /**
   * A font already in the workbook in colour `rgb`, NEAREST THE BODY'S SIZE — never the first match.
   *
   * The size matters as much as the colour. Taking the first bold `#0868A8` font finds the
   * Overview's 18pt headline face, and a page name set at 18pt in a 16.5-high row is the difference
   * between a contents list and a mess. The point of cloning is to land in the same type scale as
   * the rows beside it, not merely in the same hue.
   */
  const fontColoured = (rgb: string, bold: boolean) => {
    const matcher = new RegExp(`color rgb="FF${rgb}"`, "i");
    let best: number | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    fonts.forEach((font, index) => {
      if (!matcher.test(font) || font.includes("<b/>") !== bold) return;
      const gap = Number.isFinite(bodySize) ? Math.abs(sizeOf(font) - bodySize) : 0;
      if (gap < bestGap) { bestGap = gap; best = index; }
    });
    return best;
  };
  const brandFont = fontColoured("0868A8", true) ?? fontColoured("0868A8", false);
  const mutedFont = fontColoured("7A93A3", false);

  /**
   * A border the workbook already draws, found by SHAPE: `edge` is its only edge and it is drawn in
   * `weights`. The engine's own catalogue has a hairline grey under a row and a medium blue under a
   * heading, and those are the two rules every sheet here is ruled with — so the table gets the
   * workbook's rules rather than a line invented for this page.
   */
  const borderWith = (edge: "bottom" | "top", weights: string[], rgb?: string) =>
    borders.findIndex((border) => {
      const edges = [...border.matchAll(/<(left|right|top|bottom|diagonal)[^>]*style="([a-z]+)"/g)];
      if (edges.length !== 1 || edges[0][1] !== edge) return false;
      if (!weights.includes(edges[0][2])) return false;
      return rgb === undefined || new RegExp(`color rgb="FF${rgb}"`, "i").test(border);
    });
  const hairline = borderWith("bottom", ["thin", "hair"], "7A93A3");
  const heavyRule = borderWith("bottom", ["medium", "thick"], "0868A8");
  // A section OPENS with its rule, so the line belongs to the heading above the pages it covers.
  // With the rule underneath, the band floated free and its line read as the first entry's.
  const openingRule = borderWith("top", ["medium", "thick"], "0868A8");

  const swap = (xf: string, patch: { borderId?: number; fillId?: number; fontId?: number; indent?: number }) => {
    let out = xf;
    if (patch.fontId !== undefined) {
      out = out.replace(/\bfontId="\d+"/, `fontId="${patch.fontId}"`);
      if (!/\bapplyFont="1"/.test(out)) out = out.replace(/\bxfId="(\d+)"/, `xfId="$1" applyFont="1"`);
    }
    if (patch.fillId !== undefined) {
      out = out.replace(/\bfillId="\d+"/, `fillId="${patch.fillId}"`);
      if (!/\bapplyFill="1"/.test(out)) out = out.replace(/\bxfId="(\d+)"/, `xfId="$1" applyFill="1"`);
    }
    if (patch.borderId !== undefined) {
      out = out.replace(/\bborderId="\d+"/, `borderId="${patch.borderId}"`);
      // Without applyBorder a cellXf's borderId may be ignored in favour of the style it derives
      // from, so the rule would simply not be drawn and there would be nothing to see anywhere.
      if (!/\bapplyBorder="1"/.test(out)) out = out.replace(/\bxfId="(\d+)"/, `xfId="$1" applyBorder="1"`);
    }
    if (patch.indent !== undefined) {
      if (/<alignment\b/.test(out)) {
        out = /\bindent="\d+"/.test(out)
          ? out.replace(/\bindent="\d+"/, `indent="${patch.indent}"`)
          : out.replace(/<alignment\b/, `<alignment indent="${patch.indent}"`);
      } else {
        // No alignment element at all: give it one, and close the xf properly either way.
        out = /\/>$/.test(out)
          ? out.replace(/\/>$/, `><alignment horizontal="left" vertical="center" indent="${patch.indent}"/></xf>`)
          : out.replace(/>(?=(?:(?!<alignment)[\s\S])*<\/xf>)/, `><alignment horizontal="left" vertical="center" indent="${patch.indent}"/>`);
      }
      if (!/\bapplyAlignment="1"/.test(out)) out = out.replace(/\bxfId="(\d+)"/, `xfId="$1" applyAlignment="1"`);
    }
    return out;
  };

  const add = (definition: string): string => {
    const result = appendCellXf(xml, definition);
    xml = result.xml;
    return String(result.index);
  };

  // ── THE COVER BANNER ────────────────────────────────────────────────────────────────────────
  //
  // A deep band across the masthead with the month reversed out of it, and the mark on a WHITE
  // PANEL at its left.
  //
  // THE WHITE PANEL IS NOT DECORATION — it is the only way the logo survives. The mark in this
  // workbook is the on-light file: "SATO" is set in BLACK, so on a dark band that half of the
  // wordmark disappears and the banner reads "PHARMA". The stock on-dark file has the opposite
  // problem here: its "SATO" is white and would show, but its "PHARMA" is the brand blue `#0868A8`
  // sitting on a `#085080` band — about 1.5:1, which is not a contrast at all. Neither file works
  // directly on the band, so the band gives it a white ground to stand on, which is also what the
  // house standard asks for: the on-light mark, on white.
  const darkFill = fills.reduce(
    (best, fill, index) => {
      const rgb = /fgColor rgb="FF([0-9A-Fa-f]{6})"/.exec(fill)?.[1];
      if (!rgb) return best;
      const value = parseInt(rgb, 16);
      const luma = ((value >> 16) & 255) * 0.299 + ((value >> 8) & 255) * 0.587 + (value & 255) * 0.114;
      return best.luma <= luma ? best : { index, luma };
    },
    { index: -1, luma: Number.POSITIVE_INFINITY },
  ).index;

  /** The largest white face the workbook owns, bold or not — the type that reverses out of the band. */
  // A DEEPER SHADE OF THE OWNER'S OWN BLUE, appended once, for the band to stand on.
  //
  // Not a new colour so much as a darker step of the darkest one the workbook already has. It is
  // needed because the mark's "PHARMA" is set in `#0A6BA6`; on the template's darkest fill,
  // `#085080`, that is roughly 1.5:1 and the word sinks into the band — measured on a real render,
  // where "SATO" read white and "PHARMA" had all but vanished. Taking the same hue down to ~55%
  // luminance puts it near 3:1, which is what a mark this size needs.
  const bannerFill = (() => {
    const rgb = darkFill >= 0 ? /fgColor rgb="FF([0-9A-Fa-f]{6})"/.exec(fills[darkFill] ?? "")?.[1] : null;
    if (!rgb) return darkFill;
    const value = parseInt(rgb, 16);
    const deepen = (channel: number) => Math.max(0, Math.round(channel * 0.55));
    const deeper = [
      deepen((value >> 16) & 255),
      deepen((value >> 8) & 255),
      deepen(value & 255),
    ].map((channel) => channel.toString(16).padStart(2, "0").toUpperCase()).join("");
    const existing = fills.findIndex((fill) => new RegExp(`fgColor rgb="FF${deeper}"`, "i").test(fill));
    if (existing >= 0) return existing;
    const open = xml.indexOf("<fills");
    const close = xml.indexOf("</fills>");
    if (open < 0 || close < 0) return darkFill;
    const count = fills.length;
    xml = xml.slice(0, open)
      + xml.slice(open, close).replace(/count="\d+"/, `count="${count + 1}"`)
      + `<fill><patternFill patternType="solid"><fgColor rgb="FF${deeper}"/><bgColor indexed="64"/></patternFill></fill>`
      + xml.slice(close);
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${deeper}"/></patternFill></fill>`);
    return count;
  })();

  const whiteFont = (bold: boolean) => {
    let best: number | null = null;
    let bestSize = -1;
    fonts.forEach((font, index) => {
      if (!/color rgb="FFFFFFFF"/i.test(font) || font.includes("<b/>") !== bold) return;
      const size = sizeOf(font);
      if (!Number.isFinite(size) || size <= bestSize) return;
      bestSize = size;
      best = index;
    });
    return best;
  };
  /** Add a font the workbook does not have, and return its index. */
  const addFont = (definition: string): number => {
    const open = xml.indexOf("<fonts");
    const close = xml.indexOf("</fonts>");
    if (open < 0 || close < 0) return -1;
    const index = fonts.length;
    xml = xml.slice(0, open)
      + xml.slice(open, close).replace(/count="\d+"/, `count="${index + 1}"`)
      + definition
      + xml.slice(close);
    fonts.push(definition);
    return index;
  };

  // A COVER-SIZED TITLE. The largest white bold face the template owns is 17pt, which is a heading
  // on a working sheet and looks tentative reversed out of a 74pt band. 22pt is added once, in the
  // template's own Segoe UI so it sits in the same type family as everything around it.
  const existingWhiteBold = whiteFont(true);
  const bannerTitleFont = (() => {
    const wanted = 22;
    const current = existingWhiteBold === null ? 0 : sizeOf(fonts[existingWhiteBold] ?? "");
    if (Number.isFinite(current) && current >= wanted) return existingWhiteBold;
    const added = addFont(
      `<font><b/><sz val="${wanted}"/><color rgb="FFFFFFFF"/><name val="Segoe UI"/><family val="2"/></font>`,
    );
    return added < 0 ? existingWhiteBold : added;
  })();
  // The line under the headline at 9.5pt read as a caption rather than as the month. 12pt is added
  // once, in the same face, so the two lines of the banner are a pair instead of a title with a
  // footnote stuck to it.
  const bannerSubFont = (() => {
    const wanted = 12;
    const existing = whiteFont(false);
    const current = existing === null ? 0 : sizeOf(fonts[existing] ?? "");
    if (Number.isFinite(current) && current >= wanted) return existing;
    const added = addFont(
      `<font><sz val="${wanted}"/><color rgb="FFFFFFFF"/><name val="Segoe UI"/><family val="2"/></font>`,
    );
    return added < 0 ? (existing ?? bannerTitleFont) : added;
  })();

  // THE TITLE, ONE SIZE UP. The masthead the siblings use is 13pt, which is right on a sheet whose
  // job is a dense table; the contents page is the cover and reads as timid at that size. It takes
  // the LARGEST bold face the workbook ALREADY OWNS in the title's own colour, so the page grows
  // into type the owner already set rather than into a size invented here — and if his template
  // has nothing bigger, it simply stays as it was.
  const titleXf = xfs[title]!;
  const titleColour = /color rgb="FF([0-9A-Fa-f]{6})"/.exec(fontOf(titleXf))?.[1];
  const baseTitlePt = sizeOf(fontOf(titleXf));
  let bigTitleFont = -1;
  let titlePt = Number.isFinite(baseTitlePt) ? baseTitlePt : 13;
  fonts.forEach((font, index) => {
    if (!font.includes("<b/>")) return;
    if (titleColour && !new RegExp(`color rgb="FF${titleColour}"`, "i").test(font)) return;
    const size = sizeOf(font);
    if (!Number.isFinite(size) || size <= titlePt) return;
    titlePt = size;
    bigTitleFont = index;
  });

  const bodyXf = xfs[body]!;
  // Every row is ruled. A zebra alone separates rows by shade; the hairline is what makes the two
  // columns read as ONE row across 96 characters of description, which is the whole job of this
  // page. Where the workbook has no such border, the variants collapse back to the plain style
  // rather than inventing one.
  const ruled = (patch: { fillId?: number; fontId?: number }) =>
    add(swap(bodyXf, { ...patch, ...(hairline >= 0 ? { borderId: hairline } : {}) }));

  /** A banner cell: on the dark band, no rule, optionally carrying reversed-out type. */
  const banner = (fontId: number | null) =>
    add(swap(bodyXf, { borderId: 0, ...(bannerFill >= 0 ? { fillId: bannerFill } : {}), ...(fontId === null ? {} : { fontId }) }));

  const palette: IndexPalette = {
    bannerTitle: banner(bannerTitleFont),
    bannerSub: banner(bannerSubFont),
    bannerBlank: banner(null),
    // The band closes on the brand rule, so its bottom edge is a deliberate line rather than the
    // place a colour happens to stop. It is the same rule the sheets already draw under a heading.
    bannerFoot: add(
      swap(bodyXf, {
        borderId: heavyRule >= 0 ? heavyRule : 0,
        ...(bannerFill >= 0 ? { fillId: bannerFill } : {}),
      }),
    ),
    title: add(
      swap(titleXf, {
        ...(bigTitleFont < 0 ? {} : { fontId: bigTitleFont }),
      }),
    ),
    titlePt: String(titlePt),
    titleTail: Number.isFinite(titleTail) ? String(titleTail) : String(title),
    header: String(header),
    body: ruled({}),
    link: brandFont === null ? ruled({}) : ruled({ fontId: brandFont }),
    // A section bar: tinted, in the brand blue, opening with the heavier rule ABOVE it. Small blue
    // caps floating over white had no weight at all — the sections were invisible and the page read
    // as one undifferentiated list.
    band: add(
      swap(bodyXf, {
        ...(brandFont === null ? {} : { fontId: brandFont }),
        ...(tintFill >= 0 ? { fillId: tintFill } : {}),
        ...(openingRule >= 0
          ? { borderId: openingRule }
          : heavyRule >= 0
            ? { borderId: heavyRule }
            : {}),
      }),
    ),
    foot: mutedFont === null ? String(body) : add(swap(bodyXf, { fontId: mutedFont })),
  };

  zip.file("xl/styles.xml", xml);
  return palette;
}

/**
 * Number formats for the pivot grids, taken from the engine's own catalogue rather than invented.
 *
 * s43 is `#,##0;-#,##0;"—"`, so a zero prints as an em dash instead of reading as "sold nothing";
 * s44 is `0.0%`; s8 is the blue table header the sheets beside these use; s9 the body row. Using the
 * engine's own indices is what keeps these pages looking like their siblings through any restyle of
 * the owner's template.
 */
const GRID_STYLE: Record<GridCellKind, string | null> = {
  blank: null,
  corner: "8",
  header: "8",
  label: "9",
  money: "43",
  percent: "44",
  text: "9",
};

/**
 * Write each pivot page's grid into its own cells.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE WHOLE POINT: a pivot table stores no cells, so on a reader that cannot refresh one — Excel for
 * iOS/Android, WPS on a phone — those three pages are blank. Desktop Excel is untouched by this:
 * `refreshOnLoad="1"` is still set, so it rebuilds the pivot over these cells on open exactly as it
 * does today, slicers and fold-by-region intact. These cells are what a phone shows instead.
 *
 * NOTHING HERE TOUCHES A PIVOT, A CACHE OR A SLICER, with one exception: `location`'s extent is
 * re-declared to match what is written. That matters and is not cosmetic — the stored extent is the
 * range Excel redraws into, and a grid larger than it would leave our rows stranded on the desktop
 * BELOW a working pivot, which is a worse defect than the one being fixed and one the owner would
 * see first. The extent is computed from the same rows the refresh will read, so the two agree.
 *
 * `firstHeaderRow`, `firstDataRow` and `firstDataCol` are left exactly as the owner's template has
 * them, and `buildPivotGrid` emits the header block those numbers describe — three rows on the two
 * matrices, one on Area x Product. They are the contract between this grid and the pivot drawn over
 * it, so they are read here rather than assumed there.
 */
async function writePivotGrids(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
  // Once for the whole workbook, before the loop: three sheets share it, and appending it three
  // times would put three identical formats into styles.xml.
  const wrapStyle = await ensureWrappedLabelStyle(zip);

  for (const [sheetName, spec] of Object.entries(MANIFEST.sheets)) {
    if (spec.kind !== "pivot") continue;
    const gridSpec = PIVOT_GRID_SPECS[sheetName];
    const sheetFile = zip.file(spec.file);
    if (!gridSpec || !sheetFile) continue;

    const grid = buildPivotGrid(fill.data.salesData, gridSpec);
    if (!grid) continue;

    // Where the pivot sits, read from the pivot's own part rather than hard-coded: the template is
    // the owner's and he re-saves it.
    const relsFile = zip.file(spec.file.replace("worksheets/", "worksheets/_rels/") + ".rels");
    const relsXml = relsFile ? await relsFile.async("string") : "";
    const pivotPart = /Target="\.\.\/(pivotTables\/pivotTable\d+\.xml)"/.exec(relsXml)?.[1];
    const pivotFile = pivotPart ? zip.file(`xl/${pivotPart}`) : null;
    if (!pivotFile) continue;

    const pivotXml = await pivotFile.async("string");
    const location = /<location\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/.exec(pivotXml);
    if (!location) continue;
    const firstColumn = columnNumber(location[1]!);
    const firstRow = Number(location[2]!);

    // ── The cells ─────────────────────────────────────────────────────────────────────────────
    const rows: string[] = [];
    grid.cells.forEach((line, offset) => {
      const rowNumber = firstRow + offset;
      const cells = line
        .map((cell, column) => {
          // A row LABEL wraps; nothing else does. A wrapped number column would grow every row's
          // height for no gain, and the headers are short by construction.
          const style = cell.kind === "label" ? wrapStyle ?? GRID_STYLE[cell.kind] : GRID_STYLE[cell.kind];
          if (style === null || cell.value === null || cell.value === "") return "";
          const ref = `${columnLetters(firstColumn + column)}${rowNumber}`;
          if (typeof cell.value === "number") {
            return Number.isFinite(cell.value) ? `<c r="${ref}" s="${style}"><v>${cell.value}</v></c>` : "";
          }
          return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(xmlSafe(String(cell.value)))}</t></is></c>`;
        })
        .join("");
      if (cells) rows.push(`<row r="${rowNumber}">${cells}</row>`);
    });
    if (rows.length === 0) continue;

    const lastRow = firstRow + grid.cells.length - 1;
    const lastColumn = columnLetters(firstColumn + grid.width - 1);

    let xml = await sheetFile.async("string");

    // Rows must ASCEND inside <sheetData> or Excel repairs the sheet. The header rows the template
    // keeps (the title, the coverage note) all sit above the pivot, so appending is enough — but any
    // row at or below the pivot's own first row is dropped first, so a re-run cannot double them.
    xml = xml.replace(/<sheetData>([\s\S]*?)<\/sheetData>/, (_match, body: string) => {
      const kept = [...String(body).matchAll(/<row\b[^>]*?\/>|<row\b[^>]*?>[\s\S]*?<\/row>/g)]
        .map((one) => one[0])
        .filter((one) => Number(/\br="(\d+)"/.exec(one)?.[1] ?? 0) < firstRow);
      return `<sheetData>${kept.join("")}${rows.join("")}</sheetData>`;
    });

    // The declared extent has to cover what is now on the sheet, or Excel trims the view to it.
    xml = xml.replace(/<dimension ref="([A-Z]+)(\d+):[A-Z]+\d+"/, (_match, col: string, row: string) =>
      `<dimension ref="${col}${row}:${lastColumn}${lastRow}"`);

    zip.file(spec.file, xml);
    zip.file(
      `xl/${pivotPart}`,
      pivotXml.replace(/(<location\b[^>]*\bref=")[A-Z]+\d+:[A-Z]+\d+(")/, `$1${location[1]}${firstRow}:${lastColumn}${lastRow}$2`),
    );
  }
}

/** "AX" -> 50. The inverse of `columnLetters`, needed to start writing at the pivot's own corner. */
function columnNumber(letters: string): number {
  let total = 0;
  for (const character of letters) total = total * 26 + (character.charCodeAt(0) - 64);
  return total;
}
