import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseNativeVisitDraft } from "../src/lib/crm/native-visits/rules.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A blank latitude or longitude on a CRM visit is NO fix, never 0°N 0°E.
//
// parseNativeVisitDraft read each coordinate with finiteOrNull, which caught null and "" but not
// whitespace: `Number(" ")` is 0. A blank pair therefore read as 0°N 0°E, which is outside Egypt,
// so the visit was flagged "out of bounds" and kept 0,0 as a position the phone never reported —
// telling an approver the phone was in the Gulf of Guinea when it reported nothing at all.
//
// Nothing new is decided here: a missing fix and an out-of-bounds fix are both FLAGS, never a
// refusal (owner decision 7), and half a pair was already no fix. A blank coordinate now takes the
// "missing" flag a missing one always had. The coordinate is read with readCoordinateInput
// (src/lib/geo/coordinate-input.ts, shared since #3995), not a new copy. finiteOrNull stays for the
// doctor's CRM id, where a blank already ends as "no doctor".
//
// Production on 2026-09-18: crm_native_visits holds no rows at all, so the defect was latent and
// nothing was repaired.
// ─────────────────────────────────────────────────────────────────────────────

const RULES = "src/lib/crm/native-visits/rules.ts";

const BLANKS = [
  ["blank", " "],
  ["tab and newline", "\t\n"],
  ["empty", ""],
  ["null", null],
  ["undefined", undefined],
] as const;

const CONTEXT = { cairoToday: "2026-09-20", now: new Date("2026-09-20T08:00:00.000Z") };

function visitBody(latitude: unknown, longitude: unknown) {
  return {
    accuracyMeters: 12,
    clientSubmissionId: "3f1c2a6e-9b4d-4c8e-8a1f-2b3c4d5e6f70",
    comment: "",
    contactCrmId: 5123,
    deviceRecordedAt: "2026-09-20T07:55:00.000Z",
    latitude,
    longitude,
    partnerHrIds: [],
    shift: "AM",
    visitDate: "2026-09-20",
    visitType: "regular",
  };
}

export function runCrmVisitBlankCoordinatesTests() {
  // ── The headline: a blank pair is no fix, never an out-of-bounds pin at 0°N 0°E ─
  for (const [label, value] of BLANKS) {
    const visit = parseNativeVisitDraft(visitBody(value, value), CONTEXT);
    assert.ok(visit.ok, `a visit whose coordinates are ${label} still saves — a missing fix is a flag, never a refusal`);
    assert.equal(
      visit.value.gpsStatus,
      "missing",
      `a CRM visit whose latitude and longitude are ${label} has no fix — finiteOrNull read " " as 0°N 0°E and flagged it out of bounds`,
    );
    assert.equal(visit.value.latitude, null, `a ${label} latitude is not stored as 0`);
    assert.equal(visit.value.longitude, null, `a ${label} longitude is not stored as 0`);
    assert.equal(visit.value.accuracyMeters, null, "a visit with no fix keeps no accuracy");
  }

  // ── Half a pair is no fix either, as it already was ───────────────────────────
  for (const [label, value] of BLANKS) {
    for (const body of [visitBody(value, 31.2357), visitBody(30.0444, value)]) {
      const visit = parseNativeVisitDraft(body, CONTEXT);
      assert.ok(visit.ok);
      assert.equal(visit.value.gpsStatus, "missing", `a ${label} half of the pair is no fix`);
      assert.equal(visit.value.latitude, null);
      assert.equal(visit.value.longitude, null);
    }
  }

  // ── A real fix reads exactly as before ────────────────────────────────────────
  const cairo = parseNativeVisitDraft(visitBody(30.0444, 31.2357), CONTEXT);
  assert.ok(cairo.ok);
  assert.equal(cairo.value.gpsStatus, "captured");
  assert.equal(cairo.value.latitude, 30.0444);
  assert.equal(cairo.value.accuracyMeters, 12);
  const asText = parseNativeVisitDraft(visitBody(" 30.0444 ", "31.2357"), CONTEXT);
  assert.ok(asText.ok);
  assert.equal(asText.value.gpsStatus, "captured", "a numeric string, padded or not, is still a fix");
  assert.equal(asText.value.longitude, 31.2357);
  const abroad = parseNativeVisitDraft(visitBody(51.5072, -0.1276), CONTEXT);
  assert.ok(abroad.ok);
  assert.equal(abroad.value.gpsStatus, "out_of_bounds", "a real fix outside Egypt is still flagged and kept");
  assert.equal(abroad.value.latitude, 51.5072);

  // ── The rules read the coordinates with the shared reader ─────────────────────
  const rules = stripComments(readFileSync(RULES, "utf8"));
  assert.match(rules, /import \{ readAccuracyInput, readCoordinateInput \} from "@\/lib\/geo\/coordinate-input";/);
  assert.match(rules, /readCoordinateInput\(body\.latitude\)/, "the latitude is read with the shared coordinate reader");
  assert.match(rules, /readCoordinateInput\(body\.longitude\)/, "the longitude is read with the shared coordinate reader");
  assert.doesNotMatch(rules, /finiteOrNull\(body\.(latitude|longitude)\)/, "finiteOrNull lets \" \" through as 0");
}
