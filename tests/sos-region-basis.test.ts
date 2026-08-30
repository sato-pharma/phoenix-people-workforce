import assert from "node:assert/strict";

import {
  buildOperationalRegionMap,
  type LineOperationalRegionMap,
  type OperationalRegionResolver,
} from "../src/lib/sales/closing-organogram-regions.ts";
import {
  areaMatchesRegionFilter,
  buildRegionOptions,
  operationalRegionFor,
  rowIsInRegionScope,
  rowMatchesRegionFilter,
  widenRegionsToGeography,
} from "../src/lib/sales/sos-region-basis.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The dashboard and the Monthly Closing used to publish DIFFERENT regional splits of the same line
// and the same month. The dashboard grouped by the geographic region the fact row carries; the
// Closing relabelled every area through the organogram. On production for 2026-07 that moved
// 807,168 EGP between regions — CNS Others +335,008, CNS Delta (1) −213,804 — with an identical
// grand total, which is exactly why it went unnoticed.
//
// These tests pin the rule (organogram, both surfaces) AND the thing that makes the rule dangerous
// to implement: an area's ACCESS bound is still geographic, because that is the only code the RPCs
// can filter on. Swap the two and a scoped manager's board renders EMPTY, which a user reads as
// "I sold nothing" rather than as a bug.
//
// The maps below are built with the REAL `buildOperationalRegionMap`, so the effective-dating
// predicate under test is the production one and not a stand-in.
// ─────────────────────────────────────────────────────────────────────────────

const REGION_NAMES = new Map<string, string>([
  ["AB", "Alex-BHR"],
  ["CA", "Cairo"],
  ["D1", "Delta (1)"],
  ["D3", "Delta (3)"],
  ["GZ", "Giza"],
  ["OT", "Others"],
  ["UE", "Upper Egypt"],
  ["UE-1", "Upper Egypt 1"],
  ["UE-2", "Upper Egypt 2"],
]);

/** The shape production actually has, verified live 2026-08-30 against `au.f_line_area_map_asof`. */
const ANTI_INFECTIVE_ROWS = [
  { area_code: "UE1", operational_region_code: "UE-1", effective_from: "2026-01-01", effective_to: null },
  { area_code: "UE3", operational_region_code: "UE-2", effective_from: "2026-01-01", effective_to: null },
  { area_code: "GZ6", operational_region_code: "UE-1", effective_from: "2026-01-01", effective_to: null },
  // The Delta (3) territory move: a dated PAIR, in force from 2026-09-01 and not a day earlier.
  { area_code: "D11", operational_region_code: "D1", effective_from: "2026-01-01", effective_to: "2026-09-01" },
  { area_code: "D11", operational_region_code: "D3", effective_from: "2026-09-01", effective_to: null },
];
const CNS_ROWS = [
  { area_code: "GZ6", operational_region_code: "OT", effective_from: "2026-01-01", effective_to: null },
  { area_code: "D16", operational_region_code: "AB", effective_from: "2026-01-01", effective_to: null },
  { area_code: "UE1", operational_region_code: "UE", effective_from: "2026-01-01", effective_to: null },
];

/** Area -> the GEOGRAPHIC region its sales rows carry. */
const GEOGRAPHIC_REGION_BY_AREA = new Map<string, string>([
  ["UE1", "UE"],
  ["UE3", "UE"],
  ["GZ6", "GZ"],
  ["D11", "D1"],
  ["D16", "D1"],
  ["CA5", "CA"],
]);

const OFFICIAL_LINES = ["Anti Infective", "CNS", "Head Office"];

/** Period end -> map, built through the real dating predicate. */
function mapFor(rows: Array<Record<string, unknown>>, period: string | null): LineOperationalRegionMap | null {
  // Mirrors `closingRegionsAsOfDate`: the LAST DAY of the month being shown, never today.
  const asOf = period ? `${period}-${new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate()}` : "2026-08-31";
  return buildOperationalRegionMap(rows, asOf, REGION_NAMES);
}

function makeResolver(options?: { available?: boolean }): OperationalRegionResolver {
  if (options?.available === false) {
    return { available: false, forLinePeriod: () => null, regionName: () => undefined };
  }
  return {
    available: true,
    regionName: (code) => REGION_NAMES.get(code.toUpperCase()),
    forLinePeriod: (line, period) => {
      const key = String(line ?? "").trim().toLowerCase();
      if (key === "anti infective") return mapFor(ANTI_INFECTIVE_ROWS, period ?? null);
      if (key === "cns") return mapFor(CNS_ROWS, period ?? null);
      // Head Office is outside the organogram set — the real resolver returns null for it too.
      return null;
    },
  };
}

export async function runSosRegionBasisTests() {
  const resolver = makeResolver();

  // ── 1. THE HEADLINE: the board's regional split follows the ORGANOGRAM, not geography ──
  // GZ6 sits in Giza on the map. On CNS the organogram gives it to Others, on Anti Infective to
  // Upper Egypt 1. Before this fix the dashboard called all three "Giza" while the Closing — the
  // published truth, already mailed to the CEO — called them Others and Upper Egypt 1.
  assert.equal(
    operationalRegionFor(resolver, "CNS", "GZ6", "2026-07", "GZ"),
    "OT",
    "the dashboard groups a CNS area by the organogram region the Closing publishes, not by geography",
  );
  assert.equal(
    operationalRegionFor(resolver, "Anti Infective", "GZ6", "2026-07", "GZ"),
    "UE-1",
    "the same area answers differently on a different line — the organogram is per line",
  );
  assert.equal(
    operationalRegionFor(resolver, "CNS", "D16", "2026-07", "D1"),
    "AB",
    "Kafr El-Sheikh 1 files under Alex-BHR on CNS even though its sales rows carry Delta (1)",
  );

  // ── 2. THE REGRESSION THAT EMPTIES A BOARD: access stays GEOGRAPHIC ──
  // `scopeRegionCodes` is built from the geographic regions a manager's areas sit in, because that
  // is what the RPC push-down filters on. If a future tidy-up passes the organogram code here, the
  // comparison is "UE-1" against a bound holding "UE" — every row is rejected and the manager sees
  // a blank board with no error anywhere.
  // The row that separates the two: an Anti Infective sale in UE1, which the fact table files under
  // Upper Egypt and the organogram files under Upper Egypt 1. Both functions receive this SAME row,
  // so which field each reads is the entire assertion.
  const splitRow = { regionCode: "UE", operationalRegionCode: "UE-1" };
  const geographicScope = new Set(["UE"]);
  assert.equal(
    rowIsInRegionScope(geographicScope, splitRow),
    true,
    "a manager scoped to Upper Egypt still sees this row — the access test reads the GEOGRAPHIC code, so relabelling never empties a board",
  );
  assert.equal(
    rowIsInRegionScope(new Set(["UE-1"]), splitRow),
    false,
    "and an organogram code is NOT an access bound: nothing in the database carries it, so it can never widen access either",
  );
  assert.equal(
    rowIsInRegionScope(new Set(["GZ"]), splitRow),
    false,
    "the access bound still excludes a region the viewer does not own",
  );
  assert.equal(rowIsInRegionScope(null, splitRow), true, "a company-scope viewer is bounded by nothing");

  // ── 3. The user's own filter reads the ORGANOGRAM code — what the board showed them ──
  assert.equal(
    rowMatchesRegionFilter(new Set(["UE-1"]), splitRow),
    true,
    "picking Upper Egypt 1 selects the rows the board totalled under Upper Egypt 1",
  );
  assert.equal(
    rowMatchesRegionFilter(new Set(["UE"]), splitRow),
    false,
    "and picking Upper Egypt does NOT quietly include a row the board showed under Upper Egypt 1",
  );
  assert.equal(rowMatchesRegionFilter(null, splitRow), true, "no selection means no filter");

  // ── 4. The SQL push-down is widened to geography, or the board fetches nothing at all ──
  // `region_code` in the rollup is geography. "UE-1" matches no row in the database, so pushing it
  // down unwidened returns zero rows — the same empty board, arrived at from the other direction.
  const widened = widenRegionsToGeography(["UE-1"], resolver, OFFICIAL_LINES, ["2026-07"], GEOGRAPHIC_REGION_BY_AREA);
  assert.ok(widened.includes("UE"), "UE-1 widens to Upper Egypt — where UE1's rows actually sit");
  assert.ok(widened.includes("GZ"), "and to Giza — because GZ6 is an Anti Infective UE-1 area that sits in Giza geographically");
  assert.ok(widened.includes("UE-1"), "the picked code is always kept: Direct rows and non-organogram lines match on it");

  // A pick that is already geographic must not lose itself in the widening.
  const widenedGeographic = widenRegionsToGeography(["OT"], resolver, OFFICIAL_LINES, ["2026-07"], GEOGRAPHIC_REGION_BY_AREA);
  assert.ok(widenedGeographic.includes("OT"), "a geographic pick survives widening");
  assert.ok(widenedGeographic.includes("GZ"), "and widens to reach the CNS area the organogram moved into Others");

  // ── 5. DATING: the row's OWN month decides, never today ──
  // Delta (3) is in force from 2026-09-01. August must never see it, whenever the page is rendered.
  assert.equal(
    operationalRegionFor(resolver, "Anti Infective", "D11", "2026-08", "D1"),
    "D1",
    "August resolves D11 to Delta (1) — the Delta (3) move is dated 2026-09-01 and must not reach back",
  );
  assert.equal(
    operationalRegionFor(resolver, "Anti Infective", "D11", "2026-09", "D1"),
    "D3",
    "September resolves the same area to Delta (3)",
  );

  // ── 6. Every "don't know" falls back to geography — a missing mapping never costs a row ──
  assert.equal(
    operationalRegionFor(resolver, "Head Office", "UE1", "2026-07", "UE"),
    "UE",
    "Head Office is outside the organogram set and keeps geographic grouping",
  );
  assert.equal(
    operationalRegionFor(resolver, "CNS", "CA5", "2026-07", "CA"),
    "CA",
    "an area the org chart does not cover keeps its geographic region rather than vanishing",
  );
  assert.equal(
    operationalRegionFor(makeResolver({ available: false }), "CNS", "GZ6", "2026-07", "GZ"),
    "GZ",
    "an unreadable org chart degrades to the old geographic grouping, never to a blank board",
  );

  // ── 7. The picker offers every region the board can SHOW ──
  const options = buildRegionOptions(
    [
      { regionCode: "GZ", regionName: "Giza" },
      { regionCode: "UE", regionName: "Upper Egypt" },
      { regionCode: "D1", regionName: "Delta (1)" },
    ],
    resolver,
    OFFICIAL_LINES,
    "2026-07",
  );
  const codes = options.map((option) => option.code);
  assert.ok(codes.includes("UE-1") && codes.includes("UE-2"), "UE-1 and UE-2 exist only in the organogram and must still be pickable");
  assert.ok(codes.includes("GZ"), "geographic regions stay in the list — Head Office is grouped by nothing else");
  assert.equal(
    options.find((option) => option.code === "UE-1")?.label,
    "Upper Egypt 1",
    "an organogram-only region is named, not rendered as a bare code",
  );
  assert.equal(new Set(codes).size, codes.length, "no region is offered twice");

  // A forward-dated region must not appear in a month it was dated to spare.
  const augustCodes = buildRegionOptions([], resolver, OFFICIAL_LINES, "2026-08").map((option) => option.code);
  assert.ok(!augustCodes.includes("D3"), "Delta (3) is not offered for August — the move is dated 2026-09-01");
  const septemberCodes = buildRegionOptions([], resolver, OFFICIAL_LINES, "2026-09").map((option) => option.code);
  assert.ok(septemberCodes.includes("D3"), "and is offered for September");

  // ── 8. The line-less panels (Top Bricks / Top Customers) match on EITHER basis ──
  // They carry no line dimension, so there is no single right organogram answer; matching on
  // geography alone would drop a brick out of the panel sitting directly under the chart that
  // just showed its area under an organogram region.
  assert.equal(
    areaMatchesRegionFilter(new Set(["OT"]), resolver, OFFICIAL_LINES, "2026-07", "GZ", "GZ6"),
    true,
    "a Giza brick shows under Others because CNS's organogram puts GZ6 there",
  );
  assert.equal(
    areaMatchesRegionFilter(new Set(["GZ"]), resolver, OFFICIAL_LINES, "2026-07", "GZ", "GZ6"),
    true,
    "and still shows under Giza, which is where it geographically is",
  );
  assert.equal(
    areaMatchesRegionFilter(new Set(["AB"]), resolver, OFFICIAL_LINES, "2026-07", "GZ", "GZ6"),
    false,
    "but not under a region no line maps it to",
  );
  assert.equal(areaMatchesRegionFilter(null, resolver, OFFICIAL_LINES, "2026-07", "GZ", "GZ6"), true, "no selection means no filter");
}
