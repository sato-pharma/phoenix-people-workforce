import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NO_FIX_FOR_A_VISIT,
  PLACE_MAX_ACCURACY_METERS,
  ROUGH_FIX_AT_THE_PLACE,
  ROUGH_FIX_FOR_A_VISIT,
  VISIT_MAX_ACCURACY_METERS,
  parsePlaceDraft,
  parseVisitDraft,
  placePoint,
} from "../src/lib/phoenix-crm/entry-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix CRM takes a reading up to 200 m to validate a place and up to 500 m for a visit (owner,
// 2026-10-03: "accept up to max 500 m in visits and 200 m in validation").
//
// Production, Sat 3 Oct 2026 — the first real day of Delta (1) on Phoenix CRM: one rep's phone was on
// APPROXIMATE location, and between 09:10 and 09:57 Cairo it validated four different Benha hospitals
// at ONE identical point, 30.4684684684685, 31.1899555209043, every reading "within 2,000 m". Nothing
// refused it, and a place is fixed for good, so each later visit there read "0 m apart" — a 2 km blur
// compared with itself. Every other rep that morning read between 3.6 and 19.8 m.
//
// A reading wider than its line is now no reading: refused in words about his own phone (Golden Rule
// #1 — nothing about any check). An unknown accuracy is still taken, exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

const BENHA = { lat: 30.4684684684685, lon: 31.1899555209043 };
const CLINIC = { lat: 30.4657861755584, lon: 31.1863753029889 };
const TIMINGS = [{ weekday: 6, start: "17:00", end: "21:00" }];
const DOCTOR = "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";

function placeBody(pin: number | null, photo: number | null | "none", at = BENHA) {
  return {
    lat: at.lat,
    lon: at.lon,
    accuracyMeters: pin,
    photoPath: "seat/place.jpg",
    timings: TIMINGS,
    ...(photo === "none" ? {} : { shutterLat: CLINIC.lat, shutterLon: CLINIC.lon, shutterAccuracyMeters: photo }),
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
  assert.equal(PLACE_MAX_ACCURACY_METERS, 200, "a place is validated on a reading up to 200 m");
  assert.equal(VISIT_MAX_ACCURACY_METERS, 500, "a visit is taken on a reading up to 500 m");

  // ── The headline: the Benha place is refused ──────────────────────────────────
  assert.equal(
    refusalOf(parsePlaceDraft({ ...placeBody(2000, null, BENHA), shutterLat: BENHA.lat, shutterLon: BENHA.lon, shutterAccuracyMeters: 2000 })),
    ROUGH_FIX_AT_THE_PLACE,
    "a place whose pin AND photo both read 2,000 m is refused — it was fixed for good on 3 Oct, four hospitals on one point",
  );

  // ── The place's line: 200 m, inclusive ────────────────────────────────────────
  assert.equal(refusalOf(parsePlaceDraft(placeBody(200, "none"))), null, "200 m is inside the place's line");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(201, "none"))), ROUGH_FIX_AT_THE_PLACE, "201 m is outside it");
  assert.equal(refusalOf(parsePlaceDraft(placeBody(500, "none"))), ROUGH_FIX_AT_THE_PLACE, "a reading a visit would take is still too wide for a place");

  // ── Photo first, unless the photo is rough and the pin is not ─────────────────
  const photoGood = parsePlaceDraft(placeBody(1500, 15));
  assert.ok(photoGood.ok, "a sharp photo validates the place even when the pin was rough");
  assert.equal(placePoint(photoGood.value).source, "photo", "the photo's reading is the fixed point, as ruled 2026-09-29");

  const bothGood = parsePlaceDraft(placeBody(5, 15));
  assert.ok(bothGood.ok);
  assert.equal(placePoint(bothGood.value).source, "photo", "with both readings sharp the photo still wins — the ruling is unchanged");

  const pinGood = parsePlaceDraft(placeBody(5, 2000));
  assert.ok(pinGood.ok, "a sharp pin rescues a place whose photo was taken on a rough reading — no second photo needed");
  const pinPoint = placePoint(pinGood.value);
  assert.equal(pinPoint.source, "pin", "a rough photo with a sharp pin fixes the place on the pin");
  assert.equal(pinPoint.accuracyMeters, 5);
  assert.equal(pinPoint.lat, BENHA.lat, "the pin's own coordinates, never the photo's");

  assert.equal(refusalOf(parsePlaceDraft(placeBody(900, 2000))), ROUGH_FIX_AT_THE_PLACE, "both rough: refused");

  // ── Unknown is never refused, and no location is still its own sentence ───────
  const unknown = parsePlaceDraft(placeBody(null, null));
  assert.ok(unknown.ok, "an unknown accuracy is taken, as it always was");
  assert.equal(placePoint(unknown.value).source, "photo");
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

  // ── Golden Rule #1: the sentence is about his phone, never a check ─────────────
  for (const message of [ROUGH_FIX_AT_THE_PLACE, ROUGH_FIX_FOR_A_VISIT]) {
    assert.match(message, /Turn on precise location for Phoenix/, "it says what to switch on — approximate location is the cause");
    for (const banned of [/check/i, /flag/i, /suspic/i, /accura/i, /distance/i, /\bfar\b/i, /manager/i, /report/i, /\d+\s*m\b/]) {
      assert.doesNotMatch(message, banned, `the rep's sentence must not hint at a check (${banned})`);
    }
  }

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
