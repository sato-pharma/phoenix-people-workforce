import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveLineRegion, type LineArea } from "../src/lib/territory-management/service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Territory Management — the brick search's region label (production defect, found 2026-09-22).
//
// The in-map brick search labelled every hit "<area> · <region> · block <block>", taking the
// region from `source_of_sales_bricks.region_code`. That column has NO line concept and predates
// the September 2026 territory moves, so on production that day 296 active bricks across 26
// line×area pairs were labelled with a region their area is no longer in on the line being looked
// at. Measured against `au_v_line_area_map` (carries_target, open window):
//
//   • Every Delta (3) brick read Delta (1), Delta (2) or Others — D11 Qalubeya (15), D24 Sharkia 1
//     (12), D25 Sharkia 2 (11), OT9 Ismailia (2), OT2 Suez (1) — because D3 exists only on Anti
//     Infective and the column carries one line-agnostic answer.
//   • Every UE-1/UE-2 brick read the coarse "UE" (177 bricks across both split lines).
//   • CNS CA5 "Down town" (38 bricks) read CA where the line operates it as GZ.
//   • CNS D16 Kafr El-Sheikh 1 (11) read D1 where CNS keeps it on Alex-BHR (AB).
//   • Pedia GZ6 Fayoum (6) and UE9 Beni Suef (10) read GZ where Pedia operates them as UE-1.
//
// The column cannot be right, because the answer is not a property of the brick. UE3 Assuit 1 is
// UE-2 on Anti Infective and UE-1 on Pedia; D11 Qalubeya is Delta (3) on Anti Infective and
// Delta (1) on CNS. One stored code has to be wrong for at least one line, every time.
//
// What this file pins:
//   1. The region is the LINE's `operational_region_code`, resolved per line.
//   2. The same brick legitimately reads two different regions on two lines — that is the point,
//      not a contradiction.
//   3. An area the searched line does not carry has NO region on that line: blank, plus the flag.
//      Never a region borrowed from another line or from the pre-move column.
//   4. The resolution is actually WIRED — searchBricks takes a lineCode and stops reading
//      `region_code`, the route requires it, and the search box sends it.
// ─────────────────────────────────────────────────────────────────────────────

/** The live organogram rows for these areas, read from production on 2026-09-22. */
function lineMap(entries: [string, string, string][]): Map<string, LineArea> {
  return new Map(entries.map(([areaCode, areaName, regionCode]) => [areaCode, { areaName, regionCode }]));
}

const ANTI_INFECTIVE = lineMap([
  ["D11", "Qalubeya", "D3"],
  ["D24", "Sharkia 1", "D3"],
  ["OT2", "Suez", "D3"],
  ["UE3", "Assuit 1", "UE-2"],
  ["UE9", "Beni Suef", "UE-1"],
]);

const CNS = lineMap([
  ["CA5", "Down town", "GZ"],
  ["D11", "Qalubeya", "D1"],
  ["D16", "Kafr El-Sheikh 1", "AB"],
  ["UE3", "Assuit 1", "UE"],
]);

const PEDIA = lineMap([
  ["D11", "Qalubeya", "D1"],
  ["D16", "Kafr El-Sheikh 1", "D1"],
  ["GZ6", "Fayoum", "UE-1"],
  ["UE3", "Assuit 1", "UE-1"],
]);

export function runTerritorySearchRegionLabelTests() {
  // 1 · The line's own region, not the brick column's.
  assert.equal(
    resolveLineRegion("D11", ANTI_INFECTIVE).regionCode,
    "D3",
    "Qalubeya's bricks are stamped D1 in source_of_sales_bricks; on Anti Infective the area moved to Delta (3) on 2026-09-01",
  );
  assert.equal(
    resolveLineRegion("D16", CNS).regionCode,
    "AB",
    "CNS keeps Kafr El-Sheikh 1 on Alex-BHR — half-migrated across lines is the CORRECT state, not a defect to align",
  );
  assert.equal(
    resolveLineRegion("GZ6", PEDIA).regionCode,
    "UE-1",
    "Fayoum is Giza on Anti Infective and UE-1 on Pedia — the Upper Egypt split is PEDIA's, and the brick column knows only 'GZ'",
  );
  assert.equal(
    resolveLineRegion("CA5", CNS).regionCode,
    "GZ",
    "CNS operates Down town out of Giza; the brick column's 'CA' is the pre-move label for all 38 of its bricks",
  );

  // 2 · Same brick, two lines, two regions — a single stored code cannot serve both.
  assert.equal(resolveLineRegion("UE3", ANTI_INFECTIVE).regionCode, "UE-2", "Assuit 1 is UE-2 on Anti Infective");
  assert.equal(resolveLineRegion("UE3", PEDIA).regionCode, "UE-1", "Assuit 1 is UE-1 on Pedia — the split's membership DIFFERS by line");
  assert.equal(resolveLineRegion("UE3", CNS).regionCode, "UE", "CNS never split Upper Egypt, so its coarse 'UE' is right there and wrong on the other two");
  assert.notEqual(
    resolveLineRegion("D11", ANTI_INFECTIVE).regionCode,
    resolveLineRegion("D11", CNS).regionCode,
    "Delta (3) is ANTI-INFECTIVE ONLY — one line-agnostic column has to mislabel one of these two lines",
  );

  // 3 · An area the line does not carry has no region ON THAT LINE.
  const offLine = resolveLineRegion("CA5", PEDIA);
  assert.equal(offLine.onSelectedLine, false, "Down town is a CNS area; Pedia does not carry it");
  assert.equal(offLine.regionCode, "", "blank, never a region borrowed from CNS or from the pre-move brick column");
  assert.equal(offLine.areaName, null, "the line map has no name for it either — the caller falls back to the SoS area name");
  assert.equal(
    resolveLineRegion("D24", PEDIA).onSelectedLine,
    false,
    "Sharkia 1 sits on Anti Infective's Delta (3); searching Pedia must say so rather than print D3",
  );
  assert.equal(resolveLineRegion("D11", PEDIA).onSelectedLine, true, "Qalubeya IS carried on Pedia — only its region differs");

  // 4 · Wiring. A pure resolver nothing calls would leave the defect on screen.
  const service = readFileSync(new URL("../src/lib/territory-management/service.ts", import.meta.url), "utf8");
  const search = service.slice(service.indexOf("export async function searchBricks"), service.indexOf("Write a hand-placed pin"));
  assert.ok(search.length > 0, "searchBricks still exists in the service");
  assert.ok(
    /lineCode: string;/.test(search) && search.includes("loadLineAreaRows(lineCode)"),
    "searchBricks takes a lineCode and resolves its areas from the organogram's line map",
  );
  assert.ok(search.includes("resolveLineRegion(areaCode, lineAreas)"), "each hit's region goes through the per-line resolver");
  assert.ok(
    !/\.select\([^)]*\bregion_code\b/.test(search) && !/\brow\.region_code\b/.test(search),
    "searchBricks no longer selects or reads source_of_sales_bricks.region_code — that column is the defect",
  );
  assert.ok(
    !/\brow\.region_code\b/.test(service),
    "nothing in the territory service reads the line-agnostic brick region column any more, including the map payload",
  );

  const route = readFileSync(new URL("../app/api/territory-management/search/route.ts", import.meta.url), "utf8");
  assert.ok(
    route.includes("lineCode is required"),
    "the search route REQUIRES a line — defaulting to one would quietly label every brick against whichever came first",
  );
  assert.ok(route.includes("searchBricks({ access, lineCode, query })"), "the route forwards both the line and the caller's own scope");

  const workspace = readFileSync(
    new URL("../src/components/territory-management/territory-map-workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    workspace.includes("&lineCode=${encodeURIComponent(lineCode)}"),
    "the search box sends the line it is showing, so switching lines relabels the hits",
  );
  assert.ok(
    workspace.includes("hit.onSelectedLine ? hit.regionName :"),
    "a hit whose area the line does not carry renders the honest note instead of a region",
  );
}
