import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  employeeExitDay,
  isActiveDirectoryEmployee,
  isWithinNoticePeriod,
  type EmployeeDirectoryRow,
} from "../src/lib/employees/employee-directory.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A NOTICE PERIOD IS STILL WORK — the Private Calendar reads a leaver until the day AFTER his exit.
//
// Owner, 23 October 2026: "drop after his resignation date not submission date".
//
// What went wrong. `employees.employment_status` flips to `resigned` and `organogram_visible` to
// false the moment a resignation is SUBMITTED — not when it is approved, and not when the person
// actually leaves. A Medical Representative's resignation was submitted on 18 October 15:47 Cairo
// for a last working day of 31 October; she went on working, logging 10 and 12 customer visits on
// the 21st and the 22nd. From that submission onwards every surface built on
// `isActiveDirectoryEmployee` had lost her, so:
//   - her Private Calendar could not be opened at all, and
//   - `getPrivateCalendarDayEvidence` handed back an EMPTY DAY for the 21st and the 22nd — not an
//     error, an empty day — which the System Audit's visit-lifecycle detector read as 22 logged
//     Phoenix CRM visits "lost at the calendar itself" (VISIT-S4-MISSING, 3 occurrences, every one
//     of them one of the only two resigned reps in the scan; the other 80 rep-days of the same run
//     read correctly).
//
// The two properties pinned here:
//   1. THE CUT IS THE EXIT DAY, NEVER THE SUBMISSION. `isWithinNoticePeriod` keeps a departed
//      employee while the day asked about is on or before the later of his last working date and his
//      resignation date, and drops him after it. A departed row with neither date is NOT kept —
//      there is no day to compare, and an open-ended answer would restore the whole inactive roster.
//   2. 🔴 AN EMPLOYEE NOBODY READ IS NOT AN EMPTY DAY. The day-evidence door must write no entry for
//      an employee outside the set it loaded, because every caller already reads a missing entry as
//      "could not be read" — the dispute reviewer's day facts say so in those words, and the
//      detector reports it as unreadable instead of as lost visits. The confident blank is the bug.
//
// And one thing deliberately NOT changed: `getCompanyNoActivityDays` keeps the active-only roster.
// It is the engine behind the Deductions No Records Activity connector and the weekly gap notice, so
// widening it would start raising deduction candidates against people working out their notice —
// money, and the owner's call in that module, never a side effect of a calendar fix.
// ─────────────────────────────────────────────────────────────────────────────

function employee(overrides: Partial<EmployeeDirectoryRow>): EmployeeDirectoryRow {
  return {
    hrId: "B-110",
    fullName: "A Medical Representative",
    jobTitle: "Medical Representative",
    employmentStatus: "active",
    organogramVisible: true,
    lastWorkingDate: null,
    resignationDate: null,
    ...overrides,
  } as EmployeeDirectoryRow;
}

export function runPrivateCalendarNoticePeriodTests() {
  // ── 1. The exit day is the LATER of the two dates ────────────────────────────────────────────
  assert.equal(employeeExitDay({ lastWorkingDate: "2026-10-31", resignationDate: "2026-10-31" }), "2026-10-31");
  assert.equal(
    employeeExitDay({ lastWorkingDate: "2026-11-15", resignationDate: "2026-10-31" }),
    "2026-11-15",
    "when the two dates differ the LATER one is the last day the person could still have worked",
  );
  assert.equal(employeeExitDay({ lastWorkingDate: null, resignationDate: "2026-10-17" }), "2026-10-17");
  assert.equal(employeeExitDay({ lastWorkingDate: null, resignationDate: null }), null);
  assert.equal(
    employeeExitDay({ lastWorkingDate: "2026-10-31T00:00:00Z", resignationDate: null }),
    "2026-10-31",
    "a timestamp is read as its day, never rejected",
  );

  // ── 2. The real production shape: submitted 18 Oct, last working day 31 Oct ──────────────────
  const onNotice = employee({
    employmentStatus: "resigned",
    lastWorkingDate: "2026-10-31",
    organogramVisible: false,
    resignationDate: "2026-10-31",
  });
  assert.equal(
    isActiveDirectoryEmployee(onNotice),
    false,
    "the active directory loses her at submission — that is the defect being worked around, not the fix",
  );
  assert.equal(isWithinNoticePeriod(onNotice, "2026-10-21"), true, "the 21st is inside her notice period");
  assert.equal(isWithinNoticePeriod(onNotice, "2026-10-22"), true, "and so is the 22nd");
  assert.equal(isWithinNoticePeriod(onNotice, "2026-10-31"), true, "her last working day is still hers");
  assert.equal(isWithinNoticePeriod(onNotice, "2026-11-01"), false, "she drops the day AFTER her exit day");

  // The other flagged rep: resignation recorded 17 October 23:56 for a last working day of 17
  // October, and the audit flagged her 12 October — a day she plainly worked, five days before.
  const alreadyLeft = employee({
    employmentStatus: "resigned",
    hrId: "B-182",
    lastWorkingDate: "2026-10-17",
    organogramVisible: false,
    resignationDate: "2026-10-17",
  });
  assert.equal(isWithinNoticePeriod(alreadyLeft, "2026-10-12"), true, "a window reaching a day she worked still reads her");
  assert.equal(isWithinNoticePeriod(alreadyLeft, "2026-10-18"), false);

  // ── 3. What must NOT be kept ─────────────────────────────────────────────────────────────────
  assert.equal(
    isWithinNoticePeriod(employee({ employmentStatus: "resigned", organogramVisible: false }), "2026-10-22"),
    false,
    "a departed row with NEITHER date is not open-ended — that would restore the whole inactive roster",
  );
  assert.equal(
    isWithinNoticePeriod(employee({}), "2026-10-22"),
    false,
    "an active employee is not on notice; the active test answers for him",
  );
  assert.equal(isWithinNoticePeriod(onNotice, ""), false, "no day asked about, no answer");
  assert.equal(isWithinNoticePeriod(onNotice, "22/10/2026"), false, "only an ISO day is read");
  assert.equal(
    isWithinNoticePeriod(
      employee({
        employmentStatus: "resigned",
        fullName: "Phoenix System Administrator",
        hrId: "PHX-1",
        jobTitle: "System Administrator",
        lastWorkingDate: "2026-12-31",
      }),
      "2026-10-22",
    ),
    false,
    "a system or console account never joins the directory by this door either",
  );

  // ── 4. The wiring: who reads the wider set, and who deliberately does not ────────────────────
  const service = readFileSync(new URL("../src/lib/private-calendar/service.ts", import.meta.url), "utf8");
  assert.match(
    service,
    /async function privateCalendarEmployees\(fromDate: string\)[\s\S]*?getEmployeeDirectoryRows\(\{ includeInactive: true \}\)[\s\S]*?isActiveDirectoryEmployee\(employee\) \|\| isWithinNoticePeriod\(employee, fromDate\)/,
    "the calendar's employee set is the active directory PLUS the notice periods the window reaches",
  );
  assert.equal(
    (service.match(/await privateCalendarEmployees\(start\)/g) ?? []).length,
    2,
    "both calendar reads — the month workspace and the day-evidence door — use it",
  );

  const noActivity = service.slice(service.indexOf("export async function getCompanyNoActivityDays"));
  assert.ok(noActivity.length > 0, "getCompanyNoActivityDays must still exist for this check to mean anything");
  const noActivityBody = noActivity.slice(0, noActivity.indexOf("\n}\n") + 1);
  assert.ok(
    !noActivityBody.includes("privateCalendarEmployees"),
    "🔴 the no-activity engine stays ACTIVE-ONLY: widening it raises deduction candidates against people on notice",
  );
  assert.match(
    noActivityBody,
    /ACTIVE ONLY, deliberately/,
    "and it says so in the code, so nobody later 'fixes' it to match the calendar",
  );

  // ── 5. The door writes no entry for an employee it never read ────────────────────────────────
  const door = service.slice(service.indexOf("export async function getPrivateCalendarDayEvidence"));
  assert.match(
    door,
    /const read = new Set\(employees\.map\(\(employee\) => privateCalendarHrIdKey\(employee\.hrId\)\)\)/,
    "the door tracks which asked employees its loaders actually read",
  );
  assert.match(
    door,
    /if \(!employeeKey \|\| !read\.has\(employeeKey\)\) continue;/,
    "🔴 and skips the rest — an employee nobody read is never answered with an empty day",
  );
}
