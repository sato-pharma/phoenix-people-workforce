import { strict as assert } from "node:assert";

import type { OutstationCarEvidenceMetadata } from "../src/lib/outstation/types.ts";
import { validateLiveArrivalEvidence } from "../src/lib/outstation/car-evidence.ts";
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
  const missingMetadata = validateLiveArrivalEvidence({
    carEvidenceMetadata: null,
    transportationType: "car",
  });
  assert.equal(missingMetadata.isValid, false);

  const valid = validateLiveArrivalEvidence({
    carEvidenceMetadata: validMetadata,
    transportationType: "car",
  });
  assert.equal(valid.isValid, true);

  const galleryEvidence = validateLiveArrivalEvidence({
    carEvidenceMetadata: {
      ...validMetadata,
      source: "gallery",
    } as unknown as OutstationCarEvidenceMetadata,
    transportationType: "car",
  });
  assert.equal(galleryEvidence.isValid, false);

  const missingGps = validateLiveArrivalEvidence({
    carEvidenceMetadata: {
      ...validMetadata,
      capturedLatitude: Number.NaN,
    },
    transportationType: "car",
  });
  assert.equal(missingGps.isValid, false);

  // ── Owner change (2026-08-04): the arrival photo is required for EVERY transport type ──
  // This assertion is INVERTED from what it pinned before. A train/bus claim used to be exempt,
  // which meant it could reach payroll carrying no photograph at all — 5 of the 12 requests in
  // production on that date have no photo for exactly this reason. Every new request must now
  // carry two photos, and this is the first of them.
  for (const transportationType of ["train", "bus", "other"] as const) {
    const missingArrivalPhoto = validateLiveArrivalEvidence({
      carEvidenceMetadata: null,
      transportationType,
    });
    assert.equal(
      missingArrivalPhoto.isValid,
      false,
      `a ${transportationType} trip must NOT be exempt from the arrival photo`,
    );
    assert.match(
      missingArrivalPhoto.message,
      new RegExp(transportationType, "i"),
      "the refusal must name the employee's actual transport, not tell a train passenger to photograph a car",
    );

    // …and the same non-car trip passes once the photo is there, so the requirement is about the
    // photo's presence and never about the transport type.
    assert.equal(
      validateLiveArrivalEvidence({ carEvidenceMetadata: validMetadata, transportationType }).isValid,
      true,
      `a ${transportationType} trip with a live arrival photo is valid`,
    );
  }

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
