import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { buildPlanningCalendarDetailRows, buildPlanningCalendarSummaryRows } from "../src/lib/weekly-planning/calendar-export.ts";
import {
  planningItemStatusLabel,
  withApprovedLeave,
  type PlanningCalendarPlanItem,
} from "../src/lib/weekly-planning/calendar.ts";
import { isPlanningLeave } from "../src/lib/vacation/approved-leave-days.ts";

/**
 * Owner, 2026-10-27 (Rasha Sabry): her weekly plan said Office for Tuesday 20 October, she then took
 * that day as annual leave, both approvals came through, and the Planning Calendar still never showed
 * it — "in all her calendars it should syncronize everywhere". The calendar now draws approved leave
 * on its days, over whatever the plan said.
 */
function row(overrides: Partial<PlanningCalendarPlanItem>): PlanningCalendarPlanItem {
  return {
    activityTitle: "Office",
    activityType: "Office",
    area: "Cairo",
    conflictKey: null,
    conflictWarning: null,
    employeeDisplayName: "Rasha",
    employeeHrId: "B-50",
    employeeJobTitle: "Group Product Manager",
    employeeName: "Rasha Sabry",
    endDate: "2026-10-20",
    id: "plan-1",
    lineName: "Pedia",
    medicalRepDisplayName: null,
    medicalRepHrId: null,
    medicalRepName: null,
    notes: null,
    planId: "plan-a",
    planKind: "weekly",
    region: "Cairo",
    source: "plan",
    startDate: "2026-10-20",
    status: "submitted",
    time: "AM",
    title: "Rasha - Cairo - Cairo - Office",
    ...overrides,
  };
}

function leave(overrides: Partial<PlanningCalendarPlanItem>): PlanningCalendarPlanItem {
  return row({
    activityTitle: "Annual Vacation",
    activityType: "Vacation",
    id: "leave-B-50|2026-10-20",
    onLeave: true,
    planId: "",
    status: "final_approved",
    time: "Full day",
    ...overrides,
  });
}

export async function runPlanningCalendarApprovedLeaveTests() {
  // 1. A full day of leave replaces every plan row that person had on that day, and only that day.
  const plans = [
    row({ id: "am", time: "AM" }),
    row({ id: "pm", time: "PM", activityType: "Field", activityTitle: "Single Visit" }),
    row({ id: "wed", startDate: "2026-10-21", endDate: "2026-10-21" }),
    row({ id: "other-person", employeeHrId: "B-51", employeeName: "Someone Else" }),
  ];
  const fullDay = withApprovedLeave(plans, [leave({})]);
  assert.deepEqual(
    fullDay.map((item) => item.id).sort(),
    ["leave-B-50|2026-10-20", "other-person", "wed"],
    "a full day of leave hides that person's plan rows on that day, and leaves other days and other people alone",
  );

  // 2. HR ids match however they were typed.
  assert.deepEqual(
    withApprovedLeave([row({ id: "am", employeeHrId: "b-50" })], [leave({})], (hrId) => hrId.trim().toUpperCase()).map((item) => item.id),
    ["leave-B-50|2026-10-20"],
    "\"b-50\" on the plan and \"B-50\" on the leave are one person",
  );

  // 3. Half a day of leave keeps the half still worked, and replaces only the plan's own Vacation row.
  const half = withApprovedLeave(
    [row({ id: "am", time: "AM", activityType: "Vacation", activityTitle: "Vacation" }), row({ id: "pm", time: "PM" })],
    [leave({ time: "Half day", activityTitle: "Annual Vacation (half day)" })],
  );
  assert.deepEqual(
    half.map((item) => item.id).sort(),
    ["leave-B-50|2026-10-20", "pm"],
    "a half day of leave keeps the other half's plan and replaces the plan's own Vacation row",
  );

  // 4. A person with no plan that week still shows on leave.
  assert.equal(withApprovedLeave([], [leave({})]).length, 1, "leave is drawn even when there is no plan at all");

  // 5. A leave row says so on screen and in the export, never "Final approved".
  assert.equal(planningItemStatusLabel(leave({})), "Approved leave");
  assert.equal(planningItemStatusLabel(row({ status: "manager_approved" })), "Manager approved");

  const details = buildPlanningCalendarDetailRows([leave({}), row({ id: "wed", startDate: "2026-10-21" })]);
  const leaveRow = details.find((detail) => detail.date === "2026-10-20");
  assert.equal(leaveRow?.status, "Approved leave", "the export's status column reads Approved leave");
  assert.equal(leaveRow?.planKind, "-", "a leave day has no plan kind");
  const [summary] = buildPlanningCalendarSummaryRows([leave({}), row({ id: "wed", startDate: "2026-10-21" })]);
  assert.equal(summary.planEntries, 1, "a leave day is not a plan entry");
  assert.equal(summary.weekly, 1, "nor a weekly plan entry");
  assert.equal(summary.leaveDays, 1, "it is counted as a leave day");

  // 6. Which requests count: approved, or waiting on HR after the manager said yes — the plan form's line.
  assert.equal(isPlanningLeave({ status: "approved" }), true);
  assert.equal(isPlanningLeave({ status: "pending_hr", manager_decision: "approved" }), true);
  assert.equal(isPlanningLeave({ status: "pending_hr", manager_decision: null }), false, "a request the manager has not decided is not leave yet");
  assert.equal(isPlanningLeave({ status: "pending_manager" }), false);
  assert.equal(isPlanningLeave({ status: "rejected", manager_decision: "approved" }), false, "a refused request is never leave");

  // 7. The one loader every Planning Calendar surface reads (admin page, portal page, API, export)
  //    lays the leave over the plans, and counts conflicts on the result.
  const service = readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8");
  assert.match(
    service,
    /const calendarItems = withApprovedLeave\(planItems, leaveItems, normalizeHrId\);/,
    "getSharedPlanningCalendarWorkspace lays approved leave over the plans",
  );
  assert.match(service, /buildPlanningCalendarConflicts\(calendarItems\)/, "chain visits are counted after the leave is laid over");
  assert.match(service, /loadPlanningLeaveDays\(hrIds, \{ from: start, to: end \}\)/, "the leave is read from Vacations for the month");

  // 8. The company calendar names the leave, never its stored key.
  const companyCalendar = readFileSync("src/lib/calendar/service.ts", "utf8");
  assert.match(companyCalendar, /vacationTypeLabel\(normalizeVacationType\(row\.vacation_type\)\)/, "My leave (Annual Vacation), not My leave (annual)");
}
