import assert from "node:assert/strict";

import {
  formatHeldAge,
  heldAgeBand,
  hoursHeldSince,
  summarizeHeldQueue,
} from "../src/lib/notifications/held-ageing.ts";

export function runNotificationHeldAgeingTests() {
  // ── Big is urgent, and that is the opposite of a countdown ───────────────────────────────────
  // The direct-order Held Desk counts DOWN to a 14-day expiry, so 1 is its urgent end. A gate hold
  // has no expiry, so the number only grows and 72h is the urgent end here. Copying the countdown
  // palette across would paint the most neglected item in the calmest colour.
  assert.equal(heldAgeBand(0), "fresh", "just held is not yet a problem");
  assert.equal(heldAgeBand(23), "fresh", "still same-working-day");
  assert.equal(heldAgeBand(24), "stale", "a full day unreviewed is the first alarm");
  assert.equal(heldAgeBand(71), "stale", "still stale right up to the critical threshold");
  assert.equal(heldAgeBand(72), "critical", "three days unreviewed is the worst band");
  assert.equal(
    heldAgeBand(24 * 365),
    "critical",
    "the band SATURATES — older than critical stays critical, never wrapping back to fresh",
  );

  // The invariant behind those constants: severity must never FALL as the wait grows.
  const severity: Record<string, number> = { fresh: 0, stale: 1, critical: 2 };
  for (let hour = 1; hour <= 200; hour += 1) {
    assert.ok(
      severity[heldAgeBand(hour)] >= severity[heldAgeBand(hour - 1)],
      `severity must never fall as hours rise — broke between ${hour - 1}h and ${hour}h`,
    );
  }

  // ── Age maths ───────────────────────────────────────────────────────────────────────────────
  const now = new Date("2026-09-08T12:00:00.000Z");
  assert.equal(hoursHeldSince("2026-09-08T11:30:00.000Z", now), 0, "half an hour floors to 0, never 1");
  assert.equal(hoursHeldSince("2026-09-08T11:00:00.000Z", now), 1, "exactly an hour reads 1");
  assert.equal(hoursHeldSince("2026-09-05T12:00:00.000Z", now), 72, "three days reads 72h — the critical edge");
  assert.equal(hoursHeldSince(null, now), 0, "a missing timestamp is 0, not NaN");
  assert.equal(hoursHeldSince("not a date", now), 0, "an unparseable timestamp is 0, not NaN");
  assert.equal(
    hoursHeldSince("2026-09-09T12:00:00.000Z", now),
    0,
    "a FUTURE timestamp clamps to 0 — a negative age would sort to the top of an oldest-first queue and read as the most urgent item",
  );

  // ── The chip label ──────────────────────────────────────────────────────────────────────────
  assert.equal(formatHeldAge(0), "under 1h", "sub-hour reads as under 1h, never '0h'");
  assert.equal(formatHeldAge(5), "5h", "hours below a day");
  assert.equal(formatHeldAge(23), "23h", "still hours at the last hour of the first day");
  assert.equal(formatHeldAge(24), "1d", "a day switches to days");
  assert.equal(formatHeldAge(279), "11d", "the 2026-08-28 incident's age, had it still been held");

  // ── The header summary ──────────────────────────────────────────────────────────────────────
  const empty = summarizeHeldQueue([], now);
  assert.equal(empty.empty, true, "an empty queue says so, so the header can omit the age line entirely");
  assert.equal(empty.oldestHours, 0, "empty queue has no oldest");
  assert.equal(empty.worst, "fresh", "empty is never reported as critical");

  const mixed = summarizeHeldQueue(
    [
      "2026-09-08T11:00:00.000Z", // 1h  → fresh
      "2026-09-07T06:00:00.000Z", // 30h → stale
      "2026-09-01T12:00:00.000Z", // 168h → critical
    ],
    now,
  );
  assert.equal(mixed.total, 3, "counts every held row");
  assert.equal(mixed.fresh, 1, "one fresh");
  assert.equal(mixed.stale, 1, "one stale");
  assert.equal(mixed.critical, 1, "one critical");
  assert.equal(mixed.oldestHours, 168, "oldest is the worst age present, not the newest or the mean");
  assert.equal(mixed.worst, "critical", "the header takes the WORST band present");

  // NOTE, so nobody mistakes these for a control: `worst` counted from the bands present and
  // `heldAgeBand(oldestHours)` are the SAME ANSWER today, and swapping one for the other passes
  // every assertion here. They cannot diverge while banding depends on age alone, because the
  // oldest row then necessarily carries the worst band — which the 200-hour monotonicity loop
  // above is what actually pins. These assertions state correct behaviour; they do not
  // discriminate between the two implementations, and claiming otherwise would be false comfort.
  const allFresh = summarizeHeldQueue(["2026-09-08T11:00:00.000Z", "2026-09-08T10:00:00.000Z"], now);
  assert.equal(allFresh.worst, "fresh", "a queue of fresh rows reports fresh");
  assert.equal(allFresh.critical, 0, "and counts no criticals");

  const staleOnly = summarizeHeldQueue(["2026-09-07T06:00:00.000Z"], now);
  assert.equal(staleOnly.worst, "stale", "stale-only never escalates itself to critical");

  // A queue whose only rows are unparseable must not read as ancient — 0h, fresh, not critical.
  const junk = summarizeHeldQueue([null, "not a date"], now);
  assert.equal(junk.oldestHours, 0, "unparseable timestamps do not manufacture an age");
  assert.equal(junk.worst, "fresh", "and do not manufacture an alarm");
  assert.equal(junk.total, 2, "but the rows are still counted — they exist and are still held");
}
