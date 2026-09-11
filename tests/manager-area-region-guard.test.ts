import assert from "node:assert/strict";

import {
  type AreaRow,
  type ManagerRow,
  describeManagerAreaDrift,
  detectManagerAreaDrift,
  indexRegionShapedAreas,
  isRegionOwningTitle,
} from "../src/lib/org/manager-area-region.ts";

/**
 * A sales manager is recorded against his REGION, never against one of his own rep areas.
 *
 * WHY THIS IS THE ASSERTION THAT MATTERS. `employees.area_id` carries two different meanings and
 * nothing in the schema says which. For a rep it is his territory. For a district manager it is
 * only the key the seating engine matches a vacancy on — he owns a whole region. So a manager
 * sitting on a rep area is indistinguishable from a rep sitting on his own, and every board that
 * groups people by area then shows the manager occupying that patch. The damage is the inverse of
 * an error: the rep seat under him reads as COVERED when it is vacant, which is the one failure
 * nobody goes looking for.
 *
 * Measured on production 2026-09-11: six of eighteen occupied district-manager seats were drifted,
 * and the open Upper Egypt 2 vacancy carried Sohag 1 for the next hire to inherit. Both causes are
 * covered below, because the second one is what makes it spread and it is invisible: a resignation
 * opens a replacement vacancy by copying the LEAVER's area, and the next hire inherits it from the
 * vacancy. Delta (1) proved that half is independent — the correct region area row had existed all
 * along and all three Delta (1) managers were still on Menoufia 1.
 */

const AREAS: AreaRow[] = [
  { areaId: 1, areaName: "Cairo" },
  { areaId: 29, areaName: "Delta (1)" },
  { areaId: 1101, areaName: "Menoufia 1" },
  { areaId: 1123, areaName: "Minia 1" },
  { areaId: 1149, areaName: "Upper Egypt 1" },
];

function manager(over: Partial<ManagerRow> = {}): ManagerRow {
  return {
    hrId: "B-1",
    fullName: "A Manager",
    jobTitle: "District Sales Manager",
    regionName: "Delta (1)",
    areaId: 29,
    areaName: "Delta (1)",
    ...over,
  };
}

export async function runManagerAreaRegionGuardTests() {
  // ---------------------------------------------------------------------------------------
  // The headline: a manager parked on one of his own rep areas is caught.
  // ---------------------------------------------------------------------------------------
  const drifted = detectManagerAreaDrift(
    [manager({ hrId: "B-154", fullName: "A Delta Manager", areaId: 1101, areaName: "Menoufia 1" })],
    AREAS,
  );
  assert.equal(drifted.length, 1, "a manager on a rep area must be reported");
  assert.equal(drifted[0].kind, "manager_area_is_not_region");
  assert.equal(
    drifted[0].kind === "manager_area_is_not_region" ? drifted[0].expectedAreaId : null,
    29,
    "the finding must name the region-shaped area he should carry",
  );
  assert.match(
    drifted[0].detail,
    /Menoufia 1/,
    "the detail must name the area he is wrongly on, so the fix needs no second lookup",
  );

  // ---------------------------------------------------------------------------------------
  // Cause 1: a region that has no area row at all. This is what the Upper Egypt split created,
  // and it is why the migration pinned those vacancies to a member area — there was nothing else
  // to point at. Reported once per region, naming who is affected.
  // ---------------------------------------------------------------------------------------
  const missing = detectManagerAreaDrift(
    [
      manager({ hrId: "PD-1", regionName: "Upper Egypt 2", areaId: 1127, areaName: "Sohag1" }),
      manager({ hrId: "AI-1", regionName: "Upper Egypt 2", areaId: 16, areaName: "Upper Egypt" }),
    ],
    AREAS,
  );
  assert.equal(missing.length, 1, "a region with no area row is one finding, not one per manager");
  assert.equal(missing[0].kind, "region_has_no_area_row");
  assert.deepEqual(
    missing[0].kind === "region_has_no_area_row" ? missing[0].managers : [],
    ["AI-1", "PD-1"],
    "every manager stranded by the missing row must be named",
  );

  // ---------------------------------------------------------------------------------------
  // Clean geography reports nothing. Without this the check could pass by flagging everyone.
  // ---------------------------------------------------------------------------------------
  assert.deepEqual(
    detectManagerAreaDrift(
      [
        manager({ hrId: "B-12" }),
        manager({ hrId: "PD-0014", regionName: "Upper Egypt 1", areaId: 1149, areaName: "Upper Egypt 1" }),
      ],
      AREAS,
    ),
    [],
    "managers already recorded against their region must not be flagged",
  );

  // ---------------------------------------------------------------------------------------
  // A rep is NOT a manager. He holds his own area by design, and flagging him would bury the
  // real findings under sixty-eight false ones.
  // ---------------------------------------------------------------------------------------
  assert.deepEqual(
    detectManagerAreaDrift(
      [manager({ hrId: "B-166", jobTitle: "Medical Representative", areaId: 1101, areaName: "Menoufia 1" })],
      AREAS,
    ),
    [],
    "a medical rep on his own area is correct, never a finding",
  );
  assert.equal(isRegionOwningTitle("Medical Representative"), false);
  assert.equal(isRegionOwningTitle("Product Manager"), false, "a product manager owns no region");
  assert.equal(isRegionOwningTitle("District Sales Manager"), true);
  assert.equal(isRegionOwningTitle("national sales manager"), true, "matching is case-insensitive");

  // ---------------------------------------------------------------------------------------
  // `Others` is the pseudo-district: sales, no target, no seat anyone holds, and legitimately no
  // area row. Reporting it would train the reader to ignore this check.
  // ---------------------------------------------------------------------------------------
  assert.deepEqual(
    detectManagerAreaDrift([manager({ hrId: "OT-1", regionName: "Others", areaId: null, areaName: null })], AREAS),
    [],
    "the Others pseudo-district must never be reported as a missing area row",
  );

  // ---------------------------------------------------------------------------------------
  // Matching is by NAME, case- and whitespace-insensitively, because the two families in
  // `public.areas` share no code convention: region rows are snake_case (`delta_1`) and rep areas
  // are upper-case (`D12`). An id comparison alone would have nothing to compare.
  // ---------------------------------------------------------------------------------------
  const index = indexRegionShapedAreas([
    { areaId: 99, areaName: "  delta (1)  " },
    { areaId: 29, areaName: "Delta (1)" },
  ]);
  assert.equal(index.get("delta (1)")?.areaId, 29, "a duplicate name resolves to the lower id, stably");

  // ---------------------------------------------------------------------------------------
  // The one-line summary the nightly job logs, and the silence when nothing is wrong.
  // ---------------------------------------------------------------------------------------
  assert.equal(describeManagerAreaDrift([]), null, "a clean run must log nothing at all");
  const summary = describeManagerAreaDrift([...drifted, ...missing]);
  assert.match(String(summary), /1 manager\(s\)/);
  assert.match(String(summary), /1 region\(s\)/);
}
