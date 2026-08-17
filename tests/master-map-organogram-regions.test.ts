import assert from "node:assert/strict";
import {
  buildMasterMapTree,
  renderFlatRows,
  renderMasterRows,
  renderRegionRows,
  renderUnnamedRows,
  shopOwningRegions,
  type OrganogramAreaInput,
} from "../src/lib/sales/master-map/tree.ts";

// Two of the nine Source of Sales regions own no areas at all: Upper Egypt 1 and Upper Egypt 2 are
// the Anti Infective line's two district territories, and they exist only in the People Organogram.
// The Master Map fills them from au_v_line_area_map — which means the SAME pharmacy is now reachable
// from two tabs.
//
// That is the whole risk this file exists to pin. The shops must appear on those tabs and must NOT
// be counted a second time by the master tab, the flat tab, the gaps tab or the finder. Production
// has 50,622 shops; a tree that walked every region would report roughly 4,300 of them twice, and
// nothing on the sheet would say so.

const distributorName = (code: string) => code;

function shop(brickId: string, code: string, name: string) {
  return {
    address: "",
    brickId,
    customerCode: code,
    customerName: name,
    distributorCode: "IS",
    source: "admin-import",
  };
}

/** The real shape, reduced: Minia 1 sits in Upper Egypt, Beni Suef in Giza, both run by UE-1. */
function productionShaped(organogramAreas: OrganogramAreaInput[]) {
  return buildMasterMapTree({
    areas: [
      { areaCode: "UE1", areaName: "Minia 1", regionCode: "UE" },
      { areaCode: "UE9", areaName: "Beni Suef", regionCode: "GZ" },
    ],
    bricks: [
      { areaCode: "UE1", brickId: "B-MINIA", brickName: "Minia Centre" },
      { areaCode: "UE9", brickId: "B-BENI", brickName: "Beni Suef Centre" },
    ],
    customers: [
      shop("B-MINIA", "1001", "صيدلية النور"),
      shop("B-BENI", "1002", "صيدلية الأمل"),
      shop("B-BENI", "1003", ""),
    ],
    organogramAreas,
    regions: [
      { regionCode: "GZ", regionName: "Giza" },
      { regionCode: "UE", regionName: "Upper Egypt" },
      { regionCode: "UE-1", regionName: "Upper Egypt 1" },
    ],
  });
}

const ANTI_INFECTIVE: OrganogramAreaInput[] = [
  { areaCode: "UE1", lineName: "Anti Infective", regionCode: "UE-1" },
  { areaCode: "UE9", lineName: "Anti Infective", regionCode: "UE-1" },
  // CNS runs Minia 1 under plain Upper Egypt. A region that already has its own areas must ignore
  // this entirely — otherwise the overlay would start second-guessing real geography.
  { areaCode: "UE1", lineName: "CNS", regionCode: "UE" },
];

export function runMasterMapOrganogramRegionsTests() {
  const tree = productionShaped(ANTI_INFECTIVE);
  const region = (name: string) => {
    const found = tree.regions.find((candidate) => candidate.regionName === name);
    assert.ok(found, `expected a region called ${name}`);
    return found;
  };

  // ---- The overlay fills a region that has no geography of its own --------------------------
  const upperEgyptOne = region("Upper Egypt 1");
  assert.equal(
    upperEgyptOne.fromOrganogram,
    true,
    "a region with no areas in the area master is marked as an organogram view, which is what excludes it from every total",
  );
  assert.deepEqual(
    upperEgyptOne.areas.map((area) => area.areaName),
    ["Beni Suef", "Minia 1"],
    "the district's areas come from the organogram and are sorted by name like every other region",
  );
  assert.equal(upperEgyptOne.customerCount, 3, "the district reports the shops in its borrowed areas");
  assert.deepEqual(
    upperEgyptOne.organogramLines,
    ["Anti Infective"],
    "the line is carried through so the tab can name it instead of showing a line code",
  );
  assert.deepEqual(
    upperEgyptOne.sitsIn,
    ["Giza", "Upper Egypt"],
    "the note has to name every region these shops physically belong to — Beni Suef is a Giza area run by an Upper Egypt district",
  );

  // ---- A region with real geography is never overlaid ----------------------------------------
  const upperEgypt = region("Upper Egypt");
  assert.equal(
    upperEgypt.fromOrganogram,
    false,
    "Upper Egypt keeps its own areas; the overlay answers 'this region has none', not 'let me re-file this one'",
  );
  assert.deepEqual(
    upperEgypt.areas.map((area) => area.areaName),
    ["Minia 1"],
    "the CNS organogram row for Minia 1 must not add or move anything on a region that already has areas",
  );

  // ---- THE HEADLINE: no shop is counted twice ------------------------------------------------
  const flat = renderFlatRows(tree, distributorName);
  assert.equal(
    flat.length,
    3,
    "the flat tab holds one row per shop — walking the organogram regions too would list Beni Suef's shops under both Giza and Upper Egypt 1",
  );
  assert.deepEqual(
    [...new Set(flat.map((row) => row[0]))].sort(),
    ["Giza", "Upper Egypt"],
    "only the regions that own their shops reach the flat tab, so the finder's counts stay true",
  );
  assert.deepEqual(
    shopOwningRegions(tree).map((candidate) => candidate.regionName),
    ["Giza", "Upper Egypt"],
    "shopOwningRegions is the one gate every total goes through",
  );

  const master = renderMasterRows(tree, distributorName);
  assert.ok(
    !master.some((row) => "label" in row && row.label.startsWith("Upper Egypt 1")),
    "the master tab must not repeat the district, or the same pharmacy appears twice inside one tab",
  );
  assert.equal(
    renderUnnamedRows(tree, distributorName).length,
    1,
    "the one nameless shop is listed once on the gaps tab, not once per tab that can reach it",
  );

  // ---- The tab says what it is ----------------------------------------------------------------
  const rows = renderRegionRows(upperEgyptOne, distributorName);
  const note = rows[1];
  assert.ok(note && note.kind === "empty-note", "the explanation sits directly under the region band");
  assert.ok(
    note.kind === "empty-note" &&
      note.label.includes("Anti Infective") &&
      note.label.includes("Giza and Upper Egypt"),
    "the note names the line and both home regions in words, so nobody adds this tab's total to a national figure",
  );

  // ---- An area the organogram claims and the master lacks is REPORTED -------------------------
  const withGhost = productionShaped([
    ...ANTI_INFECTIVE,
    { areaCode: "UE99", lineName: "Anti Infective", regionCode: "UE-1" },
  ]);
  const ghosted = withGhost.regions.find((candidate) => candidate.regionName === "Upper Egypt 1");
  assert.deepEqual(
    ghosted?.missingAreaCodes,
    ["UE99"],
    "an organogram area the area master has never heard of is surfaced, never silently skipped",
  );
  assert.ok(
    renderRegionRows(ghosted!, distributorName).some(
      (row) => "label" in row && row.label.includes("UE99"),
    ),
    "and it is printed on the tab, so a broken link between the two masters reads as a broken link",
  );

  // ---- No organogram at all is a valid sheet ---------------------------------------------------
  const bare = productionShaped([]);
  const bareDistrict = bare.regions.find((candidate) => candidate.regionName === "Upper Egypt 1");
  assert.equal(
    bareDistrict?.fromOrganogram,
    false,
    "with the org chart unreadable the district renders as the empty region it is, rather than failing the workbook",
  );
  assert.equal(
    renderFlatRows(bare, distributorName).length,
    3,
    "and the rest of the master is completely unaffected by the overlay being absent",
  );
}
