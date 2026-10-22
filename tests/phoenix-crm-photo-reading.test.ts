import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { distanceMeters } from "../src/lib/phoenix-crm/geo.ts";
import {
  COLD_RECEIVER_MS,
  CONTRADICTION_FLOOR_METERS,
  laterReadingOverrules,
  readingsContradict,
  takenCold,
  type CameraReading,
} from "../src/lib/phoenix-crm/photo-reading-rules.ts";
import { PLACE_MAX_ACCURACY_METERS } from "../src/lib/phoenix-crm/entry-rules.ts";
import { MAX_TRAVEL_KMH } from "../src/lib/phoenix-crm/location-integrity.ts";
import {
  CASE_READING_LABELS,
  caseStory,
  oddReadingSentence,
  type CaseStoryInput,
} from "../src/lib/crm-integrity/integrity-case-story.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A COLD FIRST READING NEVER BECOMES THE PHOTO'S (2026-10-22).
//
// Dr Tharwat Milad's clinic in Dishna, validated 20 Oct 2026 at 15:36. The camera's reading put the
// signboard photo in Faw Bahari, 10,070 m west, claiming ±65 m; the pin the same phone took five seconds
// later read Dishna at ±20 m, and the previous rep's two April check-ins at this doctor sit 242 m and
// 273 m from that pin. A receiver just switched on answers first from nearby networks, and the camera
// kept that answer because the shutter's fresh reading replaced it only when it claimed to be sharper.
//
// What this pins:
//   · the rule — two readings contradict past both accuracies (and the floor); a later one overrules a
//     kept one only when the kept one arrived while the receiver was cold, and never otherwise;
//   · the camera — the watch and the shutter both ask it, the stamp then names the reading kept, and
//     the shutter is never held for it;
//   · the warm-up — the receiver is held on while a capture screen is open, never asks for a permission
//     the site does not already have, and every capture screen holds it;
//   · the board — a pin and a photograph further apart than anybody travels in the seconds between
//     them say that one of the two is not where the phone was, the ordinary cause names the phone's
//     first reading, and the place's kept point is never counted as a second witness against the pin.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = new URL("../", import.meta.url);

function code(path: string): string {
  // CRLF on this laptop, LF on the runner: normalise so a line-based read means the same on both.
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

/** The receiver was switched on at this moment, on the page's clock. */
const ON = 1_000_000;
/** Dr Tharwat Milad's place, as stored: the camera's reading and the pin. */
const FAW_BAHARI: CameraReading = { lat: 26.0839274, lon: 32.3733084, accuracyMeters: 65.1, arrivedAt: ON + 2_000 };
const DISHNA: CameraReading = { lat: 26.1208047, lon: 32.465416, accuracyMeters: 20.1, arrivedAt: ON + 7_000 };

/** A point due north of Dishna's pin, at a known distance. One degree of latitude is ~111,195 m. */
function north(metres: number, accuracyMeters: number | null, arrivedAt: number): CameraReading {
  return { lat: DISHNA.lat + metres / 111_195, lon: DISHNA.lon, accuracyMeters, arrivedAt };
}

export function runPhoenixCrmPhotoReadingTests() {
  // ── 1 · The rule ────────────────────────────────────────────────────────────────────────────────
  assert.ok(Math.abs(distanceMeters(FAW_BAHARI, DISHNA) - 10_070) <= 5, "the two stored readings are the 10,070 m the board measured");
  assert.equal(CONTRADICTION_FLOOR_METERS, PLACE_MAX_ACCURACY_METERS, "the floor is the place's own accuracy line, never a second number");
  assert.equal(COLD_RECEIVER_MS, 30_000, "a receiver is cold for its first half minute");

  assert.equal(readingsContradict(FAW_BAHARI, DISHNA), true, "10 km apart on ±65 m and ±20 m cannot both be true");
  assert.equal(readingsContradict(DISHNA, north(200, 10, ON)), false, "🔴 two readings a doorway apart never contradict: the floor, not their accuracies, decides that close");
  assert.equal(readingsContradict(DISHNA, north(260, 10, ON)), true, "past the floor and past both accuracies, they do");
  assert.equal(readingsContradict(DISHNA, north(900, 1_000, ON)), false, "an approximate reading (±1,000 m) 900 m off is inside its own circle: no contradiction");
  assert.equal(readingsContradict(north(0, null, ON), north(260, null, ON)), true, "unknown accuracies count as none, so only the floor protects them");

  assert.equal(takenCold({ arrivedAt: ON + 2_000 }, ON), true, "a reading two seconds after the receiver started is cold");
  assert.equal(takenCold({ arrivedAt: ON + COLD_RECEIVER_MS }, ON), false, "one at the half minute is not");
  assert.equal(takenCold({ arrivedAt: ON + 2_000 }, null), true, "no known start vouches for nothing: cold");
  assert.equal(takenCold({ arrivedAt: Number.NaN }, ON), true, "and a reading with no arrival time is cold");

  // 🔴 THE CASE ITSELF: the camera's cold Faw Bahari reading, overruled by the Dishna reading after it.
  assert.equal(laterReadingOverrules(FAW_BAHARI, DISHNA, ON), true, "🔴 a cold reading a later one contradicts is overruled, whatever accuracy it claimed");
  // The same two readings on a WARM receiver: nothing here decides, and the sharper one stays as before.
  const warmFaw = { ...FAW_BAHARI, arrivedAt: ON + 45_000 };
  assert.equal(laterReadingOverrules(warmFaw, { ...DISHNA, arrivedAt: ON + 50_000 }, ON), false, "🔴 a reading from a warm receiver is never overruled by contradiction — the old rule stands");
  const besideFaw: CameraReading = { lat: FAW_BAHARI.lat + 150 / 111_195, lon: FAW_BAHARI.lon, accuracyMeters: 30, arrivedAt: ON + 7_000 };
  assert.equal(laterReadingOverrules(FAW_BAHARI, besideFaw, ON), false, "a cold reading the later one agrees with stays — there is nothing to overrule");

  // ── 2 · The camera asks it, at the watch and at the shutter ─────────────────────────────────────
  const camera = code("src/components/phoenix-crm/live-photo-capture.tsx");
  assert.match(camera, /if \(laterReadingOverrules\(current, reading, receiverRunningSince\(\)\)\) return reading;/, "the running watch replaces a cold reading the next one contradicts");
  assert.match(camera, /receiverRef\.current = receiverStarted\(\);\s*watchRef\.current = navigator\.geolocation\.watchPosition\(/, "the camera's own watch is registered as it starts");
  assert.match(camera, /function stopLocation\(\) \{[\s\S]{0,200}receiverStopped\(receiverRef\.current\);/, "and unregistered as it stops");
  const takePhoto = camera.slice(camera.indexOf("async function takePhoto"), camera.indexOf("function retake()"));
  const sinceAt = takePhoto.indexOf("const receiverSince = receiverRunningSince();");
  const stopAt = takePhoto.indexOf("stopLocation();");
  assert.ok(sinceAt > 0 && stopAt > sinceAt, "🔴 the receiver's start is read BEFORE the camera's watch stops, or a warm reading would read as cold");
  assert.match(takePhoto, /const shutterOverrules =\s*hasPosition\(shutterFix\) &&\s*!shutterIsSharper &&\s*laterReadingOverrules\(/, "the shutter's fresh reading overrules a cold one it contradicts");
  assert.match(takePhoto, /hasPosition\(shutterFix\) && \(shutterIsSharper \|\| shutterOverrules\)/, "and then becomes the photo's reading");
  assert.match(takePhoto, /const stampFix: Fix = shutterOverrules \? photoFix : usedFix;/, "🔴 the stamp names the overruling reading, so the picture never prints a place the phone never was");
  assert.match(takePhoto, /readEvidenceLocationStamp\(payload, stampFix\.lat, stampFix\.lon, null\)/, "the stamp's place is the stamped reading's");
  assert.match(takePhoto, /locationCapturedAt: stampFix\.at/, "with that reading's own time");
  assert.match(takePhoto, /fix: stampFix,/, "and the photo carries the reading burned into it");
  assert.doesNotMatch(camera, /holdForPreciseFix|await new Promise\(\(resolve\) => setTimeout/, "the shutter is never held waiting for a better reading");

  // ── 3 · The warm-up ───────────────────────────────────────────────────────────────────────────
  const receiver = code("src/components/phoenix-crm/location-receiver.ts");
  assert.match(receiver, /status\.state === "granted"/, "🔴 it starts only where location is ALREADY allowed — never a permission prompt the rep cannot place");
  assert.match(receiver, /if \(holders === 0 \|\| warmWatch !== null\) return;/, "and only once, for as long as a screen still holds it");
  assert.match(receiver, /enableHighAccuracy: true, maximumAge: 0/, "the satellites, never a cached answer");
  assert.doesNotMatch(receiver, /setError|CrmNote|toast|alert\(/, "nothing is ever shown (Golden Rule #1)");
  for (const [path, call] of [
    ["src/components/phoenix-crm/live-photo-capture.tsx", "useLocationWarmUp();"],
    ["src/components/phoenix-crm/capture-location.tsx", "useLocationWarmUp();"],
    ["src/components/phoenix-crm/out-of-list-entry.tsx", "useLocationWarmUp(adding);"],
  ] as const) {
    assert.ok(code(path).includes(call), `${path} holds the receiver warm`);
  }
  const screens = code("src/components/phoenix-crm/list-screens.tsx");
  for (const screen of ["export function ValidateScreen(", "export function AddPlaceScreen("]) {
    const start = screens.indexOf(screen);
    const body = screens.slice(start, screens.indexOf("\nexport function", start + 10));
    assert.ok(start > 0 && body.includes("useLocationWarmUp();"), `${screen} warms the receiver from its first step`);
  }

  // ── 4 · The board tells it as what it was ────────────────────────────────────────────────────────
  // His case as the board loads it: the place's kept point IS the photograph's reading (the point was
  // taken from the photograph), the pin is the door, and the photograph came five seconds first.
  const at = (reading: CameraReading, iso: string) => ({ lat: reading.lat, lon: reading.lon, accuracyMeters: reading.accuracyMeters, atIso: iso });
  const hisCase: CaseStoryInput = {
    source: "capture_trust",
    subjectKind: "place",
    subjectLabel: null,
    strong: true,
    flags: ["photo_pin_disagrees"],
    reasons: ["The photo and the pin are in different parts of the city"],
    repName: "Osama",
    customerName: "Tharwat Milad",
    customerList: "AM",
    customerSpeciality: "General Surgery",
    brickName: null,
    brickDistanceKm: null,
    placeDistanceMeters: null,
    readings: [
      { label: CASE_READING_LABELS.placeCaptured, ...at(FAW_BAHARI, "2026-10-20T12:36:34Z") },
      { label: CASE_READING_LABELS.pin, ...at(DISHNA, "2026-10-20T12:36:39Z") },
      { label: CASE_READING_LABELS.photograph, ...at(FAW_BAHARI, "2026-10-20T12:36:34Z") },
    ],
    nearbyVisits: [],
    spreadMeters: 10_070,
    accuracyMeters: 65.1,
    deviceMocked: null,
    signText: null,
    companionNames: [],
    replayByName: null,
    signals: { gapSeconds: -5, metresApart: 10_070, verdict: "disagrees" },
    photoPath: "phoenix-crm/places/tharwat.jpg",
    visitDate: "2026-10-20",
  };
  const story = caseStory(hisCase);
  const said = (input: CaseStoryInput): string => caseStory(input).headline;
  const impossible = "one of the two is not where the phone was";

  assert.ok(story.headline.includes("10.1 km apart"), `the distance is still the first fact: ${story.headline}`);
  assert.ok(story.headline.includes("only 5 seconds apart"), `🔴 and the five seconds beside it: ${story.headline}`);
  assert.ok(story.headline.includes(impossible), `🔴 10 km in five seconds says that one of the two readings was wrong, not that anybody moved: ${story.headline}`);
  const withGap = (gapSeconds: number, metresApart = 10_070): CaseStoryInput => ({ ...hisCase, signals: { ...hisCase.signals, gapSeconds, metresApart } });
  assert.ok(!said(withGap(3 * 3600)).includes(impossible), "the same 10 km three hours apart is a journey, and says only the distance");
  assert.ok(!said(withGap(60, 2_100)).includes(impossible), "2.1 km in a minute is about 121 km/h after both accuracies — a car does that, so nothing is claimed");
  assert.ok(said(withGap(0)).includes("taken at the same moment"), "no time at all reads as the same moment, never 'less than a second apart'");
  assert.ok(!said({ ...hisCase, signals: { metresApart: 10_070 } }).includes(impossible), "no recorded gap claims nothing");

  // Each reading keeps the accuracy it claimed, and only the distance left over is timed.
  const withAccuracies = (pinAccuracy: number | null, photoAccuracy: number | null, metresApart: number, gapSeconds: number): CaseStoryInput => ({
    ...hisCase,
    readings: hisCase.readings.map((reading) => ({
      ...reading,
      accuracyMeters: reading.label === CASE_READING_LABELS.pin ? pinAccuracy : photoAccuracy,
    })),
    signals: { gapSeconds, metresApart, verdict: "disagrees" },
  });
  assert.ok(!said(withAccuracies(1_050, 1_050, 2_100, 5)).includes(impossible), "🔴 two loose readings whose circles meet could both be true: nothing is claimed");
  assert.ok(!said(withAccuracies(null, 65.1, 10_070, 5)).includes(impossible), "a reading with no accuracy figure grants nothing to time against");
  // The line is the detector's own: 2,500 m in 60 s is exactly 150 km/h and not past it; in 59 s it is.
  assert.equal(MAX_TRAVEL_KMH, 150, "the travel line the detector already uses");
  assert.ok(!said(withAccuracies(0, 0, 2_500, 60)).includes(impossible), "exactly at the travel line is not past it");
  assert.ok(said(withAccuracies(0, 0, 2_500, 59)).includes(impossible), "a second less and it is");
  assert.match(
    code("src/lib/crm-integrity/integrity-case-story.ts"),
    /import \{ MAX_TRAVEL_KMH \} from "@\/lib\/phoenix-crm\/location-integrity";/,
    "the speed is the detector's own constant, never a second number",
  );

  // The ordinary cause names the phone's first reading, and the line reads as sentences.
  const usually = story.story.find((line) => line.startsWith("Usually:")) ?? "";
  assert.ok(usually.includes("before the satellites lock"), `🔴 the ordinary cause is the one that happened here: ${usually}`);
  const twoCauses = caseStory({ ...hisCase, flags: ["photo_pin_disagrees", "photo_pin_gap_long"], reasons: ["far apart", "a long gap"] });
  const twoUsually = twoCauses.story.find((line) => line.startsWith("Usually:")) ?? "";
  assert.ok(!/\.\.|\. and |does this or so does/.test(twoUsually), `two causes read as two sentences, never "these.." or "these. and": ${twoUsually}`);
  assert.ok(twoUsually.includes("and so does a form left open"), `a cause's own ", and" is never rewritten: ${twoUsually}`);

  // 🔴 The place's kept point is the photograph's own reading, so it is never a second witness.
  const odd = oddReadingSentence(hisCase) ?? "";
  assert.ok(odd.includes("the point kept for the place is the photograph's own reading"), `the two "agreeing" readings are one, and the panel says why: ${odd}`);

  for (const line of [...story.story, twoUsually]) {
    assert.ok(!/fraud|cheat|fake|lying|dishonest/i.test(line), `no case accuses anybody: ${line}`);
  }
}
