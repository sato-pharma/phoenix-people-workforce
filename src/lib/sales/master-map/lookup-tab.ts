// Master Map — the "Find a pharmacy" tab and the hidden helper tab behind it.
//
// This is the tab the owner actually works in: four dropdowns that narrow each other, a search box
// that looks across name, code and address at once, a live count, and the matching shops beneath.
//
// THREE THINGS HERE ARE NOT OBVIOUS.
//
// 1. FORMULAS CANNOT GO THROUGH THE VALUES WRITE. Both the Node client and the Apps Script send
//    values with valueInputOption=RAW, and that is deliberate: pharmacy codes are zero-padded
//    ("0012345"), so USER_ENTERED would read them as numbers and silently eat the leading zeros.
//    RAW keeps the codes intact but stores "=FILTER(...)" as literal text. So every formula on
//    these two tabs is injected as a formulaValue in the REQUESTS pass instead.
//
// 2. THE FILTER RUNS ONCE, ON THE HIDDEN TAB. Both the count and the visible rows read the same
//    spilled result. Doing it twice would mean two passes over 50,000 rows on every keystroke.
//
// 3. THE VISIBLE ROWS ARE CAPPED. ARRAY_CONSTRAIN holds the display to 500 shops, and the status
//    line says so with the true total beside it. Spilling all 50,000 into a tab that recalculates
//    on every dropdown change makes the sheet unusable, and a silent cap would read as missing
//    data — hence the count.
//
// LAYOUT_VERSION is what makes a design change reach the sheet. The plan hashes each tab's TEXT,
// so an edit that only touches formulas or formatting would hash identically and never repaint.
// Bumping the version changes the visible text, which moves the hash. Bump it whenever you change
// anything on these two tabs.

import { MASTER_MAP_FLAT_COLUMNS } from "@/lib/sales/master-map/tree";
import {
  FONT,
  STYLE,
  rgb,
  renderedTabColor,
  repeatCellRequest,
  type RenderedSheet,
} from "@/lib/sales/master-map/sheet-render";

export const LOOKUP_TAB = "Find a pharmacy";

/** Hidden. Holds the dropdown lists and the one live filter both halves of the tab read. */
export const LISTS_TAB = "Lists";

const LAYOUT_VERSION = "v1";

/** How many matching shops the tab shows at once. The true total is always stated beside it. */
const VISIBLE_LIMIT = 500;

const COLUMN_COUNT = MASTER_MAP_FLAT_COLUMNS.length;

/** Where the controls live, 0-based. Row 4 on screen. */
const INPUT_ROW = 3;
const STATUS_ROW = 5;
const HINT_ROW = 6;
const HEADER_ROW = 7;
const RESULTS_ROW = 8;

/**
 * Columns of "All customers", by letter, so the formulas below read as something a person can
 * check against the tab rather than as arithmetic on indexes.
 */
const FLAT = {
  address: "J",
  area: "B",
  brick: "C",
  channel: "I",
  code: "G",
  pharmacy: "E",
  region: "A",
} as const;

const LOOKUP = `'${LOOKUP_TAB}'`;
const SOURCE = `'All customers'`;

/** "blank means everything" — a cleared box contributes nothing rather than matching nothing. */
function optional(cell: string, column: string): string {
  return `(${LOOKUP}!${cell}="")+(${SOURCE}!${column}2:${column}=${LOOKUP}!${cell})`;
}

function searchClause(cell: string): string {
  const anyOf = [FLAT.pharmacy, FLAT.code, FLAT.address]
    .map((column) => `ISNUMBER(SEARCH(${LOOKUP}!${cell},${SOURCE}!${column}2:${column}))`)
    .join("+");
  return `(${LOOKUP}!${cell}="")+${anyOf}`;
}

/** One distinct, sorted column of "All customers", narrowed by whichever boxes are already set. */
function listFormula(column: string, narrowBy: readonly string[]): string {
  const conditions = [`${SOURCE}!${column}2:${column}<>""`, ...narrowBy].join(",");
  // Single-argument IFERROR, which returns a genuinely blank cell. IFERROR(x,"") would put an
  // empty STRING there instead, and COUNTA counts an empty string — so "no matches" would report
  // as one match and the status line would contradict the empty table underneath it.
  return `=IFERROR(SORT(UNIQUE(FILTER(${SOURCE}!${column}2:${column},${conditions}))))`;
}

const REGION_CELL = "$A$4";
const AREA_CELL = "$B$4";
const BRICK_CELL = "$C$4";
const CHANNEL_CELL = "$D$4";
const SEARCH_CELL = "$E$4";

const RESULT_FORMULA = `=IFERROR(FILTER(${SOURCE}!A2:K,${[
  optional(REGION_CELL, FLAT.region),
  optional(AREA_CELL, FLAT.area),
  optional(BRICK_CELL, FLAT.brick),
  optional(CHANNEL_CELL, FLAT.channel),
  searchClause(SEARCH_CELL),
].join(",")}))`;

function updateCellFormula(sheetId: number, row: number, column: number, formula: string): unknown {
  return {
    updateCells: {
      fields: "userEnteredValue",
      range: {
        endColumnIndex: column + 1,
        endRowIndex: row + 1,
        sheetId,
        startColumnIndex: column,
        startRowIndex: row,
      },
      rows: [{ values: [{ userEnteredValue: { formulaValue: formula } }] }],
    },
  };
}

function dropdownRequest(sheetId: number, column: number, range: string, help: string): unknown {
  return {
    setDataValidation: {
      range: {
        endColumnIndex: column + 1,
        endRowIndex: INPUT_ROW + 1,
        sheetId,
        startColumnIndex: column,
        startRowIndex: INPUT_ROW,
      },
      rule: {
        condition: { type: "ONE_OF_RANGE", values: [{ userEnteredValue: `=${LISTS_TAB}!${range}` }] },
        inputMessage: help,
        // Not strict: the box has to be clearable, and "strict" would reject an empty cell — which
        // is exactly the state that means "all of them".
        showCustomUi: true,
        strict: false,
      },
    },
  };
}

/**
 * The hidden helper tab.
 *
 * Only A1 carries text; everything else is a spilling formula, and nothing is written into the
 * spill areas. A written-then-blanked cell still counts as occupied to a spilling array, which
 * shows up as #REF! across the whole tab.
 */
export function renderListsSheet(sheetId: number): RenderedSheet {
  const values = [[`Master Map helper — do not edit. Layout ${LAYOUT_VERSION}`]];

  const clearRequests: unknown[] = [
    { updateCells: { fields: "userEnteredValue,userEnteredFormat", range: { sheetId } } },
  ];

  const requests: unknown[] = [
    // Grow the grid BEFORE the formulas land, and grow it to hold every shop.
    //
    // With no filters set the result spills all 50,622 rows, and a spill with nowhere to go fails
    // the whole tab rather than truncating. The script's own ensureTab only ever asks for 1,000
    // rows here, because it sizes a tab from the TEXT it is about to write and this tab's text is
    // a single cell — so the height has to be claimed here, in the request pass that follows it.
    {
      updateSheetProperties: {
        fields: "gridProperties(rowCount,columnCount)",
        properties: { gridProperties: { columnCount: 18, rowCount: 55_000 }, sheetId },
      },
    },
    updateCellFormula(sheetId, 1, 0, listFormula(FLAT.region, [])),
    updateCellFormula(
      sheetId,
      1,
      1,
      listFormula(FLAT.area, [optional(REGION_CELL, FLAT.region)]),
    ),
    updateCellFormula(
      sheetId,
      1,
      2,
      listFormula(FLAT.brick, [
        optional(REGION_CELL, FLAT.region),
        optional(AREA_CELL, FLAT.area),
      ]),
    ),
    updateCellFormula(sheetId, 1, 3, listFormula(FLAT.channel, [])),
    updateCellFormula(sheetId, 1, 5, RESULT_FORMULA),
    {
      updateSheetProperties: { fields: "hidden", properties: { hidden: true, sheetId } },
    },
  ];

  return { clearRequests, requests, values };
}

/** The tab the owner works in. */
export function renderLookupSheet(sheetId: number): RenderedSheet {
  const blank = (): string[] => new Array(COLUMN_COUNT).fill("");
  const row = (cells: readonly string[]): string[] => {
    const out = [...cells];
    while (out.length < COLUMN_COUNT) out.push("");
    return out;
  };

  const values: string[][] = [
    row(["Find a pharmacy"]),
    blank(),
    row(["Region", "Area", "Brick", "Channel", "Search a name, a code or an address"]),
    blank(),
    blank(),
    blank(),
    row([
      `Leave a box empty to include all of it. Showing at most ${VISIBLE_LIMIT} shops at a time — ` +
        `the count above is the real total. Layout ${LAYOUT_VERSION}.`,
    ]),
    [...MASTER_MAP_FLAT_COLUMNS],
  ];

  const clearRequests: unknown[] = [
    { unmergeCells: { range: { sheetId } } },
    {
      updateCells: {
        fields: "userEnteredValue,userEnteredFormat,dataValidation",
        range: { sheetId },
      },
    },
  ];

  const bandRows = [0, STATUS_ROW, HINT_ROW];

  const requests: unknown[] = [
    {
      updateSheetProperties: {
        fields: "gridProperties(hideGridlines,frozenRowCount)",
        properties: { gridProperties: { frozenRowCount: HEADER_ROW + 1, hideGridlines: true }, sheetId },
      },
    },
    ...bandRows.map((index) => ({
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
    })),
    repeatCellRequest(sheetId, 0, 1, STYLE.region),
    repeatCellRequest(sheetId, 2, 3, STYLE.label),
    repeatCellRequest(sheetId, STATUS_ROW, STATUS_ROW + 1, STYLE.area),
    repeatCellRequest(sheetId, HEADER_ROW, HEADER_ROW + 1, STYLE.columnHeader),
    // The five control cells: a pale box with a real border, so they read as things to fill in
    // rather than as more data.
    {
      repeatCell: {
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(248, 250, 252),
            horizontalAlignment: "CENTER",
            textFormat: {
              bold: true,
              fontFamily: FONT,
              fontSize: 11,
              foregroundColor: rgb(15, 23, 42),
            },
            verticalAlignment: "MIDDLE",
            wrapStrategy: "OVERFLOW_CELL",
          },
        },
        fields:
          "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat,verticalAlignment,wrapStrategy)",
        range: {
          endColumnIndex: 5,
          endRowIndex: INPUT_ROW + 1,
          sheetId,
          startColumnIndex: 0,
          startRowIndex: INPUT_ROW,
        },
      },
    },
    {
      updateBorders: {
        bottom: { color: rgb(148, 163, 184), style: "SOLID", width: 1 },
        innerVertical: { color: rgb(203, 213, 225), style: "SOLID", width: 1 },
        left: { color: rgb(148, 163, 184), style: "SOLID", width: 1 },
        range: {
          endColumnIndex: 5,
          endRowIndex: INPUT_ROW + 1,
          sheetId,
          startColumnIndex: 0,
          startRowIndex: INPUT_ROW,
        },
        right: { color: rgb(148, 163, 184), style: "SOLID", width: 1 },
        top: { color: rgb(148, 163, 184), style: "SOLID", width: 1 },
      },
    },
    // The hint line: quiet, so it explains itself once and then gets out of the way.
    {
      repeatCell: {
        cell: {
          userEnteredFormat: {
            horizontalAlignment: "CENTER",
            textFormat: {
              bold: false,
              fontFamily: FONT,
              fontSize: 9,
              foregroundColor: rgb(148, 163, 184),
              italic: true,
            },
          },
        },
        fields: "userEnteredFormat(horizontalAlignment,textFormat)",
        range: {
          endRowIndex: HINT_ROW + 1,
          sheetId,
          startColumnIndex: 0,
          startRowIndex: HINT_ROW,
        },
      },
    },
    dropdownRequest(sheetId, 0, "A2:A", "Pick a region, or leave it empty for every region."),
    dropdownRequest(sheetId, 1, "B2:B", "Areas of the region you picked."),
    dropdownRequest(sheetId, 2, "C2:C", "Bricks of the area you picked."),
    dropdownRequest(sheetId, 3, "D2:D", "Pharmacy, Store or Hospital."),
    updateCellFormula(
      sheetId,
      STATUS_ROW,
      0,
      `=IF(COUNTA(${LISTS_TAB}!F2:F)=0,"Nothing matches those filters — clear one of the boxes above.",` +
        `"Showing "&TEXT(MIN(${VISIBLE_LIMIT},COUNTA(${LISTS_TAB}!F2:F)),"#,##0")&" of "&` +
        `TEXT(COUNTA(${LISTS_TAB}!F2:F),"#,##0")&" matching shops")`,
    ),
    updateCellFormula(
      sheetId,
      RESULTS_ROW,
      0,
      `=IFERROR(ARRAY_CONSTRAIN(${LISTS_TAB}!F2:P,${VISIBLE_LIMIT},${COLUMN_COUNT}))`,
    ),
    {
      updateDimensionProperties: {
        fields: "pixelSize",
        properties: { pixelSize: 44 },
        range: { dimension: "ROWS", endIndex: 1, sheetId, startIndex: 0 },
      },
    },
    {
      updateDimensionProperties: {
        fields: "pixelSize",
        properties: { pixelSize: 32 },
        range: { dimension: "ROWS", endIndex: INPUT_ROW + 1, sheetId, startIndex: INPUT_ROW },
      },
    },
    {
      updateDimensionProperties: {
        fields: "pixelSize",
        properties: { pixelSize: 28 },
        range: { dimension: "ROWS", endIndex: STATUS_ROW + 1, sheetId, startIndex: STATUS_ROW },
      },
    },
  ];

  [140, 170, 200, 100, 400, 150, 130, 250, 90, 600, 320].forEach((width, column) => {
    requests.push({
      updateDimensionProperties: {
        fields: "pixelSize",
        properties: { pixelSize: width },
        range: { dimension: "COLUMNS", endIndex: column + 1, sheetId, startIndex: column },
      },
    });
  });

  requests.push(renderedTabColor(sheetId, rgb(15, 23, 42)));

  return { clearRequests, requests, values };
}
