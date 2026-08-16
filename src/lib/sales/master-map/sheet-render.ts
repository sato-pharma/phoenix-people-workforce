// Master Map — turning rendered rows into Google Sheets API requests.
//
// Two things drive every choice here.
//
// REQUEST COUNT. A 50,000-row sheet formatted one row at a time is 50,000 requests and will not
// finish. Consecutive rows of the same kind are therefore collapsed into a single range request,
// which takes the whole workbook down to a few hundred.
//
// NO WRAPPING, NO ELLIPSIS. The owner's standing rule. Every cell is OVERFLOW_CELL — text spills
// into empty neighbours rather than wrapping to a second line or being clipped with a "…".

import type { MasterMapRow } from "@/lib/sales/master-map/tree";
import { MASTER_MAP_COLUMNS } from "@/lib/sales/master-map/tree";

const COLUMN_COUNT = MASTER_MAP_COLUMNS.length;

type Rgb = { blue: number; green: number; red: number };

const rgb = (red: number, green: number, blue: number): Rgb => ({
  blue: blue / 255,
  green: green / 255,
  red: red / 255,
});

const STYLE = {
  area: { background: rgb(37, 99, 135), bold: true, size: 12, text: rgb(255, 255, 255) },
  brick: { background: rgb(226, 232, 240), bold: true, size: 11, text: rgb(15, 23, 42) },
  columnHeader: { background: rgb(248, 250, 252), bold: true, size: 9, text: rgb(100, 116, 139) },
  emptyNote: { background: rgb(254, 249, 195), bold: false, size: 10, text: rgb(133, 77, 14) },
  region: { background: rgb(15, 23, 42), bold: true, size: 14, text: rgb(255, 255, 255) },
  unnamed: { background: rgb(254, 243, 199), bold: false, size: 10, text: rgb(120, 53, 15) },
} as const;

/**
 * The provenance column: pale grey, small, italic. Deliberately the quietest thing on the row —
 * it is there to be consulted when a pharmacy looks wrong, not to compete with the pharmacy's own
 * name. Applied as a second pass over just that column, after the row's own style.
 */
const SOURCE_STYLE = { italic: true, size: 8, text: rgb(148, 163, 184) } as const;

const SOURCE_COLUMN = COLUMN_COUNT - 1;

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

function styleFor(row: MasterMapRow): (typeof STYLE)[keyof typeof STYLE] | null {
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

function repeatCellRequest(
  sheetId: number,
  startRow: number,
  endRow: number,
  style: (typeof STYLE)[keyof typeof STYLE],
): unknown {
  return {
    repeatCell: {
      cell: {
        userEnteredFormat: {
          backgroundColor: style.background,
          textFormat: {
            bold: style.bold,
            fontSize: style.size,
            foregroundColor: style.text,
          },
          verticalAlignment: "MIDDLE",
          wrapStrategy: "OVERFLOW_CELL",
        },
      },
      fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)",
      range: { endRowIndex: endRow, sheetId, startColumnIndex: 0, startRowIndex: startRow },
    },
  };
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
          textFormat: {
            bold: false,
            fontSize: SOURCE_STYLE.size,
            foregroundColor: SOURCE_STYLE.text,
            italic: SOURCE_STYLE.italic,
          },
          wrapStrategy: "OVERFLOW_CELL",
        },
      },
      fields: "userEnteredFormat(textFormat,wrapStrategy)",
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
export function renderSheet(rows: readonly MasterMapRow[], sheetId: number): RenderedSheet {
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

  // Column widths chosen so the long Arabic pharmacy names and addresses sit on one line.
  // Order: Pharmacy, Distributor, Code, Also supplied by, Channel, Address.
  const widths = [400, 150, 130, 250, 90, 600, 320];
  widths.forEach((width, column) => {
    requests.push({
      updateDimensionProperties: {
        fields: "pixelSize",
        properties: { pixelSize: width },
        range: { dimension: "COLUMNS", endIndex: column + 1, sheetId, startIndex: column },
      },
    });
  });

  return { clearRequests, requests, values };
}

/** The flat lookup tab: a frozen header, no merges, filterable. */
export function renderFlatSheet(
  header: readonly string[],
  dataRows: readonly (readonly string[])[],
  sheetId: number,
): RenderedSheet {
  const values = [[...header], ...dataRows.map((row) => [...row])];
  const clearRequests: unknown[] = [
    { updateCells: { fields: "userEnteredValue,userEnteredFormat", range: { sheetId } } },
  ];
  const requests: unknown[] = [
    {
      updateSheetProperties: {
        fields: "gridProperties.frozenRowCount",
        properties: { gridProperties: { frozenRowCount: 1 }, sheetId },
      },
    },
    repeatCellRequest(sheetId, 0, 1, STYLE.region),
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

  const widths = [140, 170, 200, 100, 400, 150, 130, 250, 90, 600, 320];
  widths.forEach((width, column) => {
    requests.push({
      updateDimensionProperties: {
        fields: "pixelSize",
        properties: { pixelSize: width },
        range: { dimension: "COLUMNS", endIndex: column + 1, sheetId, startIndex: column },
      },
    });
  });
  return { clearRequests, requests, values };
}
