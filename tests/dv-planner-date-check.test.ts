import assert from "node:assert/strict";

import { checkPlannedDate } from "../src/lib/double-visit-analytics/date-check.ts";

export function runDvPlannerDateCheckTests() {
  const window = { dateFrom: "2026-07-01", dateTo: "2026-07-19", today: "2026-07-19" };

  // No date picked yet — nothing to check.
  assert.equal(
    checkPlannedDate({ ...window, plannedDate: "", visits: [] }),
    null,
    "empty plannedDate returns null",
  );

  // Picked date is after today — plan hasn't come due yet.
  assert.deepEqual(
    checkPlannedDate({ ...window, plannedDate: "2026-07-25", visits: [] }),
    { status: "future" },
    "a date after today is 'future'",
  );

  // Picked date falls before the loaded window — can't check what wasn't fetched.
  assert.deepEqual(
    checkPlannedDate({ ...window, plannedDate: "2026-06-15", visits: [] }),
    { status: "outside-range" },
    "a date before dateFrom is 'outside-range'",
  );

  // Picked date falls after dateTo but is not in the future relative to `today` — a custom
  // period can set dateTo before today, so this is a distinct case from 'future'.
  assert.deepEqual(
    checkPlannedDate({
      dateFrom: "2026-06-01",
      dateTo: "2026-06-20",
      today: "2026-07-19",
      plannedDate: "2026-06-25",
      visits: [],
    }),
    { status: "outside-range" },
    "a date after dateTo (but before today) is 'outside-range', not 'future'",
  );

  // Picked date is inside the window, but no visit was recorded that day.
  assert.deepEqual(
    checkPlannedDate({
      ...window,
      plannedDate: "2026-07-10",
      visits: [{ activityDate: "2026-07-11", doubleVisitorName: "Ahmed Samir" }],
    }),
    { status: "not-recorded" },
    "an in-window date with no matching visit is 'not-recorded'",
  );

  // Picked date matches a visit — confirmed, with the visitor's name surfaced.
  assert.deepEqual(
    checkPlannedDate({
      ...window,
      plannedDate: "2026-07-10",
      visits: [
        { activityDate: "2026-07-09", doubleVisitorName: "Someone Else" },
        { activityDate: "2026-07-10", doubleVisitorName: "Ahmed Samir" },
      ],
    }),
    { status: "confirmed", visitorNames: ["Ahmed Samir"] },
    "an in-window date with a matching visit is 'confirmed', naming the visitor",
  );

  // Multiple visitors on the same day — all named, deduped, null names dropped.
  const multiVisitorResult = checkPlannedDate({
    ...window,
    plannedDate: "2026-07-10",
    visits: [
      { activityDate: "2026-07-10", doubleVisitorName: "Ahmed Samir" },
      { activityDate: "2026-07-10", doubleVisitorName: "Ahmed Samir" },
      { activityDate: "2026-07-10", doubleVisitorName: "Mona Adel" },
      { activityDate: "2026-07-10", doubleVisitorName: null },
    ],
  });
  assert.equal(multiVisitorResult?.status, "confirmed");
  assert.deepEqual(
    (multiVisitorResult as { status: "confirmed"; visitorNames: string[] }).visitorNames.slice().sort(),
    ["Ahmed Samir", "Mona Adel"],
    "confirmed visitorNames dedupes repeats and drops null names",
  );

  // A date exactly at dateFrom/dateTo is in-window, not out-of-range (inclusive boundaries).
  assert.deepEqual(
    checkPlannedDate({
      ...window,
      plannedDate: window.dateFrom,
      visits: [{ activityDate: window.dateFrom, doubleVisitorName: "Ahmed Samir" }],
    }),
    { status: "confirmed", visitorNames: ["Ahmed Samir"] },
    "dateFrom itself is in-window (inclusive)",
  );
  assert.deepEqual(
    checkPlannedDate({ ...window, plannedDate: window.dateTo, visits: [] }),
    { status: "not-recorded" },
    "dateTo itself is in-window (inclusive), not 'future' when it equals today",
  );
}
