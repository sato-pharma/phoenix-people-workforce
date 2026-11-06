import { strict as assert } from "node:assert";

import { isFieldWorkforceComplianceEligibleTitle, logsOwnCrmVisitsTitle } from "../src/lib/field-workforce-compliance/eligibility.ts";
import {
  buildIReports360FieldWorkforceMatrix,
  visitFromMirrorRow,
  type FieldWorkforceEmployeeInput,
  type FieldWorkforceMatrixVisit,
  type VisitsMirrorRow,
} from "../src/lib/field-workforce-compliance/ireports360-source.ts";
import { buildFieldWorkforceRecommendationsReportFromArchive } from "../src/lib/field-workforce-compliance/recommendations.ts";
import { computeAttendanceCrossCheck } from "../src/lib/field-workforce-compliance/attendance-cross-check.ts";
import type { IReports360Visit } from "../src/lib/crm/vendor-row-types.ts";
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
    contactGrade: null,
    customerName: null,
    doubleID,
    doubleName: doubleID != null ? "Double.Partner" : null,
    id: agentID * 1000 + Number(visitDate.slice(8, 10)),
    region: null,
    regionID: null,
    saveDate: null,
    speciality: null,
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
    "HR Advisory",
    "HR Operations",
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
    { crmId: "1", crmUsername: "Rep.One", employmentStatus: "active", fullName: "Rep One", displayName: "Rep One", hireDate: "2024-01-01", hrId: "A-1", jobTitle: "Medical Representative", positionTitle: null },
    // Eligible manager with NO visits at all — must still appear (the "missing managers" fix).
    { crmId: "5", crmUsername: "Mgr.Five", employmentStatus: "active", fullName: "Mgr Five", displayName: "Mgr Five", hireDate: "2024-01-01", hrId: "A-5", jobTitle: "National Sales Manager", positionTitle: null },
    // Manager who ONLY rides along as a double partner — his joint visits must be credited.
    { crmId: "7", crmUsername: "Mgr.Seven", employmentStatus: "active", fullName: "Mgr Seven", displayName: "Mgr Seven", hireDate: "2024-01-01", hrId: "A-6", jobTitle: "District Sales Manager", positionTitle: null },
    // Ineligible role — excluded.
    { crmId: "2", crmUsername: "Admin.Two", employmentStatus: "active", fullName: "Admin Two", displayName: "Admin Two", hireDate: "2024-01-01", hrId: "A-2", jobTitle: "Admin Assistant", positionTitle: null },
    // Departed employee — excluded even though eligible role.
    { crmId: "9", crmUsername: "Gone.Nine", employmentStatus: "resigned", fullName: "Gone Nine", displayName: "Gone Nine", hireDate: "2024-01-01", hrId: "A-9", jobTitle: "Medical Representative", positionTitle: null },
    // Regression guard (2026-07-18 production leak): a bespoke status-string check here used
    // to recognize only "terminated"/"resigned"/"inactive" and missed these two values, so 15
    // historical_payroll_record employees (and system_placeholder rows) leaked into the live
    // Workforce Compliance view. Now routed through the same canonical classifyEmployeeNode
    // used everywhere else in the app.
    { crmId: "10", crmUsername: "Historical.Ten", employmentStatus: "historical_payroll_record", fullName: "Historical Ten", displayName: "Historical Ten", hireDate: "2024-01-01", hrId: "A-10", jobTitle: "District Sales Manager", positionTitle: null },
    { crmId: "11", crmUsername: "Sys.Eleven", employmentStatus: "system_placeholder", fullName: "System Eleven", displayName: "System Eleven", hireDate: "2024-01-01", hrId: "A-11", jobTitle: "National Sales Manager", positionTitle: null },
  ];

  const { matrix, ownRegularCountByHrKeyAndDate, ownSplitByHrKeyAndDate, rideAlongSplitByHrKeyAndDate } = buildIReports360FieldWorkforceMatrix({
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

  // Header + Rep One (A-1) + Mgr Five (A-5) + Mgr Seven (A-6). Admin Two, Gone Nine, Historical
  // Ten (historical_payroll_record) & System Eleven (system_placeholder) all excluded.
  const hrIds = matrix.slice(1).map((row) => row[1]);
  assert.deepEqual(
    [...hrIds].sort(),
    ["A-1", "A-5", "A-6"],
    "only eligible, active employees appear — historical_payroll_record and system_placeholder are excluded too, not just resigned/terminated/inactive",
  );

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

  // Own (primary-agent) vs ride-along (double) split — the basis for the portal Team Calendar's
  // "DV" coaching marker, which stops a manager's row duplicating the reps' visit counts.
  // Rep One is the primary agent on both days; Mgr Seven is credited the 05-05 joint visit above,
  // but only as the DOUBLE, so his OWN count that day is zero (no entry).
  const ownOf = (hr: string, dateIso: string) =>
    ownRegularCountByHrKeyAndDate.get(`${canonicalHrIdKey(hr)}|${dateIso}`);
  assert.equal(ownOf("A-1", "2026-05-04"), 1, "Rep One's solo visit is an own (primary-agent) visit");
  assert.equal(ownOf("A-1", "2026-05-05"), 1, "Rep One is the primary agent on the joint day, so it is still an own visit");
  assert.equal(
    ownOf("A-6", "2026-05-05"),
    undefined,
    "the ride-along manager has ZERO own visits on the joint day (double-credit only) — the portal renders this as a DV coaching day, never a duplicated visit count",
  );

  // The same split AM · PM · Pharmacies (owner, 2026-10-23: the square prints each figure apart, "same for district
  // managers"). An unmarked period counts as PM, the golden rule's own reading. The joint visit is Rep One's own and the
  // manager's RIDE-ALONG — never his own — so his row never adds the rep's visits on top of his.
  const key = (hr: string, dateIso: string) => `${canonicalHrIdKey(hr)}|${dateIso}`;
  assert.deepEqual(ownSplitByHrKeyAndDate.get(key("A-1", "2026-05-05")), { am: 0, pharmacies: 0, pm: 1 }, "the rep's own split");
  assert.deepEqual(rideAlongSplitByHrKeyAndDate.get(key("A-6", "2026-05-05")), { am: 0, pharmacies: 0, pm: 1 }, "the manager's ride-along split");
  assert.equal(ownSplitByHrKeyAndDate.get(key("A-6", "2026-05-05")), undefined, "and nothing in his own");
  assert.equal(rideAlongSplitByHrKeyAndDate.get(key("A-1", "2026-05-05")), undefined, "the rep rode along with nobody");

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
    { crmId: "1", crmUsername: "Rep.One", employmentStatus: "active", fullName: "Rep One", displayName: "Rep One", hireDate: "2024-01-01", hrId: "A-1", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "7", crmUsername: "Mgr.Seven", employmentStatus: "active", fullName: "Mgr Seven", displayName: "Mgr Seven", hireDate: "2024-01-01", hrId: "A-6", jobTitle: "District Sales Manager", positionTitle: null },
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
    contactGrade: null,
    customerName: null,
    doubleID: row.double_crm_id,
    doubleName: row.double_name,
    id: 0,
    region: null,
    regionID: null,
    saveDate: null,
    speciality: null,
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

  // Fix #6: the mirror mapping must carry `comment` through so the excuse-labeled-AV detector
  // (dayHasExcuseLabeledAv) can fire on the live path — it was hardcoded null before, silently
  // disabling excuse detection for the whole production preview path.
  const excuseRow: VisitsMirrorRow = {
    agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null,
    visit_date: "2026-05-12", visit_type: -4, comment: "Afternoon Excuse",
  };
  assert.equal(
    visitFromMirrorRow(excuseRow).comment,
    "Afternoon Excuse",
    "mirror mapping must carry the CRM comment so excuse-labeled AV is detectable, not hardcoded null",
  );

  const mirrorRepRow = mirrorMatrix.find((row) => row[1] === "A-1")!;
  const mirrorMgrRow = mirrorMatrix.find((row) => row[1] === "A-6")!;
  // Column layout: [TM, HR ID, Hiring Date, Month, Year, day1..dayN]; 05-04=idx8, 05-11=idx15, 05-18=idx22.
  assert.equal(mirrorRepRow[8], 2, "two regular visits on the same day sum to a count of 2");
  assert.equal(mirrorRepRow[15], "AV", "visitType -4 maps to AV via the mirror row path");
  assert.equal(mirrorRepRow[22], "CP", "visitType -8 maps to CP via the mirror row path");
  assert.equal(mirrorMgrRow[22], "CP", "the double partner is credited the same CP day via the mirror row path");

  // --- Public Holiday (-5) and Casual Leave (-6) are WORKING days (owner ruling 2026-08-21). ---
  // Asserted through the real matrix builder rather than the map, so this also covers the
  // `?? "CP"` default both codes used to rely on. Flipping either to "AV" would consume the
  // rep's annual balance and then bite salary — the exact shape of the Health Day incident.
  {
    const workingDayRows: VisitsMirrorRow[] = [
      { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null, visit_date: "2026-05-05", visit_type: -5 },
      { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null, visit_date: "2026-05-06", visit_type: -6 },
    ];
    const { matrix } = buildIReports360FieldWorkforceMatrix({
      employees: mirrorEmployees,
      month: 5,
      year: 2026,
      todayIso: "2026-06-01",
      visits: workingDayRows.map(visitFromMirrorRow),
    });
    const repRow = matrix.find((row) => row[1] === "A-1")!;
    // Same column layout as above: day 1 sits at index 5, so 05-05 = idx 9 and 05-06 = idx 10.
    assert.equal(repRow[9], "CP", "Public Holiday (-5) is a worked day, never AV — it must never charge leave");
    assert.equal(repRow[10], "CP", "Casual Leave (-6) is a worked day, never AV — it must never charge leave");
  }

  // --- Mixed day (owner decision 2026-07-20): a day with BOTH a regular visit AND a campaign now
  // COUNTS the regular visit (numeric count, not "CP"), and flags the campaign via
  // campaignOverlayKeys so the grid renders a two-color split square and campaignDays stays
  // accurate. A rep's real visits are never dropped from the total just because a campaign shared
  // the day. Only a pure-campaign day (no regular visit) still classifies as "CP" (asserted above). ---
  {
    const mixedRows: VisitsMirrorRow[] = [
      { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null, visit_date: "2026-05-20", visit_type: 0 },
      { agent_crm_id: 1, agent_name: "Rep.One ( Cairo / A )", double_crm_id: null, double_name: null, visit_date: "2026-05-20", visit_type: -8 },
    ];
    const { matrix: mixedMatrix, campaignOverlayKeys } = buildIReports360FieldWorkforceMatrix({
      employees: mirrorEmployees,
      month: 5,
      year: 2026,
      todayIso: "2026-06-01",
      visits: mixedRows.map(visitFromMirrorRow),
    });
    const mixedRepRow = mixedMatrix.find((row) => row[1] === "A-1")!;
    // Column layout: day N is at index N + 4, so 2026-05-20 is index 24.
    assert.equal(mixedRepRow[24], 1, "a mixed day (1 regular + 1 campaign) counts the regular visit, not 'CP'");
    assert.equal(campaignOverlayKeys.size, 1, "the mixed day is flagged as a campaign overlay (drives the split square + campaignDays)");
  }

  // --- Tier 0.1/0.2: deterministic crm_id -> hr_id resolution + confidence, NO fuzzy names ---
  const baseVisit = (agentID: number, agentName: string | null): FieldWorkforceMatrixVisit => ({
    agentID, agentName, ampm: null, attendance: null, callType: null, comment: null, contactID: null,
    contactName: null, contactGrade: null, customerName: null, doubleID: null, doubleName: null, id: 0,
    region: null, regionID: null, saveDate: null, speciality: null,
    visitDate: "2026-05-06", visitType: 0, visitTypeDescription: null,
  });
  const identityEmployees: FieldWorkforceEmployeeInput[] = [
    // Resolved by directory crm_id.
    { crmId: "100", crmUsername: "res.byid", employmentStatus: "active", fullName: "Res ById", displayName: "Res ById", hireDate: "2024-01-01", hrId: "B-1", jobTitle: "Medical Representative", positionTitle: null },
    // No crm_id/username of ours, but the mirror already resolved their hr_id (sync override/username).
    { crmId: null, crmUsername: null, employmentStatus: "active", fullName: "Res ByOverride", displayName: "Res ByOverride", hireDate: "2024-01-01", hrId: "B-2", jobTitle: "Medical Representative", positionTitle: null },
    // Has a username but no crm_id; a visit's NAME matches it — must NOT be fuzzy-attributed.
    { crmId: null, crmUsername: "No.Crm", employmentStatus: "active", fullName: "Name Only", displayName: "Name Only", hireDate: "2024-01-01", hrId: "B-3", jobTitle: "Medical Representative", positionTitle: null },
    // No crm identity anywhere -> unresolved.
    { crmId: null, crmUsername: null, employmentStatus: "active", fullName: "Ghost None", displayName: "Ghost None", hireDate: "2024-01-01", hrId: "B-4", jobTitle: "Medical Representative", positionTitle: null },
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

  // --- SFE Manager guard: appears in leave/compliance review, never as a payroll deduction ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sfeArchive: any = {
    archive: { id: "live:2026-06", monthKey: "2026-06", month: 6, year: 2026, employeeCount: 1, highSeverityCount: 0, reviewCandidateCount: 1, sheetName: "s", sourceFilename: "f", status: "archived", uploadedAt: "2026-07-01T00:00:00.000Z", uploadedBy: "test" },
    preview: {
      employees: [{ ...guardEmployee("S-1", "crm_id"), roleName: "SFE Manager" }],
      errors: [], metadata: { dateRange: { start: "2026-06-01", end: "2026-06-30" } }, reviewCandidates: [], severityCounts: { High: 0, Low: 0, Medium: 1, Review: 0 }, warnings: [],
    },
  };
  const sfeReport = buildFieldWorkforceRecommendationsReportFromArchive(sfeArchive, [], undefined);
  assert.ok(
    sfeReport.leaveRecommendations.some((rec) => rec.employeeCode === "S-1"),
    "SFE Manager still appears in leave/compliance review",
  );
  assert.ok(
    !sfeReport.payrollRecommendations.some((rec) => rec.employeeCode === "S-1"),
    "SFE Manager NEVER generates a payroll-deduction recommendation, per eligibility.ts's promise",
  );

  // --- Head Office fingerprint integration: device-mapped-only employees get a Team Calendar
  // row, but can never generate a payroll-deduction recommendation (informational only). ---
  const deviceMappedEmployees: FieldWorkforceEmployeeInput[] = [
    // "Admin Assistant" is not a field-workforce-eligible title (see the ineligible-role case
    // above) — must be absent without device-mapping, present once device-mapped.
    { crmId: null, crmUsername: null, employmentStatus: "active", fullName: "Office Amira", displayName: "Office Amira", hireDate: "2024-01-01", hrId: "HO-1", jobTitle: "Admin Assistant", positionTitle: null },
  ];
  const { matrix: withoutDeviceMapping } = buildIReports360FieldWorkforceMatrix({
    employees: deviceMappedEmployees, month: 5, year: 2026, todayIso: "2026-06-01", visits: [],
  });
  assert.ok(
    !withoutDeviceMapping.slice(1).some((row) => row[1] === "HO-1"),
    "non-field-eligible title is excluded when NOT device-mapped, same as before this feature",
  );
  const { matrix: withDeviceMapping } = buildIReports360FieldWorkforceMatrix({
    deviceMappedHrKeys: new Set([canonicalHrIdKey("HO-1")!]),
    employees: deviceMappedEmployees, month: 5, year: 2026, todayIso: "2026-06-01", visits: [],
  });
  assert.ok(
    withDeviceMapping.slice(1).some((row) => row[1] === "HO-1"),
    "non-field-eligible title gets a Team Calendar row once actively device-mapped",
  );

  // Payroll-safety: a device-mapped-only employee with a RESOLVED CRM identity (deliberately
  // not "unresolved" — proves the new title-eligibility gate, not the incidental identity
  // guard, is what's protecting this) and a no-activity day must still never reach
  // payrollRecommendations.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hoArchive: any = {
    archive: { id: "live:2026-07", monthKey: "2026-07", month: 7, year: 2026, employeeCount: 1, highSeverityCount: 0, reviewCandidateCount: 1, sheetName: "s", sourceFilename: "f", status: "archived", uploadedAt: "2026-07-01T00:00:00.000Z", uploadedBy: "test" },
    preview: {
      employees: [{ ...guardEmployee("HO-1", "crm_id"), roleName: "Admin Assistant" }],
      errors: [], metadata: { dateRange: { start: "2026-07-01", end: "2026-07-31" } }, reviewCandidates: [], severityCounts: { High: 0, Low: 0, Medium: 1, Review: 0 }, warnings: [],
    },
  };
  const hoReport = buildFieldWorkforceRecommendationsReportFromArchive(hoArchive, [], undefined);
  assert.ok(
    hoReport.leaveRecommendations.some((rec) => rec.employeeCode === "HO-1"),
    "device-mapped-only employee still appears in leave/compliance review",
  );
  assert.ok(
    !hoReport.payrollRecommendations.some((rec) => rec.employeeCode === "HO-1"),
    "device-mapped-only employee (non-field-eligible title) NEVER generates a payroll-deduction recommendation, even with a resolved CRM identity",
  );

  // --- Holiday-source guard (money safety): national holidays are fetched live from Google
  // Calendar. When that lookup degrades, the month's public holidays are missing, so every rep's
  // holiday reads as an ordinary working day with no activity — which would generate a payroll
  // deduction for the WHOLE field force off a third-party outage. Payroll must be suppressed;
  // the advisory leave recommendation is unaffected and still surfaces the days for review. ---
  {
    // A field-eligible title is required or the existing title gate would make every case pass
    // vacuously (guardEmployee's default roleName is null, which is NOT field-eligible).
    const holidayEmployee = { ...guardEmployee("HD-1", "crm_id"), roleName: "Medical Representative" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const holidayArchive = (metadata: Record<string, unknown>): any => ({
      archive: { ...guardArchive.archive, id: "live:2026-07", monthKey: "2026-07", month: 7, year: 2026 },
      preview: {
        employees: [holidayEmployee], errors: [],
        metadata: { dateRange: { start: "2026-07-01", end: "2026-07-31" }, ...metadata },
        reviewCandidates: [], severityCounts: { High: 0, Low: 0, Medium: 1, Review: 0 }, warnings: [],
      },
    });

    // Positive control — healthy holiday source: the payroll recommendation IS produced.
    const healthy = buildFieldWorkforceRecommendationsReportFromArchive(
      holidayArchive({ holidayCalendarReachable: true, holidayConnected: true }), [], undefined,
    );
    assert.ok(
      healthy.payrollRecommendations.some((rec) => rec.employeeCode === "HD-1"),
      "healthy holiday source still produces the payroll recommendation (guard must not fire)",
    );
    assert.equal(healthy.integrationStatus.holidaySource, "connected");

    // THE case the old holidayConnected-only check would have missed: the Google calendar was
    // unreachable, but a hardcoded company/fixed-date holiday overlapped the month, so
    // `connected` is still true. Only `calendarReachable` reveals the outage.
    const unreachable = buildFieldWorkforceRecommendationsReportFromArchive(
      holidayArchive({ holidayCalendarReachable: false, holidayConnected: true }), [], undefined,
    );
    assert.ok(
      !unreachable.payrollRecommendations.some((rec) => rec.employeeCode === "HD-1"),
      "calendar unreachable -> NO payroll deduction, even though holidayConnected was true",
    );
    assert.ok(
      unreachable.leaveRecommendations.some((rec) => rec.employeeCode === "HD-1"),
      "the advisory leave recommendation survives — the days are still surfaced for human review",
    );
    assert.equal(unreachable.integrationStatus.holidaySource, "degraded", "suppression is visible, not silent");
    assert.ok(unreachable.integrationStatus.holidaySourceMessage, "degraded state carries an explanatory message");

    // No holidays at all resolved for the month.
    const noHolidays = buildFieldWorkforceRecommendationsReportFromArchive(
      holidayArchive({ holidayCalendarReachable: false, holidayConnected: false }), [], undefined,
    );
    assert.ok(
      !noHolidays.payrollRecommendations.some((rec) => rec.employeeCode === "HD-1"),
      "no holiday data at all -> NO payroll deduction",
    );

    // Legacy/Excel archives predate these fields. Absent (undefined) must mean "not asserted",
    // NOT "degraded" — otherwise every historical archive silently stops producing payroll
    // recommendations. This is why the guard compares against `false` explicitly.
    const legacy = buildFieldWorkforceRecommendationsReportFromArchive(holidayArchive({}), [], undefined);
    assert.ok(
      legacy.payrollRecommendations.some((rec) => rec.employeeCode === "HD-1"),
      "archive without the holiday-source fields is treated as not-degraded (no regression for legacy archives)",
    );
    assert.equal(legacy.integrationStatus.holidaySource, "connected");
  }

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
    { crmId: "200", crmUsername: null, employmentStatus: "active", fullName: "Timing One", displayName: "Timing One", hireDate: "2024-01-01", hrId: "T-1", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "201", crmUsername: null, employmentStatus: "active", fullName: "Timing Two", displayName: "Timing Two", hireDate: "2024-01-01", hrId: "T-2", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "202", crmUsername: null, employmentStatus: "active", fullName: "Timing Three", displayName: "Timing Three", hireDate: "2024-01-01", hrId: "T-3", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "203", crmUsername: null, employmentStatus: "active", fullName: "Timing Four", displayName: "Timing Four", hireDate: "2024-01-01", hrId: "T-4", jobTitle: "Medical Representative", positionTitle: null },
  ];
  const timingVisits: FieldWorkforceMatrixVisit[] = [
    // iReports360 stores saveDate as a ZONE-LESS Cairo wall-clock tagged +00 (verified in
    // production), so a visit logged at 10:15 Cairo is stored — and read back — as 10:15:00Z. The
    // code reads that clock as-is and must NOT re-convert through Africa/Cairo, so these fixtures
    // carry the real wall-clock the rep logged at, as a ...Z instant (no offset juggling).
    // T-1: two visits same day, logged 10:15 Cairo (AM-tagged, on-time) and 15:30 Cairo (PM-tagged).
    { ...baseVisit(200, "x"), ampm: "AM", visitDate: "2026-05-06", saveDate: "2026-05-06T10:15:00Z" },
    { ...baseVisit(200, "x"), ampm: "PM", visitDate: "2026-05-06", saveDate: "2026-05-06T15:30:00Z" },
    // T-2: single AM-tagged visit logged at 13:15 Cairo — logged past 11:30 -> late start.
    { ...baseVisit(201, "x"), ampm: "am", visitDate: "2026-05-06", saveDate: "2026-05-06T13:15:00Z" },
    // T-3: only a PM-tagged visit that day -> no AM entry to judge -> isLateStart must be null, not false.
    { ...baseVisit(202, "x"), ampm: "PM", visitDate: "2026-05-06", saveDate: "2026-05-06T15:00:00Z" },
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

  // --- 1.1b Excuse-labeled AV detection: iReports360 has no separate visit_type for excuses —
  // both real vacation and excuses are logged under the same AV-mapped type (-4/-15), told
  // apart only by free-text comment. This drives which av_with_punch days get excluded from
  // the fingerprint-contradiction recommendation.
  const excuseEmployees: FieldWorkforceEmployeeInput[] = [
    { crmId: "300", crmUsername: null, employmentStatus: "active", fullName: "Excuse One", displayName: "Excuse One", hireDate: "2024-01-01", hrId: "E-1", jobTitle: "Medical Representative", positionTitle: null },
  ];
  const excuseVisits: FieldWorkforceMatrixVisit[] = [
    // Real vacation comment on an AV-mapped visit -> not excuse-labeled.
    { ...visit(300, "2026-05-10", "x"), visitType: -4, comment: "Annual Leave" },
    // Excuse comment on an AV-mapped visit -> excuse-labeled.
    { ...visit(300, "2026-05-11", "x"), visitType: -4, comment: "Afternoon Excuse" },
    // Case-insensitive and substring match ("Morning Excuse").
    { ...visit(300, "2026-05-12", "x"), visitType: -4, comment: "MORNING EXCUSE" },
    // A CP-mapped visit (Campaign) whose comment happens to mention "excuse" must NOT count —
    // only AV-mapped visit types are checked.
    { ...visit(300, "2026-05-13", "x"), visitType: -8, comment: "Excuse for missing campaign log" },
    // AV-mapped visit with a null comment -> not excuse-labeled (no false positive on absence of data).
    { ...visit(300, "2026-05-14", "x"), visitType: -4, comment: null },
  ];
  const { avExcuseLabeledKeys } = buildIReports360FieldWorkforceMatrix({
    employees: excuseEmployees, month: 5, year: 2026, todayIso: "2026-06-01", visits: excuseVisits,
  });
  const excuseKey = canonicalHrIdKey("E-1");
  assert.equal(avExcuseLabeledKeys.has(`${excuseKey}|2026-05-10`), false, "Annual Leave comment is not excuse-labeled");
  assert.equal(avExcuseLabeledKeys.has(`${excuseKey}|2026-05-11`), true, "Afternoon Excuse comment is excuse-labeled");
  assert.equal(avExcuseLabeledKeys.has(`${excuseKey}|2026-05-12`), true, "match is case-insensitive (MORNING EXCUSE)");
  assert.equal(avExcuseLabeledKeys.has(`${excuseKey}|2026-05-13`), false, "a CP-mapped (Campaign) visit's comment is never checked, even if it contains \"excuse\"");
  assert.equal(avExcuseLabeledKeys.has(`${excuseKey}|2026-05-14`), false, "an AV-mapped visit with no comment is not excuse-labeled");
  assert.equal(avExcuseLabeledKeys.size, 2, "exactly the two excuse-labeled days are recorded");

  // --- 1.2 Customer-authenticity: repeat-customer / low-variety / PM-recurrence patterns ---
  // May 2026 week boundaries (Mon-Sun) used below: week A = 05-04..05-10, week B = 05-11..05-17.
  const contactVisit = (
    agentID: number,
    contactID: number,
    contactName: string,
    visitDate: string,
    ampm: "AM" | "PM" | null = null,
  ): FieldWorkforceMatrixVisit => ({
    agentID, agentName: "x", ampm, attendance: null, callType: null, comment: null,
    contactID, contactName, contactGrade: null, customerName: null, doubleID: null, doubleName: null, id: 0,
    region: null, regionID: null, saveDate: null, speciality: null,
    visitDate, visitType: 0, visitTypeDescription: null,
  });
  const caEmployees: FieldWorkforceEmployeeInput[] = [
    { crmId: "300", crmUsername: null, employmentStatus: "active", fullName: "CA High Concentration + Low Variety", displayName: "CA High Concentration + Low Variety", hireDate: "2024-01-01", hrId: "CA-1", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "301", crmUsername: null, employmentStatus: "active", fullName: "CA Consecutive Days", displayName: "CA Consecutive Days", hireDate: "2024-01-01", hrId: "CA-2", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "302", crmUsername: null, employmentStatus: "active", fullName: "CA PM Twice One Week", displayName: "CA PM Twice One Week", hireDate: "2024-01-01", hrId: "CA-3", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "303", crmUsername: null, employmentStatus: "active", fullName: "CA PM Every Week", displayName: "CA PM Every Week", hireDate: "2024-01-01", hrId: "CA-4", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "304", crmUsername: null, employmentStatus: "active", fullName: "CA Healthy Pattern", displayName: "CA Healthy Pattern", hireDate: "2024-01-01", hrId: "CA-5", jobTitle: "Medical Representative", positionTitle: null },
    { crmId: "305", crmUsername: null, employmentStatus: "active", fullName: "CA No Visits", displayName: "CA No Visits", hireDate: "2024-01-01", hrId: "CA-6", jobTitle: "Medical Representative", positionTitle: null },
  ];
  const caVisits: FieldWorkforceMatrixVisit[] = [
    // CA-1: contact 900 gets 5 of 6 visits (83% share, and only 2 distinct contacts) -> both rules.
    contactVisit(300, 900, "Dr Mostly Visited", "2026-05-04"),
    contactVisit(300, 900, "Dr Mostly Visited", "2026-05-06"),
    contactVisit(300, 900, "Dr Mostly Visited", "2026-05-08"),
    contactVisit(300, 900, "Dr Mostly Visited", "2026-05-12"),
    contactVisit(300, 900, "Dr Mostly Visited", "2026-05-14"),
    contactVisit(300, 901, "Dr Rarely Visited", "2026-05-20"),

    // CA-2: contact 910 visited 3 consecutive days, plus 5 other distinct single-visit contacts
    // (dilutes share to 3/8=37.5% and distinctContacts to 6, so only consecutive_same_contact fires).
    contactVisit(301, 910, "Dr Consecutive", "2026-05-04"),
    contactVisit(301, 910, "Dr Consecutive", "2026-05-05"),
    contactVisit(301, 910, "Dr Consecutive", "2026-05-06"),
    contactVisit(301, 911, "Dr Other A", "2026-05-11"),
    contactVisit(301, 912, "Dr Other B", "2026-05-12"),
    contactVisit(301, 913, "Dr Other C", "2026-05-13"),
    contactVisit(301, 914, "Dr Other D", "2026-05-14"),
    contactVisit(301, 915, "Dr Other E", "2026-05-15"),

    // CA-3: contact 920 gets 2 PM visits within the SAME week (week A) -> "twice in one week".
    // Other contacts dilute variety/concentration below their thresholds.
    contactVisit(302, 920, "Dr PM Repeat", "2026-05-04", "PM"),
    contactVisit(302, 920, "Dr PM Repeat", "2026-05-06", "PM"),
    contactVisit(302, 921, "Dr Other F", "2026-05-11", "AM"),
    contactVisit(302, 922, "Dr Other G", "2026-05-12", "AM"),
    contactVisit(302, 923, "Dr Other H", "2026-05-13", "AM"),

    // CA-4: contact 930 gets exactly one PM visit in week A AND one PM visit in week B — never
    // twice in the same week, but recurs across EVERY week that has any PM visit at all.
    contactVisit(303, 930, "Dr PM Every Week", "2026-05-04", "PM"),
    contactVisit(303, 930, "Dr PM Every Week", "2026-05-11", "PM"),
    contactVisit(303, 931, "Dr Other I", "2026-05-12", "AM"),
    contactVisit(303, 932, "Dr Other J", "2026-05-13", "AM"),
    contactVisit(303, 933, "Dr Other K", "2026-05-14", "AM"),

    // CA-5: healthy — 5 distinct contacts, one visit each, no PM, no consecutive days -> no flags.
    contactVisit(304, 940, "Dr Healthy A", "2026-05-04"),
    contactVisit(304, 941, "Dr Healthy B", "2026-05-06"),
    contactVisit(304, 942, "Dr Healthy C", "2026-05-08"),
    contactVisit(304, 943, "Dr Healthy D", "2026-05-11"),
    contactVisit(304, 944, "Dr Healthy E", "2026-05-13"),

    // CA-6: no customer visits at all (e.g. campaign-only month) -> zero-visit shape, not flagged.
  ];
  const { customerAuthenticityByHrKey } = buildIReports360FieldWorkforceMatrix({
    employees: caEmployees, month: 5, year: 2026, todayIso: "2026-06-01", visits: caVisits,
  });
  const caOf = (hr: string) => {
    const key = canonicalHrIdKey(hr);
    return key ? customerAuthenticityByHrKey.get(key) : undefined;
  };

  const ca1 = caOf("CA-1");
  assert.equal(ca1?.distinctContacts, 2, "CA-1 has 2 distinct contacts");
  assert.equal(ca1?.topContactShare, 5 / 6, "CA-1 top contact share is 5/6");
  assert.equal(ca1?.topContactName, "Dr Mostly Visited", "CA-1 top contact name resolves from contact_name");
  assert.ok(ca1?.flaggedRules.includes("low_variety"), "CA-1 flags low_variety (<3 distinct contacts)");
  assert.ok(ca1?.flaggedRules.includes("high_concentration"), "CA-1 flags high_concentration (>=60% one contact)");
  assert.equal(ca1?.flagged, true);

  const ca2 = caOf("CA-2");
  assert.deepEqual(ca2?.flaggedRules, ["consecutive_same_contact"], "CA-2 flags ONLY consecutive_same_contact — diluted variety/share don't also fire");

  const ca3 = caOf("CA-3");
  assert.ok(ca3?.flaggedRules.includes("pm_recurring_contact"), "CA-3 flags pm_recurring_contact (twice in one ISO week)");

  const ca4 = caOf("CA-4");
  assert.ok(ca4?.flaggedRules.includes("pm_recurring_contact"), "CA-4 flags pm_recurring_contact (recurs every week with a PM visit, even though never twice in the same week)");

  const ca5 = caOf("CA-5");
  assert.deepEqual(ca5?.flaggedRules, [], "CA-5 healthy pattern has no flags");
  assert.equal(ca5?.flagged, false);

  const ca6 = caOf("CA-6");
  assert.deepEqual(ca6, { distinctContacts: 0, flagged: false, flaggedRules: [], topContactName: null, topContactShare: null, totalCustomerVisits: 0 }, "CA-6 with zero customer visits is the empty shape, not flagged");

  // --- 1.3 Attendance cross-check: fusing FWC's own classification with fingerprint punches ---
  const crossCheckCell = (dateIso: string, overrides: Record<string, unknown>) => ({
    context: [], countedAsNoActivityCandidate: false, countedAsVisitTotal: false, countedAsWorkedDay: false,
    dateIso, dayNumber: Number(dateIso.slice(8, 10)), employeeName: "x", explanation: "", hrId: "x",
    ignored: false, isFriday: false, isPreHire: false, isPublicHoliday: false, rawValue: null,
    status: "N",
    ...overrides,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const crossCheckEmployee = (hrId: string, timeline: unknown[]): any => ({ hrId, timeline });

  const acEmployees = [
    crossCheckEmployee("D-1", [
      // Worked day (visits logged), no punch, no exception -> visits_no_punch.
      crossCheckCell("2026-05-04", { countedAsWorkedDay: true, status: "VISITS" }),
      // Worked day, but punched that day -> consistent, no signal.
      crossCheckCell("2026-05-05", { countedAsWorkedDay: true, status: "VISITS" }),
      // N day, punched -> punch_no_visits (corroborates a real no-activity day).
      crossCheckCell("2026-05-06", { status: "N" }),
      // N day, not punched -> genuinely absent both ways, no signal.
      crossCheckCell("2026-05-07", { status: "N" }),
      // Worked day, no punch, but an APPROVED exception that day -> carved out, no signal.
      crossCheckCell("2026-05-08", { countedAsWorkedDay: true, status: "VISITS" }),
      // Ignored day (e.g. holiday/weekly-off) with no punch -> skipped entirely regardless of punch state.
      crossCheckCell("2026-05-09", { countedAsWorkedDay: true, ignored: true, status: "VISITS" }),
      // AV (vacation signal) day, not punched -> consistent (genuinely on leave), no signal.
      crossCheckCell("2026-05-10", { status: "AV" }),
      // AV day, punched, 6h worked (>= the 5h threshold) -> av_with_punch (full contradiction).
      crossCheckCell("2026-05-11", { status: "AV" }),
      // AV day, punched, 2h worked (< the 5h threshold) -> av_with_partial_punch (half-day).
      crossCheckCell("2026-05-12", { status: "AV" }),
      // AV day, punched, but duration unresolvable (no workedMinutesByKey entry) -> conservative
      // default is av_with_partial_punch, never the full contradiction, on incomplete data.
      crossCheckCell("2026-05-13", { status: "AV" }),
    ]),
  ];
  const punchedKeys = new Set(["d-1|2026-05-05", "d-1|2026-05-06", "d-1|2026-05-11", "d-1|2026-05-12", "d-1|2026-05-13"]);
  const exceptionKeys = new Set(["d-1|2026-05-08"]);
  const workedMinutesByKey = new Map([
    ["d-1|2026-05-11", 360],
    ["d-1|2026-05-12", 120],
  ]);
  const crossCheckResult = computeAttendanceCrossCheck({ employees: acEmployees, exceptionKeys, punchedKeys, workedMinutesByKey });

  assert.equal(crossCheckResult.get("d-1|2026-05-04"), "visits_no_punch", "worked day with no punch and no exception -> visits_no_punch");
  assert.equal(crossCheckResult.get("d-1|2026-05-05"), undefined, "worked day WITH a punch is consistent -> no signal");
  assert.equal(crossCheckResult.get("d-1|2026-05-06"), "punch_no_visits", "N day with a punch -> punch_no_visits");
  assert.equal(crossCheckResult.get("d-1|2026-05-07"), undefined, "N day with no punch is consistent (genuinely absent) -> no signal");
  assert.equal(crossCheckResult.get("d-1|2026-05-08"), undefined, "an approved exception carves the day out even though visits+no-punch would otherwise flag it");
  assert.equal(crossCheckResult.get("d-1|2026-05-09"), undefined, "an FWC-ignored day (holiday/weekly-off) is skipped entirely, regardless of punch state");
  assert.equal(crossCheckResult.get("d-1|2026-05-10"), undefined, "an AV (vacation) day with no punch is consistent -> no signal");
  assert.equal(crossCheckResult.get("d-1|2026-05-11"), "av_with_punch", "AV day with a punch and 6h worked (>=5h) -> av_with_punch (full contradiction)");
  assert.equal(crossCheckResult.get("d-1|2026-05-12"), "av_with_partial_punch", "AV day with a punch and 2h worked (<5h) -> av_with_partial_punch (half-day)");
  assert.equal(crossCheckResult.get("d-1|2026-05-13"), "av_with_partial_punch", "AV day with a punch but unresolvable duration defaults to the half-day bucket, not the full contradiction");
  assert.equal(crossCheckResult.size, 5, "exactly the five real disagreements are recorded, nothing else");
  // logsOwnCrmVisitsTitle — who can honestly be judged on NOT logging a CRM visit.
  //
  // Deliberately narrower than isFieldWorkforceComplianceEligibleTitle: a rep owns a
  // contact list and enters visits, so an empty day is that rep's own signal. A manager
  // has no contact list and does not hand-enter visits — the rep submits and TAGS them —
  // so a manager's empty day measures the rep's data entry, which the manager cannot fix.
  //
  // July 2026: 16 managers/PMs carried 131,741.94 EGP (77% of the CRM category), and on
  // 35 of those charged days the person had CLOCKED IN on the fingerprint device.
  for (const repTitle of ["Medical Representative", "Medical Rep", "medical rep", "  MEDICAL   REPRESENTATIVE  "]) {
    assert.ok(logsOwnCrmVisitsTitle(repTitle), `${repTitle} owns a contact list and logs visits, so a no-activity day is their own signal`);
  }
  for (const managerTitle of [
    "National Sales Manager",
    "Regional Sales Manager",
    "District Sales Manager",
    "District Manager",
    "Group Product Manager",
    "Product Manager",
    "Marketing Manager",
    "Training Manager",
    "Sfe Manager",
  ]) {
    assert.ok(
      !logsOwnCrmVisitsTitle(managerTitle),
      `${managerTitle} has no contact list and appears in CRM only when a rep tags them — their absence is the rep's data entry, not their own work, and they cannot correct it`,
    );
    assert.ok(
      isFieldWorkforceComplianceEligibleTitle(managerTitle),
      `${managerTitle} must STILL be field-workforce eligible — this predicate narrows deduction scope only, it does not remove anyone from the compliance report`,
    );
  }
  for (const headOffice of ["Ceo", "Hr Manager", "Admin Assistant", "Qppv", "Office Coordinator", null, ""]) {
    assert.ok(!logsOwnCrmVisitsTitle(headOffice), `${headOffice ?? "(blank)"} has no CRM obligation at all`);
  }
}