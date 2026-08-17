// Master Map — the "Gaps" tab.
//
// Two lists the owner can act on, in one place: the shops that reached us without a name, and the
// bricks holding no customers at all. Measured on production 2026-08-17: 7,407 nameless shops
// (14.6% of the master) and 90 empty bricks.
//
// WHY A TAB RATHER THAN A FILTER. Both are already visible on the main tabs — a nameless shop
// renders amber saying "(no name on file)", an empty brick renders with a note under it. That is
// honest and completely useless for fixing them, because they are spread across 697 bricks. This
// tab is the working list.
//
// WHY THE COUNTS ARE IN THE BAND TEXT. They are rendered, not computed by a formula, so the tab
// hashes differently the moment either number moves. A COUNTA() would leave the plan hash
// identical and the sheet would sit on a stale figure until something else forced a repaint.

import {
  MASTER_MAP_EMPTY_BRICK_COLUMNS,
  MASTER_MAP_GAP_COLUMNS,
  renderEmptyBrickRows,
  renderUnnamedRows,
  type MasterMapTree,
} from "@/lib/sales/master-map/tree";
import {
  MANAGER_COLUMN_WIDTH,
  STYLE,
  rgb,
  renderedTabColor,
  repeatCellRequest,
  type RenderedSheet,
} from "@/lib/sales/master-map/sheet-render";

export const GAPS_TAB = "Gaps";

const COLUMN_COUNT = MASTER_MAP_GAP_COLUMNS.length;

/** Address and provenance are long free text, so they stay left. Everything else centres. */
const CENTRED_COLUMNS = [0, 1, 2, 3, 4, 5, 6, 7];

const COLUMN_WIDTHS = [140, 170, 200, 100, 150, 130, 250, 90, 600, 320];
while (COLUMN_WIDTHS.length < COLUMN_COUNT) COLUMN_WIDTHS.push(MANAGER_COLUMN_WIDTH);

function count(total: number, one: string, many: string): string {
  return `${total.toLocaleString("en-US")} ${total === 1 ? one : many}`;
}

export function renderGapsSheet(
  tree: MasterMapTree,
  distributorName: (code: string) => string,
  sheetId: number,
): RenderedSheet {
  const unnamed = renderUnnamedRows(tree, distributorName);
  const emptyBricks = renderEmptyBrickRows(tree);

  const pad = (cells: readonly string[]): string[] => {
    const out = [...cells];
    while (out.length < COLUMN_COUNT) out.push("");
    return out;
  };

  const values: string[][] = [];
  /** Rows that span the full width and carry a band style, collected as we go. */
  const bands: { row: number; style: (typeof STYLE)[keyof typeof STYLE] }[] = [];
  /** Rows carrying a column header. */
  const headers: number[] = [];

  values.push(pad(["Gaps to fix"]));
  bands.push({ row: 0, style: STYLE.region });

  values.push(
    pad([
      "Neither list is a defect report. A brick can legitimately hold no customers, and a shop can " +
        "legitimately reach us without a name — these are simply the ones worth chasing.",
    ]),
  );
  bands.push({ row: 1, style: STYLE.emptyNote });

  values.push(pad([`Shops with no name on file   ·   ${count(unnamed.length, "shop", "shops")}`]));
  bands.push({ row: values.length - 1, style: STYLE.area });

  headers.push(values.length);
  values.push([...MASTER_MAP_GAP_COLUMNS]);

  if (unnamed.length === 0) {
    values.push(pad(["Every shop in the master has a name. Nothing to chase."]));
    bands.push({ row: values.length - 1, style: STYLE.emptyNote });
  } else {
    for (const row of unnamed) values.push(pad(row));
  }
  const unnamedFirstRow = headers[0] + 1;
  const unnamedLastRow = values.length;

  values.push(pad([]));

  values.push(
    pad([`Bricks with no customers   ·   ${count(emptyBricks.length, "brick", "bricks")}`]),
  );
  bands.push({ row: values.length - 1, style: STYLE.area });

  headers.push(values.length);
  values.push(pad(MASTER_MAP_EMPTY_BRICK_COLUMNS));

  if (emptyBricks.length === 0) {
    values.push(pad(["Every brick in the master holds at least one shop."]));
    bands.push({ row: values.length - 1, style: STYLE.emptyNote });
  } else {
    for (const row of emptyBricks) values.push(pad(row));
  }

  const clearRequests: unknown[] = [
    { unmergeCells: { range: { sheetId } } },
    { updateCells: { fields: "userEnteredValue,userEnteredFormat", range: { sheetId } } },
  ];

  const requests: unknown[] = [
    {
      updateSheetProperties: {
        fields: "gridProperties.hideGridlines",
        properties: { gridProperties: { hideGridlines: true }, sheetId },
      },
    },
    {
      repeatCell: {
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(255, 255, 255),
            horizontalAlignment: "LEFT",
            textFormat: {
              bold: false,
              fontFamily: "Roboto",
              fontSize: 10,
              foregroundColor: rgb(15, 23, 42),
            },
            verticalAlignment: "MIDDLE",
            wrapStrategy: "OVERFLOW_CELL",
          },
        },
        fields:
          "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat,verticalAlignment,wrapStrategy)",
        range: { sheetId },
      },
    },
    {
      updateDimensionProperties: {
        fields: "pixelSize",
        properties: { pixelSize: 21 },
        range: { dimension: "ROWS", endIndex: Math.max(values.length, 1), sheetId, startIndex: 0 },
      },
    },
  ];

  for (const band of bands) {
    requests.push({
      mergeCells: {
        mergeType: "MERGE_ALL",
        range: {
          endColumnIndex: COLUMN_COUNT,
          endRowIndex: band.row + 1,
          sheetId,
          startColumnIndex: 0,
          startRowIndex: band.row,
        },
      },
    });
    requests.push(repeatCellRequest(sheetId, band.row, band.row + 1, band.style));
  }

  for (const header of headers) {
    requests.push(repeatCellRequest(sheetId, header, header + 1, STYLE.columnHeader));
  }

  // The nameless shops carry the same amber they wear on the main tabs, so the two readings of the
  // same shop look like the same thing rather than two unrelated problems.
  if (unnamed.length > 0) {
    requests.push(repeatCellRequest(sheetId, unnamedFirstRow, unnamedLastRow, STYLE.unnamed));
  }

  requests.push({
    updateDimensionProperties: {
      fields: "pixelSize",
      properties: { pixelSize: 38 },
      range: { dimension: "ROWS", endIndex: 1, sheetId, startIndex: 0 },
    },
  });

  for (const column of CENTRED_COLUMNS) {
    requests.push({
      repeatCell: {
        cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
        fields: "userEnteredFormat.horizontalAlignment",
        range: { endColumnIndex: column + 1, sheetId, startColumnIndex: column },
      },
    });
  }

  COLUMN_WIDTHS.forEach((width, column) => {
    requests.push({
      updateDimensionProperties: {
        fields: "pixelSize",
        properties: { pixelSize: width },
        range: { dimension: "COLUMNS", endIndex: column + 1, sheetId, startIndex: column },
      },
    });
  });

  requests.push(renderedTabColor(sheetId, rgb(180, 83, 9)));

  return { clearRequests, requests, values };
}
