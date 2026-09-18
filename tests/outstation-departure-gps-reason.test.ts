import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import {
  DEPARTURE_LOCATION_REFUSALS_KEPT,
  DEPARTURE_LOCATION_REFUSAL_REASONS,
  departureRefusalReasonFromBrowserErrorCode,
  isDepartureLocationRefusalReason,
  noGpsLocationText,
  readDepartureLocationRefusalReason,
  readDepartureLocationRefusals,
  withDepartureLocationRefusal,
} from "../src/lib/outstation/departure-location-refusals.ts";
import type { DepartureLocationRefusal } from "../src/lib/outstation/departure-location-refusals.ts";
import { DEPARTURE_PHOTO_NO_GPS_NOTE, approverTripPhotos } from "../src/lib/outstation/trip-evidence-photos.ts";
import type { OutstationDepartureEvidenceMetadata } from "../src/lib/outstation/types.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// No GPS on a departure photo is told to the approver, with its cause in a few words.
//
// Owner, 2026-09-18, on Saad Salama's 1 September departure photo, saved with no position:
// "the system must record the reason". The approver saw only "Location unavailable". The same day
// the owner ruled "Refuse the photo" (#4007): a departure photo with no location is refused at
// capture and nothing is stored. He then chose "Record refused tries": every refusal is saved with
// its time and cause, and the approver reads it where the departure photo would be, in his words:
// "No GPS location because" the cause. Short, the cause only, never a story or a guess.
// ─────────────────────────────────────────────────────────────────────────────

const PHOTOS_COMPONENT = "src/components/outstation/trip-evidence-photos.tsx";
const SERVICE = "src/lib/outstation/service.ts";
const REFUSAL_ROUTE = "app/api/outstation/[id]/departure-photo/location-refusal/route.ts";
const WEB_CARD = "src/components/outstation/departure-photo-card.tsx";
const APP_CAPTURE = "mobile/src/lib/evidence-photo.ts";
const APP_LOCATION = "mobile/src/lib/location.ts";

function read(path: string) {
  return stripComments(readFileSync(path, "utf8"));
}

/** The body of one top-level function, up to the next top-level function. */
function functionSlice(src: string, declaration: string) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = src.slice(start + declaration.length);
  const ends = [rest.indexOf("\nexport "), rest.indexOf("\nasync function "), rest.indexOf("\nfunction ")].filter(
    (i) => i !== -1,
  );
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length);
}

/** Saad Salama's departure metadata as production holds it: no position, no reason. */
function saadDeparture(overrides: Partial<OutstationDepartureEvidenceMetadata> = {}): OutstationDepartureEvidenceMetadata {
  return {
    capturedAt: "2026-09-01T14:30:58.158Z",
    capturedLatitude: null,
    capturedLocationLabel: "Location unavailable",
    capturedLongitude: null,
    distanceFromArrivalKm: null,
    flags: [],
    minutesAfterArrival: 201,
    previousVersions: [],
    source: "live_camera",
    summary: "Departure photo captured distance from the arrival photo unknown, 201 minute(s) after it.",
    version: 1,
    ...overrides,
  };
}

function departurePhoto(
  meta: OutstationDepartureEvidenceMetadata | null,
  path: string | null = "departure/B-119/112.jpg",
  refusals: unknown = [],
) {
  const [, departure] = approverTripPhotos({
    carEvidenceImagePath: "car/B-119/arrival.jpg",
    carEvidenceImageUrl: "https://storage.example/arrival.jpg",
    carEvidenceMetadata: null,
    departureEvidenceImagePath: path,
    departureEvidenceImageUrl: path ? "https://storage.example/departure.jpg" : null,
    departureEvidenceMetadata: meta,
    departureLocationRefusals: refusals,
    employeeRole: "District Manager",
    evidenceGateStatus: "complete",
  });
  return departure;
}

export function runOutstationDepartureGpsReasonTests() {
  // ── Headline: a refused try reaches the approver, with its time and its cause ──────
  const tries: DepartureLocationRefusal[] = [
    { at: "2026-09-18T14:30:00.000Z", reason: "location_off" },
    { at: "2026-09-18T14:34:00.000Z", reason: "timeout" },
  ];
  const owed = departurePhoto(null, null, tries);
  assert.deepEqual(
    owed.refusedTries,
    [
      { at: "2026-09-18T14:30:00.000Z", text: "No GPS location because location was turned off on the phone." },
      { at: "2026-09-18T14:34:00.000Z", text: "No GPS location because the phone found no signal in time." },
    ],
    "each refused departure photo reaches the approver, where the photo would be, with its time and cause",
  );
  assert.equal(owed.missingNote, "No departure photo has been taken.", "and the missing photo is still said");
  const [arrivalWithTries] = approverTripPhotos({ departureLocationRefusals: tries });
  assert.deepEqual(arrivalWithTries.refusedTries, [], "the arrival photo never carries the departure tries");

  // ── The words: the owner's own shape, short, and never a code ─────────────────────
  for (const reason of DEPARTURE_LOCATION_REFUSAL_REASONS) {
    const words = noGpsLocationText(reason);
    assert.match(words, /^No GPS location[ .]/, `${reason}: starts with "No GPS location", the owner's words`);
    assert.ok(words.length <= 70, `${reason}: short, the cause only (${words.length} characters): ${words}`);
    assert.ok(!words.includes("_"), `${reason}: never shows a code: ${words}`);
  }
  assert.equal(
    noGpsLocationText("not_reported"),
    "No GPS location. The phone did not report why.",
    "with no cause reported it says so, never a guessed cause",
  );

  // ── Saad Salama's photo on file: no refused try, no cause, the same short note ────
  const saad = departurePhoto(saadDeparture());
  assert.equal(saad.gpsMissingReason, DEPARTURE_PHOTO_NO_GPS_NOTE, "a photo on file with no position says there is no GPS");
  assert.equal(saad.locationLabel, null, "and not the bare 'Location unavailable' beside it");
  assert.ok(saad.url, "the photo itself is still shown");
  assert.deepEqual(saad.refusedTries, [], "and nothing was recorded for it, so no try is invented");
  assert.equal(
    DEPARTURE_PHOTO_NO_GPS_NOTE,
    "No GPS location. The phone did not report why.",
    "the note is the fact and its cause only, never a story or a guessed cause",
  );

  // "No position" is the domain's own: half a pair and the old failed-fix 0,0 count too.
  assert.equal(
    departurePhoto(saadDeparture({ capturedLatitude: 0, capturedLongitude: 0 })).gpsMissingReason,
    DEPARTURE_PHOTO_NO_GPS_NOTE,
    "a photo stored at exactly 0,0 (the old failed-fix marker) has no GPS",
  );
  assert.equal(
    departurePhoto(saadDeparture({ capturedLatitude: 31.2 })).gpsMissingReason,
    DEPARTURE_PHOTO_NO_GPS_NOTE,
    "half a pair is no position",
  );

  // A photo WITH a position carries no note and keeps its place; its earlier tries still show.
  const fixed = departurePhoto(
    saadDeparture({ capturedLatitude: 31.2, capturedLocationLabel: "Mahatet El Raml, Alexandria", capturedLongitude: 29.9 }),
    "departure/B-119/112.jpg",
    tries,
  );
  assert.equal(fixed.gpsMissingReason, null, "a photo with a position has no missing-GPS note");
  assert.equal(fixed.locationLabel, "Mahatet El Raml, Alexandria", "and keeps its place label");
  assert.equal(fixed.refusedTries.length, 2, "the tries refused before it are still on the record");

  // No photo, no note: a missing photo is its own note, not a GPS problem.
  assert.equal(departurePhoto(null, null).gpsMissingReason, null, "no departure photo means no GPS note");
  const [arrival] = approverTripPhotos({ departureEvidenceMetadata: saadDeparture() });
  assert.equal(arrival.gpsMissingReason, null, "the arrival photo never carries the departure note");

  // ── The stored list: read defensively, capped, never a guessed cause ──────────────
  assert.deepEqual(readDepartureLocationRefusals(undefined), [], "a row from before the column reads as no tries");
  assert.deepEqual(readDepartureLocationRefusals("not json"), [], "a bad value reads as no tries");
  assert.deepEqual(
    readDepartureLocationRefusals([
      { at: "2026-09-18T14:30:00.000Z", reason: "timeout" },
      { at: "yesterday-ish", reason: "timeout" },
      { reason: "timeout" },
      null,
      "timeout",
      { at: "2026-09-18T14:40:00.000Z", reason: "gremlins" },
    ]),
    [
      { at: "2026-09-18T14:30:00.000Z", reason: "timeout" },
      { at: "2026-09-18T14:40:00.000Z", reason: "not_reported" },
    ],
    "an entry without a real time is dropped, and an unknown cause is 'not reported', never passed through",
  );
  assert.deepEqual(
    readDepartureLocationRefusals(JSON.stringify(tries)),
    tries,
    "a list stored as JSON text reads the same",
  );
  let list: DepartureLocationRefusal[] = [];
  for (let minute = 0; minute < DEPARTURE_LOCATION_REFUSALS_KEPT + 5; minute += 1) {
    list = withDepartureLocationRefusal(list, {
      at: new Date(Date.UTC(2026, 8, 18, 14, minute)).toISOString(),
      reason: "timeout",
    });
  }
  assert.equal(list.length, DEPARTURE_LOCATION_REFUSALS_KEPT, "retrying in a dead spot never grows the row past the cap");
  assert.equal(list[list.length - 1]?.at, "2026-09-18T14:24:00.000Z", "the newest try is kept");
  assert.equal(list[0]?.at, "2026-09-18T14:05:00.000Z", "and the oldest are the ones dropped");

  // ── Causes as the clients report them ──────────────────────────────────────────────
  assert.equal(departureRefusalReasonFromBrowserErrorCode(1), "permission_denied", "browser code 1 is PERMISSION_DENIED");
  assert.equal(departureRefusalReasonFromBrowserErrorCode(2), "position_unavailable", "browser code 2 is POSITION_UNAVAILABLE");
  assert.equal(departureRefusalReasonFromBrowserErrorCode(3), "timeout", "browser code 3 is TIMEOUT");
  assert.equal(readDepartureLocationRefusalReason("location_off"), "location_off", "a known code is kept");
  assert.equal(readDepartureLocationRefusalReason(undefined), "not_reported", "no code is 'not reported'");
  assert.equal(readDepartureLocationRefusalReason("DROP TABLE"), "not_reported", "an unknown code is never stored as sent");

  // The Android app cannot import the server's list, so every code it can send is pinned to it.
  const appLocation = read(APP_LOCATION);
  const appCapture = read(APP_CAPTURE);
  const unavailableUnion = /export type LocationUnavailableReason =([^;]+);/.exec(appLocation);
  const tryReasonUnion = /function refusedTryReason\([^)]*\):([^{]+)\{/.exec(appCapture);
  assert.ok(unavailableUnion, "the app names why it has no reading");
  assert.ok(tryReasonUnion, "the app names the cause it reports for a refused try");
  const appCodes = [...`${unavailableUnion[1]}${tryReasonUnion[1]}`.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(appCodes.length >= 4, `expected the app's cause codes, found ${appCodes.length}`);
  for (const code of appCodes) {
    assert.ok(isDepartureLocationRefusalReason(code), `the app sends "${code}", which the server must know`);
  }

  // ── Every client reports the try BEFORE it shows the refusal ──────────────────────
  const card = read(WEB_CARD);
  const cardReportAt = card.indexOf("if (!fix) await reportRefusedTry(request.id,");
  const cardRefusalAt = card.indexOf("if (!fix) throw new Error(DEPARTURE_PHOTO_LOCATION_REQUIRED_MESSAGE);");
  assert.notEqual(cardReportAt, -1, "the web card reports a refused try");
  assert.ok(cardReportAt < cardRefusalAt, "and does so before it refuses");
  assert.match(
    functionSlice(card, "async function reportRefusedTry"),
    /fetch\(`\/api\/outstation\/\$\{requestId\}\/departure-photo\/location-refusal`/,
    "the web card reports to the refusal route",
  );
  assert.match(
    card,
    /\(error\) => resolve\(\{ position: null, reason: departureRefusalReasonFromBrowserErrorCode\(error\.code\) \}\)/,
    "the web card's cause is the browser's own error code",
  );

  assert.match(
    appCapture,
    /if \(!access\.granted\) return \{ message: await refuseWithoutLocation\(requestId, token, access, null\), status: "failed" \};/,
    "the app reports a refused try when location is not allowed",
  );
  assert.match(
    appCapture,
    /if \(fix\.status !== "fixed"\) return \{ message: await refuseWithoutLocation\(requestId, token, access, fix\), status: "failed" \};/,
    "the app reports a refused try when there is no fix",
  );
  assert.match(
    functionSlice(appCapture, "async function refuseWithoutLocation"),
    /`\/api\/outstation\/\$\{requestId\}\/departure-photo\/location-refusal`/,
    "the app reports to the refusal route",
  );

  // The service records one from an older app that still sends a photo without a position.
  const service = read(SERVICE);
  const capture = functionSlice(service, "export async function captureOutstationDeparturePhoto");
  const recordAt = capture.indexOf("await appendDepartureLocationRefusal(request, \"not_reported\");");
  assert.notEqual(recordAt, -1, "the capture records a refused try an older app sends");
  assert.ok(
    recordAt < capture.indexOf("departurePhotoLocationRefusal(input.latitude, input.longitude)"),
    "and records it before it refuses",
  );
  const record = functionSlice(service, "export async function recordOutstationDepartureLocationRefusal");
  assert.match(
    record,
    /if \(!ownsRequest\) \{\s*await assertOutstationAdminAccess\(access, "approve"\);\s*\}[\s\S]*appendDepartureLocationRefusal\(/,
    "only the employee's own request, or an outstation admin, can record a try, as for the photo itself",
  );
  assert.match(
    functionSlice(service, "async function appendDepartureLocationRefusal"),
    /\} catch \(error\) \{\s*logError\(/,
    "recording is best effort: a failed write is logged, never shown to the employee in place of the refusal",
  );
  assert.match(
    functionSlice(service, "function mapOutstationRequestRow"),
    /departureLocationRefusals: readDepartureLocationRefusals\(row\.departure_location_refusals\)/,
    "every request read carries its refused tries",
  );

  const route = read(REFUSAL_ROUTE);
  assert.match(route, /assertSameOriginMutation\(request\)/, "the refusal route checks the origin");
  assert.match(route, /assertPermission\(access, "outstation", "create"\)/, "and the outstation permission");
  assert.match(
    route,
    /reason: readDepartureLocationRefusalReason\(body\?\.reason\)/,
    "and stores only a known cause",
  );

  const migration = readdirSync("supabase/migrations").find((name) =>
    name.endsWith("_outstation_departure_location_refusals.sql"),
  );
  assert.ok(migration && existsSync(`supabase/migrations/${migration}`), "the column has its migration");
  assert.match(
    readFileSync(`supabase/migrations/${migration}`, "utf8"),
    /add column if not exists departure_location_refusals jsonb not null default '\[\]'::jsonb/,
    "the column starts empty on every request",
  );

  // ── Both approver screens render it (they share one component) ───────────────────
  const component = read(PHOTOS_COMPONENT);
  assert.match(component, /\{photo\.gpsMissingReason\}/, "the photo component shows the missing-GPS note");
  assert.match(
    component,
    /photo\.refusedTries\.map\([\s\S]*?Tried \{formatDateTimeValue\(refusedTry\.at\)\}: \{refusedTry\.text\}/,
    "the photo component shows each refused try with its time, in Cairo",
  );
}
