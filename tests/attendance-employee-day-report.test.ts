import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Regression guard for the Employee Day-by-Day Report module (deep audit,
 * 2026-07-22). getEmployeeDayByDayReport/listFlexEligibleEmployees are entirely
 * Supabase-backed and cannot be unit-tested without DB infra — matching the
 * established pattern for this domain (see attendance-self-scope.test.ts),
 * these pin the exact source wiring for each fixed issue rather than mocking
 * the client.
 */
export function runAttendanceEmployeeDayReportTests() {
  const page = readFileSync("app/(admin)/attendance/employee-day-report/page.tsx", "utf8");
  const lib = readFileSync("src/lib/attendance/employee-day-report.ts", "utf8");

  // 1. Access control: this report exposes per-employee punch/deduction detail,
  //    so it must be gated to Super Admin only — not just the coarse
  //    attendance:read permission every basic attendance surface uses. A prior
  //    version only checked attendance:read, letting Finance Manager/Financial
  //    Advisor/SFE Manager/CEO browse any employee's detail despite those
  //    roles' own matrix comments disclaiming HR/payroll authority.
  assert.match(
    page,
    /if \(access\.role !== "Super Admin"\) \{\s*redirect\("\/employee-portals"\);/,
    "employee-day-report page must gate to Super Admin only and redirect otherwise, failing closed",
  );

  // 2. Correctness: policy must be resolved PER DAY, not once for the whole
  //    admin-chosen range — an arbitrary range can span a policy change (new
  //    scheduled_start/flex_minutes/required_minutes/brackets, or the employee
  //    only became flex-eligible partway through).
  assert.match(
    lib,
    /function resolvePolicyForDay\(dateIso: string\)/,
    "getEmployeeDayByDayReport must resolve the attendance policy per day",
  );
  assert.match(
    lib,
    /resolveActiveAttendancePolicy\(\s*\{ hr_id: employee!\.hr_id, job_title: employee!\.job_title \},\s*flexPolicies,\s*dateIso,\s*dateIso,\s*\)/,
    "the per-day policy resolver must query with dateIso/dateIso, not the full range",
  );
  assert.doesNotMatch(
    lib,
    /resolveActiveAttendancePolicy\(\s*\{ hr_id: employee\.hr_id, job_title: employee\.job_title \},\s*flexPolicies,\s*input\.dateFromIso,\s*input\.dateToIso,\s*\)/,
    "must not resolve a single policy across the whole requested range",
  );

  // 3. The employee dropdown must be scope-able to the admin's chosen historical
  //    range, not hardcoded to today — otherwise an employee who resigned, or
  //    moved off the flexible-hours model, since the period being reviewed is
  //    never selectable, defeating the report's own historical-review purpose.
  assert.match(
    lib,
    /export async function listFlexEligibleEmployees\(range\?: \{ dateFromIso: string; dateToIso: string \}\)/,
    "listFlexEligibleEmployees must accept an optional historical range",
  );
  assert.match(
    page,
    /listFlexEligibleEmployees\(\s*filters\?\.dateFrom && filters\?\.dateTo \? \{ dateFromIso: filters\.dateFrom, dateToIso: filters\.dateTo \} : undefined,\s*\)/,
    "the page must pass the admin's chosen range through to listFlexEligibleEmployees once picked",
  );
}
