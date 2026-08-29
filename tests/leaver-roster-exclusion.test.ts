import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACTIVE_EMPLOYMENT_STATUSES, ACTIVE_EMPLOYMENT_STATUSES_IN_LIST, isTerminalEmploymentStatus } from "../src/lib/auth/session-lifecycle.ts";

/**
 * Call sites that ENUMERATE the employees table to present a set of people — a picker, a
 * recipient search, an account-creation template, a notification audience. Each one used to
 * return every leaver, because a resigned employee keeps their line, area, manager and work
 * email (correctly — history needs them), so nothing in the row itself says "gone".
 *
 * Deliberately NOT listed here: the many call sites that enumerate the table to build a lookup
 * map keyed by hr_id. Those must keep returning leavers or a resigned person's name disappears
 * from their own historical records, and payroll loses the salary of someone still owed a final
 * settlement.
 */
const ENUMERATING_CALL_SITES = [
  "app/(admin)/attendance/exceptions/page.tsx",
  "src/lib/internal-messages/service.ts",
  "app/api/admin/users/bulk/route.ts",
  "src/lib/weekly-planning/service.ts",
] as const;

/**
 * Call sites that enumerate employees for a DATE-RANGE-SCOPED roster or report, rather than a
 * plain "who is currently active" picker. These correctly keep a leaver visible for the range
 * they actually worked, then exclude them once their last working date falls before the range —
 * the same design proven correct in attendance/roster.ts's getAttendanceRoster. Listed
 * separately because the fix is `isTerminalEmploymentStatus` + `last_working_date`, not the
 * `ACTIVE_EMPLOYMENT_STATUSES_IN_LIST` SQL filter the sites above use.
 */
const DATE_RANGE_AWARE_CALL_SITES = [
  "src/lib/attendance/fingerprint-report.ts",
] as const;

/**
 * The Company Activity Report: filterCompanyActivityEmployees is the single choke point that
 * narrows an `includeInactive: true` roster before the heavy day-by-day scan runs, and it used to
 * apply no employment-status check at all — a resigned employee, complete with their line/area/
 * job title intact, showed up as a full row of manufactured absences for any date range, including
 * one entirely after they left. Fixed with the same last-working-date-vs-range-start rule as
 * attendance/roster.ts. Pinned at both the shared filter function AND its two callers (the report
 * page and its XLSX export), because the fix is a third `startDateIso` argument threaded through —
 * a caller that quietly drops back to the two-argument call silently un-fixes this.
 */
const COMPANY_ACTIVITY_FILTER_FILE = "src/lib/company-activity-report/filters.ts";
const COMPANY_ACTIVITY_CALLER_FILES = [
  "app/(admin)/admin/company-activity-report/page.tsx",
  "app/api/company-activity-report/export/route.ts",
] as const;

export function runLeaverRosterExclusionTests() {
  // The rule itself. If this set ever grows to admit a terminal status, every filter below
  // silently stops excluding anyone — so pin the meaning, not just the spelling.
  assert.ok(ACTIVE_EMPLOYMENT_STATUSES.has("active"), "an active employee must stay visible");
  assert.ok(ACTIVE_EMPLOYMENT_STATUSES.has("on_leave"), "on_leave is still employed, never a leaver");
  assert.equal(ACTIVE_EMPLOYMENT_STATUSES.has("resigned"), false, "resigned must never count as active");
  assert.equal(ACTIVE_EMPLOYMENT_STATUSES.has("terminated"), false, "terminated must never count as active");
  assert.ok(isTerminalEmploymentStatus("resigned"), "resigned is terminal");
  assert.ok(isTerminalEmploymentStatus("terminated"), "terminated is terminal");
  assert.equal(isTerminalEmploymentStatus(null), false, "an unset status is legacy data, treated as active — this rule only ever hides confirmed leavers");

  // The PostgREST literal the call sites interpolate. Pinned so a rename cannot quietly turn
  // every `.or(...)` below into a filter that matches nothing.
  assert.equal(ACTIVE_EMPLOYMENT_STATUSES_IN_LIST, "(active,on_leave)", "the in-list literal must name exactly the active statuses");

  for (const file of ENUMERATING_CALL_SITES) {
    const source = readFileSync(file, "utf8");
    const queryIndex = source.indexOf('.from("employees")');
    assert.notEqual(queryIndex, -1, `${file} should still query the employees table`);

    // Matched against the whole file rather than a byte window after the query: a source pin
    // sliced to a fixed offset false-fails the moment the file shifts by a line.
    assert.ok(
      source.includes("ACTIVE_EMPLOYMENT_STATUSES_IN_LIST"),
      `${file} enumerates employees to present people, so it must exclude leavers via ACTIVE_EMPLOYMENT_STATUSES_IN_LIST — without it every resigned employee reappears in this list`,
    );
    assert.ok(
      source.includes("employment_status.is.null,employment_status.in."),
      `${file} must keep the null-status escape hatch, so legacy rows with no status are never newly hidden`,
    );
  }

  for (const file of DATE_RANGE_AWARE_CALL_SITES) {
    const source = readFileSync(file, "utf8");
    assert.notEqual(source.indexOf('.from("employees")'), -1, `${file} should still query the employees table`);
    assert.ok(
      source.includes("isTerminalEmploymentStatus"),
      `${file} builds a money-moving attendance/deduction report by enumerating employees, so it must gate leavers on isTerminalEmploymentStatus — without it a resigned Medical Rep/DM/RSM keeps generating deduction rows forever`,
    );
    assert.ok(
      source.includes("last_working_date"),
      `${file} must compare the employee's last_working_date against the reported date range — without it a leaver is either hidden even during the days they still worked, or never excluded at all`,
    );
  }

  const filterSource = readFileSync(COMPANY_ACTIVITY_FILTER_FILE, "utf8");
  assert.ok(
    filterSource.includes("isTerminalEmploymentStatus"),
    `${COMPANY_ACTIVITY_FILTER_FILE} enumerates the whole roster (includeInactive: true) to build the Company Activity Report table, so it must gate leavers on isTerminalEmploymentStatus — without it a resigned employee's row never disappears, for any date range`,
  );
  assert.ok(
    filterSource.includes("employee.lastWorkingDate"),
    `${COMPANY_ACTIVITY_FILTER_FILE} must compare lastWorkingDate against the report's start date, or a leaver is excluded even for the days they actually worked`,
  );

  for (const file of COMPANY_ACTIVITY_CALLER_FILES) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      source.includes("filterCompanyActivityEmployees(roster, filters, startDate)"),
      `${file} must pass startDate as the third argument to filterCompanyActivityEmployees — without it this caller silently reverts to the unbounded, pre-fix behaviour even though the shared function supports the date bound`,
    );
  }
}
