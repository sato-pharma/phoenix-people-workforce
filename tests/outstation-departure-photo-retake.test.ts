import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildOutstationDepartureEvidenceImagePath } from "../src/lib/outstation/car-evidence-storage.ts";
import { isWithinDepartureWindow } from "../src/lib/outstation/departure-evidence.ts";

// The departure photo was capture-once from 2026-08-04: the service refused a second one outright,
// because the pair is what proves the employee was still at the destination hours after arriving,
// and a later replacement defeats that. The owner allowed retakes on 2026-08-08 under two explicit
// conditions, and this file exists to stop either of them being quietly relaxed later:
//
//   1. A retake is bounded by the SAME deadline as the first capture — the end of the trip's last
//      day, Cairo. That is what keeps every version something taken while he was still on the trip.
//   2. NOTHING is ever overwritten. Each capture gets its own storage object, and the superseded
//      one is recorded in previousVersions.
//
// Relax (1) and the photo stops proving where he was. Relax (2) and a substituted photo becomes
// indistinguishable from a corrected one, which is the entire reason the retake was safe to allow.

const SERVICE = join(process.cwd(), "src/lib/outstation/service.ts");

function squash(source: string): string {
  return source.replace(/\s+/g, " ");
}

export function runOutstationDeparturePhotoRetakeTests() {
  const service = squash(readFileSync(SERVICE, "utf8"));

  // ── Versioned storage paths: no capture can land on another ─────────────────
  const first = buildOutstationDepartureEvidenceImagePath({
    employeeHrId: "B-119",
    requestId: 61,
    version: 1,
  });
  const second = buildOutstationDepartureEvidenceImagePath({
    employeeHrId: "B-119",
    requestId: 61,
    version: 2,
  });
  const third = buildOutstationDepartureEvidenceImagePath({
    employeeHrId: "B-119",
    requestId: 61,
    version: 3,
  });

  assert.notEqual(
    first,
    second,
    "a retake must not resolve to the first capture's storage path — same path means the original is gone, and a corrected photo becomes indistinguishable from a substituted one",
  );
  assert.notEqual(second, third, "every retake needs its own path, not just the second one");

  // v1 keeps the original unsuffixed name so photos taken before retakes existed still resolve.
  assert.equal(
    first,
    "departure/B-119/61.jpg",
    "the first capture must keep the original unsuffixed path — changing it would strand every departure photo taken before retakes existed",
  );

  // Defaulting to v1 matters: a caller that forgets the version must land on the first path and
  // be REJECTED by the bucket's upsert:false, never silently overwrite a later capture.
  assert.equal(
    buildOutstationDepartureEvidenceImagePath({ employeeHrId: "B-119", requestId: 61 }),
    first,
    "an omitted version must default to 1, so a careless caller collides and fails rather than overwriting",
  );

  // ── The window is the same one the first capture had ────────────────────────
  assert.equal(
    isWithinDepartureWindow({ capturedAt: "2026-08-08T09:00:00.000Z", tripEndDate: "2026-08-08" }),
    true,
    "a retake on the trip's last day is inside the window",
  );
  assert.equal(
    isWithinDepartureWindow({ capturedAt: "2026-08-09T09:00:00.000Z", tripEndDate: "2026-08-08" }),
    false,
    "the day after the trip ends is outside the window — this is the boundary the retake is bounded by",
  );

  // ── The service actually enforces both ──────────────────────────────────────
  assert.ok(
    !service.includes('throw new Error("A departure photo has already been captured for this request.")'),
    "the flat capture-once refusal must be gone — it is what pushed honest employees into asking an admin to waive the gate over a blurred photo",
  );
  assert.ok(
    service.includes("const isRetake = Boolean(request.departureEvidenceImagePath)") &&
      service.includes("isWithinDepartureWindow({"),
    "a retake must be gated on the trip window in the service, not merely hidden in the UI — the UI is a usability choice, the service is the boundary",
  );
  assert.ok(
    service.includes("previousVersions") && service.includes("version," ),
    "the superseded capture must be recorded in previousVersions and the new one numbered — an unversioned retake keeps no trail",
  );
  assert.ok(
    /upload the new capture with its version/i.test(service) || service.includes("version,"),
    "the upload must receive the version, or every retake writes to the first capture's path",
  );
}
