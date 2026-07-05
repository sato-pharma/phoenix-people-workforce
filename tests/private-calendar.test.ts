import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canReadPrivateCalendarEmployee,
  buildPrivateCalendarTeamSummary,
  derivePrivateCalendarExceptions,
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
  assert.ok(exceptions.some((item) => item.title === "Missing attendance cover"), "exceptions must include uncovered workdays");

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
    customWorkdayExceptions.filter((item) => item.title === "Missing attendance cover").map((item) => item.date),
    ["2026-05-04", "2026-05-06"],
    "private calendar missing-attendance warnings must follow custom employee workdays before June",
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
    serviceSource.match(/\.in\("employee_hr_id", employeeHrKeys\)/g)?.length,
    3,
    "vacation, excuse, and plan private-calendar loaders must use expanded employee HR_ID keys",
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
  assert.match(serviceSource, /sharedPlanningCalendarStatuses/, "plan loader must use submitted-or-approved planning statuses");
  assert.match(serviceSource, /canReadPrivateCalendarEmployee/, "service must enforce server-side employee scope");
  assert.match(serviceSource, /viewMode/, "service must support employee and team calendar modes");
  assert.match(serviceSource, /derivePrivateCalendarExceptions/, "service must derive private calendar exceptions server-side");
  assert.match(serviceSource, /loadAttendancePolicyGroups/, "service must resolve custom attendance workdays for private calendar exceptions");

  const apiSource = readFileSync("app/api/private-calendar/route.ts", "utf8");
  assert.match(apiSource, /getPrivateCalendarWorkspace/, "private calendar API must load through the scoped service");
  assert.match(apiSource, /url\.searchParams\.get\("view"\)/, "private calendar API must accept view mode");

  const accessRegistrySource = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(accessRegistrySource, /\/api\/private-calendar/, "private calendar API must be in access registry");
  assert.match(accessRegistrySource, /\/admin\/private-calendars/, "private calendar admin page must be in access registry");

  const portalLayoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  assert.match(portalLayoutSource, /Private Calendar/, "employee sidebar must include Private Calendar");
  assert.match(portalLayoutSource, /\/employee-portals\/plans\/calendar/, "plan users must get the Planning Calendar route");

  const navRegistrySource = readFileSync("src/components/employee-portal/employee-portal-nav-registry.ts", "utf8");
  assert.match(navRegistrySource, /\/employee-portals\/private-calendar/, "bottom nav registry must include Private Calendar");
  assert.match(navRegistrySource, /Planning Calendar/, "bottom nav registry must include Planning Calendar for plan users");

  const privateCalendarUiSource = readFileSync("src/components/employee-portal/private-calendar.tsx", "utf8");
  assert.match(privateCalendarUiSource, /Daily Timeline/, "private calendar UI must include daily timeline view");
  assert.match(privateCalendarUiSource, /Manager Team Calendar/, "private calendar UI must include manager team calendar snapshot");
  assert.match(privateCalendarUiSource, /Source trace/, "private calendar UI must include source traceability");
  assert.match(privateCalendarUiSource, /Exception Warnings/, "private calendar UI must highlight exceptions");
  assert.match(privateCalendarUiSource, /Calendar Report/, "private calendar UI must include a calendar report table");
  assert.match(privateCalendarUiSource, /"Date", "Source", "Entry", "Check-in", "Check-out", "Scheduled Time", "Working Hours", "Status", "Full Details"/, "private calendar report must show attendance and calendar detail columns");
  assert.doesNotMatch(privateCalendarUiSource, /"HR ID", "Full Name", "Job Title", "Line", "Department"/, "private calendar report must not expose static identity columns");
  assert.match(privateCalendarUiSource, /Report rows mirror all calendar and attendance details/, "private calendar report must explain that rows mirror calendar and attendance entries");
  assert.doesNotMatch(privateCalendarUiSource, /xl:grid-cols-\[minmax\(0,1fr\)_420px\]/, "private calendar must not narrow the month grid with a right-side timeline rail");
  assert.match(privateCalendarUiSource, /lg:grid-cols-2 2xl:grid-cols-3/, "private calendar timeline must render below the calendar as a responsive card grid");

  const workspacePagesSource = readFileSync("src/components/workspace/admin-shell-employee-pages.tsx", "utf8");
  assert.match(workspacePagesSource, /<PrivateCalendar initialWorkspace=\{workspace\} surface="workspace" \/>/, "workspace private calendar must use the admin-shell surface mode");

  const adminPageSource = readFileSync("app/(admin)/admin/private-calendars/page.tsx", "utf8");
  assert.match(adminPageSource, /PrivateCalendarsFilterMap|PrivateCalendar/, "admin private calendars page must render a calendar or filter-map component");

  // (The legacy Vacation Action Center component was removed — replaced by the Approvals Hub
  // Vacation Approvals page. Its "approval impact preview" is a deferred nicety on the new page.)

  const excuseDecisionRouteSource = readFileSync("app/api/excuses/[id]/decision/route.ts", "utf8");
  assert.match(excuseDecisionRouteSource, /private calendar/, "excuse approval result must mention private calendar impact");
}
