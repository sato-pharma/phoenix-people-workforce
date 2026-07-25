import assert from "node:assert/strict";

import {
  describePopulationDiff,
  diffPopulation,
  type PreviousRosterEntry,
} from "../src/lib/automated-payroll/population-diff.ts";
import type { PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { RowLifecycle } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * Guards the population diff — the safety net for silent-disappearance bugs.
 *
 * The headline case is the REAL 2026-07-25 incident: B-157 (Sameh Ahmed Ezzat
 * Mohamed Hussien) had `employment_status='resigned'` with a last working date
 * a full month in the FUTURE, so he was dropped from the entire payroll
 * population while still actively employed. Nothing surfaced it — no error, no
 * empty state. He must land in `disappeared`, never quietly in `left`.
 */

function member(hrId: string, fullName: string, lifecycle: RowLifecycle = "regular"): PopulationMember {
  return {
    employee: { hrId, fullName } as unknown as EmployeeDirectoryRow,
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle,
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
    unpaidDaysInSpan: 0,
  };
}

function rosterEntry(hrId: string, fullName: string, wasLeaver = false): PreviousRosterEntry {
  return { hrId, fullName, compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""), wasLeaver };
}

export function runAutomatedPayrollPopulationDiffTests() {
  // ---- THE REAL BUG: paid last month, gone now, no resignation on file ------
  const samehGone = diffPopulation({
    current: [member("B-1", "Stays Employed"), member("B-2", "Also Stays")],
    previous: [
      rosterEntry("B-1", "Stays Employed"),
      rosterEntry("B-2", "Also Stays"),
      rosterEntry("B-157", "Sameh Ahmed Ezzat Mohamed Hussien"), // NOT a leaver
    ],
  });
  assert.equal(samehGone.disappeared.length, 1, "an unexplained absence must be flagged, not swallowed");
  assert.equal(samehGone.disappeared[0]?.hrId, "B-157");
  assert.equal(samehGone.left.length, 0, "an employee with no resignation must never be reported as 'left'");

  // ---- a genuine leaver is expected, not an alarm ---------------------------
  const realLeaver = diffPopulation({
    current: [member("B-1", "Stays Employed")],
    previous: [rosterEntry("B-1", "Stays Employed"), rosterEntry("B-9", "Really Resigned", true)],
  });
  assert.equal(realLeaver.left.length, 1);
  assert.equal(realLeaver.left[0]?.hrId, "B-9");
  assert.deepEqual(realLeaver.disappeared, [], "a settled leaver must not raise an alarm");

  // ---- a joiner must NOT mask a disappearance in the same month -------------
  // (headcount is identical here — 2 then, 2 now — which is exactly why a bare
  // headcount comparison cannot catch this and the diff names people instead)
  const masked = diffPopulation({
    current: [member("B-1", "Stays Employed"), member("B-99", "Brand New", "joiner")],
    previous: [rosterEntry("B-1", "Stays Employed"), rosterEntry("B-157", "Vanished Silently")],
  });
  assert.equal(masked.currentHeadcount, masked.previousHeadcount, "headcount is unchanged — the trap");
  assert.equal(masked.joined.length, 1);
  assert.equal(masked.joined[0]?.hrId, "B-99");
  assert.equal(masked.disappeared.length, 1, "a disappearance hidden behind a joiner must still be caught");
  assert.equal(masked.disappeared[0]?.hrId, "B-157");

  // ---- HR_ID matching is normalization-insensitive -------------------------
  // (compact keys: the same person written "b157" vs "B-157" is still present)
  const messyIds = diffPopulation({
    current: [member("b-157", "Same Person Different Casing")],
    previous: [rosterEntry("B-157", "Same Person Different Casing")],
  });
  assert.deepEqual(messyIds.disappeared, [], "casing/dash differences must not fake a disappearance");
  assert.deepEqual(messyIds.joined, [], "casing/dash differences must not fake a joiner");

  // ---- no baseline (first-ever run) is stated honestly, not shown as churn --
  const firstRun = diffPopulation({ current: [member("B-1", "First Ever")], previous: [] });
  assert.equal(firstRun.noBaseline, true);
  assert.equal(firstRun.joined.length, 1);
  assert.deepEqual(firstRun.disappeared, []);
  assert.equal(describePopulationDiff(firstRun), "No previous month to compare against.");

  // ---- a clean month reports no movement -----------------------------------
  const steady = diffPopulation({
    current: [member("B-1", "A"), member("B-2", "B")],
    previous: [rosterEntry("B-1", "A"), rosterEntry("B-2", "B")],
  });
  assert.deepEqual(steady.joined, []);
  assert.deepEqual(steady.left, []);
  assert.deepEqual(steady.disappeared, []);
  assert.equal(describePopulationDiff(steady), "2 employees (was 2)");

  // ---- the summary line surfaces the warning when it matters ---------------
  assert.equal(describePopulationDiff(masked).includes("unexplained"), true);
}
