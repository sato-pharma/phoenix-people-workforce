import assert from "node:assert/strict";

import {
  computeNextRuns,
  detectScheduleCollisions,
  formatNextRunHuman,
  validateCronExpression,
} from "../src/lib/cron-control/cron-expression.ts";

const FIXED_FROM = new Date("2026-07-19T00:00:00Z");

export function runCronControlExpressionTests() {
  // Valid: matches the real live phoenix-notify-daily schedule exactly.
  const dailyResult = computeNextRuns({ cronExpression: "36 6 * * *", from: FIXED_FROM, timeZone: "Africa/Cairo" });
  assert.equal(dailyResult.valid, true, "valid daily expression should parse");
  if (dailyResult.valid) {
    assert.equal(dailyResult.nextRuns.length, 5, "default preview count is 5");
    assert.equal(dailyResult.nextRuns[0], "2026-07-19T03:36:00.000Z", "06:36 Africa/Cairo is 03:36 UTC");
    assert.equal(dailyResult.nextRuns[1], "2026-07-20T03:36:00.000Z", "next run is exactly 1 day later");
  }

  // Valid: every-5-minutes expression, custom count.
  const frequentResult = computeNextRuns({ count: 3, cronExpression: "*/5 * * * *", from: FIXED_FROM, timeZone: "UTC" });
  assert.equal(frequentResult.valid, true);
  if (frequentResult.valid) assert.equal(frequentResult.nextRuns.length, 3);

  // Invalid: garbage syntax.
  const garbage = computeNextRuns({ cronExpression: "not a cron", timeZone: "UTC" });
  assert.equal(garbage.valid, false, "garbage syntax must be rejected");

  // Invalid: unreachable day-of-month/month combination (Feb 30 never occurs) — the real
  // fat-finger failure mode for this feature, per the plan's design discussion.
  const unreachable = computeNextRuns({ cronExpression: "0 0 30 2 *", timeZone: "UTC" });
  assert.equal(unreachable.valid, false, "Feb 30 can never fire and must be rejected");

  // Invalid: unrecognized time zone.
  const badTz = computeNextRuns({ cronExpression: "0 0 * * *", timeZone: "Not/AZone" });
  assert.equal(badTz.valid, false, "an unrecognized IANA time zone must be rejected");

  // validateCronExpression is a thin single-occurrence wrapper around computeNextRuns.
  assert.equal(validateCronExpression("36 6 * * *", "Africa/Cairo").valid, true);
  assert.equal(validateCronExpression("0 0 30 2 *", "UTC").valid, false);

  // formatNextRunHuman renders a readable, timezone-labeled string.
  const human = formatNextRunHuman("2026-07-20T03:36:00.000Z", "Africa/Cairo");
  assert.ok(human.includes("Africa/Cairo"), "human-readable string names the timezone");
  assert.ok(human.length > 0);

  // detectScheduleCollisions: same-minute overlap is flagged, no overlap is not.
  const collisions = detectScheduleCollisions(
    ["2026-07-20T03:36:00.000Z", "2026-07-21T03:36:00.000Z"],
    [
      { jobName: "Other Job A", runs: ["2026-07-20T03:36:00.000Z"] }, // same minute as candidate's first run
      { jobName: "Other Job B", runs: ["2026-07-20T09:00:00.000Z"] }, // no overlap
    ],
  );
  assert.equal(collisions.length, 1, "exactly one colliding job should be flagged");
  assert.equal(collisions[0].jobName, "Other Job A");

  const noCollisions = detectScheduleCollisions(
    ["2026-07-20T03:36:00.000Z"],
    [{ jobName: "Other Job B", runs: ["2026-07-20T09:00:00.000Z"] }],
  );
  assert.equal(noCollisions.length, 0, "no overlap means no collisions reported");
}
