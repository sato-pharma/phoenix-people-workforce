import { strict as assert } from "node:assert";

import { buildFieldWorkforceCompliancePreview } from "../src/lib/field-workforce-compliance/classifier.ts";
import { complianceLabel } from "../src/lib/field-workforce-compliance/compliance-label.ts";
import {
  buildIReports360FieldWorkforceMatrix,
  type FieldWorkforceEmployeeInput,
  type FieldWorkforceMatrixVisit,
} from "../src/lib/field-workforce-compliance/ireports360-source.ts";
import { parseFieldWorkforceComplianceMatrix } from "../src/lib/field-workforce-compliance/parser.ts";
import { buildFieldWorkforceManagerScorecards } from "../src/lib/field-workforce-compliance/scorecards.ts";

/**
 * TODAY HAS NOT ENDED, SO IT IS NEVER JUDGED (owner, 2026-10-26).
 *
 * The Team Calendar showed every rep "N" for today from the first minute of the morning — a day
 * still being worked was read as a no-activity day, pulled the compliance percentage down and
 * raised a no-activity review candidate. Today with nothing logged yet is now a neutral blank,
 * exactly like a future day; today WITH visits still counts as worked.
 *
 * And someone with no eligible day in the month (hired 1 Nov, viewing October) has no percentage
 * at all — "Starts 1 Nov 2026", or "—" with no start date — never 0%.
 *
 * No money rule changes: deductions read only `no_activity` candidates, and today simply stops
 * raising one.
 */

const TODAY = "2026-10-26"; // a Monday
const OCTOBER_HEADERS = Array.from({ length: 31 }, (_, index) => `${index + 1}-Oct-2026`);
// Column layout: [TM, HR ID, Hiring Date, Month, Year, day1..dayN].
const dayColumn = (day: number) => 4 + day;

function octoberRow(name: string, hrId: string, hireDate: string, days: Record<number, unknown>): unknown[] {
  return [name, hrId, hireDate, "Oct", 2026, ...OCTOBER_HEADERS.map((_, index) => days[index + 1] ?? null)];
}

function reference(hrId: string, fullName: string, extra: Record<string, unknown> = {}) {
  return {
    areaName: "Cairo",
    employmentStatus: "active",
    fullName,
    hireDate: "2026-01-01",
    hrId,
    jobTitle: "Medical Representative",
    lineName: "CNS",
    managerName: "Manager One",
    roleName: "Medical Rep",
    teamName: "Team A",
    ...extra,
  };
}

function runTheSourceLeavesTodayBlank() {
  const employees: FieldWorkforceEmployeeInput[] = [
    {
      crmId: "1", crmUsername: "Rep.One", displayName: "Rep One", employmentStatus: "active", fullName: "Rep One",
      hireDate: "2026-01-01", hrId: "A-1", jobTitle: "Medical Representative", positionTitle: null,
    },
    {
      crmId: "2", crmUsername: "Rep.Two", displayName: "Rep Two", employmentStatus: "active", fullName: "Rep Two",
      hireDate: "2026-01-01", hrId: "A-2", jobTitle: "Medical Representative", positionTitle: null,
    },
  ];
  const visitToday: FieldWorkforceMatrixVisit = {
    agentHrId: "A-2", agentID: 2, agentName: "Rep.Two ( Cairo / A )", ampm: null, attendance: null, callType: null,
    comment: null, contactGrade: null, contactID: 5001, contactName: "Dr. One", customerName: null, doubleHrId: null,
    doubleID: null, doubleName: null, id: 1, partnerCreditOnly: false, region: null, regionID: null, saveDate: null,
    speciality: null, visitDate: TODAY, visitType: 0, visitTypeDescription: null,
  };

  const { matrix } = buildIReports360FieldWorkforceMatrix({ employees, month: 10, todayIso: TODAY, visits: [visitToday], year: 2026 });
  const rowOf = (hrId: string) => matrix.find((row) => row[1] === hrId)!;

  assert.equal(rowOf("A-1")[dayColumn(25)], "N", "a finished working day with nothing logged is still N");
  assert.equal(rowOf("A-1")[dayColumn(26)], null, "TODAY WITH NO VISITS IS BLANK, NOT N — the day has not ended");
  assert.equal(rowOf("A-1")[dayColumn(27)], null, "a future day stays blank");
  assert.equal(rowOf("A-2")[dayColumn(26)], 1, "today WITH a visit still shows its visit");
}

function runTheClassifierNeverJudgesToday() {
  const parsed = parseFieldWorkforceComplianceMatrix({
    fileName: "October 2026 live.xlsx",
    matrix: [
      ["TM", "HR ID", "Hiring Date", "Month", "Year", ...OCTOBER_HEADERS],
      // Worked the 1st, nothing on the 25th, nothing yet today.
      octoberRow("Rep One", "A-1", "1-Jan-2026", { 1: 4, 25: "N" }),
      // Worked today.
      octoberRow("Rep Two", "A-2", "1-Jan-2026", { 26: 3 }),
      // Hired 1 November: no eligible October day.
      octoberRow("Nora Starter", "A-3", "1-Nov-2026", {}),
    ],
    sheetName: "iReport",
  });
  assert.equal(parsed.errors.length, 0);

  const preview = buildFieldWorkforceCompliancePreview({
    employeeReferences: [
      reference("A-1", "Rep One"),
      reference("A-2", "Rep Two"),
      reference("A-3", "Nora Starter", { hireDate: "2026-11-01", managerName: "Manager Two" }),
    ],
    holidayConnected: true,
    holidaySourceLabel: "Egypt public holidays",
    holidays: [],
    parsed,
    todayIso: TODAY,
  });
  const of = (hrId: string) => preview.employees.find((employee) => employee.hrId === hrId)!;

  const repOne = of("A-1");
  const today = repOne.timeline.find((cell) => cell.dateIso === TODAY)!;
  assert.notEqual(today.status, "N", "today is never read as N");
  assert.equal(today.ignored, true, "TODAY WITH NO VISITS IS NOT AN ELIGIBLE DAY");
  assert.equal(today.ignoreReason, "not_yet_ended");
  assert.equal(today.countedAsNoActivityCandidate, false);
  assert.equal(
    preview.reviewCandidates.some((candidate) => candidate.hrId === "A-1" && candidate.dateIso === TODAY),
    false,
    "today raises no review candidate",
  );
  assert.equal(
    preview.reviewCandidates.some((candidate) => candidate.hrId === "A-1" && candidate.dateIso === "2026-10-25" && candidate.type === "no_activity"),
    true,
    "a finished day with nothing logged is still a no-activity candidate",
  );
  // 1–25 October less four Fridays (2, 9, 16, 23): 21 eligible days. Today and after are out.
  assert.equal(repOne.eligibleWorkingDays, 21, "only finished days are eligible");
  assert.equal(repOne.compliancePercent, Math.round((1 / 21) * 10000) / 100);

  const repTwoToday = of("A-2").timeline.find((cell) => cell.dateIso === TODAY)!;
  assert.equal(repTwoToday.ignored, false, "today WITH visits is a judged day");
  assert.equal(repTwoToday.countedAsWorkedDay, true, "today's visits count as worked");

  // Zero eligible days → no percentage, never 0%.
  const nora = of("A-3");
  assert.equal(nora.eligibleWorkingDays, 0);
  assert.equal(nora.compliancePercent, null, "ZERO ELIGIBLE DAYS GIVES NO PERCENTAGE");
  assert.equal(complianceLabel(nora), "Starts 1 Nov 2026");
  assert.equal(complianceLabel(repOne), `${Math.round(repOne.compliancePercent!)}%`, "whole percentages");

  assert.equal(complianceLabel({ compliancePercent: null, hiringDateIso: null, timeline: [] }), "—", "no start date reads a dash");

  // A manager whose only member has no percentage averages to none, not 0%, and sorts last.
  const scorecards = buildFieldWorkforceManagerScorecards(preview.employees);
  const managerTwo = scorecards.find((card) => card.groupName === "Manager Two")!;
  assert.equal(managerTwo.avgCompliancePercent, null, "a member with no percentage is left out of the average");
  assert.equal(scorecards[scorecards.length - 1].groupName, "Manager Two");
  const managerOne = scorecards.find((card) => card.groupName === "Manager One")!;
  assert.notEqual(managerOne.avgCompliancePercent, null);
}

export function runFwcTodayNotYetEndedTests() {
  runTheSourceLeavesTodayBlank();
  runTheClassifierNeverJudgesToday();
}
