import assert from "node:assert/strict";

import { regroupAreaRowsByOperationalRegion, type SosByAreaLineRow } from "../src/lib/analytics/service.ts";
import type { OperationalRegionResolver } from "../src/lib/sales/closing-organogram-regions.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The analytics region breakdowns must follow the ORGANOGRAM, like the Monthly Closing, while the
// GEOGRAPHIC code stays on every row as the dimension access was applied in.
//
// Until this was fixed they grouped on geography. Measured on production for 2026-07: EGP 705,076
// of 10,370,361 (6.8%) sat under a region the organogram does not agree with — `OT` understated by
// 266,063, and `UE-1` / `UE-2` reported as nothing at all, because no row in the geographic master
// carries those codes.
//
// The reason the loader had to start fetching the LINE: the organogram region is a function of
// (line, area, month). 15 of 48 production areas are owned by two different districts depending on
// the line, so a row already summed across lines — which is exactly what `analytics_sos_by_area`
// returns — cannot be re-filed at all.
// ─────────────────────────────────────────────────────────────────────────────

const REGION_NAMES = new Map([
  ["UE", "Upper Egypt"],
  ["UE-1", "Upper Egypt 1"],
  ["UE-2", "Upper Egypt 2"],
  ["OT", "Others"],
  ["CA", "Cairo"],
]);

/**
 * UE3 is geographically Upper Egypt. The organogram gives it to UE-2 on Anti Infective and to
 * Others on CNS — the two-owner shape that makes the line indispensable.
 */
function makeResolver(): OperationalRegionResolver {
  const map = (pairs: Array<[string, string]>) => ({
    regionByArea: new Map(pairs.map(([area, region]) => [area, { regionCode: region, regionName: REGION_NAMES.get(region) ?? region }])),
    regionCodes: new Set(pairs.map(([, region]) => region)),
  });
  return {
    available: true,
    regionName: (code) => REGION_NAMES.get(code.toUpperCase()),
    forLinePeriod: (line) => {
      const key = String(line ?? "").trim().toLowerCase();
      // UE-7 is deliberately absent from REGION_NAMES: a district the name lookup cannot resolve.
      if (key === "anti infective") return map([["UE3", "UE-2"], ["UE1", "UE-1"], ["UE7", "UE-7"]]);
      if (key === "cns") return map([["UE3", "OT"]]);
      return null; // outside the organogram set — the real resolver answers null here too
    },
  };
}

function row(over: Partial<SosByAreaLineRow> = {}): SosByAreaLineRow {
  return {
    period: "2026-07",
    line: "Anti Infective",
    regionCode: "UE",
    regionName: "Upper Egypt",
    areaCode: "UE3",
    areaName: "Qena",
    channel: "Distributor",
    units: 100,
    value: 1_000,
    ...over,
  };
}

export function runAnalyticsOrganogramRegionsTests() {
  const resolver = makeResolver();

  // ── 1. THE HEADLINE: a row is re-filed under the district that owns it ───────────────────────
  const [reFiled] = regroupAreaRowsByOperationalRegion([row()], resolver);
  assert.equal(reFiled!.operationalRegionCode, "UE-2", "the row must be filed under the district the organogram gives it");
  assert.equal(reFiled!.operationalRegionName, "Upper Egypt 2", "a region that exists only in the organogram must still get a name");

  // ── 2. The GEOGRAPHIC code survives — it is the dimension access was applied in ───────────────
  // The viewer's bound is a geographic set intersected by scopeAnalyticsFilters and pushed into the
  // RPC. Overwriting this field would leave nothing to audit that decision against.
  assert.equal(reFiled!.regionCode, "UE", "the geographic region code must be preserved, not overwritten");
  assert.equal(reFiled!.regionName, "Upper Egypt", "the geographic region name must be preserved too");

  // ── 3. One area, two districts, two rows — the shape the closing publishes ────────────────────
  // The SAME area and month on two lines. Collapsing the line away must not merge them, or one
  // district's money is reported under the other's name.
  const twoLines = regroupAreaRowsByOperationalRegion(
    [row({ line: "Anti Infective", value: 1_000 }), row({ line: "CNS", value: 250 })],
    resolver,
  );
  assert.equal(twoLines.length, 2, "an area owned by two districts must produce one row per district");
  const byRegion = new Map(twoLines.map((r) => [r.operationalRegionCode, r.value]));
  assert.equal(byRegion.get("UE-2"), 1_000, "Anti Infective's share must sit with UE-2");
  assert.equal(byRegion.get("OT"), 250, "CNS's share of the SAME area must sit with Others");

  // ── 4. Collapsing the line is LOSSLESS — no value invented, none dropped ──────────────────────
  const many = [
    row({ line: "Anti Infective", areaCode: "UE3", value: 1_000, units: 10 }),
    row({ line: "Anti Infective", areaCode: "UE1", value: 400, units: 4 }),
    row({ line: "CNS", areaCode: "UE3", value: 250, units: 2 }),
    row({ line: "Head Office", areaCode: "UE3", value: 90, units: 1 }),
  ];
  const out = regroupAreaRowsByOperationalRegion(many, resolver);
  assert.equal(
    out.reduce((s, r) => s + r.value, 0),
    many.reduce((s, r) => s + r.value, 0),
    "re-filing must preserve total value exactly",
  );
  assert.equal(
    out.reduce((s, r) => s + r.units, 0),
    many.reduce((s, r) => s + r.units, 0),
    "re-filing must preserve total units exactly",
  );

  // ── 5. Two rows of the SAME line+area+district DO merge, so the grain is unchanged ────────────
  // Callers consume (period, region, area, channel); the line must genuinely collapse out.
  const merged = regroupAreaRowsByOperationalRegion(
    [row({ value: 1_000, units: 10 }), row({ value: 500, units: 5 })],
    resolver,
  );
  assert.equal(merged.length, 1, "identical line+area+district rows must collapse to one");
  assert.equal(merged[0]!.value, 1_500, "collapsed rows must sum");
  assert.equal(merged[0]!.units, 15, "collapsed units must sum");

  // ── 6a. A district the name lookup cannot resolve renders as its CODE, never as a blank ──────
  // The organogram can carry a region the geographic master has never heard of, and if the name
  // lookup also misses it the row would otherwise render with an EMPTY region — which reads on a
  // dashboard as "no region", not as "a name is missing", and silently forms its own blank group.
  const unnamed = regroupAreaRowsByOperationalRegion([row({ areaCode: "UE7" })], resolver);
  assert.equal(unnamed[0]!.operationalRegionCode, "UE-7", "the unnameable district must still be resolved");
  assert.equal(
    unnamed[0]!.operationalRegionName,
    "UE-7",
    "a district with no display name must fall back to its CODE — never to an empty string",
  );

  // ── 6. A line OUTSIDE the organogram falls back to geography, never to a blank ────────────────
  // Head Office is not in the organogram set. The resolver answers null; the row must keep its
  // geographic region rather than land under an empty code where no dashboard would show it.
  const ho = regroupAreaRowsByOperationalRegion([row({ line: "Head Office" })], resolver);
  assert.equal(ho[0]!.operationalRegionCode, "UE", "a line outside the organogram must fall back to geography");
  assert.equal(ho[0]!.operationalRegionName, "Upper Egypt", "the fallback must carry the geographic NAME, not a bare code");
}
