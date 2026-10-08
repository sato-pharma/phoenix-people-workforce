import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assessCaptureTrust, CAPTURE_DRIFT_AGREE_METRES, CAPTURE_DRIFT_DISAGREE_METRES } from "../src/lib/evidence/capture-trust.ts";
import { PHOENIX_CRM_STRONG_INTEGRITY_FLAGS } from "../src/lib/phoenix-crm/location-integrity.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a place's TWO readings compared with each other (2026-10-08).
 *
 * A place stores the photo's own shutter fix and the separate Capture-location pin, and until that
 * day nothing compared them: three live places sat with their photo and pin 869 m, 1,553 m and 687 m
 * apart, each reading individually "precise". `assessCaptureTrust` already answers this for three
 * other modules; Phoenix CRM now files its verdict as a FLAG — never a refusal, never a hold.
 */

const fix = (latitude: number, longitude: number, capturedAt: string) => ({ accuracyMeters: 10, capturedAt, latitude, longitude });

export function runPhoenixCrmCaptureTrustPlaceTests(): void {
  // The thresholds are read, never re-declared here.
  assert.ok(CAPTURE_DRIFT_AGREE_METRES < CAPTURE_DRIFT_DISAGREE_METRES);

  const near = assessCaptureTrust({ locationFix: fix(30.0444, 31.2357, "2026-10-08T08:00:00Z"), photoFix: fix(30.0445, 31.2358, "2026-10-08T08:01:00Z") });
  assert.equal(near.measured, true);
  assert.equal(near.verdict === "disagrees" || near.verdict === "drifted", false, "one doorway apart is not a case");
  const far = assessCaptureTrust({ locationFix: fix(30.0444, 31.2357, "2026-10-08T08:00:00Z"), photoFix: fix(30.0644, 31.2557, "2026-10-08T08:01:00Z") });
  assert.equal(far.verdict, "disagrees", "kilometres apart is a different part of the city");
  const one = assessCaptureTrust({ locationFix: fix(30.0444, 31.2357, "2026-10-08T08:00:00Z"), photoFix: null });
  assert.equal(one.measured, false, "one reading is not measured, and an unmeasured pair files nothing");

  // Only the disagreement is strong; drift, a long gap and identical readings are worth a look.
  assert.ok(PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes("photo_pin_disagrees"));
  for (const weak of ["photo_pin_drifted", "photo_pin_gap_long", "photo_pin_identical"] as const) {
    assert.ok(!PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(weak), `${weak} is never on its own an accusation`);
  }

  const server = stripComments(readFileSync("src/lib/phoenix-crm/server/location-integrity.ts", "utf8"));
  const body = server.slice(server.indexOf("export async function filePlaceCaptureTrust"), server.indexOf("export async function filePlaceSignboardFlag"));
  assert.ok(body.includes('source: "capture_trust"'), "its own source — `gps` would REPLACE the position verdict on the same place");
  assert.ok(body.includes("if (!assessment.measured) return;"), "an unmeasured pair writes nothing");
  assert.ok(body.includes("catch"), "it never turns a saved validation into an error");
  assert.ok(!body.includes("hold_review") && !body.includes("throw "), "a flag, never a hold or a refusal");

  const list = stripComments(readFileSync("src/lib/phoenix-crm/server/list.ts", "utf8"));
  assert.ok(list.includes("filePlaceCaptureTrust("), "every place save files the comparison");

  const migration = readFileSync("supabase/migrations/20261008023051_phoenix_crm_signboard_and_capture_trust.sql", "utf8");
  assert.match(migration, /check \(source in \('gps', 'photo', 'behaviour', 'capture_trust', 'signboard'\)\)/, "the source CHECK carries both new detectors");
  console.log("phoenix-crm capture trust on places: OK");
}
