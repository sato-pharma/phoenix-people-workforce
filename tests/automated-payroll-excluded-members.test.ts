import assert from "node:assert/strict";

import { filterExcludedMembers, type PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * Guards the run-scoped exclusion filter (excludeEmployeeFromRun /
 * loadRunContext in run-service.ts). Real case (owner-reported 2026-08-08):
 * AI-0004, a same-day hire/termination whose master record carried only
 * allowances (no base salary), derived a Gross Salary of 0.00 and hard-blocked
 * Part 2 confirmation for the entire run via preflightValidate — with no
 * acknowledge-and-proceed option. filterExcludedMembers is what lets HR drop
 * that one employee from just this run instead.
 */

function member(hrId: string, fullName: string): PopulationMember {
  return {
    employee: { hrId, fullName } as unknown as EmployeeDirectoryRow,
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
    unpaidDaysInSpan: 0,
  };
}

export function runAutomatedPayrollExcludedMembersTests() {
  const members = [member("AI-0001", "Stays In"), member("AI-0004", "Abdelrahman Alaa"), member("AI-0007", "Also Stays")];

  // ---- empty exclusion set is a true no-op, not just an equal-content copy --
  const untouched = filterExcludedMembers(members, new Set());
  assert.equal(untouched, members, "an empty exclusion set must return the exact same array reference, no new allocation");

  // ---- one excluded member is dropped, the rest keep their original order ---
  const withOneExcluded = filterExcludedMembers(members, new Set(["ai0004"]));
  assert.deepEqual(
    withOneExcluded.map((m) => m.employee.hrId),
    ["AI-0001", "AI-0007"],
    "the excluded compact key must drop exactly that employee and preserve the order of everyone else",
  );

  // ---- excluding a compact key nobody has leaves the population unchanged ---
  const noMatch = filterExcludedMembers(members, new Set(["zz9999"]));
  assert.deepEqual(
    noMatch.map((m) => m.employee.hrId),
    ["AI-0001", "AI-0004", "AI-0007"],
    "an exclusion set that matches nobody in this run must not drop anyone",
  );
}
