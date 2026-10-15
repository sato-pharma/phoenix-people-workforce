// Master Map — preview the tree, and optionally paint one region into the live sheet.
//
//   pnpm run master-map:preview                     -> statistics only, touches nothing
//   pnpm run master-map:preview -- --region OT --push -> paints that one region into the sheet
//
// Read-only against Supabase in every mode. The --push mode writes to Google, and only ever to
// the single tab named after the region, so it can be run against the real sheet safely while
// the layout is still being agreed.

import { buildMasterMapTree, renderRegionRows, shopOwningRegions } from "@/lib/sales/master-map/tree";
import { loadMasterMapSource } from "@/lib/sales/master-map/load";
import { renderSheet } from "@/lib/sales/master-map/sheet-render";
import { syncMasterMap } from "@/lib/sales/master-map/sync";
import {
  batchUpdate,
  environmentTokenProvider,
  getSpreadsheet,
  writeValues,
} from "@/lib/sales/master-map/sheets-client";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "master-map-preview",
  entry: import.meta.url,
  known: ["--all", "--push", "--region"],
});

const SPREADSHEET_ID =
  process.env.MASTER_MAP_SPREADSHEET_ID ?? "1za3G8C6HCi74qmq4PwP_T7d-rM16UU1XivqEV7A48Hg";

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const started = Date.now();
  const source = await loadMasterMapSource();
  const tree = buildMasterMapTree(source);

  // Every total counts the regions that OWN their shops. The organogram views (Upper Egypt 1 and
  // Upper Egypt 2) hold the same pharmacies as Upper Egypt and Giza, so including them here would
  // report a master bigger than the one that exists.
  const owning = shopOwningRegions(tree);
  const totalCustomers = owning.reduce((sum, region) => sum + region.customerCount, 0);
  const totalBricks = owning.reduce(
    (sum, region) => sum + region.areas.reduce((areaSum, area) => areaSum + area.bricks.length, 0),
    0,
  );
  const emptyBricks = owning.reduce(
    (sum, region) =>
      sum +
      region.areas.reduce(
        (areaSum, area) => areaSum + area.bricks.filter((brick) => brick.customers.length === 0).length,
        0,
      ),
    0,
  );
  const unnamed = owning.reduce(
    (sum, region) =>
      sum +
      region.areas.reduce(
        (areaSum, area) =>
          areaSum +
          area.bricks.reduce(
            (brickSum, brick) => brickSum + brick.customers.filter((c) => !c.hasName).length,
            0,
          ),
        0,
      ),
    0,
  );

  console.log("=== Master Map ===");
  console.log(`source customer rows : ${source.customers.length}`);
  console.log(`rows after merge     : ${totalCustomers}`);
  console.log(`rows saved by merge  : ${source.customers.length - totalCustomers}`);
  console.log(`regions              : ${tree.regions.length}`);
  console.log(`bricks               : ${totalBricks}  (${emptyBricks} with no customers)`);
  console.log(`unnamed customers    : ${unnamed}`);
  console.log(`orphaned customers   : ${tree.orphanedCustomers.length}`);
  console.log(`loaded in            : ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log("");
  for (const region of tree.regions) {
    console.log(
      `  ${region.regionName.padEnd(16)} ${String(region.areas.length).padStart(3)} areas  ` +
        `${String(region.areas.reduce((s, a) => s + a.bricks.length, 0)).padStart(4)} bricks  ` +
        `${String(region.customerCount).padStart(6)} customers` +
        (region.fromOrganogram
          ? `   <- organogram view of ${region.sitsIn.join(" + ")}, not counted in the totals above`
          : ""),
    );
  }

  if (process.argv.includes("--all")) {
    console.log("\nsyncing the whole workbook...");
    const result = await syncMasterMap({
      onProgress: (message) => console.log(`  ${message}`),
      spreadsheetId: SPREADSHEET_ID,
    });
    console.log(`\n${result.tabs.length} tabs written in ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
    return;
  }

  const wanted = argValue("region");
  if (!process.argv.includes("--push") || !wanted) {
    console.log("\n(no --region <code> --push and no --all given, nothing was written)");
    return;
  }

  const region = tree.regions.find(
    (candidate) => candidate.regionCode.toUpperCase() === wanted.toUpperCase(),
  );
  if (!region) throw new Error(`No such region: ${wanted}`);

  const distributorName = (code: string) => source.distributorNames.get(code) ?? code;
  const rows = renderRegionRows(region, distributorName);
  console.log(`\nrendering "${region.regionName}" -> ${rows.length} sheet rows`);

  const token = await environmentTokenProvider()();
  const book = await getSpreadsheet(token, SPREADSHEET_ID);
  console.log(`spreadsheet: ${book.title}`);

  let tab = book.tabs.find((candidate) => candidate.title === region.regionName);
  if (!tab) {
    await batchUpdate(token, SPREADSHEET_ID, [
      { addSheet: { properties: { title: region.regionName } } },
    ]);
    const refreshed = await getSpreadsheet(token, SPREADSHEET_ID);
    tab = refreshed.tabs.find((candidate) => candidate.title === region.regionName);
    if (!tab) throw new Error(`Could not create tab ${region.regionName}`);
    console.log(`created tab "${tab.title}" (id ${tab.sheetId})`);
  } else {
    console.log(`reusing tab "${tab.title}" (id ${tab.sheetId})`);
  }

  // Make sure the grid is tall enough before writing into it.
  await batchUpdate(token, SPREADSHEET_ID, [
    {
      updateSheetProperties: {
        fields: "gridProperties(rowCount,columnCount)",
        properties: {
          gridProperties: { columnCount: 12, rowCount: Math.max(rows.length + 10, 1000) },
          sheetId: tab.sheetId,
        },
      },
    },
  ]);

  const { clearRequests, requests, values } = renderSheet(rows, tab.sheetId);
  // Clear, then text, then formatting — so a run interrupted halfway leaves correct but unstyled
  // rows rather than an empty tab.
  await batchUpdate(token, SPREADSHEET_ID, clearRequests);
  await writeValues(token, SPREADSHEET_ID, tab.title, values);
  await batchUpdate(token, SPREADSHEET_ID, requests);

  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=${tab.sheetId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
