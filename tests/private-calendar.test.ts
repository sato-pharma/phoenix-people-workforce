import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canReadPrivateCalendarEmployee,
  buildPrivateCalendarTeamSummary,
  derivePrivateCalendarExceptions,
  isPrivateCalendarGlobalViewer,
  mapAttendanceRowToPrivateCalendarItem,
  mapExcuseRowToPrivateCalendarItem,
  mapVacationRowToPrivateCalendarItem,
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

export function runPrivateCalendarTests() {
  const employee = { hrId: "E-1", managerHrId: "M-1" };
  const directReport = { hrId: "E-2", managerHrId: "M-1" };
  const indirectReport = { hrId: "E-3", managerHrId: "E-2" };
  const unrelated = { hrId: "E-4", managerHrId: "M-9" };

  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "E-1" }), employee), true, "employee can read own private calendar");
  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "M-1", role: "Manager", scope: "team" }), directReport), true, "manager can read direct report calendar");
  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "M-1", role: "Manager", scope: "team" }), indirectReport), false, "manager cannot read indirect report calendar");
  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "M-1", role: "Manager", scope: "team" }), unrelated), false, "manager cannot read unrelated employee calendar");
  assert.equal(canReadPrivateCalendarEmployee(access({ hrId: "AA", role: "CEO", scope: "company" }), unrelated), true, "CEO can read all private calendars");
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
  // it must never suppress or otherwise affect the "No Activity Recorded" check.
  // An employee with zero real items (no punch, no vacation, no excuse, no CRM
  // double visit) on an expected workday flags exactly once, with a description
  // that spells out exactly which sources were checked and came up empty.
  const noItemsExceptions = derivePrivateCalendarExceptions({
    employees: [{ departmentName: null, fullName: "Employee Two", hrId: "E-2", jobTitle: "Product Manager", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" }],
    end: "2026-06-17",
    isExpectedWorkday: () => true,
    items: [],
    start: "2026-06-17",
    today: "2026-06-17",
  });
  assert.equal(
    noItemsExceptions.filter((e) => e.title === "No Activity Recorded").length,
    1,
    "an uncovered workday with no real items flags exactly one No Activity Recorded exception",
  );
  assert.equal(
    noItemsExceptions[0]?.description,
    "Employee Two: no CRM double visit, no fingerprint attendance, no approved vacation, and no approved excuse recorded for this workday.",
    "the description must spell out exactly which sources were checked and came up empty",
  );

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
    today: "2026-07-09",
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
    today: "2026-07-10",
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
    today: "2026-06-18",
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
    today: "2026-05-06",
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
    today: "2026-07-11",
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
    holiday: 0,
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
    today: dvDate,
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
    3,
    "vacation, excuse, and no-activity-status private-calendar loaders must use expanded employee HR_ID keys",
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
  // Both the calendar workspace and the company No Activity Days report must go
  // through the one per-employee helper (behavior asserted above). A local
  // re-implementation is how the company path drifted into suppressing every
  // employee's punches — including Complete ones — on any colleague's
  // double-visit date, manufacturing wrongful payroll deduction candidates.
  assert.equal(
    (serviceSource.match(/suppressFieldVisitAttendanceProblems\(allItems\)/g) ?? []).length,
    2,
    "both the private calendar workspace and getCompanyNoActivityDays must suppress field-visit attendance through the shared per-employee helper",
  );
  assert.doesNotMatch(
    serviceSource,
    /fieldVisitDates/,
    "field-visit suppression must never be re-implemented inline with a date-only key — it would suppress other employees' attendance",
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
  // Private Calendar stays hidden from the sidebar by default for every role — owner-approved
  // 2026-07-24 exception: Talent Acquisition gets it via a dedicated, narrowly-gated flag
  // (showPrivateCalendarTab), not a blanket unlock. Assert the gate exists rather than banning
  // the label outright now that one role legitimately has it.
  assert.match(portalLayoutSource, /showPrivateCalendarTab \? \[\{ href: "\/employee-portals\/private-calendar"/, "Private Calendar must stay behind the showPrivateCalendarTab flag, not render unconditionally");
  assert.match(portalLayoutSource, /\/employee-portals\/plans\/calendar/, "plan users must get the Planning Calendar route");

  const navigationSource = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
  assert.match(navigationSource, /showPrivateCalendarTab: isTalentAcquisition,/, "showPrivateCalendarTab must stay scoped to Talent Acquisition only, not widened to every role");

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
    /grid-cols-\[repeat\(5,minmax\(0,1fr\)\)_56px_56px\]/,
    "the Fri/Sat weekend columns must use a fixed minimal width instead of an equal 1fr share",
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
  assert.doesNotMatch(
    privateCalendarUiSource,
    /source === "double_visit"\) return "[^"]*(blue|indigo)/,
    "double_visit must not use blue or indigo — both read too close to vacation's blue at chip size",
  );
  const doubleVisitFuchsiaMatches = privateCalendarUiSource.match(/source === "double_visit"\) return "[^"]*fuchsia/g) ?? [];
  assert.equal(
    doubleVisitFuchsiaMatches.length,
    3,
    "double_visit must get its own distinct fuchsia consistently across all remaining source-color helpers (accent, chip, swatch)",
  );
  assert.doesNotMatch(
    privateCalendarUiSource,
    /return "[^"]*teal/,
    "holiday (the source-color fallback) must not use teal — it read too close to attendance's emerald green at chip size",
  );
  const holidayVioletMatches = privateCalendarUiSource.match(/return "[^"]*violet/g) ?? [];
  assert.equal(
    holidayVioletMatches.length,
    3,
    "holiday (the source-color fallback) must get its own distinct violet consistently across accent, chip, and swatch",
  );
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
    "Search\/View\/Employee\/Line\/Department must be gated on whether the viewer can actually see more than one employee",
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
}
