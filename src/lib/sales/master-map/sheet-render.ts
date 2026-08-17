// Master Map — turning rendered rows into Google Sheets API requests.
//
// Three things drive every choice here.
//
// REQUEST COUNT. A 50,000-row sheet formatted one row at a time is 50,000 requests and will not
// finish. Consecutive rows of the same kind are therefore collapsed into a single range request,
// which takes the whole workbook down to a few hundred.
//
// NO WRAPPING, NO ELLIPSIS. The owner's standing rule. Every cell is OVERFLOW_CELL — text spills
// into empty neighbours rather than wrapping to a second line or being clipped with a "…".
//
// CENTRED, BUT NOT BLINDLY. Bands, headers and every short column are centred. Pharmacy name,
// address and provenance stay left-aligned on purpose: they are long free text under
// OVERFLOW_CELL, so centring them would spill each line out of BOTH sides of its cell and the
// column would stop reading as a column at all.

import type { MasterMapRow } from "@/lib/sales/master-map/tree";
import { MASTER_MAP_COLUMNS } from "@/lib/sales/master-map/tree";

const COLUMN_COUNT = MASTER_MAP_COLUMNS.length;

export type Rgb = { blue: number; green: number; red: number };

export const rgb = (red: number, green: number, blue: number): Rgb => ({
  blue: blue / 255,
  green: green / 255,
  red: red / 255,
});

/**
 * One font across the whole workbook.
 *
 * Roboto, because it ships with Sheets and carries a full Arabic face — most of these pharmacy
 * names are Arabic, and a font without that coverage silently falls back per-glyph, which is what
 * makes a sheet look homemade.
 */
export const FONT = "Roboto";

const WHITE = rgb(255, 255, 255);

type CellStyle = {
  align: "CENTER" | "LEFT";
  background: Rgb;
  bold: boolean;
  size: number;
  text: Rgb;
};

export const STYLE = {
  area: { align: "CENTER", background: rgb(30, 91, 138), bold: true, size: 12, text: WHITE },
  brick: {
    align: "CENTER",
    background: rgb(226, 232, 240),
    bold: true,
    size: 11,
    text: rgb(15, 23, 42),
  },
  columnHeader: {
    align: "CENTER",
    background: rgb(241, 245, 249),
    bold: true,
    size: 9,
    text: rgb(100, 116, 139),
  },
  emptyNote: {
    align: "CENTER",
    background: rgb(254, 249, 195),
    bold: false,
    size: 10,
    text: rgb(133, 77, 14),
  },
  label: {
    align: "CENTER",
    background: WHITE,
    bold: true,
    size: 10,
    text: rgb(100, 116, 139),
  },
  region: { align: "CENTER", background: rgb(15, 23, 42), bold: true, size: 15, text: WHITE },
  unnamed: {
    align: "LEFT",
    background: rgb(254, 243, 199),
    bold: false,
    size: 10,
    text: rgb(120, 53, 15),
  },
} as const satisfies Record<string, CellStyle>;

/** Bands get room to breathe; everything else stays tight so more shops fit on a screen. */
const ROW_HEIGHT = { area: 30, base: 21, region: 38 } as const;

/**
 * The provenance column: pale grey, small, italic. Deliberately the quietest thing on the row —
 * it is there to be consulted when a pharmacy looks wrong, not to compete with the pharmacy's own
 * name. Applied as a second pass over just that column, after the row's own style.
 */
const SOURCE_STYLE = { italic: true, size: 8, text: rgb(148, 163, 184) } as const;

const SOURCE_COLUMN = COLUMN_COUNT - 1;

/**
 * Which columns are centred on the grouped tabs.
 *
 * Distributor, Code, Also supplied by, Channel. Pharmacy (0), Address (5) and provenance (6) are
 * long free text and stay left — see the header comment.
 */
const GROUPED_CENTRED_COLUMNS = [1, 2, 3, 4];

/** Same idea on the flat tab, whose geography columns are short enough to centre as well. */
const FLAT_CENTRED_COLUMNS = [0, 1, 2, 3, 5, 6, 7, 8];

/** The visible text of one row, padded to the full column count. */
function rowValues(row: MasterMapRow): string[] {
  const pad = (cells: string[]) => {
    const out = [...cells];
    while (out.length < COLUMN_COUNT) out.push("");
    return out;
  };
  switch (row.kind) {
    case "area":
    case "brick":
    case "empty-note":
    case "region":
      return pad([row.label]);
    case "blank":
      return pad([]);
    case "customer":
      return pad(row.cells);
    case "header":
      return [...MASTER_MAP_COLUMNS];
  }
}

/** Does this row kind occupy one merged band across all columns? */
function isBand(kind: MasterMapRow["kind"]): boolean {
  return kind === "region" || kind === "area" || kind === "brick" || kind === "empty-note";
}

function styleFor(row: MasterMapRow): CellStyle | null {
  switch (row.kind) {
    case "area":
      return STYLE.area;
    case "brick":
      return STYLE.brick;
    case "empty-note":
      return STYLE.emptyNote;
    case "header":
      return STYLE.columnHeader;
    case "region":
      return STYLE.region;
    case "customer":
      return row.unnamed ? STYLE.unnamed : null;
    case "blank":
      return null;
  }
}

/** A stable key so consecutive identically-styled rows collapse into one request. */
function styleKey(row: MasterMapRow): string {
  if (row.kind === "customer") return row.unnamed ? "customer-unnamed" : "customer";
  return row.kind;
}

export function repeatCellRequest(
  sheetId: number,
  startRow: number,
  endRow: number,
  style: CellStyle,
): unknown {
  return {
    repeatCell: {
      cell: {
        userEnteredFormat: {
          backgroundColor: style.background,
          horizontalAlignment: style.align,
          textFormat: {
            bold: style.bold,
            fontFamily: FONT,
            fontSize: style.size,
            foregroundColor: style.text,
          },
          verticalAlignment: "MIDDLE",
          wrapStrategy: "OVERFLOW_CELL",
        },
      },
      fields:
        "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat,verticalAlignment,wrapStrategy)",
      range: { endRowIndex: endRow, sheetId, startColumnIndex: 0, startRowIndex: startRow },
    },
  };
}

/**
 * The base coat: one request that gives every cell on the tab the workbook font and a white
 * ground, before any row style lands on top.
 *
 * Without it, plain customer rows carry no style request at all (styleFor returns null for them,
 * which is what keeps the request count down) and would therefore keep Google's default Arial.
 */
function baseFormatRequest(sheetId: number): unknown {
  return {
    repeatCell: {
      cell: {
        userEnteredFormat: {
          backgroundColor: WHITE,
          horizontalAlignment: "LEFT",
          textFormat: { bold: false, fontFamily: FONT, fontSize: 10, foregroundColor: rgb(15, 23, 42) },
          verticalAlignment: "MIDDLE",
          wrapStrategy: "OVERFLOW_CELL",
        },
      },
      fields:
        "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat,verticalAlignment,wrapStrategy)",
      range: { sheetId },
    },
  };
}

/** Gridlines off. The bands carry the structure, and the ruled paper look fights them. */
function hideGridlinesRequest(sheetId: number): unknown {
  return {
    updateSheetProperties: {
      fields: "gridProperties.hideGridlines",
      properties: { gridProperties: { hideGridlines: true }, sheetId },
    },
  };
}

function rowHeightRequest(sheetId: number, startRow: number, endRow: number, pixels: number): unknown {
  return {
    updateDimensionProperties: {
      fields: "pixelSize",
      properties: { pixelSize: pixels },
      range: { dimension: "ROWS", endIndex: endRow, sheetId, startIndex: startRow },
    },
  };
}

/** Centre a single column for the whole height of the tab. */
function centreColumnRequest(sheetId: number, column: number): unknown {
  return {
    repeatCell: {
      cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
      fields: "userEnteredFormat.horizontalAlignment",
      range: { endColumnIndex: column + 1, sheetId, startColumnIndex: column },
    },
  };
}

function columnWidthRequests(sheetId: number, widths: readonly number[]): unknown[] {
  return widths.map((width, column) => ({
    updateDimensionProperties: {
      fields: "pixelSize",
      properties: { pixelSize: width },
      range: { dimension: "COLUMNS", endIndex: column + 1, sheetId, startIndex: column },
    },
  }));
}

/**
 * Re-style just the provenance column across a run of customer rows.
 *
 * `column` is a parameter because the grouped tabs and the flat lookup tab put provenance in
 * different places — last of seven columns on one, last of eleven on the other — and the owner
 * asked for the same quiet treatment beside every pharmacy, on whichever tab he is reading.
 */
function sourceColumnRequest(
  sheetId: number,
  startRow: number,
  endRow: number,
  column: number = SOURCE_COLUMN,
): unknown {
  return {
    repeatCell: {
      cell: {
        userEnteredFormat: {
          horizontalAlignment: "LEFT",
          textFormat: {
            bold: false,
            fontFamily: FONT,
            fontSize: SOURCE_STYLE.size,
            foregroundColor: SOURCE_STYLE.text,
            italic: SOURCE_STYLE.italic,
          },
          wrapStrategy: "OVERFLOW_CELL",
        },
      },
      fields: "userEnteredFormat(horizontalAlignment,textFormat,wrapStrategy)",
      range: {
        endColumnIndex: column + 1,
        endRowIndex: endRow,
        sheetId,
        startColumnIndex: column,
        startRowIndex: startRow,
      },
    },
  };
}

/**
 * A colour for the tab strip, derived from the tab's own name.
 *
 * Derived rather than listed, because the region list is data — two regions were added since this
 * sheet was first drawn. A hard-coded palette would leave every future region grey.
 */
export function tabColorFor(title: string): Rgb {
  const palette: Rgb[] = [
    rgb(30, 91, 138),
    rgb(13, 148, 136),
    rgb(147, 51, 234),
    rgb(217, 119, 6),
    rgb(190, 24, 93),
    rgb(5, 150, 105),
    rgb(2, 132, 199),
    rgb(180, 83, 9),
    rgb(109, 40, 217),
  ];
  let sum = 0;
  for (let index = 0; index < title.length; index += 1) sum += title.charCodeAt(index);
  return palette[sum % palette.length];
}

export function renderedTabColor(sheetId: number, color: Rgb): unknown {
  return {
    updateSheetProperties: { fields: "tabColor", properties: { sheetId, tabColor: color } },
  };
}

export type RenderedSheet = {
  /**
   * The destructive pass, kept apart from the rest on purpose.
   *
   * Painting a tab is clear -> text -> formatting, never clear -> formatting -> text. The Apps
   * Script gets six minutes per run and a big tab can span two of them, so whatever order these
   * go in is a state the owner can actually open the sheet and see. Losing the formatting for a
   * few minutes is survivable; looking at a blank Master tab is not.
   */
  clearRequests: unknown[];
  requests: unknown[];
  values: string[][];
};

/**
 * Build everything needed to paint one tab: the text, the merged bands, and the formatting.
 *
 * `sheetId` is the numeric tab id, which the caller reads back from the spreadsheet after
 * creating the tab — titles are not stable identifiers in the Sheets API.
 */
export function renderSheet(
  rows: readonly MasterMapRow[],
  sheetId: number,
  options: { tabColor?: Rgb } = {},
): RenderedSheet {
  const values = rows.map(rowValues);
  const requests: unknown[] = [];

  // Wipe whatever the tab held before, so a shrinking dataset cannot leave stale rows behind.
  // The unmerge has to come first and has to be unconditional: updateCells does NOT clear merges,
  // so on the second sync last week's bands would still be merged and every new mergeCells that
  // overlapped one of them would fail the whole batch.
  const clearRequests: unknown[] = [
    { unmergeCells: { range: { sheetId } } },
    { updateCells: { fields: "userEnteredValue,userEnteredFormat", range: { sheetId } } },
  ];

  requests.push(hideGridlinesRequest(sheetId));
  requests.push(baseFormatRequest(sheetId));
  requests.push(rowHeightRequest(sheetId, 0, Math.max(values.length, 1), ROW_HEIGHT.base));

  // Merge every band row across the full width, in one request each. Bands are a small fraction
  // of the sheet (about 760 of 53,000 rows), so per-row requests are affordable here.
  rows.forEach((row, index) => {
    if (!isBand(row.kind)) return;
    requests.push({
      mergeCells: {
        mergeType: "MERGE_ALL",
        range: {
          endColumnIndex: COLUMN_COUNT,
          endRowIndex: index + 1,
          sheetId,
          startColumnIndex: 0,
          startRowIndex: index,
        },
      },
    });
  });

  // Collapse consecutive same-styled rows into range formatting requests.
  let runStart = 0;
  for (let index = 0; index <= rows.length; index += 1) {
    const atEnd = index === rows.length;
    const changed = atEnd || styleKey(rows[index]) !== styleKey(rows[runStart]);
    if (!changed) continue;
    const style = styleFor(rows[runStart]);
    if (style) requests.push(repeatCellRequest(sheetId, runStart, index, style));
    // Second pass over the provenance column only, so it stays pale and small on every customer
    // row — including the amber unnamed ones, whose own style would otherwise darken it.
    if (rows[runStart].kind === "customer") {
      requests.push(sourceColumnRequest(sheetId, runStart, index));
    }
    runStart = index;
  }

  // Taller rows for the two headline band kinds only. Bricks are left at the base height on
  // purpose: there are 697 of them and one request each would cost more than it is worth.
  rows.forEach((row, index) => {
    if (row.kind === "region") requests.push(rowHeightRequest(sheetId, index, index + 1, ROW_HEIGHT.region));
    else if (row.kind === "area") requests.push(rowHeightRequest(sheetId, index, index + 1, ROW_HEIGHT.area));
  });

  for (const column of GROUPED_CENTRED_COLUMNS) requests.push(centreColumnRequest(sheetId, column));

  // Column widths chosen so the long Arabic pharmacy names and addresses sit on one line.
  // Order: Pharmacy, Distributor, Code, Also supplied by, Channel, Address, Where this came from.
  requests.push(...columnWidthRequests(sheetId, [400, 150, 130, 250, 90, 600, 320]));

  if (options.tabColor) requests.push(renderedTabColor(sheetId, options.tabColor));

  return { clearRequests, requests, values };
}

/** The flat lookup tab: a frozen header, no merges, filterable. */
export function renderFlatSheet(
  header: readonly string[],
  dataRows: readonly (readonly string[])[],
  sheetId: number,
  options: { tabColor?: Rgb } = {},
): RenderedSheet {
  const values = [[...header], ...dataRows.map((row) => [...row])];
  const clearRequests: unknown[] = [
    { updateCells: { fields: "userEnteredValue,userEnteredFormat", range: { sheetId } } },
  ];
  const requests: unknown[] = [
    hideGridlinesRequest(sheetId),
    baseFormatRequest(sheetId),
    rowHeightRequest(sheetId, 0, Math.max(values.length, 1), ROW_HEIGHT.base),
    {
      updateSheetProperties: {
        fields: "gridProperties.frozenRowCount",
        properties: { gridProperties: { frozenRowCount: 1 }, sheetId },
      },
    },
    repeatCellRequest(sheetId, 0, 1, STYLE.region),
    rowHeightRequest(sheetId, 0, 1, ROW_HEIGHT.area),
    {
      setBasicFilter: {
        filter: { range: { endColumnIndex: header.length, sheetId, startRowIndex: 0 } },
      },
    },
  ];
  // Provenance stays pale and small here too — same rule, different column index.
  if (values.length > 1) {
    requests.push(sourceColumnRequest(sheetId, 1, values.length, header.length - 1));
  }

  // A hairline under every row. Deliberately borders rather than an addBanding request: banding
  // is a persistent object that updateCells does not clear, so re-running the sync would stack a
  // second banded range over the first and Google rejects the overlap.
  if (values.length > 1) {
    requests.push({
      updateBorders: {
        innerHorizontal: { color: rgb(241, 245, 249), style: "SOLID", width: 1 },
        range: {
          endColumnIndex: header.length,
          endRowIndex: values.length,
          sheetId,
          startColumnIndex: 0,
          startRowIndex: 1,
        },
      },
    });
  }

  for (const column of FLAT_CENTRED_COLUMNS) requests.push(centreColumnRequest(sheetId, column));

  requests.push(
    ...columnWidthRequests(sheetId, [140, 170, 200, 100, 400, 150, 130, 250, 90, 600, 320]),
  );

  if (options.tabColor) requests.push(renderedTabColor(sheetId, options.tabColor));

  return { clearRequests, requests, values };
}
