import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { routeAttendancePunch, resolveDeviceMappingStatus } from "../src/lib/attendance/metrics.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Attendance ingestion used to report ONE `skipped` total, and that number mixed two
// opposite meanings:
//
//   * a finger nobody has ever named — a real person's attendance is being thrown away
//   * a finger somebody already classified — the driver, or a retired enrolment
//
// The second kind never falls to zero, so the total could never read as healthy and was
// useless as an alarm. Measured on production 2026-08-26: 290 skipped every sync, of which
// exactly one device user (47, the incoming National Sales Manager) was an open question.
//
// This file pins the split. It checks the DECISION function directly, and it checks the
// SELECT that feeds it — because a narrowed SELECT disarms the whole thing silently: if the
// query goes back to `.eq("is_active", true)`, every skipped punch arrives with no row at
// all, every one is classified "unknown", and the alarm is loud forever instead of quiet.
// ─────────────────────────────────────────────────────────────────────────────

export function runAttendanceSkippedPunchClassificationTests() {
  // ── The decision itself ────────────────────────────────────────────────────
  {
    const cases: Array<{
      what: string;
      row: Parameters<typeof routeAttendancePunch>[0];
      expect: ReturnType<typeof routeAttendancePunch>;
    }> = [
      {
        what: "an active enrolment carrying an employee is the only thing that attributes a punch",
        row: { employeeHrId: "AI-0008", isActive: true, nonEmployeeLabel: null },
        expect: "attribute",
      },
      {
        what: "a RETIRED enrolment is a deliberate skip - the person is known, this finger was replaced",
        row: { employeeHrId: "B-157", isActive: false, nonEmployeeLabel: null },
        expect: "skip_ignored",
      },
      {
        what: "a labelled non-employee (the driver) is a deliberate skip, not an open question",
        row: { employeeHrId: null, isActive: false, nonEmployeeLabel: "Driver" },
        expect: "skip_ignored",
      },
      {
        what: "a row that exists but names nobody is STILL unknown - the row alone decides nothing",
        row: { employeeHrId: null, isActive: false, nonEmployeeLabel: null },
        expect: "skip_unknown",
      },
      {
        what: "a whitespace-only label does not count as having classified anything",
        row: { employeeHrId: null, isActive: false, nonEmployeeLabel: "   " },
        expect: "skip_unknown",
      },
      {
        what: "no row at all is unknown - nothing has ever been said about that finger",
        row: null,
        expect: "skip_unknown",
      },
      {
        what: "an undefined lookup miss behaves the same as an absent row",
        row: undefined,
        expect: "skip_unknown",
      },
    ];

    for (const { what, row, expect } of cases) {
      assert.equal(routeAttendancePunch(row), expect, what);
    }
  }

  // Exactly one of the four mapping statuses may attribute a punch. Pinned as an
  // exhaustive sweep so a fifth status added later cannot quietly default to "attribute"
  // and start ingesting punches for a finger nobody has approved.
  {
    const statuses = ["active", "inactive", "non_employee", "unmapped"] as const;
    const rows = {
      active: { employeeHrId: "AA", isActive: true, nonEmployeeLabel: null },
      inactive: { employeeHrId: "AA", isActive: false, nonEmployeeLabel: null },
      non_employee: { employeeHrId: null, isActive: false, nonEmployeeLabel: "Driver" },
      unmapped: { employeeHrId: null, isActive: false, nonEmployeeLabel: null },
    } as const;

    for (const status of statuses) {
      assert.equal(
        resolveDeviceMappingStatus(rows[status]),
        status,
        `fixture for "${status}" must actually resolve to that status`,
      );
    }

    const attributing = statuses.filter((s) => routeAttendancePunch(rows[s]) === "attribute");
    assert.deepEqual(attributing, ["active"], "only an active mapping may attribute a punch");

    const openQuestions = statuses.filter((s) => routeAttendancePunch(rows[s]) === "skip_unknown");
    assert.deepEqual(openQuestions, ["unmapped"], "only an unmapped device user is an open question");
  }

  // ── The SELECT that feeds the decision ─────────────────────────────────────
  // The gate moved out of the query and into routeAttendancePunch. That is only safe while
  // the query keeps returning the rows the decision needs to see.
  {
    const route = readFileSync(
      new URL("../app/api/attendance/raw-punches/route.ts", import.meta.url),
      "utf8",
    );

    const selectMatch = route.match(/\.select\("device_id,device_user_id[^"]*"\)/);
    assert.ok(selectMatch, "the device-user lookup must still select by explicit column list");
    const select = selectMatch[0];

    for (const column of ["employee_hr_id", "is_active", "non_employee_label"]) {
      assert.ok(
        select.includes(column),
        `the lookup must select ${column} - without it every skipped punch reads as unknown`,
      );
    }

    // The two filters that used to narrow this query must NOT come back. Either one turns
    // a classified finger into an invisible one, which is indistinguishable from unknown.
    const lookup = route.slice(route.indexOf("async function resolveDeviceUserRows"));
    const lookupBody = lookup.slice(0, lookup.indexOf("\n}\n"));
    assert.ok(
      !/\.eq\(\s*"is_active"/.test(lookupBody),
      'the lookup must not filter on is_active - an inactive row is a DELIBERATE skip and has to stay visible',
    );
    assert.ok(
      !/\.not\(\s*"employee_hr_id"/.test(lookupBody),
      "the lookup must not exclude rows without an employee - a labelled non-employee has none",
    );

    // A PostgREST `.in()` puts its list in the URL and silently returns zero rows past a
    // few hundred ids, so the id list must be chunked rather than passed whole.
    assert.ok(
      /lookupChunkSize/.test(lookupBody) && /slice\(i, i \+ lookupChunkSize\)/.test(lookupBody),
      "the device-user id list must be chunked - a long .in() returns an empty set with no error",
    );

    // The response has to actually carry the split, and keep the old total beside it so
    // existing readers do not break.
    for (const key of ["skippedUnknown", "skippedIgnored", "unknownDeviceUsers", "skipped:"]) {
      assert.ok(route.includes(key), `the ingestion response must report ${key}`);
    }
  }
}
