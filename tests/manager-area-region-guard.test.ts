import assert from "node:assert/strict";

import {
  type AreaRow,
  type ManagerRow,
  type TeamRow,
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

/** Teams: the region team sits ON the region area and takes its name; rep teams hang off rep areas. */
const TEAMS: TeamRow[] = [
  { teamId: 24, teamName: "Delta (1)", areaId: 29 },
  { teamId: 80, teamName: "Delta (1)", areaId: 1101 },
  { teamId: 125, teamName: "Upper Egypt 1", areaId: 1149 },
];

function manager(over: Partial<ManagerRow> = {}): ManagerRow {
  return {
    hrId: "B-1",
    fullName: "A Manager",
    jobTitle: "District Sales Manager",
    regionName: "Delta (1)",
    areaId: 29,
    areaName: "Delta (1)",
    teamId: 24,
    teamName: "Delta (1)",
    teamAreaId: 29,
    teamAreaName: "Delta (1)",
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
  assert.equal(isRegionOwningTitle("district manager"), true, "matching is case-insensitive");

  // ---------------------------------------------------------------------------------------
  // A REGIONAL manager owns SEVERAL regions, so the premise of this whole check does not hold
  // for him and he must never be flagged.
  //
  // This is not hypothetical. The first version of the list included him, and on 2026-09-11 it
  // reported Pedia's Regional Sales Manager as a defect: he manages three district managers across
  // Alex-BHR, Delta (1) and Delta (2), his region field reads Alex-BHR as an approximation, and his
  // team is named Alex-Delta because that is his actual span. A check that cries wolf about the one
  // row it does not understand is a check people learn to ignore.
  // ---------------------------------------------------------------------------------------
  assert.equal(isRegionOwningTitle("Regional Sales Manager"), false, "a regional manager owns several regions");
  assert.equal(isRegionOwningTitle("Regional Manager"), false);
  assert.equal(isRegionOwningTitle("National Sales Manager"), false, "a national manager owns a line, not a region");

  assert.deepEqual(
    detectManagerAreaDrift(
      [manager({
        hrId: "PD-0001",
        fullName: "A Regional Manager",
        jobTitle: "Regional Sales Manager",
        regionName: "Delta (1)",
        areaId: 1101,
        areaName: "Menoufia 1",
        teamId: 80,
        teamName: "Alex-Delta",
        teamAreaId: 1101,
        teamAreaName: "Menoufia 1",
      })],
      AREAS,
      TEAMS,
    ),
    [],
    "a regional manager is out of scope on BOTH halves, area and team",
  );

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

  // ---------------------------------------------------------------------------------------
  // The same drift, one table over: the TEAM.
  //
  // This half is nastier than the area half, because the team's NAME can be perfectly correct
  // while the team itself hangs off a rep area — which is exactly what five managers carried on
  // 2026-09-11, three of them on a "Delta (1)" team attached to Menoufia 1. Nothing on screen
  // looks wrong, so only a check that compares the team's AREA can see it.
  // ---------------------------------------------------------------------------------------
  const teamDrift = detectManagerAreaDrift(
    [manager({ hrId: "B-12", teamId: 80, teamName: "Delta (1)", teamAreaId: 1101, teamAreaName: "Menoufia 1" })],
    AREAS,
    TEAMS,
  );
  assert.equal(teamDrift.length, 1, "a manager on a rep-area team must be reported");
  assert.equal(teamDrift[0].kind, "manager_team_is_not_region");
  assert.equal(
    teamDrift[0].kind === "manager_team_is_not_region" ? teamDrift[0].expectedTeamId : null,
    24,
    "the finding must name the team on the region's own area",
  );
  assert.match(
    teamDrift[0].detail,
    /Menoufia 1/,
    "the detail must name the area the team wrongly hangs off",
  );

  // The team NAME matching is not enough on its own — this is the trap the check exists for.
  assert.equal(
    teamDrift[0].kind === "manager_team_is_not_region" ? teamDrift[0].teamName : null,
    "Delta (1)",
    "the wrong team carries the RIGHT name, which is why the screen shows nothing amiss",
  );

  // A manager already on his region's team is clean.
  assert.deepEqual(detectManagerAreaDrift([manager()], AREAS, TEAMS), [], "the region team is correct");

  // A region with no team on its own area is reported once, naming who is stranded.
  const noTeam = detectManagerAreaDrift(
    [
      manager({ hrId: "PD-1", regionName: "Cairo", areaId: 1, areaName: "Cairo", teamId: null, teamName: null, teamAreaId: null, teamAreaName: null }),
      manager({ hrId: "AI-1", regionName: "Cairo", areaId: 1, areaName: "Cairo", teamId: null, teamName: null, teamAreaId: null, teamAreaName: null }),
    ],
    AREAS,
    TEAMS,
  );
  assert.equal(noTeam.length, 1, "a region with no team of its own is one finding, not one per manager");
  assert.equal(noTeam[0].kind, "region_has_no_team_row");
  assert.deepEqual(
    noTeam[0].kind === "region_has_no_team_row" ? noTeam[0].managers : [],
    ["AI-1", "PD-1"],
  );

  // OMITTING teams is not the same as passing none. A caller that cannot read teams must omit, or
  // it would report every manager in the company as teamless — the check crying wolf about itself.
  assert.deepEqual(
    detectManagerAreaDrift([manager({ teamId: null, teamName: null, teamAreaId: null, teamAreaName: null })], AREAS),
    [],
    "omitted teams means area-only, never a team finding",
  );
  assert.equal(
    detectManagerAreaDrift([manager({ teamId: null, teamName: null, teamAreaId: null, teamAreaName: null })], AREAS, []).length,
    1,
    "an empty team list DOES mean no team exists, and is a finding",
  );

  // Both halves are independent: a manager can be right on one and wrong on the other, and the
  // area verdict must not swallow the team check.
  const both = detectManagerAreaDrift(
    [manager({ hrId: "B-99", areaId: 1101, areaName: "Menoufia 1", teamId: 80, teamAreaId: 1101, teamAreaName: "Menoufia 1" })],
    AREAS,
    TEAMS,
  );
  assert.equal(both.length, 2, "a manager wrong on both area and team produces both findings");
  assert.deepEqual(
    both.map((f) => f.kind).sort(),
    ["manager_area_is_not_region", "manager_team_is_not_region"],
  );

  const bothSummary = String(describeManagerAreaDrift(both));
  assert.match(bothSummary, /recorded against a rep area/);
  assert.match(bothSummary, /team that hangs off a rep area/);

  // ---------------------------------------------------------------------------------------
  // An ACTING district manager still holds his own rep seat, so the seat rule keeps him on that
  // rep area and its team. `seat-titles.ts` titles him "District Sales Manager" on purpose, so the
  // title alone flagged him every night (Upper Egypt 1's acting manager on Minia 1, 2026-10-25).
  // ---------------------------------------------------------------------------------------
  const acting = manager({
    hrId: "PD-0034",
    fullName: "An Acting Manager",
    regionName: "Upper Egypt 1",
    areaId: 1123,
    areaName: "Minia 1",
    teamId: 109,
    teamName: "Minia 1",
    teamAreaId: 1123,
    teamAreaName: "Minia 1",
  });
  assert.deepEqual(
    detectManagerAreaDrift([acting], AREAS, TEAMS, new Set(["PD-0034"])),
    [],
    "an acting district manager who holds a rep seat keeps that seat's area and team",
  );
  assert.deepEqual(
    detectManagerAreaDrift([acting], AREAS, TEAMS, new Set(["SOMEONE-ELSE"])).map((f) => f.kind).sort(),
    ["manager_area_is_not_region", "manager_team_is_not_region"],
    "the same row WITHOUT a rep seat is still a drifted manager",
  );
  assert.equal(
    detectManagerAreaDrift([acting], AREAS, TEAMS).length,
    2,
    "omitting the rep-seat set keeps the old behaviour",
  );
}
