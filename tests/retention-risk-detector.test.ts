import assert from "node:assert/strict";

import {
  buildRetentionRiskSignals,
  retentionRiskSignalKey,
} from "../src/lib/retention-risk/detector.ts";
import type {
  RetentionRiskDetectionInput,
  RetentionRiskSubject,
} from "../src/lib/retention-risk/types.ts";

/**
 * The retention-risk detector: five consecutive WORKING days of recorded leave, or of no CRM entry
 * at all, on the owner's instruction of 2026-09-06.
 *
 * THE CALENDAR THESE DATES SIT ON. For a Medical Representative the week is Saturday to Wednesday
 * full days, Thursday a half day and FRIDAY THE ONLY WEEKLY OFF (`isFieldWorkforceFridayOnlyTitle`
 * — Saturday is a working day for that title and a day off for everyone else). In the window used
 * throughout this file:
 *
 *   Sat 29 Aug · Sun 30 · Mon 31 · Tue 1 Sep · Wed 2 · Thu 3 · FRI 4 · Sat 5 · Sun 6 · Mon 7 ·
 *   Tue 8 · Wed 9 · Thu 10 · FRI 11 · Sat 12
 *
 * Two Fridays inside a fortnight is exactly why the bridging rule below is the load-bearing one.
 */

const MEASURABLE_THROUGH = "2026-09-12";
const WINDOW_START = "2026-08-29";
const WINDOW_END = "2026-09-30";

function rep(overrides: Partial<RetentionRiskSubject> = {}): RetentionRiskSubject {
  return {
    areaName: "Cairo 1",
    displayName: "Test Rep",
    firstCrmActivityDate: "2026-01-05",
    hireDate: "2026-01-01",
    hrId: "B-999",
    jobTitle: "Medical Representative",
    lastWorkingDate: null,
    lineName: "CNS",
    managerHrId: "B-100",
    managerName: "Test Manager",
    positionTitle: null,
    watchCrmSilence: true,
    ...overrides,
  };
}

function input(overrides: Partial<RetentionRiskDetectionInput> = {}): RetentionRiskDetectionInput {
  return {
    crmActivityByHrId: new Map(),
    leaveByHrId: new Map(),
    measurableThrough: MEASURABLE_THROUGH,
    publicHolidays: new Set<string>(),
    subjects: [rep()],
    thresholdWorkingDays: 5,
    windowEnd: WINDOW_END,
    windowStart: WINDOW_START,
    ...overrides,
  };
}

/** Activity on every listed date, keyed the way the service keys it (canonical, lower case). */
function activity(dates: string[], key = "b-999") {
  return new Map([[key, new Set(dates)]]);
}

function leave(dates: string[], key = "b-999") {
  return new Map([[key, new Set(dates)]]);
}

export function runRetentionRiskDetectorTests() {
  // ── A weekly off BRIDGES a run; it must never break one ────────────────────────────────────
  //
  // This is the assertion the whole feature lives or dies on. A rep is silent from Tuesday 1
  // September to Monday 7 September, with Friday the 4th in the middle. Six working days.
  //
  // If Friday BROKE the run, the same silence would split into 3 + 3 and NOTHING would be
  // reported — and because Friday recurs weekly, a five-working-day streak could then only ever
  // be Saturday-to-Wednesday exactly. The feature would report almost nothing, silently, and look
  // like it was working.
  {
    const signals = buildRetentionRiskSignals(
      input({ crmActivityByHrId: activity(["2026-08-31", "2026-09-08"]) }),
    );
    const silence = signals.filter((one) => one.trigger === "crm_silence");
    assert.equal(silence.length, 1, "one unbroken run, not one per side of the Friday");
    assert.equal(
      silence[0].workingDays,
      6,
      "Tue 1, Wed 2, Thu 3, Sat 5, Sun 6, Mon 7 — the Friday is bridged, never counted",
    );
    assert.equal(silence[0].startDate, "2026-09-01");
    assert.equal(silence[0].endDate, "2026-09-07", "the run ends on the last WORKING day, never on a weekend");
    assert.ok(
      silence[0].bridgedDates.includes("2026-09-04"),
      "the bridged Friday is reported, so a reader can see the calendar span really covered",
    );
    assert.equal(
      silence[0].ongoing,
      false,
      "a CRM entry on 8 September ended it — ongoing is the absence of an ending, not a date comparison",
    );
  }

  // ── The threshold is measured in working days, and 4 is not 5 ──────────────────────────────
  {
    // Silent Tue 1 to Sat 5: Tue, Wed, Thu and Sat are four working days (Friday bridged).
    // The trailing entry on 12 September is not decoration: without it the days AFTER the gap
    // (Mon 7 to Sat 12) are themselves five working days and the case would pass for the wrong
    // reason.
    const four = buildRetentionRiskSignals(
      input({ crmActivityByHrId: activity(["2026-08-31", "2026-09-06", "2026-09-12"]) }),
    ).filter((one) => one.trigger === "crm_silence");
    assert.equal(four.length, 0, "four working days is under the owner's rule and must stay silent");

    const five = buildRetentionRiskSignals(
      input({ crmActivityByHrId: activity(["2026-08-31", "2026-09-07", "2026-09-12"]) }),
    ).filter((one) => one.trigger === "crm_silence");
    assert.equal(five.length, 1, "the fifth working day is what raises it");
    assert.equal(five[0].workingDays, 5);
  }

  // ── Recorded leave BRIDGES a silence run rather than ending it ─────────────────────────────
  //
  // Leave explains the missing rows, so it cannot count as silence. But if it also RESET the
  // count, a few days of leave in the middle of a fortnight away would split one long
  // disappearance into two short runs and neither would reach the threshold — leave would become
  // the way to hide from this board.
  {
    const signals = buildRetentionRiskSignals(
      input({
        crmActivityByHrId: activity(["2026-08-31", "2026-09-10"]),
        leaveByHrId: leave(["2026-09-03", "2026-09-05", "2026-09-06"]),
      }),
    );
    const silence = signals.filter((one) => one.trigger === "crm_silence");
    assert.equal(silence.length, 1, "the leave in the middle must not split the run in two");
    assert.equal(
      silence[0].workingDays,
      5,
      "Tue 1, Wed 2, Mon 7, Tue 8, Wed 9 — the three leave days and the Friday are bridged, so only the five unexplained days count. Had leave BROKEN the run it would be 2 and 3, and neither reaches the rule.",
    );
  }

  // The same three leave days, one short of the threshold on their own, must not raise a leave
  // signal either — 3 working days is not 5.
  {
    const signals = buildRetentionRiskSignals(
      input({ leaveByHrId: leave(["2026-09-03", "2026-09-05", "2026-09-06"]) }),
    );
    assert.equal(
      signals.filter((one) => one.trigger === "extended_leave").length,
      0,
      "three leave days is under the rule",
    );
  }

  // ── Five consecutive leave working days DO raise the leave signal ──────────────────────────
  {
    const signals = buildRetentionRiskSignals(
      input({
        // Tue 1 to Mon 7 with the Friday bridged: Tue, Wed, Thu, Sat, Sun, Mon = 6 working days.
        leaveByHrId: leave([
          "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07",
        ]),
      }),
    );
    const extended = signals.filter((one) => one.trigger === "extended_leave");
    assert.equal(extended.length, 1);
    assert.equal(extended[0].workingDays, 6, "the Friday inside the block is bridged, not counted as leave");
    assert.equal(extended[0].startDate, "2026-09-01");
    assert.equal(extended[0].endDate, "2026-09-07");
  }

  // ── A public holiday bridges exactly like a weekly off ─────────────────────────────────────
  {
    const withHoliday = buildRetentionRiskSignals(
      input({
        crmActivityByHrId: activity(["2026-08-31", "2026-09-08"]),
        publicHolidays: new Set(["2026-09-02"]),
      }),
    ).filter((one) => one.trigger === "crm_silence");
    assert.equal(withHoliday.length, 1, "a holiday must not split the run");
    assert.equal(
      withHoliday[0].workingDays,
      5,
      "the same six-day run minus the holiday — a public holiday is never a day somebody failed to work",
    );
  }

  // ── A MANAGER is never measured for CRM silence ────────────────────────────────────────────
  //
  // A rep logs the visit and tags the manager, so a manager's silence measures the rep's data
  // entry. Measured on production 2026-09-06 with this rule off: the SFE Manager read 26 days
  // silent, the Finance & Admin Manager 52, and the NSM, Marketing Manager, Group Product Manager
  // and Training Manager all 10. None of them was leaving.
  {
    const manager = rep({
      displayName: "Test District Manager",
      hrId: "B-900",
      jobTitle: "District Sales Manager",
      watchCrmSilence: false,
    });
    const signals = buildRetentionRiskSignals(
      input({
        crmActivityByHrId: new Map(),
        leaveByHrId: leave(
          ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-05", "2026-09-06"],
          "b-900",
        ),
        subjects: [manager],
      }),
    );
    assert.equal(
      signals.filter((one) => one.trigger === "crm_silence").length,
      0,
      "a manager with no CRM row at all in the whole window still raises no silence signal",
    );
    assert.equal(
      signals.filter((one) => one.trigger === "extended_leave").length,
      1,
      "the LEAVE rule still applies to them — it reads an HR record, not somebody else's data entry",
    );
  }

  // ── A CRM account that has never produced a row is skipped, not reported ───────────────────
  //
  // "Silent for the whole window" and "has no CRM account yet" are indistinguishable from the
  // mirror. Measured on production 2026-09-06: of 69 active medical reps, exactly 4 had no row in
  // the 66-day scan, and those same 4 have never had one at all — so treating null as a signal
  // would report only unmapped accounts, which crm/unmapped-alert.ts already covers.
  {
    const signals = buildRetentionRiskSignals(
      input({ subjects: [rep({ firstCrmActivityDate: null })] }),
    );
    assert.equal(
      signals.filter((one) => one.trigger === "crm_silence").length,
      0,
      "no CRM history at all means unmeasurable, never guilty",
    );
  }

  // ── A new joiner is not reported for the days before their account was producing ───────────
  {
    const signals = buildRetentionRiskSignals(
      input({
        crmActivityByHrId: activity(["2026-09-08"]),
        subjects: [rep({ firstCrmActivityDate: "2026-09-08", hireDate: "2026-09-01" })],
      }),
    );
    assert.equal(
      signals.filter((one) => one.trigger === "crm_silence").length,
      0,
      "measurement starts at the first entry the account ever produced, so ramp-up is not a disappearance",
    );
  }

  // ── Nothing is measured past what the data can answer for ──────────────────────────────────
  //
  // Reps enter visits through and after the working day and the mirror syncs three times a day,
  // so today always reads empty for everybody. The ceiling is what stops this board reporting the
  // entire field force every morning.
  {
    const signals = buildRetentionRiskSignals(
      input({
        crmActivityByHrId: activity(["2026-08-31"]),
        measurableThrough: "2026-09-02",
      }),
    ).filter((one) => one.trigger === "crm_silence");
    assert.equal(signals.length, 0, "only Tue 1 and Wed 2 are measurable, which is two working days");
  }

  // ── An ongoing run is one nothing ended, and it keeps ONE notification key ─────────────────
  {
    const day6 = buildRetentionRiskSignals(
      input({ crmActivityByHrId: activity(["2026-08-31"]), measurableThrough: "2026-09-07" }),
    ).filter((one) => one.trigger === "crm_silence");
    const day7 = buildRetentionRiskSignals(
      input({ crmActivityByHrId: activity(["2026-08-31"]), measurableThrough: "2026-09-08" }),
    ).filter((one) => one.trigger === "crm_silence");

    assert.equal(day6[0].ongoing, true, "nothing ended it, so it is still open");
    assert.equal(day7[0].workingDays, day6[0].workingDays + 1, "it grows by a day each day it continues");
    assert.equal(
      retentionRiskSignalKey(day7[0]),
      retentionRiskSignalKey(day6[0]),
      "the key is the run's START date, so a growing run is announced once and never re-announced every morning",
    );
  }

  // ── HR ids are mixed case in this system, so every lookup must be canonicalised ────────────
  {
    const signals = buildRetentionRiskSignals(
      input({
        // The mirror stores "b-999"; the directory row says "B-999". A plain equality check finds
        // nothing here, and "no activity found" is exactly what a disappearance looks like.
        crmActivityByHrId: activity(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-05", "2026-09-06", "2026-09-07"], "b-999"),
        subjects: [rep({ hrId: "B-999" })],
      }),
    );
    assert.equal(
      signals.filter((one) => one.trigger === "crm_silence").length,
      0,
      "a working rep whose id is stored in a different case must never read as silent",
    );
  }

  // ── Someone who has left is not measured past their last working day ──────────────────────
  {
    const signals = buildRetentionRiskSignals(
      input({
        crmActivityByHrId: activity(["2026-08-31"]),
        subjects: [rep({ lastWorkingDate: "2026-09-02" })],
      }),
    ).filter((one) => one.trigger === "crm_silence");
    assert.equal(signals.length, 0, "a leaver's empty days after their exit are not a retention signal");
  }

  // ── Ordering: what someone should look at first ────────────────────────────────────────────
  {
    const signals = buildRetentionRiskSignals(
      input({
        crmActivityByHrId: new Map([
          // Still going: silent from Sun 6 September, six working days and counting.
          ["b-1", new Set(["2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-05"])],
          // Ended on 12 September, but far longer while it lasted — eleven working days.
          ["b-2", new Set(["2026-08-29", "2026-09-12"])],
        ]),
        subjects: [
          rep({ displayName: "Still Going", hrId: "B-1" }),
          rep({ displayName: "Already Back", hrId: "B-2" }),
        ],
      }),
    ).filter((one) => one.trigger === "crm_silence");
    assert.equal(signals.length, 2);
    assert.equal(
      signals[0].displayName,
      "Still Going",
      "an open run outranks a longer closed one — the open one is the person somebody still has to call",
    );
  }
}
