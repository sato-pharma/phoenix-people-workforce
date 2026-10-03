import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NO_FIX_FOR_A_VISIT,
  PLACE_MAX_ACCURACY_METERS,
  PLACE_PRECISION_NOTE,
  ROUGH_FIX_AT_THE_PLACE,
  ROUGH_FIX_FOR_A_VISIT,
  VISIT_MAX_ACCURACY_METERS,
  parsePlaceDraft,
  parseVisitDraft,
  placePoint,
} from "../src/lib/phoenix-crm/entry-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix CRM validates a place only on readings within 100 m — the photo's own AND the Capture-location
// pin — and takes a visit on a reading within 500 m (owner, 2026-10-03: "accept up to max 500 m in
// visits and 200 m in validation"; then "the system should never accept a photo or location … in
// validation", "in validation the system can block inaccurate validation", and "inform the rep that
// validation must be accurate minimum accepted 100m accuracy").
//
// Production, Sat 3 Oct 2026 — the first real day of Delta (1) on Phoenix CRM: one rep's phone was on
// APPROXIMATE location, and between 09:10 and 09:57 Cairo it validated four different Benha hospitals
// at ONE identical point, 30.4684684684685, 31.1899555209043, every reading "within 2,000 m". Nothing
// refused it, and a place is fixed for good, so each later visit there read "0 m apart" — a 2 km blur
// compared with itself. Every other rep that morning read between 3.6 and 19.8 m.
//
// The validation's line is TOLD to the rep, by the owner's word: before he starts, and in the refusal.
// His own reading is never shown, and the visit's line is still never put into words (Golden Rule #1).
// An unknown accuracy is still taken, exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

const BENHA = { lat: 30.4684684684685, lon: 31.1899555209043 };
const CLINIC = { lat: 30.4657861755584, lon: 31.1863753029889 };
const TIMINGS = [{ weekday: 6, start: "17:00", end: "21:00" }];
const DOCTOR = "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";

/** A place body: the pin's accuracy, and the photo's — or "none" when the shutter read no position. */
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

function visitBody(accuracyMeters: number | null) {
  return {
    ...CLINIC,
    accuracyMeters,
    customerId: DOCTOR,
    kind: "single",
    products: ["Lacto Advanced"],
    pharmacyName: "El Ezaby",
    comment: "Discussed the new dose.",
  };
}

function refusalOf(result: { ok: true } | { ok: false; error: string }): string | null {
  return result.ok ? null : result.error;
}

export function runPhoenixCrmAccuracyGateTests() {
  // ── The owner's two numbers ───────────────────────────────────────────────────
  assert.equal(PLACE_MAX_ACCURACY_METERS, 100, "a place is validated only on readings within 100 m");
  assert.equal(VISIT_MAX_ACCURACY_METERS, 500, "a visit is taken on a reading within 500 m");

  // ── The headline: the Benha place is refused ──────────────────────────────────
  assert.equal(
    refusalOf(parsePlaceDraft(placeBody(2000, 2000, BENHA))),
    ROUGH_FIX_AT_THE_PLACE,
    "a place whose pin AND photo both read 2,000 m is refused — it was fixed for good on 3 Oct, four hospitals on one point",
  );

  // ── The place's line: 100 m, inclusive ────────────────────────────────────────
  assert.equal(refusalOf(parsePlaceDraft(placeBody(100, 100))), null, "100 m is inside the place's line");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(101, 5))), ROUGH_FIX_AT_THE_PLACE, "a pin at 101 m is outside it");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(5, 101))), ROUGH_FIX_AT_THE_PLACE, "a photo at 101 m is outside it");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(200, 5))), ROUGH_FIX_AT_THE_PLACE, "the first line he named, 200 m, is now too wide");

  // ── BOTH readings must be accurate: neither rescues the other ─────────────────
  assert.equal(
    refusalOf(parsePlaceDraft(placeBody(5, 2000))),
    ROUGH_FIX_AT_THE_PLACE,
    "a rough PHOTO is refused even beside a sharp pin — the system never accepts a rough photo in validation",
  );
  assert.equal(
    refusalOf(parsePlaceDraft(placeBody(1500, 15))),
    ROUGH_FIX_AT_THE_PLACE,
    "a rough PIN is refused even beside a sharp photo — the system never accepts a rough location in validation",
  );

  const bothGood = parsePlaceDraft(placeBody(5, 15));
  assert.ok(bothGood.ok, "two accurate readings validate the place");
  assert.equal(placePoint(bothGood.value).source, "photo", "and the photo's reading is the fixed point, as ruled 2026-09-29");

  const noPhotoReading = parsePlaceDraft(placeBody(8, "none"));
  assert.ok(noPhotoReading.ok, "a photo whose shutter read no position is not a rough one — the pin alone decides, as before");
  assert.equal(placePoint(noPhotoReading.value).source, "pin");

  // ── Unknown is never refused, and no location is still its own sentence ───────
  assert.ok(parsePlaceDraft(placeBody(null, null)).ok, "an unknown accuracy is taken, as it always was");
  assert.notEqual(
    refusalOf(parsePlaceDraft({ photoPath: "seat/place.jpg", timings: TIMINGS })),
    ROUGH_FIX_AT_THE_PLACE,
    "no location at all keeps its own sentence — allow location — never the rough one",
  );

  // ── The visit's line: 500 m, inclusive ────────────────────────────────────────
  assert.equal(refusalOf(parseVisitDraft(visitBody(2000))), ROUGH_FIX_FOR_A_VISIT, "the Benha 2,000 m visit is refused");
  assert.equal(refusalOf(parseVisitDraft(visitBody(1414))), ROUGH_FIX_FOR_A_VISIT, "the 1,414 m Mahalla visit of 3 Oct is refused too");
  assert.equal(refusalOf(parseVisitDraft(visitBody(501))), ROUGH_FIX_FOR_A_VISIT, "501 m is outside the visit's line");
  assert.equal(refusalOf(parseVisitDraft(visitBody(500))), null, "500 m is inside it");
  assert.equal(refusalOf(parseVisitDraft(visitBody(300))), null, "a weak-signal visit (over the 100 m flag) still saves — flagged for the manager, never refused");
  assert.equal(refusalOf(parseVisitDraft(visitBody(4))), null);
  assert.equal(refusalOf(parseVisitDraft(visitBody(null))), null, "an unknown accuracy is taken, as it always was");
  assert.equal(refusalOf(parseVisitDraft({ ...visitBody(4), lat: undefined, lon: undefined })), NO_FIX_FOR_A_VISIT, "no location keeps its own sentence");

  // ── The rep is TOLD the validation's line, by the owner's word ─────────────────
  for (const message of [PLACE_PRECISION_NOTE, ROUGH_FIX_AT_THE_PLACE]) {
    assert.match(message, /Validation needs an accurate location, within 100 m/, "he is told the validation must be accurate, within 100 m");
    assert.match(message, /Turn on precise location for Phoenix/, "and what to switch on — approximate location is the cause");
    for (const banned of [/check/i, /flag/i, /suspic/i, /distance/i, /\bfar\b/i, /manager/i, /report/i]) {
      assert.doesNotMatch(message, banned, `it states the rule of his work, never a check on him (${banned})`);
    }
  }
  assert.match(ROUGH_FIX_AT_THE_PLACE, /take the photo and press Capture location again/, "a rough photo is retaken, not rescued by the pin");

  // ── The visit's line is still never put into words (Golden Rule #1) ───────────
  assert.match(ROUGH_FIX_FOR_A_VISIT, /Turn on precise location for Phoenix/);
  for (const banned of [/check/i, /flag/i, /suspic/i, /accura/i, /distance/i, /\bfar\b/i, /manager/i, /report/i, /\d+\s*m\b/]) {
    assert.doesNotMatch(ROUGH_FIX_FOR_A_VISIT, banned, `the visit's sentence must not hint at a check (${banned})`);
  }

  // ── The validation screen states the rule before the photo, and never his reading ─
  const editor = stripComments(readFileSync("src/components/phoenix-crm/place-editor.tsx", "utf8"));
  const photoBlock = /title=\{`\$\{firstStep\} · Signboard photo`\}>([\s\S]*?)<LivePhotoCapture/.exec(editor);
  assert.ok(photoBlock, "the Signboard photo step opens with what comes before the camera");
  assert.ok(photoBlock[1].includes("{PLACE_PRECISION_NOTE}"), "the rule is told on the validation screen, before the photo is taken");
  // His own reading is still never printed: tests/phoenix-crm-place-location-frozen.test.ts pins the
  // location block, and the note above is a constant that names the rule and nothing measured.

  // ── Every save goes through the two parsers ───────────────────────────────────
  const list = stripComments(readFileSync("src/lib/phoenix-crm/server/list.ts", "utf8"));
  assert.equal((list.match(/const place = parsePlaceDraft\(body\.place\);/g) ?? []).length, 2, "validating and adding a place both parse through the gate");
  const visits = stripComments(readFileSync("src/lib/phoenix-crm/server/visits.ts", "utf8"));
  assert.ok(visits.includes("const draft = parseVisitDraft(body);"), "the visit save parses through the gate");

  // ── The silent reader waits for a reading the save takes ──────────────────────
  const reader = stripComments(readFileSync("src/components/phoenix-crm/use-silent-fix.ts", "utf8"));
  assert.ok(
    reader.includes("withinAccuracy(fix.accuracyMeters, VISIT_MAX_ACCURACY_METERS)"),
    "Log visit judges the kept reading by the server's own line, never a copy of it",
  );
  assert.ok(reader.includes("if (goodEnough(bestRef.current)) return Promise.resolve(bestRef.current);"), "a reading inside the line is sent at once");
  assert.ok(
    reader.includes("if (goodEnough(bestRef.current) || watchRef.current === null) finish();"),
    "a rough first reading waits for a sharper one, and a refusal still answers at once",
  );
}
