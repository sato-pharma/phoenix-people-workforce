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
 * THE CALENDAR THIS BOARD COUNTS: Saturday, Sunday, Monday, Tuesday, Wednesday. NOT Thursday, NOT
 * Friday — owner, 2026-09-07: "FRIDAY AND THURSDAY NOT INCLUDED". His own worked example: on Monday
 * 7 September the three days behind it are the 2nd, the 5th and the 6th.
 *
 * In the window used throughout this file (counted days in CAPS):
 *
 *   SAT 29 Aug · SUN 30 · MON 31 · TUE 1 Sep · WED 2 · thu 3 · fri 4 · SAT 5 · SUN 6 · MON 7 ·
 *   TUE 8 · WED 9 · thu 10 · fri 11 · SAT 12
 *
 * FOUR skipped days inside a fortnight is exactly why the bridging rule is the load-bearing one:
 * if any of them BROKE a run, nothing could ever span a week.
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
      5,
      "Tue 1, Wed 2, Sat 5, Sun 6, Mon 7 — Thursday the 3rd and Friday the 4th are both skipped",
    );
    assert.equal(silence[0].startDate, "2026-09-01");
    assert.equal(silence[0].endDate, "2026-09-07", "the run ends on the last WORKING day, never on a weekend");
    assert.ok(
      silence[0].bridgedDates.includes("2026-09-04") && silence[0].bridgedDates.includes("2026-09-03"),
      "both skipped days are reported, so a reader can see the calendar span really covered",
    );
    assert.equal(
      silence[0].ongoing,
      false,
      "a CRM entry on 8 September ended it — ongoing is the absence of an ending, not a date comparison",
    );
  }

  // ── The threshold is measured in working days, and 4 is not 5 ──────────────────────────────
  {
    // Silent Tue 1 to Sun 6, seen again on Mon 7: Tue 1, Wed 2, Sat 5, Sun 6 are four counted days.
    // The trailing entry on 12 September is not decoration: without it the days AFTER the gap are
    // themselves enough to reach the threshold and the case would pass for the wrong reason.
    const four = buildRetentionRiskSignals(
      input({ crmActivityByHrId: activity(["2026-08-31", "2026-09-07", "2026-09-12"]) }),
    ).filter((one) => one.trigger === "crm_silence");
    assert.equal(four.length, 0, "four counted days is under this test's threshold and must stay silent");

    const five = buildRetentionRiskSignals(
      input({ crmActivityByHrId: activity(["2026-08-31", "2026-09-08", "2026-09-12"]) }),
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
        crmActivityByHrId: activity(["2026-08-31", "2026-09-12"]),
        leaveByHrId: leave(["2026-09-05", "2026-09-06"]),
      }),
    );
    const silence = signals.filter((one) => one.trigger === "crm_silence");
    assert.equal(silence.length, 1, "the leave in the middle must not split the run in two");
    assert.equal(
      silence[0].workingDays,
      5,
      "Tue 1, Wed 2, Mon 7, Tue 8, Wed 9 — the two leave days and the skipped Thu/Fri are bridged, so only the five unexplained days count. Had leave BROKEN the run it would be 2 and 3, and neither reaches the rule.",
    );
  }

  // The same three leave days, one short of the threshold on their own, must not raise a leave
  // signal either — 3 working days is not 5.
  {
    const signals = buildRetentionRiskSignals(
      input({ leaveByHrId: leave(["2026-09-05", "2026-09-06"]) }),
    );
    assert.equal(
      signals.filter((one) => one.trigger === "extended_leave").length,
      0,
      "two counted leave days is under this test's threshold",
    );
  }

  // ── Five consecutive leave working days DO raise the leave signal ──────────────────────────
  {
    const signals = buildRetentionRiskSignals(
      input({
        // Tue 1 to Mon 7 with Thu/Fri skipped: Tue, Wed, Sat, Sun, Mon = 5 counted days.
        leaveByHrId: leave([
          "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07",
        ]),
      }),
    );
    const extended = signals.filter((one) => one.trigger === "extended_leave");
    assert.equal(extended.length, 1);
    assert.equal(extended[0].workingDays, 5, "the Thursday and Friday inside the block are skipped, not counted as leave");
    assert.equal(extended[0].startDate, "2026-09-01");
    assert.equal(extended[0].endDate, "2026-09-07");
  }

  // ── A public holiday bridges exactly like a weekly off ─────────────────────────────────────
  {
    const withHoliday = buildRetentionRiskSignals(
      input({
        crmActivityByHrId: activity(["2026-08-31", "2026-09-09"]),
        publicHolidays: new Set(["2026-09-02"]),
      }),
    ).filter((one) => one.trigger === "crm_silence");
    assert.equal(withHoliday.length, 1, "a holiday must not split the run");
    assert.equal(
      withHoliday[0].workingDays,
      5,
      "Tue 1, Sat 5, Sun 6, Mon 7, Tue 8 — the holiday on the 2nd is skipped like a weekend, because a public holiday is never a day somebody failed to work",
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
          ["2026-09-01", "2026-09-02", "2026-09-05", "2026-09-06", "2026-09-07"],
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
    // The DETECTOR stays general — hand it a non-rep and the leave rule still applies, which is
    // what makes that rule testable here at all. Who actually reaches it is decided one layer up:
    // service.ts filters the roster to Medical Reps for BOTH rules (owner, 2026-09-07, "medical
    // reps only i said"), and tests/retention-risk-notify.test.ts pins that filter.
    assert.equal(
      signals.filter((one) => one.trigger === "extended_leave").length,
      1,
      "the detector applies the leave rule to whatever subject it is given; the rep-only scoping lives in service.ts",
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

  // ── openRunsOnly: a person who came back is not a resignation risk ─────────────────────────
  //
  // Owner, 2026-09-07, after seeing the first live board: "i only see reps with no enteries for 5
  // consecutive days or vacation for 5 consecutive days in current month and didnt return 2 work
  // yet or seen." The board was showing a rep silent 3-17 August who had been logging visits every
  // day since — history, not a warning.
  {
    const both = input({ crmActivityByHrId: activity(["2026-08-31", "2026-09-08"]) });
    const withClosed = buildRetentionRiskSignals(both).filter((one) => one.trigger === "crm_silence");
    assert.equal(withClosed.length, 1, "the run 1-7 September is real and closed by the entry on the 8th");
    assert.equal(withClosed[0].ongoing, false);

    const openOnly = buildRetentionRiskSignals({ ...both, openRunsOnly: true })
      .filter((one) => one.trigger === "crm_silence");
    assert.equal(openOnly.length, 0, "he came back on 8 September, so he must not be on the board");
  }

  // The still-open one survives that same filter — otherwise the rule would empty the board.
  {
    const open = buildRetentionRiskSignals(
      input({ crmActivityByHrId: activity(["2026-08-31"]), openRunsOnly: true }),
    ).filter((one) => one.trigger === "crm_silence");
    assert.equal(open.length, 1, "still silent, still on the board");
    assert.equal(open[0].ongoing, true);
  }

  // ── The last CRM entry is the one BEFORE the gap, never the newest overall ─────────────────
  //
  // On the first live board a rep whose gap ran 3-17 August was shown "Last CRM entry 6 September":
  // the maximum across the whole window, which reads as though nothing had ever been wrong.
  {
    const signals = buildRetentionRiskSignals(
      input({ crmActivityByHrId: activity(["2026-08-30", "2026-09-08", "2026-09-12"]) }),
    ).filter((one) => one.trigger === "crm_silence");
    assert.equal(signals.length, 1);
    // Sun 30 Aug carries the entry, so the silence opens on Mon 31 Aug — not 1 September.
    assert.equal(signals[0].startDate, "2026-08-31");
    assert.equal(
      signals[0].lastCrmActivityDate,
      "2026-08-30",
      "the entry that preceded the silence — not 12 September, which is after the run and makes the gap look imaginary",
    );
  }

  // ── THE OWNER'S OWN WORKED EXAMPLE, 2026-09-07 ─────────────────────────────────────────────
  //
  // "TODAY 7 SEPT THEN I SHOULD SEE IF ANYONE NOT SUBMITTED 3 HISTORICAL DAYS FRIDAY AND THURSDAY
  // NOT INCLUDED". Today is Monday 7 September, so the three days behind it are Wed 2, Sat 5 and
  // Sun 6 — Thursday the 3rd and Friday the 4th are skipped entirely.
  //
  // This is pinned at the REAL threshold of three, not the five the other cases use, because it is
  // the rule as he stated it rather than a mechanism test.
  {
    // `openRunsOnly` because that is how the board runs: a gap the rep already came back from is
    // not what he asked to see. Without it the empty days BEFORE the first entry (29-31 August)
    // count as a second, closed run.
    const asOf = {
      ...input(),
      measurableThrough: "2026-09-06",
      openRunsOnly: true,
      thresholdWorkingDays: 3,
    };

    // Last seen 1 September: the 2nd, 5th and 6th are all empty. Three days. He must appear.
    const silentSince1st = buildRetentionRiskSignals({
      ...asOf,
      crmActivityByHrId: activity(["2026-09-01"]),
    }).filter((one) => one.trigger === "crm_silence");
    assert.equal(silentSince1st.length, 1, "no entry on the 2nd, 5th or 6th — three days, he shows");
    assert.equal(silentSince1st[0].workingDays, 3);
    assert.equal(silentSince1st[0].startDate, "2026-09-02");
    assert.equal(silentSince1st[0].endDate, "2026-09-06");

    // Last seen 2 September: only the 5th and the 6th are empty. Two days. He must NOT appear —
    // and under the old rule, where Thursday the 3rd counted, this same rep DID appear.
    const silentSince2nd = buildRetentionRiskSignals({
      ...asOf,
      crmActivityByHrId: activity(["2026-09-02"]),
    }).filter((one) => one.trigger === "crm_silence");
    assert.equal(
      silentSince2nd.length,
      0,
      "worked on the 2nd, so only the 5th and 6th are empty — two days, and Thursday must not make up the third",
    );
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
