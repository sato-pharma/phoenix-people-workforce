import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cairoMidnightUtcIso } from "../src/lib/attendance/timezone.ts";

// The old utcBoundaryForLocalDate (duplicated byte-for-byte in punch-minutes.ts and
// fingerprint-report.ts) built a LOCAL-constructor Date and serialized it — on this repo's
// UTC-only production runtime that produced UTC-midnight of the date string, not Cairo-midnight,
// ~2-3h later than the true boundary. cairoMidnightUtcIso replaces both copies with one
// DST-safe helper.

export function runAttendanceCairoMidnightBoundaryTests() {
  // EEST (summer, Cairo = UTC+3): Cairo midnight of Jul 25 = Jul 24 21:00 UTC.
  assert.equal(cairoMidnightUtcIso("2026-07-25"), "2026-07-24T21:00:00.000Z");
  // EET (winter, Cairo = UTC+2): Cairo midnight of Jan 16 = Jan 15 22:00 UTC.
  assert.equal(cairoMidnightUtcIso("2026-01-16"), "2026-01-15T22:00:00.000Z");

  // dayOffset must be equivalent to asking for the next date directly.
  assert.equal(cairoMidnightUtcIso("2026-07-24", 1), cairoMidnightUtcIso("2026-07-25"));
  assert.equal(cairoMidnightUtcIso("2026-01-15", 1), cairoMidnightUtcIso("2026-01-16"));

  // Fixture-level demonstration of the actual bug this replaces: a real punch at
  // 2026-07-24T22:00:00Z is Cairo 01:00 on Jul 25 (EEST) — genuinely a "Jul 25" punch. The old
  // naive boundary (UTC-midnight of the date string) would have excluded it from a
  // `.gte(cairoBoundary("2026-07-25"))` range query; the fixed boundary correctly includes it.
  const earlyCairoMorningPunch = new Date("2026-07-24T22:00:00Z");
  const oldBuggyBoundary = new Date("2026-07-25T00:00:00.000Z"); // what utcBoundaryForLocalDate used to return
  const fixedBoundary = new Date(cairoMidnightUtcIso("2026-07-25"));
  assert.equal(
    earlyCairoMorningPunch.getTime() >= oldBuggyBoundary.getTime(),
    false,
    "sanity: the old naive boundary would have wrongly excluded this genuinely-Jul-25-Cairo punch",
  );
  assert.equal(
    earlyCairoMorningPunch.getTime() >= fixedBoundary.getTime(),
    true,
    "the fixed Cairo-aware boundary correctly includes this punch in the Jul 25 range",
  );

  // Both call sites must import the shared helper rather than redefining it locally.
  const punchMinutes = readFileSync("src/lib/attendance/punch-minutes.ts", "utf8");
  const fingerprintReport = readFileSync("src/lib/attendance/fingerprint-report.ts", "utf8");
  for (const [name, source] of Object.entries({ "punch-minutes.ts": punchMinutes, "fingerprint-report.ts": fingerprintReport })) {
    assert.match(
      source,
      /import \{ cairoMidnightUtcIso \} from "@\/lib\/attendance\/timezone";/,
      `${name} must import the shared cairoMidnightUtcIso helper`,
    );
    assert.doesNotMatch(
      source,
      /function utcBoundaryForLocalDate/,
      `${name} must not redefine its own local utcBoundaryForLocalDate copy`,
    );
  }
}
