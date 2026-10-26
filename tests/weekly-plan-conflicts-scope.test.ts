import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { selectSameLinePlanBookings } from "../src/lib/weekly-planning/calendar-service.ts";
import type { CalendarViewerContext } from "../src/lib/weekly-planning/calendar-service.ts";
import {
  SAME_LINE_BOOKING_MAX_RANGE_DAYS,
  sameLineBookingRangeProblem,
  sameLineBookingWarning,
} from "../src/lib/weekly-planning/calendar.ts";
import type { PlanningCalendarPlanItem } from "../src/lib/weekly-planning/calendar.ts";

/**
 * GET /api/weekly-plans/conflicts feeds one thing: the Plans form's "already planned with this Medical
 * Rep on this date" warning, which reads the rep, the date and who booked. Audit of 2026-10-26: the route
 * answered ANY range (a whole year) and returned, for every district on the viewer's line, the other
 * manager's HR id, area, region and activity title. It is now capped to one plan period and returns the
 * rep + date, naming the manager only where the viewer may already see that manager's plan.
 */

function planItem(input: Partial<PlanningCalendarPlanItem> & { employeeHrId: string; employeeJobTitle: string | null }): PlanningCalendarPlanItem {
  return {
    activityTitle: "Double Visit - Pharmacy Chain",
    activityType: "Field",
    area: "Assiut 2",
    conflictKey: null,
    conflictWarning: null,
    employeeName: "Legal Name",
    employeeDisplayName: "Display Name",
    endDate: "2026-11-02",
    id: "plan-1",
    lineName: "CNS",
    medicalRepHrId: "REP-1",
    medicalRepName: "Rep One",
    medicalRepDisplayName: "Rep One",
    notes: null,
    planId: "header-1",
    planKind: "weekly",
    region: "Upper Egypt 1",
    source: "plan",
    startDate: "2026-11-02",
    status: "submitted",
    time: null,
    title: "Display Name - Upper Egypt 1 - Assiut 2",
    ...input,
  };
}

const AMGAD: CalendarViewerContext = {
  hrId: "B-118",
  role: "District Manager",
  lineName: "CNS",
  directReportHrIds: new Set(),
};

export function runWeeklyPlanConflictsScopeTests() {
  // --- The window is one plan period, never a year ---
  assert.equal(sameLineBookingRangeProblem("2026-11-02", "2026-11-08"), null, "a week is allowed");
  assert.equal(sameLineBookingRangeProblem("2026-11-01", "2026-11-30"), null, "a month is allowed");
  assert.equal(sameLineBookingRangeProblem("2026-11-02", "2026-11-02"), null, "a single day is allowed");
  assert.equal(SAME_LINE_BOOKING_MAX_RANGE_DAYS, 42);
  assert.equal(sameLineBookingRangeProblem("2026-11-01", "2026-12-12"), null, "exactly 42 days is the last allowed window");
  assert.notEqual(sameLineBookingRangeProblem("2026-11-01", "2026-12-13"), null, "43 days is refused");
  assert.notEqual(sameLineBookingRangeProblem("2026-01-01", "2026-12-31"), null, "a whole year is refused");
  assert.notEqual(sameLineBookingRangeProblem("2026-11-08", "2026-11-02"), null, "an end before the start is refused");
  assert.notEqual(sameLineBookingRangeProblem("2026-02-31", "2026-03-02"), null, "a date that does not exist is refused");

  // --- What a booking may carry ---
  const peerDistrictManager = planItem({ employeeHrId: "B-120", employeeJobTitle: "District Manager", employeeDisplayName: "Peer Manager" });
  const sameLineProductManager = planItem({ employeeHrId: "B-130", employeeJobTitle: "Product Manager", employeeDisplayName: "Line Product Manager", id: "plan-2" });
  const ownPlan = planItem({ employeeHrId: "B-118", employeeJobTitle: "District Manager", id: "plan-3" });
  const otherLine = planItem({ employeeHrId: "P-5", employeeJobTitle: "District Manager", lineName: "Pedia", id: "plan-4" });
  const noRep = planItem({ employeeHrId: "B-121", employeeJobTitle: "District Manager", medicalRepHrId: null, medicalRepName: null, id: "plan-5" });

  const bookings = selectSameLinePlanBookings(
    [peerDistrictManager, sameLineProductManager, ownPlan, otherLine, noRep],
    AMGAD,
  );
  assert.equal(bookings.length, 2, "the peer's and the product manager's bookings of a rep remain; own plan, other line and repless rows do not");

  const peer = bookings[0];
  assert.deepEqual(
    peer,
    { date: "2026-11-02", medicalRepHrId: "REP-1", medicalRepName: "Rep One", plannedByDisplayName: null },
    "a peer District Manager's booking is rep + date only - the manager is not named to a viewer who cannot see that plan",
  );
  assert.deepEqual(Object.keys(peer).sort(), ["date", "medicalRepHrId", "medicalRepName", "plannedByDisplayName"]);
  const wire = JSON.stringify(bookings);
  for (const leaked of ["B-120", "Assiut 2", "Upper Egypt 1", "Double Visit", "Peer Manager", "Legal Name", "CNS", "Pedia"]) {
    assert.equal(wire.includes(leaked), false, `the wire answer must not carry "${leaked}"`);
  }
  assert.equal(
    bookings[1].plannedByDisplayName,
    "Line Product Manager",
    "a manager whose plan the viewer already sees on the planning calendar is still named",
  );

  // A viewer with no line is told nothing.
  assert.deepEqual(selectSameLinePlanBookings([peerDistrictManager], { ...AMGAD, lineName: null }), []);

  // --- The form's warning still fires, and never needs the viewer's id ---
  const warning = sameLineBookingWarning({
    activityDate: "2026-11-02",
    bookings,
    medicalRepHrId: "REP-1",
    medicalRepName: "Rep One",
  });
  assert.match(warning ?? "", /Another manager/, "an unnamed booking reads as another manager");
  assert.match(warning ?? "", /Line Product Manager/, "a nameable booking keeps its name");
  assert.match(warning ?? "", /already planned with Rep One on this date/);
  assert.match(warning ?? "", /warning only/i);
  assert.equal(
    sameLineBookingWarning({ activityDate: "2026-11-03", bookings, medicalRepHrId: "REP-1", medicalRepName: "Rep One" }),
    null,
    "a different day does not warn",
  );
  assert.equal(
    sameLineBookingWarning({ activityDate: "2026-11-02", bookings, medicalRepHrId: "REP-9", medicalRepName: "Other Rep" }),
    null,
    "a different rep does not warn",
  );

  // --- The route and the service both enforce the cap and the cut ---
  const route = stripComments(readFileSync("app/api/weekly-plans/conflicts/route.ts", "utf8"));
  assert.match(route, /sameLineBookingRangeProblem\(/, "the route refuses an over-long range with a 400");
  const service = stripComments(readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8"));
  assert.match(service, /return selectSameLinePlanBookings\(/, "the service answers through the trimmed selector");
  assert.match(service, /sameLineBookingRangeProblem\(start, end\)/, "the service refuses an over-long range too");
}
