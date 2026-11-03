import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { type ValidatedPlaceReading } from "../src/lib/phoenix-crm/entry-rules.ts";
import { refusalSentence } from "../src/lib/phoenix-crm/refused-readings-rules.ts";
import {
  parseSeatedPlaceDraft,
  parseSeatingReading,
  SEATING_AWAY_FROM_BUILDING,
  seatingAwayFromBuilding,
} from "../src/lib/phoenix-crm/shared-place-rules.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A rep seats a customer in a polyclinic only while standing in that building (owner, 3 Nov 2026, chose
// "Refuse at seating", amending his own 2026-10-09 "no location").
//
// Hadeer Abdelnaser Osman Hassan's Dr Farid Shawky was seated in a look-alike building 3.9 km from the door
// they stood at, and from then on the far-visit rule refused every visit at the real door.
//
// What this pins, each on the real coordinates of that afternoon:
//   · the verdict: the far line from the nearer of the building's two door readings, and no reading
//     (or one too rough to say) seats exactly as before;
//   · the doors: both seating paths ask it right after the venue is read and before the timetable scan, the
//     Super Admin's move never does, and a manager validating beside the rep never does;
//   · the record: the attempt names the building for the SFE, and the place row never keeps the reading;
//   · the words: his own work and the way out, never the line, his metres or a check.
// ─────────────────────────────────────────────────────────────────────────────

const FAR_METERS = 300;

/** عيادات الحصري, Hossary Station: the building Dr Farid Shawky was seated in. */
const HOSSARY_STATION: ValidatedPlaceReading = {
  id: "412fb041-0000-4000-8000-000000000000",
  lat: 29.9732,
  lon: 30.9437,
  photoLat: 29.9732,
  photoLon: 30.9437,
  photoAccuracyMeters: 12,
  pinLat: 29.9733,
  pinLon: 30.9436,
  pinAccuracyMeters: 9,
  pointSource: "photo",
};

/** Where Hadeer stood at 15:12 Cairo, on the real door: 3.9 km away. */
const AT_THE_REAL_DOOR = { lat: 29.9561373, lon: 30.9076283, accuracyMeters: 20 };

function bodyOf(file: string, signature: string): string {
  const source = stripComments(readFileSync(file, "utf8"));
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is in ${file}`);
  const end = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, end < 0 ? undefined : end);
}

export function runPhoenixCrmSeatAtBuildingTests() {
  // ── The verdict ────────────────────────────────────────────────────────────────────────────────
  const away = seatingAwayFromBuilding({ building: HOSSARY_STATION, standingAt: AT_THE_REAL_DOOR, farMeters: FAR_METERS });
  assert.equal(away?.refused, true, "🔴 the seating that started this: 3.9 km from the building is refused");
  assert.ok((away?.metres ?? 0) > 3_800 && (away?.metres ?? 0) < 4_100, `and it is measured at about 3.9 km, read ${away?.metres}`);

  const inTheBuilding = seatingAwayFromBuilding({
    building: HOSSARY_STATION,
    standingAt: { lat: 29.9734, lon: 30.9438, accuracyMeters: 15 },
    farMeters: FAR_METERS,
  });
  assert.equal(inTheBuilding?.refused, false, "a rep standing in the building seats as before");

  // The nearer door reading decides, exactly as a visit's does: a rep the seating lets through can log
  // the visit there, because the visit is asked the same question of the same readings.
  const atThePinOnly = seatingAwayFromBuilding({
    building: { ...HOSSARY_STATION, photoLat: 29.99, photoLon: 30.97, photoAccuracyMeters: 40, lat: 29.99, lon: 30.97 },
    standingAt: { lat: 29.9733, lon: 30.9436, accuracyMeters: 10 },
    farMeters: FAR_METERS,
  });
  assert.equal(atThePinOnly?.refused, false, "standing at the building's pin is standing in the building, however far its photograph read");

  assert.equal(
    seatingAwayFromBuilding({ building: HOSSARY_STATION, standingAt: null, farMeters: FAR_METERS }),
    null,
    "🔴 no reading is NOT MEASURED, never a refusal: location off seats as it always did",
  );

  // ── The wire: total, and it refuses nothing ────────────────────────────────────────────────────
  assert.deepEqual(parseSeatingReading(AT_THE_REAL_DOOR), AT_THE_REAL_DOOR, "a good reading is read off the wire");
  assert.equal(parseSeatingReading({ ...AT_THE_REAL_DOOR, accuracyMeters: 2_000 }), null, "an approximate-location phone says nothing about which building he is in");
  assert.equal(parseSeatingReading({ ...AT_THE_REAL_DOOR, accuracyMeters: 500 })?.accuracyMeters, 500, "500 m is the visit's own line, and it is inside it");
  assert.equal(parseSeatingReading({ lat: 51.5, lon: -0.1, accuracyMeters: 5 }), null, "a point outside Egypt is no reading");
  for (const junk of [null, undefined, "here", 7, {}, { lat: "", lon: "" }]) {
    assert.equal(parseSeatingReading(junk), null, `junk (${JSON.stringify(junk)}) is no reading and never a throw`);
  }
  assert.equal(parseSeatingReading({ lat: 29.97, lon: 30.94 })?.accuracyMeters, null, "an unknown accuracy is measured, as a visit's is");

  const draft = {
    sharedPlaceId: "3f4a1b2c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    timings: [{ weekday: 6, start: "10:00" }],
  };
  const noReading = parseSeatedPlaceDraft(draft);
  assert.equal(noReading.ok && noReading.value.standingAt, null, "a body from an older build parses, not measured");
  const withReading = parseSeatedPlaceDraft({ ...draft, standingAt: AT_THE_REAL_DOOR });
  assert.deepEqual(withReading.ok && withReading.value.standingAt, AT_THE_REAL_DOOR, "and the reading travels on the draft");
  const roughReading = parseSeatedPlaceDraft({ ...draft, standingAt: { ...AT_THE_REAL_DOOR, accuracyMeters: 2_000 } });
  assert.equal(roughReading.ok, true, "🔴 a rough reading never costs the seating");

  // ── The words ──────────────────────────────────────────────────────────────────────────────────
  assert.doesNotMatch(SEATING_AWAY_FROM_BUILDING, /\d|\bm\b|metre|meter|check|GPS|far/i, "the rep reads his own work: no line, no metres, no check");
  assert.match(SEATING_AWAY_FROM_BUILDING, /Choose the building you are in/, "and the way out for a rep who tapped the wrong one");
  assert.match(SEATING_AWAY_FROM_BUILDING, /step outside/, "and for an honest rep on a reading that has not settled");

  const sfe = refusalSentence({ subjectKind: "place", reason: "far_from_place", accuracyMeters: 20, photoAccuracyMeters: null, maxAccuracyMeters: 300, blockedPermission: null, distanceMeters: 3_919 });
  assert.match(sfe, /3\.9 km away from the building/, "the SFE reads the metres to the BUILDING");
  assert.doesNotMatch(sfe, /visit/i, "and never the visit's sentence, which is another refusal");
  const visitSentence = refusalSentence({ subjectKind: "visit", reason: "far_from_place", accuracyMeters: 20, photoAccuracyMeters: null, maxAccuracyMeters: 300, blockedPermission: null, distanceMeters: 412 });
  assert.match(visitSentence, /The visit was logged 412 m away/, "a far VISIT still reads as itself");

  // ── The doors ──────────────────────────────────────────────────────────────────────────────────
  const list = "src/lib/phoenix-crm/server/list.ts";
  const validate = bodyOf(list, "export async function validateCustomer(");
  const addPlace = bodyOf(list, "export async function addPlace(");
  for (const [name, door] of [["validateCustomer", validate], ["addPlace", addPlace]] as const) {
    const venueRead = door.indexOf("sharedPlaceForSeating(");
    const asked = door.indexOf("refuseSeatingAwayFromBuilding(");
    assert.ok(venueRead >= 0 && asked > venueRead, `${name} asks right after the venue is read`);
    const scan = door.indexOf("scanSeatedTimetable(");
    assert.ok(scan > asked, `🔴 and ${name} asks before the timetable scan, so a refusal spends no try and replaces no board`);
  }
  assert.match(
    validate,
    /if \(seated && venue && validatedAs === "rep"\) \{\s*await refuseSeatingAwayFromBuilding\(/,
    "🔴 a manager validating beside the rep is not asked, as his own visit is not",
  );

  const refuser = bodyOf(list, "async function refuseSeatingAwayFromBuilding(");
  assert.ok(refuser.indexOf("await recordSeatingAwayRefusal(") < refuser.indexOf("throw validationError(SEATING_AWAY_FROM_BUILDING, SEATING_AWAY_CODE)"), "the attempt is filed before the refusal is raised");

  const move = stripComments(readFileSync("src/lib/phoenix-crm/server/place-move.ts", "utf8"));
  assert.doesNotMatch(move, /seatingAwayFromBuilding|refuseSeatingAwayFromBuilding/, "🔴 the Super Admin's move is never asked: he is not standing in anything");

  // ── The record, and what is never kept ─────────────────────────────────────────────────────────
  const recorder = bodyOf("src/lib/phoenix-crm/server/refused-readings.ts", "export async function recordSeatingAwayRefusal(");
  assert.match(recorder, /subject_kind: "place"/, "filed as a place refused");
  assert.match(recorder, /reason: "far_from_place"/, "under the far reason");
  assert.match(recorder, /shared_place_id: input\.sharedPlaceId/, "naming the building, the one thing a refused seating has no row to say");
  assert.doesNotMatch(recorder, /place_id: input\.placeId/, "and no place: its metres are to the building");

  const check = stripSqlComments(readFileSync("supabase/migrations/20261103154101_phoenix_crm_refused_seating_names_its_building.sql", "utf8"));
  assert.match(check, /reason = 'far_from_place'::text and subject_kind = 'place'::text/, "the table takes that row, and a far VISIT still names no building");

  const counter = bodyOf("src/lib/phoenix-crm/server/refused-readings.ts", "export async function countTimetableRefusals(");
  assert.match(counter, /\.in\("reason", \["timetable_unreadable", "timetable_missing"\]\)/, "🔴 and it can never spend a timetable try, which are counted by their own two reasons");

  const payload = bodyOf("src/lib/phoenix-crm/server/shared-places.ts", "export async function seatedPlacePayload(");
  assert.doesNotMatch(payload, /standingAt|readings/, "🔴 the seated row never keeps the reading: its point is the building's");

  // ── The screen ─────────────────────────────────────────────────────────────────────────────────
  const screens = stripComments(readFileSync("src/components/phoenix-crm/list-screens.tsx", "utf8"));
  assert.equal(screens.split('const readFix = useSilentFix(door === "shared");').length - 1, 2, "both screens read in silence, only on the building door");
  assert.equal(screens.split('const standingAt = door === "shared" ? await readFix() : null;').length - 1, 2, "and both read at Save");
  assert.equal(screens.split("setSeated(chooseTheBuildingAgain(photo));").length - 1, 2, "both send him back to choose the building");
  assert.match(
    screens,
    /function chooseTheBuildingAgain[\s\S]*?sharedPlaceId: null, photo: null,/,
    "🔴 and a photo goes with the choice: it is stamped with that building's name and would replace another's board",
  );
}
