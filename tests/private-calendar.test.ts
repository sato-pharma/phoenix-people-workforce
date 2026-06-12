import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  canReadPrivateCalendarEmployee,
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
  assert.ok(attendance.detailLines.some((line) => line.includes("Working hours: 08:01")));

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

  assert.deepEqual(summarizePrivateCalendarItems([attendance, vacation, excuse, plan]), {
    attendance: 1,
    excuse: 1,
    holiday: 0,
    plan: 1,
    total: 4,
    vacation: 1,
  });

  const serviceSource = readFileSync("src/lib/private-calendar/service.ts", "utf8");
  assert.match(serviceSource, /\.eq\("status", "approved"\)/, "vacation and excuse loaders must only read approved rows");
  assert.match(serviceSource, /sharedPlanningCalendarStatuses/, "plan loader must use submitted-or-approved planning statuses");
  assert.match(serviceSource, /canReadPrivateCalendarEmployee/, "service must enforce server-side employee scope");

  const apiSource = readFileSync("app/api/private-calendar/route.ts", "utf8");
  assert.match(apiSource, /getPrivateCalendarWorkspace/, "private calendar API must load through the scoped service");

  const accessRegistrySource = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(accessRegistrySource, /\/api\/private-calendar/, "private calendar API must be in access registry");
  assert.match(accessRegistrySource, /\/admin\/private-calendars/, "private calendar admin page must be in access registry");

  const portalLayoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  assert.match(portalLayoutSource, /Private Calendar/, "employee sidebar must include Private Calendar");
  assert.match(portalLayoutSource, /\/employee-portals\/plans\/calendar/, "plan users must get the Planning Calendar route");

  const navRegistrySource = readFileSync("src/components/employee-portal/employee-portal-nav-registry.ts", "utf8");
  assert.match(navRegistrySource, /\/employee-portals\/private-calendar/, "bottom nav registry must include Private Calendar");
  assert.match(navRegistrySource, /Planning Calendar/, "bottom nav registry must include Planning Calendar for plan users");
}
