import assert from "node:assert/strict";
import {
  LISTS_COLUMN_COUNT,
  listsRowCount,
  renderListsSheet,
} from "../src/lib/sales/master-map/lookup-tab.ts";
import {
  buildMasterMapTree,
  flatShopCount,
  renderFlatRows,
} from "../src/lib/sales/master-map/tree.ts";

// "Find a pharmacy" is the tab the owner actually works in, and it died silently once already.
//
// The finder is a FILTER that spills one row per shop into the hidden Lists tab from F2, and both
// the count and the visible rows read that spill. A spill with nowhere to go does not truncate —
// it fails the whole tab: Lists!F2 becomes #REF!, the results table is empty, and the status line
// reads "Showing 1 of 1 matching shops", because COUNTA counts the single error cell as a match.
//
// The grid height was a fixed 55,000, chosen when the master held 50,622 shops. Measured live on
// 2026-09-09 the master held 63,510 and the finder had been returning nothing — with every other
// tab on the workbook correct and current, which is why nobody could see it from the data.
//
// Two properties keep that from recurring, and this file pins both:
//
//   1. The height is DERIVED from the shop count, never typed.
//   2. The shop count is IN THE TAB'S TEXT — the plan hashes each tab's text, so the hash moves
//      when the master grows, the tab repaints, and the height is recomputed. Without that the
//      height would change only when LAYOUT_VERSION does, which is the original bug.

/** The state of production on 2026-09-09, and the size the fixed constant could not hold. */
const SHOPS_TODAY = 63_510;
const THE_OLD_FIXED_HEIGHT = 55_000;

/** Just enough of a Sheets API request to read the grid a tab claims for itself. */
type GridClaim = {
  updateSheetProperties?: {
    properties?: { gridProperties?: { columnCount?: number; rowCount?: number } };
  };
};

function gridClaim(sheet: { requests: unknown[] }): { columnCount?: number; rowCount?: number } {
  for (const request of sheet.requests as GridClaim[]) {
    const grid = request?.updateSheetProperties?.properties?.gridProperties;
    if (grid) return grid;
  }
  throw new Error("the Lists tab claimed no grid at all");
}

function listsGridRowCount(shopCount: number): number {
  const rowCount = gridClaim(renderListsSheet(1, shopCount)).rowCount;
  if (typeof rowCount !== "number") throw new Error("the Lists tab claimed no grid height at all");
  return rowCount;
}

export function runMasterMapFinderGridTests() {
  // ---- The grid always outgrows the spill -------------------------------------------------------
  // +1 because the spill starts at row 2, under the header text in A1.
  for (const shops of [0, 1, 10_000, 50_622, SHOPS_TODAY, 90_000, 250_000]) {
    assert.ok(
      listsRowCount(shops) >= shops + 1,
      `a ${shops}-shop master needs at least ${shops + 1} rows; the spill fails the whole tab rather than clipping`,
    );
  }

  assert.ok(
    listsRowCount(SHOPS_TODAY) > THE_OLD_FIXED_HEIGHT,
    "the fixed 55,000 is what broke the finder in production — a derived height must clear it",
  );
  assert.ok(
    listsRowCount(THE_OLD_FIXED_HEIGHT) > THE_OLD_FIXED_HEIGHT,
    "and it must clear it at exactly the size that first overflowed it, not merely somewhere above",
  );

  // Headroom, because the grid can only grow when the tab repaints.
  assert.ok(
    listsRowCount(SHOPS_TODAY) >= Math.ceil(SHOPS_TODAY * 1.2),
    "a grid sized to the exact shop count would overflow again on the next pharmacy added",
  );

  // Never shrink below the floor: a small or half-loaded master must not paint a tiny grid that
  // the next real load then overflows.
  assert.equal(listsRowCount(0), 60_000, "an empty master still claims the floor");
  let previous = 0;
  for (const shops of [0, 1_000, 60_000, SHOPS_TODAY, 120_000]) {
    const height = listsRowCount(shops);
    assert.ok(height >= previous, "the height never goes down as the master grows");
    previous = height;
  }

  // ---- The rendered tab uses that height, and says what it was sized for ------------------------
  assert.equal(
    listsGridRowCount(SHOPS_TODAY),
    listsRowCount(SHOPS_TODAY),
    "the request pass has to claim the derived height — ensureTab only ever asks for 1,000 rows",
  );
  assert.notEqual(
    listsGridRowCount(SHOPS_TODAY),
    listsGridRowCount(SHOPS_TODAY * 2),
    "the height has to move with the master, or it is a constant wearing a function's clothes",
  );

  const rendered = renderListsSheet(1, SHOPS_TODAY);
  assert.ok(
    rendered.values[0][0].includes("63,510"),
    "the tab's TEXT names the shop count — that is what moves its content hash and triggers the repaint that resizes the grid",
  );
  assert.notEqual(
    renderListsSheet(1, SHOPS_TODAY).values[0][0],
    renderListsSheet(1, SHOPS_TODAY + 1).values[0][0],
    "one more shop must change the text, or the plan hashes the two states identically and the grid never grows",
  );
  assert.ok(
    rendered.values[0][0].startsWith("Master Map helper — do not edit."),
    "it is still the do-not-edit banner a person opening the hidden tab needs to read first",
  );

  // The width is the other half of the same failure: a grid one column short of the spill fails
  // the tab exactly as a short grid does.
  assert.equal(
    gridClaim(rendered).columnCount,
    LISTS_COLUMN_COUNT,
    "four dropdown columns plus one full width of the flat tab, derived rather than typed",
  );

  // ---- The count is the same population the spill holds -----------------------------------------
  const tree = buildMasterMapTree({
    areaManagers: [],
    areas: [
      { areaCode: "UE1", areaName: "Minia 1", regionCode: "UE" },
      { areaCode: "OT2", areaName: "Others bucket", regionCode: "OT" },
    ],
    bricks: [
      { areaCode: "UE1", brickId: "B-MINIA", brickName: "Minia Centre" },
      { areaCode: "OT2", brickId: "B-OTHER", brickName: "Other brick" },
    ],
    customers: [
      {
        address: "12 Corniche",
        brickId: "B-MINIA",
        customerCode: "1001",
        customerName: "صيدلية النور",
        distributorCode: "IS",
        source: "admin-import",
      },
      {
        address: "9 Nile St",
        brickId: "B-OTHER",
        customerCode: "1002",
        customerName: "صيدلية الشفاء",
        distributorCode: "IS",
        source: "admin-import",
      },
    ],
    regions: [
      { regionCode: "OT", regionName: "Others" },
      { regionCode: "UE", regionName: "Upper Egypt" },
    ],
  });

  assert.equal(
    flatShopCount(tree),
    renderFlatRows(tree, (code) => code).length,
    "the grid is sized from a count taken WITHOUT building the rows, so it has to agree with the rows exactly — an organogram view counted in would oversize harmlessly, one left out would overflow",
  );
}
