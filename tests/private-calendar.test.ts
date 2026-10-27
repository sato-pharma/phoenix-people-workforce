import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildPrivateCalendarHierarchyIndex,
  canReadPrivateCalendarEmployee,
  buildPrivateCalendarTeamSummary,
  derivePrivateCalendarExceptions,
  isPrivateCalendarGlobalViewer,
  isWithinEmploymentWindow,
  mapAttendanceRowToPrivateCalendarItem,
  mapExcuseRowToPrivateCalendarItem,
  mapVacationRowToPrivateCalendarItem,
  PRIVATE_CALENDAR_PAGE_SIZE,
  readAllPrivateCalendarRows,
  suppressFieldVisitAttendanceProblems,
  summarizePrivateCalendarItems,
} from "../src/lib/private-calendar/logic.ts";
import type { PrivateCalendarItem } from "../src/lib/private-calendar/logic.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

function access(overrides: Partial<AccessContext>): AccessContext {
  return {
    hrId: "E-1",
    loginId: "E-1",
    role: "Employee",
    scope: "self",
    source: "session",
    ...overrides,
  };
}

export async function runPrivateCalendarTests() {
  const employee = { hrId: "E-1", managerHrId: "M-1" };
  const directReport = { hrId: "E-2", managerHrId: "M-1" };
  const indirectReport = { hrId: "E-3", managerHrId: "E-2" };
  const unrelated = { hrId: "E-4", managerHrId: "M-9" };

  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "E-1" }), employee), true, "employee can read own private calendar");
  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "M-1", role: "Manager", scope: "team" }), directReport), true, "manager can read direct report calendar");
  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "M-1", role: "Manager", scope: "team" }), indirectReport), false, "manager cannot read indirect report calendar");
  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "M-1", role: "Manager", scope: "team" }), unrelated), false, "manager cannot read unrelated employee calendar");
  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "AA", role: "CEO", scope: "company" }), unrelated), true, "CEO can read all private calendars");
  // A Regional or National Sales Manager manages through his district managers — owner, 2026-10-20:
  // "when you filter by manager you find no manager". With the directory index he reads his whole
  // subtree, down to the medical rep.
  const nsm = { hrId: "N-1", managerHrId: "AA" };
  const districtManager = { hrId: "D-1", managerHrId: "N-1" };
  const rep = { hrId: "R-1", managerHrId: "D-1" };
  const otherLineRep = { hrId: "R-9", managerHrId: "D-9" };
  const otherLineDistrict = { hrId: "D-9", managerHrId: "N-9" };
  const byCanonicalHrId = buildPrivateCalendarHierarchyIndex([nsm, districtManager, rep, otherLineRep, otherLineDistrict]);
  const nsmAccess = access({ hrId: "N-1", loginId: "N-1", role: "National Sales Manager", scope: "line" });
  assert.equal(canReadPrivateCalendarEmployee(nsmAccess, rep, undefined, { byCanonicalHrId }), true, "a National Sales Manager reads a medical rep two levels down");
  assert.equal(canReadPrivateCalendarEmployee(nsmAccess, districtManager, undefined, { byCanonicalHrId }), true, "a National Sales Manager reads his district manager");
  assert.equal(canReadPrivateCalendarEmployee(nsmAccess, otherLineRep, undefined, { byCanonicalHrId }), false, "a National Sales Manager never reads another line's rep");
  assert.equal(canReadPrivateCalendarEmployee(nsmAccess, rep), false, "without the directory index the walk never runs — a single-row caller stays conservative");
  const rsmAccess = access({ hrId: "D-1", loginId: "D-1", role: "Regional Manager", scope: "hierarchy" });
  assert.equal(canReadPrivateCalendarEmployee(rsmAccess, rep, undefined, { byCanonicalHrId }), true, "a Regional Manager reads his subtree too");
  // Every manager seat reads his whole team beneath him (owner, 2026-10-27) — the Marketing Manager
  // whose Product Manager reports to his Group Product Manager, and a plain Manager alike.
  const wholeTeamMarketingManager = { hrId: "MM-1", managerHrId: "AA" };
  const wholeTeamGroupProductManager = { hrId: "GPM-1", managerHrId: "MM-1" };
  const wholeTeamProductManager = { hrId: "PM-1", managerHrId: "GPM-1" };
  const headOfficeIndex = buildPrivateCalendarHierarchyIndex([wholeTeamMarketingManager, wholeTeamGroupProductManager, wholeTeamProductManager, nsm, districtManager, rep]);
  const marketingAccess = access({ hrId: "MM-1", loginId: "MM-1", role: "Marketing Manager", scope: "line" });
  assert.equal(canReadPrivateCalendarEmployee(marketingAccess, wholeTeamProductManager, undefined, { byCanonicalHrId: headOfficeIndex }), true, "a Marketing Manager reads the Product Manager under his Group Product Manager");
  assert.equal(canReadPrivateCalendarEmployee(marketingAccess, rep, undefined, { byCanonicalHrId: headOfficeIndex }), false, "a Marketing Manager never reads outside his own subtree");
  const groupProductAccess = access({ hrId: "GPM-1", loginId: "GPM-1", role: "Group Product Manager", scope: "line" });
  assert.equal(canReadPrivateCalendarEmployee(groupProductAccess, wholeTeamMarketingManager, undefined, { byCanonicalHrId: headOfficeIndex }), false, "the subtree is downward only — never the manager above");
  const plainManager = access({ hrId: "N-1", loginId: "N-1", role: "Manager", scope: "team" });
  assert.equal(canReadPrivateCalendarEmployee(plainManager, rep, undefined, { byCanonicalHrId }), true, "a head-office Manager reads his whole team beneath him too");
  const selfOnly = access({ hrId: "N-1", loginId: "N-1", role: "Finance Manager", scope: "self" });
  assert.equal(canReadPrivateCalendarEmployee(selfOnly, rep, undefined, { byCanonicalHrId }), false, "a self-scoped seat never walks the subtree");
  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "B-10", role: "Employee", scope: "self" }), unrelated), true, "configured HR manager ID can read all private calendars");
  assert.equal(isPrivateCalendarGlobalViewer(access({ hrId: "admin-HR", loginId: "admin-HR" })), true, "admin-HR is a configured global viewer");

  const attendance = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "9:03 AM",
    actualLastPunch: "5:04 PM",
    dateIso: "2026-06-19",
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "E-1",
    employeeName: "Employee One",
    lateMinutes: "",
    recommendedAction: "No action",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Complete",
    timeLong: "08:01",
  });
  assert.equal(attendance.source, "attendance");
  assert.equal(attendance.time, "9:03 AM - 5:04 PM");
  assert.equal(attendance.sourceTable, "attendance_raw_punches");
  assert.ok(attendance.detailLines.some((line) => line.includes("Working hours: 08:01")));
  assert.equal(attendance.title, "Office 9:03 AM to 5:04 PM - Full day", "a Complete attendance day must render as an Office time range, not a generic status label");
  assert.deepEqual(attendance.chipLines, ["Office", "From 9:03 AM", "To 5:04 PM", "Full day"], "the month-grid chip must stack Office/From/To/status on separate lines instead of one crammed line");

  // A Complete day judged against a HALVED requirement (an approved Am/Pm-Only
  // vacation covers the other half) is a normal half working day — it must never
  // read "Full day", which would misleadingly claim the employee worked the whole day.
  const halfDayVacationAttendanceItem = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "8:50 AM",
    actualLastPunch: "1:00 PM",
    dateIso: "2026-07-09",
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "E-1",
    employeeName: "Employee One",
    halfDayVacationPart: "pm_only",
    lateMinutes: "",
    recommendedAction: "On time and full hours.",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Complete",
    timeLong: "04:10",
  });
  assert.equal(halfDayVacationAttendanceItem.title, "Office 8:50 AM to 1:00 PM - Half day", "a half-day-vacation-adjusted Complete day must read 'Half day', not 'Full day'");
  assert.deepEqual(halfDayVacationAttendanceItem.chipLines, ["Office", "From 8:50 AM", "To 1:00 PM", "Half day"], "the month-grid chip must also say Half day, not Full day, when a half-day vacation covers the other half");

  const lateAttendance = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "9:45 AM",
    actualLastPunch: "5:04 PM",
    dateIso: "2026-06-18",
    deductionDays: "0.25",
    earlyLeaveMinutes: "",
    employeeHrId: "E-1",
    employeeName: "Employee One",
    lateMinutes: "45",
    recommendedAction: "Late arrival",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Late",
    timeLong: "07:19",
  });
  assert.ok(lateAttendance.exceptionFlags.includes("Late arrival"), "attendance mapper must highlight late exceptions");
  assert.equal(lateAttendance.title, "Office 9:45 AM to 5:04 PM - Late", "a non-Complete attendance day must keep its own status label in the Office time range");

  // A late/short/early reading that falls in a policy's zero-deduction band
  // (grace usage, a dead zone below the first bracket, etc.) must not raise a
  // "needs review" warning flag on the private calendar — nothing will actually
  // be deducted, so there is nothing to review.
  const lateNoDeductionAttendance = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "9:10 AM",
    actualLastPunch: "5:04 PM",
    dateIso: "2026-06-19",
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "E-1",
    employeeName: "Employee One",
    lateMinutes: "10",
    recommendedAction: "No action",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Late",
    timeLong: "07:54",
  });
  assert.equal(
    lateNoDeductionAttendance.exceptionFlags.includes("Late arrival"),
    false,
    "a Late status with zero deductionDays must not be flagged as an exception needing review",
  );

  const shortNoDeductionAttendance = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "9:00 AM",
    actualLastPunch: "4:50 PM",
    dateIso: "2026-06-19",
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "E-1",
    employeeName: "Employee One",
    lateMinutes: "",
    recommendedAction: "No action",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Short day",
    timeLong: "07:50",
  });
  assert.equal(
    shortNoDeductionAttendance.exceptionFlags.includes("Short day"),
    false,
    "a Short day status with zero deductionDays must not be flagged as an exception needing review",
  );

  // A missing punch is never auto-deducted at this stage (its deductionDays is
  // always a placeholder 0) — it must stay flagged regardless, since it always
  // needs a human decision before any deduction is determined either way.
  const singlePunchNoDeduction = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "9:03 AM",
    actualLastPunch: "",
    dateIso: "2026-06-19",
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "E-1",
    employeeName: "Employee One",
    lateMinutes: "",
    recommendedAction: "Review missing punch",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Single punch",
    timeLong: "00:00",
  });
  assert.ok(
    singlePunchNoDeduction.exceptionFlags.includes("Single punch"),
    "a missing punch must stay flagged for review even though its deductionDays placeholder is zero",
  );

  const vacation = mapVacationRowToPrivateCalendarItem({
    day_part: "full_day",
    duration_days: "2",
    employee_hr_id: "E-1",
    employee_name: "Employee One",
    end_date: "2026-06-21",
    id: "vac-1",
    paid_duration_days: "2",
    payment_status: "paid",
    start_date: "2026-06-20",
    status: "approved",
    vacation_type: "annual",
  });
  assert.equal(vacation.source, "vacation");
  assert.equal(vacation.startDate, "2026-06-20");
  assert.equal(vacation.endDate, "2026-06-21");
  assert.equal(vacation.sourceRecordId, "vac-1");
  assert.match(vacation.approvalImpact ?? "", /private calendar/i);

  const excuse = mapExcuseRowToPrivateCalendarItem({
    duration_hours: "2",
    employee_hr_id: "E-1",
    employee_name: "Employee One",
    excuse_date: "2026-06-22",
    excuse_type: "afternoon",
    id: "excuse-1",
    status: "approved",
  });
  assert.equal(excuse.source, "excuse");
  assert.equal(excuse.time, "Afternoon (2h)");
  assert.equal(excuse.sourceTable, "v2_excuse_requests");

  // Planning Calendar ("plan") activity is not a private-calendar source at all —
  // it must never suppress or otherwise affect the "No Activity Recorded" check. The
  // description says so in as many words since the owner's ruling of 2026-10-12 (*"NEVER
  // COUNT WEEKLY PLAN AS COVERAGE WHAT IF HE PLANNED BUT DIDNT GO WORK?"*), because between
  // 7 and 12 October an approved plan item of seven types DID clear this day.
  // An employee with zero real items (no punch, no vacation, no excuse, no CRM
  // double visit) on an expected workday flags exactly once, with a description
  // that spells out exactly which sources were checked and came up empty.
  const noItemsExceptions = derivePrivateCalendarExceptions({
    employees: [{ departmentName: null, fullName: "Employee Two", hrId: "E-2", jobTitle: "Product Manager", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" }],
    end: "2026-06-17",
    isExpectedWorkday: () => true,
    items: [],
    start: "2026-06-17",
    today: "2026-06-18",
  });
  assert.equal(
    noItemsExceptions.filter((e) => e.title === "No Activity Recorded").length,
    1,
    "an uncovered workday with no real items flags exactly one No Activity Recorded exception",
  );
  assert.equal(
    noItemsExceptions[0]?.description,
    "Employee Two: no CRM field or double visit, no fingerprint attendance, no approved vacation and no approved excuse recorded for this workday. An approved weekly plan is not a record of work and never clears this day.",
    "the description must spell out exactly which sources were checked and came up empty",
  );

  // A rep's OWN solo CRM visit proves field work exactly as a double visit does.
  // Only the double-visit feed used to be wired in, so 86% of field work was
  // invisible: measured on July 2026 production data, 1,700 rep-days carrying
  // 15,429 real logged visits had no punch, no leave and no double visit, and
  // every one read as "No Activity Recorded". Field reps are not enrolled on
  // fingerprint devices at all, so CRM is their ONLY possible proof of work.
  {
    const fieldVisitItem = {
      approvalImpact: null,
      description: null,
      detailLines: [],
      employeeDepartmentName: null,
      employeeHrId: "E-2",
      employeeJobTitle: null,
      employeeLineName: null,
      employeeName: "Employee Two",
      endDate: "2026-06-17",
      exceptionFlags: [],
      id: "field-visit-e2",
      managerName: null,
      severity: "success" as const,
      source: "field_visit" as const,
      sourceLabel: "Live iReports360 visit mirror",
      sourceRecordId: "field-visit-e2",
      sourceSystem: "CRM Field Visits",
      sourceTable: "ireports360_visits",
      startDate: "2026-06-17",
      status: "performed",
      time: "Full day",
      title: "Field visits: Customer A",
    };
    const covered = derivePrivateCalendarExceptions({
      employees: [{ departmentName: null, fullName: "Employee Two", hrId: "E-2", jobTitle: "Medical Rep", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" }],
      end: "2026-06-17",
      isExpectedWorkday: () => true,
      items: [fieldVisitItem],
      start: "2026-06-17",
      today: "2026-06-18",
    });
    assert.equal(
      covered.filter((e) => e.title === "No Activity Recorded").length,
      0,
      "a rep's own solo CRM field visit must cover the day — it is the only proof a device-less field rep can produce",
    );
  }

  // A half-day vacation (Am/Pm Only) is expected to carry attendance for the other
  // half of the day — that must not be flagged as a conflict. A full-day vacation
  // with attendance still is.
  const halfDayVacation = mapVacationRowToPrivateCalendarItem({
    day_part: "pm_only",
    duration_days: "0.5",
    employee_hr_id: "E-5",
    employee_name: "Employee Five",
    end_date: "2026-07-09",
    id: "vac-half-1",
    paid_duration_days: "0.5",
    payment_status: "paid",
    start_date: "2026-07-09",
    status: "approved",
    vacation_type: "emergency",
  });
  const halfDayAttendance = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "8:50 AM",
    actualLastPunch: "1:00 PM",
    dateIso: "2026-07-09",
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "E-5",
    employeeName: "Employee Five",
    lateMinutes: "",
    recommendedAction: "Morning presence",
    scheduledEnd: "1:00 PM",
    scheduledStart: "9:00 AM",
    status: "Complete",
    timeLong: "04:10",
  });
  const halfDayEmployee = { departmentName: null, fullName: "Employee Five", hrId: "E-5", jobTitle: "Medical Rep", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" };
  const halfDayExceptions = derivePrivateCalendarExceptions({
    employees: [halfDayEmployee],
    end: "2026-07-09",
    isExpectedWorkday: () => true,
    items: [halfDayVacation, halfDayAttendance],
    start: "2026-07-09",
    today: "2026-07-10",
  });
  assert.equal(
    halfDayExceptions.some((e) => e.title === "Attendance during vacation"),
    false,
    "attendance during the non-vacation half of a half-day (Am/Pm Only) vacation must not be flagged",
  );

  const fullDayVacation = mapVacationRowToPrivateCalendarItem({
    day_part: "full_day",
    duration_days: "1",
    employee_hr_id: "E-5",
    employee_name: "Employee Five",
    end_date: "2026-07-10",
    id: "vac-full-1",
    paid_duration_days: "1",
    payment_status: "paid",
    start_date: "2026-07-10",
    status: "approved",
    vacation_type: "annual",
  });
  const fullDayAttendance = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "9:00 AM",
    actualLastPunch: "5:00 PM",
    dateIso: "2026-07-10",
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "E-5",
    employeeName: "Employee Five",
    lateMinutes: "",
    recommendedAction: "No action",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Complete",
    timeLong: "08:00",
  });
  const fullDayExceptions = derivePrivateCalendarExceptions({
    employees: [halfDayEmployee],
    end: "2026-07-10",
    isExpectedWorkday: () => true,
    items: [fullDayVacation, fullDayAttendance],
    start: "2026-07-10",
    today: "2026-07-11",
  });
  assert.ok(
    fullDayExceptions.some((e) => e.title === "Attendance during vacation"),
    "attendance during a full-day vacation must still be flagged",
  );

  const exceptions = derivePrivateCalendarExceptions({
    employees: [{
      departmentName: "Marketing",
      fullName: "Employee One",
      hrId: "E-1",
      jobTitle: "Product Manager",
      lineName: "Line A",
      managerHrId: "M-1",
      managerName: "Manager One",
    }],
    end: "2026-06-18",
    items: [lateAttendance],
    start: "2026-06-17",
    today: "2026-06-19",
  });
  assert.ok(exceptions.some((item) => item.title === "Late arrival"), "exceptions must include attendance warning flags");
  assert.ok(exceptions.some((item) => item.title === "No Activity Recorded"), "exceptions must include uncovered workdays");

  // Only an uncovered EXPECTED workday is flagged — a non-workday, whichever day
  // that is per this custom schedule, stays blank when uncovered (no exception at
  // all, danger or otherwise). A real captured record on any day still shows
  // normally regardless (items are never exception-gated).
  const customWorkdayExceptions = derivePrivateCalendarExceptions({
    employees: [{
      departmentName: "Administration",
      fullName: "A Three",
      hrId: "A-3",
      jobTitle: "Office Admin",
      lineName: "Office",
      managerHrId: "M-1",
      managerName: "Manager One",
    }],
    end: "2026-05-06",
    isExpectedWorkday: (_employee, date) => ["2026-05-04", "2026-05-06"].includes(date),
    items: [],
    start: "2026-05-04",
    today: "2026-05-07",
  });
  assert.deepEqual(
    customWorkdayExceptions.filter((item) => item.title === "No Activity Recorded").map((item) => item.date),
    ["2026-05-04", "2026-05-06"],
    "private calendar missing-attendance warnings must follow custom employee workdays, and the non-workday (2026-05-05) must stay blank",
  );

  // Friday is a day off for every role (isFieldWorkforceFriday — unconditional,
  // no job-title carve-out); Saturday is a day off for every role EXCEPT Medical
  // Rep / District (Sales) Manager, whose weekend is Friday-only
  // (isFieldWorkforceFridayOnlyTitle). Using the real default schedule (no
  // isExpectedWorkday override) over a Fri+Sat pair with nothing recorded:
  // Medical Rep gets flagged on Saturday (it's their workday) but not Friday;
  // a Product Manager (both days off) gets flagged on neither.
  const medicalRep = { departmentName: null, fullName: "Rep One", hrId: "MR-1", jobTitle: "Medical Representative", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" };
  const productManager = { departmentName: null, fullName: "PM One", hrId: "PM-1", jobTitle: "Product Manager", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" };
  const weekendExceptions = derivePrivateCalendarExceptions({
    employees: [medicalRep, productManager],
    end: "2026-07-11",
    items: [],
    start: "2026-07-10",
    today: "2026-07-12",
  });
  assert.deepEqual(
    weekendExceptions.filter((item) => item.title === "No Activity Recorded").map((item) => `${item.employeeHrId}:${item.date}`),
    ["MR-1:2026-07-11"],
    "Saturday (2026-07-11) is a real workday for Medical Rep only — Friday stays blank for everyone, Saturday stays blank for the Product Manager too",
  );

  const teamSummary = buildPrivateCalendarTeamSummary({
    employees: [{
      departmentName: "Marketing",
      fullName: "Employee One",
      hrId: "E-1",
      jobTitle: "Product Manager",
      lineName: "Line A",
      managerHrId: "M-1",
      managerName: "Manager One",
    }],
    exceptions,
    items: [attendance, vacation, excuse],
  });
  assert.equal(teamSummary[0]?.sourceCounts.attendance, 1);
  assert.ok((teamSummary[0]?.exceptionCount ?? 0) >= 1, "team summary must count exceptions per employee");

  assert.deepEqual(summarizePrivateCalendarItems([attendance, vacation, excuse]), {
    attendance: 1,
    double_visit: 0,
    excuse: 1,
    field_visit: 0,
    holiday: 0,
    plan: 0,
    total: 3,
    vacation: 1,
  });

  // Field-visit attendance suppression must be scoped to the employee who was
  // actually out on the double visit. The company No Activity Days report runs
  // this over the WHOLE roster and its output becomes payroll deduction
  // candidates, so a date-keyed filter would let one employee's double visit
  // erase a different employee's punches and flag them "No Activity Recorded".
  const dvDate = "2026-06-22";
  const visitingRepDoubleVisit: PrivateCalendarItem = {
    approvalImpact: null,
    description: null,
    detailLines: [],
    employeeDepartmentName: null,
    employeeHrId: "E-1",
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: "Employee One",
    endDate: dvDate,
    exceptionFlags: [],
    id: `double-visit-E-1-${dvDate}`,
    managerName: null,
    severity: "info",
    source: "double_visit",
    sourceLabel: "Double Visit",
    sourceRecordId: null,
    sourceSystem: "iReports360",
    sourceTable: "ireports360_visits",
    startDate: dvDate,
    status: "Completed",
    time: null,
    title: "Double visit",
  };
  const otherEmployeeCompletePunch = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "8:58 AM",
    actualLastPunch: "5:06 PM",
    dateIso: dvDate,
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "E-2",
    employeeName: "Employee Two",
    lateMinutes: "",
    recommendedAction: "No action",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Complete",
    timeLong: "08:08",
  });
  const visitingRepLatePunch = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "10:41 AM",
    actualLastPunch: "5:02 PM",
    dateIso: dvDate,
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "E-1",
    employeeName: "Employee One",
    lateMinutes: "101",
    recommendedAction: "Review",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Late",
    timeLong: "06:21",
  });
  // A second double-visit day for the same rep, where they DID punch a full day.
  // (One attendance row per employee per date, so this needs its own date.)
  const secondDvDate = "2026-06-23";
  const visitingRepSecondDoubleVisit: PrivateCalendarItem = {
    ...visitingRepDoubleVisit,
    endDate: secondDvDate,
    id: `double-visit-E-1-${secondDvDate}`,
    startDate: secondDvDate,
  };
  const visitingRepCompletePunch = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "8:55 AM",
    actualLastPunch: "5:01 PM",
    dateIso: secondDvDate,
    deductionDays: "0",
    earlyLeaveMinutes: "",
    employeeHrId: "E-1",
    employeeName: "Employee One",
    lateMinutes: "",
    recommendedAction: "No action",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Complete",
    timeLong: "08:06",
  });
  const suppressed = suppressFieldVisitAttendanceProblems([
    visitingRepDoubleVisit,
    visitingRepSecondDoubleVisit,
    otherEmployeeCompletePunch,
    visitingRepLatePunch,
    visitingRepCompletePunch,
  ]);
  const suppressedIds = new Set(suppressed.map((item) => item.id));
  assert.ok(
    suppressedIds.has(otherEmployeeCompletePunch.id),
    "a colleague's double visit must never suppress a DIFFERENT employee's attendance — that would flag them 'No Activity Recorded' and feed a wrongful payroll deduction",
  );
  assert.ok(
    suppressedIds.has(visitingRepCompletePunch.id),
    "a genuine Complete punch must survive on a field-visit date — real proof of presence always wins",
  );
  assert.ok(
    !suppressedIds.has(visitingRepLatePunch.id),
    "the visiting employee's own Late/Short-day flag must still be suppressed on their double-visit date",
  );
  assert.ok(
    suppressedIds.has(visitingRepDoubleVisit.id),
    "double-visit items themselves are never filtered",
  );
  // The employee who merely shares the date must still count as covered, i.e.
  // must never surface as "No Activity Recorded" in the company report.
  const teammateCoverageExceptions = derivePrivateCalendarExceptions({
    employees: [{
      departmentName: null,
      fullName: "Employee Two",
      hrId: "E-2",
      jobTitle: "Medical Rep",
      lineName: null,
      managerHrId: null,
      managerName: null,
    }],
    end: dvDate,
    isExpectedWorkday: () => true,
    items: suppressed,
    start: dvDate,
    today: "2026-06-23",
  });
  assert.equal(
    teammateCoverageExceptions.filter((exception) => exception.title === "No Activity Recorded").length,
    0,
    "an employee who punched a full day must never be reported 'No Activity Recorded' because a teammate had a double visit that date",
  );

  const serviceSource = readFileSync("src/lib/private-calendar/service.ts", "utf8");
  const excuseLoaderSource = serviceSource.slice(
    serviceSource.indexOf("async function loadExcuseItems"),
    serviceSource.indexOf("export function canUsePrivateCalendarAdminSurface"),
  );
  assert.match(
    serviceSource,
    /import \{ hrIdLookupKeys \} from "@\/lib\/hr-id"/,
    "private calendar must use the shared HR_ID lookup helper",
  );
  assert.match(
    serviceSource,
    /function expandHrIdLookupKeys/,
    "private calendar must expand employee HR_ID filters into known casing dialects",
  );
  assert.equal(
    serviceSource.match(/\.in\("employee_hr_id", employeeHrKeys\)/g)?.length,
    2,
    "the vacation and excuse private-calendar loaders must use expanded employee HR_ID keys",
  );
  assert.match(
    excuseLoaderSource,
    /\.in\("employee_hr_id", employeeHrKeys\)/,
    "approved excuse calendar reads must match A-8/a-8/canonical HR_ID dialects",
  );
  assert.doesNotMatch(
    excuseLoaderSource,
    /toUpperCase\(\)/,
    "approved excuse calendar reads must not use uppercase-only HR_ID matching",
  );
  assert.match(serviceSource, /\.eq\("status", "approved"\)/, "vacation and excuse loaders must only read approved rows");
  assert.doesNotMatch(serviceSource, /loadPlanItems|privateCalendarPlanStatuses|mapPlanRowToPrivateCalendarItem/, "the Planning Calendar (plan) source must never sync into the private calendar again");
  assert.match(serviceSource, /canReadPrivateCalendarEmployee/, "service must enforce server-side employee scope");
  assert.match(serviceSource, /viewMode/, "service must support employee and team calendar modes");
  assert.match(serviceSource, /derivePrivateCalendarExceptions/, "service must derive private calendar exceptions server-side");
  assert.match(serviceSource, /loadAttendancePolicyGroups/, "service must resolve custom attendance workdays for private calendar exceptions");
  // Field-visit suppression must go through the one per-employee helper
  // (behavior asserted above) in BOTH the employee/team workspace and the
  // company-wide engine. A local re-implementation is how the company path
  // drifted into suppressing every employee's punches — including Complete
  // ones — on any colleague's double-visit date, manufacturing wrongful
  // payroll deduction candidates.
  assert.equal(
    (serviceSource.match(/suppressFieldVisitAttendanceProblems\(allItems\)/g) ?? []).length,
    2,
    "the private calendar workspace and the company no-activity engine must both suppress field-visit attendance through the shared per-employee helper",
  );
  assert.doesNotMatch(
    serviceSource,
    /fieldVisitDates/,
    "field-visit suppression must never be re-implemented inline with a date-only key — it would suppress other employees' attendance",
  );
  // The No Activity Days admin module is retired: no clarification workflow and
  // no payroll-deduction decisions from the private calendar. getCompanyNoActivityDays
  // itself SURVIVES — it is the engine the unified Deductions module's No Records
  // Activity connector reuses, and it decides nothing on its own.
  assert.doesNotMatch(
    serviceSource,
    /no_activity_clarifications|appendNoActivityStatusExceptions/,
    "the retired clarification workflow must not come back into the private calendar service",
  );
  assert.match(
    serviceSource,
    /export async function getCompanyNoActivityDays/,
    "the company no-activity engine must stay — the unified Deductions connector depends on it",
  );
  assert.match(
    serviceSource,
    /derivePrivateCalendarExceptions\(\{[\s\S]*?items,\n/,
    "exceptions must be derived from the full recorded/verified item set",
  );

  const apiSource = readFileSync("app/api/private-calendar/route.ts", "utf8");
  assert.match(apiSource, /getPrivateCalendarWorkspace/, "private calendar API must load through the scoped service");
  assert.match(apiSource, /url\.searchParams\.get\("view"\)/, "private calendar API must accept view mode");
  assert.match(apiSource, /actualOnly/, "private calendar API must accept the actual-only display mode");

  const exportRouteSource = readFileSync("app/api/private-calendar/export/route.ts", "utf8");
  assert.match(exportRouteSource, /actualOnly/, "private calendar export must honor actual-only mode so downloads match what the employee sees");

  const employeePortalPageSource = readFileSync("app/employee-portals/private-calendar/page.tsx", "utf8");
  assert.match(employeePortalPageSource, /actualOnly:\s*true/, "employee portal private calendar must keep requesting actual-only display mode");

  const accessRegistrySource = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(accessRegistrySource, /\/api\/private-calendar/, "private calendar API must be in access registry");
  assert.match(accessRegistrySource, /\/admin\/private-calendars/, "private calendar admin page must be in access registry");

  const portalLayoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  // Private Calendar is self-scoped and, as of the 2026-08-01 owner decision, shown to EVERY
  // portal role (it was a narrowly-gated Talent-Acquisition-only exception, owner-approved
  // 2026-07-24). It stays behind the showPrivateCalendarTab flag rather than rendering
  // unconditionally, so Modules Control can still curate it per role/person — assert the gate
  // exists, not that any one role is excluded.
  assert.match(portalLayoutSource, /showPrivateCalendarTab \? \[\{ href: "\/employee-portals\/private-calendar"/, "Private Calendar must stay behind the showPrivateCalendarTab flag, not render unconditionally");
  assert.match(portalLayoutSource, /\/employee-portals\/plans\/calendar/, "plan users must get the Planning Calendar route");

  const navigationSource = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
  assert.match(navigationSource, /showPrivateCalendarTab: true,/, "showPrivateCalendarTab is granted to every portal role (2026-08-01 owner decision); the page is self-scoped and every role holds attendance:read");

  const navRegistrySource = readFileSync("src/components/employee-portal/employee-portal-nav-registry.ts", "utf8");
  assert.doesNotMatch(navRegistrySource, /\/employee-portals\/private-calendar/, "Private Calendar is removed from the bottom-nav registry for all roles");
  assert.match(navRegistrySource, /Planning Calendar/, "bottom nav registry must include Planning Calendar for plan users");

  const privateCalendarUiSource = readFileSync("src/components/employee-portal/private-calendar.tsx", "utf8");
  assert.match(privateCalendarUiSource, /Daily Timeline/, "private calendar UI must include daily timeline view");
  assert.match(
    privateCalendarUiSource,
    /function syncNow\(\) \{/,
    "the Sync Now button must call a real handler, not just render a static label",
  );
  assert.match(
    privateCalendarUiSource,
    /await loadWorkspace\(year, month, selectedEmployee\.hrId, selectedDate, viewMode\);/,
    "Sync Now must re-run the exact same live fetch as navigation, for the currently viewed month/employee, not a no-op",
  );
  assert.match(
    privateCalendarUiSource,
    /onClick=\{syncNow\}/,
    "the Sync Now button must be wired to the real handler",
  );
  assert.match(
    privateCalendarUiSource,
    /setLastSyncedAt\(new Date\(\)\);/,
    "every successful fetch (nav or Sync Now) must record a fresh synced-at timestamp so the UI never shows a stale claim of freshness",
  );
  assert.match(privateCalendarUiSource, /Manager Team Calendar/, "private calendar UI must include manager team calendar snapshot");
  assert.match(privateCalendarUiSource, /Source trace/, "private calendar UI must include source traceability");
  assert.match(privateCalendarUiSource, /Exception Warnings/, "private calendar UI must highlight exceptions");
  // The on-page Calendar Report table was removed — the report now exists only
  // as the XLSX/PDF export (a separate, already-independent server-side code
  // path in src/lib/private-calendar/export.ts), never rendered in the browser.
  assert.doesNotMatch(privateCalendarUiSource, /Calendar Report/, "the calendar report table must no longer render on the page");
  assert.doesNotMatch(privateCalendarUiSource, /CalendarReportTable/, "the CalendarReportTable component must be fully removed, not just unrendered");
  assert.doesNotMatch(privateCalendarUiSource, /"Date", "Source", "Entry", "Check-in", "Check-out", "Scheduled Time", "Working Hours", "Status", "Full Details"/, "the report table's column header row must be gone from the frontend");
  assert.match(privateCalendarUiSource, /XLSX/, "the XLSX export control must remain the only way to get the calendar report");
  assert.match(privateCalendarUiSource, /\/api\/private-calendar\/export\?format=xlsx/, "XLSX export must still hit the independent server-side export route");
  assert.doesNotMatch(privateCalendarUiSource, /xl:grid-cols-\[minmax\(0,1fr\)_420px\]/, "private calendar must not narrow the month grid with a right-side timeline rail");
  assert.match(privateCalendarUiSource, /lg:grid-cols-2 2xl:grid-cols-3/, "private calendar timeline must render below the calendar as a responsive card grid");
  assert.match(
    privateCalendarUiSource,
    /grid-cols-\[repeat\(5,minmax\(0,1fr\)\)_56px_minmax\(0,1fr\)\]/,
    "only FRIDAY is the narrow fixed column — Saturday is a working day for the Medical Rep / District Manager population (Friday-only weekend, isFieldWorkforceFridayOnlyTitle), so it must get an equal 1fr share like Sun–Thu, not a fixed 56px weekend width",
  );
  assert.doesNotMatch(
    privateCalendarUiSource,
    /<span className="block truncate" key=\{lineIndex\}>\{line\}<\/span>/,
    "chip lines must not be truncated with an ellipsis — long names should wrap instead",
  );
  assert.doesNotMatch(
    privateCalendarUiSource,
    /line-clamp-\d/,
    "chip lines must never be capped at N rows — every word must stay fully visible, no matter how many lines it takes",
  );
  assert.match(
    privateCalendarUiSource,
    /<span className="block py-1 \[overflow-wrap:anywhere\]" key=\{lineIndex\}>\{line\}<\/span>/,
    "each chip line must render as its own block-level row, fully unclamped, so the day cell grows to fit every word",
  );
  assert.match(
    privateCalendarUiSource,
    /divide-y divide-black\/15/,
    "stacked chip lines (each 'sentence' — DV partner / AM-PM count / area) must be visually separated from the line below them",
  );
  // Colours live in ONE table keyed by kind of day (kindTones), read by every helper. A double visit
  // — regular or campaign — wears fuchsia in all three slots (accent, chip, swatch), never blue or
  // indigo (too close to vacation's sky at chip size), and no other kind wears fuchsia.
  const kindTonesBlock = privateCalendarUiSource.match(/const kindTones: Record<[^>]+> = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  assert.ok(kindTonesBlock, "the calendar keeps one colour table keyed by kind of day");
  const kindToneEntries = new Map(
    [...kindTonesBlock.matchAll(/\n {2}(\w+): \{([\s\S]*?)\n {2}\}/g)].map((match) => [match[1], match[2]] as const),
  );
  for (const kind of ["double_regular", "double_campaign"]) {
    const entry = kindToneEntries.get(kind) ?? "";
    for (const slot of ["accent", "chip", "swatch"]) {
      const value = entry.match(new RegExp(`${slot}: "([^"]*)"`))?.[1] ?? "";
      assert.match(value, /fuchsia/, `${kind} must wear fuchsia in its ${slot}`);
      assert.doesNotMatch(value, /blue|indigo/, `${kind} must not use blue or indigo in its ${slot} — both read too close to vacation at chip size`);
    }
  }
  for (const [kind, entry] of kindToneEntries) {
    if (kind.startsWith("double_")) continue;
    assert.doesNotMatch(entry, /fuchsia/, `fuchsia is the double visit's own colour — ${kind} must not wear it`);
  }
  // A national holiday wears its own violet in all three slots, never teal (too close to
  // attendance's emerald at chip size), and no other kind wears violet.
  const holidayEntry = kindToneEntries.get("holiday") ?? "";
  for (const slot of ["accent", "chip", "swatch"]) {
    const value = holidayEntry.match(new RegExp(`${slot}: "([^"]*)"`))?.[1] ?? "";
    assert.match(value, /violet/, `holiday must wear its own violet in its ${slot}`);
    assert.doesNotMatch(value, /teal/, `holiday must not use teal in its ${slot} — it read too close to attendance's emerald at chip size`);
  }
  for (const [kind, entry] of kindToneEntries) {
    if (kind === "holiday") continue;
    assert.doesNotMatch(entry, /violet/, `violet is the national holiday's own colour — ${kind} must not wear it`);
  }
  assert.doesNotMatch(
    privateCalendarUiSource,
    /function sourceTone\(/,
    "sourceTone must not be reintroduced as dead code — it had no callers left once the report table was removed",
  );
  assert.match(
    privateCalendarUiSource,
    /function exceptionTone\(/,
    "exceptionTone (danger/warning/info) must exist to style the never-blank No Activity Recorded exceptions consistently across the grid, agenda, and detail panel",
  );
  assert.match(
    privateCalendarUiSource,
    /const canFilterAcrossEmployees = workspace\.access\.canSelectEmployee;/,
    "Search/View/Employee/Line/Department must be gated on whether the viewer can actually see more than one employee",
  );
  assert.match(
    privateCalendarUiSource,
    /\{canFilterAcrossEmployees \? \(\s*\n\s*<>/,
    "the multi-employee-only filters must be wrapped behind the canFilterAcrossEmployees gate, not always rendered",
  );

  const workspacePagesSource = readFileSync("src/components/workspace/admin-shell-employee-pages.tsx", "utf8");
  assert.match(workspacePagesSource, /<PrivateCalendar initialWorkspace=\{workspace\} surface="workspace"[^/]*\/>/, "workspace private calendar must use the admin-shell surface mode");

  const adminPageSource = readFileSync("app/(admin)/admin/private-calendars/page.tsx", "utf8");
  assert.match(adminPageSource, /PrivateCalendarsFilterMap|PrivateCalendar/, "admin private calendars page must render a calendar or filter-map component");

  // (The legacy Vacation Action Center component was removed — replaced by the Approvals Hub
  // Vacation Approvals page. Its "approval impact preview" is a deferred nicety on the new page.)

  const excuseDecisionRouteSource = readFileSync("app/api/excuses/[id]/decision/route.ts", "utf8");
  assert.match(excuseDecisionRouteSource, /private calendar/, "excuse approval result must mention private calendar impact");

  // ── Private Calendar audit, 2026-09-21. Every case below was a defect measured live on the
  // portal before it was fixed; each assertion is the one that goes red if the fix is undone.

  // TODAY IS NEVER JUDGED. A rep's visits sync from the CRM through the day and an office
  // worker's second punch lands at the end of it, so judging today flagged everyone mid-shift.
  {
    const emptyToday = derivePrivateCalendarExceptions({
      employees: [{ departmentName: null, fullName: "Employee Two", hrId: "E-2", jobTitle: "Product Manager", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" }],
      end: "2026-06-17",
      isExpectedWorkday: () => true,
      items: [],
      start: "2026-06-17",
      today: "2026-06-17",
    });
    assert.equal(emptyToday.length, 0, "today is still in progress — an empty today must never read 'No Activity Recorded'");

    const officeWorker = [{ departmentName: null, fullName: "Employee One", hrId: "E-1", jobTitle: "Product Manager", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" }];
    const morningPunchToday = derivePrivateCalendarExceptions({
      employees: officeWorker,
      end: "2026-06-19",
      isExpectedWorkday: () => true,
      items: [singlePunchNoDeduction],
      start: "2026-06-19",
      today: "2026-06-19",
    });
    assert.equal(
      morningPunchToday.some((exception) => exception.title === "Single punch"),
      false,
      "this morning's punch is not a missing punch yet — the evening punch has not happened",
    );
    const morningPunchEnded = derivePrivateCalendarExceptions({
      employees: officeWorker,
      end: "2026-06-19",
      isExpectedWorkday: () => true,
      items: [singlePunchNoDeduction],
      start: "2026-06-19",
      today: "2026-06-20",
    });
    assert.ok(
      morningPunchEnded.some((exception) => exception.title === "Single punch"),
      "once the day has ended, a lone punch is flagged for review",
    );
  }

  // THE EMPLOYMENT WINDOW. A rep hired on the 12th was flagged "No Activity Recorded" for every
  // workday of the month before he joined.
  assert.equal(isWithinEmploymentWindow("2026-09-11", { hireDate: "2026-09-12" }), false, "a day before the hire date is outside employment");
  assert.equal(isWithinEmploymentWindow("2026-09-12", { hireDate: "2026-09-12" }), true, "the hire date itself is a working day");
  assert.equal(
    isWithinEmploymentWindow("2026-09-21", { hireDate: "2026-09-01T00:00:00+00:00", lastWorkingDate: "2026-09-20" }),
    false,
    "a day after the last working date is outside employment (and a timestamped hire date reads as its date)",
  );
  assert.equal(isWithinEmploymentWindow("2026-09-20", { lastWorkingDate: "2026-09-20" }), true, "the last working date itself is a working day");
  assert.equal(isWithinEmploymentWindow("2026-09-20", { hireDate: null, lastWorkingDate: null }), true, "no recorded dates means no window to apply");
  {
    const newHire = derivePrivateCalendarExceptions({
      employees: [{ departmentName: null, fullName: "New Hire", hrId: "PD-1", jobTitle: "Medical Rep", lineName: "Pedia", managerHrId: "M-1", managerName: "Manager One" }],
      end: "2026-09-14",
      isExpectedWorkday: (_employee, date) => isWithinEmploymentWindow(date, { hireDate: "2026-09-12" }),
      items: [],
      start: "2026-09-10",
      today: "2026-09-21",
    });
    assert.deepEqual(
      newHire.filter((exception) => exception.title === "No Activity Recorded").map((exception) => exception.date),
      ["2026-09-12", "2026-09-13", "2026-09-14"],
      "days before the hire date are never judged — only the days he was employed",
    );
  }
  assert.equal(
    (serviceSource.match(/isExpectedWorkday: expectedWorkdayResolver\(/g) ?? []).length,
    2,
    "the employee/team calendar AND the company no-activity engine must both apply the employment window through the one resolver",
  );
  assert.match(
    serviceSource,
    /if \(employmentWindow && !isWithinEmploymentWindow\(date, employmentWindow\)\) return false;/,
    "the resolver must refuse every day outside the employment window before it consults the attendance policy",
  );

  // ATTENDANCE COLOUR FOLLOWS THE FLAGS, never the raw status word: a zero-deduction Short day
  // raised no flag in the strip yet painted amber on the grid.
  assert.equal(shortNoDeductionAttendance.severity, "info", "a Short day in a zero-deduction band is plain information, not a warning");
  assert.equal(lateNoDeductionAttendance.severity, "info", "a Late status in a zero-deduction band is plain information, not a warning");
  assert.equal(lateAttendance.severity, "warning", "a late arrival that costs a deduction needs review");
  assert.equal(singlePunchNoDeduction.severity, "warning", "a lone punch always needs review");
  assert.equal(attendance.severity, "success", "a complete day is good news");
  const absentAttendance = mapAttendanceRowToPrivateCalendarItem({
    actualFirstPunch: "",
    actualLastPunch: "",
    dateIso: "2026-06-19",
    deductionDays: "1",
    earlyLeaveMinutes: "",
    employeeHrId: "E-1",
    employeeName: "Employee One",
    lateMinutes: "",
    recommendedAction: "Absence",
    scheduledEnd: "5:00 PM",
    scheduledStart: "9:00 AM",
    status: "Absent",
    timeLong: "00:00",
  });
  assert.equal(absentAttendance.severity, "danger", "an absence that costs a deduction is a real problem");

  // A LONE PUNCH READS "Punch", never "From": a 5:06 PM punch is almost certainly a departure.
  assert.equal(singlePunchNoDeduction.title, "Office punch 9:03 AM - Single punch", "a lone punch must not claim to be the arrival");
  assert.deepEqual(singlePunchNoDeduction.chipLines, ["Office", "Punch 9:03 AM", "Single punch"], "the month-grid chip must say Punch, not From");

  // HALF-DAY VACATION reads the house label ("PM only"), never the raw code cased ("Pm Only").
  assert.equal(halfDayVacation.time, "PM only", "a half-day vacation's time must read 'PM only'");
  assert.ok(halfDayVacation.detailLines.includes("Day part: PM only"), "the detail line must use the same label");

  // AN APPROVED EXCUSE IS COVERED TIME — it painted the same amber as a late punch.
  assert.equal(excuse.severity, "info", "an approved excuse is not something to review");

  // THE TEAM SNAPSHOT counts what needs review only — a review request's own status (info) is
  // news for the employee, never a warning against them.
  {
    const teamEmployee = [{ departmentName: "Marketing", fullName: "Employee One", hrId: "E-1", jobTitle: "Product Manager", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" }];
    const reviewException = exceptions.find((exception) => exception.title === "Late arrival");
    assert.ok(reviewException, "fixture: the late-arrival exception must exist");
    const infoOnly = buildPrivateCalendarTeamSummary({ employees: teamEmployee, exceptions: [{ ...reviewException, severity: "info" }], items: [] });
    assert.equal(infoOnly[0]?.exceptionCount, 0, "an info exception must not count as a warning in the team snapshot");
    const oneWarning = buildPrivateCalendarTeamSummary({ employees: teamEmployee, exceptions: [reviewException], items: [] });
    assert.equal(oneWarning[0]?.exceptionCount, 1, "a real warning still counts");
  }

  // THE LEAVE LOADERS PAGE THROUGH EVERY ROW. Both stopped at a fixed 100, so a team or
  // company month past 100 leave rows lost the rest — and every lost day read "No Activity
  // Recorded" although the leave was approved.
  {
    assert.equal(PRIVATE_CALENDAR_PAGE_SIZE, 1000, "a page is PostgREST's own 1,000-row cap");
    const source = Array.from({ length: 2500 }, (_, index) => ({ id: index }));
    const ranges: Array<[number, number]> = [];
    const rows = await readAllPrivateCalendarRows<{ id: number }>(async (from, to) => {
      ranges.push([from, to]);
      return { data: source.slice(from, to + 1), error: null };
    });
    assert.equal(rows.length, 2500, "every one of 2,500 rows must come back, not the first 100 or 1,000");
    assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]], "pages must be contiguous and never overlap");

    const exactRanges: Array<[number, number]> = [];
    const exact = await readAllPrivateCalendarRows<{ id: number }>(async (from, to) => {
      exactRanges.push([from, to]);
      return { data: source.slice(0, 1000).slice(from, to + 1), error: null };
    });
    assert.equal(exact.length, 1000, "an exact multiple of the page size must not lose or repeat a row");
    assert.equal(exactRanges.length, 2, "a full page is never assumed to be the last one");

    await assert.rejects(
      readAllPrivateCalendarRows(async () => ({ data: null, error: new Error("page failed") })),
      /page failed/,
      "a failed page must throw, never return a silently short list",
    );
  }
  assert.doesNotMatch(serviceSource, /\.limit\(100\)/, "no private calendar loader may stop at a fixed 100 rows");
  assert.equal(
    (serviceSource.match(/await readAllPrivateCalendarRows<(VacationCalendarRow|ExcuseCalendarRow)>\(/g) ?? []).length,
    2,
    "both leave loaders must read through the pager",
  );

  // ONE NAME PER PERSON: a vacation row carries the legal name it was filed under, which made one
  // person read as two different people across a team calendar.
  assert.match(
    serviceSource,
    /employeeName: employee\.fullName \|\| item\.employeeName,/,
    "the directory's display name must win over the name a source row carries",
  );

  // CAIRO'S MONTH: both routes defaulted to UTC's, which is still the previous month for the
  // first hours of every month in Cairo.
  for (const [label, routeSource] of [["calendar API", apiSource], ["calendar export", exportRouteSource]] as const) {
    assert.match(routeSource, /currentCairoDateParts\(\)/, `the ${label} must default to Cairo's month`);
    assert.doesNotMatch(routeSource, /getUTCMonth\(\)|getUTCFullYear\(\)/, `the ${label} must never default to UTC's month`);
  }

  // THE PALETTE: one colour per KIND of day — who went (single, double, chain) crossed with
  // regular or campaign for a visit — pinned in full by tests/visit-count-golden-rule.test.ts.
  assert.match(privateCalendarUiSource, /const kindTones: Record<PrivateCalendarActivityKind/, "every kind of day has its own tones");
  assert.doesNotMatch(
    privateCalendarUiSource,
    /function sourceChipTone\(source: PrivateCalendarSource, severity/,
    "a problem must never repaint a kind's colour — severity is an outline round the kind's own card",
  );

  // THE SCREEN: every visit is counted AM · PM · Pharmacies apart, the strip never silently drops
  // rows past 8, a sent review request shows at once, and a phone gets a compact month instead of
  // one-letter lines.
  assert.match(privateCalendarUiSource, /<KeyFigures\b/, "the key figures count every kind, visits AM · PM · Pharmacies apart");
  assert.doesNotMatch(privateCalendarUiSource, /filteredExceptions\.slice\(0, 8\)\.map/, "the exception strip must not silently cap at 8");
  assert.match(privateCalendarUiSource, /Show all \$\{filteredExceptions\.length\}/, "the strip must offer every exception past the first 8");
  assert.match(
    privateCalendarUiSource,
    /await loadWorkspace\(year, month, selectedEmployee\.hrId, selectedDate, viewMode\)\.catch\(\(\) => undefined\);/,
    "a sent review request must re-read the month so its pending status shows at once",
  );
  assert.match(privateCalendarUiSource, /"mt-1\.5 hidden space-y-2 md:block"/, "the full day-cell entries must show from md up only");
  assert.match(privateCalendarUiSource, /"flex flex-wrap justify-center gap-0\.5 md:hidden"/, "a phone must get one colour marker per kind instead of the entries");
}
