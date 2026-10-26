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
      validateLiveArrivalEvidence({
        carEvidenceMetadata: null,
        employeeRole: "District Manager",
        transportationType,
      }).isValid,
      false,
      `${transportationType} is not exempt from the arrival photo, so its UI must be able to capture one`,
    );
    assert.equal(
      validateLiveArrivalEvidence({
        carEvidenceMetadata: validMetadata,
        employeeRole: "District Manager",
        transportationType,
      }).isValid,
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
  // Owner waiver 2026-08-19 (the Training Manager added 2026-10-26): the roles in
  // evidence-waiver.ts owe no photo, so the guard is
  // now "missing AND not waived" rather than a bare "missing". The COUNT is what this pins — both
  // buttons, never one — because a single-button regression is exactly how the mobile action bar
  // once stayed live while the desktop card was fixed.
  // Owner request 2026-09-19: a Meeting or Other expense owes no arrival photo either, so the guard is
  // now `arrivalPhotoOwed` (= not a non-travel expense AND not a waived role). The waiver half is
  // asserted separately below so this guard can never silently drop it.
  // Owner request 2026-10-22 ("make it in a form exactly like … log a visit in Phoenix CRM"): the
  // form is a step form now, with ONE action bar on every screen size, so there is ONE Submit
  // button — the desktop card and the mobile bar were the two copies that could drift, and they
  // are gone. Exactly one, so a second Submit cannot come back without its own guard.
  assert.equal(
    wizard.split("|| (!hasCarEvidence && arrivalPhotoOwed) }").length - 1,
    1,
    "the one Submit button disables on a missing arrival photo, for every transport type and every role that still owes one",
  );
  assert.equal(
    wizard.split("void submit();").length - 1,
    1,
    "there is exactly one Submit press in the form — a second one is a second guard that can drift",
  );
  assert.ok(
    wizard.includes("const arrivalPhotoOwed = !isNonTravel && !isEvidencePhotoWaived;"),
    "arrivalPhotoOwed must keep the evidence waiver in it — the two buttons guard on it, so dropping the waiver here disables a waived manager's button with no photo card on screen",
  );
  assert.ok(
    !wizard.includes("|| !hasCarEvidence }"),
    "…and neither may keep the un-waived form of the guard, or a waived manager's button sits dead with no photo card on screen to explain it",
  );
  assert.ok(
    wizard.includes("{arrivalPhotoMissingMessage}") && wizard.includes(": arrivalPhotoMissingShort}"),
    "a disabled button must name its reason — an unexplained dead button is what made this read as 'nothing happens'",
  );
  // …and the bar beside the button names it too: the evidence step's problem is the arrival photo.
  assert.ok(
    wizard.includes("{barStatus}") && wizard.includes("submitExpenseStepProblem("),
    "the action bar shows what is still missing, from the same step rule that decides it",
  );

  // ── The image is sent for every type ────────────────────────────────────────
  assert.ok(
    !wizard.includes('carEvidenceImageDataUrl: transportationType === "car" ? carEvidence?.imageDataUrl : undefined'),
    "the captured image must be sent for every transport type — stripping it for train/bus guaranteed the server refusal even once the camera was reachable",
  );
  assert.ok(
    // A Meeting or Other expense (owner, 2026-09-19) takes no photo at all; every TRIP type still sends
    // whatever was captured, whatever its transport type (the assertion above pins that half).
    wizard.includes("carEvidenceImageDataUrl: carEvidence?.imageDataUrl,") ||
      wizard.includes("carEvidenceImageDataUrl: isNonTravel ? undefined : carEvidence?.imageDataUrl,"),
    "the wizard sends whatever was captured, and lets the server judge it",
  );

  // ── The refusal is visible on a phone ───────────────────────────────────────
  // Every message now renders INSIDE the sticky action bar (2026-10-22), the bar Log a visit carries:
  // held above the portal's bottom navigation and under the thumb wherever the page is scrolled.
  // In normal flow a refusal once rendered below a fixed footer and off-screen, which is why a real
  // 400 looked like no response at all.
  assert.ok(
    wizard.includes('aria-label="Submit expense action bar"') &&
      wizard.includes("sticky bottom-[var(--phx-portal-bottom-nav-reserve,0px)]"),
    "the action bar must stay pinned above the portal's bottom navigation",
  );
  assert.ok(
    wizard.includes("const barStatus: ReactNode = message ? ("),
    "a message (a server refusal included) is the FIRST thing the bar shows, so it is never off-screen",
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
