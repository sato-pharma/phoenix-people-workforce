import assert from "node:assert/strict";

import {
  daysWaitingSince,
  pickLatestReturnPerRequest,
  returnedAgeBand,
} from "../src/lib/direct-orders/returned-ageing.ts";

export function runReturnedOrdersAgeingTests() {
  // ── The band is INVERTED against the Held Desk, and that is the whole point ──────────────────
  // Held counts DOWN to a 14-day expiry, so 1 day is its urgent end. `returned` has no clock, so
  // the number only grows and 21 days is the urgent end here. A session "harmonising" the two
  // desks would flip these and paint the most neglected order the calmest colour.
  assert.equal(returnedAgeBand(0), "fresh", "a same-day return is not yet a problem");
  assert.equal(returnedAgeBand(6), "fresh", "under a week is still the rep's normal turnaround");
  assert.equal(returnedAgeBand(7), "stale", "a week with no answer is the first alarm");
  assert.equal(returnedAgeBand(20), "stale", "still stale right up to the critical threshold");
  assert.equal(returnedAgeBand(21), "critical", "three weeks unanswered is the worst band");
  assert.equal(
    returnedAgeBand(60),
    "critical",
    "the band SATURATES rather than wrapping — older than critical is still critical, never back to fresh",
  );

  // The inversion, stated as the invariant itself rather than as three separate constants: age
  // must never be scored as LESS urgent the longer it waits.
  const severity: Record<string, number> = { fresh: 0, stale: 1, critical: 2 };
  for (let day = 1; day <= 40; day += 1) {
    assert.ok(
      severity[returnedAgeBand(day)] >= severity[returnedAgeBand(day - 1)],
      `severity must never fall as days rise — broke between day ${day - 1} and ${day}`,
    );
  }

  // ── Age maths ───────────────────────────────────────────────────────────────────────────────
  const now = new Date("2026-09-08T12:00:00.000Z");
  assert.equal(daysWaitingSince("2026-09-08T11:00:00.000Z", now), 0, "an hour old floors to 0 days, never 1");
  assert.equal(daysWaitingSince("2026-09-01T12:00:00.000Z", now), 7, "exactly seven days reads 7");
  assert.equal(daysWaitingSince("2026-08-12T12:00:00.000Z", now), 27, "matches the oldest real row on 2026-09-08");
  assert.equal(daysWaitingSince(null, now), 0, "a missing timestamp is 0, not NaN");
  assert.equal(daysWaitingSince("not a date", now), 0, "an unparseable timestamp is 0, not NaN");
  assert.equal(
    daysWaitingSince("2026-09-09T12:00:00.000Z", now),
    0,
    "a FUTURE timestamp clamps to 0 — a negative age would sort to the top of an oldest-first desk and read as the most urgent row",
  );

  // ── The latest return wins ──────────────────────────────────────────────────────────────────
  // An order can be returned, corrected, resubmitted and returned again. Only the last comment is
  // still open; showing the first hands the rep a question they already answered.
  const latest = pickLatestReturnPerRequest([
    { requestId: "a", createdAt: "2026-08-12T09:00:00.000Z", message: "only 15%" },
    { requestId: "a", createdAt: "2026-09-01T09:00:00.000Z", message: "still only 15% — revise" },
    { requestId: "b", createdAt: "2026-08-24T09:00:00.000Z", message: "code should be POS/IBNSINA" },
  ]);
  assert.equal(latest.size, 2, "one entry per request, not one per event");
  assert.equal(
    latest.get("a")?.message,
    "still only 15% — revise",
    "the LAST return is the open question; the first was already answered",
  );
  assert.equal(latest.get("b")?.message, "code should be POS/IBNSINA", "a single-event request keeps its only comment");

  // Order-independence: the query does sort, but a helper that silently relies on the caller's
  // ORDER BY is one refactor away from showing the oldest comment with no error anywhere.
  const shuffled = pickLatestReturnPerRequest([
    { requestId: "a", createdAt: "2026-09-01T09:00:00.000Z", message: "newest" },
    { requestId: "a", createdAt: "2026-07-01T09:00:00.000Z", message: "oldest" },
    { requestId: "a", createdAt: "2026-08-01T09:00:00.000Z", message: "middle" },
  ]);
  assert.equal(
    shuffled.get("a")?.message,
    "newest",
    "the latest event wins regardless of the order the rows arrive in",
  );

  // A malformed timestamp must not become the 'latest' and hide the real comment.
  const withJunk = pickLatestReturnPerRequest([
    { requestId: "a", createdAt: "2026-09-01T09:00:00.000Z", message: "real" },
    { requestId: "a", createdAt: "", message: "junk" },
  ]);
  assert.equal(withJunk.get("a")?.message, "real", "an unparseable event is skipped, never treated as newest");

  assert.equal(pickLatestReturnPerRequest([]).size, 0, "no events yields an empty map, not a throw");
}
