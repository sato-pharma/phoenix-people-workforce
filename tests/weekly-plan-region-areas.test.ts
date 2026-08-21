import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  APPROVED_PLANNING_REGIONS,
  canonicalPlanningRegionName,
  planningAreaOptions,
  planningAreasForRegion,
} from "../src/lib/weekly-planning/regions.ts";

/**
 * Regression cover for the Area picker on the employee weekly plan.
 *
 * An Anti Infective rep in Upper Egypt 1 could not submit a plan at all: the picker rendered
 * with zero options, so "Single Visit needs an area" was an error she had no way to satisfy.
 * Two things were wrong, and a third would have been wrong if only the first were fixed.
 *
 *  1. `employees.region_name` / the AU region codes split line 1's Upper Egypt into
 *     "Upper Egypt 1" (UE-1) and "Upper Egypt 2" (UE-2); CNS and Pedia keep one undivided
 *     "Upper Egypt" (UE). The canonicaliser matched only the plain spelling, so neither
 *     district belonged to any planning region and no areas were offered.
 *
 *  2. Areas were derived from the Medical Rep employee roster, which cannot see an area whose
 *     occupant has a blank `area_name` — Beni Suef is exactly that case — and which excludes
 *     the plan owner, so a rep could never pick the area they themselves cover.
 *
 *  3. Folding UE-1 and UE-2 into one region must NOT hand a UE-1 rep the UE-2 areas. A rep
 *     plans inside their own DM district.
 */

// The live Anti Infective seat map (au_v_line_area_map + au_v_regions), which is what the
// picker now reads.
const ANTI_INFECTIVE_SEATS = [
  { areaName: "Minia 1", regionCode: "UE-1", regionName: "Upper Egypt 1" },
  { areaName: "Minia 2", regionCode: "UE-1", regionName: "Upper Egypt 1" },
  { areaName: "Beni Suef", regionCode: "UE-1", regionName: "Upper Egypt 1" },
  { areaName: "Assuit 1", regionCode: "UE-2", regionName: "Upper Egypt 2" },
  { areaName: "Assuit 2", regionCode: "UE-2", regionName: "Upper Egypt 2" },
  { areaName: "Sohag1", regionCode: "UE-2", regionName: "Upper Egypt 2" },
  { areaName: "Sohag2", regionCode: "UE-2", regionName: "Upper Egypt 2" },
  { areaName: "Qena 1", regionCode: "UE-2", regionName: "Upper Egypt 2" },
  { areaName: "Qena 2", regionCode: "UE-2", regionName: "Upper Egypt 2" },
  { areaName: "Nasr City", regionCode: "CA", regionName: "Cairo" },
  { areaName: "Heliopolis", regionCode: "CA", regionName: "Cairo" },
  // "Others" is not a planning region and must never surface as a plannable area.
  { areaName: "Main Store", regionCode: "OT", regionName: "Others" },
];

// CNS keeps Upper Egypt undivided — one district code for the whole region.
const CNS_SEATS = [
  { areaName: "Minia 1", regionCode: "UE", regionName: "Upper Egypt" },
  { areaName: "Minia 2", regionCode: "UE", regionName: "Upper Egypt" },
  { areaName: "Assuit 1", regionCode: "UE", regionName: "Upper Egypt" },
  { areaName: "Qena 1", regionCode: "UE", regionName: "Upper Egypt" },
];

export function runWeeklyPlanRegionAreasTests() {
  // ---------------------------------------------------------------- 1. region canonicalisation

  // Both district spellings must belong to the one approved Upper Egypt planning region.
  assert.equal(canonicalPlanningRegionName("Upper Egypt 1"), "Upper Egypt");
  assert.equal(canonicalPlanningRegionName("Upper Egypt 2"), "Upper Egypt");
  // A future district must not silently empty the picker the way 1 and 2 did.
  assert.equal(canonicalPlanningRegionName("Upper Egypt 3"), "Upper Egypt");
  assert.equal(canonicalPlanningRegionName("upper egypt"), "Upper Egypt");

  // Delta's numbers are NOT district suffixes — they are two separate approved regions and
  // must survive canonicalisation rather than collapsing the way Upper Egypt's do.
  assert.equal(canonicalPlanningRegionName("Delta (1)"), "Delta 1");
  assert.equal(canonicalPlanningRegionName("Delta (2)"), "Delta 2");

  assert.equal(canonicalPlanningRegionName("Alex-BHR"), "ALEX-BHR");
  assert.equal(canonicalPlanningRegionName("Cairo"), "Cairo");
  assert.equal(canonicalPlanningRegionName("Giza"), "Giza");

  // Not planning regions — "Others" is a real au_v_regions row and must stay out.
  assert.equal(canonicalPlanningRegionName("Others"), null);
  assert.equal(canonicalPlanningRegionName("Head office"), null);
  assert.equal(canonicalPlanningRegionName(""), null);
  assert.equal(canonicalPlanningRegionName(null), null);

  assert.equal(APPROVED_PLANNING_REGIONS.length, 6, "the approved planning region list is six regions");
  assert.ok(
    !APPROVED_PLANNING_REGIONS.some((region) => /upper egypt \d/i.test(region)),
    "districts must fold into Upper Egypt, never be added to the approved list",
  );

  // ---------------------------------------------------------------- 2. the rep's own district

  // THE headline case: an Upper Egypt 1 Anti Infective rep gets her own district, whole and
  // nothing but. Beni Suef is in it despite having no rep row carrying that area name.
  const ue1 = planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", "UE-1");
  assert.deepEqual(ue1, ["Beni Suef", "Minia 1", "Minia 2"]);
  for (const foreign of ["Assuit 1", "Assuit 2", "Sohag1", "Sohag2", "Qena 1", "Qena 2"]) {
    assert.ok(!ue1.includes(foreign), `a UE-1 rep must not be offered ${foreign} (that is UE-2)`);
  }

  // The mirror case: a UE-2 rep gets UE-2 and never Minia or Beni Suef.
  const ue2 = planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", "UE-2");
  assert.deepEqual(ue2, ["Assuit 1", "Assuit 2", "Qena 1", "Qena 2", "Sohag1", "Sohag2"]);
  assert.ok(!ue2.includes("Beni Suef"), "a UE-2 rep must not be offered Beni Suef (that is UE-1)");

  // A line with no district split keeps the whole region.
  assert.deepEqual(planningAreaOptions(CNS_SEATS, "Upper Egypt", "UE"), [
    "Assuit 1",
    "Minia 1",
    "Minia 2",
    "Qena 1",
  ]);

  // Region case and stored spelling do not matter — the canonicaliser decides.
  assert.deepEqual(planningAreaOptions(ANTI_INFECTIVE_SEATS, "upper egypt", "UE-1"), [
    "Beni Suef",
    "Minia 1",
    "Minia 2",
  ]);
  assert.deepEqual(planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", "ue-1"), [
    "Beni Suef",
    "Minia 1",
    "Minia 2",
  ]);

  // ---------------------------------------------------------------- 3. planning outside the district

  // Picking a region the rep's district is not in offers that whole region rather than an
  // empty list — an empty picker is the bug this whole change exists to end.
  assert.deepEqual(planningAreaOptions(ANTI_INFECTIVE_SEATS, "Cairo", "UE-1"), ["Heliopolis", "Nasr City"]);

  // An unknown/blank own district also falls back to the whole region rather than nothing.
  assert.equal(planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", null).length, 9);
  assert.equal(planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", "ZZ").length, 9);

  // "Others" is not plannable under any region.
  for (const region of APPROVED_PLANNING_REGIONS) {
    assert.ok(
      !planningAreaOptions(ANTI_INFECTIVE_SEATS, region, null).includes("Main Store"),
      `"Others" areas must never be offered (leaked into ${region})`,
    );
  }

  // No region chosen yet -> no areas, whatever the seat map holds.
  assert.deepEqual(planningAreaOptions(ANTI_INFECTIVE_SEATS, "", "UE-1"), []);
  assert.deepEqual(planningAreaOptions(ANTI_INFECTIVE_SEATS, "Others", "UE-1"), []);

  // ---------------------------------------------------------------- 4. the roster fallback

  // Only reached when the seat map could not be loaded. It still must include the plan
  // owner's own area, which the roster never carries (the roster is the Double Visit partner
  // pool, and nobody may partner with themselves).
  const roster = [
    { areaName: "Minia 2", regionName: "Upper Egypt 1" },
    { areaName: null, regionName: "Upper Egypt 1" },
  ];
  assert.deepEqual(planningAreasForRegion(roster, "Upper Egypt", { areaName: "Minia 1", regionName: "Upper Egypt 1" }), [
    "Minia 1",
    "Minia 2",
  ]);
  assert.deepEqual(planningAreasForRegion([], "Upper Egypt", { areaName: "Minia 1", regionName: "Upper Egypt 1" }), [
    "Minia 1",
  ]);
  assert.deepEqual(planningAreasForRegion(roster, "Cairo", null), []);

  // ---------------------------------------------------------------- 5. wiring

  const serviceSrc = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  const workspaceSrc = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  const loaderSrc = readFileSync("src/lib/weekly-planning/planning-areas.ts", "utf8");

  // The duplicate copy of the canonicaliser is what let this survive in the UI while the
  // server looked correct. Both consumers must read the shared module.
  for (const [label, src] of [
    ["service.ts", serviceSrc],
    ["plans-workspace.tsx", workspaceSrc],
  ] as const) {
    assert.match(
      src,
      /from "@\/lib\/weekly-planning\/regions"/,
      `${label} must take the planning region vocabulary from the shared module`,
    );
    assert.ok(
      !/"alex\/bhr"/.test(src),
      `${label} must not re-implement the region canonicaliser (found an inline spelling table)`,
    );
  }

  // The seat model is the authority, and it must be read from the currently-effective rows
  // for the plan owner's own line.
  assert.match(loaderSrc, /from\("au_v_line_area_map"\)/, "the loader must read the AU seat map");
  assert.match(loaderSrc, /\.is\("effective_to", null\)/, "the loader must take only currently-effective seats");
  assert.match(loaderSrc, /\.eq\("line_code", lineCode\)/, "the loader must scope seats to the plan owner's line");

  // The picker must prefer the seat model and keep the roster only as a fallback.
  assert.match(
    workspaceSrc,
    /planningAreaOptions\(source\.seats, region, source\.ownRegionCode\)[\s\S]{0,200}planningAreasForRegion\(source\.roster/,
    "areasForRegion must try the seat model first and fall back to the roster",
  );
  // The owner's district code has to actually reach the client for the narrowing to work.
  assert.match(serviceSrc, /regionCode: employee\.regionCode \?\? null/, "the payload must carry the owner's region code");
  assert.match(serviceSrc, /planningAreaSeats,/, "the payload must carry the seat map");
  assert.match(
    workspaceSrc,
    /ownRegionCode: workspace\.currentEmployee\?\.regionCode \?\? null/,
    "the Area picker must be given the owner's district code",
  );
}
