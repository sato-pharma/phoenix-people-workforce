import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { applyLineRegionOverride, type CanonicalArea } from "../src/lib/sales/territory/skeleton.ts";

/**
 * THE MEDICAL REP CARD SHOWS THE REGION OF THE REP'S OWN LINE.
 *
 * WHY THIS EXISTS. The Territory Drilldown builds a Medical Rep's area/region card from
 * loadCanonicalAreas — au_v_canonical_areas.code_region_code, which is line-AGNOSTIC. But the
 * region a canonical area belongs to varies by line: Qalubeya is Delta (1) canonically yet Delta (3)
 * on Anti Infective; Beni Suef is Giza canonically yet Upper Egypt on Pedia. Measured on production
 * 2026-09-22, that showed the wrong region on 13 of 66 seated reps' cards, and a rep read a
 * different region from the one his own DM and the closing use for the same area.
 *
 * applyLineRegionOverride corrects the region with au_v_line_area_map.operational_region_code — the
 * same per-line authority the DM / RM / nationwide levels already read via loadLineAreas — while
 * keeping the canonical NAME and never dropping an area the line map does not carry.
 */

function area(areaCode: string, areaName: string, regionCode: string): CanonicalArea {
  return { areaCode, areaName, regionCode };
}

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

export function runTerritoryRepRegionLabelTests() {
  // The two production cases the audit named: the line region replaces the canonical one.
  const base = [
    area("D11", "Qalubeya", "D1"), // canonical Delta (1) …
    area("UE9", "Beni Suef", "GZ"), // canonical Giza …
    area("CA1", "Nasr City", "CA"), // agrees on both → unchanged
  ];
  const antiInfectiveRegions = [
    area("D11", "Qalubeya", "D3"), // … but Delta (3) on Anti Infective
    area("UE9", "Beni Suef", "UE-1"), // … but Upper Egypt 1 on Anti Infective
    area("CA1", "Nasr City", "CA"),
  ];

  const corrected = applyLineRegionOverride(base, antiInfectiveRegions);
  const byCode = new Map(corrected.map((a) => [a.areaCode, a] as const));
  assert.equal(byCode.get("D11")?.regionCode, "D3", "Qalubeya must read the line region Delta (3), not the canonical Delta (1)");
  assert.equal(byCode.get("UE9")?.regionCode, "UE-1", "Beni Suef must read the line region Upper Egypt 1, not the canonical Giza");
  assert.equal(byCode.get("CA1")?.regionCode, "CA", "an area whose regions already agree is unchanged");

  // The NAME is never touched — only loadCanonicalAreas names an area, and the override must not
  // borrow a name from the line map even when it carries one.
  assert.equal(byCode.get("D11")?.areaName, "Qalubeya", "the canonical area name survives the region override");

  // An area the line map does not carry keeps its canonical region and STAYS on the card. This is
  // the graceful path: measured 0 of 66 reps today, but a rep whose area is 'other' for his line
  // must still see a card, not vanish.
  const partial = applyLineRegionOverride(base, [area("D11", "Qalubeya", "D3")]);
  assert.equal(partial.length, base.length, "no area is ever dropped by the override");
  assert.equal(partial.find((a) => a.areaCode === "UE9")?.regionCode, "GZ", "an area absent from the line map keeps its canonical region");

  // Every other root level (DM/RM/nationwide) already reads the line-aware region directly, so it
  // passes an empty override list — which must be a clean no-op, not a wipe.
  const untouched = applyLineRegionOverride(base, []);
  assert.deepEqual(
    untouched.map((a) => [a.areaCode, a.regionCode]),
    base.map((a) => [a.areaCode, a.regionCode]),
    "an empty line-region list leaves every region exactly as the base gave it",
  );

  // Case-insensitive area-code match: canonical and line-map code casing must never cause a miss
  // that silently falls back to the wrong (canonical) region.
  const mixedCase = applyLineRegionOverride([area("d11", "Qalubeya", "D1")], [area("D11", "Qalubeya", "D3")]);
  assert.equal(mixedCase[0].regionCode, "D3", "area-code matching is case-insensitive");

  // The input must not be mutated — buildTerritorySkeleton derives regionCodesInScope from the
  // returned array and must not see the base array change under it.
  const input = [area("D11", "Qalubeya", "D1")];
  applyLineRegionOverride(input, [area("D11", "Qalubeya", "D3")]);
  assert.equal(input[0].regionCode, "D1", "applyLineRegionOverride returns copies and never mutates its input");

  // ------------------------------------------------------------------ the fix is actually wired

  const source = readSource("../src/lib/sales/territory/skeleton.ts");
  const build = source.slice(source.indexOf("export async function buildTerritorySkeleton"));

  // The override must run against the loaded areas, or the pure function above proves nothing about
  // what the rep actually sees.
  assert.ok(
    build.includes("applyLineRegionOverride(baseAreas, lineAreaRegions)"),
    "buildTerritorySkeleton must correct the areas through applyLineRegionOverride",
  );

  // The line-aware region source must be fetched ONLY for the area (Medical Rep) level — the other
  // levels already read operational_region_code through loadLineAreas and must not pay a second
  // query. Pinned by requiring the area-level guard right before the loadLineAreas(auLineCode, null,
  // asOf) call (asOf is the window-end date threaded in by finding 5).
  assert.ok(
    /rootScope\.level === "area" && auLineCode\s*\n?\s*\?\s*loadLineAreas\(auLineCode, null, asOf\)/.test(build),
    "the line-region override source (loadLineAreas(auLineCode, null, asOf)) must load only for the area level",
  );
  assert.ok(
    build.includes("const allAreas = applyLineRegionOverride("),
    "allAreas must be the corrected list, so regionCodesInScope, the region cards and the area lanes all read the line-aware region",
  );
}
