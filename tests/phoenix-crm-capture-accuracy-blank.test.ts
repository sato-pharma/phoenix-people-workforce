import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseCapturedFix, parsePlaceDraft, parseVisitDraft } from "../src/lib/phoenix-crm/entry-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A blank GPS accuracy on a Phoenix CRM live photo is UNKNOWN, never a perfect 0 m fix.
//
// parseCapturedFix caught a null or missing accuracy, but read everything else with `Number(...)`,
// and `Number("")` and `Number(" ")` are 0. A phone that sent a blank accuracy with its place or
// visit photo was therefore saved at 0 m, and the place card told the manager the photo was taken
// "within 0 m", the most precise fix the system can show, when the phone reported no accuracy at all.
//
// Nothing new is decided here. The coordinates were already safe (isUsableFix refuses a blank and
// anything outside Egypt), a negative accuracy was already unknown, and an unknown accuracy is never
// "weak GPS", exactly as before. The accuracy is now read with readAccuracyInput
// (src/lib/geo/coordinate-input.ts, shared since #3995), not a new copy.
//
// Production on 2026-09-18: 3 validated places and 2 visits, none at 0 m, so the defect was latent
// and nothing was repaired.
// ─────────────────────────────────────────────────────────────────────────────

const RULES = "src/lib/phoenix-crm/entry-rules.ts";

const BLANKS = [
  ["blank", " "],
  ["tab and newline", "\t\n"],
  ["empty", ""],
  ["null", null],
  ["undefined", undefined],
] as const;

const CAIRO = { lat: 30.0444, lon: 31.2357 };
const DOCTOR = "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";

function valueOf<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  assert.ok(result.ok, result.ok ? "" : `expected a value, got the refusal "${result.error}"`);
  return result.value;
}

export function runPhoenixCrmCaptureAccuracyBlankTests() {
  // ── The headline: a blank accuracy is unknown, never 0 m ──────────────────────
  for (const [label, accuracyMeters] of BLANKS) {
    const fix = valueOf(parseCapturedFix({ ...CAIRO, accuracyMeters }));
    assert.equal(
      fix.accuracyMeters,
      null,
      `a Phoenix CRM photo whose accuracy is ${label} has an unknown accuracy — Number(...) read a blank one as a perfect 0 m fix`,
    );
    assert.equal(fix.lat, CAIRO.lat, "the location itself is kept");
    assert.equal(fix.lon, CAIRO.lon);
  }

  // ── Both screens that carry the fix: validating a place, and a visit ──────────
  for (const [label, accuracyMeters] of BLANKS) {
    const place = valueOf(parsePlaceDraft({ ...CAIRO, accuracyMeters, photoPath: "seat/place.jpg", timings: [{ weekday: 6, start: "17:00", end: "21:00" }] }));
    assert.equal(place.accuracyMeters, null, `a place validated with a ${label} accuracy is saved with no accuracy, not 0 m`);
    const visit = valueOf(parseVisitDraft({ ...CAIRO, accuracyMeters, customerId: DOCTOR, kind: "single", products: ["Lacto Advanced"], photoPath: "seat/visit.jpg" }));
    assert.equal(visit.accuracyMeters, null, `a visit with a ${label} accuracy is saved with no accuracy, not 0 m`);
  }

  // ── A real accuracy reads exactly as before ───────────────────────────────────
  assert.equal(valueOf(parseCapturedFix({ ...CAIRO, accuracyMeters: 12.345 })).accuracyMeters, 12.3);
  assert.equal(valueOf(parseCapturedFix({ ...CAIRO, accuracyMeters: " 18 " })).accuracyMeters, 18, "a numeric string, padded or not, is still an accuracy");
  assert.equal(valueOf(parseCapturedFix({ ...CAIRO, accuracyMeters: 0 })).accuracyMeters, 0, "a phone that really reports 0 m keeps it");
  assert.equal(valueOf(parseCapturedFix({ ...CAIRO, accuracyMeters: -5 })).accuracyMeters, null, "a negative accuracy stays unknown");
  assert.equal(valueOf(parseCapturedFix({ ...CAIRO, accuracyMeters: "abc" })).accuracyMeters, null);

  // ── The coordinates were already guarded, and still are ───────────────────────
  for (const [label, value] of BLANKS) {
    assert.equal(parseCapturedFix({ lat: value, lon: value, accuracyMeters: 12 }).ok, false, `a ${label} coordinate pair is still refused`);
  }

  // ── The parser reads the accuracy with the shared reader ──────────────────────
  const rules = stripComments(readFileSync(RULES, "utf8"));
  assert.match(rules, /import \{ readAccuracyInput \} from "@\/lib\/geo\/coordinate-input";/);
  assert.match(rules, /readAccuracyInput\(raw\.accuracyMeters\)/, "the accuracy is read with the shared accuracy reader");
  assert.doesNotMatch(rules, /Number\(raw\.accuracyMeters\)/, "Number(...) reads a blank accuracy as 0 m");
}
