import { strict as assert } from "node:assert";

import { isFieldWorkforceComplianceEligibleTitle } from "../src/lib/field-workforce-compliance/eligibility.ts";
import {
  buildIReports360FieldWorkforceMatrix,
  visitFromMirrorRow,
  type FieldWorkforceEmployeeInput,
  type FieldWorkforceMatrixVisit,
  type VisitsMirrorRow,
} from "../src/lib/field-workforce-compliance/ireports360-source.ts";
import { buildFieldWorkforceRecommendationsReportFromArchive } from "../src/lib/field-workforce-compliance/recommendations.ts";
import type { IReports360Visit } from "../src/lib/field-workforce-compliance/ireports360-client.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

function visit(
  agentID: number,
  visitDate: string,
  agentName: string | null,
  doubleID: number | null = null,
): IReports360Visit {
  return {
    agentID,
    agentName,
    ampm: null,
    attendance: null,
    callType: null,
    comment: null,
    contactID: null,
    contactName: null,
    customerName: null,
    doubleID,
    doubleName: doubleID != null ? "Double.Partner" : null,
    id: agentID * 1000 + Number(visitDate.slice(8, 10)),
    saveDate: null,
    visitDate,
    visitType: 0, // regular visit
    visitTypeDescription: "Regular",
  };
}

export function runFieldWorkforceComplianceEligibilityTests() {
  // --- Helper: who is eligible (Sales + Marketing + Training Manager) ---
  for (const eligible of [
    "Medical Representative",
    "medical rep",
    "District Sales Manager",
    "Regional Sales Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
    "Training Manager",
    "SFE Manager", // appears in the compliance report (excluded from deductions elsewhere)
  ]) {
    assert.equal(
      isFieldWorkforceComplianceEligibleTitle(eligible),
      true,
      `expected "${eligible}" to be eligible`,
    );
  }

  // --- Helper: who is excluded (back-office, system, blank titles) ---
  for (const excluded of [
    "HR Manager",
    "Finance Manager",
    "R And D Manager",
    "Regulatory Affairs",
    "Qppv",
    "Talent Acquisition",
    "Admin Assistant",
    "System Administrator",
    "Office Coordinator",
    "Ceo",
    "",
    null,
    undefined,
  ]) {
    assert.equal(
      isFieldWorkforceComplianceEligibleTitle(excluded),
      false,
      `expected "${String(excluded)}" to be excluded`,
    );
  }

  // Multiple title fields: eligibility holds if ANY field qualifies.
  assert.equal(isFieldWorkforceComplianceEligibleTitle("", "Medical Rep"), true);
  assert.equal(isFieldWorkforceComplianceEligibleTitle("Office Coordinator", null), false);

  // --- Matrix builder: every eligible, active employee becomes a row (even with no visits) ---
  const employees: FieldWorkforceEmployeeInput[] = [
    // Eligible rep WITH a visit.
    { crmId: "1", crmUsername: "Rep.One", employmentStatus: "active", fullName: "Rep One", hireDate: "2024-01-01", hrId: "A-1", jobTitle: "Medical Representative", positionTitle: null },
    // Eligible manager with NO visits at all — must still appear (the "missing managers" fix).
    { crmId: "5", crmUsername: "Mgr.Five", employmentStatus: "active", fullName: "Mgr Five", hireDate: "2024-01-01", hrId: "A-5", jobTitle: "National Sales Manager", positionTitle: null },
    // Manager who ONLY rides along as a double partner — his joint visits must be credited.
    { crmId: "7", crmUsername: "Mgr.Seven", employmentStatus: "active", fullName: "Mgr Seven", hireDate: "2024-01-01", hrId: "A-6", jobTitle: "District Sales Manager", positionTitle: null },
    // Ineligible role — excluded.
    { crmId: "2", crmUsername: "Admin.Two", employmentStatus: "active", fullName: "Admin Two", hireDate: "2024-01-01", hrId: "A-2", jobTitle: "Admin Assistant", positionTitle: null },
    // Departed employee — excluded even though eligible role.
    { crmId: "9", crmUsername: "Gone.Nine", employmentStatus: "resigned", fullName: "Gone Nine", hireDate: "2024-01-01", hrId: "A-9", jobTitle: "Medical Representative", positionTitle: null },
  ];

  const { matrix } = buildIReports360FieldWorkforceMatrix({
    employees,
    month: 5,
    year: 2026,
    todayIso: "2026-06-01",
    visits: [
      visit(1, "2026-05-04", "Rep.One ( Cairo / A )"),
      // Rep One's visit on the 5th where Mgr Seven (crm 7) is the double partner.
      visit(1, "2026-05-05", "Rep.One ( Cairo / A )", 7),
      visit(99, "2026-05-04", "Ghost.Agent ( Unknown / X )"), // orphan visit, no employee → ignored
    ],
  });

  // Header + Rep One (A-1) + Mgr Five (A-5) + Mgr Seven (A-6). Admin Two & Gone Nine excluded.
  const hrIds = matrix.slice(1).map((row) => row[1]);
  assert.deepEqual([...hrIds].sort(), ["A-1", "A-5", "A-6"], "only eligible, active employees appear");

  const repRow = matrix.find((row) => row[1] === "A-1")!;
  const mgrFiveRow = matrix.find((row) => row[1] === "A-5")!;
  const mgrSevenRow = matrix.find((row) => row[1] === "A-6")!;
  // Column layout: [TM, HR ID, Hiring Date, Month, Year, day1..dayN]; 2026-05-04 = index 8, 05-05 = index 9.
  assert.equal(repRow[8], 1, "Rep One shows 1 regular visit on 2026-05-04");
  // Mgr Five has no visits at all → no numeric activity anywhere.
  assert.ok(
    mgrFiveRow.slice(5).every((cell) => cell === "N" || cell === null),
    "zero-visit manager appears with no numeric activity",
  );
  // Mgr Seven only appears as a double — that joint visit on the 5th must be credited.
  assert.equal(mgrSevenRow[9], 1, "double-partner manager is credited the joint visit on 2026-05-05");

  // --- Mirror-row parity: visitFromMirrorRow -> buildIReports360FieldWorkforceMatrix must
  // produce IDENTICAL classification to feeding the equivalent IReports360Visit objects
  // directly, since FWC now sources its matrix from the ireports360_visits mirror table
  // instead of a live CRM call. Covers VISIT_TYPE_TO_STATUS mapping (regular/AV/CP),
  // Friday-blank, and the double-visit credit path — all through the mirror-row shape. ---
  const mirrorRows: VisitsMirrorRow[] = [
    // Regular visit -> numeric count.
    { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null, visit_date: "2026-05-04", visit_type: 0 },
    // Same day, second regular visit -> count of 2.
    { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null, visit_date: "2026-05-04", visit_type: 0 },
    // Annual Vacation -> "AV".
    { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null, visit_date: "2026-05-11", visit_type: -4 },
    // Campaign -> "CP", and credited to the double partner (Mgr Seven, crm 7) too.
    { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: 7, double_name: "Mgr.Seven ( HQ / B )", visit_date: "2026-05-18", visit_type: -8 },
  ];
  const mirrorEmployees: FieldWorkforceEmployeeInput[] = [
    { crmId: "1", crmUsername: "Rep.One", employmentStatus: "active", fullName: "Rep One", hireDate: "2024-01-01", hrId: "A-1", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "7", crmUsername: "Mgr.Seven", employmentStatus: "active", fullName: "Mgr Seven", hireDate: "2024-01-01", hrId: "A-6", jobTitle: "District Sales Manager", positionTitle: null },
  ];

  const { matrix: mirrorMatrix } = buildIReports360FieldWorkforceMatrix({
    employees: mirrorEmployees,
    month: 5,
    year: 2026,
    todayIso: "2026-06-01",
    visits: mirrorRows.map(visitFromMirrorRow),
  });
  const directVisits: IReports360Visit[] = mirrorRows.map((row) => ({
    agentID: row.agent_crm_id,
    agentName: row.agent_name,
    ampm: null,
    attendance: null,
    callType: null,
    comment: null,
    contactID: null,
    contactName: null,
    customerName: null,
    doubleID: row.double_crm_id,
    doubleName: row.double_name,
    id: 0,
    saveDate: null,
    visitDate: row.visit_date,
    visitType: row.visit_type as number,
    visitTypeDescription: null,
  }));
  const { matrix: directMatrix } = buildIReports360FieldWorkforceMatrix({
    employees: mirrorEmployees,
    month: 5,
    year: 2026,
    todayIso: "2026-06-01",
    visits: directVisits,
  });
  assert.deepEqual(mirrorMatrix, directMatrix, "mirror-row mapping must produce an identical matrix to the direct IReports360Visit shape");

  const mirrorRepRow = mirrorMatrix.find((row) => row[1] === "A-1")!;
  const mirrorMgrRow = mirrorMatrix.find((row) => row[1] === "A-6")!;
  // Column layout: [TM, HR ID, Hiring Date, Month, Year, day1..dayN]; 05-04=idx8, 05-11=idx15, 05-18=idx22.
  assert.equal(mirrorRepRow[8], 2, "two regular visits on the same day sum to a count of 2");
  assert.equal(mirrorRepRow[15], "AV", "visitType -4 maps to AV via the mirror row path");
  assert.equal(mirrorRepRow[22], "CP", "visitType -8 maps to CP via the mirror row path");
  assert.equal(mirrorMgrRow[22], "CP", "the double partner is credited the same CP day via the mirror row path");

  // --- Tier 0.1/0.2: deterministic crm_id -> hr_id resolution + confidence, NO fuzzy names ---
  const baseVisit = (agentID: number, agentName: string | null): FieldWorkforceMatrixVisit => ({
    agentID, agentName, ampm: null, attendance: null, callType: null, comment: null, contactID: null,
    contactName: null, customerName: null, doubleID: null, doubleName: null, id: 0, saveDate: null,
    visitDate: "2026-05-06", visitType: 0, visitTypeDescription: null,
  });
  const identityEmployees: FieldWorkforceEmployeeInput[] = [
    // Resolved by directory crm_id.
    { crmId: "100", crmUsername: "res.byid", employmentStatus: "active", fullName: "Res ById", hireDate: "2024-01-01", hrId: "B-1", jobTitle: "Medical Representative", positionTitle: null },
    // No crm_id/username of ours, but the mirror already resolved their hr_id (sync override/username).
    { crmId: null, crmUsername: null, employmentStatus: "active", fullName: "Res ByOverride", hireDate: "2024-01-01", hrId: "B-2", jobTitle: "Medical Representative", positionTitle: null },
    // Has a username but no crm_id; a visit's NAME matches it — must NOT be fuzzy-attributed.
    { crmId: null, crmUsername: "No.Crm", employmentStatus: "active", fullName: "Name Only", hireDate: "2024-01-01", hrId: "B-3", jobTitle: "Medical Representative", positionTitle: null },
    // No crm identity anywhere -> unresolved.
    { crmId: null, crmUsername: null, employmentStatus: "active", fullName: "Ghost None", hireDate: "2024-01-01", hrId: "B-4", jobTitle: "Medical Representative", positionTitle: null },
  ];
  const identityVisits: FieldWorkforceMatrixVisit[] = [
    baseVisit(100, "Anything At All"),                                   // crm_id 100 -> B-1 via directory
    { ...baseVisit(999, "Ghost"), agentHrId: "B-2" },                    // crm_id not in directory, mirror hr_id -> B-2
    baseVisit(555, "No.Crm ( Cairo / A )"),                              // name matches B-3's username -> must be IGNORED
  ];
  const { identityByHrKey, matrix: identityMatrix } = buildIReports360FieldWorkforceMatrix({
    employees: identityEmployees, month: 5, year: 2026, todayIso: "2026-06-01", visits: identityVisits,
  });
  const idOf = (hr: string) => {
    const key = canonicalHrIdKey(hr);
    return key ? identityByHrKey.get(key) : undefined;
  };

  assert.equal(idOf("B-1")?.confidence, "crm_id", "directory crm_id -> crm_id confidence");
  assert.equal(idOf("B-1")?.attributedVisitRows, 1, "B-1 gets its crm_id-matched visit");
  assert.equal(idOf("B-2")?.confidence, "override", "no directory crm mapping, resolved only by the mirror's hr_id");
  assert.equal(idOf("B-2")?.attributedVisitRows, 1, "B-2 is attributed via the mirror's agent_hr_id (crm_id gap-fill)");
  assert.equal(idOf("B-3")?.confidence, "crm_username", "username on file but no crm_id");
  assert.equal(idOf("B-3")?.attributedVisitRows, 0, "no fuzzy name matching: the name-matching visit is NOT credited to B-3");
  assert.equal(idOf("B-4")?.confidence, "unresolved", "no crm_id/username/override -> unresolved");
  assert.equal(idOf("B-4")?.attributedVisitRows, 0, "unresolved employee has zero attributed visits");
  // B-3's row must have no numeric activity (proves the fuzzy-name visit was dropped).
  const b3Row = identityMatrix.find((row) => row[1] === "B-3")!;
  assert.ok(b3Row.slice(5).every((cell) => cell === "N" || cell === null), "B-3 shows only N/blank — never the fuzzy-matched visit");

  // --- Tier 0.2 guard: an unresolved employee generates NO leave/payroll recommendations ---
  const nCell = (dateIso: string) => ({
    context: [], countedAsNoActivityCandidate: true, countedAsVisitTotal: false, countedAsWorkedDay: false,
    dateIso, dayNumber: Number(dateIso.slice(8, 10)), employeeName: "x", explanation: "", hrId: "x",
    ignored: false, isFriday: false, isPreHire: false, isPublicHoliday: false, rawValue: "N",
    severity: "Medium", status: "N",
  });
  const guardEmployee = (hrId: string, confidence: "crm_id" | "unresolved") => ({
    areaName: null, campaignDays: 0, compliancePercent: 0, crmIdentity: { attributedVisitRows: 0, confidence, crmId: null },
    employeeName: hrId, employmentStatus: "active", eligibleWorkingDays: 1, fridays: 0, hiringDateIso: "2024-01-01",
    hiringDateSource: "employee_directory", holidayWarnings: 0, hrId, lineName: null, managerHrId: null, managerName: null,
    matchedEmployeeName: hrId, matchedHrId: hrId, matchStatus: "matched", noActivityCandidates: 1,
    noActivityPattern: { adjacentToFridayDates: [], adjacentToPublicHolidayDates: [], consecutiveSignalCount: 0, hasThreeDayStreak: false, hasTwoDayStreak: false, highMonthlyCount: false, longestStreak: 1, summary: "" },
    preHireIgnoredValues: 0, roleName: null, severityCounts: { High: 0, Low: 0, Medium: 1, Review: 0 }, sourceRowNumber: 1,
    teamName: null, timeline: [nCell("2026-05-06")], totalVisits: 0, unknownValues: 0, vacationSignalDays: 0, workedDays: 0,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guardArchive: any = {
    archive: { id: "live:2026-05", monthKey: "2026-05", month: 5, year: 2026, employeeCount: 2, highSeverityCount: 0, reviewCandidateCount: 2, sheetName: "s", sourceFilename: "f", status: "archived", uploadedAt: "2026-06-01T00:00:00.000Z", uploadedBy: "test" },
    preview: { employees: [guardEmployee("C-1", "crm_id"), guardEmployee("C-2", "unresolved")], errors: [], metadata: { dateRange: { start: "2026-05-01", end: "2026-05-31" } }, reviewCandidates: [], severityCounts: { High: 0, Low: 0, Medium: 2, Review: 0 }, warnings: [] },
  };
  const guardReport = buildFieldWorkforceRecommendationsReportFromArchive(guardArchive, [], undefined);
  const guardCodes = [...guardReport.leaveRecommendations, ...guardReport.payrollRecommendations].map((rec) => rec.employeeCode);
  assert.ok(guardCodes.includes("C-1"), "resolved employee still generates recommendations");
  assert.ok(!guardCodes.includes("C-2"), "unresolved employee generates NO recommendations (deduction money-safety guard)");

  // --- 1.1 CRM-logging timing: first/last LOGGED time, active window, late-start flag ---
  // Sourced from saveDate (crm_save_date) — NOT visitDate/visit_date_time, which is a fixed
  // midnight placeholder on every production row (verified 2026-07: 100% of 93,742 rows) and
  // carries no real time-of-day signal at all. saveDate genuinely varies (verified: 38,758
  // distinct times across 62,953 regular-visit rows in production) and is the CRM record-save
  // timestamp, a reasonable proxy for real-time field logging.
  // Egypt reinstated seasonal DST in 2023 (summer = UTC+3, winter = UTC+2), so a May UTC
  // timestamp is Cairo-local UTC+3 — computed via real Intl/IANA timezone data (not a fixed
  // offset), which is exactly what makes this correct across the whole year including DST
  // transitions. "T07:15:00Z" on 2026-05-06 (May -> summer time) is therefore 10:15 Cairo.
  const timingEmployees: FieldWorkforceEmployeeInput[] = [
    { crmId: "200", crmUsername: null, employmentStatus: "active", fullName: "Timing One", hireDate: "2024-01-01", hrId: "T-1", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "201", crmUsername: null, employmentStatus: "active", fullName: "Timing Two", hireDate: "2024-01-01", hrId: "T-2", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "202", crmUsername: null, employmentStatus: "active", fullName: "Timing Three", hireDate: "2024-01-01", hrId: "T-3", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "203", crmUsername: null, employmentStatus: "active", fullName: "Timing Four", hireDate: "2024-01-01", hrId: "T-4", jobTitle: "Medical Representative", positionTitle: null },
  ];
  const timingVisits: FieldWorkforceMatrixVisit[] = [
    // T-1: two visits same day, logged 10:15 Cairo (AM-tagged, on-time) and 15:30 Cairo (PM-tagged).
    { ...baseVisit(200, "x"), ampm: "AM", visitDate: "2026-05-06", saveDate: "2026-05-06T07:15:00Z" },
    { ...baseVisit(200, "x"), ampm: "PM", visitDate: "2026-05-06", saveDate: "2026-05-06T12:30:00Z" },
    // T-2: single AM-tagged visit logged at 13:15 Cairo — logged past 11:30 -> late start.
    { ...baseVisit(201, "x"), ampm: "am", visitDate: "2026-05-06", saveDate: "2026-05-06T10:15:00Z" },
    // T-3: only a PM-tagged visit that day -> no AM entry to judge -> isLateStart must be null, not false.
    { ...baseVisit(202, "x"), ampm: "PM", visitDate: "2026-05-06", saveDate: "2026-05-06T12:00:00Z" },
    // T-4: visit with no saveDate at all (e.g. a defensive/legacy shape) -> no timing entry.
    { ...baseVisit(203, "x"), ampm: "AM", visitDate: "2026-05-06" },
  ];
  const { loggingTimingByHrKeyAndDate } = buildIReports360FieldWorkforceMatrix({
    employees: timingEmployees, month: 5, year: 2026, todayIso: "2026-06-01", visits: timingVisits,
  });
  const timingOf = (hr: string, dateIso: string) => {
    const key = canonicalHrIdKey(hr);
    return key ? loggingTimingByHrKeyAndDate.get(`${key}|${dateIso}`) : undefined;
  };

  const t1 = timingOf("T-1", "2026-05-06");
  assert.equal(t1?.firstLoggedTime, "10:15", "T-1 first logged time is Cairo-local 10:15");
  assert.equal(t1?.lastLoggedTime, "15:30", "T-1 last logged time is Cairo-local 15:30");
  assert.equal(t1?.activeWindowMinutes, 315, "T-1 active window is 10:15-15:30 = 315 minutes");
  assert.equal(t1?.isLateStart, false, "T-1's AM-tagged entry logged at 10:15 is before the 11:30 threshold");

  assert.equal(timingOf("T-2", "2026-05-06")?.isLateStart, true, "T-2's AM-tagged entry logged at 13:15 (mixed-case 'am') is after 11:30 -> late start");

  assert.equal(timingOf("T-3", "2026-05-06")?.isLateStart, null, "T-3 has no AM-tagged entry that day -> isLateStart is null, not guessed");

  assert.equal(timingOf("T-4", "2026-05-06"), undefined, "a visit with no saveDate produces no timing entry for that day");
}
