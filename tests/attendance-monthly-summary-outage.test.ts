import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveWorkingDayAttendance } from "../src/lib/attendance/monthly-summary.ts";

/**
 * Contract guard: the Monthly Attendance Summary must never report a device-ingestion outage as
 * employee absence.
 *
 * The August 2026 incident: the on-prem attendance agent stopped POSTing on 2026-07-30, and because
 * the summary treated "no punch row for this day" as "not present", every rostered employee was
 * marked absent for 2, 3 and 4 August — roughly 48 absence-days that never happened, and a 100%
 * absence rate presented as a confident figure. That Absent column is read as evidence about
 * people, so the fail-safe direction is mandatory.
 *
 * Supabase-backed end to end (roster + punches + calendar), so — matching this module's established
 * pattern (see attendance-device-outage-failsafe.test.ts) — the contract is pinned by source
 * inspection. The outage detector's own behaviour is covered where it lives.
 */
export function runAttendanceMonthlySummaryOutageTests() {
  // ── The decision itself, behaviourally ───────────────────────────────────────────────────────
  // The whole defect lives in one branch: what a missing punch row MEANS. A source-inspection
  // check cannot catch that branch being semantically disabled (verified — neutering the guard
  // while leaving its text in place kept an inspection-only test green), so the rule is pinned by
  // behaviour first.
  assert.equal(
    resolveWorkingDayAttendance({ hasOutage: true, hasPunchRow: false }),
    "no_data",
    "a day the device delivered nothing for ANYONE is unmeasurable — calling it absence invents evidence against every rostered employee at once",
  );
  assert.equal(
    resolveWorkingDayAttendance({ hasOutage: false, hasPunchRow: false }),
    "absent",
    "when the device DID deliver that day, a person missing from the data is genuinely absent — the fail-safe must not swallow real absence",
  );
  assert.equal(
    resolveWorkingDayAttendance({ hasOutage: false, hasPunchRow: true }),
    "present",
    "a punched day is present",
  );
  assert.equal(
    resolveWorkingDayAttendance({ hasOutage: true, hasPunchRow: true }),
    "no_data",
    "an outage day stays unmeasurable even for someone who happens to have a row, so one stray punch cannot make the day look measured for everybody else",
  );

  const summary = readFileSync("src/lib/attendance/monthly-summary.ts", "utf8");

  // 1. It must reuse the CANONICAL company-wide outage detector, not re-derive the rule. Two
  //    definitions of "outage" would let the weekly digest and this report disagree about the same
  //    day — the digest already skips those days, which is why the fabricated absences here were
  //    never cross-checked against anything.
  assert.match(
    summary,
    /getCompanyWideOutageDates/,
    "the monthly summary must consume the shared outage detector (ingestion-health.ts), never its own punch-presence rule",
  );

  // 2. The outage check must run BEFORE the day is counted as expected — the whole defect was that
  //    an outage day reached `expectedWorkingDays += 1` and then failed the present check, which is
  //    arithmetically identical to absence.
  const outageGuardIndex = summary.indexOf("outageDates.has(dateIso)");
  const expectedIncrementIndex = summary.indexOf("expectedWorkingDays += 1");
  assert.ok(outageGuardIndex > 0, "the per-day outage guard must exist");
  assert.ok(
    outageGuardIndex < expectedIncrementIndex,
    "an outage day must be skipped BEFORE expectedWorkingDays is incremented, or it still lands in absentDays",
  );

  // 3. absentDays stays a pure derivation of expected-minus-present, so excluding the day from
  //    `expected` is what keeps it out of `absent`. Pin that shape so a later refactor can't
  //    reintroduce absence by another route.
  assert.match(
    summary,
    /absentDays:\s*Math\.max\(0,\s*expectedWorkingDays\s*-\s*presentDays\)/,
    "absentDays must remain expected-minus-present, so an excluded outage day cannot become absence",
  );

  // 4. The gap must be SURFACED, not merely swallowed — silently dropping the days would turn a
  //    visible-but-wrong number into an invisible hole, which is not an improvement.
  assert.match(summary, /missingDataDates/, "the summary must expose which days had no data");
  assert.match(summary, /noDataDays/, "each employee row must carry its own no-data day count");

  // 5. Both surfaces a human reads must show it.
  const component = readFileSync("src/components/attendance/monthly-attendance-summary.tsx", "utf8");
  assert.match(
    component,
    /missingDataDates\.length > 0/,
    "the page must render an explicit warning when attendance data is missing for a working day",
  );
  const exporter = readFileSync("src/lib/attendance/monthly-summary-export.ts", "utf8");
  assert.match(
    exporter,
    /missingDataDates/,
    "the XLSX export must declare the incomplete window too — the file outlives the screen",
  );
  assert.match(
    exporter,
    /key: "noDataDays"/,
    "the export needs a No Data column beside Absent so a low Present count is readable as missing data",
  );
}
