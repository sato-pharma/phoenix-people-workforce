import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { visibleLineAreas, type TerritoryScope } from "../src/lib/territory-management/service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Territory Management — the brick search is scoped to the caller's own areas
// (owner instruction, 2026-09-22: "scope the brick search to the caller's own areas").
//
// The in-map search box ran one query: every ACTIVE brick in the country, matched on name or id,
// with no line, region or area narrowing at all — and the box is not gated on pin-editing, so
// every role holding `territory:read` had it. A District Manager could type two letters and read
// back the name, area, block and exact coordinate of bricks in regions he does not manage. Every
// other read in this module is scoped: `loadTerritoryFilters` narrows the picker, `loadTerritoryMap`
// re-checks each requested area against both the line map and the caller's own scope. The search
// was the one hole, and it was the easiest surface in the module to reach.
//
// The fix is a SHARED definition rather than a second copy of the narrowing: `visibleLineAreas`
// now answers "which areas of this line may this caller see", and BOTH the area picker and the
// search are built from it. The search is bounded by `.in("area_code", [...])` over exactly that
// set, so a hit is always somewhere the caller could have navigated to anyway — and a caller with
// nothing on the line gets nothing rather than the whole country.
//
// What this file pins:
//   1. A seat-bound caller (District Manager) sees only his own areas.
//   2. A region-bound caller (Regional Manager) sees only his own region's areas.
//   3. A company-wide caller (CEO / SFE Manager / Super Admin) still sees the whole line.
//   4. The "Others" holding bucket is never searchable, at any scope.
//   5. Area codes are compared case-insensitively, so a lower-cased code cannot slip the bound.
//   6. The search is actually BOUNDED by that set, and fails CLOSED on an empty one.
//   7. The picker, the search and the map's findings share the one definition — no second copy to drift.
// ─────────────────────────────────────────────────────────────────────────────

/** Anti Infective's live rows for these areas, read from production on 2026-09-22. */
const ANTI_INFECTIVE_ROWS = [
  { area_code: "CA1", area_name: "Cairo East 1", operational_region_code: "CA" },
  { area_code: "D11", area_name: "Qalubeya", operational_region_code: "D3" },
  { area_code: "D24", area_name: "Sharkia 1", operational_region_code: "D3" },
  { area_code: "D25", area_name: "Sharkia 2", operational_region_code: "D3" },
  { area_code: "UE9", area_name: "Beni Suef", operational_region_code: "UE-1" },
  { area_code: "OT7", area_name: "Aswan", operational_region_code: "OT" },
];

const COMPANY_WIDE: TerritoryScope = { areaCodes: null, lineCodes: null, regionCodes: null };

export function runTerritorySearchScopeTests() {
  // 1 · A District Manager's seat-derived area bound.
  const dm = visibleLineAreas(ANTI_INFECTIVE_ROWS, {
    areaCodes: new Set(["D11", "D24"]),
    lineCodes: new Set(["anti_infective"]),
    regionCodes: null,
  });
  assert.deepEqual([...dm.keys()].sort(), ["D11", "D24"], "a DM's search reaches his own two areas and nothing else");
  assert.equal(dm.has("D25"), false, "Sharkia 2 is the sibling DM's area — same region, still not his to read");
  assert.equal(dm.has("CA1"), false, "and nothing from another region at all");

  // 2 · A Regional Manager's region bound.
  const rm = visibleLineAreas(ANTI_INFECTIVE_ROWS, {
    areaCodes: null,
    lineCodes: new Set(["anti_infective"]),
    regionCodes: new Set(["D3"]),
  });
  assert.deepEqual([...rm.keys()].sort(), ["D11", "D24", "D25"], "Delta (3)'s manager reaches every Delta (3) area");
  assert.equal(rm.has("UE9"), false, "Beni Suef is UE-1 on this line — outside his region, so outside his search");

  // 3 · Company-wide still sees the whole line.
  const all = visibleLineAreas(ANTI_INFECTIVE_ROWS, COMPANY_WIDE);
  assert.deepEqual(
    [...all.keys()].sort(),
    ["CA1", "D11", "D24", "D25", "UE9"],
    "a CEO / SFE Manager / Super Admin keeps the whole line — scoping narrows nobody who was already company-wide",
  );

  // 4 · "Others" is never searchable — it is a holding bucket, not somewhere a rep is hired.
  assert.equal(all.has("OT7"), false, "Aswan sits in Others; the picker has never offered it, so the search must not return it either");
  assert.equal(
    visibleLineAreas(ANTI_INFECTIVE_ROWS, { areaCodes: new Set(["OT7"]), lineCodes: null, regionCodes: null }).size,
    0,
    "not even for a caller whose own area bound names it — the bucket exclusion runs first",
  );

  // 5 · Case cannot slip the bound.
  const lowercased = visibleLineAreas([{ area_code: "d11", area_name: "Qalubeya", operational_region_code: "d3" }], {
    areaCodes: new Set(["D11"]),
    lineCodes: null,
    regionCodes: new Set(["D3"]),
  });
  assert.equal(lowercased.size, 1, "a lower-cased area or region code is matched, not silently dropped or silently admitted");
  assert.equal(lowercased.get("d11")?.regionCode, "d3", "and the row's own spelling is kept for display, not the comparison's");

  // 6 · The search is really bounded by that set, and fails closed.
  const service = readFileSync(new URL("../src/lib/territory-management/service.ts", import.meta.url), "utf8");
  const search = service.slice(service.indexOf("export async function searchBricks"), service.indexOf("Write a hand-placed pin"));
  assert.ok(search.length > 0, "searchBricks still exists in the service");
  assert.ok(
    search.includes("visibleLineAreas(await loadLineAreaRows(lineCode), scope)"),
    "searchBricks resolves the caller's OWN areas, passing the scope — not the line's whole area map",
  );
  assert.ok(
    search.includes('.in("area_code", [...lineAreas.keys()])'),
    "and bounds the brick query by that set — this line is the fix; without it the query is nationwide again",
  );
  assert.ok(
    search.includes("if (lineAreas.size === 0) return [];"),
    "a caller with no areas on this line gets nothing, never an unbounded `.in()` over an empty list",
  );
  assert.ok(
    !/\.from\("source_of_sales_areas"\)/.test(search),
    "the nationwide area-name lookup is gone with the nationwide search it existed to serve",
  );

  // 7 · One definition behind the picker, the search and the map's findings.
  // (2026-10-27: loadTerritoryMap became the third caller — its allocation findings compare a brick
  // with every area of the line the caller may see, and that set must be this one, never a copy.)
  assert.equal(
    service.match(/visibleLineAreas\(/g)?.length,
    4,
    "declared once, called three times — by loadTerritoryFilters for the picker, by searchBricks for the search and by loadTerritoryMap for the findings' comparison, with no copy of the narrowing",
  );
  const loader = service.slice(
    service.indexOf("export async function loadTerritoryMap("),
    service.indexOf("\n}\n", service.indexOf("export async function loadTerritoryMap(")),
  );
  assert.ok(
    loader.includes("visibleLineAreas(allowed, scope)"),
    "the map's comparison set is the same definition, passing the scope — a neighbour the picker hides is never read",
  );
  const filters = service.slice(
    service.indexOf("export async function loadTerritoryFilters"),
    service.indexOf("export type ScopeOverviewArea"),
  );
  assert.ok(
    filters.includes("visibleLineAreas(await loadLineAreaRows(lineCode), scope)"),
    "the area picker is built from the same definition, so the search can never offer a brick the picker would have hidden",
  );
}
