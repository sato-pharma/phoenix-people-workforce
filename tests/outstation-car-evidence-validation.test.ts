import { strict as assert } from "node:assert";

import type { OutstationCarEvidenceMetadata } from "../src/lib/outstation/types.ts";
import { validateLiveCarEvidence } from "../src/lib/outstation/car-evidence.ts";
import {
  buildOutstationCarEvidenceImagePath,
  parseOutstationCarEvidenceImageDataUrl,
} from "../src/lib/outstation/car-evidence-storage.ts";

const validMetadata: OutstationCarEvidenceMetadata = {
  capturedAt: "2026-05-17T00:00:00.000Z",
  capturedLatitude: 29.975998,
  capturedLocationLabel: "Sheraton, Cairo, Egypt",
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

  const valid = validateLiveCarEvidence({
    carEvidenceMetadata: validMetadata,
    transportationType: "car",
  });
  assert.equal(valid.isValid, true);

  const galleryEvidence = validateLiveCarEvidence({
    carEvidenceMetadata: {
      ...validMetadata,
      source: "gallery",
    } as unknown as OutstationCarEvidenceMetadata,
    transportationType: "car",
  });
  assert.equal(galleryEvidence.isValid, false);

  const missingGps = validateLiveCarEvidence({
    carEvidenceMetadata: {
      ...validMetadata,
      capturedLatitude: Number.NaN,
    },
    transportationType: "car",
  });
  assert.equal(missingGps.isValid, false);

  const trainDoesNotRequireCarEvidence = validateLiveCarEvidence({
    carEvidenceMetadata: null,
    transportationType: "train",
  });
  assert.equal(trainDoesNotRequireCarEvidence.isValid, true);

  assert.equal(
    buildOutstationCarEvidenceImagePath(validMetadata),
    "car/EMP-1001/draft-1.jpg",
  );

  const parsedImage = parseOutstationCarEvidenceImageDataUrl(
    `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`,
  );
  assert.equal(parsedImage.contentType, "image/jpeg");
  assert.equal(parsedImage.bytes.length, 4);

  assert.throws(() =>
    parseOutstationCarEvidenceImageDataUrl(
      `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
    ),
  );
}
