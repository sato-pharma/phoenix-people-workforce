import { strict as assert } from "node:assert";

import type { OutstationCarEvidenceMetadata } from "../src/lib/outstation/types.ts";
import { validateLiveCarEvidence } from "../src/lib/outstation/service.ts";

const validMetadata: OutstationCarEvidenceMetadata = {
  capturedAt: "2026-05-17T00:00:00.000Z",
  capturedLatitude: 29.975998,
  capturedLongitude: 31.13756,
  employeeHrId: "EMP-1001",
  requestDraftId: "draft-1",
  requestId: null,
  source: "live_camera",
};

export function runOutstationCarEvidenceValidationTests() {
  const missingMetadata = validateLiveCarEvidence({
    carEvidenceMetadata: null,
    transportationType: "car",
  });
  assert.equal(missingMetadata.isValid, false);
  assert.equal(
    missingMetadata.message,
    "Car transport requires one live in-app camera capture before submitting the request.",
  );

  const valid = validateLiveCarEvidence({
    carEvidenceMetadata: validMetadata,
    transportationType: "car",
  });
  assert.equal(valid.isValid, true);
  assert.equal(valid.message, "");

  const galleryEvidence = validateLiveCarEvidence({
    carEvidenceMetadata: {
      ...validMetadata,
      source: "gallery",
      requestDraftId: "draft-gallery",
    } as unknown as OutstationCarEvidenceMetadata,
    transportationType: "car",
  });
  assert.equal(galleryEvidence.isValid, false);
  assert.equal(
    galleryEvidence.message,
    "Only live in-app camera capture satisfies car evidence requirements for car transport requests.",
  );

  const gpsDeniedLikeMissingCoordinates = validateLiveCarEvidence({
    carEvidenceMetadata: {
      ...validMetadata,
      capturedLatitude: NaN,
      capturedLongitude: 31.13756,
      requestDraftId: "draft-denied",
    },
    transportationType: "car",
  });
  assert.equal(gpsDeniedLikeMissingCoordinates.isValid, false);
  assert.equal(
    gpsDeniedLikeMissingCoordinates.message,
    "Car live camera evidence is incomplete. Capture the photo again and keep it inside the app only.",
  );

  const gpsDeniedExplicit = validateLiveCarEvidence({
    carEvidenceMetadata: {
      ...validMetadata,
      capturedLatitude: Number.NaN,
      capturedLongitude: Number.NaN,
      requestDraftId: "draft-denied-explicit",
    },
    transportationType: "car",
  });
  assert.equal(gpsDeniedExplicit.isValid, false);

  const trainDoesNotRequireEvidence = validateLiveCarEvidence({
    carEvidenceMetadata: null,
    transportationType: "train",
  });
  assert.equal(trainDoesNotRequireEvidence.isValid, true);
}
