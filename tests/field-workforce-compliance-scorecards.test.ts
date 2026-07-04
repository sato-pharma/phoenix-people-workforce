import { strict as assert } from "node:assert";

import {
  buildFieldWorkforceLineScorecards,
  buildFieldWorkforceManagerScorecards,
} from "../src/lib/field-workforce-compliance/scorecards.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scorecardEmployee = (overrides: Record<string, unknown>): any => ({
  areaName: null, campaignDays: 0, compliancePercent: 80, employeeName: "x",
  employmentStatus: "active", eligibleWorkingDays: 20, fridays: 4, hiringDateIso: "2024-01-01",
  hiringDateSource: "employee_directory", holidayWarnings: 0, hrId: "x", lineName: null,
  managerHrId: null, managerName: null, matchedEmployeeName: "x", matchedHrId: "x",
  matchStatus: "matched", noActivityCandidates: 0,
  noActivityPattern: { adjacentToFridayDates: [], adjacentToPublicHolidayDates: [], consecutiveSignalCount: 0, hasThreeDayStreak: false, hasTwoDayStreak: false, highMonthlyCount: false, longestStreak: 0, summary: "" },
  preHireIgnoredValues: 0, roleName: null, severityCounts: { High: 0, Low: 0, Medium: 0, Review: 0 },
  sourceRowNumber: 1, teamName: null, timeline: [], totalVisits: 5, unknownValues: 0,
  vacationSignalDays: 0, workedDays: 12,
  ...overrides,
});

export function runFieldWorkforceComplianceScorecardsTests() {
  // --- 2.2 Manager/line scorecards ---
  const employees = [
    scorecardEmployee({ hrId: "E-1", managerName: "Manager A", lineName: "Line X", compliancePercent: 100, noActivityCandidates: 0, severityCounts: { High: 0, Low: 0, Medium: 0, Review: 0 } }),
    scorecardEmployee({ hrId: "E-2", managerName: "Manager A", lineName: "Line X", compliancePercent: 60, noActivityCandidates: 3, severityCounts: { High: 1, Low: 0, Medium: 0, Review: 0 } }),
    scorecardEmployee({ hrId: "E-3", managerName: "Manager B", lineName: "Line Y", compliancePercent: 20, noActivityCandidates: 8, severityCounts: { High: 1, Low: 0, Medium: 0, Review: 0 } }),
    // Blank manager/line -> must be bucketed under "Unassigned", never dropped.
    scorecardEmployee({ hrId: "E-4", managerName: null, lineName: "", compliancePercent: 50, noActivityCandidates: 2, severityCounts: { High: 0, Low: 0, Medium: 1, Review: 0 } }),
  ];

  const managerScorecards = buildFieldWorkforceManagerScorecards(employees);
  // Worst-first: Manager B (20%) < Unassigned (50%) < Manager A (avg of 100+60=80%).
  assert.deepEqual(managerScorecards.map((s) => s.groupName), ["Manager B", "Unassigned", "Manager A"], "sorted worst-first by avg compliance");

  const managerB = managerScorecards.find((s) => s.groupName === "Manager B")!;
  assert.equal(managerB.employeeCount, 1);
  assert.equal(managerB.avgCompliancePercent, 20);
  assert.equal(managerB.totalNoActivityCandidates, 8);
  assert.equal(managerB.totalHighSeverityCount, 1);
  assert.equal(managerB.flaggedEmployeeCount, 1, "E-3 has a High-severity day");

  const managerA = managerScorecards.find((s) => s.groupName === "Manager A")!;
  assert.equal(managerA.employeeCount, 2);
  assert.equal(managerA.avgCompliancePercent, 80, "average of 100 and 60");
  assert.equal(managerA.totalNoActivityCandidates, 3, "sum of both members' no-activity counts");
  assert.equal(managerA.flaggedEmployeeCount, 1, "only E-2 has a High-severity day, E-1 doesn't");

  const unassigned = managerScorecards.find((s) => s.groupName === "Unassigned")!;
  assert.equal(unassigned.employeeCount, 1, "a blank managerName is bucketed under Unassigned, not dropped");

  const lineScorecards = buildFieldWorkforceLineScorecards(employees);
  assert.deepEqual(lineScorecards.map((s) => s.groupName), ["Line Y", "Unassigned", "Line X"], "line grouping uses lineName, same worst-first ordering");
  const lineX = lineScorecards.find((s) => s.groupName === "Line X")!;
  assert.equal(lineX.employeeCount, 2, "E-1 and E-2 share Line X");

  assert.deepEqual(buildFieldWorkforceManagerScorecards([]), [], "no employees -> empty scorecard list, not an error");

  // Tie-break: two groups with identical avgCompliancePercent sort alphabetically by group name.
  const tiedEmployees = [
    scorecardEmployee({ hrId: "T-1", managerName: "Zeta Manager", compliancePercent: 70 }),
    scorecardEmployee({ hrId: "T-2", managerName: "Alpha Manager", compliancePercent: 70 }),
  ];
  const tiedScorecards = buildFieldWorkforceManagerScorecards(tiedEmployees);
  assert.deepEqual(tiedScorecards.map((s) => s.groupName), ["Alpha Manager", "Zeta Manager"], "equal compliance -> alphabetical tie-break");
}
