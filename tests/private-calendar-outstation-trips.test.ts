import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { foldOutstationTripDays } from "../src/lib/outstation/trip-work-evidence.ts";
import {
  mapOutstationTripDayToPrivateCalendarItem,
  outstationTripDaysFor,
} from "../src/lib/private-calendar/outstation-trip-items.ts";
import {
  derivePrivateCalendarExceptions,
  summarizePrivateCalendarItems,
  type PrivateCalendarEmployeeOption,
  type PrivateCalendarItem,
} from "../src/lib/private-calendar/logic.ts";

// ─────────────────────────────────────────────────────────────────────────────
// OUTSTATION TRIPS ON THE PRIVATE CALENDAR.
//
// Owner, 2026-10-29: "There is an expense recorded in Phoenix for 21 : 22 October / this is ahmed
// sharaf if their is an expense it must automatic appeared in his private calendar". His bus trip to
// Minya (submitted, 21–22 October) showed "No Activity Recorded" on both days, while the deductions
// engine had spared those same days since 2026-10-12 — it reads the trip tables, the calendar did not.
//
// What this pins:
//   1. Every day of a multi-day trip becomes a calendar item, a submitted claim included, and a
//      rejected one does not (the deductions ruling: any trip not rejected, cancelled or withdrawn).
//   2. A trip day clears No Activity Recorded, so the calendar and deductions agree.
//   3. Only the asked people's trips reach the calendar, whatever case the hr id is stored in.
//   4. All three calendar passes read the trips: the workspace, the company no-activity engine
//      Deductions adjudicates, and the day evidence a review-request reviewer reads.
// ─────────────────────────────────────────────────────────────────────────────

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const ahmed: PrivateCalendarEmployeeOption = {
  departmentName: "Marketing",
  fullName: "Ahmed Sharaf",
  hrId: "B-155",
  jobTitle: "Product Manager",
  lineName: "Pedia",
  managerHrId: "B-1",
  managerName: "Manager",
};

const minyaTrip = {
  employee_hr_id: "b-155",
  status: "submitted",
  to_city: "Minya Governorate",
  to_label: "Minya",
  trip_end_date: "2026-10-22T00:00:00+00:00",
  trip_start_date: "2026-10-21T00:00:00+00:00",
};

function noActivityDays(items: PrivateCalendarItem[]) {
  return derivePrivateCalendarExceptions({
    employees: [ahmed],
    end: "2026-10-22",
    isExpectedWorkday: () => true,
    items,
    start: "2026-10-21",
    today: "2026-10-31",
  })
    .filter((exception) => exception.code === "no_activity_recorded")
    .map((exception) => exception.date);
}

export function runPrivateCalendarOutstationTripsTests() {
  const days = foldOutstationTripDays({
    end: "2026-10-31",
    expenses: [],
    requests: [
      minyaTrip,
      { ...minyaTrip, employee_hr_id: "B-155", status: "rejected", trip_end_date: "2026-10-25T00:00:00+00:00", trip_start_date: "2026-10-25T00:00:00+00:00" },
      { ...minyaTrip, employee_hr_id: "B-200", trip_end_date: "2026-10-21T00:00:00+00:00" },
    ],
    start: "2026-10-01",
  });

  // ── 1 · Both days of the submitted trip, never the rejected one; only the asked person ─────────
  const ahmedsDays = outstationTripDaysFor(days, ["B-155"]);
  assert.deepEqual(ahmedsDays.map((day) => day.date), ["2026-10-21", "2026-10-22"], "every day of a submitted trip reaches the calendar, a rejected trip does not");
  assert.ok(ahmedsDays.every((day) => day.hrId.toUpperCase() === "B-155"), "another employee's trip never reaches this calendar");

  const items = ahmedsDays.map(mapOutstationTripDayToPrivateCalendarItem);
  const first = items[0] as PrivateCalendarItem;
  assert.equal(first.source, "outstation");
  assert.equal(first.activityKind, "outstation");
  assert.equal(first.severity, "success");
  assert.equal(first.sourceSystem, "Phoenix Expenses");
  assert.equal(first.sourceTable, "outstation_expense_requests");
  assert.equal(first.title, "Outstation trip to Minya");
  assert.deepEqual(first.chipLines, ["Outstation trip", "Claim pending"], "a submitted claim says it is still waiting for its decision");
  assert.notEqual(items[0]?.id, items[1]?.id, "each trip day is its own entry");

  // ── 2 · A trip day is a covered day ────────────────────────────────────────────────────────────
  assert.deepEqual(noActivityDays([]), ["2026-10-21", "2026-10-22"], "without the trip both days read No Activity Recorded");
  assert.deepEqual(noActivityDays(items), [], "an outstation trip clears No Activity Recorded on every day it covers");
  assert.equal(summarizePrivateCalendarItems(items).outstation, 2, "the Trips figure counts trip days");

  // ── 3 · Wired into all three calendar passes ───────────────────────────────────────────────────
  const service = read("src/lib/private-calendar/service.ts");
  assert.equal(
    service.match(/loadOutstationTripPrivateCalendarItems\(/g)?.length,
    3,
    "the workspace, the company no-activity engine and the day evidence all read the trips",
  );
  assert.equal(service.match(/\.\.\.trips\.items,/g)?.length, 3, "all three passes put the trip items on the day");
  assert.match(service, /outstation: trips\.ready,/, "a trip read that failed says so, rather than showing a confident empty month");
  assert.match(service, /unreadableSources\.push\("outstation"\)/, "a reviewer is told when the trips could not be read");

  const ui = read("src/components/employee-portal/private-calendar.tsx");
  assert.match(ui, /\n {2}outstation: \{/, "an outstation trip has its own entry in the one colour table");
  assert.match(ui, /ready=\{sourceReadiness\.outstation\}/, "the Trips figure says when the trips could not be read");
}
