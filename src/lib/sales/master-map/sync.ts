// Master Map — the whole-workbook sync.
//
// One entry point, called by the hourly job, by the "Sync now" button, and by the preview script.
// It is deliberately idempotent: every tab is rebuilt from scratch on every run, so a sync that
// died halfway leaves nothing to reconcile — the next run simply repaints everything.
//
// TAB LAYOUT (the owner's, 2026-08-17):
//   Master          every region, one after another, grouped and banded
//   All customers   one flat unmerged row per shop, frozen header, filterable
//   <region>        one grouped tab per region, 9 of them
//
// Google allows 60 write requests per minute per user and a full sync sits close to that, so the
// client retries 429s rather than failing. That is why this can take a couple of minutes.

import {
  MASTER_MAP_FLAT_COLUMNS,
  MASTER_MAP_GAP_COLUMNS,
  buildMasterMapTree,
  renderFlatRows,
  renderMasterRows,
  renderRegionRows,
  type MasterMapTree,
} from "@/lib/sales/master-map/tree";
import { loadMasterMapSource } from "@/lib/sales/master-map/load";
import { GAPS_TAB, renderGapsSheet } from "@/lib/sales/master-map/gaps-tab";
import {
  LISTS_COLUMN_COUNT,
  LISTS_TAB,
  LOOKUP_TAB,
  renderListsSheet,
  renderLookupSheet,
} from "@/lib/sales/master-map/lookup-tab";
import {
  renderFlatSheet,
  renderSheet,
  rgb,
  tabColorFor,
} from "@/lib/sales/master-map/sheet-render";
import {
  batchUpdate,
  environmentTokenProvider,
  getSpreadsheet,
  writeValues,
  type GoogleTokenProvider,
} from "@/lib/sales/master-map/sheets-client";

export const MASTER_TAB = "Master";
export const FLAT_TAB = "All customers";

export type MasterMapSyncResult = {
  customers: number;
  durationMs: number;
  regions: number;
  sourceRows: number;
  tabs: string[];
  unnamedCustomers: number;
};

type Progress = (message: string) => void;

/**
 * Make sure a tab exists and is big enough, and return its numeric id.
 * Titles are not stable identifiers in the Sheets API — every range is addressed by sheetId.
 */
async function ensureTab(
  token: string,
  spreadsheetId: string,
  title: string,
  rowsNeeded: number,
  columnsNeeded: number,
): Promise<number> {
  const book = await getSpreadsheet(token, spreadsheetId);
  let tab = book.tabs.find((candidate) => candidate.title === title);

  if (!tab) {
    await batchUpdate(token, spreadsheetId, [{ addSheet: { properties: { title } } }]);
    const refreshed = await getSpreadsheet(token, spreadsheetId);
    tab = refreshed.tabs.find((candidate) => candidate.title === title);
    if (!tab) throw new Error(`Could not create tab "${title}"`);
  }

  // Grow the grid BEFORE writing. A values write past the last row is rejected outright, and a
  // formatting range past it is silently clipped — which looks like the formatting "didn't work".
  await batchUpdate(token, spreadsheetId, [
    {
      updateSheetProperties: {
        fields: "gridProperties(rowCount,columnCount)",
        properties: {
          gridProperties: {
            columnCount: Math.max(columnsNeeded, 12),
            rowCount: Math.max(rowsNeeded + 20, 1000),
          },
          sheetId: tab.sheetId,
        },
      },
    },
  ]);

  return tab.sheetId;
}

async function paint(
  token: string,
  spreadsheetId: string,
  title: string,
  rendered: { clearRequests: unknown[]; requests: unknown[]; values: string[][] },
): Promise<void> {
  // Clear, then text, then formatting — in that order, and not the obvious one.
  //
  // Each step is a state the owner can open the sheet and see. Clearing and formatting before
  // writing the text leaves a beautifully banded EMPTY tab for the length of the write, which
  // reads as data loss. This way the worst visible state is correct text that has not been
  // styled yet. Merges land after the values, which is fine: a band row only carries text in its
  // first column, and MERGE_ALL keeps the top-left cell.
  await batchUpdate(token, spreadsheetId, rendered.clearRequests);
  await writeValues(token, spreadsheetId, title, rendered.values);
  await batchUpdate(token, spreadsheetId, rendered.requests);
}

/**
 * Put the tabs back in reading order and drop Google's empty default sheet.
 *
 * A tab created mid-sync lands at the end of the workbook, so without this the order drifts every
 * time a new region appears. Only a tab this sync actually wrote is moved — anything the owner
 * added by hand keeps its place after them, and is never deleted.
 */
async function orderTabs(
  token: string,
  spreadsheetId: string,
  order: readonly string[],
): Promise<void> {
  const book = await getSpreadsheet(token, spreadsheetId);
  const byTitle = new Map(book.tabs.map((tab) => [tab.title, tab]));
  const requests: unknown[] = [];

  // "Sheet1" is what Google puts in a new spreadsheet. Remove it only while it is untouched and
  // some real tab exists — never delete the last sheet, and never delete one holding data.
  const blank = byTitle.get("Sheet1");
  if (blank && book.tabs.length > order.length) {
    requests.push({ deleteSheet: { sheetId: blank.sheetId } });
  }

  order.forEach((title, index) => {
    const tab = byTitle.get(title);
    if (tab) {
      requests.push({
        updateSheetProperties: { fields: "index", properties: { index, sheetId: tab.sheetId } },
      });
    }
  });

  if (requests.length > 0) await batchUpdate(token, spreadsheetId, requests);
}

export function summariseTree(tree: MasterMapTree): {
  customers: number;
  regions: number;
  unnamedCustomers: number;
} {
  let customers = 0;
  let unnamedCustomers = 0;
  // Organogram regions hold the SAME shops as the region they sit in, so counting them here would
  // report thousands of pharmacies that do not exist.
  for (const region of tree.regions.filter((candidate) => !candidate.fromOrganogram)) {
    for (const area of region.areas) {
      for (const brick of area.bricks) {
        customers += brick.customers.length;
        unnamedCustomers += brick.customers.filter((customer) => !customer.hasName).length;
      }
    }
  }
  return { customers, regions: tree.regions.length, unnamedCustomers };
}

export async function syncMasterMap(options: {
  onProgress?: Progress;
  spreadsheetId: string;
  tokenProvider?: GoogleTokenProvider;
}): Promise<MasterMapSyncResult> {
  const started = Date.now();
  const report: Progress = options.onProgress ?? (() => {});

  const source = await loadMasterMapSource();
  const tree = buildMasterMapTree(source);
  const distributorName = (code: string) => source.distributorNames.get(code) ?? code;
  const summary = summariseTree(tree);
  report(`loaded ${source.customers.length} rows -> ${summary.customers} shops`);

  const token = await (options.tokenProvider ?? environmentTokenProvider())();
  const written: string[] = [];

  // 1. The master tab — every region in one place.
  const masterRows = renderMasterRows(tree, distributorName);
  const masterId = await ensureTab(token, options.spreadsheetId, MASTER_TAB, masterRows.length, 12);
  await paint(
    token,
    options.spreadsheetId,
    MASTER_TAB,
    renderSheet(masterRows, masterId, { tabColor: rgb(15, 23, 42) }),
  );
  written.push(MASTER_TAB);
  report(`${MASTER_TAB}: ${masterRows.length} rows`);

  // 2. The flat lookup tab.
  const flatRows = renderFlatRows(tree, distributorName);
  const flatId = await ensureTab(
    token,
    options.spreadsheetId,
    FLAT_TAB,
    flatRows.length + 1,
    MASTER_MAP_FLAT_COLUMNS.length,
  );
  await paint(
    token,
    options.spreadsheetId,
    FLAT_TAB,
    renderFlatSheet(MASTER_MAP_FLAT_COLUMNS, flatRows, flatId, { tabColor: rgb(71, 85, 105) }),
  );
  written.push(FLAT_TAB);
  report(`${FLAT_TAB}: ${flatRows.length} rows`);

  // 2b. The gaps: nameless shops and empty bricks, as a working list rather than scattered across
  // the main tabs where nobody can act on them.
  const gaps = renderGapsSheet(tree, distributorName, 0);
  const gapsId = await ensureTab(
    token,
    options.spreadsheetId,
    GAPS_TAB,
    gaps.values.length,
    MASTER_MAP_GAP_COLUMNS.length,
  );
  await paint(
    token,
    options.spreadsheetId,
    GAPS_TAB,
    renderGapsSheet(tree, distributorName, gapsId),
  );
  written.push(GAPS_TAB);
  report(`${GAPS_TAB}: ${gaps.values.length} rows`);

  // 3. One tab per region — including the two empty ones, which say so rather than not existing.
  for (const region of tree.regions) {
    const rows = renderRegionRows(region, distributorName);
    const sheetId = await ensureTab(token, options.spreadsheetId, region.regionName, rows.length, 12);
    await paint(
      token,
      options.spreadsheetId,
      region.regionName,
      renderSheet(rows, sheetId, { tabColor: tabColorFor(region.regionName) }),
    );
    written.push(region.regionName);
    report(`${region.regionName}: ${rows.length} rows`);
  }

  // 4. The two control tabs, in this order and last on purpose: both are formulas over
  // "All customers", so neither can resolve until that tab exists and is full.
  const listsId = await ensureTab(token, options.spreadsheetId, LISTS_TAB, 1, LISTS_COLUMN_COUNT);
  await paint(token, options.spreadsheetId, LISTS_TAB, renderListsSheet(listsId));
  report(`${LISTS_TAB}: hidden helper`);

  // As wide as "All customers": this tab repeats that header, and a values write past the last
  // column is rejected outright rather than clipped.
  const lookupId = await ensureTab(
    token,
    options.spreadsheetId,
    LOOKUP_TAB,
    600,
    MASTER_MAP_FLAT_COLUMNS.length,
  );
  await paint(token, options.spreadsheetId, LOOKUP_TAB, renderLookupSheet(lookupId));
  report(`${LOOKUP_TAB}: ready`);

  // 5. Reading order: the finder first, then Master, the flat lookup, the regions, and the hidden
  // helper last. Written order and reading order differ, which is why this step exists.
  await orderTabs(token, options.spreadsheetId, [
    LOOKUP_TAB,
    ...written,
    LISTS_TAB,
  ]);
  written.unshift(LOOKUP_TAB);
  written.push(LISTS_TAB);

  return {
    customers: summary.customers,
    durationMs: Date.now() - started,
    regions: summary.regions,
    sourceRows: source.customers.length,
    tabs: written,
    unnamedCustomers: summary.unnamedCustomers,
  };
}
