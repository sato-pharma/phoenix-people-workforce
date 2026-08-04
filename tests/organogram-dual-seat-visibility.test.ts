import assert from "node:assert/strict";

import {
  buildOrganogramLanes,
  rowKey,
  type OrganogramRow,
} from "../src/lib/reports/organogram-view-model.ts";

// Regression: 2026-08-01, AI-0005 was auto-seated on two au seats at once. Both rows
// rendered with the same rowKey (type + hrId + null sourceRowNumber), so every lane
// sink deduplicated the second box away and one seat silently VANISHED from the
// organogram. rowKey now includes the au seatId; a double-seated person must render
// as two visible boxes — loud, never hidden.

function auRow(overrides: Partial<OrganogramRow> & Pick<OrganogramRow, "hrId" | "seatId">): OrganogramRow {
  const name = overrides.fullName ?? overrides.hrId;
  return {
    areaId: null,
    areaName: null,
    departmentId: null,
    departmentName: null,
    displayName: name,
    fullName: name,
    hireDate: null,
    jobTitle: "Medical Representative",
    lineId: 1,
    lineName: "Anti Infective",
    managerHrId: null,
    managerReplacementForHrId: null,
    managerName: null,
    positionId: null,
    positionTitle: "Medical Representative",
    regionName: "Cairo",
    replacementForHrId: null,
    sourceRowNumber: null,
    status: "active",
    teamId: null,
    teamName: null,
    type: "employee",
    vacancyCode: null,
    ...overrides,
  };
}

function memberBoxesFor(hrId: string, lanes: ReturnType<typeof buildOrganogramLanes>): number {
  let count = 0;
  for (const group of lanes.groups) {
    count += group.members.filter((member) => member.hrId === hrId).length;
    for (const child of group.childLanes ?? []) {
      count += child.members.filter((member) => member.hrId === hrId).length;
    }
  }
  return count;
}

export function runOrganogramDualSeatVisibilityTests() {
  const nsm = auRow({
    hrId: "NSM-1",
    seatId: "SEAT-T-NSM",
    jobTitle: "National Sales Manager",
    positionTitle: "National Sales Manager",
  });
  const dmA = auRow({
    hrId: "DM-A",
    seatId: "SEAT-T-DM-A",
    jobTitle: "District Sales Manager",
    positionTitle: "District Sales Manager",
    managerHrId: "NSM-1",
    managerName: "NSM-1",
  });
  const dmB = auRow({
    hrId: "DM-B",
    seatId: "SEAT-T-DM-B",
    jobTitle: "District Sales Manager",
    positionTitle: "District Sales Manager",
    managerHrId: "NSM-1",
    managerName: "NSM-1",
  });
  const repOnSeatOne = auRow({
    hrId: "REP-X",
    seatId: "SEAT-T-REP-1",
    areaName: "Area One",
    managerHrId: "DM-A",
    managerName: "DM-A",
  });
  const repOnSeatTwo = auRow({
    hrId: "REP-X",
    seatId: "SEAT-T-REP-2",
    areaName: "Area Two",
    managerHrId: "DM-B",
    managerName: "DM-B",
  });

  assert.notEqual(
    rowKey(repOnSeatOne),
    rowKey(repOnSeatTwo),
    "two au seats held by one person must produce distinct row keys - identical keys are what made a refilled seat vanish (AI-0005, 2026-08-01)",
  );

  const lanes = buildOrganogramLanes([nsm, dmA, dmB, repOnSeatOne, repOnSeatTwo]);
  assert.equal(
    memberBoxesFor("REP-X", lanes),
    2,
    "a double-seated person renders one box per seat - the second box must never be silently deduplicated away",
  );

  // The vacant half of the invariant: a vacant seat renders under its own seat_id key,
  // which is unique by construction, so it can never collide with anything.
  const vacantSeat = auRow({
    hrId: "SEAT-T-REP-3",
    seatId: "SEAT-T-REP-3",
    type: "vacancy",
    status: "open",
    areaName: "Area Three",
    managerHrId: "DM-A",
    managerName: "DM-A",
  });
  const lanesWithVacancy = buildOrganogramLanes([nsm, dmA, dmB, repOnSeatOne, vacantSeat]);
  assert.equal(
    memberBoxesFor("SEAT-T-REP-3", lanesWithVacancy),
    1,
    "a vacant seat keeps rendering as exactly one box",
  );
}
