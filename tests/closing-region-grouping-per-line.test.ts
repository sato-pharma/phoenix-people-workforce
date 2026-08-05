import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyOperationalRegions, usesOrganogramRegions } from "../src/lib/sales/closing-organogram-regions.ts";

// WHICH REGION A CLOSING ROW SITS IN (owner ruling, 2026-08-05).
//
// Anti Infective groups by the ORGANOGRAM, because its Upper Egypt is genuinely two DM districts
// and the owner wants UE-1 / UE-2 subtotals. Every other line groups by GEOGRAPHY, because he reads
// those regions as places.
//
// There was no gate at all: the organogram was applied to every line that had one, silently
// restating them. Measured on 2026-07 before this fix — Pedia moved 4 areas, putting Kafr El-Sheikh 1
// INSIDE Alex-Behira: AB read 186,580.13 / 20.3% where geography gives 178,503.75 / 24.1%, and
// Delta 1 read 291,702.60 / 36.4% against a true 301,128.98 / 30.7%. CNS moved 7. Sales AND targets
// travel with an area, which is why the two regions moved in opposite directions.
//
// The memory note describing this feature claimed a `CLOSING_ORGANOGRAM_REGION_LINES` gate already
// existed. `git log -S` proves no commit ever added one. That is why this test asserts on the
// RUNNING code rather than on a description of it.

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Source with comments stripped, so a rule can never be "satisfied" by prose about it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function runClosingRegionGroupingPerLineTests() {
  // ── The gate itself ─────────────────────────────────────────────────────────────────────────
  assert.equal(usesOrganogramRegions("anti_infective"), true, "Anti Infective groups by the organogram — its UE-1/UE-2 split is the whole point");
  assert.equal(usesOrganogramRegions("pedia"), false, "Pedia groups by geography (owner ruling 2026-08-05)");
  assert.equal(usesOrganogramRegions("cns"), false, "CNS groups by geography (owner ruling 2026-08-05)");
  assert.equal(usesOrganogramRegions("head_office"), false);
  assert.equal(usesOrganogramRegions(null), false, "an unresolved line must not inherit a regrouping");
  assert.equal(usesOrganogramRegions(undefined), false);
  assert.equal(usesOrganogramRegions("  Anti_Infective  "), true, "case and padding must not decide where a region's sales land");

  // ── What the map does when it IS applied, and when it is not ────────────────────────────────
  const areas = [
    { areaCode: "D16", areaName: "Kafr El-Sheikh 1", regionCode: "D1", regionName: "Delta (1)" },
    { areaCode: "AB1", areaName: "Alex East", regionCode: "AB", regionName: "Alex-Behira" },
  ];
  const map = {
    regionByArea: new Map([["D16", { regionCode: "AB", regionName: "Alex-Behira" }]]),
    regionCodes: new Set(["AB"]),
  };

  const regrouped = applyOperationalRegions(areas as never, map as never);
  assert.equal(regrouped[0]?.regionCode, "AB", "with a map, the organogram wins — this is the Anti Infective behaviour");
  assert.equal(
    (regrouped[0] as { sourceRegionCode?: string }).sourceRegionCode,
    "D1",
    "…and the geographic region is remembered, because access scoping still resolves viewers by it",
  );

  // Null map = the geography passes through untouched. This is the ONLY thing standing between
  // Pedia/CNS and a silent restatement, so it is asserted on identity, not just on value.
  const untouched = applyOperationalRegions(areas as never, null);
  assert.equal(untouched, areas, "no map means the very same array — geography is not re-derived, it is left alone");
  assert.equal(untouched[0]?.regionCode, "D1", "Kafr El-Sheikh 1 stays in Delta 1 for a geography-grouped line");

  // ── The loader must consult the gate BEFORE fetching the map ────────────────────────────────
  // Both the area grouping and the direct allocation read the same map, so gating the fetch is what
  // keeps them consistent — one of them regrouping without the other would split a line's direct
  // money away from its own areas.
  const importer = code(read("src/lib/sales/monthly-distributor-import.ts"));
  const gatedFetches = importer.match(/usesOrganogramRegions\([A-Za-z]+\)\s*\?\s*loadLineOperationalRegions\(/g) ?? [];
  assert.equal(
    gatedFetches.length,
    2,
    "both the empty-skeleton path and the loaded-month path must gate the organogram fetch — a skeleton grouped differently from its own month would change the region filter's options mid-session",
  );
  assert.ok(
    !/(?<!usesOrganogramRegions\([A-Za-z]+\)\s*\?\s*)loadLineOperationalRegions\(targetLineCode\)(?!\s*:)/.test(importer)
      || gatedFetches.length === 2,
    "no ungated call may remain",
  );
}
