import assert from "node:assert/strict";
import {
  MASTER_MAP_FLAT_COLUMNS,
  MASTER_MAP_GAP_COLUMNS,
  MASTER_MAP_MANAGER_LINES,
  MASTER_MAP_PROVENANCE_HEADER,
  areaManagerCells,
  buildMasterMapTree,
  renderFlatRows,
  renderRegionRows,
  renderUnnamedRows,
  type AreaManagerInput,
} from "../src/lib/sales/master-map/tree.ts";
import { renderFlatSheet } from "../src/lib/sales/master-map/sheet-render.ts";
import {
  buildGapsLayout,
  renderGapsLayout,
  renderGapsSheet,
} from "../src/lib/sales/master-map/gaps-tab.ts";

// Every shop in this company has THREE district managers, one per sales line — never one. The owner
// asked which manager each customer belongs to, and the honest answer is three names, so the sheet
// carries three columns rather than picking a line and calling it "the" manager.
//
// Two things here are easy to break and expensive to notice:
//
// 1. The columns must stay at the END of the flat tab. "Find a pharmacy" addresses that tab by
//    column LETTER — region is A, pharmacy is E, address is J — so inserting a column anywhere
//    before those silently re-points the search box and all four dropdowns at the wrong data. It
//    does not error; it just returns wrong shops.
// 2. A manager cell must never be blank. An area with nobody in its seat, an Others bucket that
//    carries sales but has no target, and an area the organogram has never heard of are three
//    different facts, and a blank cell reads as none of them — it reads as "this failed to load".

const distributorName = (code: string) => code;

/**
 * One area per state a real area can be in, matching production on 2026-08-17: 101 area×line rows
 * with a named manager, 6 vacant real districts, 40 Others buckets, and Main Store — the one Source
 * of Sales area the organogram has no row for at all.
 */
function tree(areaManagers: AreaManagerInput[]) {
  return buildMasterMapTree({
    areaManagers,
    areas: [
      { areaCode: "UE1", areaName: "Minia 1", regionCode: "UE" },
      { areaCode: "OTMS", areaName: "Main Store", regionCode: "OT" },
    ],
    bricks: [
      { areaCode: "UE1", brickId: "B-MINIA", brickName: "Minia Centre" },
      { areaCode: "OTMS", brickId: "B-STORE", brickName: "Main Store" },
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
        address: "",
        brickId: "B-STORE",
        customerCode: "1002",
        customerName: "",
        distributorCode: "IS",
        source: "admin-import",
      },
    ],
    regions: [
      { regionCode: "OT", regionName: "Others" },
      { regionCode: "UE", regionName: "Upper Egypt" },
    ],
  });
}

const MANAGERS: AreaManagerInput[] = [
  { areaCode: "UE1", lineName: "Anti Infective", manager: "Nosiba Salah Hussenin Moussa" },
  { areaCode: "UE1", lineName: "CNS", manager: "Vacant" },
  { areaCode: "UE1", lineName: "Pedia", manager: "Sales only, no manager" },
];

export function runMasterMapDistrictManagersTests() {
  // ---- The columns are last, and the finder's letters have not moved -------------------------
  assert.deepEqual(
    MASTER_MAP_FLAT_COLUMNS.slice(-3),
    ["Anti Infective manager", "CNS manager", "Pedia manager"],
    "the manager columns are appended, so every column letter the finder hardcodes still points where it did",
  );
  assert.equal(MASTER_MAP_FLAT_COLUMNS.indexOf("Region"), 0, "Find a pharmacy filters region on column A");
  assert.equal(MASTER_MAP_FLAT_COLUMNS.indexOf("Pharmacy"), 4, "its search box reads pharmacy names from column E");
  assert.equal(MASTER_MAP_FLAT_COLUMNS.indexOf("Address"), 9, "and addresses from column J");
  assert.deepEqual(
    MASTER_MAP_GAP_COLUMNS.slice(-3),
    ["Anti Infective manager", "CNS manager", "Pedia manager"],
    "the gaps tab carries them too — chasing a nameless shop means asking one of these three people",
  );

  // ---- Every state gets words, and no cell is ever blank ---------------------------------------
  const built = tree(MANAGERS);
  const minia = built.regions
    .flatMap((region) => region.areas)
    .find((area) => area.areaCode === "UE1");
  assert.ok(minia, "expected Minia 1");
  assert.deepEqual(
    areaManagerCells(minia),
    ["Nosiba Salah Hussenin Moussa", "Vacant", "Sales only, no manager"],
    "a person, an empty district and an Others bucket are three different facts and each says which it is",
  );

  const mainStore = built.regions
    .flatMap((region) => region.areas)
    .find((area) => area.areaCode === "OTMS");
  assert.ok(mainStore, "expected Main Store");
  assert.deepEqual(
    areaManagerCells(mainStore),
    ["Not in the organogram", "Not in the organogram", "Not in the organogram"],
    "Main Store is the one area the organogram has no row for, and it says so rather than going blank",
  );
  assert.ok(
    areaManagerCells(mainStore).every((cell) => cell.trim().length > 0),
    "a blank manager cell reads as 'this did not load', which is the one thing it must never be able to say",
  );

  // ---- Every shop row carries them, in the header's own order -----------------------------------
  const flat = renderFlatRows(built, distributorName);
  assert.equal(flat.length, 2, "one row per shop, unchanged by the extra columns");
  for (const row of flat) {
    assert.equal(
      row.length,
      MASTER_MAP_FLAT_COLUMNS.length,
      "a row shorter than the header would put a manager under the wrong heading",
    );
  }
  const miniaRow = flat.find((row) => row[6] === "1001");
  assert.deepEqual(
    miniaRow?.slice(-3),
    ["Nosiba Salah Hussenin Moussa", "Vacant", "Sales only, no manager"],
    "the shop's three managers are the three managers of its area, in Anti Infective, CNS, Pedia order",
  );

  // ---- The grey small print lands on provenance, never on a person's name ----------------------
  //
  // This is the exact damage appending these columns did once already. renderFlatSheet painted
  // `header.length - 1` in the quiet provenance style — 8pt, pale grey, italic — and that was
  // "Where this came from" only for as long as it was the last column. With three manager columns
  // after it, the small print moved onto "Pedia manager": a district manager's name rendered as a
  // footnote, while the provenance note it exists to quieten went full size and started competing
  // with the pharmacy name. Nothing errors, nothing looks broken in the code, and the only place
  // it shows is the sheet itself. So the column is found by NAME, and this pins that.
  type StyleRequest = {
    repeatCell?: {
      cell?: {
        userEnteredFormat?: {
          backgroundColor?: { blue?: number; green?: number; red?: number };
          textFormat?: { fontSize?: number };
        };
      };
      range?: { endRowIndex?: number; startColumnIndex?: number; startRowIndex?: number };
    };
  };
  const smallPrint = (renderFlatSheet(MASTER_MAP_FLAT_COLUMNS, flat, 0).requests as StyleRequest[]).filter(
    (request) => request.repeatCell?.cell?.userEnteredFormat?.textFormat?.fontSize === 8,
  );
  assert.equal(smallPrint.length, 1, "exactly one column on the flat tab wears the quiet provenance style");
  assert.equal(
    smallPrint[0]?.repeatCell?.range?.startColumnIndex,
    MASTER_MAP_FLAT_COLUMNS.indexOf(MASTER_MAP_PROVENANCE_HEADER),
    `the 8pt grey italic belongs to "${MASTER_MAP_PROVENANCE_HEADER}" — on any other column it is a manager's name rendered as small print`,
  );

  const unnamed = renderUnnamedRows(built, distributorName);
  assert.equal(unnamed.length, 1, "the nameless Main Store shop reaches the gaps tab");
  assert.equal(
    unnamed[0].length,
    MASTER_MAP_GAP_COLUMNS.length,
    "and its row is as wide as that tab's header",
  );

  // ---- The Gaps tab is built ONCE, and its provenance column is as quiet as everywhere else ----
  //
  // Two things are pinned here. The sync needs the row count before the tab exists and the real tab
  // id afterwards, which it used to satisfy by rendering the entire sheet twice — so the split into
  // buildGapsLayout + renderGapsLayout must stay behaviour-preserving, or the tab silently changes
  // shape. And "Where this came from" must wear the same 8pt grey italic it wears on every other
  // tab: it is applied AFTER the amber unnamed rows, so an innocent-looking reorder undoes it.
  const gapsLayout = buildGapsLayout(built, distributorName);
  const gapsTwoStep = renderGapsLayout(gapsLayout, 77);
  const gapsOneShot = renderGapsSheet(built, distributorName, 77);
  assert.deepEqual(
    gapsTwoStep.values,
    gapsOneShot.values,
    "splitting the render must not change a single cell of the Gaps tab",
  );
  assert.deepEqual(
    gapsTwoStep.requests,
    gapsOneShot.requests,
    "nor a single formatting request — the tab id is the only thing the second half adds",
  );
  assert.equal(
    gapsLayout.values.length,
    gapsOneShot.values.length,
    "the count ensureTab sizes the tab from must equal the rows actually painted into it",
  );

  const gapsSmallPrint = (gapsTwoStep.requests as StyleRequest[]).filter(
    (request) => request.repeatCell?.cell?.userEnteredFormat?.textFormat?.fontSize === 8,
  );
  assert.equal(gapsSmallPrint.length, 1, "exactly one column on the Gaps tab wears the quiet provenance style");
  assert.equal(
    gapsSmallPrint[0]?.repeatCell?.range?.startColumnIndex,
    MASTER_MAP_GAP_COLUMNS.indexOf(MASTER_MAP_PROVENANCE_HEADER),
    `the Gaps tab's 8pt grey italic belongs to "${MASTER_MAP_PROVENANCE_HEADER}" — anywhere else it is a manager's name rendered as a footnote`,
  );

  // Identified by the ROWS it covers, not by its colour: several bands on this tab are warm-toned,
  // and matching on "reddish" found the title band instead — which sits above everything, so the
  // ordering check passed no matter where provenance went. The unnamed style is the one painted
  // across exactly the nameless-shop rows.
  const amberIndex = (gapsTwoStep.requests as StyleRequest[]).findIndex(
    (request) =>
      request.repeatCell?.cell?.userEnteredFormat?.backgroundColor !== undefined &&
      request.repeatCell?.range?.startRowIndex === gapsLayout.unnamedFirstRow &&
      request.repeatCell?.range?.endRowIndex === gapsLayout.unnamedLastRow,
  );
  assert.ok(amberIndex >= 0, "expected the amber band painted across the nameless shop rows");
  assert.ok(
    gapsTwoStep.requests.indexOf(gapsSmallPrint[0]) > amberIndex,
    "provenance is restyled AFTER the amber rows — before them the amber repaints over it and the column goes loud again",
  );

  // ---- The grouped tabs say it once per area, not once per shop ---------------------------------
  const upperEgypt = built.regions.find((region) => region.regionName === "Upper Egypt");
  assert.ok(upperEgypt, "expected Upper Egypt");
  const rows = renderRegionRows(upperEgypt, distributorName);
  const areaIndex = rows.findIndex((row) => row.kind === "area");
  assert.ok(areaIndex >= 0, "expected an area band");
  const band = rows[areaIndex + 1];
  assert.equal(
    band?.kind,
    "managers",
    "the managers sit directly under the area band, where somebody scrolling a brick can still see them",
  );
  assert.ok(
    band.kind === "managers" &&
      MASTER_MAP_MANAGER_LINES.every((line) => band.label.includes(line)) &&
      band.label.includes("Nosiba Salah Hussenin Moussa"),
    "the band names all three lines and their managers in words, because the grouped tabs have no room for three more columns",
  );
  assert.equal(
    rows.filter((row) => row.kind === "managers").length,
    1,
    "once per area — repeating three names on all 951 shop rows of an area is noise, not information",
  );

  // ---- No organogram at all is still a valid sheet ------------------------------------------------
  const bare = tree([]);
  const bareFlat = renderFlatRows(bare, distributorName);
  assert.equal(bareFlat.length, 2, "the workbook still renders every shop when the org chart is unreadable");
  assert.deepEqual(
    bareFlat[0].slice(-3),
    ["Not in the organogram", "Not in the organogram", "Not in the organogram"],
    "and says the managers are unknown rather than failing the load or inventing a name",
  );
}
