import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CAPTURE_DRIFT_AGREE_METRES,
  CAPTURE_DRIFT_DISAGREE_METRES,
  CAPTURE_GAP_FLAG_SECONDS,
  assessCaptureTrust,
  distanceBetweenFixesMeters,
  fixesAreBitIdentical,
  secondsBetweenFixes,
} from "../src/lib/evidence/capture-trust.ts";

// THE PHOTO AND THE PHOTO'S OWN LOCATION ARE THE EVIDENCE — owner, 2026-09-29: "lazm el gps b
// location w el live b location tany w n compare" and "the photo + the location of photo is the
// more trustable".
//
// This test pins BOTH halves:
//   1. the arithmetic — distance, gap, verdict bands, and what a null means, and
//   2. that the WRITE PATHS actually store the photo's own fix rather than copying the location
//      fix onto it.
//
// Half 2 is the one that matters. The bug was never in any formula: it was that three
// `storeMarketingEvidencePhoto` call sites and the direct-order insert all read the venue's
// `captured*` values into the photo's row, so the comparison these columns imply was structurally
// impossible and every stored distance was exactly zero. A formula test alone would have passed
// happily against the broken code for the whole year it was live.

/** The real production capture that exposed this, 2026-09-29, Nashwah / Zagazig. */
const LOCATION_FIX = {
  accuracyMeters: 43.8289985656738,
  capturedAt: "2026-09-29T14:10:09.176Z",
  latitude: 30.4954306,
  longitude: 31.4770646,
};

function runArithmeticTests() {
  // ── A null photo fix is NOT MEASURED, and never agreement ────────────────────
  const unmeasured = assessCaptureTrust({ locationFix: LOCATION_FIX, photoFix: null });
  assert.equal(unmeasured.verdict, "unmeasured", "a missing photo fix is never a verdict about the place");
  assert.equal(unmeasured.measured, false);
  assert.equal(unmeasured.distanceMeters, null, "no distance can be claimed from one fix");
  // The specific mistake this guards: reading `verdict !== "disagrees"` as "it is fine".
  assert.notEqual(unmeasured.verdict, "agrees", "an unmeasured pair must never read as agreeing");

  // A photo fix with only one coordinate is still not a fix.
  assert.equal(
    assessCaptureTrust({
      locationFix: LOCATION_FIX,
      photoFix: { latitude: 30.4954306, longitude: null },
    }).verdict,
    "unmeasured",
    "half a coordinate pair is no coordinate pair",
  );

  // ── WHY it is unmeasured, which is an explanation and never a finding ──────────
  // Both answers mean the same thing for judgement: nothing is known. They differ only in what a
  // reader should conclude about the HANDSET - and for an old capture, the answer is nothing at
  // all, because the feature did not exist when it was taken.
  // The capture that started all this was taken at 14:10Z, BEFORE #4781 merged at 16:34Z - so it
  // correctly reads as predating the fix, not as a camera that failed. Worth pinning: it is the
  // row most likely to be looked at, and mislabelling it would be the first thing anyone noticed.
  assert.equal(
    assessCaptureTrust({ locationFix: LOCATION_FIX, photoFix: null }).unmeasuredReason,
    "predates_shutter_fix",
    "Sama Shalaby’s 14:10Z capture predates the 16:34Z merge - it is not a shutter failure",
  );
  assert.equal(
    assessCaptureTrust({
      locationFix: { capturedAt: "2026-09-30T08:00:00Z", latitude: 30.05, longitude: 31.24 },
      photoFix: null,
    }).unmeasuredReason,
    "no_position_recorded",
    "a capture AFTER the change with no photo fix means that shutter read nothing",
  );
  assert.equal(
    assessCaptureTrust({
      locationFix: { capturedAt: "2026-07-02T09:00:00Z", latitude: 30.05, longitude: 31.24 },
      photoFix: null,
    }).unmeasuredReason,
    "predates_shutter_fix",
    "a July capture has no coordinates because the camera did not take them yet",
  );
  assert.equal(
    assessCaptureTrust({ locationFix: { latitude: 30.05, longitude: 31.24 }, photoFix: null }).unmeasuredReason,
    "predates_shutter_fix",
    "an undated capture is treated as old - the other wording would imply a failure we cannot evidence",
  );
  // A MEASURED pair carries no reason at all, so no caller can render one beside a real distance.
  assert.equal(
    assessCaptureTrust({
      locationFix: LOCATION_FIX,
      photoFix: { latitude: 30.4954306, longitude: 31.4770646 },
    }).unmeasuredReason,
    null,
    "a measured pair has no unmeasured reason",
  );

  // ── Distance ─────────────────────────────────────────────────────────────────
  // The clinic and the pharmacy from that same submission stood ~18 m apart.
  const clinic = { latitude: 30.4952868, longitude: 31.4771601 };
  const shopFront = { latitude: 30.4954306, longitude: 31.4770646 };
  const metres = distanceBetweenFixesMeters(clinic, shopFront);
  assert.ok(metres !== null && metres > 15 && metres < 22, `two doors apart should be ~18 m, got ${metres}`);

  // Zagazig against the Giza address the mistyped code 443359 was registered at: two governorates.
  const giza = { latitude: 30.005, longitude: 31.185 };
  const farApart = distanceBetweenFixesMeters(shopFront, giza);
  assert.ok(farApart !== null && farApart > 55_000, `across Cairo should exceed 55 km, got ${farApart}`);

  assert.equal(distanceBetweenFixesMeters(null, shopFront), null);
  assert.equal(
    distanceBetweenFixesMeters({ latitude: 91, longitude: 0 }, shopFront),
    null,
    "an out-of-range latitude is not a coordinate",
  );

  // ── Verdict bands ────────────────────────────────────────────────────────────
  const near = assessCaptureTrust({ locationFix: LOCATION_FIX, photoFix: { ...shopFront, capturedAt: LOCATION_FIX.capturedAt } });
  assert.equal(near.verdict, "agrees");
  assert.equal(near.measured, true);

  // Just inside and just outside the agree band, so the boundary itself is pinned.
  assert.equal(
    assessCaptureTrust({
      locationFix: { latitude: 30.0, longitude: 31.0 },
      photoFix: { latitude: 30.0 + 0.001, longitude: 31.0 },
    }).verdict,
    "agrees",
    "~111 m is well inside the agree band",
  );
  assert.equal(
    assessCaptureTrust({
      locationFix: { latitude: 30.0, longitude: 31.0 },
      photoFix: { latitude: 30.0 + 0.005, longitude: 31.0 },
    }).verdict,
    "drifted",
    "~556 m is past the agree band but not irreconcilable",
  );
  assert.equal(
    assessCaptureTrust({ locationFix: { latitude: 30.0, longitude: 31.0 }, photoFix: giza }).verdict,
    "disagrees",
  );
  assert.ok(
    CAPTURE_DRIFT_AGREE_METRES < CAPTURE_DRIFT_DISAGREE_METRES,
    "the bands must not invert",
  );
  // Loose on purpose: a false positive accuses a real person of fraud.
  assert.ok(CAPTURE_DRIFT_AGREE_METRES >= 200, "the agree band must stay generous for weak indoor fixes");

  // ── The gap ──────────────────────────────────────────────────────────────────
  // The real one: 18m31s between locating and shooting.
  const gap = secondsBetweenFixes(LOCATION_FIX, { capturedAt: "2026-09-29T14:28:40.540Z" });
  assert.ok(gap !== null && Math.round(gap) === 1111, `expected 1111 s (18m31s), got ${gap}`);
  assert.equal(
    assessCaptureTrust({
      locationFix: LOCATION_FIX,
      photoFix: { ...shopFront, capturedAt: "2026-09-29T14:28:40.540Z" },
    }).gapIsLong,
    true,
    "18m31s must flag as a long gap — it is the case that started this",
  );
  assert.equal(
    assessCaptureTrust({
      locationFix: LOCATION_FIX,
      photoFix: { ...shopFront, capturedAt: "2026-09-29T14:10:30.000Z" },
    }).gapIsLong,
    false,
    "21 seconds is a normal locate-then-shoot",
  );
  assert.equal(secondsBetweenFixes(LOCATION_FIX, { capturedAt: null }), null);
  assert.equal(secondsBetweenFixes(LOCATION_FIX, { capturedAt: "not a date" }), null);
  assert.ok(CAPTURE_GAP_FLAG_SECONDS >= 300, "the gap flag must not fire on an ordinary wait");

  // An unmeasured pair can still carry a known gap — the two are independent.
  const gapOnly = assessCaptureTrust({
    locationFix: LOCATION_FIX,
    photoFix: { capturedAt: "2026-09-29T14:28:40.540Z" },
  });
  assert.equal(gapOnly.verdict, "unmeasured");
  assert.equal(gapOnly.gapIsLong, true, "a long gap is knowable even with no photo coordinates");

  // ── The copy fingerprint ─────────────────────────────────────────────────────
  // What the old code produced on every single capture.
  assert.equal(
    fixesAreBitIdentical(LOCATION_FIX, { ...LOCATION_FIX }),
    true,
    "a copied fix is bit-identical — that is how the defect is recognised in historic rows",
  );
  assert.equal(
    fixesAreBitIdentical(LOCATION_FIX, { ...LOCATION_FIX, latitude: 30.4954307 }),
    false,
    "two genuine reads differ in the low decimals",
  );
  assert.equal(fixesAreBitIdentical(LOCATION_FIX, null), false, "nothing is identical to a missing fix");
}

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function runWritePathTests() {
  // ── Marketing: all three evidence-photo writes use the PHOTO's fix ───────────
  const marketingService = read("../src/lib/marketing-requests/service.ts");

  // Exactly three call sites write an evidence photo row. If a fourth appears it must be audited
  // too, so the count is pinned rather than the individual lines.
  const photoWrites = marketingService.match(/storeMarketingEvidencePhoto\(\{/g) ?? [];
  assert.equal(photoWrites.length, 3, "marketing writes exactly 3 evidence photos — a new one needs the same fix");

  const photoLatWrites = marketingService.match(/capturedLatitude: normalized\w+\.evidencePhotoLatitude,/g) ?? [];
  assert.equal(photoLatWrites.length, 3, "every evidence photo row must store the PHOTO's latitude");
  const photoLngWrites = marketingService.match(/capturedLongitude: normalized\w+\.evidencePhotoLongitude,/g) ?? [];
  assert.equal(photoLngWrites.length, 3, "every evidence photo row must store the PHOTO's longitude");

  // THE REGRESSION ITSELF. This is the line the bug was made of, and it must appear nowhere inside
  // an evidence-photo record again. The venue rows still legitimately use `capturedLatitude` — this
  // asserts only that no `storeMarketingEvidencePhoto` record does.
  for (const block of marketingService.split("storeMarketingEvidencePhoto({").slice(1)) {
    const record = block.slice(0, block.indexOf("},"));
    assert.ok(
      !/capturedLatitude: normalized\w+\.capturedLatitude/.test(record),
      "an evidence photo must never be stamped with the venue's location fix — that is the copy bug",
    );
    assert.ok(
      !/capturedAccuracyMeters: normalized\w+\.capturedAccuracyMeters/.test(record),
      "an evidence photo must never be stamped with the venue fix's accuracy",
    );
  }

  // ── Direct orders: the shutter fix is stored in its own columns ──────────────
  const directOrder = read("../src/lib/direct-orders/pharmacy-validation.ts");
  for (const column of ["photo_latitude:", "photo_longitude:", "photo_accuracy_meters:", "photo_captured_at:"]) {
    assert.ok(directOrder.includes(column), `direct-order validation must persist ${column}`);
  }
  // Never defaulted to the pin. `?? capturedLatitude` here would silently restore the defect.
  assert.ok(
    !/photo_latitude:\s*photoLatitude\s*\?\?/.test(directOrder),
    "a null photo fix must stay null — never fall back to the venue pin",
  );
  assert.ok(
    directOrder.includes("readCoordinateInput(input.photoLatitude)"),
    "the photo fix goes through the same coordinate reader as the pin, so a blank is null not 0",
  );

  const directOrderRoute = read("../app/api/direct-orders/pharmacy-validations/route.ts");
  assert.ok(
    directOrderRoute.includes("photoLatitude: body.photoLatitude,"),
    "the route must pass the photo fix through UNPARSED — Number('') is 0, which files 0°N 0°E",
  );

  // ── The cameras each take their own reading at the shutter ───────────────────
  const marketingCamera = read("../src/components/employee-portal/marketing-validation-workspace.tsx");
  const directOrderCamera = read("../src/components/direct-orders/pharmacy-validation-capture.tsx");
  for (const [name, source] of [["marketing", marketingCamera], ["direct order", directOrderCamera]] as const) {
    assert.ok(
      source.includes("readShutterFix()"),
      `the ${name} camera must read its own fix at the shutter`,
    );
    assert.ok(
      source.includes('from "@/lib/evidence/read-shutter-fix"'),
      `the ${name} camera must use the shared reader, not a private copy that can drift`,
    );
  }

  // THE “0 CUSTOMERS” PANEL. The owner was sent a screenshot showing “Validated · 1” beside an
  // empty “Not Usable Yet — 0 customers” panel, for a capture that was genuinely unusable. Two
  // separate defects produced it, and both are pinned:
  //   1. the tabs split on EVIDENCE alone, so a customer whose live photo and pin were perfect but
  //      whose LINK was held on a governorate mismatch counted as Validated and was missing from
  //      the queue that exists to list exactly him; and
  //   2. the tab BUTTON was gated on pendingGroups.length > 0 while the panel BODY rendered on the
  //      raw activeTab, so an emptied queue left the panel on screen with nothing in it.
  const workspace = read("../src/components/employee-portal/marketing-validation-workspace.tsx");
  assert.ok(
    workspace.includes("&& group.rows.some((row) => linkStatusIsSelectable(row.validationStatus)),"),
    "Validated must mean USABLE - evidence alone lets a held link show as ready",
  );
  assert.ok(
    workspace.includes("|| !group.rows.some((row) => linkStatusIsSelectable(row.validationStatus)),"),
    "Not Usable Yet must be the strict complement, or a held customer appears in neither tab",
  );
  assert.ok(
    workspace.includes("const effectiveTab = activeTab === \"pending\" && pendingGroups.length === 0"),
    "the rendered tab must fall back when the pending queue is empty",
  );
  assert.ok(
    !workspace.includes('{activeTab === "validation" ? ('),
    "the panel bodies must render on effectiveTab, never the raw activeTab",
  );
  assert.ok(
    workspace.includes("hasGovernorateHold(pendingGroups.flatMap((group) => group.rows))"),
    "the panel must name the REAL reason - telling a held capture to retake its photo is wrong advice",
  );

  // PHOENIX CRM is the REFERENCE DESIGN and was already the strongest of the lot — it never had
  // this bug and is deliberately not changed by it. Three properties make it stronger than a
  // single shutter fix, and all three are pinned here because a refactor toward the simpler
  // “one getCurrentPosition” shape would look like a tidy-up and would be a regression:
  //   1. a CONTINUOUS watch while the camera is open, not one snapshot;
  //   2. best-accuracy wins, but a fix older than FIX_STALE_MS is replaced even by a WORSE one,
  //      so a stale reading can never be the one stamped; and
  //   3. the stamp burns the shutter time AND the fix’s own time, so the gap is legible on the
  //      image itself without reading any row.
  const crmCamera = read("../src/components/phoenix-crm/live-photo-capture.tsx");
  assert.ok(
    crmCamera.includes("watchPosition"),
    "the CRM visit camera tracks position continuously — never downgrade it to a single fix",
  );
  assert.ok(
    crmCamera.includes("const FIX_STALE_MS = 15_000;"),
    "the CRM camera must keep its 15s staleness escape, or a stale best-accuracy fix wins for ever",
  );
  assert.ok(
    crmCamera.includes("locationCapturedAt: usedFix.at"),
    "the CRM stamp must carry the FIX’s own time beside the shutter time",
  );

  // The outstation cameras already read a fresh position in the same flow as the shutter, with
  // `maximumAge: 0`, so they never had the copy bug. Pinned so a refactor cannot quietly hoist
  // that read out to a separate "capture location" step and reintroduce it.
  for (const path of [
    "../src/components/outstation/departure-photo-card.tsx",
    "../src/components/outstation/journey-stop-card.tsx",
    "../src/components/outstation/mobile-outstation-wizard.tsx",
  ]) {
    const source = read(path);
    assert.ok(
      source.includes("getCurrentPosition"),
      `${path} must still take its own position at capture time`,
    );
    assert.ok(
      source.includes("maximumAge: 0"),
      `${path} must take a FRESH fix, never a cached one, at the shutter`,
    );
  }
}

export function runCaptureTrustTests() {
  runArithmeticTests();
  runWritePathTests();
}
