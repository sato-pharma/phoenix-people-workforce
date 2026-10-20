import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  FAR_VISIT_REFUSAL_FROM_DAY,
  farVisitRefusalApplies,
  PLACE_MAX_ACCURACY_METERS,
  VISIT_AWAY_FROM_PLACE,
  VISIT_FAR_FROM_PLACE_DEFAULT_METERS,
  validatedPlaceAnchor,
  visitAwayFromValidatedPlace,
  type ValidatedPlaceReading,
} from "../src/lib/phoenix-crm/entry-rules.ts";
import { distanceMeters } from "../src/lib/phoenix-crm/geo.ts";
import { parseRefusedReason, refusalSentence } from "../src/lib/phoenix-crm/refused-readings-rules.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A medical rep's visit logged more than 300 m from the customer's validated photograph is REFUSED
// (owner, 2026-10-20: "MAKE THE SYSTEM NOT ACCEPT MEDICAL REPS VISITS LOGGED AWAYS FROM THE VALIDATED
// PICTURE OF THE CUSTOMER WITH MAXIMUM 300 M APPART").
//
// Until that day the same 300 m line (`visit_far_meters`) only flagged a visit silently for the
// managers. Measured on production for 6-19 October 2026: 97 of 2,558 measurable rep visits (3.8%)
// sat past it, 38 more than a kilometre out, and not one of them was within its own reading's radius.
//
// What this pins:
//   · the rule — the nearest validated place decides, the photograph is the anchor when its reading is
//     sharp, the place's own point when it is not, and no place means nothing to be away from;
//   · the door — only the REP's own save is asked, and it is asked before the recording is claimed and
//     before anything is written, with the refused attempt kept for the SFE's board;
//   · the words — the rep reads about his own work, never the line, his metres or a check.
// ─────────────────────────────────────────────────────────────────────────────

/** A clinic door in Benha, and points due north of it at known distances. */
const DOOR = { lat: 30.4657861755584, lon: 31.1863753029889 };
/** One degree of latitude is ~111,195 m on the haversine sphere this module uses. */
function north(metres: number): { lat: number; lon: number } {
  return { lat: DOOR.lat + metres / 111_195, lon: DOOR.lon };
}

function place(overrides: Partial<ValidatedPlaceReading> = {}): ValidatedPlaceReading {
  return { id: "p1", lat: DOOR.lat, lon: DOOR.lon, photoLat: DOOR.lat, photoLon: DOOR.lon, photoAccuracyMeters: 12, ...overrides };
}

function read(file: string): string {
  // CRLF on this laptop, LF on the runner: normalise so a line-based read means the same on both.
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** The body of one exported function, from its signature to the closing brace at column zero. */
function functionBody(source: string, signature: RegExp): string {
  const start = source.search(signature);
  assert.ok(start >= 0, `the function ${signature} is still in the file`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `the function ${signature} still closes at column zero`);
  return source.slice(start, end);
}

export function runPhoenixCrmVisitFarRefusalTests() {
  // ── 1 · The rule ──────────────────────────────────────────────────────────────────────────────
  const verdict = (at: { lat: number; lon: number }, places: ValidatedPlaceReading[], farMeters = 300) =>
    visitAwayFromValidatedPlace({ fix: at, places, farMeters });

  // The geometry the rest of this file leans on, measured rather than assumed.
  assert.ok(Math.abs(distanceMeters(DOOR, north(290)) - 290) <= 1, "north(290) is 290 m from the door");
  assert.ok(Math.abs(distanceMeters(DOOR, north(310)) - 310) <= 1, "north(310) is 310 m from the door");

  assert.equal(verdict(DOOR, [place()]).refused, false, "a visit at the door is accepted");
  assert.equal(verdict(north(290), [place()]).refused, false, "290 m from the validated photo is inside the line");
  assert.equal(verdict(north(310), [place()]).refused, true, "🔴 310 m from the validated photo is refused — the owner's 300 m maximum");
  assert.equal(verdict(north(5_000), [place()]).refused, true, "and so is a visit across town");
  assert.equal(verdict(north(300), [place()]).refused, false, "exactly on the line is still inside it: the maximum is 300 m, not under 300 m");

  const far = verdict(north(1_200), [place()]);
  assert.ok(far.metres !== null && Math.abs(far.metres - 1_200) <= 2, `the verdict carries the metres for the SFE (${far.metres})`);
  assert.equal(far.placeId, "p1", "and the place they were measured to");
  assert.equal(far.farMeters, 300, "and the line it was refused against");

  // No validated place — a pharmacy, or a customer still waiting for one — has nothing to be away from.
  const none = verdict(north(5_000), []);
  assert.deepEqual([none.refused, none.metres, none.placeId], [false, null, null], "a customer with no validated place is never refused");

  // The NEAREST place decides: a customer with two clinics is at whichever door the rep stood at.
  const twoClinics = [place({ id: "across-town", lat: north(8_000).lat, photoLat: north(8_000).lat }), place({ id: "here" })];
  const atSecond = verdict(north(40), twoClinics);
  assert.equal(atSecond.refused, false, "a visit at the customer's second clinic is accepted");
  assert.equal(atSecond.placeId, "here", "and is measured to the clinic he stood at");

  // 🔴 THE PHOTOGRAPH IS THE ANCHOR — but only a sharp one. A place validates on its PIN since
  // 2026-10-11, so a photograph's raw reading can be an iPhone's approximate 2,000 m blur a kilometre off.
  const blurredPhoto = place({ photoLat: north(1_500).lat, photoAccuracyMeters: 2_000 });
  assert.deepEqual(validatedPlaceAnchor(blurredPhoto), { lat: DOOR.lat, lon: DOOR.lon }, "a photograph reading wider than the place's line falls back to the place's own validated point");
  assert.equal(verdict(DOOR, [blurredPhoto]).refused, false, "🔴 so an honest rep at the door is never refused against a blurred photograph");
  const sharpPhotoAway = place({ lat: north(1_000).lat, photoAccuracyMeters: PLACE_MAX_ACCURACY_METERS });
  assert.deepEqual(validatedPlaceAnchor(sharpPhotoAway), { lat: DOOR.lat, lon: DOOR.lon }, "a photograph reading within the place's line IS the anchor, over the point");
  assert.equal(verdict(north(1_000), [sharpPhotoAway]).refused, true, "and the visit is measured against the photograph, not the point");
  const unknownAccuracy = place({ lat: north(1_000).lat, photoAccuracyMeters: null });
  assert.deepEqual(validatedPlaceAnchor(unknownAccuracy), { lat: DOOR.lat, lon: DOOR.lon }, "a photograph whose phone reported no accuracy still anchors, as every door in this module takes an unknown accuracy");
  const noPhotoFix = place({ photoLat: null, photoLon: null, photoAccuracyMeters: null, lat: north(20).lat });
  assert.deepEqual(validatedPlaceAnchor(noPhotoFix), { lat: north(20).lat, lon: DOOR.lon }, "a place whose photograph carries no reading — a seat in a polyclinic — anchors on its point");
  assert.equal(validatedPlaceAnchor(place({ lat: Number.NaN, lon: Number.NaN, photoLat: null, photoLon: null })), null, "and a place with no usable reading at all anchors nothing");
  assert.equal(verdict(north(5_000), [place({ lat: Number.NaN, lon: Number.NaN, photoLat: null, photoLon: null })]).refused, false, "which refuses nobody");

  // The line is the module's own setting, with the owner's 300 m behind anything that is not a distance.
  assert.equal(VISIT_FAR_FROM_PLACE_DEFAULT_METERS, 300, "the owner's maximum");
  assert.equal(verdict(north(310), [place()], 500).refused, false, "the line follows `visit_far_meters`, read live");
  assert.equal(verdict(north(310), [place()], Number.NaN).refused, true, "and a setting that is not a distance falls back to 300 m");
  assert.equal(verdict(north(310), [place()], 0).refused, true, "nor does a zero line refuse every visit at the door");
  assert.equal(verdict({ lat: Number.NaN, lon: Number.NaN }, [place()]).refused, false, "a fix that is not a coordinate is the reading door's refusal, never this one");

  // 🔴 It starts on 20 October 2026 and never reaches back (owner, 2026-10-20: "do not refuse historical
  // — start from today this rule").
  assert.equal(FAR_VISIT_REFUSAL_FROM_DAY, "2026-10-20", "the day the owner ruled");
  assert.equal(farVisitRefusalApplies("2026-10-19"), false, "🔴 a visit captured the day before the rule is never refused, whenever it arrives");
  assert.equal(farVisitRefusalApplies("2026-10-01"), false, "nor any earlier one");
  assert.equal(farVisitRefusalApplies("2026-10-20"), true, "the rule's own day is the first it applies to");
  assert.equal(farVisitRefusalApplies("2026-11-03"), true, "and every day after it");
  assert.equal(farVisitRefusalApplies(""), false, "a day that is not a day applies nothing");
  assert.equal(farVisitRefusalApplies("20/10/2026"), false, "nor a day in another shape");

  // ── 2 · The words the rep reads ────────────────────────────────────────────────────────────────
  // His own work — be at the customer when you log the call — and never the line, his metres, or the
  // existence of a check (Golden Rule #1, as the owner narrowed it for this one refusal).
  assert.doesNotMatch(VISIT_AWAY_FROM_PLACE, /\d/, "no number: never the line, never his distance");
  assert.doesNotMatch(VISIT_AWAY_FROM_PLACE, /\b(gps|check|checked|flag|flagged|integrity|distance|metres|meters|far|photo|picture|validated)\b/i, "and no word for the check");
  assert.match(VISIT_AWAY_FROM_PLACE, /only at the customer's place/, "it says what to do: log the visit at the customer's place");
  assert.match(VISIT_AWAY_FROM_PLACE, /tap Log visit again/, "and it is never a dead end for a rep who IS there");

  // ── 3 · The door: only the rep's own save, before anything is written ─────────────────────────
  const visits = stripComments(read("src/lib/phoenix-crm/server/visits.ts"));
  const saveVisit = functionBody(visits, /export async function saveVisit\(/);
  const ruleAt = saveVisit.indexOf("visitAwayFromValidatedPlace(");
  assert.ok(ruleAt > 0, "saveVisit asks the rule");
  const guard = saveVisit.lastIndexOf('if (enteredAs === "rep" && farVisitRefusalApplies(captureDay)) {', ruleAt);
  assert.ok(guard > 0 && ruleAt - guard < 200, "🔴 only the REP's own save is asked, and only for a visit captured from 2026-10-20 on — a manager's visit and an older one still save");
  // 🔴 "Do not refuse historical — start from today this rule" (owner, 2026-10-20): the day judged is the
  // day the visit was CAPTURED, exactly as the save dates it — the offline anchor, else the photo slot.
  assert.match(
    saveVisit,
    /const captureDay = cairoBusinessDay\(new Date\(offlineCapturedAt \?\? issuedAt \?\? Date\.now\(\)\)\);/,
    "the rule asks the day the visit was captured, never the day it happened to arrive",
  );
  assert.ok(saveVisit.indexOf("const captureDay =") < guard, "and asks it before the guard reads it");
  const recordAt = saveVisit.indexOf("await recordFarVisitRefusal(", ruleAt);
  const throwAt = saveVisit.indexOf("throw validationError(VISIT_AWAY_FROM_PLACE)", ruleAt);
  assert.ok(recordAt > ruleAt && throwAt > recordAt, "the refused attempt is kept for the SFE's board, then the rep reads his refusal");
  const claimAt = saveVisit.indexOf("claimRequiredRecording(");
  const saveRpcAt = saveVisit.indexOf('"phoenix_crm_save_visit"');
  assert.ok(claimAt > throwAt, "🔴 refused BEFORE a required recording is claimed, so a refused visit never spends it");
  assert.ok(saveRpcAt > throwAt, "🔴 and before the save writes anything — no row, no notice");
  assert.match(saveVisit, /\.select\("id, lat, lon, photo_lat, photo_lon, photo_accuracy_meters"\)/, "the place read carries the photograph's own reading, which is what the visit is measured against");
  assert.match(saveVisit, /farMeters: settings\.visitFarMeters/, "the line is the module's setting, the same figure the flag and the board use");

  // The manager's own single visits never reach this door at all: they are filed through their own path.
  const ownVisitAt = saveVisit.indexOf("fileAsOwnSingleVisit(");
  assert.ok(ownVisitAt > 0 && ownVisitAt < ruleAt, "a manager's own single visit on a vacant territory leaves before the rule");

  // ── 4 · The record the SFE reads ───────────────────────────────────────────────────────────────
  const recorderFile = stripComments(read("src/lib/phoenix-crm/server/refused-readings.ts"));
  const recorder = functionBody(recorderFile, /export async function recordFarVisitRefusal\(/);
  assert.match(recorder, /\): Promise<void> \{\n  try \{/, "it returns void and opens in a try — a failed record never costs the rep his refusal message or a 500");
  assert.match(recorder, /reason: "far_from_place"/, "filed under its own reason");
  assert.match(recorder, /subject_kind: "visit"/, "as a visit");
  assert.match(recorder, /distance_meters:/, "with the metres");
  assert.match(recorder, /place_id: input\.placeId/, "and the place they were measured to");
  assert.match(recorder, /max_accuracy_meters: Math\.round\(input\.farMeters\)/, "and the line it was refused against");
  assert.match(recorder, /catch \(error\)/, "and it swallows its own failures");

  assert.equal(parseRefusedReason("far_from_place"), "far_from_place", "the board reads the new reason as itself");
  const sentence = refusalSentence({
    subjectKind: "visit",
    reason: "far_from_place",
    accuracyMeters: 14,
    photoAccuracyMeters: null,
    maxAccuracyMeters: 300,
    blockedPermission: null,
    distanceMeters: 1_234,
  });
  assert.match(sentence, /1\.2 km away from this customer's validated photo/, `the SFE reads the metres (${sentence})`);
  assert.match(sentence, /within 300 m/, "and the line");
  assert.doesNotMatch(sentence, /too rough/, "and never the rough-reading sentence: the reading was good enough to measure");
  const near = refusalSentence({ subjectKind: "visit", reason: "far_from_place", accuracyMeters: 14, photoAccuracyMeters: null, maxAccuracyMeters: 300, blockedPermission: null, distanceMeters: 412 });
  assert.match(near, /412 m away/, "under a kilometre it reads in metres");
  const unknown = refusalSentence({ subjectKind: "visit", reason: "far_from_place", accuracyMeters: 14, photoAccuracyMeters: null, maxAccuracyMeters: 300, blockedPermission: null, distanceMeters: null });
  assert.doesNotMatch(unknown, /\b0 m\b/, "an unknown distance is never printed as 0 m");

  const board = stripComments(read("src/lib/phoenix-crm/server/refused-readings-board.ts"));
  assert.match(board, /max_accuracy_meters, distance_meters, photo_path/, "the board asks the database for the metres, for both readers");
  assert.match(board, /distanceMeters: numberOrNull\(row\.distance_meters\)/, "and reads them back");

  // ── 5 · The table allows it, and only it carries the metres ────────────────────────────────────
  // The newest migration that re-adds the reason CHECK is the one the database holds.
  const migrations = readdirSync(path.join(process.cwd(), "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort();
  const reasonCheckFile = migrations
    .filter((name) => stripSqlComments(read(`supabase/migrations/${name}`)).includes("add constraint phoenix_crm_refused_readings_reason_check"))
    .pop();
  assert.ok(reasonCheckFile, "a migration still defines the reason CHECK");
  const sql = stripSqlComments(read(`supabase/migrations/${reasonCheckFile}`));
  assert.match(sql, /'far_from_place'::text/, "the newest reason CHECK allows far_from_place");
  assert.match(sql, /add column if not exists place_id uuid/, "the place column exists");
  assert.match(sql, /add column if not exists distance_meters integer/, "and the metres column");
  assert.match(
    sql,
    /reason = 'far_from_place'::text\s+or \(place_id is null and distance_meters is null\)/,
    "and no other reason may carry either of them",
  );
}
