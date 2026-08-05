import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { OutstationCarEvidenceMetadata } from "../src/lib/outstation/types.ts";
import { validateLiveArrivalEvidence } from "../src/lib/outstation/car-evidence.ts";

// On 2026-08-04 the arrival photo became mandatory for EVERY transportation type
// (validateLiveArrivalEvidence, widened by #1707). The wizard's capture card was NOT widened with
// it — it rendered only when `transportationType === "car"`. A train or bus employee therefore had
// no control anywhere on the page that could produce the photo the server had just started
// demanding, and every train/bus submission died on a 400. The National Sales Manager hit exactly
// this and reported it as "I press submit and nothing happens", because the refusal rendered in
// normal flow BELOW the fixed mobile action bar, off the bottom of the scroll area.
//
// The validator itself was correctly tested and green throughout — the defect lived entirely in
// the gap between what the server required and what the UI could produce. So this pins the WIRING:
// the capture path must stay reachable for every type the validator refuses to exempt.

const WIZARD = join(process.cwd(), "src/components/outstation/mobile-outstation-wizard.tsx");
const SERVICE = join(process.cwd(), "src/lib/outstation/service.ts");

const ALL_TRANSPORT_TYPES = ["car", "train", "bus", "other"] as const;

const validMetadata: OutstationCarEvidenceMetadata = {
  capturedAt: "2026-08-05T10:00:00.000Z",
  capturedLatitude: 30.0444,
  capturedLocationLabel: "Ramses, Cairo, Egypt",
  capturedLongitude: 31.2357,
  employeeHrId: "B-122",
  requestDraftId: "draft-1",
  requestId: null,
  source: "live_camera",
};

/** Collapses whitespace so an assertion survives Prettier reflowing the expression. */
function squash(source: string): string {
  return source.replace(/\s+/g, " ");
}

export function runOutstationArrivalPhotoCaptureReachableTests() {
  const wizard = squash(readFileSync(WIZARD, "utf8"));
  const service = squash(readFileSync(SERVICE, "utf8"));

  // ── The contract the UI has to satisfy ──────────────────────────────────────
  // No transportation type is exempt, so no transportation type may be left without a capture
  // control. This half is the "why" behind every wiring assertion below.
  for (const transportationType of ALL_TRANSPORT_TYPES) {
    assert.equal(
      validateLiveArrivalEvidence({ carEvidenceMetadata: null, transportationType }).isValid,
      false,
      `${transportationType} is not exempt from the arrival photo, so its UI must be able to capture one`,
    );
    assert.equal(
      validateLiveArrivalEvidence({ carEvidenceMetadata: validMetadata, transportationType }).isValid,
      true,
      `${transportationType} passes once the photo exists — the rule is about the photo, not the transport`,
    );
  }

  // ── The capture card is not gated on car ────────────────────────────────────
  assert.ok(
    !wizard.includes('{transportationType === "car" ? ( <Card'),
    "the arrival-photo card must not be gated on car — that gate is the whole defect: it left train and bus with no way to produce a photo the server already demanded",
  );

  // The camera opener must be present and reachable rather than merely un-gated.
  assert.ok(
    wizard.includes("openCarEvidenceCamera()"),
    "the wizard must still expose the in-app camera opener — the arrival photo is only valid from a live capture, never the gallery",
  );

  // ── The ticket card is ADDED for train/bus, never swapped in for the camera ──
  assert.ok(
    !wizard.includes("</Card> ) : ( <TicketUploadCard"),
    "the ticket upload card must not replace the camera card — a train request carries BOTH its ticket and its arrival photo",
  );

  // ── The submit button explains itself instead of sitting dead ───────────────
  assert.ok(
    !wizard.includes('(transportationType === "car" && !hasCarEvidence)'),
    "neither submit button may be car-gated: on train/bus the button stayed enabled, so the refusal came from the server instead of from the form",
  );
  assert.equal(
    wizard.split("|| !hasCarEvidence }").length - 1,
    2,
    "both submit buttons (desktop card and mobile action bar) disable on a missing arrival photo, for every transport type",
  );
  assert.ok(
    wizard.includes("{arrivalPhotoMissingMessage}") && wizard.includes("{arrivalPhotoMissingShort}"),
    "a disabled button must name its reason — an unexplained dead button is what made this read as 'nothing happens'",
  );

  // ── The image is sent for every type ────────────────────────────────────────
  assert.ok(
    !wizard.includes('carEvidenceImageDataUrl: transportationType === "car" ? carEvidence?.imageDataUrl : undefined'),
    "the captured image must be sent for every transport type — stripping it for train/bus guaranteed the server refusal even once the camera was reachable",
  );
  assert.ok(
    wizard.includes("carEvidenceImageDataUrl: carEvidence?.imageDataUrl,"),
    "the wizard sends whatever was captured, and lets the server judge it",
  );

  // ── The refusal is visible on a phone ───────────────────────────────────────
  assert.ok(
    wizard.includes('className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+4.25rem)] z-50 sm:hidden print:hidden"'),
    "on mobile the message must be pinned above the sticky action bar; in normal flow it rendered below the fixed footer and off-screen, which is why a real 400 looked like no response at all",
  );

  // ── The upload route exists for non-car, and ONLY for non-car ───────────────
  // Owner request 2026-08-05. The asymmetry is the point: an upload button on a car trip would
  // recreate this file's original defect in mirror image — a control the employee can use that
  // the server then refuses.
  assert.ok(
    wizard.includes('const canUploadArrivalPhoto = transportationType !== "car"'),
    "the upload route must be offered to every non-car type and withheld from car, matching exactly what validateLiveArrivalEvidence accepts",
  );
  assert.ok(
    wizard.includes("{canUploadArrivalPhoto ? (") && wizard.includes("void uploadArrivalEvidence(file)"),
    "the upload control must actually render behind that flag and be wired to the handler",
  );
  assert.ok(
    wizard.includes('source: "upload"') && wizard.includes('source: "live_camera"'),
    "each route stamps its own source — an uploaded photo recorded as live_camera would launder weak evidence into strong",
  );
  assert.ok(
    wizard.includes("source: carEvidence.source,"),
    "the submitted metadata carries the source the capture actually had, rather than a hardcoded one",
  );

  // The offline replay is the online path's twin, and had regressed the same way.
  assert.ok(
    !wizard.includes('carEvidenceImageDataUrl: draft.transportationType === "car" ? draft.carEvidenceImageDataUrl : undefined'),
    "the offline replay must send arrival evidence for every transport type — gated on car, a queued train draft could never sync",
  );

  // ── The server persists the photo for every type ────────────────────────────
  assert.ok(
    !service.includes('const storedCarEvidenceMetadata = calculation.transportationType === "car" && input.carEvidenceMetadata'),
    "the server must store arrival metadata for every transport type — gating persistence on car silently dropped the only evidence that could satisfy the widened gate",
  );
  assert.ok(
    !service.includes('if (calculation.transportationType === "car") { if (!input.carEvidenceImageDataUrl)'),
    "the arrival image upload must not be car-only, or a train photo is accepted by the validator and then never written to storage",
  );
  assert.ok(
    service.includes("carEvidenceImagePath = await uploadOutstationCarEvidenceImage({"),
    "the upload still happens — this test pins that it happens for everyone, not that it stopped happening",
  );
}
