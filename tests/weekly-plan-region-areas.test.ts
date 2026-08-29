import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  APPROVED_PLANNING_REGIONS,
  approvedRegionsForSeats,
  canonicalPlanningRegionName,
  isSeatEffectiveOn,
  planningAreaBelongsToRegion,
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
 *
 *  4. The REGION list itself must follow the same authority: `APPROVED_PLANNING_REGIONS` is a
 *     shared vocabulary of spellings, not a per-line menu. Applying it unfiltered to every line
 *     is how Anti Infective's Delta 3 (added for the bug above) leaked into CNS and Pedia, whose
 *     organograms have no Delta 3 at all — a second dead-end cascading dropdown one level up.
 *     `approvedRegionsForSeats` scopes the region options to what the plan owner's own line
 *     actually has, exactly the way `planningAreaOptions` already scopes areas.
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

// Anti Infective's new Delta 3 district (au.line_area_map, forward-dated to 2026-09-01). The
// picker has no as-of awareness, so these seats are already live in the model today even though
// the sales/closing side of the split is not effective until September.
const DELTA_3_SEATS = [
  { areaName: "Ismailia", regionCode: "D3", regionName: "Delta (3)" },
  { areaName: "Qalubeya", regionCode: "D3", regionName: "Delta (3)" },
  { areaName: "Sharkia 1", regionCode: "D3", regionName: "Delta (3)" },
  { areaName: "Sharkia 2", regionCode: "D3", regionName: "Delta (3)" },
  { areaName: "Suez", regionCode: "D3", regionName: "Delta (3)" },
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

  // Delta's numbers are NOT district suffixes — they are separate approved regions and
  // must survive canonicalisation rather than collapsing the way Upper Egypt's do.
  assert.equal(canonicalPlanningRegionName("Delta (1)"), "Delta 1");
  assert.equal(canonicalPlanningRegionName("Delta (2)"), "Delta 2");
  assert.equal(canonicalPlanningRegionName("Delta (3)"), "Delta 3");
  assert.equal(canonicalPlanningRegionName("Delta 3"), "Delta 3");
  assert.equal(canonicalPlanningRegionName("delta-3"), "Delta 3");

  assert.equal(canonicalPlanningRegionName("Alex-BHR"), "ALEX-BHR");
  assert.equal(canonicalPlanningRegionName("Cairo"), "Cairo");
  assert.equal(canonicalPlanningRegionName("Giza"), "Giza");

  // Not planning regions — "Others" is a real au_v_regions row and must stay out.
  assert.equal(canonicalPlanningRegionName("Others"), null);
  assert.equal(canonicalPlanningRegionName("Head office"), null);
  assert.equal(canonicalPlanningRegionName(""), null);
  assert.equal(canonicalPlanningRegionName(null), null);

  assert.equal(APPROVED_PLANNING_REGIONS.length, 7, "the approved planning region list is seven regions");
  assert.ok(
    !APPROVED_PLANNING_REGIONS.some((region) => /upper egypt \d/i.test(region)),
    "districts must fold into Upper Egypt, never be added to the approved list",
  );

  // ---------------------------------------------------------------- 2. the rep's own district

  // THE headline case: an Upper Egypt 1 Anti Infective rep gets her own district, whole and
  // nothing but. Beni Suef is in it despite having no rep row carrying that area name.
  const ue1 = planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", { regionCode: "UE-1" });
  assert.deepEqual(ue1, ["Beni Suef", "Minia 1", "Minia 2"]);
  for (const foreign of ["Assuit 1", "Assuit 2", "Sohag1", "Sohag2", "Qena 1", "Qena 2"]) {
    assert.ok(!ue1.includes(foreign), `a UE-1 rep must not be offered ${foreign} (that is UE-2)`);
  }

  // B-1's ACTUAL production row, as of 2026-08-22: area "Minia 1" (a UE-1 area) but
  // region_name "Upper Egypt 2" and a NULL region_code. The area must win — keying off the
  // region columns here would hand her Assuit/Sohag/Qena, which is precisely wrong.
  assert.deepEqual(
    planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", { areaName: "Minia 1", regionCode: null }),
    ["Beni Suef", "Minia 1", "Minia 2"],
    "the owner's AREA must decide the district, not the hand-editable region columns",
  );
  // Same row, with the drifted region code actually present and contradicting the area.
  assert.deepEqual(
    planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", { areaName: "Minia 1", regionCode: "UE-2" }),
    ["Beni Suef", "Minia 1", "Minia 2"],
    "a region code contradicting the area must lose to the area",
  );
  // Area matching ignores case and padding, the way the au model is keyed.
  assert.deepEqual(
    planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", { areaName: "  minia 1 " }),
    ["Beni Suef", "Minia 1", "Minia 2"],
  );
  // An area that is not in the seat map falls back to the region code.
  assert.deepEqual(
    planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", { areaName: "Nowhere", regionCode: "UE-1" }),
    ["Beni Suef", "Minia 1", "Minia 2"],
  );

  // ------------------------------------------- 2b. the seat model outranks both hand-typed fields

  // The AU seat model states the district outright, and it wins over BOTH the area and the
  // region code. This is what makes the narrowing work for the 15 employees — mostly District
  // Sales Managers — whose employee row carries a region word like "Upper Egypt" or "Cairo" in
  // area_name and no region code at all, so neither hand-typed field can place them.
  assert.deepEqual(
    planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", {
      seatRegionCode: "UE-1",
      areaName: "Assuit 1",
      regionCode: "UE-2",
    }),
    ["Beni Suef", "Minia 1", "Minia 2"],
    "the seat model's district must outrank both the area and the region code",
  );
  // A manager whose area_name holds a region word, with the seat model behind them.
  assert.deepEqual(
    planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", {
      seatRegionCode: "UE-1",
      areaName: "Upper Egypt",
      regionCode: null,
    }),
    ["Beni Suef", "Minia 1", "Minia 2"],
    "a manager whose area_name is a region word must still get their own district",
  );
  // THE manager shape that dominates production: area_name is a region word ("Cairo", "Giza",
  // "Upper Egypt", "Delta (1)" — 22 of the 25 active DSM/NSM rows), no region code, and no seat
  // behind them either. Nothing can place them, so they get the whole region rather than an
  // empty picker. Pinned so the fallback stays deliberate rather than accidental.
  assert.equal(
    planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", { areaName: "Upper Egypt" }).length,
    9,
    "an unplaceable manager gets the whole region, never an empty picker",
  );
  assert.equal(
    planningAreaOptions(ANTI_INFECTIVE_SEATS, "Cairo", { areaName: "Cairo" }).length,
    2,
    "the same holds in a region with no district split",
  );
  // A composite territory that is nobody's seat area ("Fayoum-Beni Suef", carried by two live
  // reps) must still reach the region code rather than dead-ending on the failed area match.
  assert.deepEqual(
    planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", {
      areaName: "Fayoum-Beni Suef",
      regionCode: "UE-1",
    }),
    ["Beni Suef", "Minia 1", "Minia 2"],
  );
  // A blank seat district must FALL THROUGH to the next authority, not pin the answer to "".
  assert.deepEqual(
    planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", { seatRegionCode: "   ", regionCode: "UE-1" }),
    ["Beni Suef", "Minia 1", "Minia 2"],
    "a blank seat district must not swallow the region code",
  );
  assert.deepEqual(
    planningAreaOptions(
      [{ areaName: "Minia 1", regionCode: "", regionName: "Upper Egypt 1" }, ...ANTI_INFECTIVE_SEATS],
      "Upper Egypt",
      { areaName: "Minia 1", regionCode: "UE-1" },
    ),
    ["Beni Suef", "Minia 1", "Minia 2"],
    "a seat with a blank region code must not swallow the region code either",
  );
  // An area name matching seats in TWO districts is ambiguous, so it resolves to neither and
  // falls through — never to whichever row happened to come first.
  assert.equal(
    planningAreaOptions(
      [{ areaName: "Minia 1", regionCode: "UE-2", regionName: "Upper Egypt 2" }, ...ANTI_INFECTIVE_SEATS],
      "Upper Egypt",
      { areaName: "Minia 1" },
    ).length,
    9,
    "an area mapped to two districts must not silently pick one by row order",
  );

  // ------------------------------------------------- 2c. the server-side area check
  // Only a KNOWN area filed under the WRONG region is rejected. Legacy spellings the seat map
  // has never heard of pass, because 48 of the 325 live plan rows carry one.
  assert.equal(planningAreaBelongsToRegion(ANTI_INFECTIVE_SEATS, "Upper Egypt", "Minia 1"), true);
  assert.equal(planningAreaBelongsToRegion(ANTI_INFECTIVE_SEATS, "Upper Egypt", "  minia 1 "), true);
  assert.equal(
    planningAreaBelongsToRegion(ANTI_INFECTIVE_SEATS, "Cairo", "Minia 1"),
    false,
    "an Upper Egypt area chosen under Cairo must be rejected",
  );
  assert.equal(
    planningAreaBelongsToRegion(ANTI_INFECTIVE_SEATS, "Delta 1", "Gharbia (1)"),
    true,
    "a legacy spelling the seat map does not know must pass, not block a submission",
  );
  assert.equal(planningAreaBelongsToRegion(ANTI_INFECTIVE_SEATS, "Upper Egypt", null), true);
  assert.equal(planningAreaBelongsToRegion([], "Upper Egypt", "Minia 1"), true, "no seat map = no check");

  // The mirror case: a UE-2 rep gets UE-2 and never Minia or Beni Suef.
  const ue2 = planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", { regionCode: "UE-2" });
  assert.deepEqual(ue2, ["Assuit 1", "Assuit 2", "Qena 1", "Qena 2", "Sohag1", "Sohag2"]);
  assert.ok(!ue2.includes("Beni Suef"), "a UE-2 rep must not be offered Beni Suef (that is UE-1)");

  // A line with no district split keeps the whole region.
  assert.deepEqual(planningAreaOptions(CNS_SEATS, "Upper Egypt", { regionCode: "UE" }), [
    "Assuit 1",
    "Minia 1",
    "Minia 2",
    "Qena 1",
  ]);

  // Region case and stored spelling do not matter — the canonicaliser decides.
  assert.deepEqual(planningAreaOptions(ANTI_INFECTIVE_SEATS, "upper egypt", { regionCode: "UE-1" }), [
    "Beni Suef",
    "Minia 1",
    "Minia 2",
  ]);
  assert.deepEqual(planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", { regionCode: "ue-1" }), [
    "Beni Suef",
    "Minia 1",
    "Minia 2",
  ]);

  // ---------------------------------------------------------------- 3. planning outside the district

  // Picking a region the rep's district is not in offers that whole region rather than an
  // empty list — an empty picker is the bug this whole change exists to end.
  assert.deepEqual(planningAreaOptions(ANTI_INFECTIVE_SEATS, "Cairo", { regionCode: "UE-1" }), ["Heliopolis", "Nasr City"]);

  // An unknown/blank own district also falls back to the whole region rather than nothing.
  assert.equal(planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", null).length, 9);
  assert.equal(planningAreaOptions(ANTI_INFECTIVE_SEATS, "Upper Egypt", { regionCode: "ZZ" }).length, 9);

  // Delta 3 must be selectable and return its own areas — the region this fix exists for. An
  // Anti Infective NSM with no district of his own (a manager row) must not get an empty picker.
  assert.deepEqual(
    planningAreaOptions([...ANTI_INFECTIVE_SEATS, ...DELTA_3_SEATS], "Delta 3", { regionCode: "UE-1" }),
    ["Ismailia", "Qalubeya", "Sharkia 1", "Sharkia 2", "Suez"],
    "Delta 3 must offer its own areas, not silently canonicalise to null",
  );

  // ------------------------------------------- 3b. the region picker must follow the seat model
  //
  // Not the fix for one missing region — the fix for the CLASS of bug. Anti Infective's Delta 3
  // has no CNS/Pedia counterpart (verified live 2026-08-28: zero `D3` rows in `au.line_area_map`
  // for either line), so a region list applied unfiltered to every line would offer CNS/Pedia a
  // "Delta 3" that then resolves to zero areas — a second dead-end cascading dropdown, the exact
  // complaint that motivated the Delta 3 fix, recurring one level up. The region options MUST be
  // derived from the same per-line seat model the area options already come from.
  assert.deepEqual(
    approvedRegionsForSeats([...ANTI_INFECTIVE_SEATS, ...DELTA_3_SEATS]),
    ["Cairo", "Delta 3", "Upper Egypt"],
    "Anti Infective's own seats must offer Delta 3",
  );
  assert.ok(
    !approvedRegionsForSeats(CNS_SEATS).includes("Delta 3"),
    "CNS has no Delta 3 seats and must never offer a region that dead-ends on zero areas",
  );
  assert.deepEqual(approvedRegionsForSeats(CNS_SEATS), ["Upper Egypt"], "CNS offers only the regions its own seats cover");

  // An unreachable/empty seat map falls back to the full approved list — an empty region picker
  // is worse than an over-wide one, the same reasoning areasForRegion already applies one level
  // down for the roster fallback.
  assert.deepEqual(approvedRegionsForSeats([]), [...APPROVED_PLANNING_REGIONS]);

  // "Others" is not plannable under any region.
  for (const region of APPROVED_PLANNING_REGIONS) {
    assert.ok(
      !planningAreaOptions(ANTI_INFECTIVE_SEATS, region, null).includes("Main Store"),
      `"Others" areas must never be offered (leaked into ${region})`,
    );
  }

  // No region chosen yet -> no areas, whatever the seat map holds.
  assert.deepEqual(planningAreaOptions(ANTI_INFECTIVE_SEATS, "", { regionCode: "UE-1" }), []);
  assert.deepEqual(planningAreaOptions(ANTI_INFECTIVE_SEATS, "Others", { regionCode: "UE-1" }), []);

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

  // ------------------------------------------- 4b. forward-dated seat rows

  // `effective_to is null` does NOT mean "in force today". The Anti Infective Delta (3) split
  // was entered with effective_from = 2026-09-01 and appeared in the picker on 28 Aug, four days
  // early. approvedRegionsForSeats derives the Region list from these same rows, so the one
  // missing predicate leaked the split into the Area AND the Region dropdown at once.
  assert.equal(isSeatEffectiveOn(null, "2026-08-28"), true, "no start date = always in force");
  assert.equal(isSeatEffectiveOn("", "2026-08-28"), true, "blank start date = always in force");
  assert.equal(isSeatEffectiveOn("  ", "2026-08-28"), true, "whitespace start date = always in force");
  assert.equal(isSeatEffectiveOn("2026-07-01", "2026-08-28"), true, "a past start date is in force");
  assert.equal(isSeatEffectiveOn("2026-08-28", "2026-08-28"), true, "in force on its own start date");
  assert.equal(isSeatEffectiveOn("2026-09-01", "2026-08-28"), false, "a forward-dated row is NOT in force");

  // The real 2026-08-28 shape: Delta 2 already live, Delta 3 dated forward to 1 Sep.
  const splitSeats = [
    { areaName: "Dakahlia 1", effectiveFrom: null, regionCode: "D2", regionName: "Delta (2)" },
    { areaName: "Sharkia 1", effectiveFrom: "2026-09-01", regionCode: "D3", regionName: "Delta (3)" },
    { areaName: "Suez", effectiveFrom: "2026-09-01", regionCode: "D3", regionName: "Delta (3)" },
  ];
  const inForceOn = (asOf: string) =>
    splitSeats.filter((seat) => isSeatEffectiveOn(seat.effectiveFrom, asOf));

  assert.deepEqual(
    inForceOn("2026-08-28").map((seat) => seat.areaName),
    ["Dakahlia 1"],
    "on 28 Aug the Area picker must not offer Sharkia 1 or Suez",
  );
  assert.deepEqual(
    approvedRegionsForSeats(inForceOn("2026-08-28")),
    ["Delta 2"],
    "on 28 Aug the Region picker must not offer Delta 3 either",
  );
  assert.deepEqual(
    approvedRegionsForSeats(inForceOn("2026-09-01")),
    ["Delta 2", "Delta 3"],
    "on 1 Sep the split is in force and Delta 3 becomes selectable",
  );

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
    /planningAreaOptions\(source\.seats, region, source\.owner\)[\s\S]{0,200}planningAreasForRegion\(source\.roster/,
    "areasForRegion must try the seat model first and fall back to the roster",
  );

  // The REGION picker must follow the same per-line seat model as the area picker beneath it,
  // not a flat list shared by every line — that mismatch is what let a region with zero areas
  // for a given line (Delta 3 for CNS/Pedia) be offered as a selectable option at all.
  assert.match(
    workspaceSrc,
    /approvedRegionsForSeats\(source\.seats\)/,
    "the region picker must derive its options from the plan owner's own line seats",
  );
  assert.ok(
    !/\bAPPROVED_PLANNING_REGIONS\b/.test(workspaceSrc),
    "the client must not read the flat approved-region list directly — every consumer scopes it through the seat model",
  );
  assert.ok(
    !/\bworkplaceRegions\b/.test(serviceSrc),
    "the directory-derived region list must not come back — it read employees.region_name, not the AU seat model, and was never wired to the client",
  );
  // All THREE district authorities have to reach the client, in order. Each is pinned
  // separately: the seat code is the one that resolves for 15 people the others miss, the area
  // is second, and the region code is the ONLY route for the 8 field-force employees whose area
  // is blank or unknown to the seat map — Hanan Safwat (AI-0012, Beni Suef) among them, which
  // is the rep the original empty-picker bug was about.
  assert.match(serviceSrc, /seatRegionCode: ownSeatRegionCode/, "the payload must carry the owner's seat district");
  assert.match(serviceSrc, /areaName: employee\.areaName/, "the payload must carry the owner's area");
  assert.match(serviceSrc, /regionCode: employee\.regionCode \?\? null/, "the payload must carry the owner's region code");
  assert.match(serviceSrc, /planningAreaSeats,/, "the payload must carry the seat map");
  // Passing the whole employee row is what keeps those three from drifting apart — the picker
  // must not be handed a hand-copied subset of it.
  assert.match(
    workspaceSrc,
    /owner: workspace\.currentEmployee,/,
    "the Area picker must be given the owner's whole employee row",
  );
  assert.ok(
    !/ownSeat/.test(workspaceSrc),
    "the owner's row must be held once, not copied into a second ownSeat field",
  );

  // The seat model must be read for the two things the employee roster cannot answer: which
  // district the owner is in, and which area a rep with a blank area_name actually covers.
  assert.match(loaderSrc, /from\("au_v_employee_seat_drift"\)/, "the seat directory must read the AU seat view");
  assert.match(
    serviceSrc,
    /areaName: candidate\.areaName\?\.trim\(\) \|\| seats\?\.areaByHrId\.get/,
    "a rep with a blank area_name must fall back to the area their AU seat covers",
  );

  // The submit path must check the area server-side; the picker narrowing is not enforcement.
  assert.match(
    serviceSrc,
    /planningAreaBelongsToRegion\(options\.planningSeats \?\? \[\], locationText, area\)/,
    "submitting must reject an area filed under a different region",
  );

  // The loader must actually apply the predicate — the pure function passing proves nothing
  // if the query never reads the column or the loop never calls it.
  assert.ok(
    loaderSrc.includes("effective_from,effective_to"),
    "the seat loader must select effective_from, not only effective_to",
  );
  assert.ok(
    loaderSrc.includes("if (!isSeatEffectiveOn(row.effective_from, asOfDate)) continue;"),
    "the seat loader must skip seat rows that are not in force yet",
  );
  assert.ok(
    loaderSrc.includes("asOfDate: string = currentCairoDateOnlyIso()"),
    "the loader's as-of date must default to Africa/Cairo today",
  );
}
