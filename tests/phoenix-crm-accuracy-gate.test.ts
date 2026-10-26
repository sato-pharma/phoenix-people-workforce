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
  pickPlacePoint,
  placePoint,
  roughFixAtThePlace,
  roughFixForAVisit,
} from "../src/lib/phoenix-crm/entry-rules.ts";
import type { CapturedFix } from "../src/lib/phoenix-crm/entry-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix CRM validates a place only on a Capture-location pin within 250 m — THE PIN ALONE DECIDES
// (owner, 2026-10-11, answering "A" when asked directly; it replaced the both-readings rule this
// header still described until 2026-10-12, after iPhone Safari handed the camera an approximate
// position — 2,000 m, 650-1,900 m — while the pin read 11-30 m and refused two named reps standing at
// the clinic. A rough pin is still refused and a rough photo reading never becomes the fixed point) —
// and takes a visit on a reading within 500 m (owner, 2026-10-03: "accept up to max 500 m in
// visits and 200 m in validation"; then "the system should never accept a photo or location … in
// validation", "in validation the system can block inaccurate validation", and "inform the rep that
// validation must be accurate minimum accepted 100m accuracy"; then, that evening, "make the 100m 250m").
//
// 🔴 THE PLACE'S LINE WENT 100 → 250 ON THE FIRST NIGHT, BECAUSE 100 DEAD-ENDED A REP WHOSE PHONE WAS
// FINE. Half an hour after phoenix_crm_refused_readings went live it recorded nine refusals in 67
// seconds (21:30:29 → 21:31:36 Cairo) from one rep whose PIN read 47 → 58 → 30 → 29 → 27 m, every one
// inside even the old line, while the photo he took at 21:29:58 read 220 m and NEVER CHANGED —
// device_captured_at was that one instant on all nine rows and photo_lat/photo_lon were identical to 13
// decimals, because a retry resends the same photo. So every attempt failed on a reading that could not
// improve, and his coordinate sat 890–911 m from a 2 km privacy-grid corner: no blurring, just a first
// fix taken before the GPS settled. The owner was offered "make a refused photo force a retake, keep
// 100 m" and chose the wider line instead. 250 m still refuses the case below by a factor of eight.
//
// Production, Sat 3 Oct 2026 — the first real day of Delta (1) on Phoenix CRM: one rep's phone was on
// APPROXIMATE location, and between 09:10 and 09:57 Cairo it validated four different Benha hospitals
// at ONE identical point, 30.4684684684685, 31.1899555209043, every reading "within 2,000 m". Nothing
// refused it, and a place is fixed for good, so each later visit there read "0 m apart" — a 2 km blur
// compared with itself. Every other rep that morning read between 3.6 and 19.8 m.
//
// The validation's line is TOLD to the rep, by the owner's word: before he starts, and in the refusal.
// 🔴 AND SINCE 2026-10-03 THE REFUSAL ALSO NAMES HIS OWN READING ("your phone gave 2,000 m") — the
// owner's amendment to his 2026-09-29 rule, after the same rep met "only a rough one" eighteen more
// times that evening and could not tell 2,000 m from 110 m. The visit's LINE is still never put into
// words (Golden Rule #1): his reading is about his phone, the line is about the check on him.
// An unknown accuracy is still taken, exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

const BENHA = { lat: 30.4684684684685, lon: 31.1899555209043 };
/** A fix carrying nothing but a pin reading — for the sentences, which read no coordinate. */
const BARE_FIX: CapturedFix = {
  accuracyMeters: null,
  deviceCapturedAt: null,
  // When the phone took the reading. Nothing here reads it — these sentences read no coordinate and
  // no clock — and null is NOT MEASURED, which is what a body with no such key means.
  fixTakenAt: null,
  deviceMocked: null,
  lat: 30.4657861755584,
  lon: 31.1863753029889,
  photoAccuracyMeters: null,
  photoCapturedAt: null,
  photoLat: null,
  photoLon: null,
};
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
  assert.equal(PLACE_MAX_ACCURACY_METERS, 250, "a place is validated only on readings within 250 m (owner, 2026-10-03 evening: \"make the 100m 250m\")");
  assert.equal(VISIT_MAX_ACCURACY_METERS, 500, "a visit is taken on a reading within 500 m");

  // ── The headline: the Benha place is refused, and the rep is TOLD her number ──
  // Owner, 2026-10-03: "show the rep her own accuracy number on the refusal". Without it she read
  // "only a rough one" eighteen times between 16:12 and 18:47 and could not tell 2,000 m from 110 m,
  // so nothing she tried could be judged — by her or by the office, since a refusal is never stored.
  assert.equal(
    refusalOf(parsePlaceDraft(placeBody(2000, 2000, BENHA))),
    "Validation needs an accurate location, within 250 m, and your phone gave 2,000 m. Turn on precise location for your browser; if it is already on, step outside the building and wait a few seconds, then take the photo and press Capture location again at the clinic.",
    "her own 2,000 m is said back to her, grouped, in the sentence that refuses her",
  );

  // ── The place's line: 250 m, inclusive ────────────────────────────────────────
  assert.equal(refusalOf(parsePlaceDraft(placeBody(250, 250))), null, "250 m is inside the place's line");
  assert.match(refusalOf(parsePlaceDraft(placeBody(251, 5))) ?? "", /your phone gave 251 m/, "a pin at 251 m is outside it, and 251 is the number she reads");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(5, 251))), null, "a photo at 251 m beside a sharp pin validates (owner, 2026-10-11: the pin decides)");

  // ── The nine refusals of 21:30 — the reason the line moved ────────────────────
  // 🔴 THE REGRESSION THIS CHANGE EXISTS FOR. His pin was never the problem; the photo he had already
  // taken was stuck at 220 m, and a retry resends it, so 100 m was a dead end with no exit but a
  // retake. Both of his readings now validate, and the OLD line is what these assertions would fail on.
  assert.equal(refusalOf(parsePlaceDraft(placeBody(47, 220))), null, "21:30:29 — pin 47 m, photo 220 m: validated now, refused under 100 m");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(27, 220))), null, "21:31:36 — his sharpest pin, same stuck photo: validated");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(220, 220))), null, "and a phone reading 220 m on BOTH is inside the line he set");
  // The old line's own boundary cases are inside the new one — the point of widening it.
  assert.equal(refusalOf(parsePlaceDraft(placeBody(101, 5))), null, "101 m, refused on the first night, is taken now");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(200, 5))), null, "so is 200 m, the first line he named");

  // ── THE PIN DECIDES (owner, 2026-10-11, "A") ──────────────────────────────────
  // 🔴 Production, 11 Oct: Georgette (B-182) stood at the clinic, her Capture-location pin read 11.2 m,
  // and iPhone Safari handed the camera 2,000 m then 1,414 m - refused eight times. B-158: pin 30 m,
  // photo 634-1,865 m. A sharp pin validates beside a rough photo reading; a rough pin is still refused.
  assert.equal(refusalOf(parsePlaceDraft(placeBody(11.2, 1414))), null, "Georgette: pin 11.2 m, photo 1,414 m - validated");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(11.2, 2000))), null, "Georgette: pin 11.2 m, photo 2,000 m - validated");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(29.9, 1865))), null, "B-158: pin 29.9 m, photo 1,865 m - validated");
  assert.match(
    refusalOf(parsePlaceDraft(placeBody(1500, 15))) ?? "",
    /your phone gave 1,500 m/,
    "a rough PIN is still refused even beside a sharp photo",
  );
  assert.match(refusalOf(parsePlaceDraft(placeBody(900, 1800))) ?? "", /your phone gave 900 m/, "two rough readings name the PIN, the only one that decides");
  const roughPhotoSharpPin = parsePlaceDraft(placeBody(11.2, 1414));
  assert.ok(roughPhotoSharpPin.ok);
  if (roughPhotoSharpPin.ok) {
    assert.equal(placePoint(roughPhotoSharpPin.value).source, "pin", "a rough photo reading is never the place's fixed point - the sharp pin is");
    assert.equal(roughPhotoSharpPin.value.photoAccuracyMeters, 1414, "and the photo's raw reading is still stored, for the integrity board");
  }

  const bothGood = parsePlaceDraft(placeBody(5, 15));
  assert.ok(bothGood.ok, "two accurate readings validate the place");
  assert.equal(placePoint(bothGood.value).source, "photo", "🔴 the LIVE PHOTO fixes the place even when the pin claims to be sharper: photo 15 m over pin 5 m (owner, 2026-10-26, replacing the 2026-10-11 sharper rule)");
  const photoSharper = parsePlaceDraft(placeBody(15, 5));
  assert.ok(photoSharper.ok);
  assert.equal(placePoint(photoSharper.value).source, "photo", "a photo sharper than the pin is the fixed point too");
  const tie = parsePlaceDraft(placeBody(27.1, 27.1));
  assert.ok(tie.ok);
  assert.equal(placePoint(tie.value).source, "photo", "a tie goes to the photo");
  // The pure picker the capture screen shares with the save, so the address she reads is the saved one.
  assert.equal(pickPlacePoint({ lat: 1, lon: 1, accuracyMeters: null }, { lat: 2, lon: 2, accuracyMeters: 11 }).source, "photo", "an UNKNOWN photo accuracy is taken, as it always was");
  assert.equal(pickPlacePoint(null, { lat: 2, lon: 2, accuracyMeters: 11 }).source, "pin", "no photo reading: the pin");
  assert.equal(pickPlacePoint({ lat: 1, lon: 1, accuracyMeters: 200 }, { lat: 2, lon: 2, accuracyMeters: 11 }).lat, 1, "🔴 a 200 m photo reading (inside the line) is the point over an 11 m pin — the photo is the source of trust (owner, 2026-10-26)");
  assert.equal(pickPlacePoint({ lat: 1, lon: 1, accuracyMeters: 250 }, { lat: 2, lon: 2, accuracyMeters: 11 }).source, "photo", "exactly on the place's line is still the photo");
  assert.equal(pickPlacePoint({ lat: 1, lon: 1, accuracyMeters: 251 }, { lat: 2, lon: 2, accuracyMeters: 11 }).source, "pin", "one metre past the line the photo is no reading, and the pin fixes the place");

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
  assert.match(refusalOf(parseVisitDraft(visitBody(2000))) ?? "", /Your phone gave 2,000 m, which is too rough to log a visit\./, "the Benha 2,000 m visit is refused, in her own number");
  assert.match(refusalOf(parseVisitDraft(visitBody(1414))) ?? "", /Your phone gave 1,414 m/, "the 1,414 m Mahalla visit of 3 Oct is refused too");
  assert.match(refusalOf(parseVisitDraft(visitBody(501))) ?? "", /Your phone gave 501 m/, "501 m is outside the visit's line");
  assert.equal(refusalOf(parseVisitDraft(visitBody(500))), null, "500 m is inside it");
  assert.equal(refusalOf(parseVisitDraft(visitBody(300))), null, "a weak-signal visit (over the 100 m flag) still saves — flagged for the manager, never refused");
  assert.equal(refusalOf(parseVisitDraft(visitBody(4))), null);
  assert.equal(refusalOf(parseVisitDraft(visitBody(null))), null, "an unknown accuracy is taken, as it always was");
  assert.equal(refusalOf(parseVisitDraft({ ...visitBody(4), lat: undefined, lon: undefined })), NO_FIX_FOR_A_VISIT, "no location keeps its own sentence");

  // ── The rep is TOLD the validation's line, by the owner's word ─────────────────
  for (const message of [PLACE_PRECISION_NOTE, ROUGH_FIX_AT_THE_PLACE]) {
    assert.match(message, /Validation needs an accurate location, within 250 m/, "he is told the validation must be accurate, within 250 m — the sentence moves with the constant, so a widened line is never said as the old one");
    assert.match(message, /Turn on precise location for your browser/, "and what to switch on — named for HIS browser, never \"Phoenix\", which no phone has");
    for (const banned of [/check/i, /flag/i, /suspic/i, /distance/i, /\bfar\b/i, /manager/i, /report/i]) {
      assert.doesNotMatch(message, banned, `it states the rule of his work, never a check on him (${banned})`);
    }
  }
  assert.match(ROUGH_FIX_AT_THE_PLACE, /take the photo and press Capture location again/, "a rough photo is retaken, not rescued by the pin");

  // ── The visit's LINE is still never put into words (Golden Rule #1) ───────────
  // 🔴 HIS READING IS NOT THE LINE, and the two must not be confused now that one of them is said.
  // "Your phone gave 2,000 m" is about his phone. "within 500 m" would be about the check on him — it
  // would tell him exactly how far from the clinic he may stand, which is the whole reason the visit's
  // line has never been printed. So the ban narrows from "no number at all" to "not THAT number".
  for (const reading of [501, 600, 1414, 2000, 12345, null]) {
    const sentence = reading === null ? ROUGH_FIX_FOR_A_VISIT : roughFixForAVisit({ ...BARE_FIX, accuracyMeters: reading });
    assert.match(sentence, /Turn on precise location for your browser/, `${reading} m still names his browser`);
    for (const banned of [/check/i, /flag/i, /suspic/i, /accura/i, /distance/i, /\bfar\b/i, /manager/i, /report/i]) {
      assert.doesNotMatch(sentence, banned, `the visit's sentence must not hint at a check (${banned}, ${reading})`);
    }
    assert.doesNotMatch(sentence, new RegExp(`\\b${VISIT_MAX_ACCURACY_METERS}\\s*m\\b`), `the visit's line itself is never printed (${reading})`);
    assert.doesNotMatch(sentence, /within \d/, `and never stated as a limit he is measured against (${reading})`);
  }
  assert.match(roughFixForAVisit({ ...BARE_FIX, accuracyMeters: 500.4 }), /Your phone gave 500 m/, "a reading is said in whole metres, never to a decimal");
  assert.equal(roughFixForAVisit({ ...BARE_FIX, accuracyMeters: null }), ROUGH_FIX_FOR_A_VISIT, "with no number to give, the sentence it always was");
  assert.equal(roughFixAtThePlace({ ...BARE_FIX, accuracyMeters: null }), ROUGH_FIX_AT_THE_PLACE, "same at the place: no number, no half-written sentence");

  // ── The validation screen states the rule before the photo, and never his reading ─
  const editor = stripComments(readFileSync("src/components/phoenix-crm/place-editor.tsx", "utf8"));
  const photoBlock = /title=\{`\$\{firstStep\} · Signboard photo`\}>([\s\S]*?)<LivePhotoCapture/.exec(editor);
  assert.ok(photoBlock, "the Signboard photo step opens with what comes before the camera");
  assert.ok(photoBlock[1].includes("browserNamed(PLACE_PRECISION_NOTE)"), "the rule is told on the validation screen, before the photo is taken — with HIS browser named");
  // His own reading is still never printed: tests/phoenix-crm-place-location-frozen.test.ts pins the
  // location block, and the note above is a constant that names the rule and nothing measured.

  // ── Every save goes through the two parsers ───────────────────────────────────
  const list = stripComments(readFileSync("src/lib/phoenix-crm/server/list.ts", "utf8"));
  // `const parsed = …` since 2026-10-09, not `const place = …`: a customer SEATED in a shared place
  // sends no location at all (the venue's point is inherited), so each door parses the draft inside
  // its own `if (!seated)` branch and assigns `place` after. The gate itself is unchanged — both
  // doors still go through `parsePlaceDraft`, and a third call would mean a door that skipped it.
  assert.equal((list.match(/const parsed = parsePlaceDraft\(body\.place\);/g) ?? []).length, 2, "validating and adding a place both parse through the gate");
  assert.equal((list.match(/parsePlaceDraft\(/g) ?? []).length, 2, "and nothing else in the module parses a place");
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
