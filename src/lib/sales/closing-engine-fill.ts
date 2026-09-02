import JSZip from "jszip";

import {
  CLOSING_ENGINE_TEMPLATE_MANIFEST,
  closingEngineTemplateBytes,
} from "./closing-engine-template-generated";

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
    if (spec.kind !== "data" || sheetName === DATA_SHEET) continue;
    const content = fill.sheets[sheetName];
    if (!content) continue;
    await fillPresentationSheet(zip, sheetName, spec, content);
  }

  await fillRepCard(zip, fill);
  await updateReferences(zip, fill);
  await restorePivotCacheSharedItems(zip);
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

  const lastRowFor: Record<string, number> = {};
  for (const [sheetName, spec] of Object.entries(MANIFEST.sheets)) {
    if (spec.kind === "formula") continue;
    const first = spec.firstDataRow ?? (spec.headerRows ?? 0) + 1;
    const written =
      sheetName === DATA_SHEET
        ? Math.max(salesRows, areaBookRows, Math.max(pickListRows - 1, 0))
        : fill.sheets[sheetName]?.rows?.length ?? 0;
    lastRowFor[sheetName] = written > 0 ? first + written - 1 : first;
  }

  const repSpec = MANIFEST.sheets[REP_CARD];
  if (repSpec) {
    const trailer = repSpec.trailerRows ?? [];
    const stampRow = repSpec.productStampRow ?? 17;
    const products = fill.repCard?.products.length ?? 0;
    const firstTrailer = trailer.length ? Math.min(...trailer) : stampRow + 1;
    const shift = products ? stampRow + products - firstTrailer : 0;
    lastRowFor[REP_CARD] = (trailer.length ? Math.max(...trailer) : stampRow) + shift;
  }

  const clamp = (_match: string, open: string, ref: string, close: string): string => {
    const parsed = /^('?)([^'!]+)\1!(\$[A-Z]+\$\d+):(\$[A-Z]+)\$(\d+)$/.exec(ref);
    if (!parsed) return `${open}${ref}${close}`;
    const [, quote, sheetName, first, lastColRef] = parsed;
    const last = lastRowFor[sheetName!];
    if (!last) return `${open}${ref}${close}`;
    return `${open}${quote}${sheetName}${quote}!${first}:${lastColRef}$${last}${close}`;
  };

  workbook = workbook.replace(/(<definedName name="_xlnm\._FilterDatabase"[^>]*>)([^<]*)(<\/definedName>)/g, clamp);
  workbook = workbook.replace(/(<definedName name="_xlnm\.Print_Area"[^>]*>)([^<]*)(<\/definedName>)/g, clamp);
  workbook = workbook.replace(/(<definedName name="PhxPrintArea"[^>]*>)([^<]*)(<\/definedName>)/g, clamp);
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
 * The values written are PLACEHOLDERS, never the real ones (which this code does not have and must
 * not leak). `refreshOnLoad="1"` replaces them from `SalesData` the moment the workbook opens. If
 * a reader somehow blocks that refresh they see "Region 1", "Area 2" — visibly unfinished, which
 * is the safe way to be wrong. Plausible-and-wrong is the outcome worth avoiding; the template
 * build's own header makes the same argument for shipping the template empty.
 *
 * Idempotent by construction: only a self-closing `<sharedItems/>` — the emptied form — is
 * rewritten, so a template that already carries a populated pool is left untouched.
 */
async function restorePivotCacheSharedItems(zip: JSZip): Promise<void> {
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
    // what maps each one back to its index.
    let index = -1;
    const filled = xml.replace(/<sharedItems\s*\/>/g, () => {
      index += 1;
      const count = depth.get(index);
      if (!count) return "<sharedItems/>";
      const label = names[index] ?? `Field ${index + 1}`;
      const items = Array.from(
        { length: count },
        (_, n) => `<s v="${xmlEscape(`${label} ${n + 1}`).replace(/"/g, "&quot;")}"/>`,
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
