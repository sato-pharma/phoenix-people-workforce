import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  selectLineAreasAsOf,
  territoryAsOfDate,
  TERRITORY_PICKER_LINES,
  type LineAreaMapRow,
} from "../src/lib/sales/territory/skeleton.ts";
import {
  isTerritoryLinePickerRole,
  resolveTerritoryPickerLine,
  TERRITORY_LINE_PICKER_ROLES,
} from "../src/lib/sales/territory/root-scope.ts";
import { isTerritoryDrilldownRole, TERRITORY_DRILLDOWN_ROLES } from "../src/lib/sales/territory/service.ts";

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * FINDING 5 — the Territory Drilldown's area list is resolved AS OF the window end, and Super Admin
 * / CEO can open the page and drill any one line nationwide.
 *
 * WHY THIS EXISTS.
 *  (A) loadLineAreas used to read `au_v_line_area_map` (effective_to IS NULL = today AND every
 *      future-dated row), so a territory move written as a pair effective the 1st of a FUTURE month
 *      showed its future region for the whole trailing window before it took effect. The fix reads
 *      the effective-dated history `au_v_line_area_map_all` and resolves the winner as of the
 *      window-end date — the same period→date rule the closing uses. selectLineAreasAsOf is the pure
 *      core, so the dating is provable without a database (break it → these assertions fire).
 *  (B) Super Admin / CEO see every line, so deriveOfficialLine (needs exactly one) can never resolve
 *      for them; they were denied the page. They now pick a line and drill it nationwide.
 */
export function runTerritoryAsofAndLinePickerTests() {
  // ---------------------------------------------------------------- (A) as-of winner selection
  // Qalubeya (D24) on Anti Infective moves Delta (1) -> Delta (3) effective 2026-09-01, written as
  // the canonical PAIR: an old row closed on 2026-09-01 and a new open row from 2026-09-01.
  const move: LineAreaMapRow[] = [
    { area_code: "D24", area_name: "Qalubeya", operational_region_code: "D1", carries_target: true, effective_from: "2020-01-01", effective_to: "2026-09-01" },
    { area_code: "D24", area_name: "Qalubeya", operational_region_code: "D3", carries_target: true, effective_from: "2026-09-01", effective_to: null },
  ];

  const august = selectLineAreasAsOf(move, "2026-08-31", null);
  assert.equal(august.length, 1, "the area is present in the August window");
  assert.equal(
    august[0].regionCode,
    "D1",
    "as of 2026-08-31 the OLD region (Delta 1) wins — reading the open row (Delta 3) would show the move a month early",
  );

  const september = selectLineAreasAsOf(move, "2026-09-30", null);
  assert.equal(
    september[0].regionCode,
    "D3",
    "as of 2026-09-30 the NEW region (Delta 3) wins — effective_to is EXCLUSIVE, so 2026-09-01 belongs to the successor",
  );

  // effective_to is EXCLUSIVE at the boundary itself: 2026-09-01 is the successor's first day.
  assert.equal(
    selectLineAreasAsOf(move, "2026-09-01", null)[0].regionCode,
    "D3",
    "on 2026-09-01 exactly, the row closed on that date is already superseded",
  );

  // carries_target = false is a sibling line's / non-seat area and must be dropped, whatever date.
  const withOther: LineAreaMapRow[] = [
    ...move,
    { area_code: "OT2", area_name: "Ismailia", operational_region_code: "OT", carries_target: false, effective_from: "2020-01-01", effective_to: null },
  ];
  const septCodes = selectLineAreasAsOf(withOther, "2026-09-30", null).map((a) => a.areaCode);
  assert.deepEqual(septCodes, ["D24"], "an area whose in-force row does not carry a target is excluded");

  // The region filter narrows to those operational regions (the DM/RM path).
  assert.equal(
    selectLineAreasAsOf(move, "2026-08-31", new Set(["D3"])).length,
    0,
    "filtering to region D3 drops D24 in August, when it is still Delta (1)",
  );
  assert.equal(
    selectLineAreasAsOf(move, "2026-09-30", new Set(["D3"])).length,
    1,
    "filtering to region D3 keeps D24 in September, once it has moved",
  );

  // The window-end date is the LAST DAY of the month (the closing's period→date rule), not "today".
  assert.equal(territoryAsOfDate("2026-09"), "2026-09-30", "the as-of date is the last day of the window-end month");
  assert.equal(territoryAsOfDate("2026-02"), "2026-02-28", "…leap-year aware via closingRegionsAsOfDate");

  // ---------------------------------------------------------------- (A) the fix is actually wired
  const skeleton = readSource("../src/lib/sales/territory/skeleton.ts");
  assert.ok(
    skeleton.includes('.from("au_v_line_area_map_all")'),
    "loadLineAreas must read the effective-dated history au_v_line_area_map_all, never the open-row au_v_line_area_map",
  );
  assert.ok(
    /export async function loadLineAreas\(\s*auLineCode: string,\s*regionCodes: Set<string> \| null,\s*asOf: string,/.test(skeleton),
    "loadLineAreas must take an asOf date and resolve the seat map as of it",
  );
  assert.ok(
    /export async function buildTerritorySkeleton\([\s\S]*?asOf: string,\s*\): Promise<TerritorySkeleton>/.test(skeleton),
    "buildTerritorySkeleton must thread the window-end asOf date through to loadLineAreas",
  );

  // ---------------------------------------------------------------- (B) Super Admin / CEO access
  for (const role of ["Super Admin", "CEO"] as const) {
    assert.ok(TERRITORY_DRILLDOWN_ROLES.includes(role), `${role} is a Territory Drilldown role`);
    assert.ok(isTerritoryDrilldownRole(role), `${role} passes the module role gate`);
    assert.ok(isTerritoryLinePickerRole(role), `${role} gets the line picker`);
    assert.ok((TERRITORY_LINE_PICKER_ROLES as readonly string[]).includes(role), `${role} is a line-picker role`);
  }
  // A single-line business role must NOT be a picker role — its line is derived, not chosen.
  for (const role of ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager"] as const) {
    assert.ok(!isTerritoryLinePickerRole(role), `${role} derives its own line and gets no picker`);
  }

  // ---------------------------------------------------------------- (B) picker-line resolution
  assert.equal(resolveTerritoryPickerLine(null), TERRITORY_PICKER_LINES[0], "no selection defaults to the first line");
  assert.equal(resolveTerritoryPickerLine("cns"), "CNS", "a lowercase line resolves to canonical casing");
  assert.equal(resolveTerritoryPickerLine("pedia"), "Pedia", "pedia resolves to Pedia");
  assert.equal(
    resolveTerritoryPickerLine("Head Office"),
    TERRITORY_PICKER_LINES[0],
    "Head Office carries no seat tree, so it is not drillable and falls back to the default line",
  );
  assert.deepEqual(
    [...TERRITORY_PICKER_LINES],
    ["Anti Infective", "CNS", "Pedia"],
    "the three seat-carrying lines are the only drillable lines",
  );
}
