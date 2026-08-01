import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildClosingGeographyFilter } from "../src/lib/analytics/service.ts";

// analytics.dim_areas, as loadAreaNameLookup builds it. AB1/AB2 sit in region AB; D16 is the
// out-of-region area a CNS District Manager also owns; D17 is a SIBLING area in that same region
// which the DM must NOT see — that pair is the whole point of the area bound.
const AREAS = new Map<string, { regionCode: string }>([
  ["AB1", { regionCode: "AB" }],
  ["AB2", { regionCode: "AB" }],
  ["D16", { regionCode: "D1" }],
  ["D17", { regionCode: "D1" }],
  ["GZ4", { regionCode: "GZ" }],
]);

export function runAnalyticsClosingGeographyScopeTests() {
  // ── Company-wide viewer: no bound at all ────────────────────────────────────
  const unbounded = buildClosingGeographyFilter({}, AREAS);
  assert.equal(unbounded("AB1"), true, "no bound ⇒ every area passes");
  assert.equal(unbounded(null), true, "no bound ⇒ an area-less (direct/unmapped) row still passes");

  const emptyArrays = buildClosingGeographyFilter({ regions: [], areas: [] }, AREAS);
  assert.equal(emptyArrays("GZ4"), true, "empty arrays are 'no selection', not 'nothing allowed'");
  assert.equal(emptyArrays(null), true, "empty arrays leave area-less rows in place");

  // ── Seat-derived DM: the AREA bound is authoritative ────────────────────────
  // Regions are deliberately widened to AB+D1 so the owned out-of-region area D16 is reachable.
  const dm = buildClosingGeographyFilter({ areas: ["AB1", "AB2", "D16"], regions: ["AB", "D1"] }, AREAS);
  assert.equal(dm("AB1"), true, "own in-region area passes");
  assert.equal(dm("D16"), true, "own OUT-OF-REGION area passes — the widened region set must not filter it out");
  assert.equal(dm("D17"), false, "a sibling area in the widened region must NOT leak in");
  assert.equal(dm("GZ4"), false, "an area outside the bound entirely is rejected");
  assert.equal(dm(null), false, "area-less rows are not attributable to a bounded viewer");
  assert.equal(dm(""), false, "blank area is treated as no area");

  // Case and whitespace must not defeat the bound.
  assert.equal(dm(" ab1 "), true, "area codes compare case- and whitespace-insensitively");
  assert.equal(dm("d17"), false, "lower-case sibling area is still rejected");

  // ── Region-scoped viewer with no seat (areas absent) ────────────────────────
  const regionOnly = buildClosingGeographyFilter({ regions: ["AB"] }, AREAS);
  assert.equal(regionOnly("AB1"), true, "area inside the allowed region passes");
  assert.equal(regionOnly("AB2"), true, "second area inside the allowed region passes");
  assert.equal(regionOnly("D16"), false, "area in another region is rejected");
  assert.equal(regionOnly("UNKNOWN"), false, "an area missing from dim_areas fails closed");
  assert.equal(regionOnly(null), false, "area-less rows are rejected for a region-bound viewer");

  // ── Fail-closed: a resolved-but-empty bound must not become 'see everything' ─
  // scopeAnalyticsFilters signals this case via `empty`, and the dashboards skip the query; this
  // asserts the loader-side predicate agrees rather than silently opening up.
  const disjoint = buildClosingGeographyFilter({ areas: ["ZZ9"], regions: ["AB"] }, AREAS);
  assert.equal(disjoint("AB1"), false, "area bound wins even when the region would have allowed it");
  assert.equal(disjoint("ZZ9"), true, "the one allowed area still passes");

  // ── Wiring guard: the loader must actually apply the predicate ──────────────
  // The original defect was that ClosingFilters carried no geography at all, so the bound computed
  // by scopeAnalyticsFilters was silently dropped. Assert the plumbing stays connected.
  const service = readFileSync("src/lib/analytics/service.ts", "utf8");
  assert.match(
    service,
    /const inGeography = buildClosingGeographyFilter\(filters, areaNames\)/,
    "loadClosingByEmployeeUncached must build the geography filter from its filters",
  );
  assert.match(
    service,
    /if \(!inGeography\(r\.area_code\)\) return false;/,
    "loadClosingByEmployeeUncached must apply the geography filter to every raw row",
  );
  assert.match(service, /\bregions\?: string\[\];/, "ClosingFilters must declare regions");
  assert.match(service, /\bareas\?: string\[\];/, "ClosingFilters must declare areas");

  for (const dashboard of [
    "monthly-closing-dashboard",
    "monthly-closing-by-line-dashboard",
    "monthly-closing-by-employee-dashboard",
  ]) {
    const source = readFileSync(`src/components/analytics/dashboards/${dashboard}.tsx`, "utf8");
    assert.match(source, /regions:\s+Array\.isArray\(filters\.regions\)/, `${dashboard} must pass regions through`);
    assert.match(source, /areas:\s+Array\.isArray\(filters\.areas\)/, `${dashboard} must pass areas through`);
    assert.match(
      source,
      /scopeAnalyticsFilters\(closingFilters, scope\)/,
      `${dashboard} must still scope its filters`,
    );
  }
}
