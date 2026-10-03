import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PLACE_MAX_ACCURACY_METERS,
  VISIT_MAX_ACCURACY_METERS,
  parsePlaceDraft,
  parseVisitDraft,
  refusedReadingOf,
} from "../src/lib/phoenix-crm/entry-rules.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A REFUSED Phoenix CRM capture now leaves its reading behind (owner, 2026-10-03: "record the refused
// readings so the next refusal is traceable").
//
// What it cost not to have it. On Sat 3 Oct 2026 one rep's phone was on Android's APPROXIMATE
// location and reported 30.4684684684685, 31.1899555209043 at exactly 2,000 m — the corner of a 2 km
// privacy square, identical to thirteen decimals across four Benha hospitals, two IP addresses and
// both capture mechanisms. The 100 m place line shipped at 11:24 Cairo, fourteen minutes after her
// last successful save, and from 16:12 to 18:47 she was refused eighteen times. Every one of those
// eighteen readings was DISCARDED: `phoenix_crm_location_integrity` is filed only after a save
// succeeds, no place or visit row is created, and the upload slot keeps only the fact that a slot was
// asked for. Her 2,000 m is knowable at all only because four captures were ACCEPTED that morning,
// before the line existed — and reconstructing it took the slots, the bytes in `storage.objects` and
// an off-line model of Android's grid.
//
// Two rules this must not break:
//   · THE REP LEARNS NOTHING NEW (Golden Rule #1). No message, screen or figure changes, and the
//     recorder is void and never throws — his refusal is identical with or without it.
//   · THE RECORD AND THE REFUSAL CANNOT DISAGREE. `refusedReadingOf` asks the DOORS' own predicates,
//     so a capture the doors accept records nothing and a capture they refuse records something.
// ─────────────────────────────────────────────────────────────────────────────

const CLINIC = { lat: 30.4657861755584, lon: 31.1863753029889 };
/** Android's 2 km blur, as this rep's phone actually reported it. */
const BLURRED = { lat: 30.4684684684685, lon: 31.1899555209043 };
const TIMINGS = [{ weekday: 6, start: "17:00", end: "21:00" }];
const DOCTOR = "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";

function placeBody(pin: number | null, photo: number | null | "none", at = CLINIC) {
  return {
    lat: at.lat,
    lon: at.lon,
    accuracyMeters: pin,
    photoPath: "seat/place.jpg",
    timings: TIMINGS,
    ...(photo === "none" ? {} : { shutterLat: at.lat, shutterLon: at.lon, shutterAccuracyMeters: photo }),
  };
}

function visitBody(accuracyMeters: number | null, extra: Record<string, unknown> = {}) {
  return {
    customerId: DOCTOR,
    kind: "single",
    products: ["Royanoxicam"],
    comment: "Discussed the new concentration.",
    lat: CLINIC.lat,
    lon: CLINIC.lon,
    accuracyMeters,
    ...extra,
  };
}

export function runPhoenixCrmRefusedReadingsTests() {
  // ── 1. The real refusal, recorded ─────────────────────────────────────────────
  // Her actual capture: both readings on the blur grid at 2,000 m.
  const hers = placeBody(2000, 2000, BLURRED);
  assert.equal(parsePlaceDraft(hers).ok, false, "a 2,000 m place is refused — the premise of everything below");
  const recorded = refusedReadingOf(hers, "place");
  assert.ok(recorded, "and its reading is recorded, which is the whole point");
  assert.equal(recorded.reason, "rough");
  assert.equal(recorded.accuracyMeters, 2000, "the number she could not read off her own screen");
  assert.equal(recorded.photoAccuracyMeters, 2000);
  assert.equal(recorded.lat, BLURRED.lat, "to every decimal — the grid proof lives in the last ones");
  assert.equal(recorded.lon, BLURRED.lon);
  assert.equal(recorded.maxAccuracyMeters, PLACE_MAX_ACCURACY_METERS, "the line it missed travels with the reading");

  // ── 2. A capture the doors ACCEPT records nothing ─────────────────────────────
  // The one state that must never produce a row: this table is evidence about refusals.
  for (const [pin, photo] of [
    [null, null],
    [12, 18],
    [PLACE_MAX_ACCURACY_METERS, PLACE_MAX_ACCURACY_METERS],
    [40, "none"],
  ] as const) {
    const body = placeBody(pin, photo);
    assert.equal(parsePlaceDraft(body).ok, true, `a place at ${String(pin)}/${String(photo)} is accepted`);
    assert.equal(refusedReadingOf(body, "place"), null, `so nothing is recorded about it (${String(pin)}/${String(photo)})`);
  }
  for (const accuracy of [null, 12, VISIT_MAX_ACCURACY_METERS]) {
    const body = visitBody(accuracy);
    assert.equal(parseVisitDraft(body).ok, true, `a visit at ${String(accuracy)} is accepted`);
    assert.equal(refusedReadingOf(body, "visit"), null, `so nothing is recorded about it (${String(accuracy)})`);
  }

  // ── 3. A refusal about something ELSE records nothing ─────────────────────────
  // A missing comment is not a location problem, and a table holding every mistyped form is a table
  // nobody reads. Each body below has a PERFECTLY GOOD reading and is still refused.
  for (const [what, body] of [
    ["no comment", visitBody(12, { comment: "   " })],
    ["no products", visitBody(12, { products: [] })],
    ["no customer", visitBody(12, { customerId: "not-a-uuid" })],
  ] as const) {
    assert.equal(parseVisitDraft(body).ok, false, `${what} is refused`);
    assert.equal(refusedReadingOf(body, "visit"), null, `${what} is not a refused READING, so nothing is filed`);
  }
  const noPhoto = { ...placeBody(12, 18), photoPath: "" };
  assert.equal(parsePlaceDraft(noPhoto).ok, false, "a place with no photo is refused");
  assert.equal(refusedReadingOf(noPhoto, "place"), null, "and files nothing: its location was fine");

  // ── 4. No usable coordinate at all ────────────────────────────────────────────
  // Permission off, or no position yet. There is no pin to store — but the accuracy the phone
  // claimed, its clock and the shutter's own pair may each still be readable, and each is worth
  // having: "the phone sent nothing at 16:12" is itself the answer to a support call.
  const blank = refusedReadingOf(
    {
      photoPath: "seat/place.jpg",
      timings: TIMINGS,
      accuracyMeters: 2000,
      deviceCapturedAt: "2026-10-03T15:12:00.000Z",
      deviceMocked: false,
      shutterLat: BLURRED.lat,
      shutterLon: BLURRED.lon,
      shutterAccuracyMeters: 2000,
    },
    "place",
  );
  assert.ok(blank, "a capture with no coordinate is still recorded");
  assert.equal(blank.reason, "no_fix");
  assert.equal(blank.lat, null, "there is no pin to store, and none is invented");
  assert.equal(blank.lon, null);
  assert.equal(blank.accuracyMeters, 2000, "the radius it claimed is kept — it is the only number there is");
  assert.equal(blank.photoAccuracyMeters, 2000, "and the shutter's own, read independently of the pin");
  assert.equal(blank.photoLat, BLURRED.lat);
  assert.equal(blank.deviceMocked, false, "false is a real answer; null would mean 'not asked'");
  assert.equal(blank.deviceCapturedAt, "2026-10-03T15:12:00.000Z");
  // 🔴 Number(null) is 0, which is finite: a missing reading once became a fix at 0°N 0°E and read as
  // impossible travel from the Gulf of Guinea. A blank is a blank here too.
  const empty = refusedReadingOf({ lat: "", lon: "", accuracyMeters: "" }, "visit");
  assert.ok(empty, "an empty body is a refusal with no reading");
  assert.equal(empty.reason, "no_fix");
  assert.deepEqual([empty.lat, empty.lon, empty.accuracyMeters], [null, null, null], "nothing is coerced to 0");

  // ── 5. Each door's own line, and only its own ─────────────────────────────────
  // A place is refused at either reading; a visit is judged on the pin alone, as the doors judge it.
  const roughPhotoOnly = placeBody(40, 2000);
  assert.equal(parsePlaceDraft(roughPhotoOnly).ok, false, "a sharp pin does not rescue a blurred photo");
  const photoCase = refusedReadingOf(roughPhotoOnly, "place");
  assert.ok(photoCase, "and the record says which of the two it was");
  assert.equal(photoCase.accuracyMeters, 40);
  assert.equal(photoCase.photoAccuracyMeters, 2000);

  for (const accuracy of [VISIT_MAX_ACCURACY_METERS + 1, 1414, 2000]) {
    const body = visitBody(accuracy);
    assert.equal(parseVisitDraft(body).ok, false, `a visit at ${accuracy} m is refused`);
    const row = refusedReadingOf(body, "visit");
    assert.ok(row, `and recorded (${accuracy} m)`);
    assert.equal(row.accuracyMeters, accuracy);
    assert.equal(row.maxAccuracyMeters, VISIT_MAX_ACCURACY_METERS, "the visit's line, never the place's");
  }
  // A reading between the two lines is a REFUSED place and an ACCEPTED visit — the one case where the
  // subject argument decides the answer, and a swap would file a row about a visit nobody refused.
  const between = Math.round((PLACE_MAX_ACCURACY_METERS + VISIT_MAX_ACCURACY_METERS) / 2);
  assert.ok(refusedReadingOf(placeBody(between, "none"), "place"), `${between} m is a refused place`);
  assert.equal(refusedReadingOf(visitBody(between), "visit"), null, `${between} m is an accepted visit`);

  // ── 6. It restates no threshold ───────────────────────────────────────────────
  // The place's line is nine days old and has moved once. A classifier carrying its own copy could
  // disagree with the door that refused the capture, which is worse than having no record at all.
  const rules = stripComments(readFileSync("src/lib/phoenix-crm/entry-rules.ts", "utf8"));
  const classifier = /export function refusedReadingOf\(([\s\S]*?)\n}/.exec(rules);
  assert.ok(classifier, "refusedReadingOf is still in entry-rules.ts");
  assert.match(classifier[1], /placeReadingsPrecise\(fix\.value\)/, "a place is judged by the door's own predicate");
  assert.match(classifier[1], /withinAccuracy\(fix\.value\.accuracyMeters, VISIT_MAX_ACCURACY_METERS\)/, "and a visit by the door's own");
  // No comparison against a literal above zero. `accuracy >= 0` is allowed and is not a threshold —
  // it rejects a negative radius, which is nonsense from any phone; `> 100` or `> 500` would be a
  // second copy of a line that has already moved once.
  assert.doesNotMatch(classifier[1], /[<>]=?\s*[1-9]/, "it compares against no threshold of its own");
  for (const line of [String(PLACE_MAX_ACCURACY_METERS), String(VISIT_MAX_ACCURACY_METERS)]) {
    assert.ok(!new RegExp(`\\b${line}\\b`).test(classifier[1]), `and never spells ${line} out`);
  }

  // ── 7. The recorder cannot cost a rep his work ────────────────────────────────
  const recorder = readFileSync("src/lib/phoenix-crm/server/refused-readings.ts", "utf8");
  assert.match(recorder, /export async function recordRefusedReading\([\s\S]*?\): Promise<void> \{\n  try \{/, "it opens in a try and returns void — there is nothing for a caller to fail on");
  assert.match(recorder, /\} catch \(error\) \{/, "and every error it can produce is swallowed");
  const recorderCode = stripComments(recorder);
  assert.doesNotMatch(recorderCode, /\bthrow\b/, "it never throws: the rep is already being refused");
  assert.doesNotMatch(recorderCode, /validationError|forbiddenError/, "and it can change no refusal the rep reads");
  assert.ok(recorderCode.includes('.from("phoenix_crm_refused_readings")'), "it writes the module's own table");
  assert.ok(recorderCode.includes(".insert({"), "an INSERT, never an upsert — eighteen refusals are eighteen rows");
  assert.doesNotMatch(recorderCode, /\.(?:upsert|update|delete)\(/, "nothing here replaces or removes a refusal already filed");
  assert.ok(recorderCode.includes("visit_date: cairoBusinessDay(refusedAt)"), "the Cairo visit day, which ends at 02:00 — never the database's UTC day");

  // ── 8. Every door that refuses a reading files it, and files it BEFORE throwing ──
  // Awaited, unlike judgeCapture: this runs while the request is still open, so an unawaited promise
  // can be killed with the invocation and record nothing — the exact hole being closed.
  for (const [file, doors] of [
    ["src/lib/phoenix-crm/server/list.ts", 2],
    ["src/lib/phoenix-crm/server/visits.ts", 1],
  ] as const) {
    const source = stripComments(readFileSync(file, "utf8"));
    const calls = [...source.matchAll(/await recordRefusedReading\(\{([\s\S]*?)\n    \}\);\n    throw validationError\(/g)];
    assert.equal(calls.length, doors, `${file}: all ${doors} refusing door(s) file the reading, awaited, before throwing`);
    for (const call of calls) {
      assert.match(call[1], /\n      subjectKind: "(?:place|visit)",/, `${file}: each call names which door refused it`);
      assert.match(call[1], /\n      repHrId: viewer\.hrId,/, `${file}: and whose phone it was`);
      assert.match(call[1], /\n      isTest,/, `${file}: a test-world refusal is filed as one`);
    }
    assert.ok(
      source.includes('import { recordRefusedReading } from "@/lib/phoenix-crm/server/refused-readings";'),
      `${file}: it is the shared recorder, never a second copy of the write`,
    );
    assert.equal(
      (source.match(/recordRefusedReading\(/g) ?? []).length,
      doors,
      `${file}: exactly ${doors} call(s) — an unawaited one anywhere else would die with the invocation`,
    );
  }

  // ── 9. Nothing a rep can open reads it ────────────────────────────────────────
  // The table is service-role only in SQL (tests/phoenix-crm-boundary.test.ts holds its four lock
  // statements); this is the other half — no screen, no rep-facing payload and no report names it.
  const migration = readFileSync("supabase/migrations/20261003211500_phoenix_crm_refused_readings.sql", "utf8");
  assert.match(migration, /create table if not exists public\.phoenix_crm_refused_readings \(/, "the table is created here");
  assert.match(migration, /drop table if exists public\.phoenix_crm_refused_readings;/, "with its rollback stated");
  // Stripped, because the comment explaining the absence necessarily names the thing that is absent.
  assert.doesNotMatch(
    stripSqlComments(migration),
    /\bunique\b/i,
    "and it is deliberately unkeyed — a constraint on any column here would collapse the retry history that IS the evidence",
  );
}
