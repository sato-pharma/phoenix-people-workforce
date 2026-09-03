import JSZip from "jszip";

import {
  CLOSING_ENGINE_TEMPLATE_MANIFEST,
  closingEngineTemplateBytes,
} from "./closing-engine-template-generated";
import { ACHIEVEMENT_ARROW_AT } from "./closing-engine-data";

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
  await updateReferences(zip, fill);
  await fitRegionControls(zip, fill);
  await sizeMatrixColumns(zip, fill);
  await sizePivotAchievementFormats(zip, fill);
  await orderPivotItems(zip, fill);
  await dropStaleLabelFormats(zip);
  await clearTitleEmblem(zip, fill);
  await restorePivotCacheSharedItems(zip, fill);
  await dropDeadSharedStrings(zip);
  if (options.macroFree) await stripMacros(zip);

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
 * conditional format. It writes the absolute cells it was given, into rows that already exist, and
 * leaves the rest of the part exactly as the owner built it.
 */
async function fillHeaderCells(zip: JSZip, spec: SheetSpec, content: EngineSheetFill): Promise<void> {
  const cells = content.cells;
  if (!cells || Object.keys(cells).length === 0) return;
  const file = zip.file(spec.file);
  if (!file) throw new Error(`closing engine template is missing ${spec.file}`);
  const { head, rows, tail } = splitSheet(await file.async("string"));
  const written = rows.map((row) => applyCells(row.xml, row.r, cells));
  zip.file(spec.file, `${head}${written.join("")}${tail}`);
}

/**
 * Follow a moved row with its merge.
 *
 * A footnote is one merged strip across the sheet, and the merge is stored separately from the
 * row. Move the row without the merge and two things break at once: the footnote clips at one
 * column width instead of spanning the sheet, and the abandoned merge lands on whatever row now
 * occupies its old number — in a long month, a real data row, silently welded into one cell.
 */
function moveMerges(sheetXml: string, moved: Map<number, number>): string {
  let out = sheetXml;
  for (const [from, to] of moved) {
    out = out.replace(
      new RegExp(`<mergeCell ref="([A-Z]+)${from}:([A-Z]+)${from}"\\s*/>`, "g"),
      `<mergeCell ref="$1${to}:$2${to}"/>`,
    );
  }
  return out;
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
    const run = runs.find((candidate) => column >= candidate.min && column <= candidate.max);
    return run ? run.emu : fallback;
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
  await widenRegionSlicers(zip, regions);
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
    if (caption) measured.set(caption, edge(block, ANCHOR_TO) - edge(block, ANCHOR_FROM));
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
 * Widen the two matrices' grand-total columns to fit their own headings.
 *
 * Both matrices repeat three columns per product — Sales Value, Target Value, Ach — and the
 * template sizes every one of them at 12.71 characters, which is right. What it also sizes at
 * 12.71 is the block after them: the grand total, whose headings are those same names with the
 * word "Total" in front. "Total Sales Value" does not fit in the width "Sales Value" fits in, so
 * the two most-read columns on the page shipped saying "Total Sales Val" and "Total Target V".
 *
 * The block exists only where the pivot asks for it — the Units Matrix sets `colGrandTotals="0"`
 * and has none — so the width lands on whatever sits past the last product group, and on nothing
 * at all when there is nothing there.
 */
async function sizeMatrixColumns(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
  const products = distinctColumn(fill.data.salesData, 5).length;
  if (!products) return;

  for (const sheetName of SLICER_SHEETS) {
    const spec = MANIFEST.sheets[sheetName];
    const file = spec ? zip.file(spec.file) : null;
    if (!spec || !file) continue;
    const xml = await file.async("string");
    const cols = /<cols>[\s\S]*?<\/cols>/.exec(xml)?.[0];
    // The run the template gives the value columns is the one carrying their style and width, so it
    // is re-cut rather than replaced: same attributes, new bounds.
    const run = cols ? /<col\b[^>]*\bmin="3"[^>]*\/>/.exec(cols)?.[0] : null;
    if (!cols || !run) continue;

    // Two row-field columns, then three value columns per product. Anything past that is the grand
    // total, which the pivot writes only when it is asked for.
    const lastProductColumn = 2 + products * 3;
    const totals = /\bcolGrandTotals="0"/.test((await pivotPartFor(zip, spec))?.xml ?? "") ? 0 : 3;
    const runMax = Number(/\bmax="(\d+)"/.exec(run)?.[1] ?? 0);
    const values = run.replace(/\bmax="\d+"/, `max="${lastProductColumn}"`);
    const grand = totals
      ? run
          .replace(/\bmin="3"/, `min="${lastProductColumn + 1}"`)
          .replace(/\bmax="\d+"/, `max="${lastProductColumn + totals}"`)
          .replace(/\bwidth="[\d.]+"/, `width="17.7109375"`)
      : "";
    // The template's run reaches well past the widest month it was cut for, and a shorter month
    // must not lose the columns beyond its own totals: they are still inside the run being
    // re-cut, so a two-piece rewrite silently drops them back to the default width with no style,
    // leaving a bare band beside the grand total on every sheet narrower than the template. Re-cut
    // in three pieces, the tail keeping exactly what the template gave it.
    const tail = runMax > lastProductColumn + totals
      ? run.replace(/\bmin="3"/, `min="${lastProductColumn + totals + 1}"`)
      : "";
    zip.file(spec.file, xml.replace(cols, cols.replace(run, `${values}${grand}${tail}`)));
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
async function polishRepCard(zip: JSZip, fill: ClosingEngineFill): Promise<void> {
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

  // 2 — the deck line, and the rule, on a row the template left empty apart from `$N$2`.
  written.set(
    2,
    `${open(2, REP_CARD_ROW_HEIGHT.deck)}`
      + `${cellXml("A2", styles.deck, String(fill.sheets[REP_CARD]?.cells?.A2 ?? ""))}`
      + `${blanks(2, "B", "H", ruled)}${cellAt(rowAt(2), "N2")}</row>`,
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
 * So the emblem is placed against the measured title rather than left at a fixed column. It only
 * ever moves right, and only when the title actually reaches it — a sheet with room to spare keeps
 * the layout the owner arranged.
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
    if (left >= needed) continue;

    const to = ANCHOR_TO.exec(emblem)?.[0];
    // A one-cell anchor carries its own size and only the corner moves; a two-cell one is defined
    // by both corners, so it has to travel as a whole or the logo stretches.
    const moved = to
      ? moveAnchor(widthOf, emblem, needed, anchorX(widthOf, to) - left)
      : emblem.replace(from, writeAnchorX(from, locateColumn(widthOf, needed)));
    zip.file(found.name, found.xml.replace(emblem, moved));
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
