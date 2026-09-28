import assert from "node:assert/strict";

import { isActiveLifecycleStatus } from "../src/lib/employees/employee-directory.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { leaverVisitorKeySet, isLeaverVisitorHrId } from "../src/lib/double-visit-analytics/service.ts";

// Owner, 2026-09-29: a resigned/terminated employee's name must not be surfaced on operational
// surfaces — they show only in the Resignations module. The driving case was A-7 (the Training
// Manager), whose live exposure once terminated is as a double-visit COACH.
//
// These pin the two DISPLAY-only hides that carry no number impact:
//  1. the canonical active set that employee-directory's manager-name resolution now filters by
//     (loadManagerNames drops a leaver, so a departed manager's name never labels a live row); and
//  2. the double-visit dashboard's leaver-visitor helpers (the filter dropdown and the visit log
//     withhold a departed coach's name while every KPI/heatmap/score — built from HR-ids — is kept).

function row(over: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    displayName: over.hrId,
    employmentStatus: "active",
    organogramVisible: true,
    jobTitle: "Training Manager",
    ...over,
  } as EmployeeDirectoryRow;
}

export function runLeaverNameHideTests() {
  // ── 1. The canonical active set the manager-name filter relies on ────────────────
  for (const active of ["active", "on_leave", "ACTIVE", "On_Leave", null, undefined, ""]) {
    assert.equal(isActiveLifecycleStatus(active), true, `"${String(active)}" must count as active (null/blank default active)`);
  }
  for (const leaver of ["resigned", "terminated", "inactive", "declined_offer", "historical_payroll_record", "system_placeholder"]) {
    assert.equal(isActiveLifecycleStatus(leaver), false, `"${leaver}" is a leaver and must NOT count as active`);
  }

  // ── 2. Double-visit leaver-visitor helpers ───────────────────────────────────────
  const directory: EmployeeDirectoryRow[] = [
    row({ hrId: "A-7", displayName: "Ahmed Elkawas", employmentStatus: "terminated" }),
    row({ hrId: "B-50", displayName: "Active Coach", employmentStatus: "active" }),
    row({ hrId: "B-97", displayName: "Resigned Coach", employmentStatus: "resigned" }),
    row({ hrId: "B-60", displayName: "On-leave Coach", employmentStatus: "on_leave" }),
  ];

  const leaverKeys = leaverVisitorKeySet(directory);

  // A terminated Training Manager (A-7) and a resigned coach are leavers; active and on_leave are not.
  assert.equal(isLeaverVisitorHrId("A-7", leaverKeys), true, "a terminated coach (A-7) must be a hidden visitor");
  assert.equal(isLeaverVisitorHrId("B-97", leaverKeys), true, "a resigned coach must be a hidden visitor");
  assert.equal(isLeaverVisitorHrId("B-50", leaverKeys), false, "an active coach must stay visible");
  assert.equal(isLeaverVisitorHrId("B-60", leaverKeys), false, "an on-leave coach must stay visible");

  // HR-id match is canonical (case-insensitive; both sides run through canonicalHrIdKey, which the
  // stored "A-7" form matches), or a leaver silently leaks back in.
  assert.equal(isLeaverVisitorHrId("a-7", leaverKeys), true, "match survives casing");
  assert.equal(isLeaverVisitorHrId("  A-7 ", leaverKeys), true, "match survives surrounding whitespace");

  // A null/blank visitor id is never treated as a hidden leaver (no false positive → no dropped name).
  assert.equal(isLeaverVisitorHrId(null, leaverKeys), false, "a null visitor id is not a leaver");
  assert.equal(isLeaverVisitorHrId("", leaverKeys), false, "a blank visitor id is not a leaver");

  // The set contains exactly the two leavers.
  assert.equal(leaverKeys.size, 2, "exactly the terminated and resigned coaches are leavers");
}
