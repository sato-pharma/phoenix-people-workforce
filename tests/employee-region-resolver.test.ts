import { strict as assert } from "node:assert";

import {
  buildRegionCrosswalk,
  employeeRegionFields,
  lineAreaKey,
  resolveRegionFromCrosswalk,
} from "../src/lib/employees/region-resolver.ts";

export function runEmployeeRegionResolverTests() {
  const crosswalk = buildRegionCrosswalk(
    [
      { line_code: "pedia", area_code: "D14", area_name: "Gharbia 1 (Tanta)", operational_region_code: "D1" },
      { line_code: "pedia", area_code: "D15", area_name: "Gharbia 2 (Mahalla)", operational_region_code: "D1" },
      { line_code: "anti_infective", area_code: "AB1", area_name: "Alex East", operational_region_code: "AB" },
    ],
    [
      { region_code: "D1", region_name: "Delta (1)" },
      { region_code: "AB", region_name: "Alex-BHR" },
    ],
  );

  // Exact resolve: (line, area) -> region code + name + area name.
  assert.deepEqual(resolveRegionFromCrosswalk("pedia", "D14", crosswalk), {
    regionCode: "D1",
    regionName: "Delta (1)",
    areaName: "Gharbia 1 (Tanta)",
  });

  // Line + area codes are matched case/space-insensitively.
  assert.deepEqual(resolveRegionFromCrosswalk("  Pedia ", "d15", crosswalk), {
    regionCode: "D1",
    regionName: "Delta (1)",
    areaName: "Gharbia 2 (Mahalla)",
  });

  // Region is keyed on the (line, area) PAIR — the same area code under another line is independent.
  assert.equal(resolveRegionFromCrosswalk("anti_infective", "AB1", crosswalk)?.regionCode, "AB");

  // Unknown pair -> null (fail closed; the caller keeps the prior value / surfaces it).
  assert.equal(resolveRegionFromCrosswalk("pedia", "ZZ9", crosswalk), null);
  assert.equal(resolveRegionFromCrosswalk(null, "D14", crosswalk), null);
  assert.equal(resolveRegionFromCrosswalk("pedia", null, crosswalk), null);

  // A region code with no name row still resolves the code (name null), not a crash.
  const partial = buildRegionCrosswalk(
    [{ line_code: "cns", area_code: "X1", area_name: "Somewhere", operational_region_code: "ZZ" }],
    [],
  );
  assert.deepEqual(resolveRegionFromCrosswalk("cns", "X1", partial), {
    regionCode: "ZZ",
    regionName: null,
    areaName: "Somewhere",
  });

  // Rows missing line/area/region are ignored when building the crosswalk.
  const dirty = buildRegionCrosswalk(
    [
      { line_code: "", area_code: "A1", area_name: "x", operational_region_code: "R1" },
      { line_code: "l1", area_code: "", area_name: "x", operational_region_code: "R1" },
      { line_code: "l1", area_code: "A1", area_name: "x", operational_region_code: "" },
    ],
    [{ region_code: "R1", region_name: "Region One" }],
  );
  assert.equal(dirty.byLineArea.size, 0);

  // Key helper normalizes both parts.
  assert.equal(lineAreaKey(" Pedia ", " D14 "), "pedia::d14");

  // employeeRegionFields (what the write path persists): a resolved region overrides the free-text
  // fallback name and carries the code; an unresolved region keeps the fallback and stores no code.
  assert.deepEqual(
    employeeRegionFields({ regionCode: "D1", regionName: "Delta (1)", areaName: "Tanta" }, "Free Text"),
    { region_name: "Delta (1)", region_code: "D1" },
  );
  assert.deepEqual(
    employeeRegionFields({ regionCode: "ZZ", regionName: null, areaName: "x" }, "Fallback Name"),
    { region_name: "Fallback Name", region_code: "ZZ" },
  );
  assert.deepEqual(employeeRegionFields(null, "Kept Free Text"), {
    region_name: "Kept Free Text",
    region_code: null,
  });
  assert.deepEqual(employeeRegionFields(null, null), { region_name: null, region_code: null });
}
