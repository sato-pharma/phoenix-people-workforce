import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildTopCoachingScores } from "../src/lib/coaching/landing-insights.ts";
import type { CoachingReportSummaryRow } from "../src/lib/coaching/types.ts";

function report(repHrId: string, name: string, score: number): CoachingReportSummaryRow {
  return {
    acknowledged: true,
    acknowledgedAt: null,
    actualScore: score,
    areaId: null,
    areaName: null,
    coachHrId: "COACH-1",
    coachName: "Coach",
    coachingDate: "2026-09-10",
    coachingMonth: 9,
    coachingQuarter: 3,
    coachingYear: 2026,
    createdAt: "2026-09-10T00:00:00.000Z",
    finalScorePercent: score,
    lineId: null,
    lineName: null,
    maxScore: 100,
    medicalRepHrId: repHrId,
    medicalRepName: name,
    performanceZone: null,
    reportId: `r-${repHrId}`,
    reportNumber: `CR-${repHrId}`,
    status: "submitted",
    submittedAt: null,
    teamId: null,
    teamName: null,
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

export function runCoachingStarsSkipResignedTests() {
  const reports = [
    report("A-1", "Alpha", 98),
    report("A-2", "Bravo", 95),
    report("A-3", "Charlie", 93),
    report("A-4", "Delta", 90),
    report("A-5", "Echo", 85),
  ];

  // Nobody has left: the plain top three.
  assert.deepEqual(
    buildTopCoachingScores(reports, 3).map((entry) => entry.medicalRepName),
    ["Alpha", "Bravo", "Charlie"],
  );

  // A resigned rep in the top three is skipped and the next score takes the slot.
  const skipped = buildTopCoachingScores(reports, 3, new Set(["A-2"]));
  assert.deepEqual(
    skipped.map((entry) => entry.medicalRepName),
    ["Alpha", "Charlie", "Delta"],
    "the star who resigned is replaced by the one scoring just below",
  );
  assert.deepEqual(skipped.map((entry) => entry.rank), [1, 2, 3]);

  // Two leavers: still three names.
  assert.deepEqual(
    buildTopCoachingScores(reports, 3, new Set(["A-1", "A-3"])).map((entry) => entry.medicalRepName),
    ["Bravo", "Delta", "Echo"],
  );

  // The match is on the HR id in either case.
  assert.equal(buildTopCoachingScores(reports, 3, new Set(["A-1"]))[0]?.medicalRepName, "Bravo");

  // The landing page feeds the builder the departed set from the full directory.
  const page = readFileSync("app/employee-portals/training-manager/page.tsx", "utf8");
  assert.match(page, /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/);
  assert.match(page, /buildTopCoachingScores\(previousMonthReports, 3, departedHrIds\)/);
}
