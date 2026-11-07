import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sharedPlaceKeys } from "../src/lib/crm/visit-workload.ts";
import { foldRepeatCheckins, routeTripDay, type RouteCheckinRow } from "../src/lib/outstation/route-checkins.ts";

// AN OUTSTATION TRIP'S ROUTE IS THE PLACES, NOT THE PHONE'S TAPS — AND A BORROWED ROUTE IS ONLY THE
// STOPS THAT WERE SHARED (owner, 2026-11-07). Saad Salama's 6 Sep Alexandria claim listed 35 check-ins
// for 16 places: the rep's phone had saved five taps at one doctor inside four seconds. Sally Saied's
// 20 Sep Damietta claim drew all 21 of her rep's check-ins across Talkha and Mansoura as Sally's route,
// though the rep had tagged her on two visits; Sally's own six visits in New Damietta had no GPS at all.

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function checkin(at: string, extra: Partial<RouteCheckinRow> = {}): RouteCheckinRow {
  return { address: null, at, contact: "Dr. Hany Samir", contactCrmId: 106601, lat: 31.2001, lon: 29.9187, via: "Yassin Khalifa", ...extra };
}

export function runOutstationRouteCheckinsTests() {
  // 1. Saad's five taps at one doctor in four seconds are ONE stop, carrying the tap count.
  const taps = foldRepeatCheckins([
    checkin("2026-09-06T09:13:16"),
    checkin("2026-09-06T09:13:17"),
    checkin("2026-09-06T09:13:18"),
    checkin("2026-09-06T09:13:19"),
    checkin("2026-09-06T09:13:20"),
    checkin("2026-09-06T09:40:02", { contact: "El Shefa Pharmacy", contactCrmId: 220410 }),
  ]);
  assert.equal(taps.length, 2, "HEADLINE: five taps at one place inside four seconds are one stop on the route");
  assert.equal(taps[0].taps, 5, "and the stop says how many taps the phone saved");
  assert.equal(taps[0].at, "2026-09-06T09:13:16", "the stop keeps the time of the first tap");
  assert.equal(taps[1].taps, 1, "the next place is its own stop");

  // 2. The same place again outside the window is a second visit, never folded into the first.
  const revisit = foldRepeatCheckins([checkin("2026-09-06 09:13:16"), checkin("2026-09-06 09:16:00")]);
  assert.equal(revisit.length, 2, "a tap three minutes later at the same doctor is a separate check-in");
  // The window is measured from the group's FIRST tap, so a steady tapper cannot chain a stop forever.
  const chained = foldRepeatCheckins([
    checkin("2026-09-06T10:00:00"),
    checkin("2026-09-06T10:01:30"),
    checkin("2026-09-06T10:03:00"),
  ]);
  assert.deepEqual(chained.map((row) => row.taps), [2, 1], "the 120-second window counts from the stop's first tap");
  // Different reps at the same place are two people's check-ins, never one.
  const twoReps = foldRepeatCheckins([checkin("2026-09-06T10:00:00"), checkin("2026-09-06T10:00:05", { via: null })]);
  assert.equal(twoReps.length, 2, "a borrowed check-in and the person's own are never folded together");
  // With no contact, the place is the GPS to four decimals.
  const byGps = foldRepeatCheckins([
    checkin("2026-09-06T11:00:00", { contact: null, contactCrmId: null, lat: 31.20011, lon: 29.91871 }),
    checkin("2026-09-06T11:00:03", { contact: null, contactCrmId: null, lat: 31.20013, lon: 29.91874 }),
  ]);
  assert.equal(byGps.length, 1, "a contact-less tap at the same GPS point folds too");

  // 3. Sally's borrowed route: only the stops she was visited at are hers; the rest are counted apart.
  const sally = routeTripDay({
    checkins: [
      checkin("2026-09-20T11:09:00", { contact: "Dr. Mona Talkha", contactCrmId: 1, via: "Batool Rafiq", withoutPerson: true }),
      checkin("2026-09-20T12:08:00", { contact: "Delta Distributors", contactCrmId: 2, via: "Batool Rafiq", withoutPerson: false }),
      checkin("2026-09-20T12:53:00", { contact: "Nile Distributors", contactCrmId: 3, via: "Batool Rafiq", withoutPerson: false }),
      checkin("2026-09-20T16:40:00", { contact: "Dr. Samy Mansoura", contactCrmId: 4, via: "Batool Rafiq", withoutPerson: true }),
      checkin("2026-09-20T18:07:00", { contact: "Dr. Adel Mansoura", contactCrmId: 5, via: "Batool Rafiq", withoutPerson: true }),
    ],
    visits: [
      { kind: "regular", role: "partner" },
      { kind: "regular", role: "partner" },
      ...Array.from({ length: 6 }, () => ({ kind: "regular", role: "agent" })),
    ],
  });
  assert.deepEqual(
    sally.checkins.map((row) => row.contact),
    ["Delta Distributors", "Nile Distributors"],
    "HEADLINE: a borrowed route is only the stops shared with the person, never the rep's whole day",
  );
  assert.deepEqual(sally.hiddenCheckins, [{ count: 3, via: "Batool Rafiq" }], "the rep's other check-ins are counted apart, by rep");
  assert.equal(sally.ownVisitsWithoutGps, 6, "HEADLINE: her own six visits with no GPS check-in are said, never hidden by the rep's route");
  // A check-in that could not be matched either way (no flag) stays on the route.
  const unmatched = routeTripDay({ checkins: [checkin("2026-09-20T12:00:00", { via: "Batool Rafiq" })], visits: [] });
  assert.equal(unmatched.checkins.length, 1, "a borrowed check-in the server could not judge stays on the route");
  // A meeting is not a visit with a missing GPS point.
  const meetingOnly = routeTripDay({ checkins: [], visits: [{ kind: "meeting", role: "agent" }] });
  assert.equal(meetingOnly.ownVisitsWithoutGps, 0, "a recorded meeting is never counted as a visit without GPS");

  // 4. The server matches a borrowed check-in to the shared visits by contact id or name.
  assert.deepEqual(sharedPlaceKeys(106601, " Dr. Hany Samir "), ["id:106601", "n:dr. hany samir"], "matched by the contact's id and its name");
  assert.deepEqual(sharedPlaceKeys(null, null), [], "a check-in naming no place has no key, so it is never judged");
  const reader = source("../src/lib/crm/visit-workload.ts");
  assert.match(reader, /ampm, contact_crm_id, contact_name, crm_save_date,/, "the visit read carries the contact's id to match on");
  assert.match(
    reader,
    /withoutPerson: !places\.some\(\(place\) => sharedPlaces\?\.has\(place\) === true\)/,
    "HEADLINE: a borrowed check-in is flagged when its place is not one the person was visited at",
  );

  // 5. The screens read the route, and the AM/PM tag is the customer's list, never the clock.
  const panel = source("../src/components/outstation/trip-workload-evidence.tsx");
  assert.match(panel, /\.map\(\(day\) => routeTripDay\(day\)\), \[state\.data\]\)/, "HEADLINE: the panel numbers and maps the routed days, memoised on the payload");
  assert.match(panel, /×\{fmt\(checkin\.taps \?\? 1\)\} taps/, "a folded stop says its taps");
  assert.match(panel, /if \(\/\^am\$\/i\.test\(value\)\) return "AM list";/, "HEADLINE: AM reads 'AM list' beside the name");
  assert.doesNotMatch(panel, /\{visit\.ampm \? ` · \$\{visit\.ampm\}` : ""\}/, "and never sits beside the saved time as if it were the clock");
  const review = source("../src/components/outstation/expense-approvals/trip-review.tsx");
  assert.match(review, /sm:columns-2/, "HEADLINE: the map legend reads down its columns");
  assert.doesNotMatch(review, /<ul className="[^"]*grid[^"]*" data-map-legend/, "never a grid, which reads zig-zag");
  assert.match(review, /legendTimeline\(legend, checkins\)/, "the photos, stops and check-ins are one time-ordered list");
}
