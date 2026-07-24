import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canReadPrivateCalendarEmployee,
  buildPrivateCalendarTeamSummary,
  derivePrivateCalendarExceptions,
  filterPrivateCalendarActualItems,
  isPrivateCalendarGlobalViewer,
  mapAttendanceRowToPrivateCalendarItem,
  mapExcuseRowToPrivateCalendarItem,
  mapPlanRowToPrivateCalendarItem,
  mapVacationRowToPrivateCalendarItem,
  summarizePrivateCalendarItems,
} from "../src/lib/private-calendar/logic.ts";
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

  const plan = mapPlanRowToPrivateCalendarItem({
    activity_date: "2026-06-23",
    activity_title: "Field",
    activity_type: "Field",
    area: "Munufia 2",
    employee_hr_id: "E-1",
    employee_name: "Employee One",
    end_time: null,
    id: "plan-1",
    location_text: "Delta 2",
    notes: "Day note",
    plan_kind: "weekly",
    start_time: null,
    status: "submitted",
  });
  assert.equal(plan.source, "plan");
  assert.equal(plan.title, "Single Visit - Munufia 2");
  assert.equal(plan.sourceTable, "employee_plan_items");
  assert.equal(plan.planCountsAsAttendance, true, "a Field/Single Visit plan self-proves attendance");

  // An off-site planned activity (Meeting/Training/Travel/Double Visit/Coaching) —
  // not just the literal "Single Visit" — must self-prove attendance, even while
  // the plan is returned for edit. Otherwise a routine manager action re-flags the
  // employee as absent (the reported bug).
  const offSitePlan = mapPlanRowToPrivateCalendarItem({
    activity_date: "2026-06-17",
    activity_title: "Meeting",
    activity_type: "Meeting",
    area: null,
    employee_hr_id: "E-1",
    employee_name: "Employee One",
    end_time: null,
    id: "plan-mtg-1",
    location_text: null,
    notes: null,
    plan_kind: "weekly",
    start_time: null,
    status: "manager_returned",
  });
  assert.equal(offSitePlan.planCountsAsAttendance, true, "an off-site plan activity self-proves attendance");
  const offSiteExceptions = derivePrivateCalendarExceptions({
    employees: [{ departmentName: null, fullName: "Employee One", hrId: "E-1", jobTitle: "Product Manager", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" }],
    end: "2026-06-17",
    isExpectedWorkday: () => true,
    items: [offSitePlan],
    start: "2026-06-17",
    today: "2026-06-17",
  });
  assert.equal(
    offSiteExceptions.filter((e) => e.title === "No Activity Recorded").length,
    0,
    "an off-site planned day must never be flagged as missing attendance",
  );

  // A desk plan (Office/Admin) with no punch still flags — the employee-facing
  // calendar hides plan items entirely, so whether a hidden plan existed must not
  // change the wording: it's the same "No Activity Recorded" as any other
  // uncovered workday, exactly once (never duplicated).
  const deskPlan = mapPlanRowToPrivateCalendarItem({
    activity_date: "2026-06-17",
    activity_title: "Office",
    activity_type: "Office",
    area: null,
    employee_hr_id: "E-2",
    employee_name: "Employee Two",
    end_time: null,
    id: "plan-office-1",
    location_text: null,
    notes: null,
    plan_kind: "weekly",
    start_time: null,
    status: "submitted",
  });
  assert.equal(deskPlan.planCountsAsAttendance, false, "a desk plan still requires a punch");
  const deskExceptions = derivePrivateCalendarExceptions({
    employees: [{ departmentName: null, fullName: "Employee Two", hrId: "E-2", jobTitle: "Product Manager", lineName: "Line A", managerHrId: "M-1", managerName: "Manager One" }],
    end: "2026-06-17",
    isExpectedWorkday: () => true,
    items: [deskPlan],
    start: "2026-06-17",
    today: "2026-06-17",
  });
  assert.equal(
    deskExceptions.filter((e) => e.title === "No Activity Recorded").length,
    1,
    "a desk plan with no punch flags exactly one No Activity Recorded exception, never a plan-specific variant",
  );
  assert.equal(
    deskExceptions[0]?.description,
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
    items: [attendance, vacation, excuse, plan],
  });
  assert.equal(teamSummary[0]?.sourceCounts.attendance, 1);
  assert.ok((teamSummary[0]?.exceptionCount ?? 0) >= 1, "team summary must count exceptions per employee");

  assert.deepEqual(summarizePrivateCalendarItems([attendance, vacation, excuse, plan]), {
    attendance: 1,
    double_visit: 0,
    excuse: 1,
    holiday: 0,
    plan: 1,
    total: 4,
    vacation: 1,
  });

  const actualOnlyItems = filterPrivateCalendarActualItems([attendance, vacation, excuse, plan]);
  assert.deepEqual(
    actualOnlyItems.map((item) => item.source),
    ["attendance", "vacation", "excuse"],
    "actual-only filter must drop plan items and keep every other source",
  );
  assert.deepEqual(summarizePrivateCalendarItems(actualOnlyItems), {
    attendance: 1,
    double_visit: 0,
    excuse: 1,
    holiday: 0,
    plan: 0,
    total: 3,
    vacation: 1,
  });

  const serviceSource = readFileSync("src/lib/private-calendar/service.ts", "utf8");
  const excuseLoaderSource = serviceSource.slice(
    serviceSource.indexOf("async function loadExcuseItems"),
    serviceSource.indexOf("async function loadPlanItems"),
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
    serviceSource.match(/for \(const \w+ of chunk\(employeeHrKeys\)\)/g)?.length,
    4,
    "vacation, excuse, plan, and no-activity-status private-calendar loaders must batch over expanded employee HR_ID keys",
  );
  assert.match(
    excuseLoaderSource,
    /for \(const \w+ of chunk\(employeeHrKeys\)\)[\s\S]*?\.in\("employee_hr_id", \w+\)/,
    "approved excuse calendar reads must match A-8/a-8/canonical HR_ID dialects",
  );
  assert.doesNotMatch(
    excuseLoaderSource,
    /toUpperCase\(\)/,
    "approved excuse calendar reads must not use uppercase-only HR_ID matching",
  );
  assert.match(serviceSource, /\.eq\("status", "approved"\)/, "vacation and excuse loaders must only read approved rows");
  assert.match(serviceSource, /privateCalendarPlanStatuses/, "plan loader must use the review-proof private-calendar plan statuses (submitted through returned/approved)");
  assert.match(serviceSource, /canReadPrivateCalendarEmployee/, "service must enforce server-side employee scope");
  assert.match(serviceSource, /viewMode/, "service must support employee and team calendar modes");
  assert.match(serviceSource, /derivePrivateCalendarExceptions/, "service must derive private calendar exceptions server-side");
  assert.match(serviceSource, /loadAttendancePolicyGroups/, "service must resolve custom attendance workdays for private calendar exceptions");
  assert.match(
    serviceSource,
    /item\.source !== "attendance" \|\| item\.status === "Complete" \|\| !fieldVisitDates\.has\(item\.startDate\)/,
    "a genuine Complete attendance punch must never be suppressed on a field-visit date, even when an unrelated/unapproved plan entry also claims field work that day — only problem statuses (Late/Short day/Single punch) get suppressed there",
  );
  assert.match(serviceSource, /actualOnly/, "service must support an actual-only (plan-hidden) private calendar mode");
  assert.match(
    serviceSource,
    /derivePrivateCalendarExceptions\(\{[\s\S]*?items,\n/,
    "exceptions must be derived from the full item set (including plan) even in actual-only mode, so field plans keep suppressing false absence flags",
  );

  const apiSource = readFileSync("app/api/private-calendar/route.ts", "utf8");
  assert.match(apiSource, /getPrivateCalendarWorkspace/, "private calendar API must load through the scoped service");
  assert.match(apiSource, /url\.searchParams\.get\("view"\)/, "private calendar API must accept view mode");
  assert.match(apiSource, /actualOnly/, "private calendar API must accept the actual-only display mode");

  const exportRouteSource = readFileSync("app/api/private-calendar/export/route.ts", "utf8");
  assert.match(exportRouteSource, /actualOnly/, "private calendar export must honor actual-only mode so downloads match what the employee sees");

  const employeePortalPageSource = readFileSync("app/employee-portals/private-calendar/page.tsx", "utf8");
  assert.match(employeePortalPageSource, /actualOnly:\s*true/, "employee portal private calendar must request actual-only (no plan items)");

  const accessRegistrySource = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(accessRegistrySource, /\/api\/private-calendar/, "private calendar API must be in access registry");
  assert.match(accessRegistrySource, /\/admin\/private-calendars/, "private calendar admin page must be in access registry");

  const portalLayoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  assert.doesNotMatch(portalLayoutSource, /Private Calendar/, "Private Calendar is hidden from the employee sidebar for all roles");
  assert.match(portalLayoutSource, /\/employee-portals\/plans\/calendar/, "plan users must get the Planning Calendar route");

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
  assert.match(
    privateCalendarUiSource,
    /line-clamp-2/,
    "chip lines must wrap onto up to two rows instead of being cut off on one line",
  );
  assert.match(
    privateCalendarUiSource,
    /divide-y divide-black\/10/,
    "stacked chip lines must be visually separated from the line below them",
  );
  assert.doesNotMatch(
    privateCalendarUiSource,
    /source === "double_visit"\) return "bg-blue-100 text-blue-700"/,
    "double_visit must not share vacation's exact blue chip color",
  );
  assert.doesNotMatch(
    privateCalendarUiSource,
    /source === "double_visit"\) return "bg-blue-500"/,
    "double_visit must not share vacation's exact blue swatch color",
  );
  const doubleVisitIndigoMatches = privateCalendarUiSource.match(/source === "double_visit"\) return "[^"]*indigo/g) ?? [];
  assert.equal(
    doubleVisitIndigoMatches.length,
    3,
    "double_visit must get its own distinct indigo consistently across all remaining source-color helpers (accent, chip, swatch — sourceTone was removed as dead code along with the report table it exclusively served)",
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
  assert.match(workspacePagesSource, /<PrivateCalendar initialWorkspace=\{workspace\} surface="workspace" \/>/, "workspace private calendar must use the admin-shell surface mode");

  const adminPageSource = readFileSync("app/(admin)/admin/private-calendars/page.tsx", "utf8");
  assert.match(adminPageSource, /PrivateCalendarsFilterMap|PrivateCalendar/, "admin private calendars page must render a calendar or filter-map component");

  // (The legacy Vacation Action Center component was removed — replaced by the Approvals Hub
  // Vacation Approvals page. Its "approval impact preview" is a deferred nicety on the new page.)

  const excuseDecisionRouteSource = readFileSync("app/api/excuses/[id]/decision/route.ts", "utf8");
  assert.match(excuseDecisionRouteSource, /private calendar/, "excuse approval result must mention private calendar impact");
}
