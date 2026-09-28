import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { resolveCaptureTimeliness } from "@/lib/outstation/capture-timeliness";

/**
 * An outstation request's captured coordinate is taken when the traveller FILES, and nothing
 * compares that moment to the trip's dates. File on the day and it is evidence of where you went;
 * file three weeks later and it records where you were standing when you filed.
 *
 * Measured on production 2026-09-28: 23 of 153 requests carry a capture from after the trip ended,
 * 14 of them 8-30 days after. AI-0013 filed four claims on 17 September for trips on 24 Aug, 1 Sep,
 * 6 Sep and 13-17 Sep; all four captured Heliopolis, because that is where she stood that morning.
 * Three therefore carry a 518 km "distance from residence" measured to her filing spot and a
 * "Location match: High" that compares the capture to itself.
 *
 * This flags that and nothing else. The two things it must never become are pinned below: a
 * refusal, and an input to a decision.
 */

export function runOutstationCaptureTimelinessTests() {
  // --- the real production rows ---------------------------------------------------------------

  // AI-0013's four, filed together on 2026-09-17. Three are late; the fourth is the trip she was
  // actually on that morning, and it must NOT be flagged.
  const weaam = [
    { capturedAt: "2026-09-17T04:59:00Z", days: 24, tripEndDate: "2026-08-24", who: "OUTSTATION-150" },
    { capturedAt: "2026-09-17T07:43:00Z", days: 16, tripEndDate: "2026-09-01", who: "OUTSTATION-152" },
    { capturedAt: "2026-09-17T04:54:00Z", days: 11, tripEndDate: "2026-09-06", who: "OUTSTATION-149" },
  ] as const;

  for (const row of weaam) {
    const result = resolveCaptureTimeliness(row);
    assert.equal(result.verdict, "late", `${row.who} was captured after its trip ended`);
    assert.equal(
      result.daysAfterTripEnd,
      row.days,
      `${row.who}: the gap must be counted in whole Cairo days`,
    );
    assert.ok(result.headline, `${row.who} must carry a sentence a reviewer can act on`);
  }

  // 🔴 The fourth. Captured 17 Sep on a trip that ran 13-17 Sep — the SAME day it ended, so it is
  // sound evidence and must be silent. Flagging this one would cry wolf on the honest case.
  const sameDayClose = resolveCaptureTimeliness({
    capturedAt: "2026-09-17T04:45:00Z",
    tripEndDate: "2026-09-17",
  });
  assert.equal(sameDayClose.verdict, "on_trip", "a capture on the trip's last day is ON the trip");
  assert.equal(sameDayClose.headline, null, "the normal case must say nothing at all");
  assert.equal(sameDayClose.daysAfterTripEnd, null, "there is no gap to report");

  // Captured DURING a multi-day trip (OUTSTATION-132: captured 8 Sep, trip 8-10 Sep).
  const midTrip = resolveCaptureTimeliness({
    capturedAt: "2026-09-08T19:15:00Z",
    tripEndDate: "2026-09-10",
  });
  assert.equal(midTrip.verdict, "on_trip", "a capture before the trip ends is on the trip");
  assert.equal(midTrip.headline, null);

  // --- the boundary is the END of the last day, Cairo ------------------------------------------

  // 21:30 UTC on 23 Sep is 00:30 Cairo on the 24th — the day AFTER. Reading this in UTC would call
  // it on-trip and the flag would miss a whole class of late evening filings.
  const justOver = resolveCaptureTimeliness({
    capturedAt: "2026-09-23T21:30:00Z",
    tripEndDate: "2026-09-23",
  });
  assert.equal(justOver.verdict, "late", "the day must be read in Africa/Cairo, not UTC");
  assert.equal(justOver.daysAfterTripEnd, 1);
  assert.ok(
    justOver.headline?.includes("1 day after"),
    "one day is singular — '1 days' reads like a bug and undermines the sentence",
  );

  const twoDays = resolveCaptureTimeliness({
    capturedAt: "2026-09-25T09:00:00Z",
    tripEndDate: "2026-09-23",
  });
  assert.ok(twoDays.headline?.includes("2 days after"), "more than one day is plural");

  // --- 🔴 it FAILS OPEN, exactly as isWithinDepartureWindow does -------------------------------

  // A gap in OUR data must never surface as a warning about a person.
  for (const [input, why] of [
    [{ capturedAt: null, tripEndDate: "2026-09-23" }, "no capture recorded"],
    [{ capturedAt: "2026-09-25T09:00:00Z", tripEndDate: null }, "no trip end recorded"],
    [{ capturedAt: "not-a-date", tripEndDate: "2026-09-23" }, "an unreadable capture"],
    [{ capturedAt: "2026-09-25T09:00:00Z", tripEndDate: "whenever" }, "an unreadable trip end"],
    [{ capturedAt: undefined, tripEndDate: undefined }, "neither side"],
  ] as const) {
    const result = resolveCaptureTimeliness(input);
    assert.equal(result.verdict, "unknown", `${why} must be "unknown", never "late"`);
    assert.equal(result.headline, null, `${why} must produce no warning about a person`);
    assert.equal(result.daysAfterTripEnd, null, `${why} must report no gap`);
  }

  // --- the wording is neutral ------------------------------------------------------------------

  const late = resolveCaptureTimeliness({ capturedAt: "2026-09-17T04:59:00Z", tripEndDate: "2026-08-24" });
  const headline = late.headline ?? "";

  assert.ok(
    headline.includes("where the request was filed, not where the trip went"),
    "the sentence must say what the coordinate DOES record, not merely that it is late",
  );
  assert.ok(
    headline.includes("Filing late is not itself a problem"),
    "a late filing is ordinary — the sentence must not let a reviewer read it as misconduct",
  );
  // 🔴 A late capture says the coordinate cannot corroborate the trip. It says NOTHING about
  // whether the trip happened, and an approver must never be nudged into reading it that way.
  for (const word of ["fraud", "suspicious", "false", "fake", "dishonest", "did not travel", "reject"]) {
    assert.ok(
      !headline.toLowerCase().includes(word),
      `the sentence must not contain "${word}" — it reports evidence quality, never a verdict`,
    );
  }

  // --- 🔴 it must never refuse, and never reach a decision --------------------------------------

  const source = readFileSync(
    new URL("../src/lib/outstation/capture-timeliness.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/\bthrow\b/.test(source),
    "capture-timeliness must never throw — the house rule on this evidence is to flag, never block",
  );

  // The module is pure: no database, no clock, no CRM. A caller supplies both sides.
  for (const forbidden of ["getSupabaseAdmin", "supabase", "fetch(", "Date.now()"]) {
    assert.ok(
      !source.includes(forbidden),
      `capture-timeliness must stay pure — found ${forbidden}`,
    );
  }

  // 🔴 The verdict must reach the REVIEWER and nothing else. workload-freshness.ts refused the same
  // widening because "quietly swapping a live read underneath a live rejection rule would change
  // outstation money with nobody asking for it"; the same applies here.
  const decision = readFileSync(
    new URL("../src/lib/outstation/decision.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !decision.includes("capture-timeliness") && !decision.includes("resolveCaptureTimeliness"),
    "the decision engine must NOT read capture timeliness — this flags an expense, it never decides one",
  );

  const admin = readFileSync(
    new URL("../src/components/outstation/outstation-requests-admin.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    admin.includes("resolveCaptureTimeliness({"),
    "the reviewer's panel must CALL it — asserting on the bare name matches the import line, so "
      + "the check would pass with the banner deleted",
  );
  assert.ok(
    admin.includes("Location captured after the trip ended"),
    "the banner must name the condition in words, not just tint a field",
  );
  // The panel portals to document.body, outside .admin-shell, so globals.css cannot zero a radius
  // here — the square-edge golden rule has to be written into the class.
  assert.ok(
    /rounded-none border border-amber-300 bg-amber-50/.test(admin),
    "the banner must be square-edged: a portalled component gets no radius reset from globals.css",
  );
}
