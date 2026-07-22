import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Regression guard for the Employee Day-by-Day Report module (deep audit,
 * 2026-07-22). getEmployeeDayByDayReport/listFlexEligibleEmployees are entirely
 * Supabase-backed and cannot be unit-tested without DB infra — matching the
 * established pattern for this domain (see attendance-settlement-service.test.ts,
 * attendance-self-scope.test.ts), these pin the exact source wiring for each
 * fixed issue rather than mocking the client.
 */
export function runAttendanceEmployeeDayReportTests() {
  const page = readFileSync("app/(admin)/attendance/employee-day-report/page.tsx", "utf8");
  const lib = readFileSync("src/lib/attendance/employee-day-report.ts", "utf8");
  const component = readFileSync("src/components/attendance/employee-day-report.tsx", "utf8");

  // 1. Access control: this report exposes the same per-employee punch/deduction
  //    detail as digest-review, so it must be gated the same way (reviewer or
  //    Super Admin) — not just the coarse attendance:read permission every basic
  //    attendance surface uses. A prior version only checked attendance:read,
  //    letting Finance Manager/Financial Advisor/SFE Manager/CEO browse any
  //    employee's detail despite those roles' own matrix comments disclaiming
  //    HR/payroll authority.
  assert.match(
    page,
    /isAuthorizedDisputeReviewer\(access\.hrId, access\.role === "Super Admin"\)/,
    "employee-day-report page must resolve reviewer authorization, not just attendance:read",
  );
  assert.match(
    page,
    /if \(!authorized\) \{\s*redirect\("\/employee-portals"\);/,
    "employee-day-report page must redirect non-reviewers, failing closed",
  );

  // 2. Correctness: policy must be resolved PER DAY, not once for the whole
  //    admin-chosen range — an arbitrary range can span a policy change (new
  //    scheduled_start/flex_minutes/required_minutes/brackets, or the employee
  //    only became flex-eligible partway through), and the weekly digest engine
  //    avoids exactly this by resolving per settlement week.
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

  // 3. Data integrity: a day already confirmed/auto_confirmed has a real, audited
  //    decision on record — the editable draft must default to THAT stored
  //    decision, never to a same-day recalculation (which can drift from what
  //    was actually settled if base_salary or policy rules changed since).
  assert.match(
    component,
    /const settled = day\.decision && \(day\.decision\.action === "confirmed" \|\| day\.decision\.action === "auto_confirmed"\) \? day\.decision : null;/,
    "initDrafts must detect an already-settled decision",
  );
  assert.match(
    component,
    /deductionDays: String\(settled \? settled\.storedDeductionDays : day\.deductionDays\)/,
    "initDrafts must prefer the stored decision's deductionDays over a live recomputation",
  );

  // 4. Drafts must resync whenever the server sends a new report (switching
  //    employee/range, or router.refresh() after Confirm/Decline) — a lazy
  //    useState initializer only runs once on mount and leaves the editable
  //    inputs visibly out of sync with the just-updated status badge. Must be
  //    a render-time state adjustment (React's documented reset-on-prop-change
  //    pattern), not a setState-in-effect, which eslint's react-hooks plugin
  //    flags as a cascading-render anti-pattern.
  assert.match(
    component,
    /if \(initialReport !== syncedReport\) \{\s*setSyncedReport\(initialReport\);\s*setDrafts\(initialReport \? initDrafts\(initialReport\.days\) : \{\}\);\s*\}/,
    "drafts state must resync during render when initialReport changes, not only at mount",
  );
  assert.doesNotMatch(
    component,
    /useEffect\(\(\) => \{\s*setDrafts\(/,
    "drafts resync must not be a setState-in-effect (react-hooks/set-state-in-effect)",
  );

  // 5. The employee dropdown must be scope-able to the admin's chosen historical
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
