import assert from "node:assert/strict";

import {
  OVERDUE_PROBATION_REMINDER_CADENCE_DAYS,
  overdueProbationReminderEventKey,
  planOverdueProbationReminder,
} from "../src/lib/probation/service.ts";

/**
 * The overdue probation escalation. The three scheduled reminders all fire BEFORE the deadline
 * (the last at 15 days remaining), so once the 90 days lapse with the evaluation still open nothing
 * chased the manager — six cases reached 46-60 days overdue on production before anyone noticed
 * (2026-09-29). planOverdueProbationReminder is the pure core that decides whether a weekly nudge is
 * due; this pins the exact edges so a regression can't quietly reopen the gap.
 */
export function runProbationOverdueReminderTests() {
  const END = "2026-08-14"; // a real overdue case's probation end date

  // ── Not overdue: the pre-deadline schedule owns this window, so no overdue event is created ──
  assert.deepEqual(
    planOverdueProbationReminder({ outstanding: true, probationEndDate: END, today: END }),
    { create: false, daysOverdue: 0, weekBucket: 0 },
    "on the end date itself, nothing is overdue yet",
  );
  assert.equal(
    planOverdueProbationReminder({ outstanding: true, probationEndDate: END, today: "2026-08-10" }).create,
    false,
    "before the end date, no overdue reminder",
  );

  // ── One day past the deadline: the escalation begins, week bucket 0 ──
  assert.deepEqual(
    planOverdueProbationReminder({ outstanding: true, probationEndDate: END, today: "2026-08-15" }),
    { create: true, daysOverdue: 1, weekBucket: 0 },
    "one day overdue starts the weekly escalation",
  );

  // ── Weekly cadence: the bucket only advances every 7 days, so re-runs inside a week don't re-fire ──
  assert.equal(planOverdueProbationReminder({ outstanding: true, probationEndDate: END, today: "2026-08-20" }).weekBucket, 0, "day 6 overdue is still week 0");
  assert.equal(planOverdueProbationReminder({ outstanding: true, probationEndDate: END, today: "2026-08-21" }).weekBucket, 1, "day 7 overdue rolls to week 1");
  // A real case from the sweep: Mostafa Elbadry, ended 2026-08-14, read on 2026-09-29 = 46 days over.
  const live = planOverdueProbationReminder({ outstanding: true, probationEndDate: END, today: "2026-09-29" });
  assert.deepEqual(live, { create: true, daysOverdue: 46, weekBucket: 6 }, "46 days overdue -> week bucket 6");

  // ── A decided case stops chasing on its own — the whole point of gating on `outstanding` ──
  assert.equal(
    planOverdueProbationReminder({ outstanding: false, probationEndDate: END, today: "2026-09-29" }).create,
    false,
    "a decided (not outstanding) case is never chased, however overdue",
  );

  // ── Null / missing end date is a safe no-op, never a throw or a false positive ──
  assert.equal(planOverdueProbationReminder({ outstanding: true, probationEndDate: null, today: "2026-09-29" }).create, false, "null end date -> no reminder");
  assert.equal(planOverdueProbationReminder({ outstanding: true, probationEndDate: undefined, today: "2026-09-29" }).create, false, "undefined end date -> no reminder");

  // ── Datetime input resolves by date part only (no tz day-shift) ──
  assert.equal(
    planOverdueProbationReminder({ outstanding: true, probationEndDate: `${END}T23:30:00Z`, today: "2026-08-15" }).daysOverdue,
    1,
    "datetime end date resolves by its date part",
  );

  // ── The event key is stable per (employee, end date, week bucket): idempotent within a week,
  //    fresh the next — which is what ignoreDuplicates on event_key relies on ──
  assert.equal(
    overdueProbationReminderEventKey("PD-0031", END, 6),
    "PD-0031:probation:probation_overdue:2026-08-14:w6",
    "event key carries the employee, end date and week bucket",
  );
  assert.notEqual(
    overdueProbationReminderEventKey("PD-0031", END, 6),
    overdueProbationReminderEventKey("PD-0031", END, 7),
    "a new week bucket is a new key, so next week creates a fresh nudge",
  );

  assert.equal(OVERDUE_PROBATION_REMINDER_CADENCE_DAYS, 7, "weekly cadence");
}
