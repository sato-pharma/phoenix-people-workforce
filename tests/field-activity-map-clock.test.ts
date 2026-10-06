import assert from "node:assert/strict";
import { utcTaggedWallClock } from "../src/lib/format/cairo-zone.ts";

/**
 * The Field Activity route map printed every GPS stop exactly three hours early.
 *
 * WHAT WENT WRONG. Every clock on this report is a CAIRO WALL CLOCK (field-activity/model.ts rule
 * 3), so it is rendered with `timeZone: "UTC"` — the digits as written, never shifted. That is only
 * half of the convention, and the other half belongs to `new Date`: a date-time string carrying NO
 * offset is parsed as the ENGINE'S LOCAL time, not as UTC. On a Cairo browser,
 * `new Date("2026-09-01T10:08:38")` is the instant `07:08:38Z`, and formatting that in UTC prints
 * 07:08. The two halves cancelled in the wrong direction and nothing threw.
 *
 * `field-activity-view.tsx` is the one caller that builds its value by hand — `${dateIso}T${clock}`,
 * with no `+00` — so it was the one surface that broke. Measured on production 2026-10-06 for B-148
 * on 1 September 2026: all ten stops off by exactly −3:00 to the second (stored 10:08:38 rendered as
 * 07:08 AM), on a card whose own "GPS window" fact, a plain string slice, read the same check-ins
 * correctly. The owner reported it the same day.
 *
 * WHY THESE ASSERTIONS AND NOT A RENDER TEST. The defect only reproduces in a process whose local
 * zone is not UTC, and CI's runner is UTC — a test that parsed a zone-less string and compared the
 * printed hour would pass identically with and without the fix, which is the worst shape a
 * regression test can take. So the invariant pinned here is the one that is true in EVERY zone: the
 * string handed to `new Date` must already carry a zone, and its digits must survive the round trip
 * into an instant. `toISOString()` is read in UTC, so the assertion is exact and zone-free.
 */

export function runFieldActivityMapClockTests() {
  // The defect itself: the shape `field-activity-view.tsx` builds, round-tripped. Without the tag,
  // `new Date` would read these digits in the engine's own zone and this instant would move.
  assert.equal(
    utcTaggedWallClock("2026-09-01T10:08:38"),
    "2026-09-01T10:08:38Z",
    "a zone-less wall clock must be tagged UTC, or the browser reads it as local time and the stop prints hours early",
  );
  assert.equal(
    new Date(utcTaggedWallClock("2026-09-01T10:08:38")).toISOString(),
    "2026-09-01T10:08:38.000Z",
    "B-148's real 1 September 2026 check-in: the digits must survive new Date unshifted, in any process zone",
  );

  // Minutes-only, which is what a punch clock hands over.
  assert.equal(utcTaggedWallClock("2026-09-02T09:57"), "2026-09-02T09:57Z", "a seconds-less wall clock is tagged too");

  // Postgres' own spacing, in case a value reaches this path without the T.
  assert.equal(
    new Date(utcTaggedWallClock("2026-09-01 20:27:16")).toISOString(),
    "2026-09-01T20:27:16.000Z",
    "a space-separated wall clock is normalised rather than left for the engine to guess at",
  );

  // The other two callers pass PostgREST's own strings. Touching those would re-introduce the bug
  // one layer down, so an already-zoned value must come back byte-identical.
  for (const zoned of [
    "2026-09-01T10:08:38+00:00",
    "2026-09-01T10:08:38+00",
    "2026-09-01T10:08:38Z",
    "2026-09-01T10:08:38+0300",
    "2026-09-01T10:08:38-05:00",
  ]) {
    assert.equal(utcTaggedWallClock(zoned), zoned, `${zoned} already carries a zone and must be left alone`);
  }

  // Not a date-time at all: returned untouched so the caller's own NaN guard still decides.
  assert.equal(utcTaggedWallClock(""), "", "an empty value is handed back for the caller's guard to reject");
  assert.equal(utcTaggedWallClock("—"), "—", "a placeholder is not a date and must not be dressed up as one");
  assert.equal(
    utcTaggedWallClock("10:08:38"),
    "10:08:38",
    "a bare clock with no date cannot be made into an instant, so it is left as it is",
  );

  // Whitespace is the shape a hand-built template literal arrives in when a field is padded.
  assert.equal(
    utcTaggedWallClock("  2026-09-01T17:17:25  "),
    "2026-09-01T17:17:25Z",
    "a padded value is trimmed before tagging, never passed through with the padding intact",
  );
}
