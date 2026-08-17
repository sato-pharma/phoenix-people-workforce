import assert from "node:assert/strict";
import {
  MASTER_MAP_FLAT_COLUMNS,
  MASTER_MAP_GAP_COLUMNS,
  MASTER_MAP_MANAGER_LINES,
  areaManagerCells,
  buildMasterMapTree,
  renderFlatRows,
  renderRegionRows,
  renderUnnamedRows,
  type AreaManagerInput,
} from "../src/lib/sales/master-map/tree.ts";

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

  const unnamed = renderUnnamedRows(built, distributorName);
  assert.equal(unnamed.length, 1, "the nameless Main Store shop reaches the gaps tab");
  assert.equal(
    unnamed[0].length,
    MASTER_MAP_GAP_COLUMNS.length,
    "and its row is as wide as that tab's header",
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
