import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyOperationalRegions, usesOrganogramRegions } from "../src/lib/sales/closing-organogram-regions.ts";

// WHICH REGION A CLOSING ROW SITS IN (owner ruling, 2026-08-07).
//
// Anti Infective, Pedia, and CNS all group by the EU ORGANOGRAM. The mapping is line-specific, so
// areas assigned to the Others territory for that line do not remain under the manager implied by
// their geographic region. Production's canonical example is Kafr El-Sheikh 2 (D17): geographically
// Delta 1, operationally Others for both Pedia and CNS.

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
  assert.equal(usesOrganogramRegions("pedia"), true, "Pedia follows its line-specific EU Organogram");
  assert.equal(usesOrganogramRegions("cns"), true, "CNS follows its line-specific EU Organogram");
  assert.equal(usesOrganogramRegions("head_office"), false);
  assert.equal(usesOrganogramRegions(null), false, "an unresolved line must not inherit a regrouping");
  assert.equal(usesOrganogramRegions(undefined), false);
  assert.equal(usesOrganogramRegions("  Anti_Infective  "), true, "case and padding must not decide where a region's sales land");

  // ── What the map does when it IS applied, and when it is not ────────────────────────────────
  const areas = [
    { areaCode: "D16", areaName: "Kafr El-Sheikh 1", regionCode: "D1", regionName: "Delta (1)" },
    { areaCode: "D17", areaName: "Kafr El-Sheikh 2", regionCode: "D1", regionName: "Delta (1)" },
    { areaCode: "AB1", areaName: "Alex East", regionCode: "AB", regionName: "Alex-Behira" },
  ];
  const map = {
    regionByArea: new Map([
      ["D16", { regionCode: "AB", regionName: "Alex-Behira" }],
      ["D17", { regionCode: "OT", regionName: "Others" }],
    ]),
    regionCodes: new Set(["AB", "OT"]),
  };

  const regrouped = applyOperationalRegions(areas as never, map as never);
  assert.equal(regrouped[0]?.regionCode, "AB", "with a map, the line-specific Organogram wins");
  assert.equal(
    (regrouped[0] as { sourceRegionCode?: string }).sourceRegionCode,
    "D1",
    "…and the geographic region is remembered, because access scoping still resolves viewers by it",
  );
  assert.equal(regrouped[1]?.regionCode, "OT", "Kafr El-Sheikh 2 follows the EU Organogram into Others");
  assert.equal(regrouped[1]?.regionName, "Others", "the exported group is labelled Others, not Delta 1");

  // Null map = the geography passes through untouched. This is the safe failure mode for a line
  // outside the field-sales Organogram or a temporary Organogram outage.
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
    !/(?<!usesOrganogramRegions\([A-Za-z]+\)\s*\?\s*)loadLineOperationalRegions\(targetLineCode,/.test(importer)
      || gatedFetches.length === 2,
    "no ungated call may remain",
  );
}
